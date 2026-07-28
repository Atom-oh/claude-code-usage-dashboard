# Asset inventory

라이브 크롤 없음(대시보드가 basic auth 뒤에 있음) — 사용자가 직접 캡처한 실제 화면 7장이
유일한 소재다. 리더보드에 노출된 워크샵 참가자 AWS 계정 ID는 `dev-NN@ws` / `eng-NN@ws`로
익명화한 뒤 옮겼다(원본은 영상/사이트에 쓰지 않는다).

| asset | 무엇 | 영상에서 쓸 곳 |
| --- | --- | --- |
| `assets/overview.png` | Overview — KPI 타일 8개(유저 72 · 세션 1,587 · 라인 46,539 · 토큰 405M) + 도입/고착도 + 그룹별 KPI 표(bedrock/enterprise/unknown) | 오프닝 제품 리빌 |
| `assets/executive.png` | Executive 원페이지 — PEOPLE / PRODUCTIVITY / COST 3단 타일 + 자동 생성 요약 문장 | 요약 비트 |
| `assets/executive-charts.png` | 같은 Executive 하단 — 일간 활성 유저 라인 + 일별 지출(모델별) 스택 바 | 차트 인서트 |
| `assets/cost.png` | Cost — 계산 비용 $507.88, 캐시 읽기/쓰기 토큰, 캐시 티어별 도넛 2개(bedrock $287 / enterprise $221) | 비용 비트 |
| `assets/productivity.png` | Productivity — 작성 라인 46,539 · 수락률 98% + 사용자별 Top10 바(익명 라벨) | 생산성 비트 |
| `assets/users.png` | Users — bedrock 52명/58.1점 vs enterprise 65명/48.1점 나란히 + Top10 리더보드 2열 + 모델 계열별 사용자당 지출 | A/B 비교 비트 |
| `assets/analytics.png` | Analytics — AI 에이전트가 ClickHouse를 직접 조회해 표로 답하는 대화 화면 | 마지막 훅 |

브랜드 신호: 제품 UI 자체가 브랜드다 — 밝은 회백 캔버스(#F4F6F9), 카드는 흰색 + 얇은 회색
테두리, bedrock은 파랑(#6183F0), enterprise는 초록(#3F9C79), 잉크는 거의 검정(#0F172A).
타이포는 시스템 산세리프(Inter 계열) 한 종류, 숫자가 크고 굵다.
