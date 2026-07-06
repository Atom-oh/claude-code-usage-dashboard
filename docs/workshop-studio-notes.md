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

- **판별 규칙**: `UserEmail`(=`ResourceAttributes['user.email']`, 위 1번 항목대로 계정ID 또는 실제 이메일) 단위로 관측된 `model` attribute를 모아, Bedrock 스타일(리전 프리픽스 `us.anthropic.*` 또는 `:` 포함)이 하나라도 있으면 `bedrock`, 아니면 `enterprise`. model이 전혀 없으면 `organization.id` 유무로 fallback. `otel_metrics_sum`에는 `SessionId`가 promoted column으로 없어서(그건 `otel_logs`에만 있음) 세션 단위가 아니라 유저 단위로 판별한다 — 세션 단위 정밀도가 필요해지면 `grouping.js`의 GROUP BY만 `Attributes['session.id']`로 바꾸면 된다.
- CFN 작성 시 [`collector-config.yaml`](../collector-config.yaml)의 `resource` processor(`experiment.group` upsert, env `EXPERIMENT_GROUP` 참조)는 **이 워크샵 시나리오에는 넣지 말거나, 넣어도 대시보드가 무시한다**는 점을 알고 있어야 한다. A/B 테스트를 EC2 그룹 자체로 나누는 다른 시나리오(원래 작업지시서)에서는 그 processor가 맞다.
- Bedrock 그룹 참가자에게는 안내서(워크샵 랩 가이드)에 `export CLAUDE_CODE_USE_BEDROCK=1`(또는 managed-settings의 그룹 A 전용 오버레이)를 별도로 안내한다. 이 값 자체를 텔레메트리 그룹 판별에 쓰지 않는다 — 실제로 무슨 모델을 호출했는지가 진실이다.

## 3. 기존 인프라 파일에서 가져갈 부분

`user-data.sh`는 이미 EC2 Launch Template 시나리오로 작성돼 있다. CFN 템플릿을 새로 쓸 때 그대로 재사용할 부분:

- otelcol-contrib 설치 + systemd 서비스 등록 블록 (`/usr/local/bin/otelcol-contrib`, `/etc/systemd/system/otelcol.service`)
- Claude Code managed-settings 배포 경로: `/etc/claude-code/managed-settings.json` (사용자 홈 `~/.claude/`가 아니라 이 경로여야 우선순위가 보장됨)
- ClickHouse 쓰기 비밀번호는 SSM SecureString에서 런타임에 `aws ssm get-parameter --with-decryption`으로 꺼낸다 — CFN에 평문으로 넣지 않는다.
- `collector-config.yaml`은 S3에서 다운로드하는 대신, 참가자 계정에는 아웃바운드 S3 접근이 제한적일 수 있으니 CFN의 `UserData`에 인라인으로 넣는 것도 검토(참가자 수 대비 파일 크기 작음).

## 4. 배포 후 실측 검증 절차 (필수)

`clickhouse-schema.sql`의 원 작업지시서 STEP 6과 동일하게, 워크샵 참가자 인스턴스 몇 개로 반드시 확인:

1. Collector 생존 확인: `systemctl status otelcol`, `journalctl -u otelcol -n 50`
2. ClickHouse에 두 그룹 데이터가 다 들어오는지: `SELECT ExperimentGroup, MetricName, count() FROM claude_code.otel_metrics_sum GROUP BY ExperimentGroup, MetricName` — 단, 이 워크샵에서는 `ExperimentGroup`(ResourceAttributes 기반)이 아니라 대시보드가 계산하는 그룹을 봐야 한다.
3. attribute 실제 키 이름 실측 (`Attributes`/`LogAttributes`의 `mapKeys`) — Claude Code 버전이 바뀌면 `model`, `session.id`, `decision` 등의 키 이름이 달라질 수 있다. 달라지면 `dashboard/server/grouping.js`와 `dashboard/server/queries.js` 두 파일만 고치면 된다.
4. temporality(`cumulative`) 설정이 실제로 적용됐는지 — 데이터가 안 들어오면 1순위 의심 지점.
5. 프롬프트 본문 유출 여부 (`otel_logs`의 `Body`/`LogAttributes`에 prompt 텍스트가 남아있지 않은지) — FSI 워크샵이면 필수 확인.

## 5. Admin 인프라(이 리포 `infra/`)와 참가자 인프라(워크샵 CFN)의 경계

이번 세션에서 `infra/`에 Terraform으로 admin 쪽 인프라(ClickHouse on EKS, 대시보드, CloudFront/Route53)를 구축했다. 워크샵 CFN을 작성할 때 알아야 할 연결점:

- **엔드포인트**: 참가자 인스턴스의 otelcol이 보낼 곳은 `https://ch.atomai.click`(ClickHouse HTTP ingest), 대시보드는 `https://ccdash.atomai.click`. 둘 다 CloudFront → 내부 NLB → EKS로 들어간다.
- **collector-config.yaml의 exporter 프로토콜을 HTTP로 바꿔야 한다.** CloudFront는 HTTP(S)만 중계한다 — 이 리포의 `collector-config.yaml` 원본은 `endpoint: tcp://${CH_HOST}:${CH_PORT}?secure=true`(네이티브 TCP, 9440)를 쓰는데, 그건 admin과 같은 VPC 안에서 직결할 때만 맞다. 워크샵 참가자는 별도 계정/VPC라 CloudFront를 거쳐야 하므로, exporter를 HTTP 프로토콜로 바꿔 `https://ch.atomai.click:443`을 바라보게 해야 한다(ClickHouse OTel exporter는 HTTP도 지원). CFN에서 이 collector-config를 만들 때 원본을 그대로 복사하지 말고 이 차이를 반영할 것.
- **인증**: NLB의 otel_writer 계정(HTTP Basic Auth)로 인증한다. CloudFront 배포(`aws_cloudfront_distribution.ch_ingest`)는 `AllViewer` origin request policy라 `Authorization` 헤더를 그대로 백엔드까지 전달한다 — CFN의 managed-settings에서 collector-config의 clickhouse exporter에 `headers: {Authorization: "Basic ..."}` 형태로 자격증명을 넣게 될 것(SSM SecureString에서 런타임 조합).
- **admin 인프라는 참가자 계정과 독립**이다(다른 AWS 계정, `AWS-Demo-Platform` 리포의 공유 ALB/인증서와도 별개로 자체 NLB/CloudFront/ACM 데이터소스 참조만 함). 워크샵 CFN 쪽에서 admin 인프라를 만들 필요는 없다 — `ch.atomai.click`/`ccdash.atomai.click`이 이미 떠 있다고 가정하고 참가자 CFN은 그 주소로 나가는 아웃바운드만 신경 쓰면 된다.
- **아직 실제 apply는 하지 않았다** — `terraform plan`까지만 검증(28개 리소스, 에러 없음). 워크샵 배포 전에 `terraform apply`로 실제로 띄우고 4번(배포 후 실측 검증) 절차를 거쳐야 한다.

## 6. 알려진 함정 체크리스트 (원 작업지시서 승계)

- [ ] grpc(4317)를 쓰는데 엔드포인트를 4318(http)로 잘못 지정하면 조용히 실패한다.
- [ ] `session.id`를 attribute로 포함하면(`OTEL_METRICS_INCLUDE_SESSION_ID=true`) cardinality가 커진다. 이 대시보드의 그룹 자동판별은 `UserEmail` 기반이라 이 값을 꺼도 그룹 판별에는 영향 없다(세션 단위로 정밀도를 올리고 싶을 때만 필요).
- [ ] 비용 비교에 `cost.usage`를 쓰지 말 것 — 근사치다. 대시보드의 "토큰 정규화 생산성" 패널로 비교하고, 실비용은 Bedrock Cost Explorer / Anthropic Console에서 별도 산정.
- [ ] `otelcol-contrib` 버전과 ClickHouse exporter의 테이블 스키마가 안 맞으면 `create_schema: true`로 두고 exporter가 만든 테이블명에 스키마를 맞추는 게 빠르다.
