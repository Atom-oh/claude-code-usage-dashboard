---
workflow: product-launch-video
flow: automation
storyboard: no
message: "Claude Code 사용량을 텔레메트리로 실측해 bedrock vs enterprise를 나란히 비교한다"
destination: web-hero
aspect: 1920x1080
language: ko
length: 30s
angle: product-demo
---

## Intent

claude-code-usage-dashboard 문서 사이트(gh-pages)의 히어로에 얹을 무음 데모 루프.
Claude Code가 OTel로 내보낸 메트릭을 ClickHouse에 모아 비용·도입·생산성 KPI로 보여주는
내부 대시보드가 실제로 어떻게 생겼는지 30초 안에 훑어준다. 마케팅 과장 없이, 실제 화면과
실제 측정 수치로만 — 워크샵 참가자 72명, 2일치 데이터가 근거다.

## Assets

- ../assets/img/overview.png — Overview(KPI 타일 + 그룹별 요약). 오프닝 제품 리빌.
- ../assets/img/executive.png — Executive 원페이지(PEOPLE/PRODUCTIVITY/COST 3단). 요약 비트.
- ../assets/img/cost.png — Cost(계산 비용, 캐시 티어별 도넛 2개). 비용 비트.
- ../assets/img/users.png — Users(bedrock vs enterprise 나란히 + Top10 리더보드). A/B 비교 비트.
- ../assets/img/analytics.png — Analytics(AI 에이전트가 ClickHouse 직접 조회). 마지막 훅.

## Customizations

- 무음: 나레이션 없음, BGM 없음 (`music: none` + SCRIPT.md 없음) — 문서 사이트 히어로에서
  자동재생 루프로 돌기 때문에 소리가 나면 안 된다.
- 화면 위에 얹는 수치 자막은 전부 스크린샷에 실제로 보이는 값만 사용한다(지어내지 않음).

## Notes

- 리더보드 유저 라벨은 워크샵 참가자 AWS 계정 ID라 이미 dev-NN@ws / eng-NN@ws로 익명화한
  스크린샷을 쓴다. 원본(repo의 screenshot/)은 영상에 넣지 않는다.
- 대시보드는 basic auth 뒤에 있어 라이브 크롤이 불가 — capture는 no-capture 경로.
- 팔레트는 제품 UI를 따른다: bedrock = 파랑(#6183F0 계열), enterprise = 초록(#3F9C79 계열),
  캔버스는 밝은 회백(#F4F6F9), 잉크는 #0F172A 계열.
