# ADR-007: Korean-first UI, i18n deferred to a string table

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

**Status:** Accepted
**Date:** 2026-09-03

### Context
Every UI-facing string in the React SPA is a Korean literal written inline in JSX — there is
no extraction layer, no string table, and no runtime language switch anywhere in
`dashboard/web/src`. This mirrors the rest of the project: every document under `docs/` and
both halves of `README.md` are already bilingual English/Korean, and the audience this
dashboard was built for and is actually used by today is a Korean organisation.

### Decision
Keep the UI Korean-only for now, keep documentation bilingual as it already is, and add no
i18n framework or dependency. If an English UI becomes genuinely necessary later, the recorded
path is: extract strings into one module, `dashboard/web/src/strings.js`, exporting a `t(key)`
lookup function; add a `UI_LANG` server environment variable surfaced through `GET
/api/config` the same way `groupMode` already is; and default that variable to `ko` so an
unset deployment behaves exactly as it does today. **No per-viewer language switch is to be
built until a second language actually has viewers** — the config-driven default is a
deployment-time choice, not a user preference toggle, until there is evidence a toggle is
needed.

### Rationale
Running a full extraction pass across the SPA and adding an i18n dependency now would be a real
cost paid against a hypothetical reader who does not exist yet — every current viewer reads
Korean. Routing the eventual language choice through `/api/config` rather than a build-time
`VITE_` environment flag matters for a reason specific to this project: the container image is
built once and reused unmodified across every deployment (`docs/deploying-for-your-org.md`),
so anything that has to vary per deployment needs to be a runtime config value, not something
baked in at build time — `UI_LANG` needs to follow the same pattern `groupMode` already
established for exactly that reason.

### Consequences
An English-speaking viewer today reads Korean labels throughout the UI while every piece of
documentation about that same UI is available in English — this asymmetry exists now and is
being named rather than left implicit. Every new UI string added before the eventual switch is
one more inline literal that will need to be extracted into the string table later; there is
no ongoing tax beyond that. How to reverse: build the `strings.js` module and `t(key)`
lookup described above — the `/api/config` plumbing it depends on already exists for
`groupMode` and `piiMask`, so wiring in `UI_LANG` follows the same established pattern rather
than inventing a new one.

### Alternatives considered
(a) Adopting `react-i18next` now — rejected: it adds a dependency and requires an immediate
full extraction pass in service of an audience that does not exist today. (b) Building an
English-only UI instead of Korean — rejected: the organisation actually using this dashboard
today reads Korean, and an English-only UI would be a worse fit for the only audience that
currently exists.

<a id="korean"></a>
## 한국어

**상태:** 채택
**날짜:** 2026-09-03

### 배경
React SPA의 모든 UI 문자열은 JSX 안에 인라인으로 쓰인 한국어 리터럴이다 —
`dashboard/web/src` 어디에도 추출 레이어, 문자열 테이블, 런타임 언어 전환 기능이 없다.
이는 프로젝트의 나머지 부분과 궤를 같이한다: `docs/` 아래 모든 문서와 `README.md`의
양쪽 절 모두 이미 영어/한국어 이중 언어이며, 이 대시보드가 만들어진 대상이자 실제로
오늘 사용하는 대상은 한국 조직이다.

### 결정
지금은 UI를 한국어 단일 언어로 유지하고, 문서는 지금처럼 이중 언어를 유지하며, i18n
프레임워크나 의존성을 추가하지 않는다. 나중에 영어 UI가 실제로 필요해지면, 기록해 두는
경로는: `t(key)` 조회 함수를 export하는 모듈 하나(`dashboard/web/src/strings.js`)로 문자열을
추출하고; `groupMode`가 이미 그렇듯 `GET /api/config`를 통해 노출되는 서버 환경변수
`UI_LANG`을 추가하며; 이 변수의 기본값을 `ko`로 두어 값이 설정되지 않은 배포는 오늘과
정확히 동일하게 동작하게 한다. **두 번째 언어에 실제 뷰어가 생기기 전까지는 뷰어별 언어
전환 기능을 만들지 않는다** — config로 결정하는 기본값은 전환이 필요하다는 증거가
나오기 전까지는 사용자 선호 토글이 아니라 배포 시점의 선택이다.

### 근거
지금 SPA 전체에 대한 추출 작업을 돌리고 i18n 의존성을 추가하는 것은, 아직 존재하지 않는
가상의 독자를 위해 실제 비용을 지불하는 일이다 — 지금의 모든 뷰어는 한국어를 읽는다.
언젠가의 언어 선택을 빌드 타임 `VITE_` 환경 플래그가 아니라 `/api/config`를 통해 흘려
보내는 것이 중요한 이유는 이 프로젝트만의 구체적인 사정에 있다: 컨테이너 이미지는 한 번
빌드되어 모든 배포에서 수정 없이 재사용되므로(`docs/deploying-for-your-org.md`),
배포마다 달라져야 하는 값은 빌드 시점에 굳혀지는 것이 아니라 런타임 config 값이어야
한다 — `UI_LANG`도 정확히 같은 이유로 `groupMode`가 이미 세운 패턴을 따라야 한다.

### 결과
오늘 영어를 쓰는 뷰어는 UI 전체에서 한국어 라벨을 읽어야 하는 반면, 같은 UI에 대한 문서는
전부 영어로도 볼 수 있다 — 이 비대칭은 지금 존재하며, 암묵적으로 남기지 않고 여기서
명시한다. 전환 전에 추가되는 새 UI 문자열 하나하나는 나중에 문자열 테이블로 추출해야 할
인라인 리터럴이 하나 늘어나는 것이며, 그 이상의 지속적인 비용은 없다. 되돌리는 방법: 위에
설명한 `strings.js` 모듈과 `t(key)` 조회를 구현한다 — 여기에 필요한 `/api/config` 배선은
`groupMode`와 `piiMask`를 위해 이미 존재하므로, `UI_LANG`을 연결하는 일은 새로운 패턴을
만드는 것이 아니라 이미 자리 잡은 패턴을 따르는 것이다.

### 검토한 대안
(a) 지금 `react-i18next`를 도입 — 기각: 의존성이 추가되고, 아직 존재하지 않는 대상을 위해
즉시 전체 추출 작업이 필요해진다. (b) 한국어 대신 영어 단일 언어 UI를 만드는 것 — 기각:
오늘 이 대시보드를 실제로 쓰는 조직은 한국어를 읽으며, 영어 단일 언어 UI는 현재 존재하는
유일한 대상에게 오히려 더 나쁜 선택이 된다.
