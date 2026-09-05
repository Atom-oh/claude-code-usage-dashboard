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

### Added (2026-09-04 auto-refresh + range presets)
- Add auto-refresh with a selectable interval (끔 / 15초 / 30초 / 1분 / 5분, default **1분**),
  persisted in `localStorage` under `ccdash.refreshMs`, paused while the tab is hidden, one
  tick skipped after a failure, and a manual refresh button in the filter bar. A tick never
  flips a page into its loading state and never blanks data already on screen
  (`src/RefreshContext.jsx`, `src/useApi.js`, `src/components/RefreshControl.jsx`)
- Range presets are now exactly 1일 / 2일 / 7일 / 30일 (plus the server's `defaultRangeDays`
  when it is not one of them), with **이번 달** (current UTC month, `period=month` in the URL)
  and a calendar popover for an arbitrary UTC day range capped at `rangeCapDays`
  (`src/urlState.js`, `src/RangeContext.jsx`, `src/components/RangePicker.jsx`,
  `src/components/DateRangePopover.jsx`)
- Old `days=14` / `days=90` links now fall back to the server default, the same way any
  non-preset `days` value already did

### Changed (2026-09-04 effort/agent cost basis)
- The Cost page's Effort and Agent panels now show the **computed** cost (tokens ×
  `pricing.js` rates) like every other card on that page, with Claude Code's reported
  `cost.usage` kept beside it as a secondary column — `/api/cost/effort-mix` and
  `/api/cost/by-agent` return `cost` + `reported_cost` + `tokens` + `unpriced_tokens` instead
  of the reported-only `cost_usd`. Reported cost is priced client-side from the client's own
  price table, so it moves with the Claude Code version: measured 2026-09-03, v2.1.251 prices
  `claude-fable-5-1` off the opus-5 row (≈0.5× of list) while v2.1.258 prices it at list, and
  the control model `claude-fable-5` is ≈1.00 on every version — so those two panels were
  under-reporting exactly the fable-5-1 sessions by ~2× depending on which client emitted them
- Add `rollupComputedCost()` to `dashboard/server/pricing.js` (pure, unit-tested): it applies
  `withComputedCost` at a `model` grain and folds the rows onto coarser key columns, which is
  what lets a per-effort/per-agent query use computed cost at all — the pricing has to be
  applied before the model column is summed away, so it cannot be done in SQL

### Changed (2026-09-04 UI copy)
- Rewrote every user-facing string in the SPA to product-grade Korean: labels, titles and
  subtitles now name what a number is, and the formulas, telemetry event/attribute names, raw
  enum values and measurement notes that used to sit in subtitles moved into `help` tooltips or
  were dropped outright. Unified the vocabulary across pages: 비용 (not 지출), 채널 (not 그룹),
  사용자 (not 유저), 추가 코드 라인 (not 추가 라인 / 작성 라인), 미분류 (not `unknown`), 미지정
  (not an empty effort), 단가 미등록 (not 미산정), 오류 (not 에러)
- Give `Card` an optional `help` prop, rendered as the same `Info` icon `StatTile` already had,
  with `DataTable` and the Card-wrapping charts in `GroupCharts.jsx` forwarding it unchanged —
  this is where the page-level methodology now lives (`dashboard/web/src/components/Card.jsx`,
  `DataTable.jsx`, `GroupCharts.jsx`)
- Add `dashboard/web/src/labels.js` with `effortLabel` / `unclassifiedLabel` / `decisionLabel`,
  so a raw enum value never reaches the screen or a CSV export — every mapped column now carries
  both `render` and `toText`. `Reliability.jsx` dropped its own local `effortLabel` in favor of
  the shared one
- Remove `LowerBoundNote` and do not replace it; the fact it stated survives as one sentence at
  the end of two `help` tooltips — the Executive `기간 비용` tile and the Cost `총 비용` tile.
  `/api/config`'s `schema.segmentAwareSeriesKey` no longer drives any UI text as a result, which
  is why both the rollup-rebuild and schema-migrations runbooks lost their "the callout updates
  itself" step
- Rename the per-user cost table's checkbox to `미분류 포함` (was `unknown 그룹 포함`), and
  update the three test files that pinned the old string — the assertions themselves are
  unchanged, only the pinned literals

### Added (2026-09-03 production decisions)
- Add outbound alerting for telemetry staleness — `dashboard/server/alerting.js` (pure
  planner with a two-tick debounce, a repeat interval and a recovery message) driven by
  `ALERT_WEBHOOK_URL` / `ALERT_REPEAT_MINUTES`, with the webhook URL held in a k8s Secret and
  never logged
- Add the Terraform surface for it — `alert_webhook_url` (sensitive, nullable) and
  `alert_repeat_minutes` in `infra/dashboard.tf`, plus `infra/alerting.tf`'s optional
  `var.alert_email`-gated CloudFront `5xxErrorRate` alarm → SNS e-mail and the
  `alert_topic_arn` output; nothing is created while the variables are null
- Add `docs/runbooks/alerting.md` (both legs, how to enable each, the three message shapes and
  what to do for each, why two replicas send two messages)
- Add ADR-004: Basic Auth is the shipped baseline, with an edge-side SSO upgrade path and self
  sign-up staying off
- Add ADR-005: outbound webhook alerting for telemetry staleness plus the edge 5xx alarm,
  including the backup-CronJob gap it does not cover
- Add ADR-006: client-side e-mail masking is the PII baseline; the server-side pseudonym design
  is recorded but deferred
- Add ADR-007: the UI stays Korean-first and i18n is deferred to a string table
- Add `LICENSE` (proprietary, all rights reserved) and `"license": "UNLICENSED"` to both
  `package.json` files

### Fixed (2026-09-03 production decisions)
- `FilterBar` no longer offers the bedrock/enterprise channel filter when `GROUP_MODE=single`
  — a single-channel org was being offered two channel names; the `group` URL parameter is
  unchanged, so a hand-typed `?group=` still applies server-side
- `UserDrawer`'s background used the nonexistent `bg-page` token and rendered transparent; it
  is `bg-paper` now (commit `d761cba`)
- `docs/architecture.md`'s Korean half claimed a 90-day cold move for the hourly rollup's TTL,
  which is DELETE-only at 180 days (commit `6454c01`)

### Added (2026-09-03 mobile nav, CSV export, schema ledger, org onboarding)
- Add mobile navigation for the SPA below the `lg` (1024px) breakpoint — a top bar plus a
  slide-over drawer, both driven by the same `NAV` table `Sidebar.jsx`'s desktop nav uses
  (`src/components/MobileNav.jsx`)
- Add a client-side "CSV" export button to every dashboard table that opts in, downloading
  exactly what the table shows (current sort included) and honouring the PII mask on the
  `user` column (`src/csv.js`, `DataTable.jsx`, wired across Overview/Users/Reliability/
  Cost/Usage/Productivity)
- Add the ClickHouse schema-migration ledger — `claude_code.schema_migrations`, introduced
  by `clickhouse-migration-004.sql` (which also backfills `002`/`003` from column evidence)
  and mirrored into both schema copies — surfaced at `GET /api/config`'s `schema.migrations`
- Add `docs/runbooks/schema-migrations.md` (how to check/apply migrations and the header
  every future migration file must carry) and `docs/runbooks/backup-and-restore.md`
  (measured RPO/retention, an explicit "RTO not measured" statement, and a quarterly
  restore-drill checklist)
- Add `docs/deploying-for-your-org.md`, a walkthrough for standing up this stack for another
  organization assembled entirely from commands already cited in the existing runbooks/README
- Expose the server's `GROUP_MODE` / `DEFAULT_RANGE_DAYS` / `RANGE_CAP_DAYS` as Terraform
  variables `group_mode` / `default_range_days` / `range_cap_days` (`infra/dashboard.tf`),
  validated with the same rules the server enforces at boot; the next `terraform apply` adds
  three env entries and rolls the dashboard Deployment once

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
- Add the CI workflow (server tests, web build, harness tests, `terraform fmt`/`validate` on pushes to
  `main`/`feat/**` and on every PR), with the harness's `.claude/`-dependent assertions reporting skipped rather
  than failed on a CI checkout where `.claude/` is absent
- Add a web build smoke test

### Added (2026-09-03 adoptability)
- Add a runtime config surface: `GROUP_MODE` (`ab`/`single`), `DEFAULT_RANGE_DAYS`, and
  `RANGE_CAP_DAYS`, all validated at boot and surfaced to the SPA via `GET /api/config`
- Add single-channel presentation mode (`GROUP_MODE=single`) so an org with one Claude Code
  channel no longer sees a permanently empty second A/B card
- Add URL permalinks for the selected range and group/user/model filters, with the user filter
  omitted from the URL while email masking is on — including a `user` parameter arriving in a
  pasted link, which the range writer no longer carries over (pinned by `permalink.test.jsx`)
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

### Added (2026-09-04 자동 새로고침 + 범위 프리셋)
- 선택 가능한 간격(끔 / 15초 / 30초 / 1분 / 5분, 기본값 **1분**)의 자동 새로고침 추가 —
  `localStorage`의 `ccdash.refreshMs`에 저장되고, 탭이 숨겨지면 멈추고, 실패 다음 tick은 한
  번 건너뛰고, 필터 바에 수동 새로고침 버튼도 함께 추가. tick은 페이지를 로딩 상태로 만들지
  않고 화면에 있는 데이터를 지우지도 않음(`src/RefreshContext.jsx`, `src/useApi.js`,
  `src/components/RefreshControl.jsx`)
- 범위 프리셋이 정확히 1일 / 2일 / 7일 / 30일로 바뀜(목록에 없으면 서버의
  `defaultRangeDays`도 추가), **이번 달**(현재 UTC 월, URL의 `period=month`)과
  `rangeCapDays`로 상한이 걸린 임의 UTC 일자 구간을 고르는 달력 팝오버 추가
  (`src/urlState.js`, `src/RangeContext.jsx`, `src/components/RangePicker.jsx`,
  `src/components/DateRangePopover.jsx`)
- 기존 `days=14` / `days=90` 링크는 이제 서버 기본값으로 폴백함 — 프리셋에 없는 다른
  `days` 값이 이미 그랬던 것과 동일한 동작

### Changed (2026-09-04 effort/agent 비용 기준)
- Cost 페이지의 Effort·에이전트 패널이 이제 다른 카드와 동일하게 **계산 비용**(토큰 ×
  `pricing.js` 단가)을 보여주고, Claude Code 보고 비용(`cost.usage`)은 대조용 컬럼으로 함께
  표시한다 — `/api/cost/effort-mix`와 `/api/cost/by-agent`가 보고 비용만 담은 `cost_usd`
  대신 `cost` + `reported_cost` + `tokens` + `unpriced_tokens`를 반환한다. 보고 비용은
  클라이언트가 자체 단가표로 계산하는 값이라 Claude Code 버전에 따라 달라진다: 실측
  2026-09-03, v2.1.251은 `claude-fable-5-1`을 opus-5 단가로 보고(정가의 약 0.5×)하고
  v2.1.258은 정가로 보고하며, 대조군 `claude-fable-5`는 모든 버전에서 약 1.00 — 즉 두 패널만
  fable-5-1 세션을 어느 클라이언트가 보냈는지에 따라 약 2배 과소 보고하고 있었다
- `dashboard/server/pricing.js`에 `rollupComputedCost()` 추가(순수 함수, 단위 테스트) —
  `withComputedCost`를 model 그레인에서 적용한 뒤 더 굵은 키 컬럼으로 접는다. 단가는 model
  컬럼이 합쳐지기 전에 적용해야 하므로 SQL만으로는 불가능하고, 이 헬퍼가 effort·에이전트별
  계산 비용을 처음으로 가능하게 한다

### Changed (2026-09-04 UI 문구)
- SPA의 모든 사용자 노출 문구를 제품 수준 한국어로 다시 씀 — 라벨·타이틀·서브타이틀이 이제
  숫자가 무엇인지 이름으로 말하고, 서브타이틀에 있던 수식·텔레메트리 이벤트/속성명·원본 enum
  값·측정 노트는 `help` 툴팁으로 옮기거나 그대로 삭제함. 페이지 전역에서 용어를 통일: 비용
  (지출 아님), 채널 (그룹 아님), 사용자 (유저 아님), 추가 코드 라인 (추가 라인 / 작성 라인
  아님), 미분류 (`unknown` 아님), 미지정 (빈 effort 아님), 단가 미등록 (미산정 아님), 오류
  (에러 아님)
- `Card`에 선택적 `help` prop 추가 — `StatTile`이 이미 가진 것과 같은 `Info` 아이콘으로
  렌더링되며, `DataTable`과 `GroupCharts.jsx`의 Card 래핑 차트들이 그대로 전달함 — 페이지별
  방법론 설명이 이제 여기에 산다(`dashboard/web/src/components/Card.jsx`, `DataTable.jsx`,
  `GroupCharts.jsx`)
- `dashboard/web/src/labels.js` 신설(`effortLabel` / `unclassifiedLabel` / `decisionLabel`) —
  원본 enum 값이 화면이나 CSV에 그대로 노출되지 않도록, 매핑되는 모든 컬럼이 `render`와
  `toText`를 함께 갖게 됨. `Reliability.jsx`는 자체 `effortLabel`을 지우고 공용 헬퍼를 가져다
  씀
- `LowerBoundNote`를 제거하고 대체하지 않음 — 그 안내가 말하던 사실은 `help` 툴팁 두 곳(맨
  끝 문장)에만 남음: Executive의 `기간 비용` 타일과 Cost의 `총 비용` 타일. 그 결과
  `/api/config`의 `schema.segmentAwareSeriesKey`는 더 이상 어떤 UI 문구도 구동하지 않고,
  이 때문에 rollup-rebuild·schema-migrations 두 런북에서 "안내문이 자동으로 갱신된다"는
  단계가 사라짐
- 사용자별 비용 표의 체크박스를 `미분류 포함`으로 변경(이전 `unknown 그룹 포함`) — 옛 문자열을
  고정해 두던 테스트 파일 3개도 갱신함. 단정문 자체는 그대로고, 고정된 문자열만 바뀜

### Added (2026-09-03 프로덕션 결정)
- 텔레메트리 staleness에 대한 발신 알림 추가 — `dashboard/server/alerting.js`(2틱 디바운스,
  반복 간격, 복구 메시지를 갖춘 순수 planner)가 `ALERT_WEBHOOK_URL` / `ALERT_REPEAT_MINUTES`로
  구동되며, 웹훅 URL은 k8s Secret에 보관되고 절대 로그에 남지 않음
- 이를 위한 Terraform 표면 추가 — `infra/dashboard.tf`의 `alert_webhook_url`(sensitive,
  nullable)과 `alert_repeat_minutes`, 그리고 `infra/alerting.tf`의 선택적
  `var.alert_email`-게이트 CloudFront `5xxErrorRate` 알람 → SNS 이메일과 `alert_topic_arn`
  출력; 변수가 null인 동안은 아무것도 생성되지 않음
- `docs/runbooks/alerting.md` 추가(두 경로, 각각 활성화하는 방법, 세 가지 메시지 형태와
  각각에 대한 대응, 레플리카 2개가 메시지 2개를 보내는 이유)
- ADR-004 추가: Basic Auth가 출시 기본값이며, 엣지 사이드 SSO 업그레이드 경로가 있고 self
  sign-up은 계속 꺼둔다는 결정
- ADR-005 추가: 텔레메트리 staleness에 대한 발신 웹훅 알림과 엣지 5xx 알람, 그리고 이것이
  다루지 않는 백업 CronJob 공백
- ADR-006 추가: 클라이언트 사이드 이메일 마스킹이 PII 기준선이며, 서버 사이드 pseudonym
  설계는 기록되었지만 보류됨
- ADR-007 추가: UI는 계속 한국어 우선을 유지하고 i18n은 문자열 테이블로 미룸
- `LICENSE`(독점, 모든 권리 보유) 추가 및 두 `package.json` 파일에 `"license": "UNLICENSED"`
  추가

### Fixed (2026-09-03 프로덕션 결정)
- `GROUP_MODE=single`일 때 `FilterBar`가 더 이상 bedrock/enterprise 채널 필터를 제공하지
  않음 — 채널이 하나뿐인 조직에 채널 이름 두 개를 보여주고 있었음; `group` URL 파라미터는
  변경되지 않았으므로 직접 입력한 `?group=`은 여전히 서버 사이드에 적용됨
- `UserDrawer`의 배경이 존재하지 않는 `bg-page` 토큰을 써서 투명하게 렌더링되던 문제 —
  이제 `bg-paper`로 수정됨(커밋 `d761cba`)
- `docs/architecture.md` 한국어 반쪽이 시간별 롤업 TTL을 90일 콜드 이동이라고 잘못 기재했던
  문제 — 실제로는 180일 DELETE-only임(커밋 `6454c01`)

### Added (2026-09-03 모바일 내비게이션, CSV 내보내기, 스키마 원장, 조직 온보딩)
- `lg`(1024px) 미만에서 SPA 모바일 내비게이션 추가 — 데스크톱 사이드바가 쓰는 것과 같은
  `NAV` 테이블로 구동되는 상단 바 + 슬라이드오버 드로어(`src/components/MobileNav.jsx`)
- 모든 대시보드 테이블에 opt-in "CSV" 내보내기 버튼 추가 — 현재 정렬 순서를 포함해 화면에
  보이는 그대로 다운로드하고, `user` 컬럼은 PII 마스킹 설정을 그대로 따름(`src/csv.js`,
  `DataTable.jsx`, Overview/Users/Reliability/Cost/Usage/Productivity 전 페이지에 연동)
- ClickHouse 스키마 마이그레이션 원장 추가 — `clickhouse-migration-004.sql`이 신설하는
  `claude_code.schema_migrations`(컬럼 증거로 `002`/`003`도 소급 기록), 두 스키마 사본에
  동일하게 미러링, `GET /api/config`의 `schema.migrations`로 노출
- `docs/runbooks/schema-migrations.md`(마이그레이션 확인·적용 절차와 향후 파일이 가져야
  할 헤더 규칙) 및 `docs/runbooks/backup-and-restore.md`(실측된 RPO/보존 기간, "RTO
  미측정"을 명시, 분기별 복구 드릴 체크리스트) 추가
- `docs/deploying-for-your-org.md` 추가 — 기존 런북/README에 이미 있는 명령만으로 구성한,
  다른 조직에 이 스택을 세우는 절차 안내서
- 서버의 `GROUP_MODE` / `DEFAULT_RANGE_DAYS` / `RANGE_CAP_DAYS`를 Terraform 변수
  `group_mode` / `default_range_days` / `range_cap_days`로 노출(`infra/dashboard.tf`) —
  서버가 부팅 시 강제하는 것과 같은 규칙으로 검증하며, 다음 `terraform apply`가 env 3개를
  추가하면서 대시보드 Deployment를 한 번 롤링 재시작

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
- CI 워크플로 추가(서버 테스트, 웹 빌드, 하니스 테스트, `main`/`feat/**` push와 모든 PR에 대한
  `terraform fmt`/`validate`) — CI 체크아웃에는 `.claude/`가 없으므로 하니스의
  `.claude/`-의존 단정문은 실패가 아니라 skipped로 보고
- 웹 빌드 스모크 테스트 추가

### Added (2026-09-03 조직 도입 용이성)
- `GROUP_MODE`(`ab`/`single`), `DEFAULT_RANGE_DAYS`, `RANGE_CAP_DAYS`로 구성되는 런타임 설정
  표면 추가 — 전부 부팅 시 검증되고 `GET /api/config`로 SPA에 노출
- 단일 채널 프리젠테이션 모드(`GROUP_MODE=single`) 추가 — Claude Code 채널이 하나뿐인 조직이
  더 이상 항상 빈 두 번째 A/B 카드를 보지 않음
- 선택한 구간과 그룹/유저/모델 필터를 URL 퍼머링크로 추가 — 이메일 마스킹이 켜져 있으면
  유저 필터는 URL에서 제외됨(붙여넣은 링크에 들어온 `user` 파라미터도 구간 쪽 writer가 더는
  옮겨 쓰지 않음, `permalink.test.jsx`로 고정)
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
