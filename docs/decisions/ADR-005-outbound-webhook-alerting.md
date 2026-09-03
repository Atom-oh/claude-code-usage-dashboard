# ADR-005: Outbound webhook alerting for telemetry staleness, plus an edge 5xx alarm

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

**Status:** Accepted
**Date:** 2026-09-03

### Context
The incident this decision responds to already happened once: the OTel collector died on a
transient DNS timeout and roughly 43 hours of telemetry silently went missing, as recorded in
`README.md`'s "Telemetry Ingestion" section. Nothing was down in the way an on-call rotation
would notice — the dashboard stayed healthy and reachable, and only the visible data window
kept shrinking, because nobody happened to look. `GET /api/health/data` already classifies the
newest `otel_metrics_sum` row into `ok`, `stale`, or `unknown` and answers HTTP 503 for the
latter two, but before this decision that classification only reached a browser tab that
happened to be open and polling. It pushed nothing anywhere on its own.

### Decision
Two independent legs, covering two different failure surfaces. The first is an in-process
timer in `dashboard/server/alerting.js`, ticking every 60 seconds: it debounces on two
consecutive non-ok ticks before sending anything, repeats every `ALERT_REPEAT_MINUTES` while
the state stays non-ok, and sends exactly one recovery message when it returns to ok. Messages
post as a Slack-compatible `{"text": …}` JSON body to a URL read from a Kubernetes Secret
(`dashboard-alert`); that URL is never written to a log line anywhere in `alerting.js`. The
second leg is an optional CloudWatch alarm on the dashboard's CloudFront distribution watching
`5xxErrorRate`, wired to an SNS topic that e-mails an address supplied via `var.alert_email`
(`infra/alerting.tf`); it is gated on that variable being set, so it is opt-in per deployment.

### Rationale
The data-freshness leg was cheap to add because the hard part — the freshness probe and its
30-second memoized result — already existed for `/api/health/data`; alerting only needed a
timer loop and a POST on top of a classification the server already computes. The edge alarm
covers a different failure mode that the in-process leg structurally cannot see: if the
dashboard process itself is down, nothing inside it can page anyone. Debouncing two consecutive
ticks before the first send matters more than it looks: a rolling deployment where a new pod
starts before ClickHouse is reachable, or a single transient DNS hiccup, would otherwise fire
an alert on every rollout. An alert channel nobody trusts gets muted or ignored, and the next
genuine 43-hour gap goes unnoticed exactly like the first one did — which is the failure this
decision exists to prevent.

### Consequences
Because each server replica runs its own independent timer and its own independent state, N
replicas produce N messages per state transition, distinguished only by the pod hostname
embedded in the message text — this is accepted deliberately rather than solved with
leader election. Coverage is strictly telemetry staleness plus edge 5xx; it does **not**
include backup CronJob failures, and that gap is being named here on purpose rather than
implied to be covered. The webhook URL itself is a secret that lives in Terraform state and in
a Kubernetes Secret, so both need the same handling as any other credential. How to reverse:
set `alert_webhook_url` and `alert_email` back to `null` in the tfvars and apply — both legs
disappear, and the server's boot path is unaffected either way, because `startAlertLoop` is
only invoked when a webhook URL is present.

### Alternatives considered
(a) A Kubernetes CronJob curling `/api/health/data` on a schedule — rejected: that route sits
behind Basic Auth like everything else (ADR-004), so a CronJob would need the same credential
stored in a second place for no real benefit over a timer already running inside the server
that computes the classification firsthand. (b) A CloudWatch Synthetics canary — rejected on
cost, and it would need the same Basic Auth credential the CronJob option does. (c)
Prometheus/Alertmanager — rejected: there is no Prometheus deployment in this cluster, and
standing one up purely for this would be disproportionate. (d) A leader-elected single sender
to avoid duplicate messages — rejected: the complexity of leader election is a poor trade
against one duplicate line per replica in a chat channel.

<a id="korean"></a>
## 한국어

**상태:** 채택
**날짜:** 2026-09-03

### 배경
이 결정이 대응하는 장애는 이미 한 번 실제로 일어났다: OTel 컬렉터가 일시적인 DNS 타임아웃으로
죽었고, 약 43시간 분량의 텔레메트리가 아무 소리 없이 사라졌다 — `README.md`의 "Telemetry
Ingestion" 절에 기록된 그대로다. 온콜 로테이션이 알아챌 만한 방식으로 무언가가 "다운"된 것은
아니었다 — 대시보드는 계속 정상이고 접근도 가능했으며, 단지 화면에 보이는 데이터 창이 계속
줄어들 뿐이었는데, 마침 아무도 들여다보지 않았을 뿐이다. `GET /api/health/data`는 이미 가장
최신 `otel_metrics_sum` 행을 `ok`/`stale`/`unknown`으로 분류하고 뒤의 두 경우 HTTP 503을
응답하지만, 이 결정 이전에는 그 분류 결과가 마침 열려서 폴링 중인 브라우저 탭에만 전달됐다.
스스로 어디에도 밀어내지 않았다.

### 결정
서로 독립적인 두 경로로 서로 다른 두 장애 표면을 커버한다. 첫 번째는
`dashboard/server/alerting.js` 안의 인프로세스 타이머로, 60초마다 틱한다: 연속으로 두 번
non-ok가 나올 때까지 발송을 디바운스하고, non-ok 상태가 유지되는 동안
`ALERT_REPEAT_MINUTES`마다 반복 발송하며, ok로 복귀할 때 복구 메시지를 정확히 한 번 보낸다.
메시지는 Kubernetes Secret(`dashboard-alert`)에서 읽은 URL로 Slack 호환
`{"text": …}` JSON 바디로 POST되며, 그 URL은 `alerting.js`의 어떤 로그 줄에도 절대 쓰이지
않는다. 두 번째 경로는 대시보드 CloudFront 배포의 `5xxErrorRate`를 감시하는 선택적 CloudWatch
알람으로, `var.alert_email`로 지정된 주소로 메일을 보내는 SNS 토픽에 연결된다
(`infra/alerting.tf`); 이 변수가 설정된 경우에만 동작하므로 배포별로 옵트인이다.

### 근거
데이터 신선도 경로는 추가 비용이 적었다 — 어려운 부분인 신선도 프로브와 그 30초 메모이제이션
결과는 `/api/health/data`를 위해 이미 존재했고, 알림은 서버가 이미 계산해 둔 분류 결과 위에
타이머 루프와 POST 하나만 얹으면 됐다. 엣지 알람은 인프로세스 경로가 구조적으로 볼 수 없는
다른 실패 모드를 커버한다: 대시보드 프로세스 자체가 죽어 있다면, 그 프로세스 내부의 무엇도
누군가를 호출할 수 없다. 첫 발송 전에 연속 두 틱을 디바운스하는 것은 보이는 것보다 중요하다:
새 파드가 ClickHouse에 아직 도달하지 못한 상태로 뜨는 롤링 배포나, 일시적인 DNS 딸꾹질만으로도
매 롤아웃마다 알림이 울릴 수 있기 때문이다. 아무도 신뢰하지 않는 알림 채널은 결국 묵음
처리되거나 무시되고, 그러면 이 결정이 막으려던 것과 똑같은 진짜 43시간짜리 공백도 다시
놓치게 된다.

### 결과
각 서버 레플리카가 각자 독립된 타이머와 독립된 상태를 돌리기 때문에, N개 레플리카는 상태
전환마다 N개의 메시지를 만들며, 메시지 텍스트에 실린 파드 hostname으로만 구분된다 —
리더 선출로 해결하지 않고 의도적으로 받아들인 결과다. 커버리지는 엄격히 텔레메트리 신선도와
엣지 5xx **뿐**이다; 백업 CronJob 실패는 **포함하지 않으며**, 그 공백을 여기서 의도적으로
명시해 둔다. 웹훅 URL 자체는 Terraform 상태와 Kubernetes Secret에 존재하는 비밀이므로, 다른
자격 증명과 동일하게 다뤄야 한다. 되돌리는 방법: tfvars에서 `alert_webhook_url`과
`alert_email`을 다시 `null`로 두고 apply한다 — 두 경로 모두 사라지며, `startAlertLoop`은
웹훅 URL이 존재할 때만 호출되므로 서버의 부팅 경로는 어느 경우든 영향을 받지 않는다.

### 검토한 대안
(a) `/api/health/data`를 주기적으로 curl하는 Kubernetes CronJob — 기각: 그 라우트도 다른
모든 것과 마찬가지로 Basic Auth 뒤에 있어서(ADR-004), CronJob이 같은 자격 증명을 또 다른
곳에 저장해야 하는데, 이미 그 분류를 직접 계산하는 서버 내부 타이머에 비해 얻는 이득이 없다.
(b) CloudWatch Synthetics 캐너리 — 비용 때문에 기각, 게다가 CronJob 안과 동일한 Basic Auth
자격 증명이 또 필요하다. (c) Prometheus/Alertmanager — 기각: 이 클러스터에는 Prometheus
배포가 없고, 이것만을 위해 새로 세우는 것은 과도하다. (d) 중복 메시지를 피하기 위한 리더
선출 단일 발신자 — 기각: 채팅 채널의 레플리카당 중복 한 줄에 비해 리더 선출의 복잡도는
좋은 거래가 아니다.
