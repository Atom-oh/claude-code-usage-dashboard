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
