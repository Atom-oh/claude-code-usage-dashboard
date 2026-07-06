import { useEffect, useState } from "react";
import { apiGet } from "./api.js";
import { useRange } from "./RangeContext.jsx";

export function useApi(path, extraParams = {}) {
  const { from, to } = useRange();
  const [state, setState] = useState({ data: null, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    apiGet(path, { from: from.toISOString(), to: to.toISOString(), ...extraParams })
      .then((data) => !cancelled && setState({ data, loading: false, error: null }))
      .catch((error) => !cancelled && setState({ data: null, loading: false, error }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, from.getTime(), to.getTime(), JSON.stringify(extraParams)]);

  return state;
}
