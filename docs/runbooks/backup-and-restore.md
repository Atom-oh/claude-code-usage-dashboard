# Runbook: ClickHouse Backup & Restore Posture

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

---

<a id="english"></a>

# English

## Overview
The `clickhouse-backup` CronJob (`infra/clickhouse.tf`, `kubernetes_cron_job_v1.backup`) runs
`BACKUP DATABASE claude_code TO S3(...)` on schedule `0 18 * * *` UTC = 03:00 KST, daily
(`infra/clickhouse.tf:360`), writing a self-contained archive object per day under the
`backup/` prefix of the ClickHouse bucket, using the pod's IRSA credentials — no separate
secret to manage for the backup itself. `infra/s3.tf`'s `expire-backups` lifecycle rule
expires objects under that same `backup/` prefix after **30 days**
(`infra/s3.tf:16-17`: `filter { prefix = "backup/" }`, `expiration { days = 30 }`). This
runbook states what those two facts mean operationally, points at the existing restore
procedure instead of duplicating it, and gives a quarterly drill checklist — including the
one number this project does not yet have.

## When to Use
- Before relying on backup coverage for an audit, a workshop teardown, or an incident
  post-mortem — to know exactly how much data-loss exposure exists at any moment.
- Quarterly, to run the restore drill below.
- After any change to `infra/clickhouse.tf`'s backup CronJob or `infra/s3.tf`'s lifecycle
  rule, to re-confirm the schedule/retention facts cited here still match the applied
  infrastructure.

## Prerequisites
- `kubectl` access to the `claude-code` namespace, same pattern as
  [`incident-response.md`](incident-response.md).
- Read access to the ClickHouse bucket (`cc-ab-clickhouse-<account-id>-<region>`) if
  inspecting backup objects directly from S3 rather than from inside the cluster.
- A scratch ClickHouse target for the drill (Option A or Option B below) — see
  [`archive-clickhouse.md`](archive-clickhouse.md#3-restore-rehearsal-recommended-while-the-workshop-account-is-still-alive).

## Procedure

### 1. See what backups exist
```bash
aws s3 ls --recursive s3://cc-ab-clickhouse-<account-id>-<region>/backup/
```
Each daily run produces one self-contained object at `backup/<UTC date>_<HHMMSS>` (a
`.backup` manifest plus `data/claude_code/<table>/...` parts) — nothing about restoring one
depends on any other object in the prefix, and nothing outside the account it lives in.

### 2. Restore — pointer, not a duplicate
The restore mechanics — Option A (matching replicated infra) and Option B (single node with
non-replicated engines, where the `PARTITION BY`/`ORDER BY` must match the source exactly or
`RESTORE` fails with `CORRUPTED_DATA`) — are already written down in
[`archive-clickhouse.md`](archive-clickhouse.md#3-restore-rehearsal-recommended-while-the-workshop-account-is-still-alive),
`### 3. Restore rehearsal`. The only operational difference for a daily-backup restore
(rather than the pre-teardown archive) is that the `RESTORE DATABASE ... FROM S3(...)` URL
points at one of this prefix's daily `backup/<date>_<HHMMSS>` objects instead of the archive
bucket's `<archive-prefix>/backup/final-<timestamp>` object — everything else in that
section, including the table pre-creation step for Option B, applies unchanged. Follow it
there rather than re-deriving the `RESTORE` statement here.

### 3. Quarterly restore drill
Run this on a cadence, not only when something has already broken — it is the only way this
project's RTO gets measured instead of guessed at.

1. Pick a recent daily backup object from Step 1.
2. Restore it into a **throwaway database name on the same cluster** — e.g.
   `claude_code_drill_<date>` — never over `claude_code`. Use the Option A/B pre-creation
   and `RESTORE DATABASE ... AS claude_code_drill_<date> FROM S3(...)` pattern from
   `archive-clickhouse.md` §3, substituting the throwaway name.
3. Compare `count()` per table between `claude_code_drill_<date>` and `claude_code` for the
   **same one-day window** that is no longer being actively written to (matching
   `archive-clickhouse.md`'s own caution that `AggregatingMergeTree` row counts can drift
   from background merges alone outside a stable window).
4. Drop the throwaway database: `DROP DATABASE claude_code_drill_<date>`.
5. Record the wall-clock time from "started restore" to "counts verified" — **this is what
   finally measures RTO.** Write the date, the backup object restored, the elapsed time, and
   pass/fail into this runbook's Notes section (or an incident-response log, if this project
   later adopts one) so the next drill has a trend to compare against.

## Verification
A drill is successful when every table's `count()` in the throwaway database matches
`claude_code`'s for the compared one-day window, and the throwaway database has been
dropped. A mismatch is not automatically a backup defect for aggregate tables — see the
background-merge caveat in Step 3 — but a mismatch on `otel_logs` or `otel_metrics_sum`
(both plain `MergeTree`-family tables with no aggregation) for a closed window is.

## Rollback
Restoring into a throwaway database has nothing to roll back — it never touches
`claude_code`. The only destructive step in this procedure is the final `DROP DATABASE`, and
it must always name the throwaway drill database, never `claude_code`.

## Gaps
This table is a posture statement, not a to-do list this doc can close on its own — each row
names a decision that belongs to someone else first.

| Gap | Why it is open | What unblocks it |
|---|---|---|
| No alert when the backup CronJob fails | there is no alerting channel decided for this project yet | the alerting-channel decision |
| No cross-region copy of the backup bucket | it is a cost decision, not a technical one | a cost decision |
| RTO is unmeasured | no restore drill has been run | the first quarterly drill (§3 above) |

## Notes
- RPO is **24 hours**, derived from the daily backup schedule (`infra/clickhouse.tf:360`) —
  there is no continuous replication or WAL shipping to a second site, so up to one full
  day's writes can be lost if the cluster is lost between two backups.
- RTO is **not measured**. Do not substitute an estimate derived from data volume or cluster
  size for it — the first quarterly drill above is what turns it into a real number.
- No alarm fires today if the backup CronJob fails a run; nothing under `infra/` watches
  `kubectl get jobs`' exit status for `clickhouse-backup`. This runbook documents that gap;
  it does not add the alarm — see the Gaps table.

---

<a id="korean"></a>

# 한국어

## 개요
`clickhouse-backup` CronJob(`infra/clickhouse.tf`의 `kubernetes_cron_job_v1.backup`)이
`0 18 * * *`(UTC) = 03:00 KST 매일 `BACKUP DATABASE claude_code TO S3(...)`를 실행하여
(`infra/clickhouse.tf:360`) ClickHouse 버킷의 `backup/` prefix 아래에 하루치 자기완결적
아카이브 객체를 씁니다 — 파드의 IRSA 자격증명을 그대로 쓰므로 백업 자체를 위해 따로 관리할
비밀값은 없습니다. `infra/s3.tf`의 `expire-backups` 라이프사이클 규칙이 같은 `backup/`
prefix 아래 객체를 **30일** 뒤 만료시킵니다(`infra/s3.tf:16-17`:
`filter { prefix = "backup/" }`, `expiration { days = 30 }`). 이 런북은 그 두 사실이
운영상 무엇을 의미하는지 정리하고, 복구 절차는 새로 쓰지 않고 기존 문서를 가리키며,
분기별 복구 드릴 체크리스트를 제공합니다 — 이 프로젝트가 아직 갖고 있지 않은 숫자
하나를 포함해서.

## 사용 시점
- 감사, 워크샵 계정 삭제, 또는 사고 사후 분석에서 백업 커버리지를 근거로 삼기 전 —
  현재 시점에 정확히 얼마의 데이터 손실 노출이 있는지 확인할 때.
- 분기마다, 아래 복구 드릴을 실행할 때.
- `infra/clickhouse.tf`의 백업 CronJob이나 `infra/s3.tf`의 라이프사이클 규칙이 바뀐 뒤,
  여기 인용된 스케줄/보존 사실이 실제 적용된 인프라와 여전히 일치하는지 재확인할 때.

## 사전 요구 사항
- `claude-code` 네임스페이스에 대한 `kubectl` 접근 — [`incident-response.md`](incident-response.md)와
  같은 패턴.
- ClickHouse 클러스터 내부가 아니라 S3에서 직접 백업 객체를 확인하려면 ClickHouse
  버킷(`cc-ab-clickhouse-<account-id>-<region>`)에 대한 읽기 권한.
- 드릴용 scratch ClickHouse 타깃(아래 Option A 또는 Option B) —
  [`archive-clickhouse.md`](archive-clickhouse.md#3-restore-rehearsal-recommended-while-the-workshop-account-is-still-alive) 참고.

## 절차

### 1. 존재하는 백업 확인
```bash
aws s3 ls --recursive s3://cc-ab-clickhouse-<account-id>-<region>/backup/
```
매일 실행마다 `backup/<UTC date>_<HHMMSS>`에 자기완결적 객체 하나가 생성됩니다(`.backup`
매니페스트 + `data/claude_code/<table>/...` part들) — 하나를 복구하는 데 같은 prefix의
다른 객체나 계정 밖의 무언가가 필요하지 않습니다.

### 2. 복구 — 새로 쓰지 않고 가리키기
복구 절차 — Option A(매칭되는 replicated infra)와 Option B(non-replicated 엔진의 단일
노드, `PARTITION BY`/`ORDER BY`가 원본과 정확히 일치하지 않으면 `RESTORE`가
`CORRUPTED_DATA`로 실패)는 이미
[`archive-clickhouse.md`](archive-clickhouse.md#3-restore-rehearsal-recommended-while-the-workshop-account-is-still-alive)의
`### 3. Restore rehearsal`에 적혀 있습니다. (사전 계정 삭제용 아카이브가 아니라) 일별
백업을 복구할 때의 유일한 운영상 차이는 `RESTORE DATABASE ... FROM S3(...)`의 URL이
아카이브 버킷의 `<archive-prefix>/backup/final-<timestamp>` 객체가 아니라 이 prefix의
일별 `backup/<date>_<HHMMSS>` 객체를 가리킨다는 점뿐입니다 — Option B의 테이블 선-생성
단계를 포함해 그 섹션의 나머지는 그대로 적용됩니다. `RESTORE` 문을 여기서 다시 만들지
말고 그 섹션을 따르세요.

### 3. 분기별 복구 드릴
이미 뭔가 고장났을 때만이 아니라 일정한 주기로 실행합니다 — 이 프로젝트의 RTO가 추정이
아니라 실측되는 유일한 방법입니다.

1. 1단계에서 최근 일별 백업 객체를 하나 고릅니다.
2. **같은 클러스터의 throwaway 데이터베이스 이름**으로 복구합니다 — 예:
   `claude_code_drill_<date>` — 절대 `claude_code` 위에 복구하지 않습니다.
   `archive-clickhouse.md` §3의 Option A/B 선-생성 절차와
   `RESTORE DATABASE ... AS claude_code_drill_<date> FROM S3(...)` 패턴을 throwaway
   이름으로 바꿔 사용합니다.
3. 더 이상 활발히 쓰이지 않는 **같은 하루 구간**에 대해 `claude_code_drill_<date>`와
   `claude_code` 사이의 테이블별 `count()`를 비교합니다(`archive-clickhouse.md`가 남긴
   주의사항과 동일하게, `AggregatingMergeTree`의 행 수는 안정된 구간 밖에서는 백그라운드
   머지만으로도 달라질 수 있습니다).
4. throwaway 데이터베이스를 삭제합니다: `DROP DATABASE claude_code_drill_<date>`.
5. "복구 시작"부터 "카운트 검증 완료"까지의 wall-clock 시간을 기록합니다 — **이것이
   RTO를 마침내 실측하는 값입니다.** 날짜, 복구한 백업 객체, 걸린 시간, 성공/실패 여부를
   이 런북의 참고 섹션(또는 이 프로젝트가 나중에 도입할 사고 대응 로그)에 적어 다음
   드릴이 비교할 추세를 남깁니다.

## 검증
비교 대상인 하루 구간에 대해 throwaway 데이터베이스의 모든 테이블 `count()`가
`claude_code`와 일치하고, throwaway 데이터베이스가 삭제되면 드릴은 성공입니다. 집계
테이블에서의 불일치는 곧바로 백업 결함을 뜻하지 않습니다 — 3단계의 백그라운드 머지
주의사항 참고 — 그러나 닫힌 구간에 대한 `otel_logs`나 `otel_metrics_sum`(둘 다 집계 없는
일반 `MergeTree` 계열)의 불일치는 결함입니다.

## 롤백
throwaway 데이터베이스로의 복구는 되돌릴 것이 없습니다 — `claude_code`를 전혀 건드리지
않습니다. 이 절차에서 유일하게 파괴적인 단계는 마지막 `DROP DATABASE`이며, 항상 throwaway
드릴 데이터베이스만 지정해야 하고 절대 `claude_code`를 지정해서는 안 됩니다.

## 갭
아래 표는 이 문서가 스스로 닫을 수 있는 할 일 목록이 아니라 현황 진술입니다 — 각 행은
먼저 다른 누군가의 결정이 필요한 사안을 가리킵니다.

| 갭 | 왜 열려 있는가 | 무엇이 풀어주는가 |
|---|---|---|
| 백업 CronJob 실패 시 알림 없음 | 이 프로젝트에는 아직 결정된 알림 채널이 없다 | 알림 채널 결정 |
| 백업 버킷의 크로스 리전 복제 없음 | 기술적 문제가 아니라 비용 결정이다 | 비용 결정 |
| RTO 미측정 | 복구 드릴이 아직 실행된 적이 없다 | 첫 분기별 드릴(위 §3) |

## 참고
- RPO는 **24시간**이며, 일별 백업 스케줄(`infra/clickhouse.tf:360`)에서 유도됩니다 —
  두 번째 사이트로의 지속적인 복제나 WAL 전송이 없으므로, 두 백업 사이에 클러스터를
  잃으면 최대 하루치 쓰기가 손실될 수 있습니다.
- RTO는 **미측정**입니다. 데이터 용량이나 클러스터 크기에서 유도한 추정값으로 대체하지
  마세요 — 위 분기별 드릴이 이를 실제 숫자로 바꾸는 유일한 수단입니다.
- 오늘 시점에는 백업 CronJob 실행이 실패해도 아무 알람도 울리지 않습니다 —
  `infra/` 아래 어떤 것도 `clickhouse-backup`의 `kubectl get jobs` 종료 상태를 감시하지
  않습니다. 이 런북은 그 갭을 문서화할 뿐 알람을 추가하지 않습니다 — 위 갭 표 참고.
