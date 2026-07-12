# Claude Code Usage Dashboard

[![version](https://img.shields.io/badge/Version-1.0.0-green.svg)]()
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

## Usage
```bash
# Local full stack (server + web), no live cluster needed if you point CH_* at a local ClickHouse
cd dashboard
docker compose up

# Server only, dev mode with reload
cd dashboard/server
npm run dev

# Web only, dev mode
cd dashboard/web
npm run dev
```
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
| `BASIC_AUTH_USER` | Basic Auth username for the whole dashboard | unset (auth disabled) |
| `BASIC_AUTH_PASSWORD` | Basic Auth password | unset (auth disabled) |
| `CHAT_MODEL_ID` | Bedrock model ID for the "Ask Claude" chat assistant | `global.anthropic.claude-sonnet-5` |
| `AWS_REGION` | AWS region for the Bedrock client | `us-east-1` |
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
the collector retries and resumes on its own. Verify it's alive and actually writing:
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
node --test *.test.js

# Web build check (no dedicated test suite yet)
cd dashboard/web
npm run build

# Claude Code harness tests (hooks, settings.json, structure)
bash tests/run-all.sh
```

## API Documentation
See [docs/api-reference.md](docs/api-reference.md) for the full endpoint list (~25 read-only
`GET /api/*` routes plus the `/api/chat` SSE endpoint).

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

## 사용법
```bash
# 로컬 풀스택(server + web) — CH_*를 로컬 ClickHouse로 향하게 하면 라이브 클러스터 불필요
cd dashboard
docker compose up

# 서버만, 리로드 개발 모드
cd dashboard/server
npm run dev

# 웹만, 개발 모드
cd dashboard/web
npm run dev
```
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
| `BASIC_AUTH_USER` | 대시보드 전체 Basic Auth 유저명 | 미설정(인증 비활성) |
| `BASIC_AUTH_PASSWORD` | Basic Auth 비밀번호 | 미설정(인증 비활성) |
| `CHAT_MODEL_ID` | "Ask Claude" 채팅 어시스턴트용 Bedrock 모델 ID | `global.anthropic.claude-sonnet-5` |
| `AWS_REGION` | Bedrock 클라이언트용 AWS 리전 | `us-east-1` |
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
컬렉터가 알아서 재시도하고 복구합니다. 살아있고 실제로 쓰고 있는지 확인:
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
node --test *.test.js

# 웹 빌드 확인 (아직 전용 테스트 스위트 없음)
cd dashboard/web
npm run build

# Claude Code 하니스 테스트 (훅, settings.json, 구조)
bash tests/run-all.sh
```

## API 문서
전체 엔드포인트 목록(읽기 전용 `GET /api/*` 라우트 약 25개 + `/api/chat` SSE 엔드포인트)은
[docs/api-reference.md](docs/api-reference.md)를 참고하세요.

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
