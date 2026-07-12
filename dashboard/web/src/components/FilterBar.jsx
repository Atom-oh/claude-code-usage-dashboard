import { useFilters } from "../FilterContext.jsx";
import { SegmentedControl } from "./SegmentedControl.jsx";

const GROUP_OPTIONS = [
  { value: "", label: "전체" },
  { value: "bedrock", label: "bedrock" },
  { value: "enterprise", label: "enterprise" },
];

// 모든 페이지에서 useApi가 이 값을 자동으로 요청에 실어보낸다(useApi.js) — 페이지별로 따로 붙일
// 필요 없음. model/user는 부분일치(대소문자 무시)라 텍스트 입력(300ms debounce는 FilterContext),
// group은 세그먼트 — unknown(모델/organization.id 신호가 없어 판별 불가능한 세션)은 A/B 비교
// 쿼리에서만 드롭되고(전체 응답의 ~11%), 사용자가 명시적으로 고를 그룹 옵션이 아니라 "필터
// 없음"과 겹치는 상태라 탭으로 넣지 않는다(queries.js filterCond 정책표 참고).
export function FilterBar() {
  const { group, setGroup, userInput, setUser, modelInput, setModel } = useFilters();
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <SegmentedControl options={GROUP_OPTIONS} value={group} onChange={setGroup} />
      <input
        value={userInput}
        onChange={(e) => setUser(e.target.value)}
        placeholder="유저 검색..."
        className="text-sm px-3 py-1.5 rounded-lg border border-ink-200 bg-white focus:border-brand-500 focus:outline-none w-40"
      />
      <input
        value={modelInput}
        onChange={(e) => setModel(e.target.value)}
        placeholder="모델 검색..."
        className="text-sm px-3 py-1.5 rounded-lg border border-ink-200 bg-white focus:border-brand-500 focus:outline-none w-40"
      />
    </div>
  );
}
