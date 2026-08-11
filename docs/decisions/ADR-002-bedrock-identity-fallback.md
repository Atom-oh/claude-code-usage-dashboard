# ADR-002: Inject `enduser.id` via IMDS instance tag, fall back with `coalesce(UserEmail, EndUserId)`

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

**Status:** Accepted (partially applied — see Consequences)
**Date:** 2026-08-11

### Context
Bedrock-group sessions have no Claude account: `organization.id`, `user.account_uuid`,
`user.account_id`, and `user.email` are all empty, confirmed on 75.7M measured rows
(2026-08-11 census), not assumed from documentation. Only `user.id` (an anonymous identifier)
and `session.id` survive. Every per-user panel/query in this dashboard (`UserEmail` — Panel 10,
`userLeaderboard`, `userDaily`, etc.) keys on `user.email`, so Bedrock users are invisible
there today.

### Decision
1. `user-data.sh` reads an EC2 instance tag (`Email`, via IMDSv2) and injects it as
   `enduser.id` in `OTEL_RESOURCE_ATTRIBUTES`, with a fallback to an SSM parameter and format
   validation (no spaces/commas/`=`, since `OTEL_RESOURCE_ATTRIBUTES` is a bare comma-separated
   `key=value` list with no escaping) that skips injection and warns rather than failing the
   boot.
2. Per-user queries fall back with `coalesce(nullIf(UserEmail,''), nullIf(EndUserId,''))`
   instead of `UserEmail` alone.
3. `EndUserId` is promoted from `ResourceAttributes`, matching `UserEmail`'s existing promotion
   — see ADR context in `docs/reference/data.md` §1b for why this matters for the
   `OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES` flag.

### Rationale
- IMDSv2 over a static per-launch-template value: the instance tag can be set per-instance at
  launch time without baking identity into the AMI or the Launch Template's user-data itself.
- `coalesce`, not a schema-level rename: `UserEmail` is still the primary identity for
  Enterprise sessions (which do have real emails) and for the tester path
  (`scripts/setup-test-telemetry.sh`, which injects `user.email` directly, not `enduser.id`).
  Bedrock and Enterprise/tester sessions populate different columns for the same logical
  "who is this" question — `coalesce` reads correctly regardless of which one is populated.

### Consequences
- Applied to `grafana-ab-queries.sql` (Panel 10) and every new `dashboard/server/queries.js`
  function added in the 2026-08-11 sync (`subagentFanout`, `skillActivations`, etc., all of
  which take a `l.UserEmail`/`t.UserEmail` filter column).
- **Not** retrofitted into the ~90 pre-existing `UserEmail` references in
  `dashboard/server/queries.js` — most critically `userLeaderboard`, the dashboard's main
  per-user panel. `EndUserId` isn't in `incFlat`/`incBucketed`'s `SELECT`/`GROUP BY`, so using
  it there means either widening those shared functions (see ADR-001 — rejected for the same
  risk/consumer-count reasons) or a parallel non-`incFlat` rewrite of `userLeaderboard`, which
  is itself one of the most complex functions in the file (multiple CTEs, straddling-user
  double-count correction, active-day scoring). That's a real, open gap: **Bedrock users
  without a synthetic tester email are still invisible on the Users page leaderboard today.**
  Follow-up work should either (a) extend `incFlat`/`incBucketed` to carry `EndUserId`
  end-to-end once a second real consumer justifies it (see ADR-001's escalation trigger), or
  (b) rewrite `userLeaderboard`'s identity join as its own dedicated change with test coverage,
  not as a side effect of an unrelated telemetry-attribute sync.

<a id="korean"></a>
## 한국어

**상태:** 채택(부분 적용 — "결과" 참고)
**날짜:** 2026-08-11

### 배경
Bedrock 그룹 세션은 Claude 계정이 없다: `organization.id`, `user.account_uuid`,
`user.account_id`, `user.email`이 전부 비어 있다 — 문서를 가정한 게 아니라 75.7M행 실측
(2026-08-11 census)으로 확인했다. `user.id`(익명 식별자)와 `session.id`만 남는다. 이
대시보드의 모든 유저별 패널/쿼리(`UserEmail` — Panel 10, `userLeaderboard`, `userDaily` 등)는
`user.email`을 키로 쓰므로, Bedrock 유저는 오늘 거기서 보이지 않는다.

### 결정
1. `user-data.sh`가 EC2 인스턴스 태그(`Email`, IMDSv2 경유)를 읽어 `OTEL_RESOURCE_ATTRIBUTES`에
   `enduser.id`로 주입한다. SSM 파라미터 폴백과 형식 검증(공백/쉼표/`=` 금지 —
   `OTEL_RESOURCE_ATTRIBUTES`는 이스케이프 없는 쉼표 구분 `key=value` 목록)을 포함하며, 위험
   문자가 있으면 주입을 건너뛰고 경고만 남긴다(부팅을 막지 않음).
2. 유저별 쿼리는 `UserEmail` 단독이 아니라
   `coalesce(nullIf(UserEmail,''), nullIf(EndUserId,''))`로 폴백한다.
3. `EndUserId`는 `Attributes`가 아니라 `ResourceAttributes`에서 승격 — 기존 `UserEmail`
   승격 방식과 동일. `OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES` 플래그와의 관계는
   `docs/reference/data.md` §1b 참고.

### 근거
- Launch Template에 정적 값을 박는 대신 IMDSv2 — 인스턴스 태그는 AMI나 user-data 자체에
  identity를 굽지 않고 launch 시점에 인스턴스별로 설정할 수 있다.
- 스키마 레벨 rename이 아니라 coalesce: `UserEmail`은 Enterprise 세션(실제 이메일 있음)과
  테스터 경로(`scripts/setup-test-telemetry.sh`, `enduser.id`가 아니라 `user.email`을 직접
  주입)의 주 identity로 여전히 유효하다. Bedrock과 Enterprise/테스터 세션은 같은 논리적
  질문("이게 누구 세션인가")에 서로 다른 컬럼을 채운다 — coalesce는 어느 쪽이 채워져 있든
  올바르게 읽는다.

### 결과
- `grafana-ab-queries.sql`(패널 10)과 2026-08-11 동기화에서 추가한 `dashboard/server/queries.js`
  신규 함수 전부(`subagentFanout`, `skillActivations` 등, 모두 `l.UserEmail`/`t.UserEmail`
  필터 컬럼을 받음)에는 적용했다.
- `dashboard/server/queries.js`의 기존 `UserEmail` 참조 ~90곳 — 가장 중요하게는 대시보드의
  메인 유저별 패널인 `userLeaderboard` — 에는 **적용하지 않았다**. `EndUserId`가
  `incFlat`/`incBucketed`의 `SELECT`/`GROUP BY`에 없어서, 거기서 쓰려면 그 공유 함수를
  넓히거나(ADR-001 — 같은 위험·소비자 수 이유로 거부) `userLeaderboard`를 `incFlat` 없이
  병렬로 다시 쓰는 방법뿐인데, 이 함수 자체가 파일에서 가장 복잡한 함수 중 하나다(CTE
  여러 개, straddling 유저 이중계상 보정, active-day 점수화). 이건 실재하는, 아직 열려 있는
  공백이다: **합성 테스터 이메일이 없는 Bedrock 유저는 오늘도 Users 페이지 리더보드에서
  보이지 않는다.** 후속 작업은 (a) 두 번째 실제 소비자가 생기면(ADR-001의 에스컬레이션
  기준 참고) `incFlat`/`incBucketed`를 `EndUserId`까지 관통하도록 확장하거나, (b)
  `userLeaderboard`의 identity join을 관련 없는 텔레메트리 속성 동기화의 부수 효과가 아니라
  테스트 커버리지를 갖춘 별도의 전용 변경으로 다시 쓰는 것 중 하나여야 한다.
