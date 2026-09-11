import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useConfig } from "./ConfigContext.jsx";
import { parseUrlState, serializeUrlState } from "./urlState.js";
import { useRefresh } from "./RefreshContext.jsx";

const RangeContext = createContext(null);

// 차트 드래그 줌으로 고른 구간(span, ms) → intervalHours(버킷 크기)를 자동 선택한다.
// 분 단위 후보 중 버킷 개수가 ~96개 이하가 되는 가장 작은 값을 골라 "구간이 좁을수록
// 세밀하게" 보이게 한다. 서버 bucket()이 intervalHours<1이면 분 버킷으로 처리한다.
//
// 서버(index.js MAX_MINUTE_BUCKET_RANGE_MS)는 span이 4시간을 넘으면 분 버킷 요청을 강제로
// 1시간으로 clamp한다 — 클라이언트 사다리가 그 규칙을 모르면 4h~48h 구간에서 분 단위
// intervalHours를 골라놓고 실제로는 서버가 시간 버킷을 돌려줘, 틱 라벨이 분 단위로 찍히고
// useDragZoom의 우측 끝 보정도 잘못된(너무 작은) 폭만큼만 밀어 재줌 시 마지막 시간 버킷이
// 잘린다(리뷰에서 MAJOR로 확인). 값 자체를 공유 모듈로 뽑을 순 없다(server/web 의존성 분리
// 원칙) — 서버와 같은 값을 유지할 것.
const MAX_MINUTE_BUCKET_RANGE_MS = 4 * 3600000;
const RESOLUTION_LADDER_MIN = [5, 15, 30, 60, 180, 360, 1440];
function resolutionForSpan(spanMs) {
  const spanMin = spanMs / 60000;
  const ladder = spanMs > MAX_MINUTE_BUCKET_RANGE_MS ? RESOLUTION_LADDER_MIN.filter((min) => min >= 60) : RESOLUTION_LADDER_MIN;
  const m = ladder.find((min) => spanMin / min <= 96) ?? 1440;
  return m / 60; // intervalHours (예: 15분 → 0.25, 하루 → 24)
}

export function RangeProvider({ children }) {
  // 기본 창은 서버가 정한다(GET /api/config의 defaultRangeDays) — 서버 warmer가 데우는 창과
  // 같은 값이어서 첫 진입이 캐시 히트다. 예전에는 여기 하드코딩된 2와 서버 index.js의
  // WARM_DAYS가 서로 따라다녀야 했다.
  const { defaultRangeDays, piiMask, schema } = useConfig();
  const projectColumns = schema?.projectColumns === true;
  const [searchParams, setSearchParams] = useSearchParams();
  // 마운트 시 한 번만 URL을 읽는다 — 이후에는 이쪽이 URL의 소유자다. useState 초기화 함수로
  // 읽어야 리렌더마다 다시 파싱해 사용자가 고른 값을 URL의 옛 값으로 되돌리는 일이 없다.
  const initial = useState(() => parseUrlState(searchParams, { defaultDays: defaultRangeDays, piiMask }))[0];
  const [days, setDays] = useState(initial.range.days);
  // 차트 드래그로 고른 임의 구간. null이면 프리셋(days) 모드. 프리셋을 다시 고르면 클리어된다.
  const [custom, setCustom] = useState(initial.range.custom);
  const [month, setMonth] = useState(initial.range.month);
  const { dayKey } = useRefresh();
  // ponytail: recompute only when inputs change, not every render — avoids refetch loops.
  // dayKey는 UTC 날짜가 바뀔 때만 변한다(RefreshContext.jsx) — 밤새 열어둔 탭이 어제 구간의
  // 범위 텍스트와 daysInRange를 계속 보여주는 것만 막고, 그 이상 자주 재계산하지 않는다.
  // 절대 tick에 의존하게 만들지 말 것: Cost.jsx의 로컬 granularity가 1분마다 초기화된다.
  const value = useMemo(() => {
    const setRange = (from, to, source = "zoom") => { setCustom({ from, to, source }); setMonth(false); };
    // 프리셋 선택은 언제나 커스텀 줌과 이번 달을 해제한다.
    const selectDays = (d) => { setCustom(null); setMonth(false); setDays(d); };
    const selectMonth = () => { setCustom(null); setMonth(true); };
    const mode = custom ? "custom" : month ? "month" : "preset";
    if (custom) {
      const now = new Date();
      const to = custom.to > now ? now : custom.to;
      const spanDays = (custom.to - custom.from) / 86400000;
      // 달력으로 고른 구간은 프리셋과 같은 규칙을 쓴다 — resolutionForSpan이면 7일 선택이 3시간
      // 버킷이 되고 Cost.jsx의 granularity 옵션("1"/"24"/"168") 중 맞는 게 없어 아무것도 활성화
      // 되지 않는다. 드래그 줌은 그대로 resolutionForSpan.
      const intervalHours = custom.source === "calendar" ? (spanDays <= 2 ? 1 : 24) : resolutionForSpan(custom.to - custom.from);
      // to는 now로 캡한다 — Executive.jsx의 daysInRange/dailyAvg/projection30d, Cost.jsx:175,
      // 헤더 서브타이틀, csvFilename이 아니면 고른 종료일 다음 날까지 세고 보여준다. custom(원본,
      // to 캡 없음)은 그대로 노출해 pill·URL·useApi가 쓴다.
      return { from: custom.from, to, days, month, custom, mode, intervalHours, setDays: selectDays, selectMonth, setRange };
    }
    if (month) {
      const now = new Date();
      // UTC 월초 — 서버 버킷과 fmt.js의 틱 라벨이 UTC 기준이라, KST 월초로 잡으면 8/31이
      // 반쪽 버킷으로 렌더된다.
      const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const to = now;
      const intervalHours = 24;
      return { from, to, days, month, custom, mode, intervalHours, setDays: selectDays, selectMonth, setRange };
    }
    const to = new Date();
    const from = new Date(to.getTime() - days * 86400000);
    // 짧은 기간(<=2일)을 골랐는데 일 단위 버킷을 쓰면 점 1~2개로 붕괴한다 — 시간 단위로 전환.
    const intervalHours = days <= 2 ? 1 : 24;
    return { from, to, days, month, custom, mode, intervalHours, setDays: selectDays, selectMonth, setRange };
  }, [days, custom, month, dayKey]);
  // range 상태를 URL에 미러링한다 — 공유한 링크가 보낸 사람이 보던 구간으로 열린다.
  // replace: true — 프리셋을 몇 번 눌렀는지가 브라우저 뒤로가기 스택을 채우면 안 된다.
  // 필터 파라미터는 FilterContext가 소유하므로 여기서 건드리지 않고 그대로 보존한다 — 단 user는
  // 마스킹이 켜져 있으면 보존도 하지 않는다. 마운트 시 두 provider의 effect가 같은 틱에 돌고
  // 마지막 navigate가 이기는데, 이쪽이 바깥 provider라 나중에 돈다: 들어온 링크의 user를 그대로
  // 옮겨 쓰면 FilterContext가 지운 원본 이메일이 URL에 되살아난다(실측 2026-09-03, jsdom).
  useEffect(() => {
    setSearchParams(
      (prev) => {
        const next = serializeUrlState({ range: { days, custom, month }, filters: {}, piiMask });
        const filterKeys = piiMask ? ["group", "model"] : ["group", "user", "model"];
        if (projectColumns) filterKeys.push("project");
        for (const k of filterKeys) {
          const v = prev.get(k);
          if (v) next.set(k, v);
        }
        return next;
      },
      { replace: true }
    );
  }, [days, custom, month, piiMask, projectColumns, setSearchParams]);
  return <RangeContext.Provider value={value}>{children}</RangeContext.Provider>;
}

export function useRange() {
  return useContext(RangeContext);
}
