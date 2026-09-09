# ADR-008: Per-group, per-instant cache-write TTL pricing policy

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

**Status:** Accepted
**Date:** 2026-09-09

### Context
The dashboard's computed cost multiplies measured token counts by list prices. Cache-write
tokens have two list prices — 1.25× input for a 5-minute cache TTL, 2× input for a 1-hour TTL —
and `pricing.js` applied one global tier to every row (`PRICING_CACHE_WRITE_TTL`, default
`1h`). Two facts make that wrong for this deployment:

1. **OTel carries no TTL.** A console-exporter dump of Claude Code 2.1.266 shows
   `claude_code.token.usage` with `type ∈ {input, output, cacheRead, cacheCreation}` and no
   `ttl` attribute; `api_request` log events have no 1h/5m split either. The tier cannot be read
   off the telemetry, so any token-based computation has to assume it.
2. **The right tier depends on the session's auth channel.** Claude Code's settings schema
   documents `promptCacheTtl` as "unset = 1 hour on a Claude subscription, 5 minutes on an API
   key, Bedrock, Vertex or Foundry". Measured directly against Bedrock in the workshop account
   (`ap-northeast-2`, `global.anthropic.claude-opus-5`): a request without `ttl` lands its whole
   cache write in `cache_creation.ephemeral_5m_input_tokens`. The 2026-09-07 workshop event (82
   participants, 231 user × model rows) then measured the dashboard `cost` at **$7,817.28**
   against **$6,640.33** recomputed at AWS rates — **+17.72%**, all of it in the cache-write
   term — and the 1h recomputation matched `cost` to the cent, confirming the global 1h tier as
   the cause. Claude Code's own `reported_cost` for the same window was **+0.11%**, because the
   client sees the 5m/1h split in each API response and prices the two parts separately.

The tier is also not static: the workshop's CloudFormation change on branch
`fix/ccb-prompt-cache-ttl-1h` pins `promptCacheTtl` / `subagentPromptCacheTtl` to `1h` for the
Bedrock fleet, so from the moment it lands the Bedrock group's correct tier flips from 5m to 1h
while ranges that reach back before it still need 5m.

### Decision
Make the cache-write tier a **policy resolved per row from `(group, instant)`**, in
`pricing.js`:

- Built-in defaults follow the provider defaults: **bedrock → 5m, enterprise → 1h**; the
  `unknown` group and rows without a group use the global `PRICING_CACHE_WRITE_TTL` (`1h`).
  Setting the global variable explicitly keeps its old meaning — one tier for every group
  without its own variable.
- `PRICING_CACHE_WRITE_TTL_BEDROCK` / `PRICING_CACHE_WRITE_TTL_ENTERPRISE` accept a tier or a
  **schedule** (`5m,2026-09-09T00:00:00Z=1h`): the first entry is the initial tier, later
  entries are `<instant>=<tier>` in ascending order. Instants must carry an explicit timezone
  and sit on a UTC hour boundary — a bad value fails the boot (and the Terraform `plan`).
- `withComputedCost(rows, {at})` / `rollupComputedCost(rows, keys, {at})` resolve the tier from
  the row's `group` and a resolution instant, and stamp `cache_write_ttl` + `cache_write_cost`
  on every priced row so the assumption is visible in the API.
- Snapshot cost queries (`costSummary`, `costByModel`, `costByUserModel`, `effortMix`,
  `agentCost`, `reportedVsComputedByVersion`) run through `acrossTtlSegments`, which splits
  `[from, to)` at every switch instant inside it, prices each segment with `at = segment start`,
  and merges the pieces per key (`mergeSegments`). Cumulative-counter diffs are additive over
  adjacent segments, and hour-aligned instants coincide with the hourly rollup's bucket edges,
  so the split is exact. Bucketed queries (`costByModelDaily`) resolve per bucket start.
  `costByModelCompare` gained a `group` grain and folds back to `model` in `compareRows`; when a
  switch instant falls inside either window it falls back to two `costByModel` calls.
- `tierCosts` reads `cache_write_cost` off priced rows instead of re-deriving it from tokens —
  a merged row's tokens were priced at two different rates.

### Rationale
Correctness for both channels at once requires the group dimension; every cost query already
carries a session-scoped `group` (`grouping.js`), so the resolution costs nothing new in SQL.
The schedule exists because a TTL change is an operator event (a `settings.json` change), and
the data before and after it must both stay right without redeploying the dashboard with a
different constant. Splitting at the range level rather than widening `incFlat` keeps to
ADR-001: the shared diff helpers are untouched, and a deployment with no switch instant issues
exactly the same queries as before.

The obvious alternative — promoting Claude Code's `reported_cost` to the primary figure, since
it matched at +0.11% — was rejected as the *default* for a reason already recorded in this repo:
`cost.usage` is priced client-side from the client's own table and is therefore
version-dependent (measured 2026-09-03: v2.1.251 priced `claude-fable-5-1` off the opus-5 row,
≈0.5× of list). The event's +0.11% agreement holds because its clients were 2.1.263 on
opus-5/sonnet-5/haiku-4-5, where that defect does not fire. Computed cost fails on the TTL
assumption; reported cost fails on the client's price table. A policy fixes the former
deterministically; the latter cannot be fixed server-side. `reported_cost` stays beside `cost`
everywhere as the cross-check, and `/api/reliability/reported-vs-computed` is the drift detector.

### Consequences
- The Bedrock group's computed cost drops by the 5m/1h cache-write difference on upgrade (for
  the 2026-09-07 event window, −$1,176.95 on $7,817.28). An operator who has already pinned the
  Bedrock fleet to 1h must set `PRICING_CACHE_WRITE_TTL_BEDROCK` (a schedule if history spans
  the change) — the dashboard cannot observe that change from telemetry.
- Ranges that span a switch instant issue one query per segment for the six snapshot cost
  endpoints; deployments without a schedule are unaffected.
- **Known residual error:** a subscription session's subagent/helper requests default to 5m
  (`subagentPromptCacheTtl`) while its main conversation is 1h. `otel_metrics_sum` carries
  `query_source` / `agent.name`, but the hourly rollup does not, so the enterprise `1h` tier
  slightly overstates those writes. The recorded follow-up is a schema migration promoting
  `QuerySource` into `otel_metrics_sum_hourly` and a local-diff cost query at that grain
  (ADR-001 pattern) — not a change to the shared `incFlat`.
- Every priced row grew two fields (`cache_write_ttl`, `cache_write_cost`) and `/api/config`'s
  `pricing` grew `cacheWriteTtlByGroup`; the SPA does not read them yet.
- How to reverse: set `PRICING_CACHE_WRITE_TTL=1h` explicitly — the policy then collapses to the
  previous single-tier behaviour without a code change.

### Alternatives considered
(a) **Promote `reported_cost` to primary** — rejected as the default (client-version dependence,
above); kept as the cross-check. (b) **Flip the global default to 5m** — rejected: correct for
Bedrock today, wrong for the subscription channel's main conversation, and wrong for Bedrock
the moment its TTL is pinned to 1h. (c) **Promote `QuerySource` into the rollup now** — the
right fix for the subscription residual, but it is a live-cluster schema migration plus a
rollup backfill and does not address the Bedrock error at all; deferred as the follow-up.
(d) **Back-solve the tier per request from `api_request.cost_usd`** — measurable, but it
depends on the client's price table (the same defect as (a)) and would move the whole cost
pipeline from `otel_metrics_sum` to `otel_logs`.

<a id="korean"></a>
## 한국어

**상태:** 채택
**날짜:** 2026-09-09

### 맥락
대시보드의 계산 비용은 실측 토큰 수에 정가를 곱한 값이다. 캐시 쓰기 토큰의 정가는 두 가지 —
5분 TTL은 입력 단가의 1.25배, 1시간 TTL은 2배 — 인데 `pricing.js`는 모든 행에 전역 티어 하나를
적용했다(`PRICING_CACHE_WRITE_TTL`, 기본 `1h`). 이 배포에서 그것이 틀린 이유는 두 가지다.

1. **OTel에 TTL이 없다.** Claude Code 2.1.266에 console exporter를 붙여 덤프한 결과
   `claude_code.token.usage`의 `type`은 `{input, output, cacheRead, cacheCreation}`뿐이고 `ttl`
   속성이 없다. `api_request` 로그 이벤트에도 1h/5m 분리 필드가 없다. 텔레메트리에서 티어를 읽을
   수 없으므로 토큰 기반 계산은 반드시 가정을 해야 한다.
2. **정답 티어는 세션의 인증 채널에 달려 있다.** Claude Code 설정 스키마는 `promptCacheTtl`을
   "미설정 = 구독은 1시간, API 키·Bedrock·Vertex·Foundry는 5분"으로 문서화한다. 워크샵 계정에서
   Bedrock을 직접 호출해(`ap-northeast-2`, `global.anthropic.claude-opus-5`) 확인하면 `ttl` 없는
   요청의 캐시 쓰기가 전량 `cache_creation.ephemeral_5m_input_tokens`로 들어간다. 2026-09-07
   워크샵 이벤트(참가자 82명, 사용자×모델 231행)에서 대시보드 `cost`는 **$7,817.28**, AWS 실단가
   재계산은 **$6,640.33** — **+17.72%**이고 차액 전부가 캐시 쓰기 항이었으며, 1h 재계산이 `cost`와
   센트까지 일치해 전역 1h 티어가 원인임이 확정됐다. 같은 구간의 Claude Code 자체 `reported_cost`는
   **+0.11%**였다 — 클라이언트는 응답마다 5m/1h 분리 값을 보고 두 부분을 따로 계산하기 때문이다.

티어는 고정도 아니다. 워크샵의 CloudFormation 변경(브랜치 `fix/ccb-prompt-cache-ttl-1h`)이
Bedrock 플릿의 `promptCacheTtl` / `subagentPromptCacheTtl`을 `1h`로 고정하므로, 그것이 반영되는
순간부터 Bedrock 그룹의 정답은 5m에서 1h로 바뀌고, 그 이전에 걸친 구간은 여전히 5m이어야 한다.

### 결정
캐시 쓰기 티어를 `pricing.js`에서 **행마다 `(그룹, 시각)`으로 판정하는 정책**으로 만든다.

- 내장 기본값은 공급자 기본값을 따른다: **bedrock → 5m, enterprise → 1h**. `unknown` 그룹과
  그룹이 없는 행은 전역 `PRICING_CACHE_WRITE_TTL`(`1h`)을 쓴다. 전역 변수를 명시하면 예전
  의미 — 자기 변수가 없는 모든 그룹에 한 티어 — 가 유지된다.
- `PRICING_CACHE_WRITE_TTL_BEDROCK` / `PRICING_CACHE_WRITE_TTL_ENTERPRISE`는 티어 하나 또는
  **스케줄**(`5m,2026-09-09T00:00:00Z=1h`)을 받는다. 첫 항목이 초기 티어, 이후 항목은
  `<시각>=<티어>` 오름차순. 시각은 타임존 명시 + UTC 정각이어야 하고, 잘못된 값은 부팅(그리고
  Terraform `plan`)을 실패시킨다.
- `withComputedCost(rows, {at})` / `rollupComputedCost(rows, keys, {at})`가 행의 `group`과
  판정 시각으로 티어를 정하고, 단가가 매겨진 모든 행에 `cache_write_ttl` + `cache_write_cost`를
  실어 가정이 API에 드러나게 한다.
- 스냅샷 비용 쿼리(`costSummary`, `costByModel`, `costByUserModel`, `effortMix`, `agentCost`,
  `reportedVsComputedByVersion`)는 `acrossTtlSegments`를 거친다 — `[from, to)` 안의 모든 전환
  시각에서 구간을 쪼개 조각마다 `at = 조각 시작`으로 계산하고 키 단위로 합친다(`mergeSegments`).
  누적 카운터의 구간 diff는 인접 구간에 가산적이고, 정각 시각은 시간별 롤업의 버킷 경계와
  일치하므로 분할은 정확하다. 버킷 쿼리(`costByModelDaily`)는 버킷 시작으로 판정한다.
  `costByModelCompare`는 `group` 그레인을 갖게 됐고 `compareRows`가 `model`로 다시 접는다; 두
  창 중 하나에 전환 시각이 들어오면 `costByModel` 두 번 호출로 폴백한다.
- `tierCosts`는 토큰에서 다시 계산하지 않고 단가가 매겨진 행의 `cache_write_cost`를 읽는다 —
  합쳐진 행의 토큰은 서로 다른 두 단가로 계산된 것이다.

### 근거
두 채널을 동시에 맞추려면 그룹 차원이 필요하고, 모든 비용 쿼리가 이미 세션 단위 `group`
(`grouping.js`)을 갖고 있어 SQL 추가 비용이 없다. 스케줄이 있는 이유는 TTL 변경이 운영자
이벤트(`settings.json` 변경)라 그 전후 데이터가 대시보드를 다른 상수로 재배포하지 않아도 둘 다
맞아야 하기 때문이다. `incFlat`을 넓히지 않고 구간 단위로 쪼개는 것은 ADR-001을 지킨다 — 공유
diff 헬퍼는 그대로고, 전환 시각이 없는 배포는 예전과 정확히 같은 쿼리를 낸다.

명백한 대안 — +0.11%로 일치한 Claude Code `reported_cost`를 1차 지표로 승격 — 은 이 저장소에
이미 기록된 이유로 *기본값*으로는 기각했다: `cost.usage`는 클라이언트 자체 단가표로 클라이언트
쪽에서 매겨져 버전에 종속된다(실측 2026-09-03: v2.1.251이 `claude-fable-5-1`을 opus-5 단가로
보고, 정가의 약 0.5배). 이벤트의 +0.11% 일치는 클라이언트가 2.1.263이고 모델이
opus-5/sonnet-5/haiku-4-5여서 그 결함이 발동하지 않았기 때문이다. 계산 비용은 TTL 가정에,
보고 비용은 클라이언트 단가표에 각각 취약하다. 정책은 앞의 것을 결정적으로 고치고, 뒤의 것은
서버에서 고칠 수 없다. `reported_cost`는 교차검증용으로 모든 곳에서 `cost` 옆에 남고,
`/api/reliability/reported-vs-computed`가 괴리 감지기다.

### 결과
- 업그레이드 시 Bedrock 그룹의 계산 비용이 5m/1h 캐시 쓰기 차이만큼 내려간다(2026-09-07
  이벤트 구간 기준 $7,817.28 중 −$1,176.95). Bedrock 플릿을 이미 1h로 고정한 운영자는
  `PRICING_CACHE_WRITE_TTL_BEDROCK`(이력이 변경을 걸치면 스케줄)을 설정해야 한다 — 대시보드는
  그 변경을 텔레메트리에서 관측할 수 없다.
- 전환 시각을 걸치는 구간은 여섯 개 스냅샷 비용 엔드포인트에서 조각마다 한 번씩 조회한다;
  스케줄이 없는 배포는 영향이 없다.
- **알려진 잔여 오차:** 구독 세션의 서브에이전트/헬퍼 요청은 5m(`subagentPromptCacheTtl`)이고
  메인 대화는 1h다. `otel_metrics_sum`에는 `query_source` / `agent.name`이 있지만 시간별 롤업에는
  없어 enterprise `1h` 티어가 그 분량을 약간 과대계상한다. 기록된 후속 작업은 `QuerySource`를
  `otel_metrics_sum_hourly`로 승격하는 스키마 마이그레이션과 그 그레인의 로컬 diff 비용
  쿼리(ADR-001 패턴)다 — 공유 `incFlat` 변경이 아니다.
- 단가가 매겨진 모든 행에 필드 둘(`cache_write_ttl`, `cache_write_cost`)이, `/api/config`의
  `pricing`에 `cacheWriteTtlByGroup`이 늘었다; SPA는 아직 읽지 않는다.
- 되돌리는 방법: `PRICING_CACHE_WRITE_TTL=1h`를 명시하면 코드 변경 없이 예전 단일 티어 동작으로
  접힌다.

### 검토한 대안
(a) **`reported_cost` 1차 승격** — 기본값으로는 기각(위 클라이언트 버전 종속), 교차검증용으로
유지. (b) **전역 기본값을 5m으로 뒤집기** — 기각: 오늘의 Bedrock에는 맞지만 구독 채널 메인
대화에는 틀리고, Bedrock TTL이 1h로 고정되는 순간 Bedrock에도 틀린다. (c) **지금 `QuerySource`를
롤업에 승격** — 구독 잔여 오차의 올바른 해법이지만 라이브 클러스터 스키마 마이그레이션 + 롤업
백필이 필요하고 Bedrock 오차는 전혀 해결하지 않는다; 후속으로 미룸. (d) **`api_request.cost_usd`
에서 요청별 티어 역산** — 측정 가능하지만 클라이언트 단가표에 의존하고((a)와 같은 결함) 비용
파이프라인 전체를 `otel_metrics_sum`에서 `otel_logs`로 옮겨야 한다.
