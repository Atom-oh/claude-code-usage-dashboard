import { createContext, useContext, useMemo, useState } from "react";

const RangeContext = createContext(null);

// 차트 드래그 줌으로 고른 구간(span, ms) → intervalHours(버킷 크기)를 자동 선택한다.
// 분 단위 후보 중 버킷 개수가 ~96개 이하가 되는 가장 작은 값을 골라 "구간이 좁을수록
// 세밀하게" 보이게 한다. 서버 bucket()이 intervalHours<1이면 분 버킷으로 처리한다.
const RESOLUTION_LADDER_MIN = [5, 15, 30, 60, 180, 360, 1440];
function resolutionForSpan(spanMs) {
  const spanMin = spanMs / 60000;
  const m = RESOLUTION_LADDER_MIN.find((min) => spanMin / min <= 96) ?? 1440;
  return m / 60; // intervalHours (예: 15분 → 0.25, 하루 → 24)
}

export function RangeProvider({ children }) {
  // 워크샵 기간 기본 2일 — 서버 warmer(index.js)가 이 기본 뷰(2일·필터 없음)를 15초마다
  // 미리 캐싱하므로, 기본값을 바꾸면 warmer의 WARM_DAYS도 같이 바꿔야 한다.
  const [days, setDays] = useState(2);
  // 차트 드래그로 고른 임의 구간. null이면 프리셋(days) 모드. 프리셋을 다시 고르면 클리어된다.
  const [custom, setCustom] = useState(null);
  // ponytail: recompute only when inputs change, not every render — avoids refetch loops.
  const value = useMemo(() => {
    const setRange = (from, to) => setCustom({ from, to });
    // 프리셋 선택은 언제나 커스텀 줌을 해제한다.
    const selectDays = (d) => { setCustom(null); setDays(d); };
    if (custom) {
      const intervalHours = resolutionForSpan(custom.to - custom.from);
      return { from: custom.from, to: custom.to, days, setDays: selectDays, intervalHours, custom, setRange };
    }
    const to = new Date();
    const from = new Date(to.getTime() - days * 86400000);
    // 짧은 기간(<=2일)을 골랐는데 일 단위 버킷을 쓰면 점 1~2개로 붕괴한다 — 시간 단위로 전환.
    const intervalHours = days <= 2 ? 1 : 24;
    return { from, to, days, setDays: selectDays, intervalHours, custom: null, setRange };
  }, [days, custom]);
  return <RangeContext.Provider value={value}>{children}</RangeContext.Provider>;
}

export function useRange() {
  return useContext(RangeContext);
}
