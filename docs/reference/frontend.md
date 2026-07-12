# Frontend / Frontend 구현 상세

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

### 1. Overview
A single React 18 + Vite SPA (`dashboard/web/`) renders 8 pages (Overview, Cost, Productivity,
Users, Trends, Executive, Usage, Analytics) against the `dashboard/server` API, sharing one
global date-range/filter context across every page.

### 2. Components
| Component | Path | Purpose |
|---|---|---|
| Entry/router | `dashboard/web/src/main.jsx`, `App.jsx` | Route table, layout shell |
| Global range state | `dashboard/web/src/RangeContext.jsx` | `from`/`to`/`intervalHours` shared across all pages |
| Global filter state | `dashboard/web/src/FilterContext.jsx` | group/user/model filters shared across all pages |
| Data fetching | `dashboard/web/src/useApi.js` | Auto-forwards range+filters to every endpoint call |
| Pages | `dashboard/web/src/pages/*.jsx` | One file per dashboard page |
| Chart/table components | `dashboard/web/src/components/*.jsx` | `GroupCharts.jsx` (donut/bar/line), `DataTable.jsx`, etc. |
| Formatting helpers | `dashboard/web/src/fmt.js`, `pivot.js`, `colors.js` | Tick formatting, pivot-for-Recharts, group color palette |

### 3. Key Decisions
- **One shared `useApi` hook auto-forwards `from/to/group/user/model/intervalHours`** to every
  endpoint call -- pages only pass endpoint-specific extras, avoiding per-page boilerplate for
  the global filter bar.
- **`intervalHours` resync via `useEffect`, not `useState` initializer** -- a page-local
  granularity control must re-sync when the global range preset changes, or switching from a
  7-day to a 1-day preset leaves charts stuck on daily buckets (a real bug fixed on the Cost
  page).
- No CSS modules, no component library -- Tailwind utility classes directly, matching the
  "workshop tool, not a product" scope in the root `CLAUDE.md`.

### 4. Code Pointers
- `dashboard/web/src/useApi.js` -- shared fetch hook, auto-forwarded params
- `dashboard/web/src/RangeContext.jsx` -- `intervalHours = days <= 2 ? 1 : 24` derivation
- `dashboard/web/src/pages/Cost.jsx` -- largest page; donut group filters, efficiency table
- `dashboard/web/src/pivot.js` -- `pivotByGroup`/`pivotByKey` (row-per-x-tick reshaping for Recharts)
- `dashboard/web/src/components/GroupCharts.jsx` -- shared chart primitives (Donut/Bar/Line)

### 5. Cross-references
- Related modules: [dashboard/web/CLAUDE.md](../../dashboard/web/CLAUDE.md)
- Related ADRs: (none yet)
- Related runbooks: (none yet)

<a id="korean"></a>
## 한국어

### 1. 개요
React 18 + Vite SPA 하나(`dashboard/web/`)가 `dashboard/server` API를 호출해 8개 페이지
(Overview, Cost, Productivity, Users, Trends, Executive, Usage, Analytics)를 렌더링하며, 전역
날짜범위/필터 컨텍스트를 모든 페이지가 공유합니다.

### 2. 구성요소
| 구성요소 | 경로 | 목적 |
|---|---|---|
| 엔트리/라우터 | `dashboard/web/src/main.jsx`, `App.jsx` | 라우트 테이블, 레이아웃 셸 |
| 전역 범위 상태 | `dashboard/web/src/RangeContext.jsx` | 모든 페이지가 공유하는 `from`/`to`/`intervalHours` |
| 전역 필터 상태 | `dashboard/web/src/FilterContext.jsx` | 모든 페이지가 공유하는 group/user/model 필터 |
| 데이터 페칭 | `dashboard/web/src/useApi.js` | 모든 엔드포인트 호출에 범위+필터 자동 전달 |
| 페이지 | `dashboard/web/src/pages/*.jsx` | 대시보드 페이지당 파일 하나 |
| 차트/테이블 컴포넌트 | `dashboard/web/src/components/*.jsx` | `GroupCharts.jsx`(도넛/바/라인), `DataTable.jsx` 등 |
| 포맷 헬퍼 | `dashboard/web/src/fmt.js`, `pivot.js`, `colors.js` | 틱 포맷, Recharts용 피벗, 그룹 색상 팔레트 |

### 3. 주요 결정
- **공유 `useApi` 훅이 모든 엔드포인트 호출에 `from/to/group/user/model/intervalHours`를
  자동 전달** -- 페이지는 엔드포인트별 추가 파라미터만 넘기면 돼서 전역 필터바용 보일러플레이트가
  페이지마다 반복되지 않습니다.
- **`intervalHours` 재동기화는 `useEffect`, `useState` 초기값이 아님** -- 페이지 로컬
  granularity 컨트롤이 전역 범위 프리셋 변경 시 재동기화 안 되면, 7일→1일 프리셋 전환 후에도
  차트가 일간 버킷에 머무릅니다(Cost 페이지에서 실제로 고친 버그).
- CSS 모듈·컴포넌트 라이브러리 없음 -- Tailwind 유틸리티 클래스를 직접 사용, 루트
  `CLAUDE.md`의 "제품이 아니라 워크샵 도구" 범위에 맞춤.

### 4. 코드 포인터
- `dashboard/web/src/useApi.js` -- 공유 fetch 훅, 자동 전달 파라미터
- `dashboard/web/src/RangeContext.jsx` -- `intervalHours = days <= 2 ? 1 : 24` 도출
- `dashboard/web/src/pages/Cost.jsx` -- 가장 큰 페이지; 도넛 그룹 필터, 효율 테이블
- `dashboard/web/src/pivot.js` -- `pivotByGroup`/`pivotByKey`(Recharts용 row-per-x-tick 재구성)
- `dashboard/web/src/components/GroupCharts.jsx` -- 공유 차트 프리미티브(Donut/Bar/Line)

### 5. 상호 참조
- 관련 모듈: [dashboard/web/CLAUDE.md](../../dashboard/web/CLAUDE.md)
- 관련 ADR: (아직 없음)
- 관련 런북: (아직 없음)
