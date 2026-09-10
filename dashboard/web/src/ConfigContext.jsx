import { createContext, useContext } from "react";

// /api/config의 런타임 설정. main.jsx가 첫 렌더 전에 한 번 받아 App으로 넘긴다 — 소비자마다
// 따로 fetch하면 같은 값을 두 번 받고 실패 처리도 두 벌이 된다.
//
// 기본값은 fail-safe 방향으로 고른다: /api/config가 실패·타임아웃하거나 구버전 서버라 키가
// 없어도 기존 동작(A/B 2일 기본, 90일 상한)이 그대로 나오고, piiMask는 fmt.js와 같은
// fail-closed ON이라 마스킹이 꺼진 채 렌더되는 일이 없다. schema는 undefined로 둔다 —
// 소비자는 === true만 "적용됨"으로 봐야 미확인 상태가 적용된 것으로 오인되지 않는다(현재 UI
// 소비자는 없고 /api/config 표면 유지용).
const DEFAULTS = {
  groupMode: "ab",
  defaultRangeDays: 2,
  rangeCapDays: 90,
  schema: undefined,
  piiMask: true,
  pricing: undefined,
};

const ConfigContext = createContext(DEFAULTS);

export function ConfigProvider({ config, children }) {
  const value = config
    ? {
        groupMode: config.groupMode === "single" ? "single" : DEFAULTS.groupMode,
        defaultRangeDays: Number.isInteger(config.defaultRangeDays) ? config.defaultRangeDays : DEFAULTS.defaultRangeDays,
        rangeCapDays: Number.isInteger(config.rangeCapDays) ? config.rangeCapDays : DEFAULTS.rangeCapDays,
        schema: config.schema,
        piiMask: config.piiMask === false ? false : DEFAULTS.piiMask,
        pricing: config.pricing,
      }
    : DEFAULTS;
  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

// provider 없이 불러도 DEFAULTS가 나온다(createContext의 기본값) — App.test.jsx가 <App />을
// prop 없이 렌더하고, 그때도 모든 페이지가 기존 동작으로 그려져야 한다.
export function useConfig() {
  return useContext(ConfigContext);
}
