# Workshop Studio 배포 시 고려사항

이 문서는 AWS Workshop Studio용 CloudFormation 템플릿을 작성할 때(별도 세션에서, Claude Code로) 참고할 체크리스트다. 이번 세션에서는 CFN 템플릿을 만들지 않았다 — 대시보드(`dashboard/`)와 이 문서만 산출물이다.

## 배경

Workshop Studio는 참가자마다 독립된 AWS 계정 하나를 발급한다. 참가자는 그 계정 안에서 CloudFormation으로 배포된 동일한 EC2 이미지를 받는다. 참가자의 절반은 `CLAUDE_CODE_USE_BEDROCK=1`로 Bedrock을 쓰고, 나머지 절반은 Claude Code에 Claude Enterprise 계정으로 로그인해서 쓴다. 두 그룹 모두 같은 OTel 텔레메트리 스키마를 내보내며, 이 리포의 대시보드(`dashboard/`)가 두 그룹을 비교한다.

## 1. 유저 식별 — AWS 계정 ID를 이메일 자리에 주입

Workshop Studio 참가자는 계정 1개 = 참가자 1명이 보장된다. CFN 템플릿의 user-data(또는 managed-settings 배포 로직)에서 `${AWS::AccountId}`를 이메일 자리에 넣으면 별도 매핑 없이 참가자를 구분할 수 있다.

```yaml
# CFN 템플릿 안, user-data를 Fn::Sub로 렌더링할 때
OTEL_RESOURCE_ATTRIBUTES: !Sub "user.email=${AWS::AccountId}@ws"
```

**주의 — 실측 필요:** Claude Enterprise 그룹은 로그인 시 Claude Code가 실제 사용자 이메일로 `user.email`(또는 동가 attribute)을 덮어쓸 수 있다. 배포 후 [`clickhouse-schema.sql`](../clickhouse-schema.sql) 6-3 절차대로 실제 값을 확인하고, 덮어써진다면 그건 오히려 더 정확한 식별자이므로 그대로 두면 된다. 계정 ID 주입은 "덮어쓰기가 안 되는 경우"의 안전망이다.

## 2. 그룹(bedrock/enterprise) 구분은 서버가 자동 판별한다 — env로 굽지 말 것

이 워크샵 시나리오에서는 참가자 본인이 로그인 방식을 선택하므로, 인스턴스 부팅 시점에 `EXPERIMENT_GROUP=bedrock|enterprise`를 정적으로 심는 게 불가능하다(같은 이미지, 같은 CFN 파라미터를 모든 참가자가 받음). 이번 대시보드는 이 문제를 텔레메트리 값으로 그룹을 사후 판별하는 방식으로 해결했다 — 상세 로직은 `dashboard/server/grouping.js` 참고.

- **판별 규칙**: `SessionId` 단위로 관측된 `Model` 값을 모아, Bedrock 스타일(`%anthropic.%` 또는 `:` 포함)이 하나라도 있으면 `bedrock`, `organization.id` attribute가 있으면 `enterprise`, 아니면 `unknown`. **세션(SessionId) 단위 판별이다** — 인증 방식은 세션 시작 시 고정되고 도중 안 바뀌므로 세션 그레인이 정확하다(실측 2026-07-07: 유저 단위로 하면 한 유저가 15세션 중 3개만 bedrock이어도 OR 휴리스틱이 유저 전체를 bedrock으로 덮어씀). `SessionId`는 `otel_metrics_sum`(ALTER로 추가)·`otel_logs`(원래 스키마) 양쪽에 promoted column이라 스키마 변경 없이 조회된다. 상세는 `dashboard/server/grouping.js`의 `GROUP_CTE` 참고.
- CFN 작성 시 [`collector-config.yaml`](../collector-config.yaml)의 `resource` processor(`experiment.group` upsert, env `EXPERIMENT_GROUP` 참조)는 **이 워크샵 시나리오에는 넣지 말거나, 넣어도 대시보드가 무시한다**는 점을 알고 있어야 한다. A/B 테스트를 EC2 그룹 자체로 나누는 다른 시나리오(원래 작업지시서)에서는 그 processor가 맞다.
- Bedrock 그룹 참가자에게는 안내서(워크샵 랩 가이드)에 `export CLAUDE_CODE_USE_BEDROCK=1`(또는 managed-settings의 그룹 A 전용 오버레이)를 별도로 안내한다. 이 값 자체를 텔레메트리 그룹 판별에 쓰지 않는다 — 실제로 무슨 모델을 호출했는지가 진실이다.

## 3. 기존 인프라 파일에서 가져갈 부분

`user-data.sh`는 이미 EC2 Launch Template 시나리오로 작성돼 있다. CFN 템플릿을 새로 쓸 때 그대로 재사용할 부분:

- otelcol-contrib 설치 + systemd 서비스 등록 블록 (`/usr/local/bin/otelcol-contrib`, `/etc/systemd/system/otelcol.service`) —
  **반드시 `Restart=always` + `RestartSec` 짧게(5s)를 포함해야 한다.** 실측(2026-07-07): 개발 환경에서
  otelcol을 로그인 쉘에서 foreground로 띄운 채 방치했다가, ClickHouse endpoint DNS 조회가 한 번
  일시적으로 타임아웃(`i/o timeout`)나면서 프로세스가 그대로 죽었고, 재시작 로직이 없어 그 뒤
  43시간 동안 텔레메트리가 전혀 안 들어갔다(대시보드는 에러 없이 "데이터가 갈수록 줄어드는" 것처럼만
  보임 — 필터/쿼리 버그로 오인하기 쉽다). 참가자 인스턴스가 수백 대인 워크샵에서 이 실패 모드가
  퍼지면 발표 중 그룹별 데이터가 조용히 마르는 것과 동일하다. README.md "Telemetry Ingestion" 절의
  유닛 파일을 그대로 쓸 것 — `Type=simple` + `Restart=always`가 핵심이고, `UserData`에 맨 `&`
  백그라운드나 `nohup`으로만 띄우는 방식은 이 결함을 그대로 재현하므로 금지.
- Claude Code managed-settings 배포 경로: `/etc/claude-code/managed-settings.json` (사용자 홈 `~/.claude/`가 아니라 이 경로여야 우선순위가 보장됨)
- ClickHouse 쓰기 비밀번호는 SSM SecureString에서 런타임에 `aws ssm get-parameter --with-decryption`으로 꺼낸다 — CFN에 평문으로 넣지 않는다.
- `collector-config.yaml`은 S3에서 다운로드하는 대신, 참가자 계정에는 아웃바운드 S3 접근이 제한적일 수 있으니 CFN의 `UserData`에 인라인으로 넣는 것도 검토(참가자 수 대비 파일 크기 작음).

## 4. 배포 후 실측 검증 절차 (필수)

`clickhouse-schema.sql`의 원 작업지시서 STEP 6과 동일하게, 워크샵 참가자 인스턴스 몇 개로 반드시 확인:

1. Collector 생존 확인: `systemctl status otelcol`, `journalctl -u otelcol -n 50`. `systemctl status`가
   `active (running)`이어도 ClickHouse로의 export가 죽어있을 수 있으니(예: DNS 장애 후 재시도
   루프만 도는 상태), 반드시 신선도까지 확인한다: `SELECT max(TimeUnix) FROM
   claude_code.otel_metrics_sum` (또는 `otel_logs`의 `max(Timestamp)`)가 `now()`와 몇 분 이상
   벌어져 있으면 실질적으로 죽은 것 — collector.log의 최근 에러(`dial tcp: ... i/o timeout` 등)를
   확인하고 `systemctl restart otelcol`.
2. ClickHouse에 두 그룹 데이터가 다 들어오는지: `SELECT ExperimentGroup, MetricName, count() FROM claude_code.otel_metrics_sum GROUP BY ExperimentGroup, MetricName` — 단, 이 워크샵에서는 `ExperimentGroup`(ResourceAttributes 기반)이 아니라 대시보드가 계산하는 그룹을 봐야 한다.
2b. **시간별 rollup(`otel_metrics_sum_hourly`) 신선도·완전성 — 대시보드가 실제로 읽는 테이블**
   (`dashboard/server/queries.js`의 `incFlat`/`incBucketed`/`GROUP_CTE`는 원본이 아니라 이
   rollup만 읽는다). MV(`otel_metrics_sum_hourly_mv`)는 생성 "이후" insert만 반영하므로,
   기존 클러스터에 새로 적용했다면 과거 데이터가 rollup에 없을 수 있다 — 반드시 확인:
   - `hour`는 `toStartOfHour`라 정상 상태에서도 `now()`와 최대 59분+ 벌어져 보인다 —
     `now()`와 직접 비교하면 healthy한 MV를 stale로 오판한다(리뷰에서 MAJOR로 확인).
     `SELECT max(hour) >= toStartOfHour(now()) FROM claude_code.otel_metrics_sum_hourly`가
     `0`(false)이면 그때 진짜 stale — MV가 안 돌고 있는 것(원본은 신선한데 rollup만 정지).
   - rollup이 비어 있으면 `min(hour)`가 `1970-01-01`(ClickHouse의 빈 테이블 `min(DateTime)`
     기본값)을 반환해 "백필 완료"로 오판할 수 있다(리뷰에서 확인 — `backfill-hourly-rollup.sh`는
     이미 `count()=0`으로 이 경우를 먼저 걸러낸다). 먼저 `SELECT count() FROM
     claude_code.otel_metrics_sum_hourly`로 비어있지 않은지 확인한 뒤,
     `SELECT min(hour) FROM claude_code.otel_metrics_sum_hourly` vs
     `SELECT min(toStartOfHour(TimeUnix)) FROM claude_code.otel_metrics_sum`을 비교한다 —
     rollup의 min이 원본의 min보다 늦으면 백필이 안 된 것. `scripts/backfill-hourly-rollup.sh`를
     1회 실행(`clickhouse-schema.sql`의 백필 절차 주석 참고).
3. attribute 실제 키 이름 실측 (`Attributes`/`LogAttributes`의 `mapKeys`) — Claude Code 버전이 바뀌면 `model`, `session.id`, `decision` 등의 키 이름이 달라질 수 있다. 달라지면 `dashboard/server/grouping.js`와 `dashboard/server/queries.js` 두 파일만 고치면 된다.
4. temporality — 운영 설정은 `cumulative`(30초마다 세션 누적값 export)다. 초기엔 대시보드 쿼리가 전부 `sum(Value)`라 세션이 길수록 토큰/비용/세션 수가 배수로 과대집계되는 버그가 있었지만(실측: 1600억 토큰), `queries.js`를 세션(`session.id`)별 경계 diff(구간 끝 누적값 - 구간 시작 직전 누적값, Prometheus increase()와 동일 원리)로 재작성해 delta/cumulative 둘 다 정확히 처리한다. `SELECT DISTINCT AggregationTemporality FROM claude_code.otel_metrics_sum`로 2(cumulative)가 나오는 게 정상이며, delta(1) 데이터가 섞여도(레거시 배포 등) 문제없다.
5. 프롬프트 본문 유출 여부 (`otel_logs`의 `Body`/`LogAttributes`에 prompt 텍스트가 남아있지 않은지) — FSI 워크샵이면 필수 확인.
6. ClickHouse reader grant 실효성 (Ask Claude SSRF 2차 방어 — 1차 방어는 `chat.js`의
   `sanitizeSql`이 앱 계층에서 직접 강제하지만, 이 grant는 그 우회 시나리오의 최후 방어선이다):
   - `otel_reader`로 접속해 `SHOW GRANTS FOR otel_reader`를 실행 — `GRANT SELECT ON
     claude_code.*`만 보여야 한다. 아무 grant도 안 보이면 operator가 `infra/clickhouse.tf`의
     `otel_reader/grants/query`(`<grants>` config)를 렌더하지 않은 것 — apply 재확인.
   - `SELECT * FROM url('http://example.com', 'CSV', 'x String')`를 실행하면 `ACCESS_DENIED`가
     나야 정상이다. 통과하면 grant가 실제로 적용되지 않은 것.
   - `SELECT * FROM system.query_log LIMIT 1`도 `ACCESS_DENIED`가 나야 한다 — claude_code 외
     DB 접근이 막혀 있는지 별도 확인(system DB는 `sanitizeSql`도 앱 계층에서 이미 거부하지만,
     grant까지 걸려 있으면 defense-in-depth가 이중이 된다).
7. Ask Claude 챗의 권한 경계 — `run_sql`은 basic auth 통과자 전원에게 `claude_code.*`의 전
   컬럼(`UserEmail`, `Attributes` 등 raw telemetry 포함)을 읽기 허용한다. 컬럼별 마스킹은 없다
   — 이 대시보드의 다른 curated API(리더보드 등)도 같은 단일 공유 크리덴셜 뒤에서 전체 유저
   이메일을 노출하므로 새 권한 확대가 아니라 기존 "basic auth = 단일 admin 신뢰" 설계의
   연장이다(의도된 설계). 워크샵 참가자에게 챗 접근을 개별로 나눠줄 계획이면 이 가정이
   깨지므로 그 전에 aggregate/컬럼 allowlist 도입이 필요하다.

## 5. Admin 인프라(이 리포 `infra/`)와 참가자 인프라(워크샵 CFN)의 경계

이번 세션에서 `infra/`에 Terraform으로 admin 쪽 인프라(ClickHouse on EKS, 대시보드, CloudFront/Route53)를 구축했다. 워크샵 CFN을 작성할 때 알아야 할 연결점:

- **엔드포인트**: 참가자 인스턴스의 otelcol이 보낼 곳은 `https://ch.atomai.click`(ClickHouse HTTP ingest), 대시보드는 `https://ccdash.atomai.click`. 둘 다 CloudFront → 내부 NLB → EKS로 들어간다.
- **collector-config.yaml의 exporter 프로토콜을 HTTP로 바꿔야 한다.** CloudFront는 HTTP(S)만 중계한다 — 이 리포의 `collector-config.yaml` 원본은 `endpoint: tcp://${CH_HOST}:${CH_PORT}?secure=true`(네이티브 TCP, 9440)를 쓰는데, 그건 admin과 같은 VPC 안에서 직결할 때만 맞다. 워크샵 참가자는 별도 계정/VPC라 CloudFront를 거쳐야 하므로, exporter를 HTTP 프로토콜로 바꿔 `https://ch.atomai.click:443`을 바라보게 해야 한다(ClickHouse OTel exporter는 HTTP도 지원). CFN에서 이 collector-config를 만들 때 원본을 그대로 복사하지 말고 이 차이를 반영할 것.
- **인증**: NLB의 otel_writer 계정(HTTP Basic Auth)로 인증한다. CloudFront 배포(`aws_cloudfront_distribution.ch_ingest`)는 `AllViewer` origin request policy라 `Authorization` 헤더를 그대로 백엔드까지 전달한다 — CFN의 managed-settings에서 collector-config의 clickhouse exporter에 `headers: {Authorization: "Basic ..."}` 형태로 자격증명을 넣게 될 것(SSM SecureString에서 런타임 조합).
- **admin 인프라는 참가자 계정과 독립**이다(다른 AWS 계정, `AWS-Demo-Platform` 리포의 공유 ALB/인증서와도 별개로 자체 NLB/CloudFront/ACM 데이터소스 참조만 함). 워크샵 CFN 쪽에서 admin 인프라를 만들 필요는 없다 — `ch.atomai.click`/`ccdash.atomai.click`이 이미 떠 있다고 가정하고 참가자 CFN은 그 주소로 나가는 아웃바운드만 신경 쓰면 된다.
- **아직 실제 apply는 하지 않았다** — `terraform plan`까지만 검증(에러 없음). `infra/`는 EKS/ClickHouse operator/대시보드 배포/Bedrock IRSA(role·policy·ServiceAccount)/DNS·CDN 리소스로 구성 — 하드코딩된 리소스 개수는 무관한 TF 편집에도 드리프트하므로 남기지 않는다. apply 전 `terraform plan`으로 add/change/destroy 개수를 그때그때 확인한다. 워크샵 배포 전에 `terraform apply`로 실제로 띄우고 4번(배포 후 실측 검증) 절차를 거쳐야 한다.
- **Ask Claude 챗(Bedrock) 배포 전제**: 대시보드의 Ask Claude 기능은 Bedrock을 호출하므로 아래가 갖춰져야 뜬다(안 그러면 대시보드는 떠도 챗만 `AccessDenied`/timeout이 난다).
  - **Bedrock model access 활성화**: admin 계정에서 `CHAT_MODEL_ID`(기본 `global.anthropic.claude-sonnet-5` — `global.` 프리픽스가 붙은 global inference profile) 모델의 access를 켠다. 파드에는 `AWS_REGION = var.region`(기본 `ap-northeast-2`)가 항상 주입되므로 — 코드 fallback은 us-east-1이지만 Terraform 배포에선 쓰이지 않는다 — **`var.region`(ap-northeast-2) 기준으로 이 global 프로파일이 가용해야 한다.** us-east-1만 켜면 파드가 ap-northeast-2로 호출해 `AccessDenied`/timeout이 난다.
  - **IRSA**: `infra/dashboard.tf`가 파드 ServiceAccount에 `bedrock:InvokeModel*` 최소권한 role을 붙인다(`aws_iam_role.dashboard_bedrock`). 신규 IAM role/policy + SA annotation 리소스가 추가됐다. inference-profile ARN은 `var.chat_model_id` 하나로 좁혀지고, foundation-model ARN은 여기서 리전 프리픽스를 떼어 파생한다(global 프로파일 특성상 리전은 와일드카드).
  - **env / 모델 변경**: 모델을 바꾸려면 `var.chat_model_id` 변수 하나만 고치면 env(`CHAT_MODEL_ID`)와 IAM policy ARN이 함께 반영된다(코드/IAM 두 곳 수동 동기화 불필요). `AWS_REGION`은 `var.region`.
  - **베이스 이미지**: `node:24-alpine`(AWS SDK v3 deprecation 대응) — Node 20에서 올리면 SDK 경고가 뜬다.
  - **ClickHouse 권한**: `otel_reader`에 `GRANT SELECT ON claude_code.*`만 부여돼(`infra/clickhouse.tf`) 챗이 만드는 SQL이 테이블 함수/system DB에 닿아도 서버 측에서 거부된다(sanitizeSql SSRF 방어의 defense-in-depth).

## 6. 알려진 함정 체크리스트 (원 작업지시서 승계)

- [ ] grpc(4317)를 쓰는데 엔드포인트를 4318(http)로 잘못 지정하면 조용히 실패한다.
- [ ] **`session.id` attribute는 필수다(`OTEL_METRICS_INCLUDE_SESSION_ID=true`).** 이 대시보드의 그룹 자동판별(§2)이 `SessionId` 단위로 동작하고 `grouping.js`의 `GROUP_CTE`가 `WHERE SessionId != ''`를 요구하므로, 끄면 세션 판별이 붕괴해 **모든 그룹이 `unknown`으로 떨어진다.** cardinality는 커지지만 이 워크샵에선 필수 전제. (`SessionId`는 `otel_metrics_sum`·`otel_logs` 양쪽에 promoted column.)
- [ ] 비용 비교에 `cost.usage`를 쓰지 말 것 — 근사치다. 대시보드의 "토큰 정규화 생산성" 패널로 비교하고, 실비용은 Bedrock Cost Explorer / Anthropic Console에서 별도 산정.
- [ ] `otelcol-contrib` 버전과 ClickHouse exporter의 테이블 스키마가 안 맞으면 `create_schema: true`로 두고 exporter가 만든 테이블명에 스키마를 맞추는 게 빠르다.
