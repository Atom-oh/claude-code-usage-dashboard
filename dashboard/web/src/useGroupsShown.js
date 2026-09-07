import { useConfig } from "./ConfigContext.jsx";
import { useFilters } from "./FilterContext.jsx";
import { groupsShown } from "./pivot.js";

// 페이지들이 groupMode + 전역 group 필터를 매번 조합하지 않도록 한 곳에 묶는다.
export function useGroupsShown() {
  const { groupMode } = useConfig();
  const { group } = useFilters();
  return (rows) => groupsShown(groupMode, rows, group);
}
