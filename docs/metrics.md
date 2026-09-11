# KPI 정의 (Metrics Glossary)

이 문서는 대시보드의 9개 페이지(`Analytics`, `Cost`, `Executive`, `Overview`, `Productivity`,
`Reliability`, `Trends`, `Usage`, `Users`)에 노출되는 지표(KPI)를 페이지별로 정리한다. 각 항목은
이름(Name) / 정의(Definition) / 원천(Source) / 계산(Calculation, `file:function`) / 주의(Caveats)
순서로 적는다. 정의가 코드에서 명확히 읽히지 않는 항목은 값을 지어내는 대신
`계산 규칙은 \`file:function\` 참고`라고만 적는다 — 틀린 공식이 나중에 데이터를 반박하는 근거로
인용되는 것이 포인터 하나 부족한 것보다 나쁘다.

## 읽는 방법 (How to read this)

아래 여섯 가지는 여러 지표에 공통으로 적용되는 주의사항이라 각 항목에서 반복하지 않고 번호로
참조한다.

1. **누적 카운터 차분 (cumulative-counter diff)** — `otel_metrics_sum`의 값은 세션(`session.id`)
   단위로 "지금까지의 누적 합계"를 ~30초마다 다시 export한 것이다. 그래서 모든 수치는
   `sum(Value)`가 아니라 세션 경계에서의 차분(`incFlat`/`incBucketed`, `queries.js`)으로 구한다.
2. **비용은 클라이언트 보고 추정값 (client-reported estimate)** — 지출 화면은
   `reported_cost`를 기본으로 사용한다. 클라이언트 버전의 단가표, 수집 누락과 계약 할인 때문에
   실제 청구액과 다를 수 있다. 계산 비용은 TTL 가정에 따라 과대·과소 산정될 수 있으므로
   실청구의 하한으로 보장하지 않는다. 소비 측에 전달된 집계행에서 확인되는 보고값 누락이나 토큰
   사용이 있는 0 보고값은 확인 필요로 표시한다. 그 행을 JS에서 합치는 합계·평균도 표시하지
   않는다. 집계 전에 다른 사용자의 양수 비용과 합쳐진 누락은 탐지하지 못할 수 있으므로,
   총계와 사용자 상세의 상태가 다를 수 있다. 양수 보고값은 완전 수집을 입증하지 않는다.
3. **단가표에 없는 모델 (unpriced models)** — 단가표(`pricing.js`)에 없는 모델의 토큰은 추정치를
   넣지 않고 계산 비용에서 통째로 빠지며, `unpriced_tokens`로 별도 노출된다.
   유효한 보고 비용이 있으면 지출과 보고 비용 기반 효율 지표에는 포함한다.
4. **`unknown` 그룹** — 세션의 그룹(Bedrock/Enterprise)을 텔레메트리로 판별하지 못하면
   `unknown`이 된다. 대부분의 A/B 비교 엔드포인트는 이를 제외하지만, 총계용 엔드포인트
   (`activeUsers`, `adoptionLevels`, `adoptionTimeseries`, `kpiSummary`, `costSummary`)는
   포함한다 — 그래서 총계가 두 그룹 행의 합보다 클 수 있다. `GROUP_MODE`(`ab`/`single`)는 이
   서버 정책을 바꾸지 않는다.
5. **그룹 판별은 세션 단위** — 그룹은 유저 단위가 아니라 세션 단위로 판별된다(`grouping.js`).
   한 사람이 세션에 따라 다른 그룹에 속할 수 있어, 그룹별 헤드카운트를 더하면 distinct 유저 수를
   넘을 수 있다.
6. **CSV 내보내기** — `exportName`이 있는 표는 CSV 버튼을 갖고, 화면에 보이는 행(정렬 순서
   포함)을 화면에 보이는 셀 텍스트 그대로 내보낸다. `PII_MASK_ENABLED` 마스킹이 켜진 동안은
   `user` 컬럼도 마스킹된 채로 내보내지므로, CSV가 마스킹을 우회하는 수단이 되지는 않는다.

---

## Executive

### 활성 개발자 (Active Developers)
- **정의**: 선택한 기간에 세션이 1건 이상 있었던 사용자 수(그룹 무관, `unknown` 세션 포함).
- **원천**: `claude_code.session.count` (`UserEmail` 속성).
- **계산**: `queries.js:activeUsers`.
- **주의**: 4번(총계는 `unknown` 포함). 그룹별 카드(스코어보드)에서는 `bedrock_users`/
  `enterprise_users`로 나뉘어 나오며, 이쪽은 그룹 판별된 세션만 센다.

### 기간 비용 (Period Cost)
- **정의**: 선택 기간의 Claude Code 보고 비용 합계. 토큰 × 단가표 계산값은 비교용으로 보존한다.
- **원천**: `claude_code.cost.usage`, `claude_code.token.usage`.
- **계산**: `queries.js:costSummary`의 기존 `reported_cost`, `spend.js:asSpendRow`.
- **주의**: 2번, 3번, 4번.

### 개발자당 비용 (Cost per Developer)
- **정의**: 기간 비용 ÷ 활성 개발자 수.
- **계산**: `Executive.jsx`의 `abCostPerDev`/`costPerDev` — `costSummary`와 `activeUsers`를
  나눈 클라이언트 계산이며 둘 다 `unknown` 세션을 포함해 분자·분모 모수가 일치한다.
- **주의**: 2번, 3번, 4번.

### 추가 코드 라인 (Lines Added)
- **정의**: 선택 기간에 추가된 코드 라인 수 합계(`added` 방향만).
- **원천**: `claude_code.lines_of_code.count` (`TokenType = 'added'`).
- **계산**: `queries.js:kpiSummary`.
- **주의**: 4번.

### 제안 수락률 (Suggestion Accept Rate)
- **정의**: 코드 편집 제안 중 수락(`accept`)으로 판정된 비율.
- **원천**: `claude_code.code_edit_tool.decision` (`Decision` 속성).
- **계산**: `queries.js:codeEditDecisions`.
- **주의**: 없음(그룹 A/B 비교 지표라 `unknown` 그룹은 기본적으로 제외).

### 개발자 활성 시간 (Active Time per Developer)
- **정의**: 사람이 실제로 상호작용한 시간(`TokenType = 'user'`) — Claude Code 프로세스 구동
  시간(`cli`)과는 다른 값.
- **원천**: `claude_code.active_time.total`.
- **계산**: `queries.js:activeTimeSummary`.
- **주의**: 없음.

### 자동화 배율 (Automation Ratio)
- **정의**: Claude Code 작업 시간 ÷ 개발자 활성 시간 — 값이 클수록 에이전트가 사람 개입 없이
  더 오래 자율 실행했다는 뜻.
- **계산**: `계산 규칙은 \`Executive.jsx:abAutoRatio\` 참고` (원천 지표는 위 "개발자 활성 시간"과
  동일한 `activeTimeSummary`의 `cli_seconds`/`user_seconds`).
- **주의**: 없음.

### 생산성 점수 (Productivity Score)
- **정의**: 라인/일, 수락률, 커밋/일, 활성일 비율, 세션/일을 가중합해 0~100으로 정규화한
  조직 종합 점수. 각 `/day` 항목은 절대 상한으로 캡한 뒤 정규화된다.
- **계산**: `productivity.js:withProductivityScore`(유저 단위 점수), Executive 페이지는 그룹을
  오간 유저의 raw 지표를 유저 단위로 먼저 합산한 뒤 동일 공식으로 재계산해 평균한다
  (`Executive.jsx`의 `orgScore`/`perUserScores`).
- **주의**: 상한값(`LOC_PER_DAY_CAP` 등)은 실측 분포 없이 임의로 잡은 값이라 조정 대상이다.

### 평균 DAU / MAU / 월간 도입률
- 아래 Overview 섹션의 동일 항목과 정의가 같다. Executive는 이 값들을 같은 소스에서 그대로
  가져와 보여준다(`activity.js:rollupAdoption`, `queries.js:adoptionLevels`).

### 개발자당 일평균 세션 (Sessions per Developer-Day)
- **정의**: 세션 수 ÷ 활성 개발자 수 ÷ 기간의 일수.
- **계산**: `Executive.jsx`의 `sessionsPerDevDay` — `kpiSummary`(세션)와 `activeUsers`(개발자)를
  클라이언트에서 나눈 값.
- **주의**: 4번.

### 30일 예상 비용 (30-Day Projection)
- **정의**: 일평균 비용 × 30 — 현재 추세를 단순 외삽한 값(예측 모델 아님).
- **계산**: `Executive.jsx`의 `projection30d = dailyAvg * 30`.
- **주의**: 2번, 3번. 짧은 구간일수록 일평균의 변동성이 커 프로젝션도 흔들린다.

### 코드 1,000라인당 비용 (Cost per 1K Lines)
- **정의**: 기간 비용 ÷ (추가 코드 라인 ÷ 1000).
- **계산**: `Executive.jsx`의 `costPerKloc`.
- **주의**: 2번, 3번.

### 일평균 비용 (Daily Average Cost)
- **정의**: 기간 비용 ÷ 기간의 일수.
- **계산**: `Executive.jsx`의 `dailyAvg`.
- **주의**: 2번, 3번.

---

## Overview

### 활성 사용자 (Active Users)
- **정의**: 선택 기간에 세션이 1건 이상 있었던 사용자 수(그룹 무관).
- **원천/계산**: Executive의 "활성 개발자"와 동일 — `queries.js:activeUsers`.
- **주의**: 4번. `model` 필터는 이 지표에 적용되지 않는다(`session.count` 행에 `Model` 속성이
  없음).

### 세션 (Sessions)
- **정의**: 선택 기간의 세션 수 합계(그룹별 합).
- **원천**: `claude_code.session.count`.
- **계산**: `queries.js:kpiSummary`.
- **주의**: 4번.

### 추가 코드 라인 (Lines Added)
- Executive의 "추가 코드 라인"과 동일 — `queries.js:kpiSummary`.

### 전체 토큰 / 입력 토큰 / 출력 토큰 (Total / Input / Output Tokens)
- **정의**: 선택 기간의 토큰 사용량 합계, 방향별(`input`/`output`)로도 분리.
- **원천**: `claude_code.token.usage` (`TokenType` 속성).
- **계산**: `queries.js:kpiSummary`.
- **주의**: 1번, 4번.

### 누적 사용자 (Total Members)
- **정의**: 조직 전체 이력에서 한 번이라도 세션을 실행한 사용자 수(선택 기간과 무관, lookback
  전체).
- **원천**: `claude_code.session.count`.
- **계산**: `queries.js:adoptionLevels`.
- **주의**: 4번.

### 월간 활성 (MAU)
- **정의**: 조회 종료 시점 기준 최근 30일 내 세션이 있었던 사용자 수.
- **원천**: `claude_code.session.count`.
- **계산**: `queries.js:adoptionLevels`(스냅샷), 시계열은 `activity.js:rollupAdoption`
  (당일 포함 trailing 30일 union).
- **주의**: 4번.

### 주간 활성 (WAU)
- **정의**: 조회 종료 시점 기준 최근 7일 내 세션이 있었던 사용자 수.
- **계산**: `queries.js:adoptionLevels`(스냅샷), 시계열은 `activity.js:rollupAdoption`
  (당일 포함 trailing 7일 union).
- **주의**: 4번.

### 일간 활성 (DAU)
- **정의**: 조회 종료 시점(또는 시계열의 해당 날짜) 세션이 있었던 사용자 수.
- **계산**: `queries.js:adoptionLevels`(스냅샷), 시계열은 `activity.js:rollupAdoption`.
- **주의**: 4번.

### DAU/MAU 고착도 (Stickiness)
- **정의**: 일간 활성 사용자 수 ÷ 월간 활성 사용자 수 — 값이 높을수록 월간 사용자 중 많은 비율이
  매일 돌아온다는 뜻. MAU가 0이면 0으로 처리(0으로 나누기 방지).
- **계산**: `activity.js:rollupAdoption`(시계열), Overview 카드는
  `queries.js:adoptionLevels`의 dau/mau로 같은 비율을 재계산.
- **주의**: 4번.

### 캐시 효율 (읽기/쓰기 캐시 비율) (Cache Efficiency)
- **정의**: 입력측 토큰(`input` + `cacheRead` + `cacheCreation`) 중 캐시 읽기(`cacheRead`)와
  캐시 쓰기(`cacheCreation`)가 차지하는 비율.
- **원천**: `claude_code.token.usage` (`TokenType` 속성).
- **계산**: `queries.js:cacheEfficiency`.
- **주의**: 캐시 쓰기(`cacheCreation`)를 분모에서 빼면 안 된다 — 캐시 미스가 실제로는
  `cacheCreation`으로 잡히기 때문에, 빼면 항상 ~100%로 왜곡된다.

### 모델별 토큰 분포 (Token Distribution by Model)
- **정의**: 선택 기간에 모델별로 사용된 토큰 수(입력/출력 분리).
- **원천**: `claude_code.token.usage`.
- **계산**: `queries.js:modelDistribution`.
- **주의**: 1번.

---

## Cost

### 총 비용 (Total Cost)
- Executive의 "기간 비용"과 동일한 원천 — `queries.js:costSummary`, `pricing.js:withComputedCost`.
- **주의**: 2번, 3번, 4번.

### Claude Code 보고 비용 (Reported Cost)
- **정의**: Claude Code 자체가 텔레메트리로 보고하는 근사 비용 — 지출 화면의 기본값이다.
- **원천**: `claude_code.cost.usage`.
- **계산**: `queries.js:costSummary`(`reported_cost`).
- **주의**: 2번. 같은 기간·채널·모델·클라이언트 버전과 수집 범위를 확인하고 비교한다.

### 입력/출력/캐시 읽기/캐시 쓰기 토큰 (Token Breakdown by Type)
- Overview의 "전체 토큰" 계열과 동일한 `claude_code.token.usage` 원천, `TokenType` 속성으로 분리.
- **계산**: `queries.js:costSummary`.
- **주의**: 1번.

### 세션 (Sessions)
- Overview의 "세션"과 동일 — `queries.js:costSummary`(`sessions`).

### 30일 예상 비용 (30-Day Projection)
- Executive의 "30일 예상 비용"과 동일한 정의(일평균 × 30), Cost 페이지 자체 합계 기준으로 재계산.
- **주의**: 2번, 3번.

### 개발자당 비용 (Cost per Developer)
- Executive의 "개발자당 비용"과 동일 — 보고 비용 총계 ÷ `activeUsers`(전체 개발자 수).
- **계산**: `Cost.jsx`의 `spendPerDeveloper`.
- **주의**: 2번, 3번, 4번.

### 사용자당 비용 — 채널별 (Cost per User, by Channel)
- **정의**: 채널별 보고 비용 ÷ 그 채널의 사용자 수 — 채널 간 사용자 수 차이를 상쇄한 비교용 지표.
- **계산**: `Cost.jsx`의 `spendPerUserFor`.
- **주의**: 2번, 3번, 5번(그룹별 인원 합은 전역 uniq보다 클 수 있음).

### 토큰 유형별 비용 / 캐시율 (Cost by Token Type / Cache Reuse Ratio)
- Overview의 "캐시 효율"과 같은 `cache_read_ratio`를 재사용 — `queries.js:cacheEfficiency`.
- 티어별 달러 금액은 토큰 × 단가표의 **계산 추정값**이다. `PRICING_CACHE_WRITE_TTL` 가정을
  표시하며, 보고 비용을 TTL별로 정확히 배분한 값이 아니다.
- 기본 보고 비용 화면에서는 숨기고, **계산 비용 비교**를 켰을 때 별도의 교차검증 영역에
  표시한다. 표의 계산값 열과 Effort의 계산값 병기도 같은 선택을 따른다.
- **주의**: 캐시 쓰기를 분모에서 빼면 안 된다(위 Overview 항목과 동일한 주의).

### Effort 수준별 비용 (Cost by Effort)
- **정의**: `effort`(사고 강도) 속성별 비용 비중 — `effort` 속성이 없는 행은 화면에 `미지정`으로
  묶여 나온다.
- **원천**: `claude_code.cost.usage`.
- **계산**: `queries.js:effortMix`.
- **표시**: `Effort 수준별 보고 비용`의 도넛 합계·범례는 보고 비용을 소수 둘째 자리까지
  표시한다. 원본 수치와 합산 방식은 변경하지 않는다.
- **주의**: 보고값의 수집·클라이언트 버전 한계는 2번과 같다.

---

## Productivity

### 생성된 PR / 추가 코드 라인 (PRs Created / Lines Added)
- Executive·Overview와 동일한 원천 — `queries.js:kpiSummary`.
- **주의**: 4번.

### 제안 수락률 (Suggestion Accept Rate)
- Executive의 "제안 수락률"과 동일 — `queries.js:codeEditDecisions`.

### 수락된 코드 라인 (Lines Accepted, 추정)
- **정의**: 추가 코드 라인 × 제안 수락률 — 실제로 수락된 라인 수를 세는 지표가 아니라, 라인 단위
  수락률 데이터가 없어 라인 총합에 수락률을 곱한 추정치다.
- **계산**: `Productivity.jsx`의 `Math.round(outcomeTotals.loc * acceptRate)`.
- **주의**: 추정치임을 화면에 항상 표시(hint).

### 개발자 활성 시간 / Claude Code 작업 시간 (Active Time / Claude Code Runtime)
- Executive의 "개발자 활성 시간"·"자동화 배율"과 동일한 원천(`active_time.total`,
  `TokenType` = `user`/`cli`) — `queries.js:activeTimeSeries`, `activeTimeSummary`.
- **주의**: 없음.

### 자동화 배율 (Automation Ratio)
- Executive와 동일한 정의(Claude Code 작업 시간 ÷ 개발자 활성 시간).

### 시간당 추가 코드 라인 (Lines per Active Hour)
- **정의**: 추가 코드 라인 ÷ 개발자 활성 시간.
- **계산**: `Productivity.jsx`의 `outcomeTotals.loc / userHours`.
- **주의**: 없음.

### 생산성 점수 상위 10위 (Top 10 by Productivity Score)
- Executive의 "생산성 점수"와 동일한 유저 단위 점수(`productivity.js:withProductivityScore`)를
  내림차순 정렬한 상위 10위.

---

## Users

### 사용자별 생산성 리더보드 (Per-User Productivity Leaderboard)
- 각 컬럼(생산성 점수, 세션, 토큰, 추가 코드 라인, PR, 커밋, 수락률, 활성일)은 위 Executive/
  Productivity 항목과 동일한 원천이며, 유저×그룹 단위로 쪼개서 보여준다.
- **계산**: `queries.js:userLeaderboard`, `productivity.js:withProductivityScore`.
- **주의**: 5번(한 유저가 두 그룹에 걸치면 각 그룹 행에 따로 나타난다).

### 채널 요약 — 사용자/평균 생산성 점수/세션/수락률 (Channel Summary)
- **정의**: 리더보드 행을 그룹별로 묶어 평균낸 요약(수락률은 단순 평균이 아니라
  수락/결정 건수 가중 평균).
- **계산**: `Users.jsx`의 `GroupFaceOff`.
- **주의**: 5번.

### 모델 계열별 사용자당 평균 비용 (Cost per User, by Model Family)
- **정의**: 모델 계열(예: Claude 3.x, 4.x)을 실제로 쓴 사용자 수로 나눈 평균 비용.
- **계산**: `계산 규칙은 \`Users.jsx:familyStats\` 참고` — 분자·분모 모두 단가표에 있는(priced)
  모델 사용 행만으로 계산한다.
- **주의**: 3번. 한 유저가 여러 계열을 쓰면 계열마다 분모에 중복으로 들어간다.

### 사용자별 도구/Skill 사용 내역 (Per-User Tool / Skill Usage)
- **정의**: 사용자별 도구 사용 횟수 / Skill 사용 횟수.
- **원천**: 도구는 `otel_logs`의 툴 사용 이벤트, Skill은 `claude_code.cost.usage`의
  `SkillName` 속성(토큰 시리즈에는 Skill 귀속이 없어 비용 이벤트를 센다).
- **계산**: `queries.js:userToolUsage`, `queries.js:userSkillUsage`.
- **주의**: 5번.

---

## Trends

### DAU / WAU / MAU / DAU-MAU 고착도
- Overview의 동일 이름 항목과 완전히 같은 정의·원천·계산이다 — Trends 페이지는 시계열의
  마지막 포인트 값을 타일로 보여준다(`activity.js:rollupAdoption`).
- **주의**: 4번. `model` 필터는 이 페이지에 적용되지 않는다(`session.count`에 `Model` 속성 없음).

---

## Reliability

이 페이지는 StatTile이 아니라 표(DataTable)로만 지표를 보여준다. 표에 나오는 값(API 응답 시간
p50/p95, refusal 건수, 재시도 소진 건수, 버전 코호트별 세션 수/비용)의 정의는 각 표의 도움말
(help)에 이미 있고, 원천/계산은 다음과 같다: `queries.js:apiLatency`, `queries.js:refusalRate`,
`queries.js:retriesExhausted`, `queries.js:apiErrors`, `queries.js:versionCohortSessions`,
`queries.js:versionCohortCost`. 해당 표는 각각 `API 응답 시간`, `API 거부 응답`, `API 오류율`,
`API 오류 상태 코드 분포`, `Claude Code 버전 분포`, `버전 구간별 Claude Code 보고 비용`다. 이
페이지의 목적 자체가 "A/B 비교를 신뢰해도 되는가"를 확인하는 것이라, 개별 수치보다 그룹 간
비대칭 여부가 핵심이다(표 도움말 참고).

## Usage

이 페이지는 대부분 표로 지표를 보여주지만, `프롬프트 길이`와 `Hook 실행 시간` 카드는 StatTile로
구성된다(도구/MCP 성공률, 커맨드 사용, Skill의 Claude Code 보고 비용, 플러그인 목록 등은 표다).
원천/계산은 `queries.js:toolMcpUsage`, `queries.js:mcpConnectorUsage`,
`queries.js:commandAdoption`, `queries.js:skillUsage`, `queries.js:pluginInventory`,
`queries.js:subagentFanout`, `queries.js:compactionPressure`다. Skill의 "Claude Code 보고
비용"은 `claude_code.cost.usage`의 `SkillName` 속성을 이용한 근사치이고(주의 3번 대상 모델은
여기서도 제외), 나머지는 카운트/비율 지표라 캐치올 주의사항이 따로 붙지 않는다.

## Analytics

"Ask Claude" 채팅 어시스턴트 페이지다. 별도의 KPI 타일이나 표를 그리지 않고, 사용자의 자연어
질문을 받아 Bedrock 기반 에이전트가 직접 읽기 전용 ClickHouse SQL을 작성·실행해 답한다
(`dashboard/server/chat.js`). 이 페이지가 실행 중 참조하는 지표는 위 다른 페이지들과 동일한
원천 테이블(`otel_metrics_sum`, `otel_logs`)이며 별도의 새 정의를 만들지 않는다.
