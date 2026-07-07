import { createContext, useContext, useMemo, useState } from "react";

const RangeContext = createContext(null);

export function RangeProvider({ children }) {
  const [days, setDays] = useState(7);
  // ponytail: recompute only when the preset changes, not every render — avoids refetch loops.
  const value = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86400000);
    // 짧은 기간(<=2일)을 골랐는데 일 단위 버킷을 쓰면 점 1~2개로 붕괴한다 — 시간 단위로 전환.
    const intervalHours = days <= 2 ? 1 : 24;
    return { from, to, days, setDays, intervalHours };
  }, [days]);
  return <RangeContext.Provider value={value}>{children}</RangeContext.Provider>;
}

export function useRange() {
  return useContext(RangeContext);
}
