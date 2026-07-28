# Runbook: Deploy the Dashboard to Production (EKS)

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

---

<a id="english"></a>

# English

## Overview
Build the dashboard's Docker image and roll it out to the `fsi-demo-cluster` EKS cluster.
Deploys are image-based, not commit-based: the image reflects whatever is in the working
tree at build time, so the checked-out branch/commit matters.

## When to Use
- After merging a PR that changes `dashboard/server` or `dashboard/web`
- After a Terraform change to `infra/dashboard.tf` that needs a new rollout to take effect

## Prerequisites
- `kubectl` context `fsi-demo-cluster` configured, access to namespace `claude-code`
- `aws` CLI authenticated with ECR push access to `180294183052.dkr.ecr.ap-northeast-2.amazonaws.com`
- `docker buildx` with `linux/arm64` support (the nodepool is Graviton)
- Server tests pass and the web build succeeds locally first (see `/test-all`)
- Bedrock model access for `var.chat_model_id` enabled in `var.bedrock_region` (independent of
  `var.region`; default `ap-northeast-2` in this admin environment — set to `us-west-2` when
  porting the built image to the workshop account) — see `docs/workshop-studio-notes.md` §5, "Ask
  Claude 챗(Bedrock) 배포 전제"

## Procedure

### 1. Confirm what you're deploying
```bash
git status
git branch --show-current
git log -1 --oneline
```
Deploys build from the working tree — confirm you're on the intended branch/commit before
building. If you have unrelated uncommitted work, `git stash` it first.

### 2. Build and push the image
```bash
TAG=$(date -u +%Y%m%d-%H%M%S)
aws ecr get-login-password --region ap-northeast-2 \
  | docker login --username AWS --password-stdin 180294183052.dkr.ecr.ap-northeast-2.amazonaws.com
docker buildx build --platform linux/arm64 \
  -t 180294183052.dkr.ecr.ap-northeast-2.amazonaws.com/cc-ab-dashboard:$TAG \
  -t 180294183052.dkr.ecr.ap-northeast-2.amazonaws.com/cc-ab-dashboard:latest \
  --push dashboard/
```

### 3. Roll out
```bash
kubectl --context fsi-demo-cluster -n claude-code set image deployment/dashboard \
  dashboard=180294183052.dkr.ecr.ap-northeast-2.amazonaws.com/cc-ab-dashboard:$TAG
kubectl --context fsi-demo-cluster -n claude-code rollout status deployment/dashboard --timeout=120s
```

## Verification
- [ ] `kubectl get pods -l app=dashboard` shows 2/2 `Running` on the new ReplicaSet
- [ ] `kubectl get deployment dashboard -o jsonpath='{.spec.template.spec.containers[0].image}'` matches `$TAG`
- [ ] Pod logs show `dashboard listening on :8080` with no stack traces
- [ ] `/healthz` returns `{"ok": true}` (via port-forward if not publicly reachable)

## Rollback
```bash
kubectl --context fsi-demo-cluster -n claude-code rollout undo deployment/dashboard
kubectl --context fsi-demo-cluster -n claude-code rollout status deployment/dashboard
```
Or explicitly redeploy the previous known-good tag with Step 3 above.

## Notes
- Last verified: 2026-07-08
- If the pending `terraform apply` includes `infra/clickhouse.tf`'s ClickHouse backup
  destination change (`Disk('cold_s3', ...)` → `BACKUP TO S3(...)`), there's no ordering
  requirement against `scripts/archive-clickhouse.sh` — its own final-snapshot step doesn't
  depend on this Terraform change being applied. What the change does is make
  `infra/s3.tf`'s pre-existing 30-day lifecycle filter start actually matching daily backups
  going forward (previously it had nothing to match). Once applied, don't go more than 30 days
  without running `scripts/archive-clickhouse.sh` again, and always run it once more right
  before the workshop account is torn down — see
  [`archive-clickhouse.md`](archive-clickhouse.md#when-to-use).
- Local verification against the live ClickHouse cluster: port-forward
  `svc/clickhouse-cc-ab` (port 8123) and the reader credentials from k8s Secret
  `clickhouse-reader`, then run `dashboard/server` locally against it before deploying —
  this has caught query bugs that unit tests (which don't touch live ClickHouse) missed.
- **ClickHouse schema changes are a separate path from the image deploy.** Editing
  `infra/files/clickhouse-schema-replicated.sql` changes the `filemd5` in the schema-init Job's
  name, so `terraform apply` replaces and re-runs it. Terraform does **not** wait for it
  (`wait_for_completion = false`), so verify by hand:
  ```bash
  kubectl --context fsi-demo-cluster -n claude-code get jobs | grep clickhouse-schema-init
  kubectl --context fsi-demo-cluster -n claude-code wait --for=condition=complete \
    job/clickhouse-schema-init-<hash> --timeout=300s
  kubectl --context fsi-demo-cluster -n claude-code exec chi-cc-ab-replicated-0-0-0 -c clickhouse \
    -- clickhouse-client -q "SHOW CREATE TABLE claude_code.otel_metrics_sum_hourly"
  kubectl --context fsi-demo-cluster -n claude-code exec chi-cc-ab-replicated-0-0-0 -c clickhouse \
    -- clickhouse-client -q "SELECT table, command, is_done FROM system.mutations WHERE is_done = 0"
  ```
  The `SHOW CREATE TABLE` is the actual check — a Job that completed doesn't prove every
  statement applied (e.g. the rollup `TTL` clause was missing for weeks while the Job showed
  `Complete`, because the Job never re-ran after the file changed).

---

<a id="korean"></a>

# 한국어

## 개요
대시보드 Docker 이미지를 빌드해 `fsi-demo-cluster` EKS 클러스터에 롤아웃합니다. 배포는
커밋 기반이 아니라 이미지 기반입니다 — 빌드 시점의 워킹트리 상태가 그대로 이미지에 담기므로
체크아웃된 브랜치/커밋이 중요합니다.

## 사용 시점
- `dashboard/server` 또는 `dashboard/web`을 바꾸는 PR을 머지한 뒤
- `infra/dashboard.tf`의 Terraform 변경을 반영하려면 새 롤아웃이 필요할 때

## 사전 요구 사항
- `kubectl` context `fsi-demo-cluster` 설정, `claude-code` 네임스페이스 접근 권한
- `180294183052.dkr.ecr.ap-northeast-2.amazonaws.com`에 push 가능한 `aws` CLI 인증
- `linux/arm64`를 지원하는 `docker buildx`(노드풀이 Graviton)
- 로컬에서 서버 테스트 통과 및 웹 빌드 성공 확인(`/test-all` 참고)
- `var.bedrock_region`(`var.region`과 별개; 이 admin 환경 기본값은 `ap-northeast-2` — 빌드한
  이미지를 워크샵 계정으로 이식할 때 `us-west-2`로 바꿔서 apply) 계정에서 `var.chat_model_id`
  모델 access 활성화 — `docs/workshop-studio-notes.md` §5 "Ask Claude 챗(Bedrock) 배포 전제" 참고

## 절차

### 1. 배포 대상 확인
```bash
git status
git branch --show-current
git log -1 --oneline
```
배포는 워킹트리에서 빌드합니다 — 빌드 전에 의도한 브랜치/커밋인지 확인하세요. 관련 없는
커밋되지 않은 작업이 있으면 먼저 `git stash`.

### 2. 이미지 빌드·푸시
```bash
TAG=$(date -u +%Y%m%d-%H%M%S)
aws ecr get-login-password --region ap-northeast-2 \
  | docker login --username AWS --password-stdin 180294183052.dkr.ecr.ap-northeast-2.amazonaws.com
docker buildx build --platform linux/arm64 \
  -t 180294183052.dkr.ecr.ap-northeast-2.amazonaws.com/cc-ab-dashboard:$TAG \
  -t 180294183052.dkr.ecr.ap-northeast-2.amazonaws.com/cc-ab-dashboard:latest \
  --push dashboard/
```

### 3. 롤아웃
```bash
kubectl --context fsi-demo-cluster -n claude-code set image deployment/dashboard \
  dashboard=180294183052.dkr.ecr.ap-northeast-2.amazonaws.com/cc-ab-dashboard:$TAG
kubectl --context fsi-demo-cluster -n claude-code rollout status deployment/dashboard --timeout=120s
```

## 검증
- [ ] `kubectl get pods -l app=dashboard`가 새 ReplicaSet에서 2/2 `Running` 표시
- [ ] `kubectl get deployment dashboard -o jsonpath='{.spec.template.spec.containers[0].image}'`가 `$TAG`와 일치
- [ ] 파드 로그에 스택 트레이스 없이 `dashboard listening on :8080` 출력
- [ ] `/healthz`가 `{"ok": true}` 응답(외부 노출 안 됐으면 port-forward로 확인)

## 롤백
```bash
kubectl --context fsi-demo-cluster -n claude-code rollout undo deployment/dashboard
kubectl --context fsi-demo-cluster -n claude-code rollout status deployment/dashboard
```
또는 위 3단계로 이전에 확인된 정상 태그를 명시적으로 재배포합니다.

## 참고
- 최종 검증일: 2026-07-08
- 적용 대기 중인 `terraform apply`에 `infra/clickhouse.tf`의 ClickHouse 백업 목적지 변경
  (`Disk('cold_s3', ...)` → `BACKUP TO S3(...)`)이 포함되어 있어도
  `scripts/archive-clickhouse.sh`와의 순서 제약은 없습니다 — 그 스크립트의 최종 스냅샷
  단계는 이 Terraform 변경 적용 여부와 무관하게 동작합니다. 이 변경이 실제로 하는 일은
  `infra/s3.tf`에 이미 있던 30일 라이프사이클 필터가 이후의 일별 백업을 실제로 매칭하기
  시작하게 만드는 것입니다(이전엔 매칭 대상이 없었습니다). 적용한 뒤로는
  `scripts/archive-clickhouse.sh`를 30일 넘게 재실행하지 않고 방치하지 마세요, 그리고
  워크샵 계정을 삭제하기 직전에는 항상 한 번 더 실행하세요 —
  [`archive-clickhouse.md`](archive-clickhouse.md#사용-시점) 참조.
- 실 ClickHouse 클러스터 대상 로컬 검증: `svc/clickhouse-cc-ab`(8123 포트)를 port-forward하고
  k8s Secret `clickhouse-reader`의 리더 자격증명을 받아 `dashboard/server`를 로컬에서 그
  클러스터에 붙여 실행 — 실 ClickHouse에 안 붙는 유닛 테스트가 놓친 쿼리 버그를 이 방식으로
  여러 번 잡았습니다.
- **ClickHouse 스키마 변경은 이미지 배포와 별개 경로입니다.**
  `infra/files/clickhouse-schema-replicated.sql`를 수정하면 schema-init Job 이름의 `filemd5`가
  바뀌어 `terraform apply`가 Job을 교체·재실행합니다. terraform은 완료를 기다리지 않으므로
  (`wait_for_completion = false`) 직접 확인하세요:
  ```bash
  kubectl --context fsi-demo-cluster -n claude-code get jobs | grep clickhouse-schema-init
  kubectl --context fsi-demo-cluster -n claude-code wait --for=condition=complete \
    job/clickhouse-schema-init-<hash> --timeout=300s
  kubectl --context fsi-demo-cluster -n claude-code exec chi-cc-ab-replicated-0-0-0 -c clickhouse \
    -- clickhouse-client -q "SHOW CREATE TABLE claude_code.otel_metrics_sum_hourly"
  kubectl --context fsi-demo-cluster -n claude-code exec chi-cc-ab-replicated-0-0-0 -c clickhouse \
    -- clickhouse-client -q "SELECT table, command, is_done FROM system.mutations WHERE is_done = 0"
  ```
  실제 확인은 `SHOW CREATE TABLE`입니다 — Job이 Complete여도 모든 문장이 적용됐다는 보장은
  아닙니다(롤업 `TTL`이 수 주간 빠져 있었는데 Job은 계속 `Complete`였습니다. 파일이 바뀐 뒤에도
  Job이 재실행되지 않았기 때문입니다).
