// ../awsops web/lib/use-chart-colors.ts 포팅 — recharts는 CSS var()를 못 읽어서 getComputedStyle로 resolve.
const FALLBACK = {
  lead: "#528DF8",
  palette: ["#528DF8", "#01A88D", "#7B26FF", "#39C2B0", "#7D8A96"],
  grid: "#E7ECEF",
  axis: "#7D8A96",
  tooltipBg: "#16202A",
  tooltipFg: "#F4F6F8",
};

export function useChartColors() {
  if (typeof window === "undefined") return FALLBACK;
  const s = getComputedStyle(document.documentElement);
  const v = (name, fb) => s.getPropertyValue(name).trim() || fb;
  return {
    lead: v("--chart-1", FALLBACK.lead),
    palette: [
      v("--chart-1", FALLBACK.palette[0]),
      v("--chart-2", FALLBACK.palette[1]),
      v("--chart-3", FALLBACK.palette[2]),
      v("--chart-4", FALLBACK.palette[3]),
      v("--chart-5", FALLBACK.palette[4]),
    ],
    grid: v("--chart-grid", FALLBACK.grid),
    axis: v("--chart-axis", FALLBACK.axis),
    tooltipBg: v("--chart-tooltip-bg", FALLBACK.tooltipBg),
    tooltipFg: v("--chart-tooltip-fg", FALLBACK.tooltipFg),
    // 스택 세그먼트/겹침 마크 사이 "서피스 갭"용(dataviz 마크 스펙) — 차트가 얹히는 카드 배경색.
    surface: v("--surface-card", "#ffffff"),
    // 범례 텍스트용 잉크 — recharts 기본 Legend는 텍스트를 시리즈 색으로 칠하는데(dataviz:
    // 텍스트는 잉크 토큰, 색은 옆의 마크가 나른다), formatter로 이 색을 강제한다.
    ink: v("--text-secondary", "#5b6b79"),
    // 엠퍼시스(하나 강조, 나머지 회색)의 그 회색 — 서피스 위에서 존재는 보이되 물러나는 톤.
    mute: v("--ink-200", "#d7dde3"),
  };
}

export function axisTick(c) {
  return { fill: c.axis, fontSize: 11 };
}

export function tooltipStyles(c) {
  return {
    contentStyle: { background: c.tooltipBg, border: "none", borderRadius: 8, boxShadow: "0 6px 24px rgba(0,0,0,.25)", padding: "8px 10px" },
    labelStyle: { color: c.tooltipFg, fontSize: 11, marginBottom: 2 },
    itemStyle: { color: c.tooltipFg, fontSize: 12 },
  };
}
