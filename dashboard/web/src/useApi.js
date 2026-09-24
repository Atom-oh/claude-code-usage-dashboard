import { useEffect, useMemo, useRef, useState } from "react";
import { apiGet } from "./api.js";
import { useRange } from "./RangeContext.jsx";
import { useFilters } from "./FilterContext.jsx";
import { useConfig } from "./ConfigContext.jsx";
import { useRefreshCycle } from "./RefreshContext.jsx";

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
const quantizedNow = () => Math.floor((Date.now() - WARM_GRACE_MS) / QUANT_MS) * QUANT_MS;
const utcMonthStart = (ms) => {
  const n = new Date(ms);
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1));
};
const CLEARED = { shownIdentity: null, shownPeriod: null };

// hold: linkedRange 패널처럼 부모 응답의 경계를 따라가는 훅이 부모의 기간 변경 응답을 기다리는 동안
// true로 둔다. 그동안 요청도 ref·state 갱신도 하지 않고 지금 보이는 것을 그대로 둔다(떠 있는 요청은
// 정상적으로 끝난다). hold가 풀리면 보류 중 일어난 기간 변경을 기간 변경으로 판정하고 새 경계로 요청한다.
export function useApi(path, extraParams = {}, enabled = true, { linkedRange = false, hold = false } = {}) {
  const { days, intervalHours, custom, month } = useRange();
  const { group, user, model, project, backend } = useFilters();
  const clientOverview = path === "/api/clients/overview" || path === "/api/codex/insights";
  // 이중 안전 — 파싱 단계(urlState.js parseUrlState)에서 이미 걸러지므로 여기서 걸리는 값은
  // 정상 경로에는 없다. 그래도 요청 문자열을 실제로 만드는 지점에 같은 게이트를 둔다: 보이지
  // 않는 필터가 요청에 실리는 것 자체가 PR #31 리뷰의 지적이었고, 게이트가 한 곳뿐이면 그 한
  // 곳을 지우는 수정이 조용히 되돌린다. paramsKey/deps는 그대로 project(원본 상태)를 본다 —
  // 입력창은 게이트가 켜졌을 때만 렌더되므로 그때 두 값은 같고, deps를 건드리면 "값이 바뀌면
  // 다시 요청한다"를 핀하는 기존 렌더 테스트가 무의미해진다.
  const { schema } = useConfig();
  const projectParam = schema?.projectColumns === true ? project : "";
  const { tick, reportFailure, beginRequest } = useRefreshCycle();
  // shownIdentity/shownPeriod: 화면의 data를 가져온 요청의 정체성·기간 키. data가 없으면 null.
  const [state, setState] = useState({ data: null, loading: true, error: null, ...CLEARED });
  const inflightRef = useRef(null);
  const paramsKeyRef = useRef(null);
  const identityKeyRef = useRef(null);
  const periodKeyRef = useRef(null);
  // 기간 변경 뒤 이전 기간의 데이터를 그대로 보여주면서 새 기간의 첫 응답을 기다리는 중인가.
  const periodPendingRef = useRef(false);
  const payloadRef = useRef(null);
  const extraJson = JSON.stringify(extraParams);
  // extraParams 중 from/to/intervalHours는 "언제를 보나"(기간)이고 나머지는 "무엇을 보나"(정체성)다.
  // intervalHours는 Cost.jsx의 로컬 granularity처럼 전역 intervalHours를 페이지에서 덮어쓰는
  // 값이다 — 전역 기간이 바뀌면 그 페이지가 이 값을 재동기화하므로 정체성에 두면 기간 변경마다
  // 해당 차트만 다시 비워진다.
  // linkedRange 패널의 from/to는 부모 응답의 실제 경계를 따라간다. 폴링 중에도 움직이는 값이라
  // 기간 변경이 아니라 같은 뷰의 새로고침이다 — 그래서 기간 키에서도 뺀다.
  const { from: extraFrom, to: extraTo, intervalHours: extraIntervalHours, ...identityExtra } = extraParams;
  const identityExtraJson = JSON.stringify(identityExtra);
  const periodExtraJson = JSON.stringify([linkedRange ? null : extraFrom ?? null,
    linkedRange ? null : extraTo ?? null, extraIntervalHours ?? null]);
  // 선택 = 정체성(경로·필터·기간 외 extraParams·linkedRange) + 기간(days·이번 달·intervalHours·
  // 커스텀 구간·이번 달의 월초·extraParams의 기간 키). 양자화된 창이 움직이는 것은 둘 다 바꾸지
  // 않는다 — 같은 뷰의 새로고침이다. 두 키는 렌더에서 계산한다: stale이 기간이 바뀐 바로 그 렌더부터
  // true여야 하기 때문이다(아래). 월초는 effect의 from과 같은 양자화 시계로 계산한다.
  const identityKey = JSON.stringify([path, group, user, model, project, backend, identityExtraJson, linkedRange]);
  const periodKey = JSON.stringify([days, month, intervalHours, custom?.from.getTime(), custom?.to.getTime(),
    month ? utcMonthStart(quantizedNow()).toISOString() : null, periodExtraJson]);
  // stale: 같은 뷰의 다른 기간 데이터가 새 기간의 응답을 기다리며 화면에 남아 있다. state로 미루지
  // 않고 렌더에서 계산한다 — effect는 자식부터 돈다. 부모의 stale을 effect에서 세팅하면 기간이 바뀐
  // 커밋에서 자식(hold: parent.stale)의 effect가 아직 false인 hold를 보고 부모의 옛 경계로 먼저
  // 요청해 버린다(PR #80 리뷰 MAJOR, 렌더 프로브로 실측). 데이터가 가져온 기간으로 되돌아오면
  // shownPeriod와 다시 같아져 false다 — 그 요청은 새로고침이다.
  const stale = state.data !== null && !state.loading && state.shownIdentity === identityKey
    && state.shownPeriod !== periodKey;

  useEffect(() => {
    if (!enabled) {
      inflightRef.current?.abort();
      inflightRef.current = null;
      paramsKeyRef.current = null;
      identityKeyRef.current = null;
      periodKeyRef.current = null;
      periodPendingRef.current = false;
      payloadRef.current = null;
      setState((s) => s.loading && !s.error ? s : { ...s, loading: true, error: null });
      return;
    }
    if (hold) return;
    // 프리셋/이번 달의 to는 양자화된 경계다(위 주석) — 커스텀 구간의 to는 그 경계에서 잘라
    // "오늘까지"로 고른 구간이 새로고침마다 함께 전진하게 한다.
    const nowQ = quantizedNow();
    let from, to;
    if (custom) {
      from = custom.from;
      to = custom.to.getTime() > nowQ ? new Date(nowQ) : custom.to;
    } else if (month) {
      from = utcMonthStart(nowQ);
      to = new Date(nowQ);
    } else {
      to = new Date(nowQ);
      from = new Date(nowQ - days * 86400000);
    }
    // 양자화된 to는 실제 now보다 150~270초 뒤다 — 월초·오늘 시작 직후에는 to <= from이 되어
    // 서버가 400(from >= to)을 낸다. 미래 to는 서버가 받아주므로(http.js parseRange) 한
    // quantum만 앞으로 밀어 빈 창을 요청한다.
    if (to.getTime() <= from.getTime()) to = new Date(from.getTime() + QUANT_MS);

    const paramsKey = JSON.stringify([path, from.toISOString(), to.toISOString(), group, user, model, project, backend, intervalHours, extraJson]);
    const paramsChanged = paramsKey !== paramsKeyRef.current;
    const identityChanged = identityKey !== identityKeyRef.current;
    const selectionChanged = identityChanged || periodKey !== periodKeyRef.current;
    // 정체성이 그대로이고 화면에 데이터가 있으면 그 데이터를 둔 채 요청한다 — 백그라운드 틱과
    // 기간 변경이 여기에 해당한다. 기간 변경도 "불러오는 중..." 자리표시자로 비우지 않으므로 차트가
    // 다시 마운트·재애니메이션되지 않고, 새 응답이 도착하는 순간 교체된다. 진행 중임은
    // RefreshControl의 "갱신 중 · 이전 데이터 표시"(beginRequest)로 드러난다. 경로·필터·그 밖의
    // extraParams가 바뀌면 다른 뷰라서 예전처럼 비우고 loading으로 시작한다.
    const retainData = !identityChanged && state.data !== null;
    // 같은 파라미터에 대한 요청이 아직 떠 있는데 틱이 오면 그 틱은 버린다(큐잉하지 않는다).
    if (!paramsChanged && inflightRef.current) return;
    if (paramsChanged) {
      // deps가 바뀌면 이전 요청의 HTTP 자체를 abort — state 반영만 막으면 서버/ClickHouse
      // 쿼리는 계속 돌아서, 필터 타이핑 중 stale 쿼리가 쌓인다.
      inflightRef.current?.abort();
      paramsKeyRef.current = paramsKey;
    }
    if (selectionChanged) {
      identityKeyRef.current = identityKey;
      periodKeyRef.current = periodKey;
      // 새 선택의 첫 응답은 이전 payload와 내용이 같아도 새 참조로 받는다.
      payloadRef.current = null;
      // 화면의 데이터가 이미 이 기간의 것이면(다른 기간으로 갔다가 되돌아온 경우) 기다릴 새 기간이 없다
      // — 새로고침처럼 실패해도 그 데이터를 두고 reportFailure한다.
      periodPendingRef.current = retainData && state.shownPeriod !== periodKey;
      if (!retainData) setState({ data: null, loading: true, error: null, ...CLEARED });
    }
    const abort = new AbortController();
    const finish = retainData ? beginRequest() : () => {};
    abort.signal.addEventListener("abort", finish, { once: true });
    inflightRef.current = abort;
    apiGet(
      path,
      {
        from: from.toISOString(),
        to: to.toISOString(),
        group: group || undefined,
        user: user || undefined,
        model: model || undefined,
        project: projectParam || undefined,
        intervalHours, // 시계열이 아닌 엔드포인트는 그냥 무시됨. extraParams가 뒤에 와서 override 가능.
        ...extraParams,
        ...(clientOverview ? { group: undefined, project: undefined, intervalHours: undefined, backend: backend || undefined } : {}),
      },
      abort.signal
    )
      .then((json) => {
        if (inflightRef.current !== abort || abort.signal.aborted) return;
        inflightRef.current = null;
        periodPendingRef.current = false;
        const text = JSON.stringify(json);
        const same = text === payloadRef.current;
        payloadRef.current = text;
        // 같은 payload면 data 참조를 유지한다(Recharts 재애니메이션·DataTable 정렬 리셋 방지) —
        // 하지만 loading→false / error→null 전이는 항상 적용한다.
        setState((s) => same && !s.loading && !s.error && s.shownIdentity === identityKey && s.shownPeriod === periodKey ? s
          : { data: same ? s.data : json, loading: false, error: null, shownIdentity: identityKey, shownPeriod: periodKey });
      })
      .catch((error) => {
        if (error.name === "AbortError" || inflightRef.current !== abort || abort.signal.aborted) return;
        inflightRef.current = null;
        // 새 기간의 첫 응답이 실패하면 이전 기간의 데이터를 남기지 않는다 — 남기면 옛 기간의 숫자가
        // 새 기간의 것처럼 보인다. 선택 변경 실패와 똑같이 에러로 비우고 reportFailure도 하지
        // 않는다. 그 요청이 떠 있는 동안 양자화된 창이 넘어가 틱 요청(selectionChanged=false)으로
        // 대체됐어도 periodPendingRef가 이 실패를 기간 변경 실패로 분류한다. 화면의 데이터와 같은
        // 기간으로 되돌아온 선택 변경은 새로고침이다(periodPendingRef가 false) — 아래로 간다.
        if ((selectionChanged && !retainData) || periodPendingRef.current) {
          periodPendingRef.current = false;
          setState({ data: null, loading: false, error, ...CLEARED });
        } else {
          // 백그라운드 틱 실패는 화면에 있는 데이터를 지우지 않는다 — 아직 데이터가 없으면
          // 파라미터 로드와 같게 에러를 드러낸다.
          setState((s) => (s.data === null ? { data: null, loading: false, error, ...CLEARED } : { ...s, loading: false }));
          reportFailure();
        }
      })
      .finally(() => {
        abort.signal.removeEventListener("abort", finish);
        finish();
      });
    // 이 cleanup에는 abort가 없다 — 틱만 바뀐 리런이 파라미터 로드를 취소하면 안 된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, days, month, intervalHours, custom?.from.getTime(), custom?.to.getTime(), group, user, model, project, backend, extraJson, identityExtraJson, periodExtraJson, linkedRange, tick, enabled, hold, beginRequest, reportFailure]);

  // 언마운트 시에만 abort한다.
  useEffect(() => () => {
    inflightRef.current?.abort();
    // StrictMode replays mount effects; an aborted request cannot block its replacement.
    inflightRef.current = null;
    paramsKeyRef.current = null;
    identityKeyRef.current = null;
    periodKeyRef.current = null;
    periodPendingRef.current = false;
  }, []);

  const { data, loading, error } = state;
  return useMemo(() => ({ data, loading, error, stale }), [data, loading, error, stale]);
}
