import { useEffect, useRef, useState } from "react";
import { apiGet } from "./api.js";
import { useRange } from "./RangeContext.jsx";
import { useFilters } from "./FilterContext.jsx";
import { useRefresh } from "./RefreshContext.jsx";

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
  const { days, intervalHours, custom, month } = useRange();
  const { group, user, model } = useFilters();
  const { tick, reportFailure } = useRefresh();
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const inflightRef = useRef(null);
  const paramsKeyRef = useRef(null);
  const payloadRef = useRef(null);
  const extraJson = JSON.stringify(extraParams);

  useEffect(() => {
    // 프리셋/이번 달의 to는 양자화된 경계다(위 주석) — 커스텀 구간의 to는 그 경계에서 잘라
    // "오늘까지"로 고른 구간이 새로고침마다 함께 전진하게 한다.
    const nowQ = Math.floor((Date.now() - WARM_GRACE_MS) / QUANT_MS) * QUANT_MS;
    let from, to;
    if (custom) {
      from = custom.from;
      to = custom.to.getTime() > nowQ ? new Date(nowQ) : custom.to;
    } else if (month) {
      const n = new Date(nowQ);
      from = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1));
      to = new Date(nowQ);
    } else {
      to = new Date(nowQ);
      from = new Date(nowQ - days * 86400000);
    }
    // 양자화된 to는 실제 now보다 150~270초 뒤다 — 월초·오늘 시작 직후에는 to <= from이 되어
    // 서버가 400(from >= to)을 낸다. 미래 to는 서버가 받아주므로(http.js parseRange) 한
    // quantum만 앞으로 밀어 빈 창을 요청한다.
    if (to.getTime() <= from.getTime()) to = new Date(from.getTime() + QUANT_MS);

    const paramsKey = JSON.stringify([path, from.toISOString(), to.toISOString(), group, user, model, intervalHours, extraJson]);
    const paramsChanged = paramsKey !== paramsKeyRef.current;
    // 같은 파라미터에 대한 요청이 아직 떠 있는데 틱이 오면 그 틱은 버린다(큐잉하지 않는다).
    if (!paramsChanged && inflightRef.current) return;
    if (paramsChanged) {
      // deps가 바뀌면 이전 요청의 HTTP 자체를 abort — state 반영만 막으면 서버/ClickHouse
      // 쿼리는 계속 돌아서, 필터 타이핑 중 stale 쿼리가 쌓인다.
      inflightRef.current?.abort();
      paramsKeyRef.current = paramsKey;
      payloadRef.current = null;
      setState((s) => ({ ...s, loading: true }));
    }
    const abort = new AbortController();
    inflightRef.current = abort;
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
      .then((json) => {
        if (inflightRef.current === abort) inflightRef.current = null;
        const text = JSON.stringify(json);
        const same = text === payloadRef.current;
        payloadRef.current = text;
        // 같은 payload면 data 참조를 유지한다(Recharts 재애니메이션·DataTable 정렬 리셋 방지) —
        // 하지만 loading→false / error→null 전이는 항상 적용한다.
        setState((s) => ({ data: same ? s.data : json, loading: false, error: null }));
      })
      .catch((error) => {
        if (error.name === "AbortError") return;
        if (inflightRef.current === abort) inflightRef.current = null;
        if (paramsChanged) {
          setState({ data: null, loading: false, error });
        } else {
          // 백그라운드 틱 실패는 화면에 있는 데이터를 지우지 않는다 — 아직 데이터가 없으면
          // 파라미터 로드와 같게 에러를 드러낸다.
          setState((s) => (s.data === null ? { data: null, loading: false, error } : { ...s, loading: false }));
          reportFailure();
        }
      });
    // 이 cleanup에는 abort가 없다 — 틱만 바뀐 리런이 파라미터 로드를 취소하면 안 된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, days, month, intervalHours, custom?.from.getTime(), custom?.to.getTime(), group, user, model, extraJson, tick]);

  // 언마운트 시에만 abort한다.
  useEffect(() => () => inflightRef.current?.abort(), []);

  return state;
}
