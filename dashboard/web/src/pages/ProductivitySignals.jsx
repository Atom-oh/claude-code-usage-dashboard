import { Card, ErrorBox, Loading } from "../components/Card.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { useApi } from "../useApi.js";

const number = (value) => value == null ? "—" : Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
const percent = (value) => value == null ? "—" : `${(Number(value) * 100).toFixed(1)}%`;
const count = (key, label) => ({ key, label, render: number });
const ratio = (key, label) => ({ key, label, render: percent, toText: percent });
const CHANNEL = { key: "group", label: "채널" };

function SignalTable({ response, title, subtitle, help, columns, exportName }) {
  if (response.loading) return <Loading />;
  if (response.error) return <ErrorBox error={response.error} />;
  if (response.data?.limited) {
    return <Card title={title}><p role="status" className="text-sm text-ink-600">
      스팬 조회 한도를 초과했거나 동일 스팬의 정보가 충돌해 계산하지 않았습니다. 기간을 줄이거나 사용자를 선택해 주세요.
    </p></Card>;
  }
  return <DataTable title={title}
    subtitle={response.data?.unsupported ? "이 기간에는 계산 가능한 인터랙션 스팬이 없습니다" : subtitle}
    help={help} columns={columns} rows={Array.isArray(response.data) ? response.data : response.data?.rows || []}
    exportName={exportName} stale={response.stale} />;
}

export function OutcomeMetricsNotice() {
  return <Card title="작업 결과 지표">
    <p className="text-sm text-ink-600">
      작업 완료 시간·14일 안정 완료율·안정 완료당 AI 비용은 아직 계산하지 않습니다.
      작업 ID와 시작·완료 시각, Git·CI·재오픈 기록, 작업별 비용 연결이 필요합니다.
      세션이나 PR 개수를 완료 작업 수로 대신하지 않습니다.
    </p>
  </Card>;
}

export default function ProductivitySignals() {
  const density = useApi("/api/productivity/activity-density");
  const outcomes = useApi("/api/productivity/tool-outcomes");
  const occupancy = useApi("/api/productivity/permission-occupancy");
  return <section aria-label="관측 활동과 실행 흐름" className="flex min-w-0 flex-col gap-4 [&_th]:whitespace-nowrap [&_td]:whitespace-nowrap">
    <p className="text-sm text-ink-600">
      관측 활동량·대기·도구 실행 결과를 각각 확인합니다. 작업 완료율, 코드 품질, 절감 시간이나 개인 역량을 뜻하지 않습니다.
      모델 필터는 해당 모델을 사용한 세션 범위이며 프로젝트 필터는 적용되지 않습니다.
    </p>
    <SignalTable response={density} title="관측 활동 밀도"
      subtitle="커밋과 사용자 활성 시간이 함께 관측된 세션 범위"
      help="동일 사용자·세션에서 관측된 커밋 증가량 ÷ 사용자 활성 시간입니다. 분모는 근무시간이 아닙니다. 연결률은 두 지표 중 하나라도 관측된 사용자·세션 범위 중 계산 가능한 비율이며 전체 수집 완전성을 보장하지 않습니다."
      columns={[CHANNEL, count("commits_per_user_hour", "커밋 / 사용자 활성 1시간"),
        count("matched_commits", "연결된 커밋"), count("user_hours", "사용자 활성 시간 (h)"),
        count("matched_scopes", "계산 가능 범위"), count("observed_scopes", "관측 범위"), ratio("coverage", "연결률")]}
      exportName="activity_density" />
    <SignalTable response={occupancy} title="관측 권한 대기 점유율"
      subtitle="대기 스팬을 연결할 수 있는 인터랙션만 계산 · 대기 신호 미수집은 —"
      help="인터랙션마다 권한 대기 구간의 중복을 제거하고 인터랙션·조회 종료 경계로 잘라 합산한 뒤, 같은 인터랙션의 시간 합계로 나눕니다. 같은 trace·세션에서 시간 구간이 겹치는 인터랙션이 여러 개면 해당 인터랙션은 제외합니다. 조회 시작 전 시작한 인터랙션은 제외되며, 대기 신호가 없는 인터랙션을 대기 0으로 간주하지 않습니다."
      columns={[CHANNEL, ratio("blocked_share", "권한 대기 점유율"),
        count("blocked_ms", "연결된 대기 (ms)"), count("interaction_ms", "연결된 인터랙션 시간 (ms)"),
        count("matched_interactions", "연결된 인터랙션"), count("interactions", "관측 인터랙션"),
        count("ambiguous_interactions", "연결 모호"), ratio("coverage", "대기 신호 연결률")]}
      exportName="permission_occupancy" />
    <SignalTable response={outcomes} title="관측 도구 실행 성공률"
      subtitle="성공 ÷ (성공 + 실패) · 결과 미상은 분모에서 제외"
      help="관측 tool_result 기록 전체를 집계합니다. 명시적 성공이 있고 오류가 없어야 성공이며, 명시적 실패 또는 오류가 있으면 실패입니다. 나머지는 미상입니다. 중복 수집 기록이 포함될 수 있고 실행 성공은 작업 완료나 코드 품질을 뜻하지 않습니다."
      columns={[CHANNEL, ratio("success_rate", "실행 성공률"), count("succeeded", "성공"),
        count("failed", "실패"), count("unknown", "미상"), count("total", "관측 결과"), ratio("unknown_rate", "미상 비율")]}
      exportName="tool_outcomes" />
    <OutcomeMetricsNotice />
  </section>;
}
