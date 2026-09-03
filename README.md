# Claude Code Usage Dashboard

[![version](https://img.shields.io/badge/Version-1.0.0-green.svg)]()
[![CI](https://github.com/Atom-oh/claude-code-usage-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/Atom-oh/claude-code-usage-dashboard/actions/workflows/ci.yml)
<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

A ClickHouse-backed usage dashboard comparing Claude Code over Bedrock vs. Claude Enterprise. | Amazon Bedrock와 Claude Enterprise의 Claude Code 사용량을 비교하는 ClickHouse 기반 대시보드입니다.

---

<a id="english"></a>

# English

## Overview
This project ingests Claude Code's native OpenTelemetry telemetry into ClickHouse and
presents cost, adoption, and productivity KPIs through a React dashboard. It was built for an
AWS Workshop Studio A/B scenario: participants use Claude Code via either Bedrock or Claude
Enterprise, and the dashboard infers which group each session belongs to from telemetry
alone (no static experiment flag), since the auth path is chosen at runtime.

## Features
- **Cost breakdown** — computed cost (real token counts x per-model pricing) vs. Claude
  Code's self-reported cost, split by model, user, and cache tier (input/cacheRead/
  cacheWrite/output)
- **Bedrock vs. Enterprise grouping, inferred per session** — no deployment-time flag; group
  membership is derived from telemetry (Bedrock-style model names, `organization.id`
  presence) at the session grain, since one user can straddle both in different sessions
- **Adoption and productivity KPIs** — DAU/WAU/MAU, lines of code, commits, PRs, code-edit
  accept rate, agenticness (tool calls per prompt), all filterable by group/user/model and
  bucketable by hour/day/week
- **Cumulative OTel counter handling** — Claude Code re-exports session-cumulative totals
  every ~30 seconds; the query layer diffs at session boundaries instead of summing raw
  values, avoiding orders-of-magnitude overcounting
- **"Ask Claude" chat assistant** — a Bedrock-backed chat widget that writes and runs its own
  read-only ClickHouse SQL (sandboxed) to answer ad-hoc usage questions

## Prerequisites
- Node.js 24+ (matches the Dockerfile's `node:24-alpine`)
- Docker with `buildx` (`linux/arm64` support), if building the deployable image
- Access to a ClickHouse instance with the `otel_metrics_sum`/`otel_logs` schema
  (`clickhouse-schema.sql`) — either the deployed EKS cluster or a local instance via
  `docker compose`
- `kubectl` + `aws` CLI, if deploying or debugging against the live cluster
- `terraform` 1.x, if changing `infra/`

## Installation
```bash
# Clone the repository
git clone https://github.com/Atom-oh/claude-code-usage-dashboard.git
cd claude-code-usage-dashboard

# Install dependencies for both server and web
bash scripts/setup.sh
```
Deploying this stack for another organization (its own EKS cluster, ClickHouse, and secrets)
is walked through in [docs/deploying-for-your-org.md](docs/deploying-for-your-org.md).

## Usage
```bash
# Local full stack: ClickHouse (schema + seed data auto-loaded on first init) and the dashboard
# on http://localhost:8080. `down -v` removes the volume, which is what makes the init scripts
# run again on the next `up`.
cd dashboard
docker compose up -d --build

# Or run the app from source against that ClickHouse. AUTH_ALLOW_INSECURE=1 is required here:
# the server refuses to start without BASIC_AUTH_USER/BASIC_AUTH_PASSWORD.
cd dashboard/server
AUTH_ALLOW_INSECURE=1 npm run dev

# Web only, dev mode
cd dashboard/web
npm run dev
```
The "Ask Claude" chat answers 503 on the local stack — chat needs Basic Auth configured *and* a
ClickHouse account whose session is `readonly`, and the compose stack has neither.

Then open the printed Vite dev URL (web) or `http://localhost:8080` (server, serving the
built SPA) in a browser.

## Configuration
Environment variables consumed by `dashboard/server`:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP port the server listens on | `8080` |
| `CH_URL` | ClickHouse HTTP endpoint | none (required) |
| `CH_DB` | ClickHouse database name | `claude_code` |
| `CH_USER` | ClickHouse user | none (required) |
| `CH_PASSWORD` | ClickHouse password | none (required) |
| `BASIC_AUTH_USER` | Basic Auth username for the whole dashboard | required unless `AUTH_ALLOW_INSECURE=1` |
| `BASIC_AUTH_PASSWORD` | Basic Auth password | required unless `AUTH_ALLOW_INSECURE=1` |
| `AUTH_ALLOW_INSECURE` | Run without Basic Auth; the server otherwise exits 1 at boot — local dev / cluster-internal probes only | unset (auth required) |
| `CHAT_ALLOW_INSECURE` | Allow `POST /api/chat` without auth; independent of `AUTH_ALLOW_INSECURE` | unset (chat requires auth) |
| `GROUP_MODE` | `ab` compares the bedrock/enterprise pair; `single` tells the SPA this org has one channel and suppresses the empty second card. Any other value fails the boot | `ab` |
| `DEFAULT_RANGE_DAYS` | Default range when a request omits `from`; also the window the server's cache warmer pre-computes | `2` |
| `RANGE_CAP_DAYS` | Longest range a request may ask for; a longer span is a 400. Must be `>=` `DEFAULT_RANGE_DAYS` | `90` |
| `PII_MASK_ENABLED` | Mask user emails in `GET /api/config`'s `piiMask` and the chat sandbox's result rows; on only for `"1"`/`"true"`, case-insensitive | unset (masking off) |
| `DATA_STALE_MINUTES` | Age threshold for `GET /api/health/data`'s `stale` classification; a non-positive or non-numeric value refuses to boot | `360` |
| `ALERT_WEBHOOK_URL` | Slack-compatible webhook that receives a message when `GET /api/health/data` has been `stale`/`unknown` for two consecutive 60 s ticks, again every `ALERT_REPEAT_MINUTES` while it stays that way, and once on recovery. Each replica alerts independently (the pod name is in the message). Treat as a secret | unset (alerting off) |
| `ALERT_REPEAT_MINUTES` | Repeat interval while the data stays non-ok; a non-positive or non-numeric value refuses to boot | `60` |
| `CHAT_MODEL_ID` | Bedrock model ID for the "Ask Claude" chat assistant | `global.anthropic.claude-sonnet-5` |
| `AWS_REGION` | AWS region for the Bedrock client | `us-east-1` |
| `BEDROCK_REGION` | Overrides `AWS_REGION` for the Bedrock call only (e.g. accounts limited to one region) | unset (falls back to `AWS_REGION`) |
| `CLAUDE_NOTIFY_WEBHOOK` | Optional webhook for Claude Code hook notifications (harness tooling, not the app) | unset (disabled) |

See `.env.example` for a copy-paste template.

## Telemetry Ingestion (required for any data to appear)

The dashboard only shows data that a local `otelcol-contrib` collector actually forwarded to
ClickHouse. Claude Code never talks to ClickHouse directly — it exports OTLP to a collector on
`localhost:4317`, and that collector's `clickhouse` exporter is what writes to
`ch.atomai.click`. **If that collector process dies (crash, DNS blip, node reboot), the
dashboard silently shows a shrinking data window with no error anywhere** — this has already
happened once in production (collector died on a transient DNS timeout, telemetry gap of ~43h
before it was noticed). Always run the collector as a supervised systemd service, not a
foreground/nohup process that dies with the shell:

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
`Restart=always` means a DNS blip or ClickHouse restart no longer kills ingestion permanently —
the collector retries and resumes on its own. `OTELCOL_QUEUE_DIR` puts the exporter's queue on
disk, so batches already accepted from Claude Code survive a collector restart and a ClickHouse
outage longer than the retry window instead of being dropped. Verify it's alive and actually
writing:
```bash
systemctl status otelcol.service
journalctl -u otelcol -n 50   # or: tail -f ~/.otelcol/collector.log
# from a machine with access to the cluster:
kubectl -n claude-code exec chi-cc-ab-replicated-0-0-0 -- \
  clickhouse-client --query "SELECT max(TimeUnix) FROM claude_code.otel_metrics_sum"
```
If `max(TimeUnix)` lags far behind `now()`, the collector (or its network path to
`ch.atomai.click`) is down — this is the #1 cause of "the dashboard only shows old/today's
data no matter what range I pick," which is a data-availability problem, not a dashboard
filter bug (the range picker and server queries have been verified correct for this).
Workshop/CFN provisioning must install this exact systemd unit (see
`docs/workshop-studio-notes.md` §3) — a bare `otelcol-contrib &` in `UserData` will not survive
a crash or reboot.

The collector authenticates as `otel_ingest`, whose privileges are `INSERT ON claude_code.*`
plus `SELECT ON claude_code.otel_metrics_sum`, with the password coming from the SSM
SecureString parameter `/claude-code/ab/clickhouse-ingest-password` (created by an operator,
not by Terraform). `user-data.sh` is a cloud-init template, so this applies to newly launched
instances only — see `docs/runbooks/clickhouse-ingest-user-cutover.md` for the cutover
procedure. The `SELECT` grant on the source table is required, not extra: the materialized
view onto `otel_metrics_sum` is checked with the inserting user's privileges, so without it
every insert fails with `ACCESS_DENIED`. The ClickHouse data this collector writes has its own
backup/restore posture — RPO, retention and the quarterly restore drill — documented in
`docs/runbooks/backup-and-restore.md`.

**Since 2026-09-02 the dashboard notices this itself.** `GET /api/health/data` classifies the
newest `otel_metrics_sum` row into `ok` / `stale` / `unknown` and answers HTTP **503** for the
latter two, and the SPA renders a warning banner on every page while that holds — so the
"silently shrinking data window with no error anywhere" failure above is now visible without
anyone running the query by hand. The staleness threshold is the server env
`DATA_STALE_MINUTES` (default `360`, i.e. 6 hours; a non-positive or non-numeric value refuses
to boot). It reads the raw table rather than the hourly rollup precisely so a dead collector
shows up in minutes rather than after the next rollup. It is a *detector*, not a fix: the
systemd unit above is still what keeps ingestion alive.

## Project Structure
```
claude-code-usage-dashboard/
  dashboard/           # The deployable application
    server/            # Express API + ClickHouse query layer
    web/               # React SPA (Vite build)
    seed/              # Demo/workshop seed data (SQL)
  infra/               # Terraform: EKS, ClickHouse operator, ECR, DNS/CDN
  docs/                # Architecture docs, ADRs, runbooks, implementation reference
  scripts/             # Operational scripts (setup, git hooks, PR review automation)
  grafana-ab-queries.sql   # Legacy Grafana panel queries (kept in sync with dashboard/server)
  clickhouse-schema.sql    # Reference schema for otel_metrics_sum / otel_logs
  collector-config.yaml    # OpenTelemetry Collector config
```

## Testing
```bash
# Server unit tests (node:test, no framework)
cd dashboard/server
npm test   # same as: node --test *.test.js

# Web unit tests (vitest, jsdom)
cd dashboard/web
npm test   # same as: vitest run

# Web build check
cd dashboard/web
npm run build

# Claude Code harness tests (hooks, settings.json, structure)
bash tests/run-all.sh
```
All three of the above, plus `terraform fmt`/`validate` on `infra/`, run in CI
(`.github/workflows/ci.yml`) on every push to `main`/`feat/**` and on every pull request. On a
CI checkout the harness suite reports the `.claude/`-dependent assertion groups as **skipped**
rather than failed, since `.claude/` is gitignored and absent there.

## API Documentation
See [docs/api-reference.md](docs/api-reference.md) for the full endpoint list (54 read-only
`GET /api/*` routes — `grep -c '^route("' dashboard/server/index.js` gives 52, plus
`GET /api/config` and `GET /api/health/data`, which skip the `route()` wrapper — plus the
`/api/chat` SSE endpoint). See [docs/metrics.md](docs/metrics.md)
for KPI definitions — what each tile/chart measures, its source metric, and the function that
computes it.

## Contributing
```
1. Fork the repository
2. Create your branch (`git checkout -b feat/amazing-feature`)
3. Commit changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request
```
Pull requests against `main` run an automated multi-AI review
(`.github/workflows/pr-review.yml`) and are blocked from merging on CRITICAL/MAJOR findings.

## License
No license file is present in this repository (private/internal workshop project). Do not
assume an open-source license applies until one is added.

## Contact
- Maintainer: [Atom-oh](https://github.com/Atom-oh)
- Issues: https://github.com/Atom-oh/claude-code-usage-dashboard/issues

---

<a id="korean"></a>

# 한국어

## 개요
이 프로젝트는 Claude Code의 네이티브 OpenTelemetry 텔레메트리를 ClickHouse에 적재하고,
React 대시보드로 비용·도입률·생산성 KPI를 보여줍니다. AWS Workshop Studio A/B 시나리오용으로
만들어졌습니다: 참가자는 Bedrock 또는 Claude Enterprise 중 하나로 Claude Code를 사용하고,
인증 방식을 런타임에 직접 고르기 때문에 대시보드는 정적 실험 플래그 없이 텔레메트리만으로
각 세션이 어느 그룹에 속하는지 추론합니다.

## 주요 기능
- **비용 breakdown** — 실측 토큰 수 × 모델별 단가로 계산한 비용과 Claude Code가 자체
  보고하는 비용을 비교, 모델·유저·캐시 티어(input/cacheRead/cacheWrite/output)별로 분리
- **세션 단위로 추론하는 Bedrock vs Enterprise 그룹** — 배포 시점 플래그 없음; 텔레메트리
  (Bedrock 스타일 모델명, `organization.id` 존재 여부)로 세션 단위로 그룹을 판별합니다.
  한 유저가 세션마다 다른 방식을 쓸 수 있기 때문입니다
- **도입률·생산성 KPI** — DAU/WAU/MAU, 추가 라인, 커밋, PR, 코드 편집 수락률, 에이전틱함
  (프롬프트당 툴 호출 수) — 전부 그룹/유저/모델로 필터링, 시간/일/주 단위로 버킷 가능
- **누적 OTel 카운터 처리** — Claude Code가 ~30초마다 세션 누적 합계를 다시 export하므로,
  쿼리 레이어가 원본 값을 합산하는 대신 세션 경계에서 diff해 자릿수 단위 과대집계를 피합니다
- **"Ask Claude" 채팅 어시스턴트** — Bedrock 기반 채팅 위젯이 직접 읽기 전용 ClickHouse
  SQL을 작성·실행(샌드박스됨)해 임의의 사용량 질문에 답합니다

## 사전 요구 사항
- Node.js 24+ (Dockerfile의 `node:24-alpine`과 동일)
- 배포용 이미지를 빌드한다면 `buildx`(`linux/arm64` 지원)가 있는 Docker
- `otel_metrics_sum`/`otel_logs` 스키마(`clickhouse-schema.sql`)를 가진 ClickHouse 접근 —
  배포된 EKS 클러스터 또는 `docker compose`로 띄운 로컬 인스턴스
- 라이브 클러스터에 배포·디버깅하려면 `kubectl` + `aws` CLI
- `infra/`를 수정한다면 `terraform` 1.x

## 설치 방법
```bash
# 저장소 클론
git clone https://github.com/Atom-oh/claude-code-usage-dashboard.git
cd claude-code-usage-dashboard

# server, web 양쪽 의존성 설치
bash scripts/setup.sh
```
다른 조직(자체 EKS 클러스터, ClickHouse, 시크릿)에 이 스택을 배포하는 절차는
[docs/deploying-for-your-org.md](docs/deploying-for-your-org.md)에 정리되어 있습니다.

## 사용법
```bash
# 로컬 풀스택: ClickHouse(스키마 + 시드 데이터가 첫 기동 시 자동 로드)와 대시보드가
# http://localhost:8080 에서 뜬다. `down -v`로 볼륨을 지워야 init 스크립트가 다음 `up`에서
# 다시 돌아간다.
cd dashboard
docker compose up -d --build

# 또는 그 ClickHouse에 붙여서 소스로 앱을 실행한다. AUTH_ALLOW_INSECURE=1이 필수다: 서버가
# BASIC_AUTH_USER/BASIC_AUTH_PASSWORD 없이는 기동을 거부한다.
cd dashboard/server
AUTH_ALLOW_INSECURE=1 npm run dev

# 웹만, 개발 모드
cd dashboard/web
npm run dev
```
로컬 스택에서 "Ask Claude" 챗은 503이다 — 챗은 Basic Auth 설정과 세션이 `readonly`인
ClickHouse 계정을 둘 다 요구하고, compose 스택은 둘 다 아니다.

그다음 브라우저에서 출력된 Vite 개발 URL(web) 또는 `http://localhost:8080`(server, 빌드된
SPA 서빙)을 엽니다.

## 환경 설정
`dashboard/server`가 사용하는 환경변수:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | 서버가 리슨하는 HTTP 포트 | `8080` |
| `CH_URL` | ClickHouse HTTP 엔드포인트 | 없음(필수) |
| `CH_DB` | ClickHouse 데이터베이스 이름 | `claude_code` |
| `CH_USER` | ClickHouse 유저 | 없음(필수) |
| `CH_PASSWORD` | ClickHouse 비밀번호 | 없음(필수) |
| `BASIC_AUTH_USER` | 대시보드 전체 Basic Auth 유저명 | 필수 — `AUTH_ALLOW_INSECURE=1`일 때만 생략 가능 |
| `BASIC_AUTH_PASSWORD` | Basic Auth 비밀번호 | 필수 — `AUTH_ALLOW_INSECURE=1`일 때만 생략 가능 |
| `AUTH_ALLOW_INSECURE` | Basic Auth 없이 실행; 미설정 시 서버가 기동 시 exit 1 — 로컬 dev / 클러스터 내부 프로브 전용 | 미설정(인증 필수) |
| `CHAT_ALLOW_INSECURE` | `POST /api/chat`을 인증 없이 허용; `AUTH_ALLOW_INSECURE`와 독립 | 미설정(챗도 인증 필요) |
| `GROUP_MODE` | `ab`는 bedrock/enterprise 쌍을 비교, `single`은 채널이 하나인 조직 — SPA가 빈 두 번째 카드를 그리지 않는다. 그 외 값은 기동 실패 | `ab` |
| `DEFAULT_RANGE_DAYS` | `from` 없이 온 요청의 기본 구간. 서버 캐시 warmer가 미리 데우는 창도 이 값이다 | `2` |
| `RANGE_CAP_DAYS` | 요청 가능한 최대 구간 — 넘으면 400. `DEFAULT_RANGE_DAYS` 이상이어야 한다 | `90` |
| `PII_MASK_ENABLED` | `GET /api/config`의 `piiMask`와 챗 샌드박스 결과 행의 유저 이메일 마스킹; `"1"`/`"true"`(대소문자 무관)일 때만 켜짐 | 미설정(마스킹 꺼짐) |
| `DATA_STALE_MINUTES` | `GET /api/health/data`의 `stale` 판정 임계(분); 0 이하이거나 숫자가 아니면 기동 거부 | `360` |
| `ALERT_WEBHOOK_URL` | `GET /api/health/data`가 60초 틱 2회 연속 `stale`/`unknown`이면 메시지를 받는 Slack 호환 웹훅. 이후 `ALERT_REPEAT_MINUTES`마다 반복하고 복구 시 1회 더 보낸다. 레플리카마다 독립 판정이라 메시지에 pod 이름이 실린다. 비밀값으로 취급 | 미설정(알림 꺼짐) |
| `ALERT_REPEAT_MINUTES` | non-ok가 지속될 때 재발송 간격(분); 0 이하이거나 숫자가 아니면 기동 거부 | `60` |
| `CHAT_MODEL_ID` | "Ask Claude" 채팅 어시스턴트용 Bedrock 모델 ID | `global.anthropic.claude-sonnet-5` |
| `AWS_REGION` | Bedrock 클라이언트용 AWS 리전 | `us-east-1` |
| `BEDROCK_REGION` | Bedrock 호출에서만 `AWS_REGION`을 덮어씀(예: 특정 리전만 허용하는 계정) | 미설정(`AWS_REGION`을 따름) |
| `CLAUDE_NOTIFY_WEBHOOK` | Claude Code 훅 알림용 옵션 웹훅(앱이 아니라 하니스 도구) | 미설정(비활성) |

복사-붙여넣기 템플릿은 `.env.example`을 참고하세요.

## 텔레메트리 수집 (데이터가 보이려면 필수)

대시보드에는 로컬 `otelcol-contrib` 컬렉터가 실제로 ClickHouse까지 전달한 데이터만 보입니다.
Claude Code는 ClickHouse에 직접 쓰지 않습니다 — `localhost:4317`의 컬렉터로 OTLP를 export하고,
그 컬렉터의 `clickhouse` exporter가 `ch.atomai.click`에 씁니다. **이 컬렉터 프로세스가
죽으면(크래시, 일시적 DNS 장애, 노드 재부팅) 대시보드는 아무 에러 없이 조용히 "데이터가
점점 줄어드는" 것처럼 보입니다** — 실제로 프로덕션에서 이미 한 번 발생했습니다(일시적 DNS
타임아웃으로 컬렉터가 죽었고, 43시간 가까이 텔레메트리 공백이 있다가 발견됨). 쉘과 함께
죽는 foreground/`nohup` 프로세스가 아니라 항상 systemd로 감독 실행하세요:

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
`Restart=always`면 DNS 일시 장애나 ClickHouse 재시작이 인제스트를 영구히 끊지 않습니다 —
컬렉터가 알아서 재시도하고 복구합니다. `OTELCOL_QUEUE_DIR`은 exporter 큐를 디스크에 둔다 —
이미 Claude Code에서 받아 둔 배치가 collector 재시작이나 재시도 창을 넘는 ClickHouse 장애에도
유실되지 않고 이어서 전송된다. 살아있고 실제로 쓰고 있는지 확인:
```bash
systemctl status otelcol.service
journalctl -u otelcol -n 50   # 또는: tail -f ~/.otelcol/collector.log
# 클러스터 접근 가능한 머신에서:
kubectl -n claude-code exec chi-cc-ab-replicated-0-0-0 -- \
  clickhouse-client --query "SELECT max(TimeUnix) FROM claude_code.otel_metrics_sum"
```
`max(TimeUnix)`가 `now()`보다 한참 뒤쳐져 있다면 컬렉터(또는 `ch.atomai.click`까지의
네트워크 경로)가 죽어있는 것입니다 — "7일로 조회해도 오늘/과거 데이터만 보인다"는 증상의
1순위 원인이며, 이건 대시보드 필터 버그가 아니라 데이터 가용성 문제입니다(range picker와
서버 쿼리 로직은 이미 검증되어 정상입니다). 워크샵/CFN 프로비저닝은 반드시 이 systemd
유닛 그대로 설치해야 합니다(`docs/workshop-studio-notes.md` §3 참고) — `UserData`에 맨
`otelcol-contrib &`만 넣으면 크래시나 재부팅에서 살아남지 못합니다.

컬렉터는 `otel_ingest` 계정으로 인증하며, 이 계정의 권한은 `INSERT ON claude_code.*`와
`SELECT ON claude_code.otel_metrics_sum`이고 비밀번호는 SSM SecureString 파라미터
`/claude-code/ab/clickhouse-ingest-password`에서 가져옵니다(terraform이 아니라 운영자가
생성). `user-data.sh`는 cloud-init 템플릿이므로 이 변경은 새로 launch되는 인스턴스에만
적용됩니다 — 컷오버 절차는 `docs/runbooks/clickhouse-ingest-user-cutover.md`를 참고하세요.
소스 테이블에 대한 `SELECT` grant는 있으면 좋은 정도가 아니라 필수입니다: `otel_metrics_sum`
위의 materialized view가 insert하는 유저의 권한으로 검사되기 때문에, 이 grant가 없으면
모든 insert가 `ACCESS_DENIED`로 실패합니다. 이 컬렉터가 쓰는 ClickHouse 데이터의 백업/복구
현황 — RPO, 보존 기간, 분기별 복구 드릴 — 은 `docs/runbooks/backup-and-restore.md`에
문서화되어 있습니다.

**2026-09-02부터 대시보드가 이 문제를 스스로 감지합니다.** `GET /api/health/data`가 가장
최신 `otel_metrics_sum` 행을 `ok` / `stale` / `unknown`으로 분류하고, 후자 둘에 대해 HTTP
**503**을 응답합니다. 그 상태가 유지되는 동안 SPA는 모든 페이지에 경고 배너를 렌더링합니다 —
그 결과 위에서 설명한 "아무 에러 없이 조용히 데이터 창이 줄어드는" 장애가 누군가 쿼리를
수동으로 돌리지 않아도 보이게 됩니다. 이 staleness 판정 기준은 서버 env
`DATA_STALE_MINUTES`(기본값 `360`, 즉 6시간; 0 이하이거나 숫자가 아닌 값은 부팅을 거부)입니다.
시간별 롤업이 아니라 원본 테이블을 읽는 이유는 정확히, 죽은 컬렉터가 다음 롤업까지 기다리지
않고 몇 분 안에 드러나게 하기 위해서입니다. 이건 *탐지기*일 뿐 고치는 수단은 아닙니다 — 위의
systemd 유닛이 여전히 인제스트를 살려두는 실제 수단입니다.

## 프로젝트 구조
```
claude-code-usage-dashboard/
  dashboard/           # 배포되는 애플리케이션
    server/            # Express API + ClickHouse 쿼리 레이어
    web/               # React SPA (Vite 빌드)
    seed/              # 데모/워크샵 시드 데이터 (SQL)
  infra/               # Terraform: EKS, ClickHouse operator, ECR, DNS/CDN
  docs/                # 아키텍처 문서, ADR, 런북, 구현 참조
  scripts/             # 운영 스크립트(설치, git 훅, PR 리뷰 자동화)
  grafana-ab-queries.sql   # 레거시 Grafana 패널 쿼리(dashboard/server와 동기화 유지)
  clickhouse-schema.sql    # otel_metrics_sum / otel_logs 참조 스키마
  collector-config.yaml    # OpenTelemetry Collector 설정
```

## 테스트
```bash
# 서버 유닛 테스트 (node:test, 프레임워크 없음)
cd dashboard/server
npm test   # node --test *.test.js와 동일

# 웹 유닛 테스트 (vitest, jsdom)
cd dashboard/web
npm test   # vitest run과 동일

# 웹 빌드 확인
cd dashboard/web
npm run build

# Claude Code 하니스 테스트 (훅, settings.json, 구조)
bash tests/run-all.sh
```
위 세 가지에 더해 `infra/`에 대한 `terraform fmt`/`validate`까지 전부 CI
(`.github/workflows/ci.yml`)에서 `main`/`feat/**`로의 모든 push와 모든 pull request에 대해
실행됩니다. CI 체크아웃에서는 `.claude/`가 gitignore 대상이라 존재하지 않으므로, 하니스
스위트는 `.claude/`에 의존하는 단정문 그룹을 실패가 아니라 **skipped**로 보고합니다.

## API 문서
전체 엔드포인트 목록(읽기 전용 `GET /api/*` 라우트 54개 — `grep -c '^route("'
dashboard/server/index.js`가 52개, 여기에 `route()` 래퍼를 건너뛰는 `GET /api/config`와
`GET /api/health/data`를 더해서 54개 — 더하기 `/api/chat` SSE 엔드포인트)은
[docs/api-reference.md](docs/api-reference.md)를 참고하세요. 각 타일/차트가 무엇을 측정하는지,
원천 지표가 무엇인지, 어떤 함수가 계산하는지는 [docs/metrics.md](docs/metrics.md)(KPI 정의)를
참고하세요.

## 기여 방법
```
1. 저장소를 Fork합니다
2. 브랜치를 생성합니다 (`git checkout -b feat/amazing-feature`)
3. 변경 사항을 커밋합니다 (`git commit -m 'feat: add amazing feature'`)
4. 브랜치에 Push합니다 (`git push origin feat/amazing-feature`)
5. Pull Request를 엽니다
```
`main`에 대한 PR은 자동 멀티 AI 리뷰(`.github/workflows/pr-review.yml`)를 거치며
CRITICAL/MAJOR 발견 시 머지가 막힙니다.

## 라이선스
이 저장소에는 라이선스 파일이 없습니다(비공개/내부 워크샵 프로젝트). 라이선스 파일이
추가되기 전까지 오픈소스 라이선스가 적용된다고 가정하지 마세요.

## 연락처
- 담당자: [Atom-oh](https://github.com/Atom-oh)
- 이슈: https://github.com/Atom-oh/claude-code-usage-dashboard/issues
