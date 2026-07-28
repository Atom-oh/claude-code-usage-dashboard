# Runbook: Incident Response

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

---

<a id="english"></a>

# English

## Overview
Diagnose and recover from the four incident classes this system actually has: dashboard
outage, telemetry stopped flowing, ClickHouse cluster degradation, and wrong-looking data.
Start at Triage and follow the matching scenario — do not skip triage, the symptoms overlap.

## When to Use
- Dashboard at `ccdash.atomai.click` returns errors or stale data
- Charts flatline even though workshop participants are actively using Claude Code
- Numbers look implausible (costs or token counts inflated 10-100x, users in the wrong group)
- ClickHouse alerts: pod restarts, disk pressure, replication errors

## Prerequisites
- `kubectl` context `fsi-demo-cluster` configured, access to namespace `claude-code`
- For telemetry incidents: SSH/SSM access to participant EC2 instances (the OTel Collector
  runs there as a systemd sidecar, not in the cluster)
- For data queries: read access pattern from `.claude/skills/clickhouse-investigate/SKILL.md`
  (port-forward `svc/clickhouse-cc-ab` + `otel_reader` credentials from Secret `clickhouse-reader`)

## Procedure

### 1. Triage
```bash
kubectl --context fsi-demo-cluster -n claude-code get pods
kubectl --context fsi-demo-cluster -n claude-code get events --sort-by=.lastTimestamp | tail -20
```
Decide the scenario:
- Dashboard pods not `Running`/`Ready`, or `/healthz` failing -> Scenario 2
- Pods healthy but charts flatline after a point in time -> Scenario 3
- ClickHouse (`chi-cc-ab-*`) or Keeper (`chk-keeper-keeper-*`) pods unhealthy -> Scenario 4
- Everything green but numbers look wrong -> Scenario 5

### 2. Dashboard down
```bash
kubectl --context fsi-demo-cluster -n claude-code logs deployment/dashboard --tail=50
kubectl --context fsi-demo-cluster -n claude-code port-forward deployment/dashboard 8080:8080 &
curl -s http://localhost:8080/healthz
```
- Stack traces mentioning ClickHouse/ECONNREFUSED: the dashboard is up but ClickHouse is not —
  go to Scenario 4.
- Crash after a recent deploy: roll back (see Rollback). The deploy history is in
  `docs/runbooks/deploy-production.md`.
- `ImagePullBackOff`: the image tag set by the last deploy does not exist in ECR — re-run the
  deploy runbook Step 2-3 with a valid tag.

### 3. Telemetry stopped flowing
First confirm from the data, not the dashboard (measured incident 2026-07-07: 15+ hour gap
went unnoticed because the dashboard itself was healthy):
```bash
kubectl --context fsi-demo-cluster -n claude-code port-forward svc/clickhouse-cc-ab 8123:8123 &
CH_PW=$(kubectl --context fsi-demo-cluster -n claude-code get secret clickhouse-reader \
  -o jsonpath='{.data.CH_PASSWORD}' | base64 -d)
curl -s "http://localhost:8123/?user=otel_reader&password=$CH_PW&database=claude_code" \
  --data-binary "SELECT max(TimeUnix) AS last_metric, now() - max(TimeUnix) AS gap_seconds FROM otel_metrics_sum"
unset CH_PW; kill %1
```
If `gap_seconds` is large (hours), the pipeline is down. The collector is an **EC2-local
systemd sidecar on each participant instance** (`user-data.sh`), not a cluster workload:
```bash
# On the participant EC2 instance (SSH or SSM session):
systemctl status otelcol
journalctl -u otelcol --since "-2 hours" --no-pager | tail -40
```
Common causes, in measured order of likelihood:
1. `otelcol` service dead after instance reboot or OOM -> `systemctl restart otelcol`
2. Wrong/rotated `CH_PASSWORD` in `/etc/otelcol/env` (writer Secret changed via Terraform) ->
   fix the env file, restart
3. Network path to ClickHouse broken — `otel_writer` is IP-allowlisted to `10.0.0.0/8` in
   `infra/clickhouse.tf`; instances outside that CIDR are silently rejected
4. Claude Code client itself not exporting — check `/etc/claude-code/managed-settings.json`
   on the instance still sets the OTel env vars

### 4. ClickHouse cluster unhealthy
```bash
kubectl --context fsi-demo-cluster -n claude-code get pods -l clickhouse.altinity.com/chi=cc-ab
kubectl --context fsi-demo-cluster -n claude-code logs chi-cc-ab-replicated-0-0-0 --tail=50
kubectl --context fsi-demo-cluster -n claude-code exec chi-cc-ab-replicated-0-0-0 -- df -h /var/lib/clickhouse
```
- **One replica down**: the service keeps answering from the other replicas (3-replica
  ReplicatedMergeTree). Let the operator restart it; verify replication catches up:
  `SELECT * FROM system.replicas WHERE absolute_delay > 60` should return no rows.
- **Keeper quorum lost** (2+ of 3 `chk-keeper-keeper-*` pods down): tables go read-only, INSERTs from
  collectors fail. Restore Keeper pods first — ClickHouse recovers on its own once quorum is back.
- **Hot disk full** (100Gi gp3 PVC): TTL moves to the `cold` S3 volume should prevent this;
  if it happens, check `SELECT disk_name, sum(bytes_on_disk) FROM system.parts GROUP BY disk_name`
  and force a move: `ALTER TABLE otel_logs MATERIALIZE TTL`. Do NOT delete the PVC
  (`kubectl delete pvc` is deny-listed in `.claude/settings.json` for this reason).

### 5. Data looks wrong
- **Costs/tokens inflated 10-100x**: almost always a query that does raw `sum(Value)` on
  `otel_metrics_sum` — values are cumulative per-session counters. Check the offending query
  against `incFlat`/`incBucketed` in `dashboard/server/queries.js` (the comment above
  `incFlat` documents the measured failure).
- **Users in the wrong bedrock/enterprise group**: grouping is session-scoped and heuristic —
  see `dashboard/server/grouping.js` for the rules and known edge cases before assuming a bug.
- **Data missing for a recent window only**: that is Scenario 3, not a query bug.

## Verification
- [ ] `kubectl get pods -n claude-code` all `Running`/`Ready`
- [ ] `/healthz` returns `{"ok": true}`
- [ ] `max(TimeUnix)` gap under 10 minutes while participants are active
- [ ] `system.replicas` shows no `absolute_delay > 60`
- [ ] Dashboard charts show current-hour data

## Rollback
Application rollback (bad deploy):
```bash
kubectl --context fsi-demo-cluster -n claude-code rollout undo deployment/dashboard
kubectl --context fsi-demo-cluster -n claude-code rollout status deployment/dashboard
```
Data recovery (last resort — corrupted/dropped tables): daily backups run at 03:00 KST
(`clickhouse-backup` CronJob) to `S3('https://<bucket>.s3.<region>.amazonaws.com/backup/<UTC
date>_<HHMMSS>')` (same bucket, IRSA credentials — no extra params needed from inside the
cluster; the timestamp includes time-of-day so a same-day retry doesn't collide with an
existing backup — find the exact path with `aws s3 ls s3://<bucket>/backup/`).

This cluster is **3-replica ReplicatedMergeTree** (`infra/clickhouse.tf`:
`shardsCount = 1, replicasCount = 3`) with **literal Keeper paths** that don't include the
database name (`/clickhouse/tables/{shard}/otel_metrics_sum`,
`infra/files/clickhouse-schema-replicated.sql`). Two things that look like they'd work do not,
verified live on a scratch replicated table (2026-07-27):

- **`RESTORE` does not overwrite existing non-empty tables** — it fails with
  `CANNOT_RESTORE_TABLE` if the target already has data, so you can't just point `RESTORE` at
  the corrupted database as-is.
- **Dropping and restoring on one replica alone does not restore anything.** `DROP DATABASE
  claude_code SYNC` without `ON CLUSTER` only drops the table on the node you're connected to —
  the other 2 replicas and their Keeper registration are untouched. Recreating the table there
  (which is what `RESTORE` does, using the replicated engine from the backup's embedded DDL)
  just re-registers it as a replica of the *same* Keeper path and it immediately re-syncs
  whatever the other 2 replicas already have — the (possibly still-corrupted) live data, not
  the backup. Restoring into a differently-named database (`RESTORE DATABASE claude_code AS
  claude_code_restore`) doesn't avoid this either, since the Keeper path has no database-name
  component — it collides with the live table's path exactly the same way and fails with
  `REPLICA_ALREADY_EXISTS`.

The verified working procedure drops the database **cluster-wide** first, so there is no live
replica left to resync from, then restores it **cluster-wide** so all 3 replicas end up
populated from the backup, not just the one you're connected to:
```sql
DROP DATABASE claude_code ON CLUSTER 'replicated' SYNC;
RESTORE DATABASE claude_code ON CLUSTER 'replicated' FROM S3('https://<bucket>.s3.<region>.amazonaws.com/backup/<UTC-date>_<HHMMSS>');
```
This drops and restores every table in the database — there is no verified way to recover a
single table in place on this replicated setup without restoring the whole database; if you
need finer granularity, treat it as a research task before relying on it, not something to
improvise during an incident.

Confirm the backup date covers what you need first — this is a last resort, not a rollback:
`DROP DATABASE ... SYNC` is irreversible except by restoring from a backup, and the pre-drop
data is gone once you run it. The 30-day lifecycle on `backup/` (`infra/s3.tf`) means dates
older than that are gone — for anything further back, see the permanent archive below.

Permanent archive before account teardown (e.g. workshop ending): see
[`archive-clickhouse.md`](archive-clickhouse.md).

## Notes
- Last verified: 2026-07-09 for Scenarios 1-5 above. The data-recovery `DROP DATABASE ...
  ON CLUSTER ... SYNC` + `RESTORE DATABASE ... ON CLUSTER ... FROM S3(...)` procedure was
  verified live end-to-end on 2026-07-27, on a scratch 3-replica `ReplicatedMergeTree` table
  (not `claude_code` itself) matching the real schema's Keeper-path shape — confirmed data
  present and consistent on all 3 replicas after restore. Earlier drafts of this procedure
  (drop without `ON CLUSTER`, restore into a differently-named database) were tried first and
  confirmed broken the same way, which is why this runbook no longer offers those as options.
- The 2026-07-07 telemetry gap (15+ hours) was found only by querying `max(TimeUnix)`
  directly — the dashboard rendered fine on stale data. Check the data first, always.

---

<a id="korean"></a>

# 한국어

## 개요
이 시스템에서 실제로 발생하는 4가지 장애 유형 — 대시보드 중단, 텔레메트리 유입 중단,
ClickHouse 클러스터 이상, 데이터 이상치 — 를 진단하고 복구합니다. 증상이 겹치므로 반드시
Triage부터 시작해 해당 시나리오를 따라갑니다.

## 사용 시점
- `ccdash.atomai.click` 대시보드가 오류를 반환하거나 오래된 데이터를 표시할 때
- 워크숍 참가자가 Claude Code를 활발히 쓰는데 차트가 평평해질 때
- 수치가 비정상일 때 (비용/토큰이 10-100배 부풀거나, 사용자가 잘못된 그룹에 표시)
- ClickHouse 경보: 파드 재시작, 디스크 압박, 복제 오류

## 사전 요구 사항
- `kubectl` context `fsi-demo-cluster` 설정, `claude-code` 네임스페이스 접근 권한
- 텔레메트리 장애 시: 참가자 EC2 인스턴스 SSH/SSM 접근 (OTel Collector는 클러스터가 아니라
  EC2의 systemd 사이드카로 동작)
- 데이터 조회 시: `.claude/skills/clickhouse-investigate/SKILL.md`의 읽기 전용 접속 패턴
  (`svc/clickhouse-cc-ab` port-forward + Secret `clickhouse-reader`의 `otel_reader` 자격증명)

## 절차

### 1. Triage
```bash
kubectl --context fsi-demo-cluster -n claude-code get pods
kubectl --context fsi-demo-cluster -n claude-code get events --sort-by=.lastTimestamp | tail -20
```
시나리오를 판별합니다:
- 대시보드 파드가 `Running`/`Ready`가 아니거나 `/healthz` 실패 -> 시나리오 2
- 파드는 정상인데 특정 시점 이후 차트가 평평함 -> 시나리오 3
- ClickHouse(`chi-cc-ab-*`) 또는 Keeper(`chk-keeper-keeper-*`) 파드 이상 -> 시나리오 4
- 전부 정상인데 수치가 이상함 -> 시나리오 5

### 2. 대시보드 중단
```bash
kubectl --context fsi-demo-cluster -n claude-code logs deployment/dashboard --tail=50
kubectl --context fsi-demo-cluster -n claude-code port-forward deployment/dashboard 8080:8080 &
curl -s http://localhost:8080/healthz
```
- ClickHouse/ECONNREFUSED 스택 트레이스: 대시보드는 살아있고 ClickHouse가 문제 —
  시나리오 4로 이동합니다.
- 최근 배포 직후 크래시: 롤백합니다(아래 롤백 참고). 배포 절차는
  `docs/runbooks/deploy-production.md`에 있습니다.
- `ImagePullBackOff`: 마지막 배포가 지정한 이미지 태그가 ECR에 없음 — 유효한 태그로 배포
  런북 2-3단계를 재실행합니다.

### 3. 텔레메트리 유입 중단
대시보드가 아니라 데이터로 먼저 확인합니다 (실측 장애 2026-07-07: 대시보드 자체는 정상이라
15시간 이상의 공백을 늦게 발견):
```bash
kubectl --context fsi-demo-cluster -n claude-code port-forward svc/clickhouse-cc-ab 8123:8123 &
CH_PW=$(kubectl --context fsi-demo-cluster -n claude-code get secret clickhouse-reader \
  -o jsonpath='{.data.CH_PASSWORD}' | base64 -d)
curl -s "http://localhost:8123/?user=otel_reader&password=$CH_PW&database=claude_code" \
  --data-binary "SELECT max(TimeUnix) AS last_metric, now() - max(TimeUnix) AS gap_seconds FROM otel_metrics_sum"
unset CH_PW; kill %1
```
`gap_seconds`가 크면(수 시간) 파이프라인이 중단된 상태입니다. Collector는 클러스터 워크로드가
아니라 **각 참가자 EC2 인스턴스의 로컬 systemd 사이드카**입니다(`user-data.sh`):
```bash
# 참가자 EC2 인스턴스에서 (SSH 또는 SSM 세션):
systemctl status otelcol
journalctl -u otelcol --since "-2 hours" --no-pager | tail -40
```
실측 기준 발생 빈도 순 원인:
1. 인스턴스 재부팅/OOM 후 `otelcol` 서비스 중단 -> `systemctl restart otelcol`
2. `/etc/otelcol/env`의 `CH_PASSWORD` 불일치 (Terraform으로 writer Secret 교체됨) ->
   env 파일 수정 후 재시작
3. ClickHouse 네트워크 경로 단절 — `otel_writer`는 `infra/clickhouse.tf`에서 `10.0.0.0/8`로
   IP 제한되어 있어, 해당 CIDR 밖 인스턴스는 조용히 거부됩니다
4. Claude Code 클라이언트 자체가 export를 안 함 — 인스턴스의
   `/etc/claude-code/managed-settings.json`에 OTel env 변수가 유지되는지 확인합니다

### 4. ClickHouse 클러스터 이상
```bash
kubectl --context fsi-demo-cluster -n claude-code get pods -l clickhouse.altinity.com/chi=cc-ab
kubectl --context fsi-demo-cluster -n claude-code logs chi-cc-ab-replicated-0-0-0 --tail=50
kubectl --context fsi-demo-cluster -n claude-code exec chi-cc-ab-replicated-0-0-0 -- df -h /var/lib/clickhouse
```
- **레플리카 1개 다운**: 나머지 레플리카들이 서비스를 계속 처리합니다(3-레플리카
  ReplicatedMergeTree). 오퍼레이터가 재시작하도록 두고, 복제 추격을 확인합니다:
  `SELECT * FROM system.replicas WHERE absolute_delay > 60`이 0행이어야 합니다.
- **Keeper 쿼럼 상실** (`chk-keeper-keeper-*` 3개 중 2개 이상 다운): 테이블이 읽기 전용이 되고
  Collector의 INSERT가 실패합니다. Keeper 파드 복구가 우선 — 쿼럼이 돌아오면 ClickHouse는
  스스로 복구됩니다.
- **핫 디스크 가득 참** (100Gi gp3 PVC): TTL이 `cold` S3 볼륨으로 이동시키므로 정상적으로는
  발생하지 않습니다. 발생 시 `SELECT disk_name, sum(bytes_on_disk) FROM system.parts GROUP BY disk_name`
  확인 후 강제 이동: `ALTER TABLE otel_logs MATERIALIZE TTL`. PVC는 절대 삭제하지 않습니다
  (`kubectl delete pvc`는 이 이유로 `.claude/settings.json` deny 목록에 있음).

### 5. 데이터 이상치
- **비용/토큰 10-100배 부풀림**: 거의 항상 `otel_metrics_sum`에 raw `sum(Value)`를 쓴 쿼리가
  원인 — 값은 세션별 누적 카운터입니다. 해당 쿼리를 `dashboard/server/queries.js`의
  `incFlat`/`incBucketed`와 대조합니다 (`incFlat` 위 주석에 실측 실패 사례가 기록됨).
- **bedrock/enterprise 그룹 오분류**: 그루핑은 세션 단위 휴리스틱입니다 — 버그로 단정하기 전에
  `dashboard/server/grouping.js`의 규칙과 알려진 엣지 케이스를 확인합니다.
- **최근 구간만 데이터 없음**: 쿼리 버그가 아니라 시나리오 3입니다.

## 검증
- [ ] `kubectl get pods -n claude-code` 전체 `Running`/`Ready`
- [ ] `/healthz`가 `{"ok": true}` 응답
- [ ] 참가자 활동 중 `max(TimeUnix)` 공백 10분 미만
- [ ] `system.replicas`에 `absolute_delay > 60` 없음
- [ ] 대시보드 차트에 현재 시간대 데이터 표시

## 롤백
애플리케이션 롤백 (잘못된 배포):
```bash
kubectl --context fsi-demo-cluster -n claude-code rollout undo deployment/dashboard
kubectl --context fsi-demo-cluster -n claude-code rollout status deployment/dashboard
```
데이터 복구 (최후 수단 — 테이블 손상/삭제 시): 매일 03:00 KST에 `clickhouse-backup` CronJob이
`S3('https://<버킷>.s3.<리전>.amazonaws.com/backup/<UTC날짜>_<HHMMSS>')`로 백업합니다(같은
버킷, IRSA 자격증명 — 클러스터 안에서는 추가 파라미터 불필요. 시각까지 넣은 건 같은 날
재시도 시 기존 백업과 경로가 겹치지 않게 하기 위함 — 정확한 경로는
`aws s3 ls s3://<버킷>/backup/`로 확인).

이 클러스터는 **3-replica ReplicatedMergeTree**(`infra/clickhouse.tf`의
`shardsCount = 1, replicasCount = 3`)이고, Keeper 경로가 **데이터베이스명을 포함하지 않는
literal 경로**입니다(`/clickhouse/tables/{shard}/otel_metrics_sum`,
`infra/files/clickhouse-schema-replicated.sql`). 될 것처럼 보이지만 안 되는 방법 두 가지를
스크래치 replicated 테이블로 직접 실측했습니다(2026-07-27):

- **`RESTORE`는 이미 데이터가 있는 테이블을 덮어쓰지 않습니다** — 대상에 데이터가 있으면
  `CANNOT_RESTORE_TABLE`로 실패하므로, 손상된 데이터베이스를 그대로 두고 `RESTORE`만
  돌릴 수는 없습니다.
- **한 레플리카에서만 지우고 복원해도 아무것도 복구되지 않습니다.** `ON CLUSTER` 없이
  `DROP DATABASE claude_code SYNC`를 실행하면 접속한 노드에서만 테이블이 지워집니다 — 다른
  2개 레플리카와 그 Keeper 등록 정보는 그대로 남습니다. 그 노드에 테이블을 다시
  만들면(`RESTORE`가 백업에 캡처된 replicated 엔진으로 정확히 이렇게 합니다) 같은 Keeper
  경로의 레플리카로 재등록될 뿐이라, 즉시 다른 2개 레플리카가 이미 갖고 있던 데이터로
  동기화됩니다 — 손상돼 있었다면 백업이 아니라 그 손상된 데이터가 돌아옵니다. 다른 이름의
  데이터베이스로 복원해도(`RESTORE DATABASE claude_code AS claude_code_restore`) 마찬가지로
  피할 수 없습니다 — Keeper 경로에 데이터베이스명이 없으므로 살아있는 테이블의 경로와
  똑같이 충돌해 `REPLICA_ALREADY_EXISTS`로 실패합니다.

실측으로 검증된 절차는 먼저 **클러스터 전체에서** 데이터베이스를 지워 되돌아 동기화할
레플리카를 없앤 뒤, **클러스터 전체를 대상으로** 복원해 3개 레플리카 모두 백업 데이터로
채워지게 합니다(접속한 노드 하나만이 아니라):
```sql
DROP DATABASE claude_code ON CLUSTER 'replicated' SYNC;
RESTORE DATABASE claude_code ON CLUSTER 'replicated' FROM S3('https://<버킷>.s3.<리전>.amazonaws.com/backup/<UTC날짜>_<HHMMSS>');
```
이 방식은 데이터베이스 안의 모든 테이블을 지우고 복원합니다 — 이 replicated 구성에서 테이블
하나만 제자리에서 복구하는 검증된 방법은 없습니다. 더 세밀한 단위가 필요하다면 장애 대응
중에 즉석으로 시도하지 말고 사전에 별도로 검증하세요.

백업 날짜가 필요한 범위를 포함하는지 먼저 확인하세요 — 이건 최후 수단이지 롤백이 아닙니다:
`DROP DATABASE ... SYNC`는 백업에서 복원하는 것 외에는 되돌릴 수 없고, 실행하는 즉시 지우기
전 데이터는 사라집니다. `backup/`의 30일 라이프사이클(`infra/s3.tf`)로 그보다 오래된 날짜는
이미 사라졌습니다 — 더 과거가 필요하면 아래 영구 아카이브를 참조하세요.

계정 삭제(워크샵 종료 등) 전 영구 아카이브는 [`archive-clickhouse.md`](archive-clickhouse.md) 참조.

## 참고
- 최종 검증일: 위 시나리오 1-5는 2026-07-09. 데이터 복구 절의
  `DROP DATABASE ... ON CLUSTER ... SYNC` + `RESTORE DATABASE ... ON CLUSTER ... FROM S3(...)`
  절차는 2026-07-27, 실제 스키마의 Keeper 경로 형태를 그대로 흉내낸 스크래치 3-replica
  `ReplicatedMergeTree` 테이블로(`claude_code` 자체가 아니라) 종단까지 실측
  검증했습니다 — 복원 후 3개 레플리카 모두에 데이터가 일치함을 확인했습니다. 이 절차의
  이전 버전(`ON CLUSTER` 없는 drop, 다른 이름 데이터베이스로 복원)은 먼저 시도했다가 같은
  방식으로 실패함을 확인하고 제외했습니다 — 그래서 이 런북은 그 방법들을 더 이상 옵션으로
  제시하지 않습니다.
- 2026-07-07 텔레메트리 공백(15시간+)은 `max(TimeUnix)` 직접 조회로만 발견됐습니다 —
  대시보드는 오래된 데이터로도 정상 렌더링됩니다. 항상 데이터부터 확인하세요.
