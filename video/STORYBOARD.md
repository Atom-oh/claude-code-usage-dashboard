---
format: 1920x1080
duration: 28s
message: "Claude Code 사용량을 텔레메트리로 실측해 bedrock vs enterprise를 나란히 비교한다"
arc: Hook → Product → A/B proof → Cost → Agent → Outro
audience: 워크샵 참가자와 내부 이해관계자 (문서 사이트 방문자)
mode: autonomous
music: none
---

## Video direction

무음 히어로 루프. 소리가 없으니 리듬은 전부 모션이 만든다 — 각 프레임은 0.4s 안에 히어로를
세우고, 이후 남은 시간에 조각을 계속 얹는다(front-load 금지). 카메라는 절제: 프레임당 한 번의
push 또는 pan만, 흔들림·회전 남용 없음.

캔버스는 제품 UI와 같은 밝은 회백(#F4F6F9), 카드는 흰색 + 얇은 회색 테두리. 강조색은 제품의
그룹 색을 그대로 쓴다 — bedrock 파랑 #6183F0, enterprise 초록 #3F9C79. 잉크 #0F172A.

**화면에 얹는 글자는 전부 라틴 문자/숫자만 쓴다.** 한글은 스크린샷 이미지 안에만 존재한다 —
렌더 머신은 클린 headless Chrome이라 한글 웹폰트 파일이 없고, 이름만 지정하면 조용히 대체
폰트로 떨어져 타이포가 깨진다(frame-worker 계약). 폰트는 번들된 Inter만 사용.

수치는 전부 스크린샷에 실제로 찍힌 값이다(2026-07-26~28, 2일):
유저 72 · 세션 1,587 · 라인 46,539 · 토큰 405,422,042 · 계산 비용 $507.88 ·
수락률 98% · bedrock 58.1 vs enterprise 48.1 · $/1K LOC $11 · 30일 프로젝션 $7,618.

## Frame 1 — Hook: 405M tokens, measured

- scene: 텅 빈 회백 화면에서 405,422,042가 카운트업하며 커진다
- duration: 4s
- transition_in: cut
- status: animated
- blueprint: dataviz-countup
- focal: 토큰 카운터
- roles: counter=hero, eyebrow=context, sublabel=proof
- assets: none
- src: compositions/frames/01-hook.html

Scene 1 (0.0–0.6s): 빈 캔버스에 eyebrow `MEASURED, NOT ESTIMATED`가 왼쪽에서
`waterfall-entry`로 들어온다. 동시에 중앙에 카운터 `0`이 `spring-pop-entrance`로 선다
(히어로는 0.5s 안에 화면에 있어야 한다).
Scene 2 (0.6–2.4s): 카운터가 `counting-dynamic-scale`로 0 → 405,422,042까지 오른다 —
값이 커질수록 scale이 1.0 → 1.12로 함께 자라 압박감을 만든다. `tabular-nums` 고정폭.
뒤에서 `ambient-glow-bloom`이 파란 광이 은은히 피어오른다(peak opacity 0.35 이하).
Scene 3 (2.4–3.2s): 카운터 아래 `TOKENS · 2 DAYS · 72 DEVELOPERS`가 단어별
`waterfall-entry`로 도착한다.
Scene 4 (3.2–4.0s): 전체가 `viewport-change`로 아주 살짝(scale 1.0 → 1.04) 다가오며 정지.
카운터 색은 bedrock 파랑, 라벨은 muted gray.

## Frame 2 — The dashboard itself

- scene: Overview 화면이 떠 있는 창으로 들어오고 KPI 타일에 카메라가 다가간다
- duration: 5s
- transition_in: crossfade
- status: animated
- blueprint: device-surface-showcase
- focal: Overview 스크린샷
- roles: window=hero, eyebrow=label, callouts=proof
- assets: assets/overview.png
- src: compositions/frames/02-product.html

Scene 1 (0.0–0.8s): `assets/overview.png`이 살짝 아래에서 올라오며 흰 카드(반경 14px,
얇은 회색 테두리, 부드러운 그림자) 안에 앉는다 — `spring-pop-entrance`, 오버슈트는 약하게
(제품 화면이라 장난스러우면 안 된다). 창 위쪽에 eyebrow `THE DASHBOARD`.
Scene 2 (0.8–2.2s): `viewport-change`로 KPI 타일 행(창 상단 좌측)으로 천천히 push —
scale 1.0 → 1.35, 타일 행이 프레임 중앙으로 온다. 나머지 영역은
`depth-of-field-blur`로 blur 0 → 3px 물러난다.
Scene 3 (2.2–3.4s): 타일 위에 콜아웃 칩 3개가 `spring-pop-entrance` 스태거(≤0.4s)로
붙는다 — `72 USERS`, `1,587 SESSIONS`, `46,539 LINES`. 칩은 흰 배경 + 파란 테두리.
Scene 4 (3.4–5.0s): 카메라가 `viewport-change`로 그룹별 KPI 표(창 하단)로 pan하며
scale 1.35 → 1.15로 살짝 물러나고, blur가 0으로 풀린다. 표의 bedrock/enterprise 행 위에
파랑·초록 하이라이트 밴드가 `stat-bars-and-fills`의 progress fill(scaleX)로 그려진다.

## Frame 3 — bedrock vs enterprise

- scene: 두 그룹 카드가 양쪽에서 기울어져 들어와 점수를 나란히 세운다
- duration: 5s
- transition_in: cut
- status: animated
- blueprint: comparison-split
- focal: 두 장의 그룹 카드
- roles: left-card=bedrock, right-card=enterprise, badges=payoff
- assets: assets/users.png
- src: compositions/frames/03-ab.html

Scene 1 (0.0–0.7s): 카드 두 장이 각자 화면 바깥에서 `split-tilt-cards`로 들어온다 —
왼쪽은 rotationY +12° → 0°, 오른쪽은 −12° → 0°. 왼쪽 카드는 파란 4% 틴트(bedrock),
오른쪽은 초록 4% 틴트(enterprise). 각 카드 머리에 그룹명(라틴 소문자 그대로 `bedrock` /
`enterprise`).
Scene 2 (0.7–2.0s): 각 카드 안에서 인원 수가 `counting-dynamic-scale`로 오른다 —
왼쪽 `52`, 오른쪽 `65`. 그 아래 세션 수 `602` / `755`가 `waterfall-entry`로 도착.
Scene 3 (2.0–3.4s): 생산성 점수 바가 `stat-bars-and-fills` 성장 바로 자란다 —
bedrock `58.1`, enterprise `48.1`(0–100 스케일, 숫자는 바 끝에서 카운트업).
Scene 4 (3.4–5.0s): 두 카드 안쪽 모서리에 `98% ACCEPT` 배지가 양쪽 동시에
`spring-pop-entrance`로 튀어나온다 — 수락률은 두 그룹이 동일하다는 게 이 비트의 요점.
카드는 `sine-wave-loop`로 아주 약하게(±4px) 위상 반대로 떠 있는다.

## Frame 4 — What it costs

- scene: 비용 타일이 쏟아져 쌓이고 캐시 티어 도넛으로 카메라가 파고든다
- duration: 5s
- transition_in: crossfade
- status: animated
- blueprint: grid-card-assemble
- focal: $507.88 타일
- roles: tiles=grid, donuts=evidence
- assets: assets/cost.png
- src: compositions/frames/04-cost.html

Scene 1 (0.0–0.5s): eyebrow `WHAT IT COSTS`가 좌상단에 `waterfall-entry`로 들어오고,
동시에 히어로 타일(`$507.88`)이 중앙에 `spring-pop-entrance`로 선다.
Scene 2 (0.5–1.8s): 히어로 타일 오른쪽·아래로 보조 타일 3개가 스태거(≤0.45s)로
자기 자리에 조립된다 — `$7,618 / 30d`, `$7.05 / DEV`, `$11 / 1K LOC`. 흰 카드 + 얇은
테두리, 숫자는 파랑 700.
Scene 3 (1.8–3.0s): 히어로 타일의 금액이 `counting-dynamic-scale`로 $0 → $507.88까지
오른다(소수 2자리 고정).
Scene 4 (3.0–5.0s): 타일 그리드가 blur 뒤로 물러나고(`depth-of-field-blur`),
`assets/cost.png`의 캐시 티어별 도넛 두 개가 있는 영역으로 `coordinate-target-zoom`이
파고든다 — 도넛 위에 `91.7%` / `94.0%` 캐시율 칩이 마지막에 `spring-pop-entrance`.

## Frame 5 — Ask it in plain language

- scene: 질문이 타이핑되고 에이전트가 표로 답한다
- duration: 5.5s
- transition_in: cut
- status: animated
- blueprint: prompt-type-submit-generate
- focal: 프롬프트 입력 → 답변 표
- roles: input=trigger, answer=payoff
- assets: assets/analytics.png
- src: compositions/frames/05-agent.html

Scene 1 (0.0–0.5s): 중앙에 흰 입력 카드가 `spring-pop-entrance`로 선다. 위쪽 eyebrow
`ASK IT IN PLAIN LANGUAGE`.
Scene 2 (0.5–2.3s): 입력 카드 안에서 질문이 `discrete-text-sequence`로 타이핑된다 —
`compare cost: bedrock vs enterprise`. 캐럿은 `context-sensitive-cursor`로 blink.
Scene 3 (2.3–3.0s): 전송 — 입력 카드가 `physics-press-reaction`으로 눌리고, 상태 칩
`running SQL…`이 `spring-pop-entrance`로 뜬다.
Scene 4 (3.0–5.5s): 입력 카드 아래로 답변 표가 자란다 — 행 4개가 `waterfall-entry`
스태거로 도착한다(`bedrock $286.61`, `enterprise $221.28`, `opus $6.81 / user`,
`haiku $0.04 / user`). 표 뒤 배경으로 `assets/analytics.png`가 12% 불투명도로 흐릿하게
깔려(blur 6px) 이게 실제 제품 화면임을 암시한다. 표 왼쪽 끝에 파랑 4px 규칙선.

## Frame 6 — Outro

- scene: 제품 이름과 문서 사이트 주소가 조용히 자리를 잡는다
- duration: 3.5s
- transition_in: crossfade
- status: animated
- blueprint: titlecard-reveal
- focal: 제품 이름
- roles: title=hero, sub=where, dot=brand
- assets: none
- src: compositions/frames/06-outro.html

Scene 1 (0.0–0.6s): 파랑 원형 마크(`CC`)가 중앙 위에 `spring-pop-entrance`로 선다.
Scene 2 (0.6–1.6s): 아래로 제목 `Claude Code Usage Dashboard`가 단어별
`waterfall-entry`로 조립된다(Inter 700, 잉크색).
Scene 3 (1.6–2.5s): 그 아래 얇은 회색 규칙선이 `stat-bars-and-fills` progress fill로
좌→우로 그려지고, 이어서 서브라인 `bedrock vs enterprise · OTel → ClickHouse`가
fromTo로 올라온다.
Scene 4 (2.5–3.5s): 마지막 프레임이므로 정지 대신 아주 느린 settle 허용 —
`ambient-glow-bloom`이 마크 뒤에서 한 번 피고, 전체가 scale 1.0 → 1.02로 숨을 고르며 끝.
