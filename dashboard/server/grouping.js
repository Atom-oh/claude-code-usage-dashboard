// A/B 그룹(bedrock vs enterprise) 판별 규칙 — 실측 후 고칠 지점은 이 파일 하나로 모은다.
//
// Workshop Studio 시나리오에서는 EXPERIMENT_GROUP 환경변수를 EC2에 정적으로 심을 수 없다
// (같은 이미지, 참가자가 로그인 방식을 선택). 그래서 텔레메트리 값으로 사후 판별한다:
//   1순위 — 유저가 실제로 호출한 model 이름이 Bedrock 스타일(anthropic. 포함 또는 ':' 포함)이면 bedrock
//   2순위 — model 정보가 없으면 organization.id 존재 여부로 enterprise 추정
//   그 외 — unknown
//
// 실측 확인(2026-07-06, 실제 claude 세션 — bedrock: ctrust 별칭, enterprise: 직접 로그인):
//   - bedrock model 예: "global.anthropic.claude-opus-4-8" (리전 프리픽스가 us.가 아니라
//     global.일 수 있음 — 'anthropic.' 포함 여부로 잡으면 리전 프리픽스와 무관하게 맞음)
//   - enterprise model 예: "claude-sonnet-5" (anthropic. 없음, ':' 없음)
//   - organization.id는 ResourceAttributes가 아니라 **Attributes(datapoint별)**에 실린다
//     (실측 전 가정이 틀렸던 지점 — 원래 ResourceAttributes로 짜여있던 걸 수정).
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
            countIf(Attributes['organization.id'] != '') > 0, 'enterprise',
            'unknown'
        ) AS grp
    FROM claude_code.otel_metrics_sum
    WHERE UserEmail != ''
    GROUP BY UserEmail
)`;

// ponytail: ClickHouse 기본 설정(join_use_nulls=0)에서 LEFT JOIN 미매칭은 NULL이 아니라
// String 기본값('')을 반환한다 — coalesce(ug.grp, 'unknown')은 그래서 무력화됐었다.
export const GROUP_EXPR = "if(ug.grp = '' OR ug.grp IS NULL, 'unknown', ug.grp)";
