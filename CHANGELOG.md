# Changelog

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

---

<a id="english"></a>

# English

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This project has not been tagged yet — everything below is unreleased.

## [Unreleased]

### Changed (2026-09-02 data correctness)
- Fold `StartTimeUnix` into `SeriesKey` so cumulative-counter diffing is segment-aware
  (`clickhouse-migration-003.sql`, ADR-003), with a runtime feature-detect surfaced via
  `GET /api/config`'s `schema.segmentAwareSeriesKey`
- Correct list prices in the built-in pricing table and make it env-overridable
  (`PRICING_JSON`/`PRICING_CACHE_WRITE_TTL`)
- Merge per-user x model spend into one row per user x group x model, instead of duplicating
  rows across model normalization variants

### Added (2026-09-02 observability and resilience)
- Add the data-freshness probe and `GET /api/health/data`, classifying the newest telemetry row
  into `ok`/`stale`/`unknown` and answering 503 for the latter two
- Add `GET /readyz` (readiness, distinct from the always-200 `/healthz` liveness probe) and a
  `SIGTERM` drain so in-flight requests get a truthful "not ready" instead of a dropped connection
- Add the SPA's freshness warning banner, backed by the new health endpoint

### Changed (2026-09-02 security and request validation)
- Make Basic Auth fail-closed: the server now refuses to boot without `BASIC_AUTH_USER`/
  `BASIC_AUTH_PASSWORD` unless `AUTH_ALLOW_INSECURE=1` is explicitly set
- Reject invalid `from`/`to`/`intervalHours` query parameters with 400 before any ClickHouse
  query runs, instead of silently coercing them
- Stop echoing the underlying ClickHouse/SQL error text in 500 response bodies
- Measure and gate the chat assistant's ClickHouse session as `readonly` before allowing
  `POST /api/chat` to run
- Guard the collector-account password against `set -x` tracing in `user-data.sh`
- Add a CloudFront security-headers policy and scope the collector's ClickHouse account to
  `INSERT`-only privileges (plus the `SELECT` the materialized view needs)

### Changed (2026-09-01 infrastructure resilience)
- Add Deployment readiness/drain settings, preferred anti-affinity, and a PodDisruptionBudget
  for the dashboard
- Make the ECR repository immutable-tagged and commit the Terraform provider lock file
- Add a backend config template and a bounded, `wait_for_completion`-gated schema-init Job

### Changed (2026-08-31 build and CI reproducibility)
- Require a committed lockfile and switch server/web installs to `npm ci`
- Pin the server's base image by digest and add a `HEALTHCHECK` plus `engines` floors
- Add the CI workflow (server tests, web build, harness tests, `terraform fmt`/`validate` on
  every push/PR), with the harness's `.claude/`-dependent assertions reporting skipped rather
  than failed on a CI checkout where `.claude/` is absent
- Add a web build smoke test

### Added (2026-09-03 adoptability)
- Add a runtime config surface: `GROUP_MODE` (`ab`/`single`), `DEFAULT_RANGE_DAYS`, and
  `RANGE_CAP_DAYS`, all validated at boot and surfaced to the SPA via `GET /api/config`
- Add single-channel presentation mode (`GROUP_MODE=single`) so an org with one Claude Code
  channel no longer sees a permanently empty second A/B card
- Add URL permalinks for the selected range and group/user/model filters, with the user filter
  omitted from the URL while email masking is on
- Add a shared empty state, distinguishing "no telemetry has ever arrived" from "nothing in
  this range", wired at the chart, table, and Executive-section level
- Add `docs/metrics.md`, a KPI glossary linked from the tiles via a help affordance and from
  `README.md`
- Add a working local full stack: `dashboard/docker-compose.yml` now brings up ClickHouse with
  schema and seed data alongside the dashboard app
- Add `infra/terraform.tfvars.example` alongside required (no-default) cluster/domain/hostname
  Terraform variables, so `terraform apply` can no longer silently target this deployment's
  cluster
- Add an on-disk `file_storage` queue to the OTel Collector's ClickHouse exporter
  (`OTELCOL_QUEUE_DIR`), so a ClickHouse outage longer than the retry window no longer drops
  queued telemetry

### Added (2026-08-11 telemetry spec sync)
- Add cost/token attribution columns (effort, agent.name, plugin.name, marketplace.name,
  mcp_server.name, mcp_tool.name, speed, start_type, source) plus `app.version`/`enduser.id`
  identity columns, verified against live telemetry rather than the (incomplete) public docs
- Add a beta traces pipeline (`otel_traces`) and permission-wait / TTFT / subagent-fanout panels
- Add skill-activation, compaction, refusal-rate, retries-exhausted, and plugin-inventory panels
  from newly-collected log events, plus a version-cohort integrity check for the A/B comparison
- Add `clickhouse-migration-002.sql` (additive `ADD COLUMN IF NOT EXISTS`, no table drops)

### Changed
- Filter `agents_view` (the `claude agents` dashboard process, not a conversation) out of every
  session-count panel
- Fall back per-user identity to `enduser.id` when `user.email` is absent (Bedrock sessions have
  no Claude account and thus no email)

### Fixed
- Fix Panel 8 (tool/MCP usage) always returning zero rows — `EventName` is stored bare
  (`tool_result`), not prefixed (`claude_code.tool_result`)

### Added
- Add the Claude Code A/B telemetry pipeline, dashboard app, and EKS infrastructure
- Add adoption/engagement panels and per-user x model cost breakdown
- Add cost efficiency table, adoption activity timeseries, and cost-tier breakdown donut;
  split input/output token totals on the Overview page
- Add a dashboard favicon
- Add a global filter bar (group/user/model) shared across every page, and hour/day/week
  timeseries resolution switching
- Add an Analytics tab with preset chat prompts for the "Ask Claude" assistant

### Changed
- Redesign the dashboard with the awsops cobalt design system
- Classify bedrock/enterprise group per session instead of per user, fixing sessions that
  straddle both auth methods being misattributed entirely to one group
- Normalize Bedrock model IDs (strip region/date/version suffixes) so the same model shows as
  one row in cost/usage breakdowns instead of splitting across region/snapshot variants

### Fixed
- Fix cumulative OTel counter double-counting; price cost from real token usage instead of
  Claude Code's self-reported estimate
- Fix infra bugs found during a real `terraform apply`
- Fix `$/LOC` cost-efficiency figures being diluted by removed-line counts, and users who
  only used unpriced models ranking as falsely "most efficient" at `$0/LOC`

[Unreleased]: https://github.com/Atom-oh/claude-code-usage-dashboard/compare/9442d29...HEAD

---

<a id="korean"></a>

# 한국어

이 프로젝트의 모든 주요 변경 사항은 이 파일에 기록됩니다.
이 문서는 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)를 기반으로 하며,
[Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 따릅니다.

이 프로젝트는 아직 태그된 릴리스가 없습니다 — 아래 항목 전부 미출시(Unreleased)입니다.

## [Unreleased]

### Changed (2026-09-02 데이터 정확성)
- 누적 카운터 diff가 프로세스 세그먼트 단위로 동작하도록 `SeriesKey`에 `StartTimeUnix`를
  접어 넣음(`clickhouse-migration-003.sql`, ADR-003), `GET /api/config`의
  `schema.segmentAwareSeriesKey`로 런타임 feature-detect 결과 노출
- 기본 단가표 가격 오류 수정, env(`PRICING_JSON`/`PRICING_CACHE_WRITE_TTL`)로 오버라이드
  가능하도록 변경
- 유저×모델별 지출을 모델 정규화 변형별로 중복 행이 생기지 않도록 유저×그룹×모델 한 행으로
  병합

### Added (2026-09-02 관측성과 정상 종료)
- 데이터 신선도 프로브와 `GET /api/health/data` 추가 — 가장 최신 텔레메트리 행을
  `ok`/`stale`/`unknown`으로 분류하고 후자 둘에 대해 503 응답
- `GET /readyz`(readiness, 항상 200인 `/healthz` liveness와 별개) 및 `SIGTERM` drain 추가 —
  진행 중인 요청이 끊기지 않고 정직하게 "not ready"를 받도록 함
- 새 헬스 엔드포인트를 사용하는 SPA의 신선도 경고 배너 추가

### Changed (2026-09-02 보안과 요청 검증)
- Basic Auth를 fail-closed로 변경 — `AUTH_ALLOW_INSECURE=1`을 명시하지 않으면
  `BASIC_AUTH_USER`/`BASIC_AUTH_PASSWORD` 없이는 서버가 기동을 거부
- 잘못된 `from`/`to`/`intervalHours` 쿼리 파라미터를 조용히 보정하는 대신 ClickHouse 쿼리
  실행 전 400으로 거부
- 500 응답 본문이 ClickHouse/SQL 원문 에러 텍스트를 더 이상 에코하지 않도록 수정
- `POST /api/chat` 허용 전 챗 어시스턴트의 ClickHouse 세션이 `readonly`인지 실측·게이트
- `user-data.sh`에서 컬렉터 계정 비밀번호를 `set -x` 트레이싱으로부터 보호
- CloudFront 보안 헤더 정책 추가, 컬렉터 계정 권한을 `INSERT`(+ materialized view가 필요로
  하는 `SELECT`)로 좁힘

### Changed (2026-09-01 인프라 복원력)
- 대시보드 Deployment에 readiness/drain 설정, preferred 안티어피니티, PodDisruptionBudget
  추가
- ECR 리포지토리를 태그 불변으로 변경, Terraform provider lock 파일 커밋
- backend 설정 템플릿 추가, schema-init Job에 `wait_for_completion` 게이트 추가

### Changed (2026-08-31 빌드와 CI 재현성)
- 커밋된 lockfile을 요구하고 server/web 설치를 `npm ci`로 전환
- 서버 베이스 이미지를 digest로 고정, `HEALTHCHECK`와 `engines` 하한 추가
- CI 워크플로 추가(서버 테스트, 웹 빌드, 하니스 테스트, 모든 push/PR에 대한
  `terraform fmt`/`validate`) — CI 체크아웃에는 `.claude/`가 없으므로 하니스의
  `.claude/`-의존 단정문은 실패가 아니라 skipped로 보고
- 웹 빌드 스모크 테스트 추가

### Added (2026-09-03 조직 도입 용이성)
- `GROUP_MODE`(`ab`/`single`), `DEFAULT_RANGE_DAYS`, `RANGE_CAP_DAYS`로 구성되는 런타임 설정
  표면 추가 — 전부 부팅 시 검증되고 `GET /api/config`로 SPA에 노출
- 단일 채널 프리젠테이션 모드(`GROUP_MODE=single`) 추가 — Claude Code 채널이 하나뿐인 조직이
  더 이상 항상 빈 두 번째 A/B 카드를 보지 않음
- 선택한 구간과 그룹/유저/모델 필터를 URL 퍼머링크로 추가 — 이메일 마스킹이 켜져 있으면
  유저 필터는 URL에서 제외됨
- "아직 수집된 텔레메트리가 없음"과 "이 구간에 데이터 없음"을 구분하는 공유 empty state
  추가 — 차트·테이블·Executive 섹션 단위로 적용
- `docs/metrics.md`(KPI 용어집) 추가, 타일의 도움말 아이콘과 `README.md`에서 연결
- 실제로 동작하는 로컬 풀스택 추가 — `dashboard/docker-compose.yml`이 이제 스키마와 시드
  데이터를 포함한 ClickHouse를 대시보드 앱과 함께 띄움
- 기본값 없는(no-default) 클러스터/도메인/호스트명 Terraform 변수와
  `infra/terraform.tfvars.example` 추가 — `terraform apply`가 이 배포의 클러스터를 조용히
  겨냥할 수 없도록 함
- OTel Collector의 ClickHouse exporter에 디스크 기반 `file_storage` 큐 추가
  (`OTELCOL_QUEUE_DIR`) — 재시도 창을 넘는 ClickHouse 장애에서도 큐에 쌓인 텔레메트리가 더
  이상 유실되지 않음

### Added (2026-08-11 텔레메트리 스펙 동기화)
- cost/token attribution 속성 추가(effort, agent.name, plugin.name, marketplace.name,
  mcp_server.name, mcp_tool.name, speed, start_type, source) + app.version/enduser.id identity
  컬럼 — 공식 문서(불완전)가 아니라 라이브 텔레메트리 실측으로 검증
- traces 파이프라인(beta, otel_traces) 신설 + 권한 대기/TTFT/서브에이전트 팬아웃 패널 추가
- skill_activated/compaction/api_refusal/api_retries_exhausted/plugin_loaded 이벤트로부터
  스킬 발동·컴팩션 압박·refusal율·재시도 소진·플러그인 인벤토리 패널 추가, A/B 버전 혼재
  검증(코호트별 이중계상 실측) 패널 추가
- `clickhouse-migration-002.sql` 추가(전부 `ADD COLUMN IF NOT EXISTS`, 테이블 DROP 없음)

### Changed (2026-08-11)
- 모든 세션 카운트 패널에서 `agents_view`(claude agents 대시보드 프로세스, 대화 세션 아님)
  제외
- user.email이 없을 때(Bedrock 세션은 Claude 계정 자체가 없어 이메일이 없음) enduser.id로
  유저 식별 폴백

### Fixed (2026-08-11)
- Panel 8(tool/MCP 사용)이 항상 0행을 반환하던 버그 수정 — EventName은 프리픽스 없이
  bare(`tool_result`)로 저장됨, `claude_code.tool_result`가 아님

### Added
- Claude Code A/B 텔레메트리 파이프라인, 대시보드 앱, EKS 인프라 추가
- 도입률/참여도 패널, 유저×모델별 비용 breakdown 추가
- 비용 효율 테이블, 도입 활동 시계열, 캐시 티어별 지출 도넛 추가; Overview 페이지에
  입력/출력 토큰 합계 분리
- 대시보드 파비콘 추가
- 전체 페이지가 공유하는 전역 필터 바(그룹/유저/모델) 추가, 시/일/주 단위 시계열 해상도
  전환 추가
- "Ask Claude" 어시스턴트용 사전 정의 프롬프트를 가진 Analytics 탭 추가

### Changed
- awsops cobalt 디자인 시스템으로 대시보드 리디자인
- bedrock/enterprise 그룹 판별을 유저 단위에서 세션 단위로 변경 — 두 인증 방식을 함께 쓰는
  세션이 한쪽 그룹으로 통째로 잘못 귀속되던 문제 해결
- Bedrock 모델 ID 정규화(리전/날짜/버전 접미사 제거) — 같은 모델이 리전·스냅샷별로 나뉘어
  보이던 비용/사용량 breakdown을 한 행으로 통합

### Fixed
- 누적 OTel 카운터 이중집계 수정; Claude Code 자체 보고 추정치 대신 실측 토큰 사용량으로
  비용 계산
- 실제 `terraform apply` 과정에서 발견된 인프라 버그 수정
- 삭제된 라인 수가 섞여 낮게 나오던 `$/LOC` 비용 효율 지표, 미산정 모델만 쓴 유저가
  `$0/LOC`로 "가장 효율적"에 잘못 랭크되던 문제 수정

[Unreleased]: https://github.com/Atom-oh/claude-code-usage-dashboard/compare/9442d29...HEAD
