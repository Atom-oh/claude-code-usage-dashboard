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
(`clickhouse-backup` CronJob) to `Disk('cold_s3', 'backup/YYYY-MM-DD')`. Restore with the
`otel_writer` account:
```sql
RESTORE DATABASE claude_code FROM Disk('cold_s3', 'backup/YYYY-MM-DD')
```
Restoring overwrites current data — confirm the backup date covers what you need first.

## Notes
- Last verified: 2026-07-09
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
`Disk('cold_s3', 'backup/YYYY-MM-DD')`로 백업합니다. `otel_writer` 계정으로 복원합니다:
```sql
RESTORE DATABASE claude_code FROM Disk('cold_s3', 'backup/YYYY-MM-DD')
```
복원은 현재 데이터를 덮어씁니다 — 백업 날짜가 필요한 범위를 포함하는지 먼저 확인합니다.

## 참고
- 최종 검증일: 2026-07-09
- 2026-07-07 텔레메트리 공백(15시간+)은 `max(TimeUnix)` 직접 조회로만 발견됐습니다 —
  대시보드는 오래된 데이터로도 정상 렌더링됩니다. 항상 데이터부터 확인하세요.
