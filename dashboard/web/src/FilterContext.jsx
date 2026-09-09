import { createContext, useContext, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useConfig } from "./ConfigContext.jsx";
import { parseUrlState, serializeUrlState } from "./urlState.js";

const FilterContext = createContext(null);

// 대시보드 전역 필터(group/user/model/project) — RangeContext(기간)와 같은 패턴. 빈 문자열 = 필터 없음.
// user/model 텍스트 입력은 300ms debounce — 안 하면 keystroke마다 페이지의 전체 엔드포인트
// (5~7개)가 재요청돼 ClickHouse에 query storm이 생긴다. userInput/modelInput은 입력창 표시용
// 원본, user/model은 debounce된 값(useApi가 이걸 본다). group은 클릭이라 debounce 불필요.
// project는 저장소 이름 정확 일치라 서버가 부분일치로 넓히지 않는다(queries.js filterCond) —
// 입력창은 FilterBar가 schema.projectColumns === true일 때만 렌더한다.
export function FilterProvider({ children }) {
  const { piiMask } = useConfig();
  const [searchParams, setSearchParams] = useSearchParams();
  // 마운트 시 한 번만 URL을 읽는다 — debounce된 값과 입력창 표시용 값을 둘 다 여기서
  // 시딩해야 한다. 입력창만 시딩하면 첫 fetch가 무필터로 나가고 300ms 뒤 다시 나간다.
  const initial = useState(() => parseUrlState(searchParams, { piiMask }).filters)[0];
  const [group, setGroup] = useState(initial.group);
  const [userInput, setUser] = useState(initial.user);
  const [modelInput, setModel] = useState(initial.model);
  const [projectInput, setProject] = useState(initial.project);
  const [user, setDebouncedUser] = useState(initial.user);
  const [model, setDebouncedModel] = useState(initial.model);
  const [project, setDebouncedProject] = useState(initial.project);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedUser(userInput), 300);
    return () => clearTimeout(t);
  }, [userInput]);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedModel(modelInput), 300);
    return () => clearTimeout(t);
  }, [modelInput]);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedProject(projectInput), 300);
    return () => clearTimeout(t);
  }, [projectInput]);

  // 필터를 URL에 미러링한다 — debounce된 값 기준이라 타이핑 중에 URL이 글자마다 바뀌지 않는다.
  // days/from/to/period는 RangeContext가 소유하므로 보존만 하고 건드리지 않는다. 값이 비면 키를
  // 아예 지운다(serializeUrlState가 생략한다) — ?group= 같은 빈 파라미터가 링크에 남으면
  // 필터가 걸린 것처럼 읽힌다.
  useEffect(() => {
    setSearchParams(
      (prev) => {
        const next = serializeUrlState({ range: null, filters: { group, user, model, project }, piiMask });
        for (const k of ["days", "from", "to", "period"]) {
          const v = prev.get(k);
          if (v) next.set(k, v);
        }
        return next;
      },
      { replace: true }
    );
  }, [group, user, model, project, piiMask, setSearchParams]);

  return (
    <FilterContext.Provider value={{ group, setGroup, user, userInput, setUser, model, modelInput, setModel, project, projectInput, setProject }}>
      {children}
    </FilterContext.Provider>
  );
}

export function useFilters() {
  return useContext(FilterContext);
}
