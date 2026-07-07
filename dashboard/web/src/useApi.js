import { useEffect, useState } from "react";
import { apiGet } from "./api.js";
import { useRange } from "./RangeContext.jsx";
import { useFilters } from "./FilterContext.jsx";

export function useApi(path, extraParams = {}) {
  const { from, to, intervalHours } = useRange();
  const { group, user, model } = useFilters();
  const [state, setState] = useState({ data: null, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    apiGet(path, {
      from: from.toISOString(),
      to: to.toISOString(),
      group: group || undefined,
      user: user || undefined,
      model: model || undefined,
      intervalHours, // 시계열이 아닌 엔드포인트는 그냥 무시됨. extraParams가 뒤에 와서 override 가능.
      ...extraParams,
    })
      .then((data) => !cancelled && setState({ data, loading: false, error: null }))
      .catch((error) => !cancelled && setState({ data: null, loading: false, error }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, from.getTime(), to.getTime(), intervalHours, group, user, model, JSON.stringify(extraParams)]);

  return state;
}
