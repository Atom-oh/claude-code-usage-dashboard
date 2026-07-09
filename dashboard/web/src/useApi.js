import { useEffect, useState } from "react";
import { apiGet } from "./api.js";
import { useRange } from "./RangeContext.jsx";
import { useFilters } from "./FilterContext.jsx";

export function useApi(path, extraParams = {}) {
  const { from, to, intervalHours } = useRange();
  const { group, user, model } = useFilters();
  const [state, setState] = useState({ data: null, loading: true, error: null });

  useEffect(() => {
    // deps가 바뀌면 이전 요청의 HTTP 자체를 abort — state 반영만 막으면 서버/ClickHouse 쿼리는
    // 계속 돌아서, 필터 타이핑 중 stale 쿼리가 쌓인다.
    const abort = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    apiGet(
      path,
      {
        from: from.toISOString(),
        to: to.toISOString(),
        group: group || undefined,
        user: user || undefined,
        model: model || undefined,
        intervalHours, // 시계열이 아닌 엔드포인트는 그냥 무시됨. extraParams가 뒤에 와서 override 가능.
        ...extraParams,
      },
      abort.signal
    )
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((error) => {
        if (error.name !== "AbortError") setState({ data: null, loading: false, error });
      });
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, from.getTime(), to.getTime(), intervalHours, group, user, model, JSON.stringify(extraParams)]);

  return state;
}
