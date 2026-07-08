import { createContext, useContext, useEffect, useState } from "react";

const FilterContext = createContext(null);

// 대시보드 전역 필터(group/user/model) — RangeContext(기간)와 같은 패턴. 빈 문자열 = 필터 없음.
// user/model 텍스트 입력은 300ms debounce — 안 하면 keystroke마다 페이지의 전체 엔드포인트
// (5~7개)가 재요청돼 ClickHouse에 query storm이 생긴다. userInput/modelInput은 입력창 표시용
// 원본, user/model은 debounce된 값(useApi가 이걸 본다). group은 클릭이라 debounce 불필요.
export function FilterProvider({ children }) {
  const [group, setGroup] = useState("");
  const [userInput, setUser] = useState("");
  const [modelInput, setModel] = useState("");
  const [user, setDebouncedUser] = useState("");
  const [model, setDebouncedModel] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedUser(userInput), 300);
    return () => clearTimeout(t);
  }, [userInput]);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedModel(modelInput), 300);
    return () => clearTimeout(t);
  }, [modelInput]);

  return (
    <FilterContext.Provider value={{ group, setGroup, user, userInput, setUser, model, modelInput, setModel }}>
      {children}
    </FilterContext.Provider>
  );
}

export function useFilters() {
  return useContext(FilterContext);
}
