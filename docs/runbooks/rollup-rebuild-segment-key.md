# Runbook: Rebuild the Hourly Rollup for the Segment-Aware SeriesKey Cutover

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

---

<a id="english"></a>

# English

## Overview
Cut the live cluster over from the legacy `SeriesKey` (`cityHash64(toString(Attributes))`) to
the segment-aware key (`StartTimeUnix` folded in, `session.count` excepted — see
[ADR-003](../decisions/ADR-003-fold-start-time-into-series-key.md)) and rebuild
`otel_metrics_sum_hourly` so the rollup reflects the same segment boundaries. This runbook
drives `clickhouse-migration-003.sql`, statement by statement. **If this document and that SQL
file ever disagree, the SQL file wins** — it is the file that actually gets executed.

## When to Use
- Rolling out the segment-aware `SeriesKey` change (ADR-003) against the live cluster.
- The reference/local docker-compose stack does not need this runbook — it has no replicas and
  no live-traffic concern, so `clickhouse-schema.sql`'s own "003" block plus a `TRUNCATE` +
  `scripts/backfill-hourly-rollup.sh` rebuild is enough (see `clickhouse-migration-003.sql` §9).

## Prerequisites
- **Writer/admin ClickHouse credentials — not the dashboard's `otel_reader` account.**
  `otel_reader` has `SELECT` on `claude_code.*` and `system.tables`/`system.databases` only. It
  cannot run any `ALTER`/`CREATE`/`EXCHANGE` statement in this procedure, and it **cannot even
  read `system.mutations`** to watch statement 2's progress. Get a privileged user
  (`otel_writer` or cluster admin) before starting.
- Two access paths to the cluster:
  - Direct exec into a ClickHouse pod, pasting each statement into an interactive client:
    ```bash
    kubectl -n claude-code exec <clickhouse-pod> -c clickhouse -- clickhouse-client
    ```
  - Or port-forward the native protocol port and drive `scripts/backfill-hourly-rollup.sh`
    from your workstation for the backfill steps (§B4/§B6):
    ```bash
    kubectl -n claude-code port-forward svc/clickhouse-cc-ab 9000:9000
    ```
    then set `CH_PORT=9000` (the script's `CH_PORT` default is already `9000`, ClickHouse's
    native-protocol default — this only matters when going through the port-forward, which is
    exactly why the script exposes it).
- `clickhouse-migration-003.sql` open in front of you; it **must** be run statement by statement,
  never as one `--queries-file` pass (each statement is commented with its own section banner,
  `§1`–`§10`). The file's §5 `EXCHANGE TABLES` is commented out on purpose — you uncomment and run
  it by hand after §4's backfill and verification (b)/(c) — and §10 (the self-recording ledger
  `INSERT`) is the final step.

## Read this before you start: the transient effects

**The raw-path double count.** Between statement 1 (`MODIFY COLUMN`, instant) and the moment
statement 2 (`MATERIALIZE COLUMN`) finishes rewriting all existing parts, the raw
`otel_metrics_sum` table holds a mix of legacy-key rows (existing parts, not yet rewritten) and
segment-key rows (new inserts, written under the new definition from the instant statement 1
runs) for any session that was live at that moment. This inflates anything that queries the raw
table directly:
- `incFlatRaw`/`incBucketedRaw` — the code paths used for ≤4h spans and minute-grain drag-zoom
  in the dashboard.
- The Grafana panels (`grafana-ab-queries.sql`) — they read the raw table, not the rollup.
- Chat SQL ("Ask Claude") when it queries `claude_code.otel_metrics_sum` directly.

**The rollup path (`incFlat`/`incBucketed`, most of the dashboard) is not affected** — it reads
`otel_metrics_sum_hourly`, which is rebuilt from scratch in this procedure and never sees mixed
keys for a given series. If a user reports a spike on a short/minute-grain view during the
mutation window, this is the explanation — check §7 "What changes for users" below, which
covers the other, permanent change instead.

**Dashboard staleness.** The dashboard server caches API responses for up to `CACHE_TTL_MS`
(`dashboard/server/index.js`) — **320,000 ms (320s, ~5.3 minutes)**. Any dashboard view can lag
the cluster by up to that long; this bounds how quickly checks (a)/(d)/(e) below become visible
in the UI itself (the SQL checks against ClickHouse directly are not subject to this delay).

## Procedure

The eight numbered steps below match `clickhouse-migration-003.sql` §1–§9 (its own section
numbers; §4/§6/§9 are comment-only, no SQL to run there beyond the backfill script).

### 1. Statement 1 — flip the key definition (§1, instant)
```sql
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated'
    MODIFY COLUMN SeriesKey UInt64 MATERIALIZED
        if(MetricName = 'claude_code.session.count',
           cityHash64(toString(Attributes)),
           cityHash64(toString(Attributes), toUnixTimestamp64Nano(StartTimeUnix)));
```
**Duration: instant, metadata-only.** `system.mutations` stays at 0 rows; existing parts keep
their old materialized values. The MV starts writing segment keys into the rollup on the very
next insert — this is also the instant the raw-path double count (above) begins.

### 2. Statement 2 — rewrite existing parts (§2, background mutation)
```sql
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated' MATERIALIZE COLUMN SeriesKey;
```
**Duration: a background mutation over ~498M rows / 2.24 GiB** (measured size of
`otel_metrics_sum`, data since 2026-07-07). Watch it with a privileged account:
```sql
SELECT count() FROM system.mutations
WHERE database = 'claude_code' AND table = 'otel_metrics_sum' AND NOT is_done;
```
Good = this drops to `0`. Until it does, the raw-path double count above is in effect.

### 3. Statement 3 — create the shadow rollup table (§3, instant)
```sql
CREATE TABLE claude_code.otel_metrics_sum_hourly_v2 ON CLUSTER 'replicated'
(
    hour                   DateTime,
    MetricName             LowCardinality(String),
    SessionId              String,
    SeriesKey              UInt64,
    UserEmail              LowCardinality(String),
    AggregationTemporality Int32,
    Model                  LowCardinality(String),
    TokenType              LowCardinality(String),
    Decision               LowCardinality(String),
    SkillName              LowCardinality(String),
    ToolName               LowCardinality(String),
    StartType              LowCardinality(String),
    AppVersion             LowCardinality(String),
    max_value SimpleAggregateFunction(max, Float64),
    sum_value SimpleAggregateFunction(sum, Float64),
    has_org   SimpleAggregateFunction(max, UInt8)
)
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/otel_metrics_sum_hourly_v2', '{replica}')
PARTITION BY toYYYYMM(hour)
ORDER BY (MetricName, SessionId, SeriesKey, UserEmail, AggregationTemporality,
          Model, TokenType, Decision, SkillName, ToolName, StartType, AppVersion, hour)
TTL toDateTime(hour) + INTERVAL 180 DAY DELETE
SETTINGS storage_policy = 'hot_cold';
```
**Duration: instant.** This is a plain `CREATE TABLE`, deliberately not `IF NOT EXISTS` — if a
`_v2` table already exists, a previous run's rollback window is still open, and you want a loud
failure here, not a silent reuse of stale data. If this fails because `_v2` already exists,
stop and resolve that leftover table (see Cleanup) before proceeding.

You do not have to wait for step 2 to finish before doing this — it does not touch
`otel_metrics_sum`.

### 4. Backfill into the shadow table (§4, the long pole)
Note the current hour before you start — this is `H0`:
```sql
SELECT toStartOfHour(now());
```
Then, from a machine that can reach the cluster (direct exec or via `kubectl port-forward`):
```bash
TARGET_TABLE=claude_code.otel_metrics_sum_hourly_v2 \
  RANGE_TO='<H0>' CH_HOST=<host> CH_PASSWORD=<pw> ./scripts/backfill-hourly-rollup.sh
```
**Duration: the long pole of this procedure.** The script aggregates day by day (one progress
line per day, `[D, D+1) 집계 중...`) over the raw table's full history — data since
**2026-07-07**, ~498M rows. It does **not** need statement 2 to have finished: the script
computes `SeriesKey` explicitly with the same expression as the `MATERIALIZED` definition
(`clickhouse-migration-003.sql` §4 comment; verification query (b) below is what proves the two
agree), so it is correct regardless of mutation progress. Env vars used:
`CH_HOST`/`CH_PORT`/`CH_PASSWORD` (connection), `TARGET_TABLE` (`_v2` here),
`RANGE_FROM`/`RANGE_TO` (window; `RANGE_FROM` left unset defaults to raw `min(TimeUnix)`).

### 5. Statement 5 — exchange the tables (§5, atomic)
```sql
EXCHANGE TABLES claude_code.otel_metrics_sum_hourly AND claude_code.otel_metrics_sum_hourly_v2 ON CLUSTER 'replicated';
```
**Duration: atomic, no visible gap.** The materialized view's `TO` target resolves by name, so
it starts writing into the rebuilt table immediately after the exchange.

**Expected, not a bug:** after this statement, the live-named table
(`claude_code.otel_metrics_sum_hourly`) sits on ZooKeeper path
`/clickhouse/tables/{shard}/otel_metrics_sum_hourly_v2`, and the old (legacy-key) data now sits
on path `/clickhouse/tables/{shard}/otel_metrics_sum_hourly`. Running `SHOW CREATE TABLE
claude_code.otel_metrics_sum_hourly` will show the `_v2` ZK path. This name/path mismatch is the
single most confusing consequence of this procedure — expect it, and see Cleanup below for the
second time it comes up.

### 6. Fill the gap (§6, minutes)
```bash
TARGET_TABLE=claude_code.otel_metrics_sum_hourly RANGE_FROM='<H0>' RANGE_TO='<Hx>' \
  CH_HOST=<host> CH_PASSWORD=<pw> ./scripts/backfill-hourly-rollup.sh
```
**Duration: minutes** — this window is just `[H0, Hx)`, not the full history. Use range mode
(not watermark mode) with `TARGET_TABLE` left at its default (the live name). `Hx` is
`toStartOfHour()` of the moment you ran the EXCHANGE.
Only `max_value`/`has_org` merge idempotently (`max`); `sum_value` is `SimpleAggregateFunction(sum)`,
so any hour the MV already wrote gets its delta rows (`AggregationTemporality = 1`) added again —
permanently. Stopping at `Hx` keeps the backfill disjoint from the MV's `[Hx, now)`; the delta rows
of the single hour `[Hx, EXCHANGE)` come out low instead (2 such rows in the whole rollup, measured
2026-09-02 prod — check with §7(f) in the migration file).

## Verification

Run these against the live cluster (all five are also in `clickhouse-migration-003.sql` §7,
commented out).

**(a) The MV writes to the new table, the old one is frozen.** Run twice, 2–3 minutes apart:
```sql
SELECT max(hour) AS head, count() AS rows FROM claude_code.otel_metrics_sum_hourly;
SELECT max(hour) AS head, count() AS rows FROM claude_code.otel_metrics_sum_hourly_v2;
```
Good = the live name's `head`/`rows` advance between the two runs; `_v2`'s do not move. If the
old table keeps growing instead, the MV did not repoint — fallback: `DROP VIEW
claude_code.otel_metrics_sum_hourly_mv ON CLUSTER 'replicated'`, re-run the `CREATE MATERIALIZED
VIEW` from `infra/files/clickhouse-schema-replicated.sql`, then redo the gap fill (step 6).

**(b) Key consistency** — run once statement 2 (§2) has finished:
```sql
SELECT countIf(SeriesKey != if(MetricName = 'claude_code.session.count', cityHash64(toString(Attributes)), cityHash64(toString(Attributes), toUnixTimestamp64Nano(StartTimeUnix)))) AS mismatch
FROM claude_code.otel_metrics_sum
WHERE TimeUnix >= now() - INTERVAL 1 DAY;
```
Good = `mismatch = 0` (mirrors the 2026-07-10 mismatch=0 pattern this repo already trusts).

**(c) Mutation progress** (needs a privileged account — `otel_reader` cannot read this table):
```sql
SELECT count() FROM system.mutations
WHERE database = 'claude_code' AND table = 'otel_metrics_sum' AND NOT is_done;
```
Good = `0` once statement 2 has completed.

**(d) 14-day cost total, new rollup vs old `_v2` table** — expect **≈+12–17%** (measured 30d
figure is +12.7%, §0.2):
```sql
SELECT round(sum(inc), 2) AS cost_usd FROM (
  SELECT greatest(mv - lagInFrame(mv, 1, 0) OVER
           (PARTITION BY MetricName, SessionId, SeriesKey ORDER BY hour), 0) AS inc
  FROM (SELECT hour, MetricName, SessionId, SeriesKey, max(max_value) AS mv
        FROM claude_code.otel_metrics_sum_hourly
        WHERE MetricName = 'claude_code.cost.usage'
          AND hour >= toStartOfHour(now()) - INTERVAL 14 DAY
        GROUP BY hour, MetricName, SessionId, SeriesKey));
```
...and the identical query against `claude_code.otel_metrics_sum_hourly_v2`. Good = the ratio
between the two is in the expected range. Two things to keep in mind reading the result: the
`lagInFrame(mv, 1, 0)` zero-default is required — a fresh segment's first bucket carries its
whole increase, and a `lagInFrame(mv, 1, mv)` default would erase exactly the value this
migration recovers. That same zero-default also counts the full history of any series that
predates the 14-day window, identically in both tables — so read the **ratio**, not the
absolute number.

**(e) Per-day row coverage, no missing days:**
```sql
SELECT toStartOfDay(hour) AS d, count() AS rows FROM claude_code.otel_metrics_sum_hourly
GROUP BY d ORDER BY d;
```
...and the same query against `_v2`. Good = both cover every day from 2026-07-07 to now with no
gaps.

## Rollback
```sql
EXCHANGE TABLES claude_code.otel_metrics_sum_hourly AND claude_code.otel_metrics_sum_hourly_v2 ON CLUSTER 'replicated';
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated'
    MODIFY COLUMN SeriesKey UInt64 MATERIALIZED cityHash64(toString(Attributes));
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated' MATERIALIZE COLUMN SeriesKey;
```
Verified locally (2026-09-02): this round trip restores the legacy key with 0 mismatches. After
rollback, the dashboard reverts to under-counting resumed sessions exactly as before this
procedure (the +8–15% recovered figures in "What changes for users" below go away again), and
`/api/config`'s `schema.segmentAwareSeriesKey` will read `false` again once the probe re-runs
(within ~10 minutes, or immediately after a pod restart).

## Cleanup
Keep `_v2` (now holding the **old**, legacy-key data after the exchange) for a rollback window.
Once that window closes:
```sql
DROP TABLE claude_code.otel_metrics_sum_hourly_v2 ON CLUSTER 'replicated';
```
Reminder, stated once already in step 5 above but worth repeating here because it is the thing
a later operator trips over: **the live-named table (`otel_metrics_sum_hourly`) lives on the
`…_hourly_v2` ZooKeeper path**, and the frozen old data sits on `…_hourly`'s path. If someone
runs `SHOW CREATE TABLE claude_code.otel_metrics_sum_hourly` after this procedure and sees the
`_v2` path in the `ENGINE` clause, that is the expected, permanent state of this table (until a
future rebuild exchanges it again) — not a sign that something is broken.

## What changes for users
- **Cost, tokens, lines of code and active time all rise** — this is the fix working, not a
  regression. The recovered resets add **+8–15% over 30 days** (measured 2026-09-02, segment-
  aware vs current): cost $27,492 vs $24,394 (+12.7%), tokens 39.29B vs 34.12B (+15.16%), lines
  of code 642,057 vs 590,891 (+8.66%), active time 4,715,018 vs 4,360,270 s (+8.14%).
- **The sessions KPI does not change.** `claude_code.session.count` is deliberately excepted
  from the segment key (it stays `cityHash64(toString(Attributes))`) because the dashboard's
  session unit is `session.id`, not the counter segment — applying the segment key there would
  have counted every `--resume` as a new session (measured 30d: 441 distinct `session.id`,
  684 under an unconditional segment key, +50%), which is not what "how many sessions" means.

## Notes
- Last verified: 2026-09-02
- This runbook mirrors `clickhouse-migration-003.sql`; where they disagree, the SQL file is the
  one that actually runs and wins. See the closing summary of this change for any discrepancy
  found while writing this document.
- See [ADR-003](../decisions/ADR-003-fold-start-time-into-series-key.md) for why this change
  was made — this runbook covers the *how*, not the *why*.

---

<a id="korean"></a>

# 한국어

## 개요
라이브 클러스터의 레거시 `SeriesKey`(`cityHash64(toString(Attributes))`)를 세그먼트 인식 키
(`StartTimeUnix`를 접어 넣고, `session.count`만 예외 — [ADR-003](../decisions/ADR-003-fold-start-time-into-series-key.md)
참고)로 전환하고, 시간별 rollup(`otel_metrics_sum_hourly`)을 같은 세그먼트 경계로 재구축합니다.
이 런북은 `clickhouse-migration-003.sql`을 statement 단위로 따라갑니다. **이 문서와 그 SQL
파일이 다르면 SQL 파일이 이깁니다** — 실제로 실행되는 쪽이니까요.

## 사용 시점
- 세그먼트 인식 `SeriesKey` 변경(ADR-003)을 라이브 클러스터에 반영할 때.
- 참조/로컬 docker-compose 스택에는 이 런북이 필요 없습니다 — replica도 없고 라이브 트래픽
  걱정도 없으므로 `clickhouse-schema.sql`의 자체 "003" 블록 + `TRUNCATE` +
  `scripts/backfill-hourly-rollup.sh` 재구축이면 충분합니다(`clickhouse-migration-003.sql` §9).

## 사전 요구 사항
- **쓰기/관리자 ClickHouse 자격 증명 — 대시보드의 `otel_reader` 계정이 아닙니다.**
  `otel_reader`는 `claude_code.*`와 `system.tables`/`system.databases`에 대한 `SELECT`만
  가지고 있습니다. 이 절차의 어떤 `ALTER`/`CREATE`/`EXCHANGE` statement도 실행할 수 없고,
  statement 2의 진행 상황을 볼 **`system.mutations`조차 읽을 수 없습니다**. 시작 전에 권한
  있는 계정(`otel_writer` 또는 클러스터 admin)을 확보하세요.
- 클러스터 접근 경로 두 가지:
  - ClickHouse 파드에 직접 exec해서 대화형 클라이언트에 각 statement를 붙여 넣는 방식:
    ```bash
    kubectl -n claude-code exec <clickhouse-pod> -c clickhouse -- clickhouse-client
    ```
  - 또는 네이티브 프로토콜 포트를 port-forward하고 워크스테이션에서 백필 단계(§B4/§B6)를
    `scripts/backfill-hourly-rollup.sh`로 직접 구동:
    ```bash
    kubectl -n claude-code port-forward svc/clickhouse-cc-ab 9000:9000
    ```
    이후 `CH_PORT=9000`을 설정합니다(스크립트의 `CH_PORT` 기본값이 이미 ClickHouse 네이티브
    프로토콜 기본값인 `9000`입니다 — 이 값이 실제로 의미를 가지는 건 이 port-forward를 거칠
    때뿐이고, 그래서 스크립트가 이 옵션을 노출합니다).
- `clickhouse-migration-003.sql`을 옆에 펴 두고, **반드시** statement 단위로 실행하세요 — 한 번의
  `--queries-file` 실행은 절대 금지입니다(각 statement는 자체 섹션 배너 `§1`–`§10`으로 주석되어
  있습니다). 이 파일의 §5 `EXCHANGE TABLES`는 의도적으로 주석 처리되어 있으며, §4 백필과
  검증 (b)/(c)를 마친 뒤 직접 주석을 풀어 실행합니다. §10(자기 기록 원장 `INSERT`)이 마지막
  단계입니다.

## 시작 전에 읽을 것: 과도기 효과

**RAW 경로 과대집계.** statement 1(`MODIFY COLUMN`, 즉시)과 statement 2(`MATERIALIZE COLUMN`)가
기존 파트를 모두 재작성해 끝나는 순간 사이, 원본 `otel_metrics_sum` 테이블에는 레거시 키 행
(재작성되지 않은 기존 파트)과 세그먼트 키 행(statement 1이 실행된 순간부터 새 정의로 쓰인
신규 insert)이 섞여 있습니다. 그 순간 살아있던 세션에 대해서는 원본 테이블을 직접 읽는 모든
것이 과대집계됩니다:
- `incFlatRaw`/`incBucketedRaw` — 대시보드에서 ≤4시간 구간과 분 단위 drag-zoom에 쓰이는 코드
  경로.
- Grafana 패널(`grafana-ab-queries.sql`) — rollup이 아니라 원본 테이블을 읽습니다.
- "Ask Claude" 챗 SQL이 `claude_code.otel_metrics_sum`을 직접 조회하는 경우.

**rollup 경로(`incFlat`/`incBucketed`, 대시보드 대부분)는 영향받지 않습니다** —
`otel_metrics_sum_hourly`를 읽고, 이 절차에서 처음부터 다시 구축되어 특정 시리즈에 대해 섞인
키를 볼 일이 없습니다. mutation 진행 중 짧은/분 단위 뷰에서 스파이크를 보고 사용자가 문의하면
이게 원인입니다 — 아래 "사용자에게 달라지는 것"은 다른, 영구적인 변화를 다룹니다.

**대시보드 지연.** 대시보드 서버는 API 응답을 최대 `CACHE_TTL_MS`
(`dashboard/server/index.js`) 만큼 캐시합니다 — **320,000ms(320초, 약 5.3분)**. 어떤 대시보드
화면이든 클러스터보다 최대 이만큼 뒤처질 수 있습니다. 즉 아래 (a)/(d)/(e) 검증이 UI 자체에
언제 반영되는지의 하한선입니다(ClickHouse에 직접 실행하는 SQL 검증은 이 지연과 무관합니다).

## 절차

아래 여덟 단계는 `clickhouse-migration-003.sql`의 §1–§9와 대응합니다(파일 자체의 섹션
번호이며, §4/§6/§9는 백필 스크립트 실행 외에 실행할 SQL이 없는 주석 블록입니다).

### 1. statement 1 — 키 정의 교체(§1, 즉시)
```sql
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated'
    MODIFY COLUMN SeriesKey UInt64 MATERIALIZED
        if(MetricName = 'claude_code.session.count',
           cityHash64(toString(Attributes)),
           cityHash64(toString(Attributes), toUnixTimestamp64Nano(StartTimeUnix)));
```
**소요 시간: 즉시, 메타데이터 전용.** `system.mutations`는 0행에 머물고 기존 파트는 예전 값을
그대로 유지합니다. MV는 바로 다음 insert부터 세그먼트 키를 rollup에 쓰기 시작합니다 — 위에서
말한 RAW 경로 과대집계도 이 순간부터 시작됩니다.

### 2. statement 2 — 기존 파트 재작성(§2, 백그라운드 mutation)
```sql
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated' MATERIALIZE COLUMN SeriesKey;
```
**소요 시간: 약 498M행 / 2.24GiB 규모의 백그라운드 mutation**(`otel_metrics_sum`의 실측
크기, 데이터는 2026-07-07부터). 권한 있는 계정으로 진행 상황을 확인하세요:
```sql
SELECT count() FROM system.mutations
WHERE database = 'claude_code' AND table = 'otel_metrics_sum' AND NOT is_done;
```
정상 = 이 값이 `0`이 되는 것. 0이 되기 전까지는 위의 RAW 경로 과대집계가 계속됩니다.

### 3. statement 3 — shadow rollup 테이블 생성(§3, 즉시)
```sql
CREATE TABLE claude_code.otel_metrics_sum_hourly_v2 ON CLUSTER 'replicated'
(
    hour                   DateTime,
    MetricName             LowCardinality(String),
    SessionId              String,
    SeriesKey              UInt64,
    UserEmail              LowCardinality(String),
    AggregationTemporality Int32,
    Model                  LowCardinality(String),
    TokenType              LowCardinality(String),
    Decision               LowCardinality(String),
    SkillName              LowCardinality(String),
    ToolName               LowCardinality(String),
    StartType              LowCardinality(String),
    AppVersion             LowCardinality(String),
    max_value SimpleAggregateFunction(max, Float64),
    sum_value SimpleAggregateFunction(sum, Float64),
    has_org   SimpleAggregateFunction(max, UInt8)
)
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/otel_metrics_sum_hourly_v2', '{replica}')
PARTITION BY toYYYYMM(hour)
ORDER BY (MetricName, SessionId, SeriesKey, UserEmail, AggregationTemporality,
          Model, TokenType, Decision, SkillName, ToolName, StartType, AppVersion, hour)
TTL toDateTime(hour) + INTERVAL 180 DAY DELETE
SETTINGS storage_policy = 'hot_cold';
```
**소요 시간: 즉시.** 일부러 `IF NOT EXISTS`를 쓰지 않은 평범한 `CREATE TABLE`입니다 — `_v2`
테이블이 이미 있다면 이전 실행의 롤백 창이 아직 열려 있다는 뜻이고, 조용히 재사용하지 말고
크게 실패해야 합니다. 이 statement가 `_v2`가 이미 존재해서 실패한다면, 진행하지 말고 그
남은 테이블을 먼저 정리하세요(아래 "정리" 참고).

statement 2가 끝나길 기다릴 필요가 없습니다 — `otel_metrics_sum`을 건드리지 않습니다.

### 4. shadow 테이블 백필(§4, 가장 오래 걸리는 단계)
시작 전에 현재 시각을 `H0`로 기록합니다:
```sql
SELECT toStartOfHour(now());
```
그다음, 클러스터에 접근 가능한 머신에서(직접 exec 또는 `kubectl port-forward` 경유):
```bash
TARGET_TABLE=claude_code.otel_metrics_sum_hourly_v2 \
  RANGE_TO='<H0>' CH_HOST=<host> CH_PASSWORD=<pw> ./scripts/backfill-hourly-rollup.sh
```
**소요 시간: 이 절차에서 가장 오래 걸리는 부분.** 스크립트는 하루 단위로 집계하며(하루당 진행
로그 한 줄, `[D, D+1) 집계 중...`) 원본 테이블의 전체 기간을 대상으로 합니다 — 데이터는
**2026-07-07**부터, 약 498M행. statement 2가 끝나길 기다릴 필요가 없습니다: 스크립트는
`MATERIALIZED` 정의와 동일한 식으로 `SeriesKey`를 직접 계산하므로(`clickhouse-migration-003.sql`
§4 주석; 아래 검증 (b)가 두 값이 실제로 일치함을 증명) mutation 진행 여부와 무관하게 옳습니다.
사용하는 환경 변수: `CH_HOST`/`CH_PORT`/`CH_PASSWORD`(접속), `TARGET_TABLE`(여기서는 `_v2`),
`RANGE_FROM`/`RANGE_TO`(구간; `RANGE_FROM`을 비워두면 원본의 `min(TimeUnix)`로 기본 설정됨).

### 5. statement 5 — 테이블 교체(§5, 원자적)
```sql
EXCHANGE TABLES claude_code.otel_metrics_sum_hourly AND claude_code.otel_metrics_sum_hourly_v2 ON CLUSTER 'replicated';
```
**소요 시간: 원자적, 가시적 공백 없음.** materialized view의 `TO` 대상은 이름으로 resolve되므로
교체 직후 재구축된 테이블에 바로 쓰기 시작합니다.

**정상 동작이며 버그가 아닙니다:** 이 statement 이후 라이브 이름
(`claude_code.otel_metrics_sum_hourly`)의 실제 ZooKeeper 경로는
`/clickhouse/tables/{shard}/otel_metrics_sum_hourly_v2`가 되고, 옛(레거시 키) 데이터는
`/clickhouse/tables/{shard}/otel_metrics_sum_hourly` 경로에 남습니다. `SHOW CREATE TABLE
claude_code.otel_metrics_sum_hourly`를 실행하면 `_v2` ZK 경로가 보입니다. 이 이름/경로 역전이
이 절차에서 가장 헷갈리는 결과입니다 — 예상하고 있으세요. 아래 "정리"에서 한 번 더 언급합니다.

### 6. 갭 채우기(§6, 수 분)
```bash
TARGET_TABLE=claude_code.otel_metrics_sum_hourly RANGE_FROM='<H0>' RANGE_TO='<Hx>' \
  CH_HOST=<host> CH_PASSWORD=<pw> ./scripts/backfill-hourly-rollup.sh
```
**소요 시간: 수 분** — 전체 기간이 아니라 `[H0, Hx)` 구간만입니다. watermark 모드가 아니라
range 모드를 쓰고, `TARGET_TABLE`은 기본값(라이브 이름)으로 둡니다. `Hx`는 EXCHANGE를 실행한
시각의 `toStartOfHour()`입니다. 멱등하게 병합되는 건 `max_value`/`has_org`(`max`)뿐이고,
`sum_value`는 `SimpleAggregateFunction(sum)`이라 MV가 이미 쓴 시간대와 겹치면 그 delta
행(`AggregationTemporality = 1`)이 겹친 버킷마다 영구히 다시 더해집니다. `Hx`에서 끊으면 백필
구간이 MV의 `[Hx, now)`와 분리되고, 대신 `[Hx, EXCHANGE)` 한 버킷의 delta 행만 낮게
나옵니다(그런 행은 rollup 전체에서 2건, 2026-09-02 prod 실측 — 마이그레이션 파일의 §7(f)로
확인하세요).

## 검증

아래 다섯 개는 라이브 클러스터에 대해 실행합니다(`clickhouse-migration-003.sql` §7에도 주석
처리된 형태로 모두 존재합니다).

**(a) MV가 새 테이블에 쓰고, 옛 테이블은 멈춰 있는지.** 2~3분 간격으로 두 번 실행:
```sql
SELECT max(hour) AS head, count() AS rows FROM claude_code.otel_metrics_sum_hourly;
SELECT max(hour) AS head, count() AS rows FROM claude_code.otel_metrics_sum_hourly_v2;
```
정상 = 두 번 실행 사이 라이브 이름의 `head`/`rows`는 전진하고, `_v2`는 움직이지 않음. 옛
테이블이 계속 자란다면 MV가 재조정되지 않은 것 — fallback: `DROP VIEW
claude_code.otel_metrics_sum_hourly_mv ON CLUSTER 'replicated'` 후
`infra/files/clickhouse-schema-replicated.sql`의 `CREATE MATERIALIZED VIEW`를 재실행하고,
갭 채우기(6단계)를 다시 수행합니다.

**(b) 키 일치** — statement 2(§2)가 끝난 뒤 실행:
```sql
SELECT countIf(SeriesKey != if(MetricName = 'claude_code.session.count', cityHash64(toString(Attributes)), cityHash64(toString(Attributes), toUnixTimestamp64Nano(StartTimeUnix)))) AS mismatch
FROM claude_code.otel_metrics_sum
WHERE TimeUnix >= now() - INTERVAL 1 DAY;
```
정상 = `mismatch = 0`(이 저장소가 이미 신뢰하는 2026-07-10 mismatch=0 패턴과 동일).

**(c) mutation 진행 상황**(권한 있는 계정 필요 — `otel_reader`는 이 테이블을 못 읽음):
```sql
SELECT count() FROM system.mutations
WHERE database = 'claude_code' AND table = 'otel_metrics_sum' AND NOT is_done;
```
정상 = statement 2가 끝나면 `0`.

**(d) 14일 비용 총계, 신규 롤업 vs 옛 `_v2` 테이블** — 기대치 **약 +12~17%**(실측 30일 기준
+12.7%, §0.2):
```sql
SELECT round(sum(inc), 2) AS cost_usd FROM (
  SELECT greatest(mv - lagInFrame(mv, 1, 0) OVER
           (PARTITION BY MetricName, SessionId, SeriesKey ORDER BY hour), 0) AS inc
  FROM (SELECT hour, MetricName, SessionId, SeriesKey, max(max_value) AS mv
        FROM claude_code.otel_metrics_sum_hourly
        WHERE MetricName = 'claude_code.cost.usage'
          AND hour >= toStartOfHour(now()) - INTERVAL 14 DAY
        GROUP BY hour, MetricName, SessionId, SeriesKey));
```
...그리고 `claude_code.otel_metrics_sum_hourly_v2`에 대해 동일한 쿼리. 정상 = 두 값의 비율이
기대 범위 안. 결과를 읽을 때 두 가지를 기억하세요: `lagInFrame(mv, 1, 0)`의 0-default는
필수입니다 — 새 세그먼트의 첫 버킷은 증가분 전체를 싣고 있고, `lagInFrame(mv, 1, mv)`
default를 쓰면 이 마이그레이션이 복구하려는 값이 그대로 지워집니다. 동시에 이 0-default는
14일 창 이전부터 존재하던 시리즈의 과거 전체도 함께 잡는데, 이는 신규/구 테이블 양쪽에
동일하게 적용되므로 절대값이 아니라 **비율**로 읽어야 합니다.

**(e) 일별 행 커버리지, 빠진 날이 없는지:**
```sql
SELECT toStartOfDay(hour) AS d, count() AS rows FROM claude_code.otel_metrics_sum_hourly
GROUP BY d ORDER BY d;
```
...그리고 `_v2`에 대해 동일한 쿼리. 정상 = 둘 다 2026-07-07부터 지금까지 매일이 빠짐없이
존재.

## 롤백
```sql
EXCHANGE TABLES claude_code.otel_metrics_sum_hourly AND claude_code.otel_metrics_sum_hourly_v2 ON CLUSTER 'replicated';
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated'
    MODIFY COLUMN SeriesKey UInt64 MATERIALIZED cityHash64(toString(Attributes));
ALTER TABLE claude_code.otel_metrics_sum ON CLUSTER 'replicated' MATERIALIZE COLUMN SeriesKey;
```
로컬 검증(2026-09-02): 이 왕복은 레거시 키를 mismatch 0으로 복원합니다. 롤백 후 대시보드는
이 절차 이전과 동일하게 resume된 세션을 과소집계하게 됩니다(아래 "사용자에게 달라지는 것"의
+8–15% 회복분은 다시 사라집니다), `/api/config`의 `schema.segmentAwareSeriesKey`도 다음 probe
주기(최대 10분, 또는 파드 재시작 시 즉시)에 다시 `false`로 돌아옵니다.

## 정리
`_v2`(교체 이후에는 **옛** 레거시 키 데이터를 담고 있음)를 롤백 창 동안 보존합니다. 창이
끝나면:
```sql
DROP TABLE claude_code.otel_metrics_sum_hourly_v2 ON CLUSTER 'replicated';
```
5단계에서 이미 한 번 언급했지만, 나중에 이 절차를 보는 오퍼레이터가 걸려 넘어지는 지점이라
다시 한번 강조합니다: **라이브 이름(`otel_metrics_sum_hourly`)은 `…_hourly_v2` ZooKeeper
경로 위에 있고**, 멈춰 있는 옛 데이터가 `…_hourly` 경로에 있습니다. 이후 누군가
`SHOW CREATE TABLE claude_code.otel_metrics_sum_hourly`를 실행해 `ENGINE` 절에서 `_v2` 경로를
본다면, 이는 이 절차의 정상적이고 영구적인 상태입니다(나중에 다시 재구축해서 교체하기 전까지) —
뭔가 고장난 신호가 아닙니다.

## 사용자에게 달라지는 것
- **비용, 토큰, 추가 라인, 활동 시간이 모두 상승합니다** — 이건 고쳐진 것이지 회귀가
  아닙니다. 회복된 리셋 구간이 **30일 기준 +8~15%**를 더합니다(2026-09-02 실측, 세그먼트
  인식 vs 현재): 비용 $27,492 vs $24,394(+12.7%), 토큰 39.29B vs 34.12B(+15.16%), 추가 라인
  642,057 vs 590,891(+8.66%), 활동 시간 4,715,018 vs 4,360,270초(+8.14%).
- **세션 KPI는 바뀌지 않습니다.** `claude_code.session.count`는 세그먼트 키에서 의도적으로
  제외됩니다(계속 `cityHash64(toString(Attributes))`를 씁니다) — 대시보드의 세션 단위는
  카운터 세그먼트가 아니라 `session.id`이기 때문입니다. 여기에 세그먼트 키를 적용했다면
  `--resume`마다 새 세션으로 잡혔을 것입니다(30일 실측: distinct `session.id` 441개, 조건 없는
  세그먼트 키를 쓰면 684개, +50%) — 이는 "세션이 몇 개인가"라는 질문의 답이 아닙니다.

## 참고
- 최종 검증일: 2026-09-02
- 이 런북은 `clickhouse-migration-003.sql`을 그대로 따라간 것입니다 — 두 문서가 다르면
  실제로 실행되는 SQL 파일이 이깁니다. 이 문서를 작성하며 발견한 불일치는 이 변경의 클로징
  서머리에 기록되어 있습니다.
- 이 변경의 이유는 [ADR-003](../decisions/ADR-003-fold-start-time-into-series-key.md)을
  참고하세요 — 이 런북은 *어떻게*를 다루고, *왜*는 다루지 않습니다.
