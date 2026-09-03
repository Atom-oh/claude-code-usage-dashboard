# ADR-006: Client-side e-mail masking as the PII baseline, server-side pseudonyms deferred

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

**Status:** Accepted
**Date:** 2026-09-03

### Context
`PII_MASK_ENABLED` surfaces to the client as `piiMask` on `GET /api/config`, and that single
flag drives two things: the SPA's `maskEmail()` helper wherever an e-mail appears in the UI,
and server-side masking of the `UserEmail` column in the chat sandbox's result rows before
they reach the client. Neither of those touches the API responses themselves — every other
route still returns `UserEmail` verbatim, and roughly ninety pre-existing references to
`UserEmail` exist across the query layer (see ADR-002 for the identity-fallback logic that
column feeds). **The threat model this rests on has to be stated explicitly, because the
masking flag alone reads as more protection than it is:** an authenticated viewer of this
dashboard is already authorised, under ADR-004, to see every row in the dataset. The mask
therefore defends against shoulder-surfing a shared screen, a screenshot ending up somewhere
it shouldn't, or a forwarded CSV export landing in the wrong inbox — it does **not** defend
against a viewer who opens devtools and reads the raw JSON response, because that viewer was
never meant to be kept out in the first place.

### Decision
Keep this client-side/sandbox-only baseline as-is. Do not implement a server-side pseudonym
scheme now. What this decision does record is the upgrade design, so that building it later is
a lookup rather than a fresh design exercise: derive the identity as
`hex(sipHash64Keyed(k0, k1, UserEmail))`, with `k0`/`k1` coming from a new `PII_HANDLE_KEY`
environment variable, and use that hash as the identity everywhere a raw address is used today
— in every API response field **and** in the `user` query filter, where an exact-match lookup
on the hash would replace today's partial (substring) match on the plaintext address. Build it
when the viewer audience actually widens past the single authorised group — concretely, when
SSO with distinct viewer roles lands per ADR-004's upgrade path. The cost is every call site
that currently selects `UserEmail`, plus the per-user drawer key and the filter contract, all
of which would need to switch to the hash.

### Rationale
Under ADR-004's premise that every authenticated viewer is already authorised to see
everything, a server-side pseudonym buys key management (rotating `PII_HANDLE_KEY`, keeping it
consistent across replicas) and a breaking contract change (the `user` filter and the drawer
key both currently round-trip a human-readable address) without changing who can actually see
what. The masking flag is the right place for today's decision because it already exists,
already fails closed, and required no new plumbing: `ConfigContext.jsx` defaults `piiMask` to
`true`, so if `/api/config` itself fails to load, the SPA renders masked rather than falling
open to plaintext.

### Consequences
A determined authenticated viewer can still read e-mail addresses straight from the network
tab — that is accepted here explicitly rather than left to be discovered later and mistaken
for a bug. CSV exports do honour the mask, since they go through the same client-side
formatting path as the UI. How to reverse: implement the `sipHash64Keyed` design recorded
above behind the existing `piiMask` flag — the flag itself, its `/api/config` plumbing, and
every SPA call site that reads it already exist, so the reversal is additive rather than a
rewrite.

### Alternatives considered
(a) A response-boundary masking middleware that rewrites `UserEmail` on the way out of the
server — rejected: it would break the `user` filter's substring match and the per-user
drawer's key, both of which need the real address to round-trip correctly, and a middleware
sitting between the query layer and every route would need to special-case both. (b) Dropping
e-mail addresses from API responses entirely — rejected: it would remove the per-user pages
that are the actual point of the adoption view, since there is no other stable per-user
identity in the telemetry today.

<a id="korean"></a>
## 한국어

**상태:** 채택
**날짜:** 2026-09-03

### 배경
`PII_MASK_ENABLED`는 `GET /api/config`의 `piiMask`로 클라이언트에 노출되고, 이 플래그
하나가 두 가지를 제어한다: SPA에서 이메일이 나타나는 모든 곳에 적용되는 `maskEmail()`
헬퍼, 그리고 챗 샌드박스의 결과 행이 클라이언트에 도달하기 전 서버 쪽에서 `UserEmail`
컬럼을 마스킹하는 처리. 둘 다 API 응답 자체는 건드리지 않는다 — 다른 모든 라우트는
여전히 `UserEmail`을 그대로 반환하며, 쿼리 레이어 전체에 `UserEmail`에 대한 참조가 약
90개 사전에 존재한다(그 컬럼이 먹여주는 identity-fallback 로직은 ADR-002 참고).
**이 결정이 딸린 위협 모델은 명시적으로 적어둬야 한다. 마스킹 플래그만 보면 실제보다
더 강한 보호처럼 읽히기 때문이다:** 이 대시보드의 인증된 뷰어는 ADR-004에 따라 이미
전체 데이터셋의 모든 행을 볼 권한이 있다. 따라서 마스킹은 공유된 화면을 어깨너머로
보는 것, 스크린샷이 엉뚱한 곳에 흘러가는 것, CSV export가 잘못된 수신함으로 전달되는
것을 막기 위한 것이다 — devtools를 열어 원본 JSON 응답을 읽는 뷰어를 막기 위한 것은
**아니다**, 왜냐하면 그 뷰어를 원천적으로 막을 의도가 처음부터 없었기 때문이다.

### 결정
이 클라이언트 측/샌드박스 한정 baseline을 그대로 유지한다. 지금 서버 측 가명화(pseudonym)
스킴을 구현하지 않는다. 이 결정이 기록해 두는 것은 업그레이드 설계다 — 나중에 만들 때
새로 설계하는 대신 참고만 하면 되도록 하기 위함이다: identity를
`hex(sipHash64Keyed(k0, k1, UserEmail))`로 도출하고, `k0`/`k1`은 새 `PII_HANDLE_KEY`
환경변수에서 가져온다. 이 해시를 오늘 원본 주소가 쓰이는 모든 곳 — 모든 API 응답 필드
**그리고** `user` 쿼리 필터 — 에서 identity로 사용한다. 이때 해시에 대한 exact-match
조회가 오늘의 평문 주소에 대한 부분(substring) 매치를 대체하게 된다. 실제로 뷰어 범위가
단일 인가 그룹을 넘어 넓어질 때 — 구체적으로는 ADR-004의 업그레이드 경로에 따라 SSO와
구분된 뷰어 역할이 도입될 때 — 이를 구현한다. 비용은 현재 `UserEmail`을 선택하는 모든
호출부와, 유저별 드로어 키, 필터 계약까지 전부 해시로 전환해야 한다는 점이다.

### 근거
ADR-004의 전제 — 인증된 모든 뷰어가 이미 전체를 볼 권한이 있다는 것 — 아래에서는
서버 측 가명화가 키 관리(`PII_HANDLE_KEY` 로테이션, 레플리카 간 일관성 유지)와
계약 파괴(`user` 필터와 드로어 키 둘 다 지금은 사람이 읽을 수 있는 주소를 그대로
왕복시킨다)를 사는 것일 뿐, 실제로 누가 무엇을 볼 수 있는지는 바꾸지 못한다. 마스킹
플래그가 오늘의 결정이 놓일 올바른 자리인 이유는 이미 존재하고, 이미 fail-closed이며,
새 배선이 필요 없었기 때문이다: `ConfigContext.jsx`는 `piiMask`의 기본값을 `true`로
두므로, `/api/config` 자체가 로드에 실패해도 SPA는 평문으로 새지 않고 마스킹된 상태로
렌더링한다.

### 결과
마음먹은 인증된 뷰어라면 네트워크 탭에서 곧바로 이메일 주소를 읽을 수 있다 — 이는 나중에
버그로 오해되어 발견되기보다, 여기서 명시적으로 받아들여진 것이다. CSV export는 UI와
동일한 클라이언트 측 포맷팅 경로를 거치므로 마스킹을 그대로 따른다. 되돌리는 방법: 위에
기록한 `sipHash64Keyed` 설계를 기존 `piiMask` 플래그 뒤에 구현한다 — 플래그 자체, 그
`/api/config` 배선, 이를 읽는 모든 SPA 호출부가 이미 존재하므로 되돌리기는 재작성이
아니라 추가 작업이 된다.

### 검토한 대안
(a) 서버를 나가는 길에 `UserEmail`을 다시 쓰는 응답 경계 마스킹 미들웨어 — 기각: `user`
필터의 substring 매치와 유저별 드로어의 키 둘 다 실제 주소가 그대로 왕복해야 정상 동작
하는데, 쿼리 레이어와 모든 라우트 사이에 앉는 미들웨어는 이 둘을 각각 특별 처리해야
한다. (b) API 응답에서 이메일 주소를 완전히 제거 — 기각: 오늘 텔레메트리에는 다른 안정적인
유저별 identity가 없으므로, adoption 뷰의 실제 목적인 유저별 페이지 자체가 사라진다.
