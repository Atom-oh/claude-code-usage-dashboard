import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { queryReadonly } from "./clickhouse.js";

// Ask Claude — Bedrock ConverseStream + run_sql 툴콜 루프 (whchoi98 대시보드의 Analyze 상당,
// 대상 저장소만 Athena → 우리 ClickHouse). 모델은 운영 결정에 따라 sonnet-5 고정.
const MODEL_ID = process.env.CHAT_MODEL_ID || "global.anthropic.claude-sonnet-5";
const MAX_HOPS = 4;

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });

// FROM 절의 테이블 참조 위치(FROM/JOIN 직후, FROM 절 내 comma cross-join 직후)에 identifier(가
// 오면 거부한다 — 테이블 함수(url/s3/remote/file/...)라는 카테고리 전체를 괄호 깊이·JOIN 종류
// 무관하게 막는 구조적 규칙. 정상 테이블 참조는 순수 식별자(otel_metrics_sum 등)나 서브쿼리
// `(SELECT ...)`뿐이다. 이전엔 `\b(from|join)\s+\w+\s*\(` 정규식이었는데 FROM/JOIN 직후 첫
// 토큰만 봐서 comma cross-join(`FROM otel_logs, url(...)`)으로 우회됐다(실측: 리뷰에서 확인).
// SELECT/WHERE의 스칼라·집계 함수(max()/toDate()...)는 테이블 위치가 아니라 그대로 통과한다.
// 전제: 진입부에서 주석(--,/**/)·백틱·세미콜론을 이미 거부해 토큰 경계가 단순하다(문자열
// 리터럴은 스캔 직전에 지운다).
function assertNoTableFunctions(sqlNoStrings) {
  const stack = [{ inFrom: false, expectTable: false }]; // 괄호 깊이별 파싱 상태
  const top = () => stack[stack.length - 1];
  const endKw = new Set(["where", "prewhere", "group", "order", "limit", "having", "settings", "union", "window", "qualify"]);
  // word(바로 뒤따르는 `(` 포함) | 단독 ( ) , | 기타 non-space 1글자
  const re = /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(\s*\()?|([(),])|(\S)/g;
  let m;
  while ((m = re.exec(sqlNoStrings))) {
    const [, word, fnParen, punc] = m;
    if (word !== undefined) {
      const f = top();
      const lw = word.toLowerCase();
      if (fnParen && f.expectTable) throw new Error("테이블 함수는 허용되지 않습니다");
      if (lw === "from" || lw === "join") { f.inFrom = true; f.expectTable = true; }
      else if (endKw.has(lw)) { f.inFrom = false; f.expectTable = false; }
      else if (lw === "on" || lw === "using") { f.expectTable = false; }
      else if (f.expectTable) { f.expectTable = false; } // 테이블 이름 소비
      if (fnParen) stack.push({ inFrom: false, expectTable: false }); // 함수 호출 → 새 괄호 프레임
    } else if (punc === "(") {
      top().expectTable = false; // 서브쿼리 테이블 참조는 허용
      stack.push({ inFrom: false, expectTable: false });
    } else if (punc === ")") {
      if (stack.length > 1) stack.pop();
    } else if (punc === "," && top().inFrom) {
      top().expectTable = true; // comma cross-join → 다음 테이블 참조
    }
  }
}

// SELECT/WITH 단일 문장만 통과 — 나머지는 전부 거부. queryReadonly의 readonly=1이 2차 방어라
// 여기는 명백한 것만 거른다(정교한 SQL 파서는 오버킬). 테이블 함수는 readonly=1이 막지 *않아*
// (SSRF: 169.254.169.254 IMDS·file()·내부망) assertNoTableFunctions로 구조적 차단한다.
// 주석(`--`, `/* */`, `#`)·인용부호(백틱·큰따옴표)는 스캐너의 토큰 경계를 흐려 테이블 함수
// 우회 벡터가 된다: ClickHouse는 `"quoted"` 식별자와 `#` 단행 주석을 지원해 `FROM "url"(...)`,
// `FROM url #x\n(...)`이 identifier( 인접성 검사를 깬다 — 전부 거부한다(정상 쿼리엔 불필요).
// system/information_schema는 타 사용자의 쿼리 텍스트(query_log) 등이 보여 거부.
export function sanitizeSql(sql) {
  const s = String(sql || "").trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(s)) throw new Error("SELECT/WITH 쿼리만 허용됩니다");
  if (/;/.test(s)) throw new Error("다중 문장은 허용되지 않습니다");
  if (/--|\/\*|[`#"]/.test(s)) throw new Error("주석/인용부호는 허용되지 않습니다");
  if (/\b(insert|alter|drop|truncate|create|rename|grant|attach|detach|optimize|system|kill)\b/i.test(s))
    throw new Error("읽기 전용 쿼리만 허용됩니다");
  if (/\binformation_schema\s*\./i.test(s)) throw new Error("claude_code 스키마만 조회할 수 있습니다");
  assertNoTableFunctions(s.replace(/'(?:[^'\\]|\\.|'')*'/g, " ")); // 문자열 리터럴 제거 후 스캔
  return s;
}

const SYSTEM = `당신은 Claude Code 사용량 대시보드의 분석 어시스턴트입니다. ClickHouse(claude_code DB)를 조회해 질문에 답하세요.

테이블:
1. otel_metrics_sum — 메트릭. 컬럼: TimeUnix(DateTime), MetricName, Value(Float64), UserEmail, SessionId, Model, TokenType(input/output/cacheRead/cacheCreation), Decision(accept/reject), SkillName, AggregationTemporality(2=cumulative), Attributes(Map).
   MetricName 값: claude_code.session.count / .token.usage / .cost.usage / .lines_of_code.count / .commit.count / .pull_request.count / .code_edit_tool.decision / .active_time.total
2. otel_logs — 이벤트. 컬럼: Timestamp, EventName(tool_result/user_prompt 등), UserEmail, SessionId, ToolName, McpServerName, Success.

중요 — cumulative 함정: otel_metrics_sum은 세션 단위 누적 카운터를 30초마다 재보고하므로 sum(Value)를 그대로 쓰면 심하게 과대집계됩니다. 또한 세션이 조회 기간(from) 이전에 시작했으면 그 세션의 누적값 전체가 기간 안에 잡혀 과대집계됩니다. 기간 [시작, 끝) 안의 실제 증가량을 구하려면 세션·시리즈 단위로 "끝 직전 누적값 - 시작 직전 누적값"을 diff하세요(음수 방지 greatest):
SELECT sum(inc) FROM (
  SELECT greatest(maxIf(Value, TimeUnix < {끝}) - maxIf(Value, TimeUnix < {시작}), 0) AS inc
  FROM otel_metrics_sum
  WHERE MetricName='...' AND TimeUnix < {끝}
  GROUP BY cityHash64(toString(Attributes)), SessionId)
(기간 전체 총량이면 {시작}=조회 시작 시각. 대시보드 서버 쿼리도 이 boundary-diff 방식을 씁니다.)
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

// 인증된(혹은 탈취된) 크리덴셜 하나로 hop×Bedrock ConverseStream을 무제한 호출하면 비용 증폭/DoS라
// per-IP 분당 상한을 둔다. ponytail: 단일 파드 in-memory sliding window — 멀티 레플리카로 가면
// 파드별 카운터라 한도가 N배 느슨해지니 그때 공유 스토어(Redis 등)로 옮긴다.
const RATE_MAX = 10, RATE_WINDOW_MS = 60_000, MAX_MESSAGES = 30;
const rateHits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const hits = (rateHits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  rateHits.set(ip, hits);
  if (rateHits.size > 5000) for (const [k, v] of rateHits) if (!v.some((t) => now - t < RATE_WINDOW_MS)) rateHits.delete(k);
  return hits.length > RATE_MAX;
}

// POST /api/chat {messages:[{role,content}]} → SSE(status/text/done/error 이벤트) 스트림.
export async function handleChat(req, res) {
  if (rateLimited(req.ip)) {
    res.status(429).json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const messages = (req.body?.messages || [])
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
      .slice(-MAX_MESSAGES)
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
        // SQL 원문은 클라이언트로 보내지 않는다 — 모델이 만든 쿼리에 이메일/세션ID 등 민감 telemetry
        // 조건이 실릴 수 있어 화면공유/로그로 노출된다. FloatingChat은 message만 렌더한다.
        send("status", { message: "쿼리 실행 중..." });
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
    // basic auth 뒤라 위험도는 낮지만, ClickHouse/AWS SDK 원문 에러(내부 테이블명·권한
    // 정보)를 클라이언트에 그대로 보내지 않는다 — 서버 로그에만 전체 스택을 남긴다.
    console.error("/api/chat", err);
    send("error", { message: "요청을 처리하지 못했습니다. 다시 시도해 주세요." });
  } finally {
    res.end();
  }
}
