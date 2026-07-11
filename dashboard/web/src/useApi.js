import { useEffect, useState } from "react";
import { apiGet } from "./api.js";
import { useRange } from "./RangeContext.jsx";
import { useFilters } from "./FilterContext.jsx";

// 서버(index.js)의 QUANT_MS/WARM_GRACE_MS와 반드시 같아야 한다 — 요청 시점의 to를 GRACE만큼
// 지난 QUANT_MS 경계로 내림해서, 같은 창 안의 모든 세션·유저가 문자 그대로 동일한 from/to를
// 보내게 한다. RangeContext의 마운트 시점 to(밀리초 정밀도)를 그대로 쓰면 세션마다 키가 달라
// 서버 캐시가 세션 간에 절대 공유되지 않고, 서버 warmer가 데운 캐시에도 히트 못 한다.
// GRACE를 빼는 이유: warmer는 grace 없이 "지금 경계"를 그대로 데우고(index.js warmCache),
// 배치가 다 끝나는 데 걸리는 시간은 index.js WARM_CYCLE_MAX_MS 주석 참고. 클라이언트가 창 T를
// 요청하는 시점이 T+GRACE이므로, GRACE > 워밍 소요 최댓값이어야 항상 warm-완료 상태를 히트한다.
// 실측(2026-07-10): otel_metrics_sum 증가(하루 ~300만 행)로 쿼리 1건이 배치 동시 실행 시
// 9~11초까지 늘어 원래 QUANT_MS=30초/GRACE=35초로는 워밍 사이클이 창을 통째로 건너뛰었다
// (필터 변경·최초 진입마다 100% 콜드로 8초대 응답 — Overview가 유독 느리게 느껴진 원인).
// QUANT_MS를 120초로 늘리고 GRACE를 서버 사이클 여유치보다 크게(150초) 잡아 재정렬.
// 표시 지연은 최대 창+유예 ≈ 270초 — 즉각 응답을 우선한 워크샵 트레이드오프(실시간성보다
// 응답속도가 중요하다고 확인됨)를 유지한 채 여유를 재확보한 값.
const QUANT_MS = 120_000;
const WARM_GRACE_MS = 150_000;

export function useApi(path, extraParams = {}) {
  const { days, intervalHours, custom } = useRange();
  const { group, user, model } = useFilters();
  const [state, setState] = useState({ data: null, loading: true, error: null });

  useEffect(() => {
    // deps가 바뀌면 이전 요청의 HTTP 자체를 abort — state 반영만 막으면 서버/ClickHouse 쿼리는
    // 계속 돌아서, 필터 타이핑 중 stale 쿼리가 쌓인다.
    const abort = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    // 드래그 줌으로 고른 커스텀 구간은 양자화하지 않고 그대로 보낸다 — 버킷 경계 라벨에서
    // 온 고정값이라 페이지의 모든 차트가 문자 그대로 같은 from/to를 공유한다(서버 TTL 캐시의
    // in-flight dedup은 그대로 유효). warmer는 기본 뷰만 데우므로 커스텀 구간 첫 조회는 콜드다.
    const to = custom ? custom.to : new Date(Math.floor((Date.now() - WARM_GRACE_MS) / QUANT_MS) * QUANT_MS);
    const from = custom ? custom.from : new Date(to.getTime() - days * 86400000);
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
  }, [path, days, intervalHours, custom?.from.getTime(), custom?.to.getTime(), group, user, model, JSON.stringify(extraParams)]);

  return state;
}
