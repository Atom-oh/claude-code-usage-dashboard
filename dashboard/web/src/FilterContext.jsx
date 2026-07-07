import { createContext, useContext, useState } from "react";

const FilterContext = createContext(null);

// 대시보드 전역 필터(group/user/model) — RangeContext(기간)와 같은 패턴. 빈 문자열 = 필터 없음.
export function FilterProvider({ children }) {
  const [group, setGroup] = useState("");
  const [user, setUser] = useState("");
  const [model, setModel] = useState("");
  return (
    <FilterContext.Provider value={{ group, setGroup, user, setUser, model, setModel }}>
      {children}
    </FilterContext.Provider>
  );
}

export function useFilters() {
  return useContext(FilterContext);
}
