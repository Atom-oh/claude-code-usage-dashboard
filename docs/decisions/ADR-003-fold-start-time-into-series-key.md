# ADR-003: Fold `StartTimeUnix` into `SeriesKey` for segment-aware counter diffing

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

**Status:** Accepted
**Date:** 2026-09-02

### Context
The decisive measurement: negative `Value` steps are **0 within** a `StartTimeUnix` segment
and **334 across** segment switches (399 switches). That is what proves the reset boundary is
*exactly* `StartTimeUnix` — not an inference from a value drop, not a guess from
`session.id` churn, but a direct, measured coincidence between "counter went backwards" and
"`StartTimeUnix` changed."

`SeriesKey` (`cityHash64(toString(Attributes))`) has, until now, identified a series by its
label combination alone. But Claude Code's OTel counters are cumulative **per process**, and a
`--resume` or helper-process restart keeps the same `session.id` while resetting its counters
to zero. Under the legacy key, that reset is invisible: the diff logic sees one continuous
series and a value that went down, which `greatest(diff, 0)` was already floor-clamping to
zero — silently discarding the entire post-reset climb until the counter caught back up to its
previous high-water mark. Measured impact: 14d `cost.usage`, 155/1,030 (15.05%)
`(SessionId, SeriesKey)` pairs have more than one `StartTimeUnix`. Per metric over 7d
(within/across): `token.usage` 0/370, `lines_of_code` 0/46, `active_time` 0/97, `commit` 0/15,
`pull_request` 0/2, `code_edit_tool.decision` 0/58, `session.count` 0/0.

A "counter continuation" hypothesis — that these are the same logical counter being
re-exported, not a real reset — was checked and disproved: the fresh counters are re-caching
the same ~572K-token context (cacheCreation 571,705 → 572,938), i.e. a real new process boundary,
not a re-export artifact.

### Decision
Fold `StartTimeUnix` into `SeriesKey` so the key identifies a counter **segment**
(label combination × process start), not just a label combination:

```
if(MetricName = 'claude_code.session.count',
   cityHash64(toString(Attributes)),
   cityHash64(toString(Attributes), toUnixTimestamp64Nano(StartTimeUnix)))
```

`toUnixTimestamp64Nano` is used because `StartTimeUnix` is `DateTime64(9)`; passing its
nanosecond integer into `cityHash64` is exact and stable.

This expression is defined once, in `clickhouse-migration-003.sql` for the live cluster, and
copied verbatim into three more places: `clickhouse-schema.sql` (the local/reference copy),
`infra/files/clickhouse-schema-replicated.sql` (new-install replicated schema), and
`scripts/backfill-hourly-rollup.sh` (which must compute the key explicitly rather than read the
column, so backfill correctness does not depend on migration timing). Rollup schema, the
materialized view's query, and every dashboard and Grafana `GROUP BY` are unchanged —
`SeriesKey` was already in every key, so no query needed to widen. The hourly rollup itself is
rebuilt via a shadow table (`otel_metrics_sum_hourly_v2`) plus `EXCHANGE TABLES`, which also
closes an unrelated sort-key drift (`StartType`/`AppVersion` were added to the live rollup as
plain columns by migration-002, not to its `ORDER BY`, because a MergeTree sort key cannot be
altered in place).

### Rationale
- **The `session.count` exception.** `claude_code.session.count` keeps the legacy key
  (label combination only), not the segment key. The dashboard's session unit is the
  `session.id`, not the process: a segment key would make every `--resume` or helper-process
  restart count as a new session, redefining the sessions KPI rather than fixing a counting
  bug. Measured effect of *not* excepting it: 30d, 441 distinct `session.id`, current KPI 455,
  segment-aware (unconditional) 684 — a +50% inflation the dashboard does not want.
- **`uniqExact(SeriesKey)` changed meaning.** It now counts counter *segments*, not label
  combinations — a series that resumed twice counts as up to three. Any cardinality census
  that used `uniqExact(SeriesKey)` as a proxy for "how many distinct label combinations" is now
  measuring something else. `clickhouse-schema.sql`'s STEP 5 cardinality census was updated to
  answer the label-cardinality question with `uniqExact(cityHash64(toString(Attributes)))`
  instead, and to say explicitly which figure is which.

### Consequences
- Cost, tokens, lines of code, and active time all rise by the amount of recovered resets, over
  30d: cost $24,394 → $27,492 (+12.7%), tokens 34.12B → 39.29B (+15.16%), lines of code
  590,891 → 642,057 (+8.66%), active time 4,360,270s → 4,715,018s (+8.14%).
- The sessions KPI does **not** change (see the `session.count` exception above).
- A transient raw-path double count exists between `MODIFY COLUMN` (metadata-only, immediate)
  and `MATERIALIZE COLUMN` finishing (a background mutation over ~498M rows): until it
  completes, RAW-path queries (`incFlatRaw`/`incBucketedRaw` for ≤4h spans and minute buckets,
  Grafana panels, chat SQL against the raw table) see a mix of legacy-keyed and segment-keyed
  rows for any session live at cutover.
- After the rollup's `EXCHANGE TABLES` step, the live-named rollup table sits on the
  `…/otel_metrics_sum_hourly_v2` ZooKeeper path and the frozen old data sits on
  `…/otel_metrics_sum_hourly` — a name/path inversion, and the `_v2` copy is kept for a
  rollback window before being dropped.
- Procedure and exact statements: `clickhouse-migration-003.sql` and
  `docs/runbooks/rollup-rebuild-segment-key.md`. This document is about the decision, not the
  operator steps.

### Alternatives considered

**(A) A separate `SegmentStart` key column**, carried alongside `SeriesKey` in every
`GROUP BY`. Rejected: this widens every `GROUP BY` and the rollup sort key, which is exactly
what [ADR-001](ADR-001-local-diff-over-shared-incflat-extension.md) exists to avoid —
`incFlat`/`incBucketed` and the rollup's sort key are the most heavily-reviewed, most
consumer-dependent code in this repo, and ADR-001 already rejected widening a shared key for a
single new consumer. `SeriesKey` folding the segment in-place needs no such widening, because
it was already present in every key.

**(B) Prometheus-style value-drop detection in SQL** — treat a `Value` decrease as the reset
signal, without touching the key. Rejected: it is lossy at hourly granularity, since a drop and
a re-climb inside the same bucket are invisible to a bucket-level max/diff. It is also strictly
worse information than what is already measured: all 334 measured negative-step drops coincide
with a `StartTimeUnix` change, so the timestamp identifies every real reset that value-drop
detection would only sometimes catch.

**(C) In-place `ALTER … DELETE` and reinsert of the rollup**, rewriting historical rollup rows
instead of a shadow-table rebuild. Rejected: it produces a visible gap for dashboard users
while the delete-and-reinsert runs, and it does not fix the sort-key drift
(`StartType`/`AppVersion` missing from the live `ORDER BY`) that the shadow rebuild closes as a
side effect.

<a id="korean"></a>
## 한국어

**상태:** 채택
**날짜:** 2026-09-02

### 배경
결정적인 실측: 음수 `Value` 스텝은 `StartTimeUnix` 세그먼트 **내부에서는 0건**,
세그먼트 전환 **사이에서는 334건**(399번의 전환)이다. 이것이 리셋 경계가 값 하락으로부터의
추론이나 `session.id` 변화에 대한 추측이 아니라 *정확히* `StartTimeUnix`라는 것을 증명한다 —
"카운터가 역행함"과 "`StartTimeUnix`가 바뀜"이 직접, 실측으로 일치한다.

`SeriesKey`(`cityHash64(toString(Attributes))`)는 지금까지 라벨 조합만으로 시리즈를
식별했다. 그러나 Claude Code의 OTel 카운터는 **프로세스당** 누적이며, `--resume`이나 헬퍼
프로세스 재시작은 같은 `session.id`를 유지한 채 카운터를 0부터 다시 시작한다. 레거시 키
아래에서는 이 리셋이 보이지 않는다 — diff 로직은 하나의 연속된 시리즈와 하락한 값을 볼
뿐이고, 이미 `greatest(diff, 0)`으로 0에 floor-clamp되어 있어, 카운터가 이전 최고점을 다시
넘어설 때까지 리셋 이후의 상승분 전체가 조용히 버려진다. 실측 영향: 14일 `cost.usage`
기준 155/1,030쌍(15.05%)의 `(SessionId, SeriesKey)`가 `StartTimeUnix`를 2개 이상 갖는다.
메트릭별 7일 (세그먼트 내부/세그먼트 사이): `token.usage` 0/370, `lines_of_code` 0/46,
`active_time` 0/97, `commit` 0/15, `pull_request` 0/2, `code_edit_tool.decision` 0/58,
`session.count` 0/0.

"카운터 연속" 가설 — 이것들이 실제 리셋이 아니라 같은 논리적 카운터가 다시 export된 것뿐이라는
가설 — 은 검증했고 반증됐다: 새 카운터들은 동일한 ~572K 토큰 컨텍스트를 다시 캐싱하고
있다(cacheCreation 571,705 → 572,938) — 즉 재-export 인공물이 아니라 실제 새 프로세스
경계다.

### 결정
`StartTimeUnix`를 `SeriesKey`에 접어 넣어, 키가 라벨 조합만이 아니라 라벨 조합 ×
프로세스 시작인 카운터 **세그먼트**를 식별하게 한다:

```
if(MetricName = 'claude_code.session.count',
   cityHash64(toString(Attributes)),
   cityHash64(toString(Attributes), toUnixTimestamp64Nano(StartTimeUnix)))
```

`toUnixTimestamp64Nano`를 쓰는 이유: `StartTimeUnix`는 `DateTime64(9)`이므로, 나노초
정수로 변환해 `cityHash64`에 넘기는 것이 정확하고 안정적이다.

이 표현식은 라이브 클러스터용 `clickhouse-migration-003.sql`에서 한 번 정의되고, 그대로
세 곳에 복사된다: `clickhouse-schema.sql`(로컬/참조 사본),
`infra/files/clickhouse-schema-replicated.sql`(신규 설치용 replicated 스키마),
`scripts/backfill-hourly-rollup.sh`(컬럼을 읽지 않고 직접 계산해야 백필 정확성이 마이그레이션
진행 시점에 의존하지 않는다). 롤업 스키마, materialized view의 쿼리, 그리고 대시보드/Grafana의
모든 `GROUP BY`는 변경되지 않는다 — `SeriesKey`가 이미 모든 키에 포함되어 있었으므로 어떤
쿼리도 넓힐 필요가 없었다. 시간별 롤업 자체는 shadow 테이블(`otel_metrics_sum_hourly_v2`)과
`EXCHANGE TABLES`로 재구축되며, 이는 부수적으로 관련 없는 정렬 키 드리프트도 해소한다
(`StartType`/`AppVersion`이 migration-002에서 라이브 롤업에 일반 컬럼으로만 추가되고
`ORDER BY`에는 들어가지 못했던 것 — MergeTree 정렬 키는 제자리에서 변경할 수 없기 때문이다).

### 근거
- **`session.count` 예외.** `claude_code.session.count`는 세그먼트 키가 아니라 레거시
  키(라벨 조합만)를 유지한다. 대시보드의 세션 단위는 `session.id`이지 프로세스가 아니다 —
  세그먼트 키를 적용하면 `--resume`이나 헬퍼 프로세스 재시작마다 새 세션으로 잡혀, 버그를
  고치는 게 아니라 세션 KPI 자체를 재정의하게 된다. 예외를 두지 않았을 때의 실측 영향:
  30일 기준 441개의 distinct `session.id`, 현재 KPI 455, 세그먼트 인식(무조건 적용) 684 —
  대시보드가 원하지 않는 +50% 부풀림이다.
- **`uniqExact(SeriesKey)`의 의미 변경.** 이제 라벨 조합이 아니라 카운터 *세그먼트* 수를
  센다 — 두 번 resume한 시리즈는 최대 3개로 집계된다. `uniqExact(SeriesKey)`를 "distinct
  라벨 조합 수"의 대용으로 쓰던 카디널리티 조사는 이제 다른 것을 측정하게 된다.
  `clickhouse-schema.sql`의 STEP 5 카디널리티 조사는 라벨-카디널리티 질문을
  `uniqExact(cityHash64(toString(Attributes)))`로 답하도록 갱신했고, 어느 값이 무엇인지
  명시했다.

### 결과
- 비용, 토큰, 코드 라인, active time이 모두 복구된 리셋만큼 상승한다(30일 기준): 비용
  $24,394 → $27,492(+12.7%), 토큰 34.12B → 39.29B(+15.16%), 코드 라인 590,891 →
  642,057(+8.66%), active time 4,360,270초 → 4,715,018초(+8.14%).
- 세션 KPI는 변경되지 **않는다**(위 `session.count` 예외 참고).
- `MODIFY COLUMN`(메타데이터 전용, 즉시)과 `MATERIALIZE COLUMN` 완료(약 498M행에 걸친
  백그라운드 mutation) 사이에 일시적인 RAW 경로 과대집계가 존재한다: 완료 전까지 RAW
  경로 쿼리(≤4시간 구간·분 단위 버킷의 `incFlatRaw`/`incBucketedRaw`, Grafana 패널, 원본
  테이블을 직접 읽는 chat SQL)는 컷오버 시점에 살아있던 세션에 대해 레거시 키 행과 세그먼트
  키 행이 섞여 보인다.
- 롤업의 `EXCHANGE TABLES` 단계 이후, 라이브 이름의 롤업 테이블은
  `…/otel_metrics_sum_hourly_v2` ZooKeeper 경로에 놓이고, 멈춰버린 옛 데이터는
  `…/otel_metrics_sum_hourly`에 남는다 — 이름/경로 역전이며, `_v2` 사본은 롤백 창 동안
  보존한 뒤 삭제한다.
- 절차와 정확한 statement는 `clickhouse-migration-003.sql`과
  `docs/runbooks/rollup-rebuild-segment-key.md` 참고. 이 문서는 결정에 대한 것이고 오퍼레이터
  절차는 다루지 않는다.

### 검토한 대안

**(A) 별도의 `SegmentStart` 키 컬럼**을 `SeriesKey`와 함께 모든 `GROUP BY`에 싣는 방식.
거부: 모든 `GROUP BY`와 롤업 정렬 키를 넓혀야 하는데, 이는 정확히
[ADR-001](ADR-001-local-diff-over-shared-incflat-extension.md)이 막으려던 것이다 —
`incFlat`/`incBucketed`와 롤업 정렬 키는 이 리포에서 가장 많이 리뷰되고 가장 많은 소비자가
의존하는 코드이며, ADR-001은 단일 신규 소비자를 위해 공유 키를 넓히는 것을 이미 거부했다.
`SeriesKey`에 세그먼트를 접어 넣는 방식은 그런 확장이 필요 없다 — 이미 모든 키에 포함되어
있었기 때문이다.

**(B) Prometheus 스타일의 SQL 내 값-하락 감지** — 키는 그대로 두고 `Value` 하락을 리셋
신호로 취급. 거부: 시간 단위 그레인에서는 손실이 있다 — 같은 버킷 안에서의 하락과 재상승은
버킷 단위 max/diff에는 보이지 않는다. 이미 실측된 정보보다도 명백히 못하다: 실측된 334건의
음수 스텝 하락 전부가 `StartTimeUnix` 변화와 일치하므로, 타임스탬프는 값-하락 감지가
가끔씩만 잡아낼 모든 실제 리셋을 확실하게 식별한다.

**(C) 롤업에 대한 제자리 `ALTER … DELETE` + 재삽입** — shadow 테이블 재구축 대신 과거 롤업
행을 직접 재작성. 거부: delete-and-reinsert가 실행되는 동안 대시보드 사용자에게 눈에 보이는
공백이 생기고, shadow 재구축이 부수적으로 해소하는 정렬 키 드리프트
(`StartType`/`AppVersion`이 라이브 `ORDER BY`에 없는 문제)는 고치지 못한다.
