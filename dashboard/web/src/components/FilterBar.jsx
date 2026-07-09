import { useFilters } from "../FilterContext.jsx";
import { SegmentedControl } from "./SegmentedControl.jsx";

const GROUP_OPTIONS = [
  { value: "", label: "전체" },
  { value: "bedrock", label: "bedrock" },
  { value: "enterprise", label: "enterprise" },
];

// 모든 페이지에서 useApi가 이 값을 자동으로 요청에 실어보낸다(useApi.js) — 페이지별로 따로 붙일
// 필요 없음. model/user는 부분일치(대소문자 무시)라 텍스트 입력(300ms debounce는 FilterContext),
// group은 세그먼트(unknown은 사용자 결정으로 탭에서 제외 — 데이터 분류에는 존재).
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
