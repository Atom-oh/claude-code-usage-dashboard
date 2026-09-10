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
kubectl --context fsi-demo-cluster -n claude-code logs -l app=dashboard --tail=200 --prefix | grep -A8 '/api/chat'
```
The requestId shown to the user (in `(요청ID: ...)`) lets you grep the exact failing call out of
a busy log. `-A8` matters: `console.error("/api/chat", {...})` prints the object across several
lines, so a bare `grep` returns only the first line and drops the requestId and stack.

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
The Cost page and ordinary chat cost answers now use client-reported `cost.usage`.
Check the time window, group/model filters, unknown-session inclusion and collection status
before comparing values. Missing reports or zero reports with token usage are not confirmed
free usage. A report can be positive while still missing some requests.

Token-price **computed cost** remains a separate diagnostic. Its cache-write TTL is an
assumption exposed in `/api/config`; mixed TTLs and client-version prices can explain a
reported/computed difference. `SCHEMA_CONTEXT` retains the generated `PRICING_PROMPT_TABLE`
for explicit diagnostic questions. Neither estimate replaces billing reconciliation.

### 4. Scenario — generic error after a long conversation
The client resends the *entire* message history every turn (`useChatStream.js`), and the server
appends every tool result to `messages` across up to `MAX_HOPS` round-trips within one turn. A
long conversation (many preset questions clicked in a row) inflates the next request's input.
The logged `hop` is **not** a growth signal — it resets to 0 on every request and is bounded by
`MAX_HOPS` (4). Inside the loop it never exceeds 3; a logged `hop` of exactly 4 means the failure
happened in the forced tool-disabled wrap-up call made after the hop budget ran out. What it tells
you is *where* in the turn
the failure happened, not how much context accumulated. To judge growth, look at the size of the
history the client sent and how many `run_sql` calls the turn made.

The mitigations in place: `capToolResultJson()` caps each tool result's size (this is the one that
actually bounds cross-hop growth), and `MAX_SQL_CALLS` bounds total `run_sql` executions per turn
(independent of `MAX_HOPS` round-trips — a single hop can carry several parallel tool calls). Note
`maxTokens` (8000) is an **output** cap and does not limit input/context growth. If it still
reproduces, the conversation needs to be reset. There is no reset button: the client keeps `msgs`
in component state and resends all of it, so the user has to reload the page (`FloatingChat`'s X
only cancels the stream and keeps the history). Tell them to refresh.

### 5. Scenario — chat answers 503 with "readonly가 아니면 비활성화됩니다"
Not the auth gate (that message is different — see the 503 row in
[docs/api-reference.md](../api-reference.md)). This is the second, independent chat gate: at
boot and every 10 minutes, `assertReadonlySession()` (`dashboard/server/clickhouse.js`) runs
`SELECT toUInt8(getSetting('readonly'))` against `CH_USER`'s session and the server refuses to
enable chat unless that probe has confirmed `readonly`. Two distinct causes look identical to
the client:
- the account really is writable (a deployment pointed `CH_USER` at `otel_writer` or a local
  `default` account, both `readonly=0`)
- the probe itself couldn't run (cluster unreachable, permission error)

Both collapse to the same fail-closed result, so check the pod log for the line
`chat disabled: ClickHouse session is not confirmed readonly (probe=…)`:
`probe=false` means the account is writable; `probe=null` means the probe failed. The fix is
always to point `CH_USER` at the readonly-profiled account (`otel_reader`, Secret
`clickhouse-reader`) — never to relax the gate. Every other data route keeps working on a
writable account; only chat is gated, because chat is the only path that runs LLM-authored
SQL. There is also a sub-second window right after a pod starts, before the first probe
returns, where chat is 503 by design — that is not a bug either.

### 6. Scenario — `AccessDeniedException` / `ThrottlingException` in logs
- `AccessDeniedException`: Bedrock model access for `CHAT_MODEL_ID` is not enabled in
  `BEDROCK_REGION`/`AWS_REGION` for this account, or the IRSA role
  (`aws_iam_role.dashboard_bedrock` in `infra/dashboard.tf`) doesn't grant the inference-profile
  ARN. Compare `var.chat_model_id` against what's actually access-enabled in the console.
- `ThrottlingException`: `handleChat` retries this once/twice with backoff before giving up
  (`sendConverseWithRetry`); if the user still sees it, the account is throttled harder than
  that budget covers — check Bedrock service quotas.

### 7. Scenario — 429 from the dashboard itself, not Bedrock
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
kubectl --context fsi-demo-cluster -n claude-code logs -l app=dashboard --tail=200 --prefix | grep -A8 '/api/chat'
```
사용자에게 보인 `(요청ID: ...)`로 바쁜 로그에서 정확한 실패 호출을 grep할 수 있습니다.
`-A8`이 중요합니다: `console.error("/api/chat", {...})`는 객체를 여러 줄에 걸쳐 출력하므로
`grep`만 쓰면 첫 줄만 잡히고 requestId·stack이 빠집니다.

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
Cost 페이지와 일반적인 챗 비용 답변은 이제 `cost.usage`의 클라이언트 보고값을 사용합니다.
기간·채널·모델 필터, 미분류 세션 포함 여부와 수집 상태를 먼저 맞추세요. 보고값이 없거나
토큰 사용이 있는데 보고값이 0인 경우는 무료로 확정하지 않습니다. 양수 보고값도 모든 요청의
수집을 보장하지 않습니다.

토큰 × 단가표의 계산 비용은 별도 진단값입니다. `/api/config`의 TTL 가정, 혼합 TTL과
클라이언트 버전별 단가 차이가 두 값의 차이를 만들 수 있습니다. `SCHEMA_CONTEXT`는
진단 질문을 위해 `PRICING_PROMPT_TABLE`을 계속 인용합니다. 실제 정산은 청구 자료와 대조하세요.

### 4. 시나리오 — 긴 대화 뒤 일반 에러
클라이언트는 매 턴 **전체 메시지 히스토리를 재전송**하고(`useChatStream.js`), 서버는 한 턴 안에서
최대 `MAX_HOPS`회 왕복하는 동안 매 툴 결과를 `messages`에 계속 덧붙입니다. 프리셋 질문을 여러
번 연속으로 누른 긴 대화는 다음 요청의 입력을 부풀립니다. 로그의 `hop`은 **팽창 신호가
아닙니다** — 매 요청 0으로 초기화되고 `MAX_HOPS`(4)로 상한입니다. 루프 안에서는 3을 넘지 않고,
로그에 `hop`이 정확히 4로 찍혔다면 hop 예산을 다 쓴 뒤의 강제 마무리 호출(툴 비활성)에서 실패한
것입니다. `hop`이 알려주는 건 턴의 *어느 지점*에서 실패했는지이고, 컨텍스트가 얼마나 쌓였는지는
아닙니다. 팽창 여부는 클라이언트가 보낸 히스토리 크기와 그 턴의 `run_sql` 실행 횟수로 판단하세요.

현재 적용된 완화책: `capToolResultJson()`이 툴 결과 크기를 캡하고(hop 간 누적 팽창을 실제로
막는 것은 이쪽입니다), `MAX_SQL_CALLS`가 한 턴의 총 `run_sql` 실행 수를 상한합니다(`MAX_HOPS`
왕복 수와는 별개 축 — 한 hop에 병렬 툴콜이 여러 개 실릴 수 있어서). `maxTokens`(8000)는
**출력** 상한이라 입력/컨텍스트 팽창을 직접 줄이지는 않습니다. 그래도 재현되면 대화를
리셋해야 합니다. 리셋 버튼은 없습니다 — 클라이언트가 `msgs`를 컴포넌트 state에 들고 전부 재전송하는
구조라 **페이지를 새로고침**해야 합니다(`FloatingChat`의 X는 스트림만 취소하고 히스토리는 유지합니다).

### 5. 시나리오 — 챗이 "readonly가 아니면 비활성화됩니다"로 503을 답함
인증 게이트가 아닙니다(그 메시지는 다릅니다 — [docs/api-reference.md](../api-reference.md)의
503 행 참고). 이건 두 번째, 독립적인 챗 게이트입니다: 부팅 시와 10분마다
`assertReadonlySession()`(`dashboard/server/clickhouse.js`)이 `CH_USER`의 세션에
`SELECT toUInt8(getSetting('readonly'))`를 실행하고, 이 프로브가 `readonly`를 확인하지
못하면 서버는 챗을 켜지 않습니다. 클라이언트 입장에서 똑같이 보이는 두 가지 원인이 있습니다:
- 계정이 실제로 쓰기 가능함(배포가 `CH_USER`를 `otel_writer`나 로컬 `default` 계정에
  물렸고, 둘 다 `readonly=0`)
- 프로브 자체가 실행되지 못함(클러스터 접속 불가, 권한 에러)

둘 다 같은 fail-closed 결과로 접히므로, 파드 로그에서
`chat disabled: ClickHouse session is not confirmed readonly (probe=…)` 줄을 확인하세요:
`probe=false`는 계정이 쓰기 가능하다는 뜻이고, `probe=null`은 프로브가 실패했다는 뜻입니다.
고치는 방법은 항상 `CH_USER`를 readonly 프로필 계정(`otel_reader`, Secret
`clickhouse-reader`)에 맞추는 것입니다 — 절대 게이트를 완화하지 마세요. 다른 데이터 라우트는
쓰기 가능한 계정에서도 그대로 동작합니다 — 챗만 게이트되는 이유는 챗이 LLM이 작성한 SQL을
실행하는 유일한 경로이기 때문입니다. 파드가 막 시작한 직후 첫 프로브가 돌아오기 전 1초
미만의 구간도 챗이 503을 답합니다 — 이것도 버그가 아니라 의도된 동작입니다.

### 6. 시나리오 — 로그에 `AccessDeniedException` / `ThrottlingException`
- `AccessDeniedException`: 이 계정에서 `BEDROCK_REGION`/`AWS_REGION` 기준 `CHAT_MODEL_ID`의
  Bedrock model access가 켜져 있지 않거나, IRSA 역할(`infra/dashboard.tf`의
  `aws_iam_role.dashboard_bedrock`)이 inference-profile ARN에 권한을 안 준 것입니다.
  `var.chat_model_id`와 콘솔에서 실제로 access-enabled인 모델을 대조하세요.
- `ThrottlingException`: `handleChat`이 백오프로 1~2회 재시도한 뒤 포기합니다
  (`sendConverseWithRetry`). 그래도 사용자에게 보이면 그 예산을 넘는 수준의 throttling이므로
  Bedrock 서비스 쿼터를 확인하세요.

### 7. 시나리오 — Bedrock이 아니라 대시보드 자체의 429
per-IP 레이트리미터입니다(`RATE_MAX = 10`/분, `chat.js`) — AWS 에러가 아닙니다. 한 IP(공유
NAT/VPN 뒤)에서 데모를 몰아서 할 때 정상적으로 발생합니다. 정상 사용자 1명에게만 계속
뜬다면 `RATE_MAX`를 재검토하세요.

## 관련 문서
- [docs/reference/agent-llm.md](../reference/agent-llm.md) — 아키텍처와 코드 포인터
- [docs/reference/security.md](../reference/security.md) — `sanitizeSql()` SQL 샌드박스
- [docs/runbooks/incident-response.md](incident-response.md) — 대시보드/ClickHouse 레벨 장애
