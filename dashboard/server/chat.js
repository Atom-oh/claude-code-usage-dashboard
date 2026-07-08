import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { queryReadonly } from "./clickhouse.js";

// Ask Claude — Bedrock ConverseStream + run_sql 툴콜 루프 (whchoi98 대시보드의 Analyze 상당,
// 대상 저장소만 Athena → 우리 ClickHouse). 모델은 운영 결정에 따라 sonnet-5 고정.
const MODEL_ID = process.env.CHAT_MODEL_ID || "global.anthropic.claude-sonnet-5";
const MAX_HOPS = 4;

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });

// SELECT/WITH 단일 문장만 통과 — 나머지는 전부 거부. queryReadonly의 readonly=1이 2차 방어라
// 여기는 명백한 것만 거른다(정교한 SQL 파서는 오버킬).
// 단, 테이블 함수(url/s3/remote/...)는 readonly=1이 막지 *않는다* — SELECT 안에서 외부 URL이나
// 내부망(EKS 노드 메타데이터 169.254.169.254 등)을 읽을 수 있는 SSRF 벡터라 명시적으로 거부한다.
// 주석(`url/**/(...)`)과 백틱 인용(`` `url`(...) ``)으로 아래 토큰 검사를 우회할 수 있어(ClickHouse
// 토크나이저는 블록 주석을 공백으로 취급) 주석/백틱 자체를 통째로 거부한다 — 챗이 생성하는
// 정상 쿼리에 주석이 필요할 일은 없다. system/information_schema는 타 사용자의 쿼리 텍스트
// (query_log) 등이 보여 claude_code 밖 스키마 참조도 거부.
function sanitizeSql(sql) {
  const s = String(sql || "").trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(s)) throw new Error("SELECT/WITH 쿼리만 허용됩니다");
  if (/;/.test(s)) throw new Error("다중 문장은 허용되지 않습니다");
  if (/--|\/\*|`/.test(s)) throw new Error("주석/백틱은 허용되지 않습니다");
  if (/\b(insert|alter|drop|truncate|create|rename|grant|attach|detach|optimize|system|kill)\b/i.test(s))
    throw new Error("읽기 전용 쿼리만 허용됩니다");
  if (/\b(url|s3|s3Cluster|remote|remoteSecure|mysql|postgresql|jdbc|odbc|hdfs|file|azureBlobStorage|gcs|deltaLake|iceberg|hudi|mongodb|redis|sqlite|dictionary|cluster|clusterAllReplicas|executable)\s*\(/i.test(s))
    throw new Error("테이블 함수는 허용되지 않습니다");
  if (/\b(information_schema|INFORMATION_SCHEMA)\s*\./.test(s)) throw new Error("claude_code 스키마만 조회할 수 있습니다");
  return s;
}

const SYSTEM = `당신은 Claude Code 사용량 대시보드의 분석 어시스턴트입니다. ClickHouse(claude_code DB)를 조회해 질문에 답하세요.

테이블:
1. otel_metrics_sum — 메트릭. 컬럼: TimeUnix(DateTime), MetricName, Value(Float64), UserEmail, SessionId, Model, TokenType(input/output/cacheRead/cacheCreation), Decision(accept/reject), SkillName, AggregationTemporality(2=cumulative), Attributes(Map).
   MetricName 값: claude_code.session.count / .token.usage / .cost.usage / .lines_of_code.count / .commit.count / .pull_request.count / .code_edit_tool.decision / .active_time.total
2. otel_logs — 이벤트. 컬럼: Timestamp, EventName(tool_result/user_prompt 등), UserEmail, SessionId, ToolName, McpServerName, Success.

중요 — cumulative 함정: otel_metrics_sum은 세션 단위 누적 카운터를 30초마다 재보고하므로 sum(Value)를 그대로 쓰면 심하게 과대집계됩니다. 합계가 필요하면 반드시 세션·시리즈 단위 max()를 먼저 취하세요:
SELECT sum(v) FROM (SELECT max(Value) AS v FROM otel_metrics_sum WHERE MetricName='...' GROUP BY cityHash64(toString(Attributes)), SessionId)
유저 수/세션 수 존재 여부(uniqExact)는 원본 테이블을 그대로 써도 됩니다.

규칙: run_sql로 필요한 데이터를 조회(최대 ${MAX_HOPS}회)한 뒤 한국어로 간결히 답하세요. 표가 어울리면 markdown 표를 쓰세요. 결과는 200행으로 잘립니다.`;

const TOOLS = {
  tools: [
    {
      toolSpec: {
        name: "run_sql",
        description: "ClickHouse claude_code DB에 읽기 전용 SELECT 쿼리를 실행하고 JSON 행을 돌려받는다 (최대 200행)",
        inputSchema: { json: { type: "object", properties: { sql: { type: "string", description: "단일 SELECT/WITH 문" } }, required: ["sql"] } },
      },
    },
  ],
};

// POST /api/chat {messages:[{role,content}]} → SSE(status/text/done/error 이벤트) 스트림.
export async function handleChat(req, res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const messages = (req.body?.messages || [])
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
      .map((m) => ({ role: m.role, content: [{ text: String(m.content).slice(0, 8000) }] }));
    if (!messages.length) throw new Error("메시지가 비어 있습니다");

    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const cmd = new ConverseStreamCommand({
        modelId: MODEL_ID,
        system: [{ text: SYSTEM }],
        messages,
        toolConfig: TOOLS,
        inferenceConfig: { maxTokens: 2000 },
      });
      const { stream } = await client.send(cmd);

      let stopReason = null;
      const content = [];
      let curText = null;
      let curTool = null;
      for await (const ev of stream) {
        if (ev.contentBlockStart?.start?.toolUse) {
          curTool = { ...ev.contentBlockStart.start.toolUse, input: "" };
        } else if (ev.contentBlockDelta?.delta?.toolUse) {
          curTool.input += ev.contentBlockDelta.delta.toolUse.input || "";
        } else if (ev.contentBlockDelta?.delta?.text) {
          const t = ev.contentBlockDelta.delta.text;
          curText = (curText || "") + t;
          send("text", { text: t });
        } else if (ev.contentBlockStop) {
          if (curTool) {
            content.push({ toolUse: { toolUseId: curTool.toolUseId, name: curTool.name, input: JSON.parse(curTool.input || "{}") } });
            curTool = null;
          } else if (curText !== null) {
            content.push({ text: curText });
            curText = null;
          }
        } else if (ev.messageStop) {
          stopReason = ev.messageStop.stopReason;
        }
      }

      messages.push({ role: "assistant", content });
      if (stopReason !== "tool_use") break;

      const results = [];
      for (const block of content) {
        if (!block.toolUse) continue;
        const { toolUseId, input } = block.toolUse;
        send("status", { message: "쿼리 실행 중...", sql: input.sql });
        try {
          const { rows, truncated } = await queryReadonly(sanitizeSql(input.sql));
          results.push({ toolResult: { toolUseId, content: [{ json: { rows, truncated } }] } });
        } catch (err) {
          results.push({ toolResult: { toolUseId, content: [{ text: `쿼리 오류: ${err.message}` }], status: "error" } });
        }
      }
      messages.push({ role: "user", content: results });
    }
    send("done", {});
  } catch (err) {
    console.error("/api/chat", err);
    send("error", { message: err.message });
  } finally {
    res.end();
  }
}
