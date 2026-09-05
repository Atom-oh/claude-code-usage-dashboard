import { createContext, useContext, useEffect, useState } from "react";

const POLL_MS = 60_000;
// 측정 불가 상태. fetch 실패·비-JSON 응답이 모두 여기로 접힌다 — 서버의 unknown과 같은 값이라
// 배너/배지 쪽에 분기를 하나 더 만들지 않는다.
const UNKNOWN = { status: "unknown", latest: null, ageMinutes: null };
// 첫 응답 전에는 loading — provider 밖에서 부르는 소비자도 이 기본값을 받아 크래시하지 않는다.
const LOADING = { status: "loading", latest: null, ageMinutes: null };

const FreshnessContext = createContext(LOADING);

export function FreshnessProvider({ children }) {
  const [state, setState] = useState(LOADING);

  useEffect(() => {
    let inflight = null;
    const poll = () => {
      inflight?.abort(); // 이전 폴이 아직 떠 있으면 접는다 — AbortError는 아래에서 무시한다
      const ac = new AbortController();
      inflight = ac;
      fetch("/api/health/data", { signal: ac.signal })
        // res.ok로 거르지 않는다: 이 엔드포인트는 stale/unknown일 때 의도적으로 503 + 본문을
        // 낸다(index.js). 503을 네트워크 오류로 취급하면 실제 stale 상태를 영원히 못 보고
        // 항상 unknown 문구만 뜬다.
        .then((res) => res.json())
        .then((body) =>
          setState({
            status: body?.status ?? "unknown",
            latest: body?.latest ?? null,
            ageMinutes: body?.ageMinutes ?? null,
            staleAfterMinutes: body?.staleAfterMinutes,
          })
        )
        // useApi.js와 같은 관례 — abort는 상태를 건드리지 않는다(원인이 다음 폴이거나 언마운트다).
        .catch((err) => {
          if (err.name !== "AbortError") setState(UNKNOWN);
        });
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      clearInterval(timer);
      inflight?.abort();
    };
  }, []);

  return <FreshnessContext.Provider value={state}>{children}</FreshnessContext.Provider>;
}

export function useFreshness() {
  return useContext(FreshnessContext);
}
