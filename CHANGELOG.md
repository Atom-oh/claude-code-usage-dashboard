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
