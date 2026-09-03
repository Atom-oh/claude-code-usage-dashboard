# ADR-004: Basic Auth as the shipped baseline, with an edge-side SSO upgrade path

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

**Status:** Accepted
**Date:** 2026-09-03

### Context
`dashboard/server/index.js` runs a fail-closed Basic Auth middleware: the server refuses to
boot without both `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` set, unless the operator opts
into `AUTH_ALLOW_INSECURE=1`, which logs one loud warning on every start rather than failing
silently insecure. The only bypass is the `AUTH_BYPASS_PATHS` set, which covers exactly
`/healthz` and `/readyz` — kubelet's liveness/readiness probes send no `Authorization` header
at all, so those two routes have to be reachable unauthenticated or the pod never becomes
Ready. `GET /api/health/data` is deliberately **not** in that bypass set: whether ingestion is
current is operational information worth gating behind the same credential as everything
else, not something to expose for free.

There is exactly one shared credential pair in this deployment. It is set once via
`var.dashboard_basic_auth_user` / `var.dashboard_basic_auth_password` in `infra/dashboard.tf`,
which materializes it into a Kubernetes Secret that the Deployment mounts as environment
variables. CloudFront is the only public ingress path (`infra/dns_cdn.tf`, terminating into a
VPC origin that forwards to an internal NLB) — there is no direct route to the pod that skips
Basic Auth. Because the credential is shared, there is no per-user identity anywhere in the
request path and therefore no per-viewer audit trail: every request looks the same regardless
of who is actually at the keyboard.

### Decision
Basic Auth remains the shipped baseline for a single-organisation, internal-audience
deployment. Credential rotation is a three-step manual procedure: update the tfvars value,
run `terraform apply` to push the new Secret, then roll the Deployment so pods pick it up
(`docs/runbooks/deploy-production.md`). No automatic rotation exists.

The upgrade path, when one is needed, is deliberately pushed to the edge rather than into the
Express app, so the server itself stays auth-agnostic: front the dashboard with an
organisation's own OIDC identity provider, or with a Cognito User Pool configured with
`AllowAdminCreateUserOnly = true`, using either an ALB `authenticate-oidc` listener rule
(CloudFront → ALB → Service) or a Lambda@Edge function. **Self-service sign-up is forbidden by
policy regardless of which upgrade path is chosen: accounts are admin-created or invited only,
and no "Sign up" UI is to be built.** That is a hard constraint on any future auth work here,
not a preference that a later owner can quietly relax. Once an edge sits in front, Basic Auth
either stays on as a second factor between the edge and the pod, or is retired in favour of
the middleware trusting a signed header the edge attaches after authenticating the user.

### Rationale
Today's audience is one ops/leadership group inside a single organisation, and every member of
that group is authorised to see the entire dataset — there is no viewer who should see less
than another viewer. A shared secret is an acceptable cost under that premise, because
splitting identities would buy an audit trail without changing what any authenticated party
can actually access. ADR-006 rests on this same "every authorised viewer sees everything"
premise for its PII-masking threat model; the two decisions should be read together, and
widening the audience in a way that breaks one likely breaks the other's assumption too.

### Consequences
There is no per-viewer audit trail — a request cannot be attributed to an individual, only to
"someone with the shared credential." A leaked credential grants full read access to every
KPI, cost breakdown, and per-user drawer until it is rotated. Rotation itself is documented but
entirely manual, so it depends on someone actually running the three steps above. How to
reverse: put an OIDC-aware component at the edge (ALB `authenticate-oidc` or Lambda@Edge) in
front of CloudFront's origin, and either keep Basic Auth active as a second factor or change
the Express middleware to trust a signed identity header from that edge component instead —
neither path requires touching the ClickHouse query layer.

### Alternatives considered
(a) `express-openid-connect` inside the server — rejected for now: it would put IdP client
configuration and secrets inside the application image, require building a login/callback flow
in the React SPA, and effectively double the auth surface the server has to get right. (b) A
Cognito Hosted UI driven directly from the SPA — rejected for the same reasons, plus it pushes
token storage and refresh handling into client-side code that does not exist today. (c) An IP
allow-list in place of any credential — rejected: workshop and conference-room participants
move between networks, and an allow-list would lock out legitimate viewers more often than it
would stop anyone determined.

<a id="korean"></a>
## 한국어

**상태:** 채택
**날짜:** 2026-09-03

### 배경
`dashboard/server/index.js`는 fail-closed 방식의 Basic Auth 미들웨어를 실행한다: `BASIC_AUTH_USER`와
`BASIC_AUTH_PASSWORD`가 둘 다 설정되지 않으면 서버는 기동을 거부하며, 운영자가
`AUTH_ALLOW_INSECURE=1`을 명시적으로 선택한 경우에만 예외가 허용되는데 이때도 매 기동마다
큰 경고 로그를 남긴다 — 조용히 비보안 상태로 넘어가지 않는다. 인증을 우회하는 경로는
`AUTH_BYPASS_PATHS`에 정의된 `/healthz`, `/readyz` 두 개뿐이다 — kubelet의 liveness/readiness
프로브는 `Authorization` 헤더를 아예 보내지 않으므로, 이 둘은 인증 없이 접근 가능해야만 파드가
Ready 상태로 전환될 수 있다. `GET /api/health/data`는 의도적으로 이 우회 목록에 **포함되지
않는다**: 인제스트가 최신인지 여부는 그 자체로 운영 정보이며, 다른 모든 것과 동일한 자격
증명 뒤에 두는 것이 맞다는 판단이다.

이 배포에는 공유 자격 증명 한 쌍만 존재한다. `infra/dashboard.tf`의
`var.dashboard_basic_auth_user` / `var.dashboard_basic_auth_password`로 한 번 설정되며, 이는
쿠버네티스 Secret으로 구체화되어 Deployment가 환경변수로 마운트한다. CloudFront가 유일한
퍼블릭 인그레스 경로다(`infra/dns_cdn.tf`, VPC origin을 거쳐 내부 NLB로 전달) — Basic Auth를
건너뛰고 파드에 직접 도달하는 경로는 없다. 자격 증명이 공유되기 때문에 요청 경로 어디에도
사용자별 신원이 존재하지 않고, 따라서 사용자별 감사 기록도 없다: 실제로 누가 키보드
앞에 있는지와 무관하게 모든 요청이 동일하게 보인다.

### 결정
단일 조직, 내부 대상 배포에 대해서는 Basic Auth를 그대로 baseline으로 유지한다. 자격 증명
교체는 수동 3단계 절차다: tfvars 값을 갱신하고, `terraform apply`로 새 Secret을 반영한 뒤,
Deployment를 롤링해 파드가 새 값을 읽게 한다(`docs/runbooks/deploy-production.md`). 자동
로테이션은 존재하지 않는다.

업그레이드 경로가 필요해질 때는 Express 앱이 아니라 의도적으로 엣지 쪽에 둔다 — 그래야
서버 자체는 인증 방식에 무관한 상태를 유지한다: 조직 자체의 OIDC IdP나, 또는
`AllowAdminCreateUserOnly = true`로 구성한 Cognito User Pool을, ALB의 `authenticate-oidc`
리스너 규칙(CloudFront → ALB → Service)이나 Lambda@Edge 함수를 통해 앞에 둔다. **어떤 업그레이드
경로를 택하든 자가 회원가입은 정책상 금지된다: 계정은 관리자 생성/초대로만 만들어지며
"Sign up" UI는 만들지 않는다.** 이는 나중에 조용히 완화할 수 있는 선호가 아니라, 향후 인증
작업 전체에 걸리는 강한 제약이다. 엣지가 앞에 서면, Basic Auth는 엣지-파드 사이의 2차
인증으로 계속 남거나, 엣지가 인증 후 붙이는 서명된 헤더를 미들웨어가 신뢰하는 방식으로
대체될 수 있다.

### 근거
현재 대상은 단일 조직 내 하나의 운영/리더십 그룹이며, 그 그룹의 모든 구성원은 전체
데이터셋을 볼 권한이 있다 — 다른 뷰어보다 적게 봐야 하는 뷰어가 없다. 이 전제 아래에서는
공유 비밀이 받아들일 만한 비용이다: 신원을 분리해도 실제로 누가 무엇을 볼 수 있는지는
바뀌지 않고 감사 기록만 얻기 때문이다. ADR-006도 PII 마스킹의 위협 모델에서 "인증된
모든 뷰어가 모든 것을 본다"는 동일한 전제에 의존한다 — 두 결정은 함께 읽어야 하며, 한쪽의
전제를 깨는 방향으로 대상 범위를 넓히면 다른 쪽의 전제도 함께 깨질 가능성이 높다.

### 결과
사용자별 감사 기록이 없다 — 요청을 특정 개인에게 귀속시킬 수 없고, "공유 자격 증명을 가진
누군가"로만 알 수 있다. 자격 증명이 유출되면 교체 전까지 모든 KPI, 비용 breakdown, 유저별
드로어에 대한 전체 읽기 권한이 노출된다. 교체 절차 자체는 문서화되어 있지만 전적으로
수동이라, 실제로 위 3단계를 누군가 수행하는지에 달려 있다. 되돌리는 방법: CloudFront의
origin 앞에 OIDC 인지 컴포넌트(ALB `authenticate-oidc` 또는 Lambda@Edge)를 두고, Basic Auth를
2차 인증으로 유지하거나 Express 미들웨어가 그 엣지 컴포넌트가 붙인 서명된 신원 헤더를
신뢰하도록 바꾼다 — 두 경로 모두 ClickHouse 쿼리 레이어는 건드릴 필요가 없다.

### 검토한 대안
(a) 서버 내부에 `express-openid-connect` 도입 — 현재는 기각: IdP 클라이언트 설정과 비밀을
애플리케이션 이미지 안에 두게 되고, React SPA에 로그인/콜백 플로우를 새로 구현해야 하며,
서버가 책임져야 할 인증 표면이 실질적으로 두 배가 된다. (b) SPA에서 직접 구동하는 Cognito
Hosted UI — 같은 이유로 기각, 게다가 오늘은 존재하지 않는 클라이언트 측 토큰 저장/갱신
처리를 새로 넣어야 한다. (c) 자격 증명 대신 IP 허용 목록만 사용 — 기각: 워크샵/회의실
참가자들은 네트워크를 자주 옮겨 다니므로, 허용 목록은 의도한 공격자를 막기보다 정당한
뷰어를 더 자주 차단할 것이다.
