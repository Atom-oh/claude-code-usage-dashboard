import { createContext, useContext, useMemo, useState } from "react";

const RangeContext = createContext(null);

export function RangeProvider({ children }) {
  const [days, setDays] = useState(7);
  // ponytail: recompute only when the preset changes, not every render — avoids refetch loops.
  const value = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86400000);
    return { from, to, days, setDays };
  }, [days]);
  return <RangeContext.Provider value={value}>{children}</RangeContext.Provider>;
}

export function useRange() {
  return useContext(RangeContext);
}
