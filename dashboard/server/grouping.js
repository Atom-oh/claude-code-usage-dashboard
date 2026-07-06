// A/B 그룹(bedrock vs enterprise) 판별 규칙 — 실측 후 고칠 지점은 이 파일 하나로 모은다.
//
// Workshop Studio 시나리오에서는 EXPERIMENT_GROUP 환경변수를 EC2에 정적으로 심을 수 없다
// (같은 이미지, 참가자가 로그인 방식을 선택). 그래서 텔레메트리 값으로 사후 판별한다:
//   1순위 — 유저가 실제로 호출한 model 이름이 Bedrock 스타일(리전 프리픽스 or ':' 포함)이면 bedrock
//   2순위 — model 정보가 없으면 organization.id 존재 여부로 enterprise 추정
//   그 외 — unknown (그룹 판별 불가 — 실측 시 attribute 키 이름이 다를 가능성 1순위 의심 지점)
//
// ponytail: session.id 단위가 더 정밀하지만 otel_metrics_sum엔 SessionId가 promoted column으로 없다
// (otel_logs에만 있음). UserEmail(이미 MATERIALIZED)로 묶는 것으로 충분 — 세션 단위가 필요해지면
// Attributes['session.id']로 GROUP BY를 바꾸면 됨.
export const GROUP_CTE = `
WITH user_group AS (
    SELECT
        UserEmail,
        multiIf(
            countIf(Model LIKE '%anthropic.%' OR Model LIKE '%:%') > 0, 'bedrock',
            countIf(ResourceAttributes['organization.id'] != '') > 0, 'enterprise',
            'unknown'
        ) AS grp
    FROM claude_code.otel_metrics_sum
    WHERE UserEmail != ''
    GROUP BY UserEmail
)`;

export const GROUP_EXPR = "coalesce(ug.grp, 'unknown')";
