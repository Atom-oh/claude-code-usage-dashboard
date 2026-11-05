// A/B 그룹(bedrock vs enterprise) 판별 규칙 — 실측 후 고칠 지점은 이 파일 하나로 모은다.
//
// Workshop Studio 시나리오에서는 EXPERIMENT_GROUP 환경변수를 EC2에 정적으로 심을 수 없다
// (같은 이미지, 참가자가 로그인 방식을 선택). 그래서 텔레메트리 값으로 사후 판별한다:
//   1순위 — 유저가 실제로 호출한 model 이름이 bare "claude-*"가 아니면 bedrock (Enterprise는
//           bare claude-*만 낼 수 있음 — Bedrock ID는 [global.|us.|eu.|apac.]anthropic.* /
//           anthropic.*(인리전) / -vN:M 접미사 / 비-Anthropic 프로바이더(openai., xai. 등))
//   2순위 — model 정보가 없으면 organization.id 존재 여부로 enterprise 추정
//   그 외 — unknown
//
// 실측 확인(2026-07-06, 실제 claude 세션 — bedrock: ctrust 별칭, enterprise: 직접 로그인):
//   - bedrock model 예: "global.anthropic.claude-opus-4-8" (리전 프리픽스가 us.가 아니라
//     global.일 수 있음 — 'anthropic.' 포함 여부로 잡으면 리전 프리픽스와 무관하게 맞음)
//   - enterprise model 예: "claude-sonnet-5" (anthropic. 없음, ':' 없음)
//   - organization.id는 ResourceAttributes가 아니라 **Attributes(datapoint별)**에 실린다
//     (실측 전 가정이 틀렸던 지점 — 원래 ResourceAttributes로 짜여있던 걸 수정).
//
// 실측 확인(2026-07-07): 인증 방식(Bedrock env var vs Enterprise 로그인)은 프로세스/세션 시작 시
// 고정되고 세션 도중 바뀌지 않는다 — 판별은 세션(SessionId) 단위여야 정확하다. UserEmail 단위로
// 판별하면 한 이메일이 여러 세션에 걸쳐 다른 방식을 쓴 경우(테스트/재로그인 등) "bedrock 스타일
// 모델을 한 번이라도 호출했으면 유저 전체를 bedrock 확정"하는 OR 휴리스틱이 소수의 bedrock
// 세션만으로 그 유저의 나머지 enterprise 세션까지 전부 bedrock으로 덮어써버린다(실측: 15세션 중
// 3개만 bedrock인데 유저 전체가 bedrock으로 나옴). SessionId는 otel_metrics_sum(ALTER로 추가)과
// otel_logs(원래 스키마) 양쪽에 이미 promoted column이라 스키마 변경 없이 그레인만 바꾸면 된다.
// 원본이 아니라 시간별 rollup(otel_metrics_sum_hourly)을 읽는다 — 이 CTE는 모든 대시보드
// 쿼리 앞에 붙는데 시간 조건이 없어서(세션의 그룹은 창 밖 행으로 판별될 수 있음) 원본 기준으론
// 쿼리마다 전체 테이블 풀스캔이었다(실측 2026-07-10: 9.5M행, 쿼리당 read_rows 26M의 주요 지분).
// rollup은 ~86x 작고 organization.id 존재 여부가 has_org로 미리 접혀 있어 무제한 스캔이 저렴하다.
// 실측 확인(2026-09-04): Bedrock은 비-Anthropic 모델도 서빙한다 — 라이브에 global.openai.gpt-5.6-sol,
// global.xai.grok-4.6, moonshotai.kimi-k2.5, zai.glm-5, deepseek.v3.2, devstral-small-2,
// minimax.minimax-m2.5, gemma-4-31b-vllm, qwen.qwen3-coder-next 9종이 존재하는데 전부
// 'anthropic.' 미포함·':' 미포함이라 예전 1순위 조건에 안 걸렸다(그 결과 32세션이 unknown,
// 2세션은 has_org 신호에 밀려 enterprise로 오분류). Enterprise(Claude 로그인)는 bare
// "claude-*" 형태만 낼 수 있으므로(실측: has_org 세션의 모델은 전부 claude-* 또는
// [global.|us.]anthropic.* — 후자는 resume으로 인증이 섞인 세션), bedrock 판별은
// "빈 값이 아니고 claude-로 시작하지 않는 모델이 하나라도 있으면"으로 잡는다. 이 조건은
// [1m] 접미사(claude-fable-5[1m])는 통과시키고, anthropic./us.anthropic./global.anthropic./
// ':' 버전 접미사/비-Anthropic 프로바이더를 전부 포섭한다(예전 조건의 상위집합).
//
// 실측 확인(2026-10-18, 최근 30일 405세션): rollup이 접어 두는 계정 신호는 organization.id
// 존재 여부(has_org) 하나뿐이고 규칙도 이것만 본다. 모델이 관측됐는데 has_org가 없으면 bedrock이다.
// user.account_uuid/client_request_id/request_id는 규칙에 쓰지 않는 보강 근거일 뿐이다: bare
// claude-* 모델인데 organization.id가 없는 149세션은 어떤 api_request 로그에도 request_id/
// client_request_id가 없었다(bedrock 모델 15세션과 같은 패턴) — 즉 organization 없는 세션 중
// request_id를 내는 1P Anthropic API-key 세션은 관측되지 않았다. 실패 조건: organization.id 없이 bare claude-* id를 내는 Anthropic API-key/
// Vertex/게이트웨이 경로는 bedrock(3P 라벨, 소유자 승인)으로 분류된다. 모델 관측이 없는 세션은
// 계속 unknown이다.
const LEGACY_GROUP = `multiIf(
            countIf(Model != '' AND NOT startsWith(Model, 'claude-')) > 0, 'bedrock',
            max(has_org) = 1, 'enterprise',
            countIf(Model != '') > 0, 'bedrock',
            'unknown'
        )`;

// Claude Code v2.1.317+ reports the API provider as `anthropic.provider` on
// every metric (observed 2026-11-04: 'bedrock', 'firstParty'). Migration 009
// keeps session-hour membership in claude_session_providers_v1. When enabled,
// reported evidence precedes the heuristic above:
//   - any 'bedrock' → bedrock (a resumed session that crossed providers keeps
//     the existing "bedrock evidence wins" precedence);
//   - Bedrock-style model ids still win over 'firstParty': the attribute covers
//     only the post-upgrade part of a resumed session (observed: a session on
//     global.anthropic.* under 2.1.303 that reports 'firstParty' after 2.1.317);
//   - 'firstParty' with organization.id → enterprise; without it (API key or
//     failed login, observed: zero-token sessions with api_error only) → unknown,
//     closing the heuristic's documented API-key-as-bedrock failure;
//   - other or absent values (older clients, unobserved providers) → heuristic.
// Disabled by default: the table exists only after migration 009.
export function groupCte({ provider = false } = {}) {
  if (!provider) return `
WITH session_group AS (
    SELECT
        SessionId,
        ${LEGACY_GROUP} AS grp
    FROM claude_code.otel_metrics_sum_hourly
    WHERE SessionId != ''
    GROUP BY SessionId
)`;
  return `
WITH session_provider AS (
    SELECT
        SessionId,
        max(Provider = 'bedrock') AS provider_bedrock,
        max(Provider = 'firstParty') AS provider_first_party
    FROM claude_code.claude_session_providers_v1
    GROUP BY SessionId
), session_group AS (
    SELECT
        r.SessionId AS SessionId,
        multiIf(
            p.provider_bedrock = 1, 'bedrock',
            r.bedrock_model = 1, 'bedrock',
            p.provider_first_party = 1 AND r.org = 1, 'enterprise',
            p.provider_first_party = 1, 'unknown',
            r.legacy_grp
        ) AS grp
    FROM (
        SELECT
            SessionId,
            max(has_org) AS org,
            countIf(Model != '' AND NOT startsWith(Model, 'claude-')) > 0 AS bedrock_model,
            ${LEGACY_GROUP} AS legacy_grp
        FROM claude_code.otel_metrics_sum_hourly
        WHERE SessionId != ''
        GROUP BY SessionId
    ) AS r
    LEFT JOIN session_provider AS p ON p.SessionId = r.SessionId
)`;
}

export function parseProviderGroups(value) {
  if (value === undefined || value === "") return false;
  if (/^(true|1)$/i.test(String(value))) return true;
  if (/^(false|0)$/i.test(String(value))) return false;
  throw new Error("CLAUDE_PROVIDER_GROUPS must be true or false");
}

export const PROVIDER_GROUPS = parseProviderGroups(process.env.CLAUDE_PROVIDER_GROUPS);
export const GROUP_CTE = groupCte({ provider: PROVIDER_GROUPS });

// ponytail: ClickHouse 기본 설정(join_use_nulls=0)에서 LEFT JOIN 미매칭은 NULL이 아니라
// String 기본값('')을 반환한다 — coalesce(ug.grp, 'unknown')은 그래서 무력화됐었다.
export const GROUP_EXPR = "if(ug.grp = '' OR ug.grp IS NULL, 'unknown', ug.grp)";
