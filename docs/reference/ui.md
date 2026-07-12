# UI / UI 구현 상세

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

### 1. Overview
Visual design is Tailwind utility classes plus a small set of shared presentational
components (Card, StatTile, Badge, SegmentedControl, DataTable, GroupCharts) reused across
every page, giving the dashboard a consistent look without a component library.

### 2. Components
| Component | Path | Purpose |
|---|---|---|
| Card / layout primitives | `dashboard/web/src/components/Card.jsx` | Card shell, `Loading`, `ErrorBox` states |
| StatTile | `dashboard/web/src/components/StatTile.jsx` | KPI number tile (label/value/hint/variant) |
| Badge | `dashboard/web/src/components/Badge.jsx` | Tone-based inline badge (positive/negative/neutral) |
| SegmentedControl | `dashboard/web/src/components/SegmentedControl.jsx` | Tab-style toggle (used for group filters, interval switches) |
| DataTable | `dashboard/web/src/components/DataTable.jsx` | Sortable table with per-column render functions |
| GroupCharts | `dashboard/web/src/components/GroupCharts.jsx` | `DonutBreakdown`, `SeriesBarChart`, `GroupBarChart`, `DualLineChart`, `HBarList` |
| Global chrome | `dashboard/web/src/components/PageHeader.jsx`, `RangePicker.jsx` | Page title/subtitle, date-range picker |
| Color system | `dashboard/web/src/colors.js`, `useChartColors.js` | Group color palette, CSS-variable-based chart colors |

### 3. Key Decisions
- **Chart color palette is CSS-variable-based (`useChartColors`)**, not hardcoded hex --
  lets the whole dashboard support light/dark or per-workshop theming from one place.
- **DonutBreakdown's `$` formatter special-cases values under $10** (2 decimal places) instead
  of always rounding -- rounding hid small cache-tier costs as "$0" on short date ranges.
- Every chart/table component accepts a `right` prop slot for a `SegmentedControl` -- lets
  pages add per-card filters (e.g., Cost page's bedrock/enterprise donut tabs) without changing
  the shared component's API.

### 4. Code Pointers
- `dashboard/web/src/components/GroupCharts.jsx` -- `DonutBreakdown` (`fmt` formatter, `right` slot)
- `dashboard/web/src/components/DataTable.jsx` -- `compareValues()` (null-safe, numeric-aware sort)
- `dashboard/web/src/components/SegmentedControl.jsx` -- shared tab control
- `dashboard/web/src/useChartColors.js` -- CSS-variable chart color hook
- `dashboard/web/src/index.css` -- Tailwind base + CSS variables

### 5. Cross-references
- Related modules: [dashboard/web/CLAUDE.md](../../dashboard/web/CLAUDE.md)
- Related ADRs: (none yet)
- Related runbooks: (none yet)

<a id="korean"></a>
## 한국어

### 1. 개요
시각 디자인은 Tailwind 유틸리티 클래스와, 모든 페이지가 재사용하는 공유 프레젠테이션
컴포넌트 소수(Card, StatTile, Badge, SegmentedControl, DataTable, GroupCharts)로 구성돼
컴포넌트 라이브러리 없이도 일관된 룩을 유지합니다.

### 2. 구성요소
| 구성요소 | 경로 | 목적 |
|---|---|---|
| Card/레이아웃 프리미티브 | `dashboard/web/src/components/Card.jsx` | Card 셸, `Loading`, `ErrorBox` 상태 |
| StatTile | `dashboard/web/src/components/StatTile.jsx` | KPI 숫자 타일(label/value/hint/variant) |
| Badge | `dashboard/web/src/components/Badge.jsx` | tone 기반 인라인 배지(positive/negative/neutral) |
| SegmentedControl | `dashboard/web/src/components/SegmentedControl.jsx` | 탭 스타일 토글(그룹 필터, interval 전환에 사용) |
| DataTable | `dashboard/web/src/components/DataTable.jsx` | 컬럼별 render 함수를 가진 정렬 가능 테이블 |
| GroupCharts | `dashboard/web/src/components/GroupCharts.jsx` | `DonutBreakdown`, `SeriesBarChart`, `GroupBarChart`, `DualLineChart`, `HBarList` |
| 전역 크롬 | `dashboard/web/src/components/PageHeader.jsx`, `RangePicker.jsx` | 페이지 제목/부제, 날짜 범위 선택기 |
| 색상 시스템 | `dashboard/web/src/colors.js`, `useChartColors.js` | 그룹 색상 팔레트, CSS 변수 기반 차트 색상 |

### 3. 주요 결정
- **차트 색상 팔레트는 하드코딩 hex가 아니라 CSS 변수 기반(`useChartColors`)** -- 대시보드
  전체가 한 곳에서 라이트/다크 또는 워크샵별 테마를 지원할 수 있게 함.
- **DonutBreakdown의 `$` 포맷터는 $10 미만 값을 특별 처리**(소수 2자리) -- 무조건 반올림하면
  짧은 기간의 소액 캐시 티어 비용이 전부 "$0"으로 숨겨졌습니다.
- 모든 차트/테이블 컴포넌트가 `SegmentedControl`을 위한 `right` prop 슬롯을 받음 -- 공유
  컴포넌트 API를 바꾸지 않고도 페이지별 카드 필터(예: Cost 페이지의 bedrock/enterprise
  도넛 탭)를 추가할 수 있게 함.

### 4. 코드 포인터
- `dashboard/web/src/components/GroupCharts.jsx` -- `DonutBreakdown`(`fmt` 포맷터, `right` 슬롯)
- `dashboard/web/src/components/DataTable.jsx` -- `compareValues()`(null-safe, 숫자 인식 정렬)
- `dashboard/web/src/components/SegmentedControl.jsx` -- 공유 탭 컨트롤
- `dashboard/web/src/useChartColors.js` -- CSS 변수 차트 색상 훅
- `dashboard/web/src/index.css` -- Tailwind 베이스 + CSS 변수

### 5. 상호 참조
- 관련 모듈: [dashboard/web/CLAUDE.md](../../dashboard/web/CLAUDE.md)
- 관련 ADR: (아직 없음)
- 관련 런북: (아직 없음)
