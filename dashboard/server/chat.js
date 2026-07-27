import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { queryReadonly } from "./clickhouse.js";
import { GROUP_CTE } from "./grouping.js";
import { PRICING_PROMPT_TABLE } from "./pricing.js";

// Ask Claude — Bedrock ConverseStream + run_sql 툴콜 루프 (whchoi98 대시보드의 Analyze 상당,
// 대상 저장소만 Athena → 우리 ClickHouse). 모델 기본값은 sonnet-5이고 CHAT_MODEL_ID로 바꿀 수 있다.
// 신뢰 경계: run_sql은 basic auth(index.js) 통과자 전원에게 claude_code.* 전 컬럼(UserEmail,
// Attributes 등 raw telemetry 포함) 읽기를 허용한다 — SYSTEM 프롬프트가 안내하는 컬럼 목록은
// 힌트일 뿐 권한 경계가 아니다. 다만 화면 노출(개인정보) 관점에서는 다른 curated API처럼
// UserEmail을 그대로 보여주면 안 되므로, run_sql의 결과 행이 모델에게 돌아가기 *전에*
// maskEmailValues로 마스킹한다(스트리밍 텍스트를 사후에 정규식으로 마스킹하는 방식은 SSE 청크
// 경계가 이메일 문자열 중간에서 끊길 수 있어 깨지기 쉽다 — 툴 결과 단계에서 막는 게 더 안전).
// 이건 "모델이 원본을 아예 볼 수 없다"는 보장이 아니라 화면 노출 완화용 2차 방어다 —
// sanitizeSql처럼 정교한 파서 없이 값 패턴으로만 판단하므로 reverse()/hex()/base64Encode()
// 등으로 텍스트 형태 자체를 바꿔 버리면(즉 결과가 더 이상 이메일처럼 안 보이면) 못 잡는다.
// 값 전체 일치가 아니라 replace로 문자열 내부 어디든 찾아 마스킹하고(concat('x=', UserEmail)
// 같은 케이스), 배열/객체 값도 재귀 순회한다(groupArray(UserEmail)/Attributes map 등이 통째로
// 새는 걸 막음 — 리뷰에서 MAJOR로 확인된 실제 우회 경로).
// 유저별 인증/멀티테넌시가 들어오면 이 가정이 깨지므로 그때 aggregate/컬럼 allowlist로 전환한다.
// 로컬 파트를 `[^\s@]+`(공백/@만 제외)로 느슨하게 잡으면 "user=ojs0106@gmail.com"처럼 앞에
// 인접한 비-이메일 문자(=, ' 등)까지 그리디하게 로컬 파트로 삼켜, 실제 마스킹은 그 삼켜진
// 구간의 뒷부분 2글자만 남기고 앞부분(prefix)까지 가려버린다(테스트에서 확인된 회귀) — 실제
// 이메일 로컬 파트에 쓰이는 문자 집합으로 좁혀 프리픽스와의 경계를 명확히 한다.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// web/src/fmt.js의 maskEmail과 동일 규칙(앞 2글자 + ****** + @도메인, 서로 다른 이메일이 같은
// 라벨로 충돌할 수 있음도 동일) — server/web은 의존성을 안 섞으므로(dashboard/CLAUDE.md) 복제,
// 한쪽을 바꾸면 반대쪽도 맞춰야 한다(normModel()/normalizeModelId()와 같은 관례).
function maskEmail(match) {
  const at = match.indexOf("@");
  return `${match.slice(0, Math.min(2, at))}******${match.slice(at)}`;
}

// 임의 문자열(에러 메시지 등)에 박힌 이메일도 같은 규칙으로 마스킹 — ClickHouse 파싱 오류가
// 입력값을 에코하는 경로(toDateTime(UserEmail) → "Cannot parse string 'x@y.com' ...")를 막는다.
export function maskEmailText(s) {
  return String(s).replace(EMAIL_RE, maskEmail);
}

// 컬럼명이 아니라 값 형태로 판단해야 `SELECT UserEmail AS user`처럼 별칭을 붙여도 걸린다.
// object key도 마스킹해야 한다 — `SELECT map(UserEmail, count()) ...`처럼 ClickHouse Map을
// JSON으로 직렬화하면 이메일이 key로 내려온다(리뷰에서 MAJOR로 확인된 우회 경로).
// 마스킹은 many-to-one이라 두 원본 key가 같은 마스킹 라벨로 충돌할 수 있다 — 처음엔 `{[mk]: mv}`
// 단순 재구성(Object.fromEntries의 last-wins)으로 값이 사라졌고(리뷰 MAJOR), 그다음엔
// `[].concat(prev, mv)`로 고쳤더니 값 자체가 배열이면(groupArray 등) 1단계 평탄화되어 두 유저의
// 배열이 하나로 섞이고, 원래부터 배열인 단일 유저 값과 충돌 결과 배열을 구분할 수 없게 됐다
// (리뷰 MAJOR, 재발). 근본 해결: "원본 key가 이메일 형태였는지"(mk !== k)로 판단해, 그런
// map 항목만 충돌 여부와 무관하게 항상 `{values: [...]}`로 감싼다 — 모양이 매번 동일해 모델이
// "배열이면 충돌" 같은 추측을 할 필요가 없다. 이메일이 아닌 보통 필드명(예: "nested")은 마스킹해도
// mk===k이므로 스칼라 그대로 둔다(기존 curated 필드 구조를 건드리지 않음).
function maskValue(v) {
  if (typeof v === "string") return maskEmailText(v);
  if (Array.isArray(v)) return v.map(maskValue);
  if (v && typeof v === "object") {
    const grouped = new Map();
    for (const [k, vv] of Object.entries(v)) {
      const mk = maskEmailText(k);
      const mv = maskValue(vv);
      if (mk === k) {
        grouped.set(mk, mv);
        continue;
      }
      const prev = grouped.get(mk);
      if (prev) prev.values.push(mv);
      else grouped.set(mk, { values: [mv] });
    }
    return Object.fromEntries(grouped);
  }
  return v;
}

export function maskEmailValues(rows) {
  return rows.map(maskValue); // row 자체가 object이므로 maskValue의 object 분기가 key까지 마스킹한다
}
const MODEL_ID = process.env.CHAT_MODEL_ID || "global.anthropic.claude-sonnet-5";
const MAX_HOPS = 4;

// 워크샵 계정은 Bedrock 호출을 us-west-2만 허용 — 인프라 리전(AWS_REGION)과 달라야 하므로
// Bedrock 전용 오버라이드를 둔다. 미설정 시 기존 동작(AWS_REGION → us-east-1) 그대로.
const client = new BedrockRuntimeClient({
  region: process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-east-1",
});

// FROM 절의 테이블 참조 위치(FROM/JOIN 직후, FROM 절 내 comma cross-join 직후)에서 두 가지를
// 검사한다: (1) identifier( 형태면 거부 — 테이블 함수(url/s3/remote/file/...)라는 카테고리
// 전체를 괄호 깊이·JOIN 종류 무관하게 막는 구조적 규칙. 정상 테이블 참조는 순수 식별자
// (otel_metrics_sum 등)나 서브쿼리 `(SELECT ...)`뿐이다. 이전엔 `\b(from|join)\s+\w+\s*\(`
// 정규식이었는데 FROM/JOIN 직후 첫 토큰만 봐서 comma cross-join(`FROM otel_logs, url(...)`)으로
// 우회됐다(실측: 리뷰에서 확인). (2) `db.table` 형태면 db가 claude_code인지 검사 — otel_reader의
// ClickHouse grant(`GRANT SELECT ON claude_code.*`)가 apply 전이거나 operator가 config
// `<grants>`를 렌더하지 않으면 앱 계층 방어가 전무해 `FROM otherdb.some_table`로 cross-DB 조회가
// 새는 구조적 결함이었다(실측: 리뷰에서 확인) — DB 미지정 참조는 세션 기본 DB(claude_code, 접속
// 설정에서 고정)로 풀리므로 그대로 허용.
// SELECT/WHERE의 스칼라·집계 함수(max()/toDate()...)나 alias.column(m.Value 등)은 테이블 참조
// 위치가 아니라 이 검사에 걸리지 않는다.
// 또한 stack 깊이가 0인데 `)`가 더 나오면 즉시 거부한다 — 이전엔 `if (stack.length > 1)`로
// 조용히 무시해, sanitize를 통과한 SQL에 남는 여분의 `)`가 queryReadonly의
// `SELECT * FROM (${sql}) LIMIT 201` 래핑 괄호를 조기에 닫아 `UNION ALL SELECT ... WHERE (...`
// 로 LIMIT 201 서버 캡을 우회하는 breakout 경로였다(실측: 리뷰에서 확인). 함수 끝에서 괄호가
// 전부 안 닫혔으면(stack.length !== 1)도 마찬가지로 거부 — 어느 쪽이든 래핑을 깨는 방향의
// 불균형은 전부 막는다.
// 전제: 진입부에서 주석(--,/**/)·백틱·세미콜론을 이미 거부해 토큰 경계가 단순하다(문자열
// 리터럴은 스캔 직전에 지운다).
// ClickHouse는 `db . table`처럼 점 주변 공백을 허용하는데, 이전 정규식은 점이 식별자에
// 바로 인접해야만 `db.table` 하나의 word로 묶었다 — 공백이 끼면 `otherdb`가 단독 테이블명으로
// 소비돼 dot 검사를 건너뛰고 cross-DB 조회가 샜다(실측: 리뷰에서 확인). 정규식이 점 앞뒤
// 공백을 삼키고, 비교용 lw에서 남은 공백을 전부 제거해 정규화한 뒤 dot을 찾는다.
function assertNoTableFunctions(sqlNoStrings) {
  const stack = [{ inFrom: false, expectTable: false }]; // 괄호 깊이별 파싱 상태
  const top = () => stack[stack.length - 1];
  const endKw = new Set(["where", "prewhere", "group", "order", "limit", "having", "settings", "union", "window", "qualify"]);
  // word(바로 뒤따르는 `(` 포함) | 단독 ( ) , | 기타 non-space 1글자
  const re = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)(\s*\()?|([(),])|(\S)/g;
  let m;
  while ((m = re.exec(sqlNoStrings))) {
    const [, word, fnParen, punc] = m;
    if (word !== undefined) {
      const f = top();
      const lw = word.replace(/\s+/g, "").toLowerCase();
      if (fnParen && f.expectTable) throw new Error("테이블 함수는 허용되지 않습니다");
      if (lw === "from" || lw === "join") { f.inFrom = true; f.expectTable = true; }
      else if (endKw.has(lw)) { f.inFrom = false; f.expectTable = false; }
      else if (lw === "on" || lw === "using") { f.expectTable = false; }
      else if (f.expectTable) {
        f.expectTable = false; // 테이블 이름 소비
        const dot = lw.indexOf(".");
        if (dot >= 0 && lw.slice(0, dot) !== "claude_code")
          throw new Error("claude_code 스키마만 조회할 수 있습니다");
      }
      if (fnParen) stack.push({ inFrom: false, expectTable: false }); // 함수 호출 → 새 괄호 프레임
    } else if (punc === "(") {
      top().expectTable = false; // 서브쿼리 테이블 참조는 허용
      stack.push({ inFrom: false, expectTable: false });
    } else if (punc === ")") {
      if (stack.length === 1) throw new Error("괄호가 맞지 않습니다");
      stack.pop();
    } else if (punc === "," && top().inFrom) {
      top().expectTable = true; // comma cross-join → 다음 테이블 참조
    }
  }
  if (stack.length !== 1) throw new Error("괄호가 맞지 않습니다");
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

// 스키마·집계 규칙 설명만 따로 export한다 — chat.test.js가 실측 스키마와의 드리프트를
// 잡아낼 수 있게(문자열 하나를 통째로 바꿔도 회귀 테스트가 실패하도록), 그리고 SYSTEM 안에서
// "무엇을 조회할 수 있는가"와 "규칙"을 시각적으로 분리한다.
export const SCHEMA_CONTEXT = `테이블(우선순위 순):
1. otel_metrics_sum_hourly — 시간당 롤업. **대시보드의 모든 쿼리가 이걸 쓴다. 특별히 분 단위
   해상도가 필요한 경우가 아니면 항상 이 테이블부터 쓰세요** (원본보다 ~86배 작아 스캔이 훨씬
   저렴합니다). 컬럼: hour(DateTime, 시간 버킷), MetricName, SessionId, SeriesKey(UInt64, 시리즈
   식별자), UserEmail, AggregationTemporality(1=delta, 2=cumulative), Model, TokenType, Decision
   (accept/reject), SkillName, ToolName, max_value(그 시간 버킷 종료 시점 누적값 — temporality=2
   경계 diff에 사용), sum_value(그 시간 버킷 내 증가량 합 — temporality=1 구간 합계에 사용),
   has_org(그 시간 버킷에 organization.id가 관측됐으면 1).
2. otel_metrics_sum — 원본 메트릭(분 단위 이하 해상도가 필요할 때만). 컬럼: TimeUnix(DateTime),
   MetricName, Value(Float64), UserEmail, SessionId, SeriesKey(UInt64, 시리즈 식별자 — 이미
   컬럼으로 있으니 cityHash64 등으로 직접 만들지 마세요), Model, TokenType, Decision, SkillName,
   AggregationTemporality, Attributes(Map).
   MetricName 값(8개, 이 외 값 없음): claude_code.session.count / .token.usage / .cost.usage /
   .lines_of_code.count / .commit.count / .pull_request.count / .code_edit_tool.decision /
   .active_time.total.
3. otel_logs — 이벤트. 컬럼: Timestamp, TimestampTime(DateTime), EventName, UserEmail, SessionId,
   ToolName, McpServerName, McpToolName, Success, LogAttributes(Map).
   EventName 주요 값: hook_execution_start/complete, api_request, tool_decision, tool_result,
   assistant_response, user_prompt, mcp_server_connection, api_error, api_retries_exhausted,
   compaction, skill_activated, subagent_completed.

중요 — temporality 분기(단정하지 말 것): AggregationTemporality는 거의 항상 2(cumulative)지만
session.count 등 일부 데이터포인트는 1(delta)로도 옵니다. 대시보드 서버(queries.js)도 매번
if(AggregationTemporality = 2, ..., ...)로 분기합니다 — 2로 가정하고 max()만 쓰면 delta 행이
섞인 시리즈에서 틀립니다.
- temporality=2(cumulative): 세션 단위 누적 카운터를 재보고하므로 sum(Value)/sum(max_value)를
  그대로 쓰면 심하게 과대집계됩니다. 세션이 조회 기간(from) 이전에 시작했으면 그 세션의 누적값
  전체가 기간 안에 잡혀 과대집계되기도 합니다. 기간 [시작, 끝) 안의 실제 증가량은 세션·시리즈
  단위로 "끝 직전 누적값 - 시작 직전 누적값"을 diff합니다(음수 방지 greatest).
- temporality=1(delta): 이미 구간 증가분이므로 diff하면 안 됩니다 — 그냥 구간 sum(sumIf)입니다.
먼저 테이블을 고르세요 — 롤업은 정각 경계에서만 정확합니다:
- 조회 구간의 시작·끝이 **둘 다 정각**(예: 최근 2일, 어제 00:00~00:00, 오늘 09:00~18:00)이면
  otel_metrics_sum_hourly를 쓰세요. 정확합니다.
- 경계가 정각이 아니거나(예: 10:30~12:30) 분 단위 정확도가 필요하면 **반드시 원본
  otel_metrics_sum을 TimeUnix로 쓰세요**. 롤업으로 근사하지 마세요: hour는 시간 버킷이라
  경계 버킷이 통째로 포함되거나 빠지고, 그때 틀리는 양은 "1시간"이 아니라 **그 경계 시간대에
  실제로 일어난 증가량**입니다 — 사용량이 몰린 시간대면 오차가 임의로 커집니다.
otel_metrics_sum_hourly 기준 두 분기를 함께 쓰는 형태(정각 경계 전제, 모델·TokenType별로 쪼개는 예):
SELECT Model, TokenType, sum(inc) AS inc FROM (
  SELECT Model, TokenType,
         if(AggregationTemporality = 2,
             greatest(maxIf(max_value, hour < {끝}) - maxIf(max_value, hour < {시작}), 0),
             sumIf(sum_value, hour >= {시작} AND hour < {끝})) AS inc
  FROM otel_metrics_sum_hourly
  WHERE MetricName='...' AND hour < {끝}
  GROUP BY Model, TokenType, SessionId, SeriesKey, AggregationTemporality)
GROUP BY Model, TokenType
(기간 전체 총량이면 {시작}=조회 시작 시각. 나중에 바깥에서 그룹핑하거나 sumIf 조건으로 쓸 컬럼은
 반드시 서브쿼리의 SELECT와 GROUP BY에 함께 넣으세요 — 서브쿼리에 없는 컬럼은 바깥 스코프에서
 참조할 수 없습니다. 총량만 필요하면 Model/TokenType을 양쪽에서 빼면 됩니다. 원본
 otel_metrics_sum을 쓸 때는 hour 대신 TimeUnix, max_value/sum_value 대신 Value, GROUP BY에
 SeriesKey, SessionId, AggregationTemporality.)
사용자가 "최근 N시간"처럼 지금 시각 기준으로 물으면 경계가 정각이 아니므로, 원본을 쓰거나
경계를 toStartOfHour로 내려 정각 구간으로 바꾼 뒤 **어느 구간을 실제로 집계했는지 답변에
밝히세요**(예: "10:00~12:00 기준"). 조용히 근사하지 마세요.
유저 수/세션 수 존재 여부(uniqExact)는 원본 테이블을 그대로 써도 됩니다.

중요 — TokenType은 MetricName마다 다른 의미입니다(공통 컬럼을 재사용):
- claude_code.token.usage: input / output / cacheRead / cacheCreation
- claude_code.lines_of_code.count: added / removed
- claude_code.active_time.total: cli / user
- 그 외 메트릭(session.count/commit.count/pull_request.count/cost.usage/code_edit_tool.decision):
  항상 빈 문자열입니다.

중요 — 비용 용어를 섞지 마세요(reported cost ≠ computed cost):
- claude_code.cost.usage("reported_cost")는 Claude Code 클라이언트가 자체 계산해 보고하는
  값입니다. 참고용이며, 대시보드가 보여주는 값과 다를 수 있습니다.
- 대시보드 Cost 페이지 카드가 보여주는 비용("computed cost")은 이 값이 아니라, token.usage의
  4개 TokenType(input/output/cacheRead/cacheCreation) 토큰 수 × 아래 모델별 단가(1M 토큰당
  USD)를 곱해 서버(pricing.js)에서 계산한 값입니다:
${PRICING_PROMPT_TABLE}
  **단가표의 필드명과 TokenType 값이 다릅니다** — 매핑은 다음과 같고, TokenType='cacheWrite'는
  데이터에 존재하지 않으니 그런 조건으로 조회하지 마세요:
    input → input, output → output, cacheRead → cacheRead, **cacheCreation → cacheWrite**
  즉 계산 비용 = (input 토큰×input) + (output 토큰×output) + (cacheRead 토큰×cacheRead)
                + (cacheCreation 토큰×cacheWrite), 전부 1e6으로 나눕니다. TokenType별 합계는
  sumIf(inc, TokenType='input') 처럼 위 boundary-diff 결과에 조건 집계로 뽑되, **Model별 GROUP BY를
  유지하세요** — 여러 모델의 토큰을 먼저 합치고 단가 하나를 곱하면 대시보드 값과 발산합니다.
  모델명은 정규화(us./global./eu./apac./anthropic. 접두사, -v숫자:숫자/날짜(-YYYYMMDD)/[1m]
  접미사 제거) 후 위 표와 매칭합니다 — 원본 Model 값 그대로는 표에 없을 수 있습니다.
- 사용자가 그냥 "비용"을 물으면 기본으로 cost.usage(reported_cost)를 조회해 답하되, 반드시
  "Claude Code 자체 보고 비용"임을 명시하세요. 대시보드 카드 값과 비교/일치를 요구하면 위 단가로
  직접 계산한 뒤 "계산 비용(단가표 기준)"이라고 구분해서 답하세요. 두 값을 같은 것처럼 뭉뚱그려
  답하지 마세요 — 실제로 서로 다른 숫자입니다.`;

// GROUP_CTE(grouping.js)를 그대로 인용한다 — 대시보드 서버가 쓰는 규칙과 프롬프트가 여기서
// 드리프트하면(예: has_org 판별 로직이 바뀌는데 프롬프트는 그대로면) 모델이 대시보드와 다른
// 숫자를 답한다. 복제하지 않고 import해서 원본이 바뀌면 프롬프트도 자동으로 따라간다.
export const SYSTEM = `당신은 Claude Code 사용량 대시보드의 분석 어시스턴트입니다. ClickHouse(claude_code DB)를 조회해 질문에 답하세요.

${SCHEMA_CONTEXT}

중요 — bedrock/enterprise 그룹: 이 값은 어떤 컬럼에도 그대로 저장돼 있지 않습니다(참가자가 로그인
방식을 자유롭게 고르는 워크숍이라 정적 플래그를 심을 수 없음). 대시보드 서버가 쓰는 것과 똑같은
아래 CTE로 세션 단위 사후 추론하세요(유저 단위로 판별하면 안 됩니다 — 한 유저가 세션마다 다른
방식을 썼을 수 있습니다):
${GROUP_CTE}
group by할 때는 이 CTE를 SessionId로 LEFT JOIN하고, 미매칭은 NULL이 아니라 빈 문자열('')이
돌아오니 if(grp = '', 'unknown', grp)로 처리하세요(coalesce는 걸리지 않습니다).

규칙: run_sql로 필요한 데이터를 조회(최대 ${MAX_HOPS}회)한 뒤 한국어로 간결히 답하세요. 표가 어울리면 markdown 표를 쓰세요. 결과는 200행으로 잘립니다.
SQL에 **큰따옴표(")나 백틱(\`)을 절대 쓰지 마세요** — 별칭이든 식별자든 어디에 있든 큰따옴표/백틱이 하나라도 있으면 쿼리 전체가 거부됩니다(보안 샌드박스가 인용부호를 전부 차단, 예외 없음). 별칭에 한국어나 예약어(group 등)를 쓰고 싶으면 그냥 인용부호 없이 쓰거나(ClickHouse는 별칭에 인용부호가 필요 없습니다), 답변을 작성할 때 컬럼명을 한국어로 바꿔서 설명하세요. 조회 횟수는 한정돼 있으니(최대 ${MAX_HOPS}회) 인용부호 실수로 낭비하지 마세요.
UserEmail 값은 개인정보 보호를 위해 이미 마스킹되어 반환됩니다(예: oj******@gmail.com). 집계(합계/카운트/그룹핑)는 반드시 SQL의 GROUP BY에서 원본 UserEmail 기준으로 끝내고 결과를 받으세요 — 마스킹된 라벨은 서로 다른 유저가 같은 문자열로 겹칠 수 있어 고유 식별자가 아니므로, 응답을 작성할 때 같은 마스킹 라벨을 가진 행이라도 절대 하나로 합치거나 재집계하지 마세요. map(UserEmail, ...)처럼 이메일이 key인 결과는 항상 "마스킹라벨": {values: [...]} 형태로 내려옵니다(유저 충돌 여부와 무관하게 매번 이 모양) — values 배열의 원소 하나하나가 그 라벨로 마스킹된 각 유저의 값이니(충돌 없으면 1개, 있으면 여러 개) 그대로 개별 유저 값으로 다루고, 배열 길이가 1보다 크다고 해서 하나의 값으로 합치지 마세요. 마스킹된 값을 원본처럼 되돌리거나 추측하지도 마세요.`;

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

// 툴 결과가 hop마다 messages에 쌓여 다음 hop 입력으로 재전송된다(MAX_HOPS번 누적) — 200행
// JSON이라도 몇 hop 겹치면 다음 요청의 입력이 눈덩이처럼 불어나 maxTokens를 넘기는 원인이 된다.
// queryReadonly의 행 상한(200)과 별개로 문자수 상한을 둬서 모델에 돌려주는 텍스트 크기 자체를 캡한다.
const TOOL_RESULT_CHAR_CAP = 20_000;
export function capToolResultJson(rows, truncated) {
  const json = { rows: maskEmailValues(rows), truncated };
  const s = JSON.stringify(json);
  if (s.length <= TOOL_RESULT_CHAR_CAP) return json;
  // 행 단위로 잘라 유효한 JSON을 유지한다 — 문자열을 그냥 slice하면 깨진 JSON을 모델에 준다.
  let cut = json.rows.length;
  while (cut > 0 && JSON.stringify({ rows: json.rows.slice(0, cut), truncated: true }).length > TOOL_RESULT_CHAR_CAP) cut = Math.floor(cut / 2);
  return { rows: json.rows.slice(0, cut), truncated: true };
}

// AWS SDK 에러를 화면에 보여줄 분류로 좁힌다 — 내부 테이블명/권한 정보는 절대 노출하지 않지만,
// "왜" 실패했는지 정도는 알려줘야 사용자가 재시도할지 기다릴지 판단할 수 있다.
export function classifyChatError(err) {
  const status = err?.$metadata?.httpStatusCode;
  const requestId = err?.$metadata?.requestId;
  const suffix = requestId ? ` (요청ID: ${requestId})` : "";
  if (err?.name === "ThrottlingException" || status === 429)
    return `요청이 몰려 일시적으로 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.${suffix}`;
  if (err?.name === "AccessDeniedException" || status === 403)
    return `모델 접근 권한이 없습니다. 관리자에게 문의해 주세요.${suffix}`;
  if (err?.name === "ValidationException")
    return `대화가 너무 길어졌습니다. 새 질문으로 다시 시도해 주세요.${suffix}`;
  return `요청을 처리하지 못했습니다. 다시 시도해 주세요.${suffix}`;
}

// ThrottlingException은 hop 안에서 스트림이 시작되기 *전에* 던져지므로(SDK가 스트림 자체를
// 재시도하지 않음) 여기서 짧은 지수 백오프로 재시도한다 — 스트림이 이미 일부 텍스트를 보낸
// 뒤의 실패는 재시도하지 않는다(중복 답변 방지).
async function sendConverseWithRetry(cmd, abortSignal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.send(cmd, { abortSignal });
    } catch (err) {
      if (err?.name !== "ThrottlingException" || attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
    }
  }
}

// 한 번의 Bedrock ConverseStream 왕복(스트림 소비 + 텍스트 전송 + 콘텐츠 블록 조립)을 캡슐화한다.
// handleChat의 툴콜 루프와 "hop 예산 소진 뒤 강제 마무리 호출"이 이 로직을 공유해야
// (아래 참고) 마무리 호출에서 파싱/방어 로직이 중복·드리프트되지 않는다.
async function runConverseTurn({ messages, allowTools, send, abortSignal }) {
  const cmd = new ConverseStreamCommand({
    modelId: MODEL_ID,
    system: [{ text: SYSTEM }],
    messages,
    ...(allowTools ? { toolConfig: TOOLS } : {}),
    inferenceConfig: { maxTokens: 8000 },
    // 확장 추론(thinking)을 켠다 — 켜지 않으면 첫 응답 전 수 초가 완전한 공백이라 멈춘 것처럼
    // 보인다. 두 값 모두 이 모델 세대에서 필수 형태다:
    //   - type: "adaptive" — 구버전 {type:"enabled", budget_tokens:N}는 sonnet-5에서 400.
    //     모델이 문제 난이도에 따라 사고량을 스스로 조절한다(고정 토큰 예산 개념 자체가 폐기됨).
    //   - display: "summarized" — sonnet-5의 기본값은 "omitted"이고, 그 경우 reasoning 블록이
    //     빈 문자열로 와서 화면에 보여줄 내용이 없다. 요약이라도 받으려면 명시해야 한다.
    additionalModelRequestFields: { thinking: { type: "adaptive", display: "summarized" } },
  });
  const { stream } = await sendConverseWithRetry(cmd, abortSignal);

  let stopReason = null;
  const content = [];
  let curText = null;
  let curTool = null;
  // reasoning 블록은 text와 signature를 **수정 없이** 그대로 assistant 메시지에 되돌려줘야
  // 한다(AWS SDK 문서 명시). 툴콜 루프는 매 hop마다 assistant 메시지를 다시 보내므로, 이걸
  // 빠뜨리거나 텍스트만 남기면 다음 hop이 서명 검증에서 거부된다.
  let curReasoning = null;
  // maxTokens에 걸려 이 hop에서 툴 입력 JSON이 중간에 잘린 toolUseId들 — 스트림을 죽이지
  // 않고 호출부에서 전용 오류로 모델에 되돌려준다.
  const truncatedToolIds = new Set();
  for await (const ev of stream) {
    const rd = ev.contentBlockDelta?.delta?.reasoningContent;
    if (ev.contentBlockStart?.start?.toolUse) {
      curTool = { ...ev.contentBlockStart.start.toolUse, input: "" };
      // 모델이 SQL을 다 쓸 때까지(toolUse delta 누적, 수 초 이상 걸릴 수 있음) 클라이언트는
      // 아무 이벤트도 못 받아 멈춘 것처럼 보인다(실측: "응답이 없는 것 같다" 리포트) — 툴콜이
      // 시작되는 즉시 상태를 보내 그 공백을 채운다. 실제 실행 시작 시(handleChat) "쿼리
      // 실행 중..."으로 다시 갈아탄다.
      send("status", { message: "쿼리 작성 중..." });
    } else if (ev.contentBlockDelta?.delta?.toolUse) {
      // contentBlockStart 없이 toolUse delta가 먼저 오는 스트림 오류를 방어 — curTool이 없으면
      // 이 delta는 버린다(누락된 몇 글자보다 전체 스트림이 죽는 게 더 나쁘다).
      if (curTool) curTool.input += ev.contentBlockDelta.delta.toolUse.input || "";
    } else if (rd) {
      curReasoning = curReasoning || { text: "", signature: undefined, redactedContent: undefined };
      if (rd.text) {
        curReasoning.text += rd.text;
        send("thinking", { text: rd.text });
      }
      // signature는 블록 끝에 한 번 오고, redactedContent는 안전상 암호화된 변형이다 —
      // 둘 다 화면에 보낼 게 없고 되돌려줄 때만 필요하다.
      if (rd.signature) curReasoning.signature = rd.signature;
      if (rd.redactedContent) curReasoning.redactedContent = rd.redactedContent;
    } else if (ev.contentBlockDelta?.delta?.text) {
      const t = ev.contentBlockDelta.delta.text;
      curText = (curText || "") + t;
      send("text", { text: t });
    } else if (ev.contentBlockStop) {
      if (curTool) {
        let input = {};
        try {
          input = JSON.parse(curTool.input || "{}");
        } catch {
          truncatedToolIds.add(curTool.toolUseId);
        }
        content.push({ toolUse: { toolUseId: curTool.toolUseId, name: curTool.name, input } });
        curTool = null;
      } else if (curReasoning) {
        // redactedContent와 reasoningText는 서로 배타적인 union 멤버다 — 둘을 한 객체에 같이
        // 넣으면 직렬화가 거부되므로 온 쪽만 그대로 돌려준다.
        content.push(
          curReasoning.redactedContent
            ? { reasoningContent: { redactedContent: curReasoning.redactedContent } }
            : { reasoningContent: { reasoningText: { text: curReasoning.text, signature: curReasoning.signature } } }
        );
        curReasoning = null;
      } else if (curText !== null) {
        content.push({ text: curText });
        curText = null;
      }
    } else if (ev.messageStop) {
      stopReason = ev.messageStop.stopReason;
    }
  }
  return { content, stopReason, truncatedToolIds };
}

// 한 턴 안에서 모델이 실제로 실행할 수 있는 run_sql 총 횟수 상한 — MAX_HOPS(왕복 수)와는 다른
// 축이다. 한 hop 응답에 toolUse 블록이 여러 개(병렬 툴콜) 실리면 hop 수보다 SQL 실행이 더 많이
// 나갈 수 있어, 왕복 상한만으로는 총 실행 횟수가 안 막힌다.
const MAX_SQL_CALLS = 8;

// POST /api/chat {messages:[{role,content}]} → SSE(status/text/done/error 이벤트) 스트림.
export async function handleChat(req, res) {
  if (rateLimited(req.ip)) {
    res.status(429).json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  // res.write 자체는 성공/실패를 던지지 않지만, 클라이언트가 이미 연결을 끊은 뒤 write하면
  // 예외가 나거나(소켓 파괴 상태) 조용히 버려진다 — 어느 쪽이든 매 send() 호출부에서 방어하지
  // 않아도 되게 여기서 한 번만 가드한다.
  const send = (event, data) => {
    if (res.writableEnded) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // 소켓이 이미 닫혔다 — 버린다.
    }
  };

  // 브라우저가 탭을 닫거나 새 질문으로 이전 요청을 abort()하면(useChatStream.js) 이 SSE 연결도
  // 끊긴다 — 그때 이미 시작된 Bedrock ConverseStream/ClickHouse 쿼리를 계속 돌리는 건 낭비다.
  // res.writableEnded가 아직 false인 상태로 'close'가 오면 정상 완료가 아니라 클라이언트가
  // 먼저 끊은 경우이므로 abort한다.
  const abortController = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  let hop = 0;
  let sqlCalls = 0;
  let stopReason = null;
  try {
    const messages = (req.body?.messages || [])
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
      .slice(-MAX_MESSAGES)
      .map((m) => ({ role: m.role, content: [{ text: String(m.content).slice(0, 8000) }] }));
    if (!messages.length) throw new Error("메시지가 비어 있습니다");

    // hop < MAX_HOPS(이전엔 <=였다 — MAX_HOPS=4인데 hop 0..4로 5회 왕복하는 off-by-one이었다)로
    // 정확히 MAX_HOPS회 왕복 안에서 끝나야 한다. 루프가 break 없이 다 돌면(마지막 hop도 여전히
    // tool_use) hop이 MAX_HOPS까지 증가한 상태로 끝나므로, 루프 뒤 `hop === MAX_HOPS`가 곧
    // "왕복을 다 쓰고도 모델이 더 조회하려 했다"는 뜻이다.
    for (; hop < MAX_HOPS; hop++) {
      // 툴 결과를 보낸 뒤 다음 Bedrock 응답이 올 때까지(모델이 결과를 "읽는" 시간, 수 초~수십초)
      // 클라이언트가 아무 이벤트도 못 받는 공백이 있다(실측: "응답이 없는 것 같다" 리포트) —
      // 매 hop 시작 시 즉시 상태를 갈아줘서 사용자가 계속 진행 중임을 알 수 있게 한다.
      send("status", { message: hop === 0 ? "질문을 이해하는 중..." : "조회 결과를 확인하는 중..." });
      const { content, stopReason: sr, truncatedToolIds } = await runConverseTurn({
        messages,
        allowTools: true,
        send,
        abortSignal: abortController.signal,
      });
      stopReason = sr;
      messages.push({ role: "assistant", content });
      if (stopReason !== "tool_use") break;

      const results = [];
      for (const block of content) {
        if (!block.toolUse) continue;
        const { toolUseId, input } = block.toolUse;
        if (truncatedToolIds.has(toolUseId)) {
          results.push({ toolResult: { toolUseId, content: [{ text: "쿼리 오류: 입력이 너무 길어 잘렸습니다. 더 짧은 쿼리로 다시 시도하세요." }], status: "error" } });
          continue;
        }
        if (sqlCalls >= MAX_SQL_CALLS) {
          results.push({ toolResult: { toolUseId, content: [{ text: "쿼리 오류: 이 턴에서 실행 가능한 쿼리 횟수를 모두 사용했습니다." }], status: "error" } });
          continue;
        }
        sqlCalls++;
        // SQL 원문을 클라이언트로 보낸다. 원래는 "모델이 만든 쿼리에 이메일/세션ID 등 민감
        // telemetry 조건이 실려 화면공유로 노출된다"는 이유로 숨겼는데, 진행 상황이 안 보여
        // 멈춘 것처럼 느껴진다는 실제 사용자 피드백으로 노출하는 쪽을 택했다(명시적 결정).
        // 이메일은 최소한 마스킹한다 — 다른 모든 경로(툴 결과·에러 메시지)가 이미 그렇게 하고
        // 있어서 SQL만 원문으로 새면 그 방어가 무의미해진다. 세션ID 등은 그대로 보인다.
        send("status", { message: "쿼리 실행 중...", sql: maskEmailText(input.sql || "") });
        try {
          const { rows, truncated } = await queryReadonly(sanitizeSql(input.sql), abortController.signal);
          results.push({ toolResult: { toolUseId, content: [{ json: capToolResultJson(rows, truncated) }] } });
        } catch (err) {
          // ClickHouse 파싱 오류는 입력값을 메시지에 에코한다(예: toDateTime(UserEmail) →
          // "Cannot parse string 'ojs0106@gmail.com' ...") — 모델이 이 텍스트를 답변에 인용해
          // 화면에 그대로 노출될 수 있으므로 다른 경로와 동일하게 마스킹한다(리뷰에서 MAJOR로 확인).
          results.push({ toolResult: { toolUseId, content: [{ text: `쿼리 오류: ${maskEmailText(err.message)}` }], status: "error" } });
        }
      }
      messages.push({ role: "user", content: results });
    }
    // hop 예산이 끝났는데 방금 hop의 툴 실행 결과가 messages에 있다면(stopReason이 여전히
    // "tool_use") — 그 결과를 모델이 한 번도 못 보고 그냥 "조회 횟수를 다 썼다"는 문구만 나가는
    // 게 원래 동작이었다(실측: 성공한 쿼리 결과가 버려지고 빈 답변으로 끝남). toolConfig 없이
    // 한 번 더 호출해 이미 모은 데이터로 반드시 텍스트 답을 내게 강제한다(툴을 다시 요청할 수
    // 없으니 무한 루프가 될 수 없다).
    if (hop === MAX_HOPS && stopReason === "tool_use") {
      send("status", { message: "답변을 정리하는 중..." });
      const { content: finalContent, stopReason: finalStop } = await runConverseTurn({
        messages,
        allowTools: false,
        send,
        abortSignal: abortController.signal,
      });
      messages.push({ role: "assistant", content: finalContent });
      stopReason = finalStop;
    }
    // 스트림이 성공적으로 끝났어도 stopReason이 "성공"을 뜻하지 않는 경우를 알린다 — 안 그러면
    // 잘린 답변이 그냥 done으로 넘어가 사용자가 잘못된 확신을 갖게 된다.
    if (stopReason === "max_tokens") send("text", { text: "\n\n_(응답이 길어 일부가 잘렸을 수 있습니다 — 필요하면 더 구체적으로 나눠서 다시 물어봐 주세요.)_" });
    send("done", {});
  } catch (err) {
    if (abortController.signal.aborted) return; // 클라이언트가 이미 떠났다 — 로그/응답 낼 필요 없음
    // basic auth 뒤라 위험도는 낮지만, ClickHouse/AWS SDK 원문 에러(내부 테이블명·권한
    // 정보)를 클라이언트에 그대로 보내지 않는다 — 서버 로그에는 분류에 필요한 필드를 구조화해 남긴다.
    // 이메일은 로그에 적재하기 전에 마스킹한다 — ClickHouse 파싱 에러는 문제가 된 SQL을 그대로
    // 에코하므로 UserEmail 리터럴이 파드 로그에 평문으로 남을 수 있다(런북이 이 로그를 grep하도록
    // 안내하므로 로그 접근자 전원에게 노출된다). 응답 경로에만 마스킹이 있었다.
    console.error("/api/chat", {
      hop,
      modelId: MODEL_ID,
      name: err?.name,
      status: err?.$metadata?.httpStatusCode,
      requestId: err?.$metadata?.requestId,
      message: maskEmailText(err?.message ?? ""),
      stack: maskEmailText(err?.stack ?? ""),
    });
    send("error", { message: classifyChatError(err) });
  } finally {
    if (!res.writableEnded) res.end();
  }
}
