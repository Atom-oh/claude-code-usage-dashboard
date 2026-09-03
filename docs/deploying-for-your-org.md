# Deploying This Dashboard for Your Organization

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

---

<a id="english"></a>

# English

## Overview
This is a walkthrough for standing up this dashboard for a new organization/cluster, built
entirely from commands that already exist in this repo's runbooks and README. Every command
below carries an inline citation to where it is copied from. If a step you expected is
missing, it is because no existing file states a command for it — this guide adds no new
procedure, flag, or environment variable of its own.

## 1. Prerequisites
- `infra/terraform.tfvars.example` exists in the repo and is the template for the variables
  you fill in below (`infra/terraform.tfvars.example`).
- `kubectl` and `aws` CLI, and `docker buildx` with `linux/arm64` support if you'll build the
  image yourself (`docs/runbooks/deploy-production.md` §"Prerequisites").
- `terraform` 1.x (`README.md` "Prerequisites").

## 2. Copy and fill the non-secret Terraform variables
```bash
cp infra/terraform.tfvars.example infra/terraform.tfvars
```
(see `infra/terraform.tfvars.example`, its own header comment). Fill in the five variables it
defines for your org: `eks_cluster_name`, `domain`, `dashboard_hostname`, `ch_ingest_hostname`,
and `dashboard_image_tag` (see step 5 below for why that last one can't be filled in yet).
`infra/terraform.tfvars.example` itself is not gitignored (its name ends in `.example`), but
the `terraform.tfvars` file you create from it is — do not commit it if it later picks up a
non-default value that shouldn't be shared (see `infra/terraform.tfvars.example`).

## 3. Provide the secret variables — names only
`infra/terraform.tfvars.example`'s header states that secret values are never written into
that file; they go in as `-var` flags or a separate, gitignored `secrets.auto.tfvars` (see
`infra/terraform.tfvars.example`). The variable **names** you need to provide a value for —
never print or commit the values themselves:
- `dashboard_basic_auth_password`
- `clickhouse_writer_password`
- `clickhouse_reader_password`
- `clickhouse_ingest_password`

## 4. The ClickHouse ingest password / SSM parameter invariant
The OTel collector on each workshop instance reads its ClickHouse password from the SSM
SecureString parameter `/claude-code/ab/clickhouse-ingest-password`. This parameter is
created **by an operator, out of band — not by Terraform**
(see `docs/runbooks/clickhouse-ingest-user-cutover.md` §2, "Create the SSM parameter out of
band"). The invariant to hold, stated without ever writing the value down: **the SSM
parameter's value must equal the `clickhouse_ingest_password` Terraform variable's value.**
If they diverge, the collector authenticates with the wrong password and ingestion fails.

`user-data.sh` is a cloud-init template, so a password rotation only takes effect for
**newly launched instances** — running instances keep using whatever password they booted
with until they are re-provisioned (see `docs/runbooks/clickhouse-ingest-user-cutover.md`
§4, "New instances only"). The instance profile needs `ssm:GetParameter` + `kms:Decrypt` on
that parameter (`user-data.sh:111`); the collector's on-disk retry queue directory is set by
`OTELCOL_QUEUE_DIR` (`user-data.sh:151`).

## 5. Build and push the first image (ECR is immutable)
`infra/terraform.tfvars.example`'s comment on `dashboard_image_tag` states that ECR is
`IMMUTABLE` here, so `latest` does not exist as a usable tag — `dashboard_image_tag` must be
a timestamp tag that has actually been pushed (see `infra/terraform.tfvars.example`). Build
and push it with the same steps `docs/runbooks/deploy-production.md` §2 uses:
```bash
TAG=$(date -u +%Y%m%d-%H%M%S)
aws ecr get-login-password --region ap-northeast-2 \
  | docker login --username AWS --password-stdin 180294183052.dkr.ecr.ap-northeast-2.amazonaws.com
docker buildx build --platform linux/arm64 \
  -t 180294183052.dkr.ecr.ap-northeast-2.amazonaws.com/cc-ab-dashboard:$TAG \
  --push dashboard/
```
(see `docs/runbooks/deploy-production.md` §2 — adjust the registry/repository to your own ECR
if you are not deploying into the same AWS account). Now go back and set
`dashboard_image_tag` in `infra/terraform.tfvars` to `$TAG`.

## 6. `terraform apply`
Apply with the secret variables from step 3 supplied via `-var`, following the same pattern
`docs/runbooks/clickhouse-ingest-user-cutover.md` §1 uses for one of them:
```bash
cd infra
terraform apply -var="clickhouse_ingest_password=<value>"
```
(see `docs/runbooks/clickhouse-ingest-user-cutover.md` §1). Supply the other three secret
variables (`dashboard_basic_auth_password`, `clickhouse_writer_password`,
`clickhouse_reader_password`) the same way, or via `secrets.auto.tfvars` (step 3).

## 7. Schema: new install vs. existing cluster
- **New install** — a `terraform apply` that provisions ClickHouse for the first time needs
  nothing beyond the Terraform schema-init Job itself; the Job applies
  `infra/files/clickhouse-schema-replicated.sql` and a fresh cluster is "at" the latest
  migration by definition once that file has run (see
  `docs/runbooks/schema-migrations.md` §"Procedure §4 — the rule for every future
  migration").
- **Existing cluster** — apply the next `clickhouse-migration-NNN.sql` by hand and verify the
  ledger, following `docs/runbooks/schema-migrations.md` end to end (see
  `docs/runbooks/schema-migrations.md` §"Procedure").

## 8. Roll out the collector
Run the OTel collector as a supervised systemd service, never as a foreground/`nohup`
process — `Restart=always` is what survives a crash, DNS blip, or reboot (see `README.md`
"Telemetry Ingestion"):
```bash
sudo tee /etc/systemd/system/otelcol.service <<'EOF'
[Unit]
Description=OpenTelemetry Collector (Claude Code -> ClickHouse)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=%i
ExecStart=/home/%i/.local/bin/otelcol-contrib --config=/home/%i/.otelcol/config.yaml
Environment=OTELCOL_QUEUE_DIR=/home/%i/.otelcol/queue
Restart=always
RestartSec=5
StandardOutput=append:/home/%i/.otelcol/collector.log
StandardError=append:/home/%i/.otelcol/collector.log

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now otelcol.service
```
(see `README.md` "Telemetry Ingestion"). Confirm it is actually writing:
```bash
systemctl status otelcol.service
journalctl -u otelcol -n 50   # or: tail -f ~/.otelcol/collector.log
```
(see `README.md` "Telemetry Ingestion").

## 9. Choosing the four org-level env values
These are `dashboard/server` env vars — decide them deliberately, not by leaving the default:

- **`GROUP_MODE`** — `ab` compares a bedrock/enterprise pair; `single` tells the SPA this org
  has one channel and suppresses the empty second card. **Any value other than `ab` or
  `single` fails the boot** (see `README.md` "Configuration"). Choose `ab` only if your org
  actually runs both auth paths side by side.
- **`DEFAULT_RANGE_DAYS`** — the default range when a request omits `from`, **and** the same
  window the server's cache warmer pre-computes (see `README.md` "Configuration"). This is
  not a free choice: raising it widens what the warmer keeps hot, at the cost of pre-warming
  a larger range on every boot.
- **`RANGE_CAP_DAYS`** — the longest range a request may ask for; a longer span is a 400, and
  it must be `>=` `DEFAULT_RANGE_DAYS` (see `README.md` "Configuration"). Set it to the
  longest range your org actually needs to look back, not larger than that.
- **`PII_MASK_ENABLED`** — masks user emails in `GET /api/config`'s `piiMask` and the chat
  sandbox's result rows; on only for `"1"`/`"true"`, case-insensitive (see `README.md`
  "Configuration"). Turn this on for any deployment reachable by more people than the data
  should be visible to on a shared screen.

## 10. Verification
Three checks, all read-only:
- `SELECT max(TimeUnix) FROM claude_code.otel_metrics_sum` — should advance close to `now()`
  (see `README.md` "Telemetry Ingestion").
- `GET /api/health/data` → **200**. This endpoint deliberately answers 503 for `stale` or
  `unknown` data by design, so 200 is the pass condition, not just "any response" (see
  `docs/api-reference.md` §"Health").
- `GET /readyz` → **200** (see `docs/api-reference.md` §"Health").

## 11. What this guide does not cover
The following are pending decisions for this project, not gaps in this guide. This guide
does not speculate about how or when they will be resolved:
- **Authentication beyond Basic Auth.**
- **Alerting** (e.g. on backup job failures or data staleness).
- **Licensing.**

---

<a id="korean"></a>

# 한국어

## 개요
이 문서는 새 조직/클러스터에 이 대시보드를 세우는 절차를 안내합니다. 전부 이 저장소의
런북과 README에 이미 있는 명령으로만 구성되어 있고, 아래 각 명령마다 어디서 가져왔는지
인라인으로 출처를 남깁니다. 기대한 단계가 빠져 있다면 그건 기존 파일 어디에도 그 명령이
없기 때문입니다 — 이 문서는 새로운 절차·플래그·환경변수를 스스로 만들지 않습니다.

## 1. 사전 요구 사항
- `infra/terraform.tfvars.example`가 저장소에 있고, 아래에서 채울 변수들의 템플릿입니다
  (`infra/terraform.tfvars.example`).
- `kubectl`과 `aws` CLI, 이미지를 직접 빌드한다면 `linux/arm64`를 지원하는
  `docker buildx`(`docs/runbooks/deploy-production.md` §"사전 요구 사항").
- `terraform` 1.x(`README.md` "사전 요구 사항").

## 2. 비밀값 아닌 Terraform 변수 복사·채우기
```bash
cp infra/terraform.tfvars.example infra/terraform.tfvars
```
(`infra/terraform.tfvars.example` 자신의 헤더 주석 참고). 이 파일이 정의하는 다섯 변수를
조직에 맞게 채웁니다: `eks_cluster_name`, `domain`, `dashboard_hostname`,
`ch_ingest_hostname`, `dashboard_image_tag`(마지막 값을 아직 채울 수 없는 이유는 아래 5단계
참고). `infra/terraform.tfvars.example` 자체는 gitignore 대상이 아닙니다(파일명이
`.example`로 끝나서), 하지만 여기서 만든 `terraform.tfvars`는 gitignore 대상입니다 — 나중에
공유하면 안 되는 값이 들어가더라도 커밋하지 마세요(`infra/terraform.tfvars.example`).

## 3. 비밀값 변수 제공 — 이름만
`infra/terraform.tfvars.example`의 헤더는 비밀값을 그 파일에 절대 적지 않는다고 명시합니다 —
`-var` 플래그나 별도의 gitignore된 `secrets.auto.tfvars`로 넘깁니다
(`infra/terraform.tfvars.example`). 값을 제공해야 하는 변수 **이름**만 — 값 자체는 절대
출력·커밋하지 않습니다:
- `dashboard_basic_auth_password`
- `clickhouse_writer_password`
- `clickhouse_reader_password`
- `clickhouse_ingest_password`

## 4. ClickHouse ingest 비밀번호 / SSM 파라미터 불변식
각 워크숍 인스턴스의 OTel 컬렉터는 ClickHouse 비밀번호를 SSM SecureString 파라미터
`/claude-code/ab/clickhouse-ingest-password`에서 읽습니다. 이 파라미터는 **운영자가 별도로
생성하며 — Terraform이 만들지 않습니다**
(`docs/runbooks/clickhouse-ingest-user-cutover.md` §2, "Create the SSM parameter out of
band" 참고). 값을 절대 적지 않고 지켜야 할 불변식만 명시합니다: **이 SSM 파라미터의 값은
`clickhouse_ingest_password` Terraform 변수의 값과 반드시 같아야 합니다.** 둘이 어긋나면
컬렉터가 잘못된 비밀번호로 인증을 시도해 인제스트가 실패합니다.

`user-data.sh`는 cloud-init 템플릿이므로 비밀번호를 교체해도 **새로 launch되는
인스턴스에만** 적용됩니다 — 이미 실행 중인 인스턴스는 재프로비저닝되기 전까지 부팅 시점의
비밀번호를 그대로 씁니다(`docs/runbooks/clickhouse-ingest-user-cutover.md` §4, "New
instances only" 참고). 인스턴스 프로파일은 이 파라미터에 대해 `ssm:GetParameter` +
`kms:Decrypt` 권한이 필요하고(`user-data.sh:111`), 컬렉터의 디스크 재시도 큐 디렉터리는
`OTELCOL_QUEUE_DIR`로 설정됩니다(`user-data.sh:151`).

## 5. 첫 이미지 빌드·푸시 (ECR은 IMMUTABLE)
`infra/terraform.tfvars.example`의 `dashboard_image_tag` 주석은 여기서 ECR이
`IMMUTABLE`이라 `latest`가 쓸 수 있는 태그로 존재하지 않는다고 명시합니다 —
`dashboard_image_tag`는 실제로 push된 타임스탬프 태그여야 합니다
(`infra/terraform.tfvars.example`). `docs/runbooks/deploy-production.md` §2와 같은 단계로
빌드·푸시합니다:
```bash
TAG=$(date -u +%Y%m%d-%H%M%S)
aws ecr get-login-password --region ap-northeast-2 \
  | docker login --username AWS --password-stdin 180294183052.dkr.ecr.ap-northeast-2.amazonaws.com
docker buildx build --platform linux/arm64 \
  -t 180294183052.dkr.ecr.ap-northeast-2.amazonaws.com/cc-ab-dashboard:$TAG \
  --push dashboard/
```
(`docs/runbooks/deploy-production.md` §2 참고 — 같은 AWS 계정으로 배포하지 않는다면
레지스트리/리포지토리를 자신의 ECR로 바꾸세요). 이제 다시 돌아가 `infra/terraform.tfvars`의
`dashboard_image_tag`를 `$TAG`로 설정합니다.

## 6. `terraform apply`
3단계의 비밀값 변수를 `-var`로 넘겨 apply합니다.
`docs/runbooks/clickhouse-ingest-user-cutover.md` §1이 그중 하나에 쓰는 것과 같은 패턴입니다:
```bash
cd infra
terraform apply -var="clickhouse_ingest_password=<value>"
```
(`docs/runbooks/clickhouse-ingest-user-cutover.md` §1 참고). 나머지 세 비밀값 변수
(`dashboard_basic_auth_password`, `clickhouse_writer_password`,
`clickhouse_reader_password`)도 같은 방식이나 `secrets.auto.tfvars`(3단계)로 넘깁니다.

## 7. 스키마: 신규 설치 vs 기존 클러스터
- **신규 설치** — ClickHouse를 처음 프로비저닝하는 `terraform apply`는 Terraform
  schema-init Job 외에 아무것도 더 필요하지 않습니다. 이 Job이
  `infra/files/clickhouse-schema-replicated.sql`을 적용하고, 그 파일이 실행되면 신규
  클러스터는 정의상 최신 마이그레이션까지 "적용된" 상태입니다
  (`docs/runbooks/schema-migrations.md` §"Procedure §4 — the rule for every future
  migration" 참고).
- **기존 클러스터** — `clickhouse-migration-NNN.sql`을 직접 적용하고 원장을 확인합니다.
  `docs/runbooks/schema-migrations.md`의 절차를 처음부터 끝까지 따르세요
  (`docs/runbooks/schema-migrations.md` §"Procedure" 참고).

## 8. 컬렉터 배포
OTel 컬렉터는 항상 systemd로 감독 실행하고, foreground/`nohup` 프로세스로 돌리지 않습니다 —
`Restart=always`가 크래시·DNS 블립·재부팅에서도 살아남게 합니다(`README.md` "텔레메트리
수집" 참고):
```bash
sudo tee /etc/systemd/system/otelcol.service <<'EOF'
[Unit]
Description=OpenTelemetry Collector (Claude Code -> ClickHouse)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=%i
ExecStart=/home/%i/.local/bin/otelcol-contrib --config=/home/%i/.otelcol/config.yaml
Environment=OTELCOL_QUEUE_DIR=/home/%i/.otelcol/queue
Restart=always
RestartSec=5
StandardOutput=append:/home/%i/.otelcol/collector.log
StandardError=append:/home/%i/.otelcol/collector.log

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now otelcol.service
```
(`README.md` "텔레메트리 수집" 참고). 실제로 쓰고 있는지 확인합니다:
```bash
systemctl status otelcol.service
journalctl -u otelcol -n 50   # 또는: tail -f ~/.otelcol/collector.log
```
(`README.md` "텔레메트리 수집" 참고).

## 9. 조직 단위 env 값 네 가지 정하기
`dashboard/server`의 env 변수입니다 — 기본값을 그냥 두지 말고 의도적으로 정하세요:

- **`GROUP_MODE`** — `ab`는 bedrock/enterprise 쌍을 비교하고, `single`은 채널이 하나인
  조직임을 SPA에 알려 빈 두 번째 카드를 그리지 않게 합니다. **`ab`/`single` 외의 값은 기동을
  실패시킵니다**(`README.md` "환경 설정" 참고). 조직이 실제로 두 인증 경로를 나란히
  쓸 때만 `ab`를 선택하세요.
- **`DEFAULT_RANGE_DAYS`** — `from` 없이 온 요청의 기본 구간이면서, **동시에** 서버 캐시
  warmer가 미리 데우는 창이기도 합니다(`README.md` "환경 설정" 참고). 자유롭게 고를 값이
  아닙니다 — 값을 올리면 warmer가 매 부팅마다 더 넓은 구간을 미리 데우는 대가로 더 넓게
  캐시를 유지합니다.
- **`RANGE_CAP_DAYS`** — 요청 가능한 최대 구간이며, 넘으면 400이고
  `DEFAULT_RANGE_DAYS` 이상이어야 합니다(`README.md` "환경 설정" 참고). 조직이 실제로
  되돌아볼 필요가 있는 최대 구간으로 설정하고 그보다 크게 잡지 마세요.
- **`PII_MASK_ENABLED`** — `GET /api/config`의 `piiMask`와 챗 샌드박스 결과 행의 유저
  이메일을 마스킹합니다. `"1"`/`"true"`(대소문자 무관)일 때만 켜집니다(`README.md` "환경
  설정" 참고). 공유 화면에서 데이터를 볼 수 있는 사람보다 더 많은 사람이 접근 가능한
  배포라면 켜세요.

## 10. 검증
읽기 전용 세 가지 확인:
- `SELECT max(TimeUnix) FROM claude_code.otel_metrics_sum` — `now()`에 가깝게 진행되어야
  합니다(`README.md` "텔레메트리 수집" 참고).
- `GET /api/health/data` → **200**. 이 엔드포인트는 `stale`/`unknown` 데이터에 대해
  의도적으로 503을 응답하도록 설계되어 있으므로, "아무 응답"이 아니라 200이 통과 조건입니다
  (`docs/api-reference.md` §"Health" 참고).
- `GET /readyz` → **200**(`docs/api-reference.md` §"Health" 참고).

## 11. 이 가이드가 다루지 않는 것
아래는 이 프로젝트의 **보류 중인 결정**이며, 이 가이드의 공백이 아닙니다. 이 가이드는 이들이
언제·어떻게 해결될지 추측하지 않습니다:
- **Basic Auth를 넘어서는 인증.**
- **알림/경보** (백업 Job 실패나 데이터 staleness에 대한 알림 등).
- **라이선싱.**
