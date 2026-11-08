export function validChatChart(chart) {
  const field = key => typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key);
  return Boolean(chart && ["bar", "stacked_bar", "line"].includes(chart.type)
    && ["usd", "tokens", "count", "percent"].includes(chart.unit)
    && typeof chart.title === "string" && chart.title.length <= 160
    && field(chart.x) && ["category", "time"].includes(chart.x_type || "category")
    && (chart.coverage === undefined || ["canonical", "unverified"].includes(chart.coverage))
    && (chart.cost_bases === undefined || (Array.isArray(chart.cost_bases) && chart.cost_bases.length <= 5
      && chart.cost_bases.every(basis => ["client_reported", "aws_list_estimate", "computed_estimate", "mixed", "unknown"].includes(basis))))
    && ["sql", "dashboard"].includes(chart.source) && Array.isArray(chart.series) && chart.series.length > 0 && chart.series.length <= 3
    && chart.series.every(s => s && field(s.key) && s.key !== chart.x && typeof s.label === "string" && s.label.length <= 160)
    && new Set(chart.series.map(s => s.key)).size === chart.series.length
    && Array.isArray(chart.data) && chart.data.length > 0 && chart.data.length <= 50
    && chart.data.every(row => row && Object.hasOwn(row, chart.x) && typeof row[chart.x] === "string" && row[chart.x].length <= 160
      && chart.series.every(s => Object.hasOwn(row, s.key) && (row[s.key] === null || (typeof row[s.key] === "number" && Number.isFinite(row[s.key]))))));
}
