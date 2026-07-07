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
// 실측 확인(2026-07-07): 인증 방식(Bedrock env var vs Enterprise 로그인)은 프로세스/세션 시작 시
// 고정되고 세션 도중 바뀌지 않는다 — 판별은 세션(SessionId) 단위여야 정확하다. UserEmail 단위로
// 판별하면 한 이메일이 여러 세션에 걸쳐 다른 방식을 쓴 경우(테스트/재로그인 등) "bedrock 스타일
// 모델을 한 번이라도 호출했으면 유저 전체를 bedrock 확정"하는 OR 휴리스틱이 소수의 bedrock
// 세션만으로 그 유저의 나머지 enterprise 세션까지 전부 bedrock으로 덮어써버린다(실측: 15세션 중
// 3개만 bedrock인데 유저 전체가 bedrock으로 나옴). SessionId는 otel_metrics_sum(ALTER로 추가)과
// otel_logs(원래 스키마) 양쪽에 이미 promoted column이라 스키마 변경 없이 그레인만 바꾸면 된다.
export const GROUP_CTE = `
WITH session_group AS (
    SELECT
        SessionId,
        multiIf(
            countIf(Model LIKE '%anthropic.%' OR Model LIKE '%:%') > 0, 'bedrock',
            countIf(Attributes['organization.id'] != '') > 0, 'enterprise',
            'unknown'
        ) AS grp
    FROM claude_code.otel_metrics_sum
    WHERE SessionId != ''
    GROUP BY SessionId
)`;

// ponytail: ClickHouse 기본 설정(join_use_nulls=0)에서 LEFT JOIN 미매칭은 NULL이 아니라
// String 기본값('')을 반환한다 — coalesce(ug.grp, 'unknown')은 그래서 무력화됐었다.
export const GROUP_EXPR = "if(ug.grp = '' OR ug.grp IS NULL, 'unknown', ug.grp)";
