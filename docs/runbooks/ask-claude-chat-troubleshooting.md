# Runbook: Ask Claude Chat Troubleshooting

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

---

<a id="english"></a>

# English

## Overview
Diagnose failures in the Analytics tab's "Ask Claude" assistant (`POST /api/chat`,
`dashboard/server/chat.js`) — either a visible error bubble, or a plausible-sounding but wrong
answer (e.g. "no bedrock/enterprise distinction exists in the data", which is false — see
Scenario 2).

## When to Use
- A chat message returns an error bubble instead of an answer
- The assistant claims data/columns don't exist that the dashboard itself uses successfully
- A long conversation (many preset questions in a row) starts failing where a fresh one doesn't

## Prerequisites
- `kubectl` context `fsi-demo-cluster`, namespace `claude-code`
- The dashboard pod's stdout is the *only* place the real error lands — `console.error`
  in `handleChat`'s catch logs `{ hop, modelId, name, status, requestId, message, stack }`, but
  the client only ever sees `classifyChatError()`'s short Korean message. **Check pod logs
  before the pod that saw the failure gets rolled/restarted — the log is gone otherwise.**

## Procedure

### 1. Get the classified message and requestId from the user, then the raw error from logs
```bash
kubectl --context fsi-demo-cluster -n claude-code logs -l app=dashboard --tail=200 --prefix | grep '/api/chat'
```
The requestId shown to the user (in `(요청ID: ...)`) lets you grep the exact failing call out of
a busy log.

### 2. Scenario — assistant says a distinction/column "doesn't exist"
This is the most common failure and is **not a data problem**. The model doesn't know
`otel_metrics_sum_hourly` exists or how `bedrock`/`enterprise` is inferred (session-scoped,
via `grouping.js`'s `GROUP_CTE`, not a stored column) unless the `SYSTEM` prompt
(`dashboard/server/chat.js`, around the `GROUP_CTE` interpolation) actually teaches it.
Verify directly against ClickHouse with the same query the dashboard uses
(`grouping.js`'s `GROUP_CTE`, LEFT JOIN by `SessionId`) before assuming the data is missing.
If the direct query works but chat still says otherwise, the `SYSTEM` prompt has drifted from
the real schema/grouping rule — fix the prompt, not the data.

### 3. Scenario — chat's cost answer doesn't match the Cost page card
Not a bug by itself. `claude_code.cost.usage` ("reported cost") is what the Claude Code client
self-reports; the Cost page's cards show a *different* number ("computed cost") derived by
multiplying token counts by the static price table in `pricing.js` (`withComputedCost`). The
chat's `SCHEMA_CONTEXT` (`dashboard/server/chat.js`) explicitly teaches this distinction and
quotes `pricing.js`'s `PRICING_PROMPT_TABLE` so the model can compute either one and label which
it used. If a user reports "the chat's cost number is wrong," first check *which* number they're
comparing against — a mismatch between reported and computed cost is expected, not a defect.
Only investigate further if the chat's *computed* cost doesn't match the dashboard's for the
same model/period (that would mean `PRICING_PROMPT_TABLE` and the dashboard's `PRICING` table
have drifted, which shouldn't happen since the former is generated from the latter).

### 4. Scenario — generic error after a long conversation
The client resends the *entire* message history every turn (`useChatStream.js`), and the server
appends every tool result to `messages` across up to `MAX_HOPS` round-trips within one turn. A
long conversation (many preset questions clicked in a row) inflates the next request's input.
Check the logged `hop` field: if it's high, this is context growth, not a code regression.
`capToolResultJson()` caps each tool result's size, `maxTokens` was raised to 8000, and
`MAX_SQL_CALLS` bounds the total `run_sql` executions per turn (independent of `MAX_HOPS`
round-trips — a single hop can carry several parallel tool calls) — all specifically for this.
If it still reproduces, the conversation needs to be reset (client has no way to trim history
other than starting a new chat).

### 5. Scenario — `AccessDeniedException` / `ThrottlingException` in logs
- `AccessDeniedException`: Bedrock model access for `CHAT_MODEL_ID` is not enabled in
  `BEDROCK_REGION`/`AWS_REGION` for this account, or the IRSA role
  (`aws_iam_role.dashboard_bedrock` in `infra/dashboard.tf`) doesn't grant the inference-profile
  ARN. Compare `var.chat_model_id` against what's actually access-enabled in the console.
- `ThrottlingException`: `handleChat` retries this once/twice with backoff before giving up
  (`sendConverseWithRetry`); if the user still sees it, the account is throttled harder than
  that budget covers — check Bedrock service quotas.

### 6. Scenario — 429 from the dashboard itself, not Bedrock
That's the per-IP rate limiter (`RATE_MAX = 10`/minute, `chat.js`), not an AWS error. Expected
under heavy demoing from one IP (e.g. behind a shared NAT/VPN). No action needed unless it's
firing for a single legitimate user, in which case reconsider `RATE_MAX`.

## Related
- [docs/reference/agent-llm.md](../reference/agent-llm.md) — architecture and code pointers
- [docs/reference/security.md](../reference/security.md) — `sanitizeSql()` SQL sandbox
- [docs/runbooks/incident-response.md](incident-response.md) — dashboard/ClickHouse-level incidents

---

<a id="korean"></a>

# 한국어

## 개요
Analytics 탭의 "Ask Claude" 어시스턴트(`POST /api/chat`, `dashboard/server/chat.js`) 실패를
진단합니다 — 화면에 보이는 에러 말풍선이든, 그럴듯하지만 틀린 답변(예: "데이터에 bedrock/
enterprise 구분이 없습니다" — 실제로는 틀림, Scenario 2 참고)이든 다룹니다.

## 언제 사용하나
- 챗 질문이 답변 대신 에러 말풍선을 반환할 때
- 어시스턴트가 대시보드 자체는 성공적으로 쓰는 데이터/컬럼이 "없다"고 답할 때
- 프리셋 질문을 여러 번 연속으로 누른 긴 대화에서만 실패가 나고 새 대화에서는 안 날 때

## 사전 준비
- `kubectl` context `fsi-demo-cluster`, 네임스페이스 `claude-code`
- 실제 에러는 **대시보드 파드 stdout에만** 남습니다 — `handleChat`의 catch가
  `{ hop, modelId, name, status, requestId, message, stack }`를 구조화해 로그로 남기지만,
  클라이언트는 `classifyChatError()`가 만든 짧은 한국어 문구만 봅니다. **파드가 재기동/롤링되기
  전에 로그를 확인하세요** — 그 뒤에는 사라집니다.

## 절차

### 1. 사용자가 본 분류 문구·요청ID를 받고, 로그에서 원문 에러를 찾는다
```bash
kubectl --context fsi-demo-cluster -n claude-code logs -l app=dashboard --tail=200 --prefix | grep '/api/chat'
```
사용자에게 보인 `(요청ID: ...)`로 바쁜 로그에서 정확한 실패 호출을 grep할 수 있습니다.

### 2. 시나리오 — 어시스턴트가 구분/컬럼이 "없다"고 답함
가장 흔한 실패이며 **데이터 문제가 아닙니다**. `otel_metrics_sum_hourly`의 존재나
`bedrock`/`enterprise`가 어떻게 추론되는지(저장된 컬럼이 아니라 세션 단위로,
`grouping.js`의 `GROUP_CTE`를 통해)를 `SYSTEM` 프롬프트(`dashboard/server/chat.js`,
`GROUP_CTE` 보간 부근)가 실제로 가르치지 않으면 모델은 알 방법이 없습니다. 데이터가 없다고
단정하기 전에 대시보드가 쓰는 것과 같은 쿼리(`grouping.js`의 `GROUP_CTE`, `SessionId`로
LEFT JOIN)를 ClickHouse에 직접 돌려 확인하세요. 직접 쿼리는 되는데 챗은 여전히 아니라고
답하면, `SYSTEM` 프롬프트가 실제 스키마/그룹핑 규칙과 드리프트된 것입니다 — 데이터가 아니라
프롬프트를 고치세요.

### 3. 시나리오 — 챗의 비용 답변이 Cost 페이지 카드와 다름
그 자체로는 버그가 아닙니다. `claude_code.cost.usage`("reported cost")는 Claude Code
클라이언트가 자체 보고하는 값이고, Cost 페이지 카드는 토큰 수 × `pricing.js`의 고정 단가표를
곱해 계산한 **다른** 값("computed cost", `withComputedCost`)을 보여줍니다. 챗의
`SCHEMA_CONTEXT`(`dashboard/server/chat.js`)가 이 구분을 명시적으로 가르치고
`pricing.js`의 `PRICING_PROMPT_TABLE`을 그대로 인용해, 모델이 둘 중 하나를 계산하고 어느 쪽을
썼는지 라벨링할 수 있게 합니다. 사용자가 "챗의 비용 숫자가 틀렸다"고 하면 먼저 *어느 값과*
비교하고 있는지 확인하세요 — reported와 computed 비용의 불일치는 예상된 동작이며 결함이
아닙니다. 챗의 *computed* 비용이 같은 모델/기간에 대해 대시보드와 다를 때만 추가로
조사하세요(그 경우엔 `PRICING_PROMPT_TABLE`과 대시보드의 `PRICING` 테이블이 드리프트된
것인데, 전자가 후자에서 생성되므로 원래는 일어나선 안 되는 일입니다).

### 4. 시나리오 — 긴 대화 뒤 일반 에러
클라이언트는 매 턴 **전체 메시지 히스토리를 재전송**하고(`useChatStream.js`), 서버는 한 턴 안에서
최대 `MAX_HOPS`회 왕복하는 동안 매 툴 결과를 `messages`에 계속 덧붙입니다. 프리셋 질문을 여러
번 연속으로 누른 긴 대화는 다음 요청의 입력을 부풀립니다. 로그의 `hop` 필드가 높으면 코드
회귀가 아니라 컨텍스트 팽창입니다. `capToolResultJson()`이 툴 결과 크기를 캡하고, `maxTokens`도
8000으로 올렸고, `MAX_SQL_CALLS`가 한 턴의 총 `run_sql` 실행 수를 상한합니다(`MAX_HOPS`
왕복 수와는 별개 축 — 한 hop에 병렬 툴콜이 여러 개 실릴 수 있어서) — 모두 이 문제 전용으로
추가됐습니다. 그래도 재현되면 대화를 리셋해야 합니다(클라이언트에는 새 대화 시작 외에
히스토리를 줄일 방법이 없습니다).

### 5. 시나리오 — 로그에 `AccessDeniedException` / `ThrottlingException`
- `AccessDeniedException`: 이 계정에서 `BEDROCK_REGION`/`AWS_REGION` 기준 `CHAT_MODEL_ID`의
  Bedrock model access가 켜져 있지 않거나, IRSA 역할(`infra/dashboard.tf`의
  `aws_iam_role.dashboard_bedrock`)이 inference-profile ARN에 권한을 안 준 것입니다.
  `var.chat_model_id`와 콘솔에서 실제로 access-enabled인 모델을 대조하세요.
- `ThrottlingException`: `handleChat`이 백오프로 1~2회 재시도한 뒤 포기합니다
  (`sendConverseWithRetry`). 그래도 사용자에게 보이면 그 예산을 넘는 수준의 throttling이므로
  Bedrock 서비스 쿼터를 확인하세요.

### 6. 시나리오 — Bedrock이 아니라 대시보드 자체의 429
per-IP 레이트리미터입니다(`RATE_MAX = 10`/분, `chat.js`) — AWS 에러가 아닙니다. 한 IP(공유
NAT/VPN 뒤)에서 데모를 몰아서 할 때 정상적으로 발생합니다. 정상 사용자 1명에게만 계속
뜬다면 `RATE_MAX`를 재검토하세요.

## 관련 문서
- [docs/reference/agent-llm.md](../reference/agent-llm.md) — 아키텍처와 코드 포인터
- [docs/reference/security.md](../reference/security.md) — `sanitizeSql()` SQL 샌드박스
- [docs/runbooks/incident-response.md](incident-response.md) — 대시보드/ClickHouse 레벨 장애
