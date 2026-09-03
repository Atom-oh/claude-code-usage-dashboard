# Runbook: Telemetry & Edge Alerting

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

---

<a id="english"></a>

# English

## Overview
This dashboard has two independent outbound alerting legs. Neither existed when the OTel
collector died on a transient DNS timeout and ~43 hours of telemetry went missing with no error
anywhere — the dashboard stayed healthy and only the data window shrank (see `README.md`
"Telemetry Ingestion"). Leg 1 (in-app data freshness) exists specifically to push that failure
mode somewhere a human will see it instead of waiting for someone to poll `/api/health/data` by
hand. Leg 2 (edge 5xx) covers a different failure: the dashboard itself being unreachable, which
leg 1 structurally cannot report because the process emitting the alert is the thing that would
be down.

## What alerts exist
| Leg | Source | Fires when | Delivery | Gate |
|-----|--------|-------------|----------|------|
| In-app data freshness | `dashboard/server/alerting.js` | `/api/health/data` non-ok for two consecutive 60 s ticks | Slack-compatible `{"text": …}` POST | `ALERT_WEBHOOK_URL` |
| Edge 5xx | CloudWatch `AWS/CloudFront` `5xxErrorRate` | average > 5% for 2 × 5 min periods | SNS e-mail | `var.alert_email` |

## Enable
Set `alert_webhook_url` via `secrets.auto.tfvars` or `-var` — never in
`terraform.tfvars.example`, which is committed. `alert_repeat_minutes` controls how often the
in-app leg repeats while still non-ok (default `60`). Set `alert_email` to gate the CloudFront
5xx alarm. The step everyone forgets: **the recipient must click AWS's SNS subscription
confirmation e-mail, or nothing is ever delivered** — an unconfirmed subscription silently
drops every notification. `terraform apply` rolls the dashboard Deployment once when either
variable changes.

## Message shapes
- `[ccdash] telemetry STALE on <pod>: last row 412 min ago (threshold 360). See docs/runbooks/alerting.md`
  → follow `docs/runbooks/incident-response.md`.
- `[ccdash] telemetry UNKNOWN on <pod>: ClickHouse probe failed or no rows in the probe window. See docs/runbooks/alerting.md`
  → also follow `docs/runbooks/incident-response.md`; UNKNOWN means the probe itself could not
  measure, which is treated exactly like stale on purpose.
- `[ccdash] telemetry recovered on <pod>: last row 3 min ago` → no action; this closes the
  incident.
- A CloudWatch 5xx alarm → roll back per `docs/runbooks/deploy-production.md`.

## Test it
Manually probe the webhook:
```bash
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"text":"[ccdash] test"}' "$ALERT_WEBHOOK_URL"
```
See whether a delivery failed:
```bash
kubectl -n claude-code logs deploy/dashboard | grep -i alert
```
A delivery failure logs `alert webhook failed: <status or error name>`. **The URL is
deliberately absent from that line** — the pod log cannot be used to recover the token even by
someone with log access but not the Secret.

## Expected duplicates
`replicas 2` means two messages per transition, differing only in the pod name. This is
ADR-005's accepted trade-off, not a bug — deduplicating would require a leader-elected sender,
which was rejected as complexity against one duplicate line.

## Silence / disable
Set the variable back to `null` and apply. `alert_webhook_url = null` disables the in-app leg;
`alert_email = null` disables the CloudFront alarm. Each leg disappears independently.

## Notes
- Last verified: 2026-09-03
- Known gap: backup CronJob failures are not alerted on by either leg (see
  `docs/decisions/ADR-005-outbound-webhook-alerting.md` and
  `docs/runbooks/backup-and-restore.md`, which records the same gap).

---

<a id="korean"></a>

# 한국어

## 개요
이 대시보드에는 서로 독립적인 발신 알림 경로가 두 개 있습니다. OTel 컬렉터가 일시적 DNS
타임아웃으로 죽어 ~43시간의 텔레메트리가 아무 에러 없이 사라졌을 때(대시보드는 정상, 데이터
창만 줄어듦 — `README.md` "Telemetry Ingestion" 참고)는 둘 다 존재하지 않았습니다. 1번 경로
(앱 내부 데이터 최신성)는 정확히 그 장애 유형을 누군가 `/api/health/data`를 손으로 폴링하기를
기다리는 대신 사람이 볼 수 있는 곳으로 밀어내기 위해 존재합니다. 2번 경로(엣지 5xx)는 다른
장애를 다룹니다 — 대시보드 자체에 접근할 수 없는 상황이며, 1번 경로는 알림을 보내는 프로세스
자체가 죽어 있을 것이므로 구조적으로 이 장애를 알릴 수 없습니다.

## 어떤 알림이 있는지
| 경로 | 소스 | 발생 조건 | 전달 방식 | 게이트 |
|------|------|-----------|-----------|--------|
| 앱 내부 데이터 최신성 | `dashboard/server/alerting.js` | `/api/health/data`가 60초 틱 2회 연속 non-ok | Slack 호환 `{"text": …}` POST | `ALERT_WEBHOOK_URL` |
| 엣지 5xx | CloudWatch `AWS/CloudFront` `5xxErrorRate` | 5분 주기 2회 연속 평균 > 5% | SNS 이메일 | `var.alert_email` |

## 활성화
`alert_webhook_url`은 `secrets.auto.tfvars` 또는 `-var`로 설정합니다 — 커밋되는
`terraform.tfvars.example`에는 절대 넣지 않습니다. `alert_repeat_minutes`는 non-ok 상태가
지속되는 동안 앱 내부 경로가 재발송하는 간격을 결정합니다(기본값 `60`). `alert_email`을
설정하면 CloudFront 5xx 알람이 활성화됩니다. 누구나 잊어버리는 단계: **수신자가 AWS의 SNS
구독 확인 메일을 클릭해야만 알림이 전달됩니다** — 확인하지 않은 구독은 모든 알림을 조용히
버립니다. 두 변수 중 하나라도 바뀌면 `terraform apply`가 대시보드 Deployment를 한 번
재기동합니다.

## 메시지 형태
- `[ccdash] telemetry STALE on <pod>: last row 412 min ago (threshold 360). See docs/runbooks/alerting.md`
  → `docs/runbooks/incident-response.md`를 따릅니다.
- `[ccdash] telemetry UNKNOWN on <pod>: ClickHouse probe failed or no rows in the probe window. See docs/runbooks/alerting.md`
  → 이것도 `docs/runbooks/incident-response.md`를 따릅니다; UNKNOWN은 프로브 자체가 측정에
  실패했다는 뜻이며, 의도적으로 stale과 동일하게 취급됩니다.
- `[ccdash] telemetry recovered on <pod>: last row 3 min ago` → 조치 불필요; 이 메시지가
  장애를 종료시킵니다.
- CloudWatch 5xx 알람 → `docs/runbooks/deploy-production.md`에 따라 롤백합니다.

## 테스트
웹훅을 수동으로 호출해봅니다:
```bash
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"text":"[ccdash] test"}' "$ALERT_WEBHOOK_URL"
```
전달 실패 여부 확인:
```bash
kubectl -n claude-code logs deploy/dashboard | grep -i alert
```
전달 실패 시 `alert webhook failed: <status or error name>`이 로그에 남습니다. **이 줄에는
의도적으로 URL이 빠져 있습니다** — 로그 접근 권한은 있지만 Secret 접근 권한은 없는 사람이라도
이 로그로 토큰을 복구할 수 없습니다.

## 중복은 정상
`replicas 2`면 전환마다 메시지가 두 개씩 오며, pod 이름만 다릅니다. 이건 ADR-005가 받아들인
트레이드오프이며 버그가 아닙니다 — 중복을 제거하려면 리더 선출 방식의 발신자가 필요한데, 한
줄의 중복 대비 복잡도가 크다는 이유로 기각되었습니다.

## 끄기
변수를 다시 `null`로 설정하고 apply합니다. `alert_webhook_url = null`은 앱 내부 경로를,
`alert_email = null`은 CloudFront 알람을 비활성화합니다. 두 경로는 서로 독립적으로 꺼집니다.

## 참고
- 최종 검증일: 2026-09-03
- 알려진 공백: 백업 CronJob 실패는 두 경로 어느 쪽도 알리지 않습니다
  (`docs/decisions/ADR-005-outbound-webhook-alerting.md`와 같은 공백을 기록한
  `docs/runbooks/backup-and-restore.md` 참고).
