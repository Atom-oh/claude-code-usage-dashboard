import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

// 자동 새로고침 주기. 0 = 끔. 값은 그대로 localStorage에 저장되므로 늘리거나 줄일 때
// 예전 값이 목록에 없으면 DEFAULT로 접힌다(아래 readStored 참고).
export const REFRESH_OPTIONS = [
  { value: 0, label: "끔" },
  { value: 15_000, label: "15초" },
  { value: 30_000, label: "30초" },
  { value: 60_000, label: "1분" },
  { value: 300_000, label: "5분" },
];
export const DEFAULT_REFRESH_MS = 60_000;
const STORAGE_KEY = "ccdash.refreshMs";

const dayKeyNow = () => Math.floor(Date.now() / 86400000);

// provider 없이 부르는 소비자(FilterBar.test.jsx 등)도 크래시하지 않게 완전한 모양을
// 기본값으로 준다 — FreshnessContext.jsx와 같은 관례.
const RefreshContext = createContext({
  intervalMs: 0,
  tick: 0,
  lastRefreshedAt: null,
  lastError: false,
  dayKey: dayKeyNow(),
  setIntervalMs() {},
  refreshNow() {},
  reportFailure() {},
});

function readStored() {
  try {
    // 저장값은 문자열로 비교한다. Number()로 먼저 캐스팅하면 안 된다 — 키가 없을 때
    // getItem은 null이고 Number(null)은 0인데, 0은 "끔"이라는 정당한 옵션값이라
    // "모르는 값이면 기본값" 가드를 그대로 통과한다. 즉 첫 방문자 전원이 1분이 아니라
    // 끔으로 시작한다(빈 문자열도 Number("")===0으로 같은 함정).
    const raw = localStorage.getItem(STORAGE_KEY);
    const opt = REFRESH_OPTIONS.find((o) => String(o.value) === raw);
    return opt ? opt.value : DEFAULT_REFRESH_MS;
  } catch {
    // 사파리 프라이빗 모드 등에서 localStorage 접근 자체가 던진다 — 기본값으로 진행한다.
    return DEFAULT_REFRESH_MS;
  }
}

export function RefreshProvider({ children }) {
  const [intervalMs, setIntervalMsState] = useState(readStored);
  const [tick, setTick] = useState(0);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null);
  const [lastError, setLastError] = useState(false);
  const [dayKey, setDayKey] = useState(dayKeyNow);
  const skipNextRef = useRef(false);

  const setIntervalMs = useCallback((ms) => {
    setIntervalMsState(ms);
    try {
      localStorage.setItem(STORAGE_KEY, String(ms));
    } catch {
      // 저장 실패는 기능을 막지 않는다 — 이번 세션에만 적용된다.
    }
  }, []);

  const bump = useCallback(() => {
    setTick((t) => t + 1);
    setLastRefreshedAt(new Date());
    setLastError(false);
    // 같은 값으로 setState하면 리렌더가 없다 — dayKey는 UTC 날짜가 바뀔 때만 실제로 변한다.
    setDayKey(dayKeyNow());
  }, []);

  const reportFailure = useCallback(() => {
    setLastError(true);
    // 실패한 백그라운드 사이클 다음 틱은 한 번 건너뛴다 — 서버가 죽어 있을 때 15초마다
    // 같은 요청을 계속 때리지 않기 위한 최소 백오프다.
    skipNextRef.current = true;
  }, []);

  useEffect(() => {
    if (intervalMs === 0) return;
    const timer = setInterval(() => {
      // 숨은 탭에서는 틱을 아예 만들지 않는다 — 백그라운드 탭 20개가 각자 5~7개 엔드포인트를
      // 재요청하면 ClickHouse에 아무도 보지 않는 부하만 남는다.
      if (document.visibilityState !== "visible") return;
      if (skipNextRef.current) {
        skipNextRef.current = false;
        return;
      }
      bump();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, bump]);

  useEffect(() => {
    if (intervalMs === 0) return;
    // 한 시간 숨어 있던 탭으로 돌아왔을 때 다음 틱까지 옛 숫자를 보여주면 안 된다.
    const onVisible = () => {
      if (document.visibilityState === "visible") bump();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [intervalMs, bump]);

  return (
    <RefreshContext.Provider
      value={{ intervalMs, tick, lastRefreshedAt, lastError, dayKey, setIntervalMs, refreshNow: bump, reportFailure }}
    >
      {children}
    </RefreshContext.Provider>
  );
}

export function useRefresh() {
  return useContext(RefreshContext);
}
