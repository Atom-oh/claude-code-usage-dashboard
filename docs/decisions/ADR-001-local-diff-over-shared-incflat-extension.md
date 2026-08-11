# ADR-001: Duplicate the cumulative-diff formula locally instead of widening `incFlat`/`incBucketed`

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

**Status:** Accepted
**Date:** 2026-08-11

### Context
The 2026-08-11 telemetry spec sync added two integrity-check endpoints
(`/api/integrity/version-cohort-sessions`, `/api/integrity/version-cohort-cost`) that need to
diff `otel_metrics_sum`'s cumulative counters (`cost.usage`, `token.usage`) grouped by a new
dimension, `AppVersion` — the point is literally to check whether the two A/B groups are
running different Claude Code versions and, if so, whether that produces different
cost/token ratios (a documented-nowhere but plausible double-counting bug below v2.1.214).

The obvious way to add a dimension to a cumulative-counter diff is to widen the shared
`incFlat()`/`incBucketed()` functions in `dashboard/server/queries.js` — they already compute
exactly this diff (`greatest(end - start, 0)` for cumulative rows, `sumIf` for delta rows) and
~40 existing query functions depend on them.

### Decision
Do not touch `incFlat`/`incBucketed`. Write a small, self-contained subquery inside
`versionCohortSessions()`/`versionCohortCost()` that duplicates the same diff formula with
`AppVersion` in its own `GROUP BY`, scanning `otel_metrics_sum` directly (no rollup
optimization).

### Rationale
- `incFlat`/`incBucketed` are the most heavily-commented, most-reviewed code in this repo for
  a reason: they've had multiple subtle boundary bugs in the past (first-bucket raw stitch,
  hour-alignment skew at short ranges, the raw-vs-rollup dual path). Every past fix required
  careful reasoning about `LOOKBACK_DAYS`, session-boundary semantics, and how the fix
  interacts with all ~40 consumers at once.
- Adding a dimension to a shared `GROUP BY` is not obviously safe just because it "only adds
  granularity" — a consumer that assumes one row per (SessionId, Metric, ...) for a `LEFT JOIN`
  keyed on that assumption would silently start seeing duplicate/split rows if a session's
  `AppVersion` ever changes mid-session (rare, but real during a fleet upgrade).
- These two endpoints are integrity/verification tooling, not primary dashboard KPIs — they
  don't need the rollup's ~86x row reduction, and correctness matters more than query cost
  here.

### Consequences
- `versionCohortSessions`/`versionCohortCost` always scan `otel_metrics_sum` directly (raw
  table, `LOOKBACK_DAYS`-bounded lookback) — slower than a rollup-backed query on wide ranges,
  acceptable for infrequently-polled integrity checks.
- If a third consumer later needs `AppVersion` (or any other new dimension) on a cumulative
  diff, re-evaluate: two ad-hoc duplicates is tolerable, but a third should probably become the
  trigger to design a safe extension path for `incFlat`/`incBucketed` instead of a third copy.
- The formula duplication is a real (if small) source of drift risk — if the diff math in
  `incFlat` changes, this local copy won't follow automatically. Documented in
  `dashboard/server/CLAUDE.md` and `docs/reference/data.md` so a future edit to `incFlat`
  prompts a check here.

<a id="korean"></a>
## 한국어

**상태:** 채택
**날짜:** 2026-08-11

### 배경
2026-08-11 텔레메트리 스펙 동기화에서 무결성 검증 엔드포인트 2개
(`/api/integrity/version-cohort-sessions`, `/api/integrity/version-cohort-cost`)를 추가했다.
이 둘은 `otel_metrics_sum`의 누적 카운터(`cost.usage`, `token.usage`)를 새 차원
`AppVersion`으로 나눠 diff해야 한다 — 목적 자체가 두 A/B 그룹이 서로 다른 Claude Code
버전을 쓰고 있는지, 그렇다면 그게 서로 다른 cost/token 비율을 만드는지(문서에 없지만
가능성 있는 v2.1.214 이전 이중계상 버그) 확인하는 것이다.

누적 카운터 diff에 차원을 추가하는 가장 직관적인 방법은 공유 함수
`incFlat()`/`incBucketed()`(`dashboard/server/queries.js`)를 넓히는 것이다 — 이미 정확히
같은 diff(누적 행은 `greatest(끝값-시작값, 0)`, delta 행은 `sumIf`)를 계산하고, 기존 쿼리
함수 ~40개가 이걸 쓴다.

### 결정
`incFlat`/`incBucketed`는 건드리지 않는다. `versionCohortSessions()`/`versionCohortCost()`
안에 같은 diff 공식을 복제한 작고 자기완결적인 서브쿼리를 작성하고, `AppVersion`을 그 안의
자체 `GROUP BY`에 넣어 `otel_metrics_sum`을 직접 스캔한다(rollup 최적화 없음).

### 근거
- `incFlat`/`incBucketed`는 이 리포에서 가장 많이 주석 달리고 가장 많이 리뷰받은 코드다 —
  이유가 있다: 과거에 미묘한 경계 버그를 여러 차례 겪었다(첫 버킷 raw stitch, 짧은 구간의
  hour 정렬 스큐, raw-vs-rollup 이중 경로). 과거 수정 전부가 `LOOKBACK_DAYS`, 세션-경계
  의미론, 그리고 그 수정이 ~40개 소비자 전체와 어떻게 상호작용하는지를 동시에 신중히
  따져야 했다.
- 공유 `GROUP BY`에 차원을 추가하는 게 "그레인만 늘어날 뿐"이라서 당연히 안전한 건 아니다 —
  (SessionId, Metric, ...)당 한 행이라고 가정하고 그 위에 `LEFT JOIN`을 건 소비자가 있다면,
  세션 도중 `AppVersion`이 바뀌는 경우(드물지만 플릿 업그레이드 중엔 실재)에 조용히
  중복·분할 행을 보게 될 수 있다.
- 이 두 엔드포인트는 무결성/검증용 도구이지 대시보드 핵심 KPI가 아니다 — rollup의 ~86x
  행 감소가 필요 없고, 여기서는 쿼리 비용보다 정확성이 우선이다.

### 결과
- `versionCohortSessions`/`versionCohortCost`는 항상 `otel_metrics_sum` 원본을 직접
  스캔한다(`LOOKBACK_DAYS`로 범위가 제한된 lookback) — 넓은 구간에서는 rollup 기반 쿼리보다
  느리지만, 자주 조회되지 않는 무결성 검증용이라 감내 가능.
- 나중에 세 번째 소비자가 누적 diff에 `AppVersion`(또는 다른 신규 차원)을 필요로 하면
  재검토할 것 — 임시 복제 2개는 허용 가능하지만, 3개째부터는 세 번째 복제 대신
  `incFlat`/`incBucketed`의 안전한 확장 경로를 설계하는 게 맞을 것이다.
- 공식 복제는 실질적인(비록 작더라도) drift 위험이다 — `incFlat`의 diff 수식이 바뀌면 이
  로컬 복제는 자동으로 따라가지 않는다. `dashboard/server/CLAUDE.md`와
  `docs/reference/data.md`에 문서화해 향후 `incFlat` 수정 시 여기도 확인하도록 남겼다.
