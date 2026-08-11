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
