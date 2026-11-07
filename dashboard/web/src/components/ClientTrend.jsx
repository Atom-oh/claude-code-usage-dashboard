import { useMemo } from "react";
import { Card } from "./Card.jsx";
import { DualLineChart } from "./GroupCharts.jsx";
import { costResolutionLabel as bucketLabel } from "../costResolution.js";
import { parseUtc } from "../fmt.js";
import { clientTimeline, formatObserved } from "../clientUsage.js";
import { basisLabel, BROWSER_TIME_ZONE, clientName, formatClientTime, observedNumber } from "../clientPresentation.js";

const compactAxis = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 });
export const clientColor = (client) => client === "claude" ? "var(--chart-1)" : "var(--chart-2)";
const color = clientColor;
export const EMPTY_VALUE = "—는 미수집·미지원·미산정 값입니다. 관측된 0과 구분합니다.";

// Per-client token/cost trend from /api/clients/overview timeseries. Bases differ, so client
// series are drawn side by side and never summed. onBucket({ from, to }) (optional): a click on a
// bucket reports its UTC bounds, clamped to the effective range.
export function ClientTrend({ rows, clients, clientRows, bucketHours, effectiveRange, metric = "both", title = "사용량·비용 추이", stale = false, onBucket }) {
  const { timeline, timeDomain, rejections, step } = useMemo(() => {
    const timeline = clientTimeline(rows, { bucketHours, effectiveRange })
      .map((row) => ({ ...row, t: parseUtc(row.t).getTime() }))
      .filter((row) => Number.isFinite(row.t));
    const from = Date.parse(effectiveRange?.from), to = Date.parse(effectiveRange?.to);
    const step = Number.isFinite(bucketHours * 3600000) && bucketHours > 0 ? bucketHours * 3600000 : 3600000;
    const timeDomain = Number.isFinite(from) && Number.isFinite(to) && from < to
      ? [from, to] : timeline.length ? [timeline[0].t, timeline.at(-1).t + step] : undefined;
    const rejections = new Map(rows.filter(row => row.request_rejections_only === true)
      .map(row => [`${row.client}:${parseUtc(row.t.replace(/(?:\.\d+)?Z$/, "")).getTime()}`,
        observedNumber(row.rejected_requests)]));
    return { timeline, timeDomain, rejections, step };
  }, [rows, bucketHours, effectiveRange?.from, effectiveRange?.to]);
  const pickBucket = onBucket ? (start) => {
    const lo = Date.parse(effectiveRange?.from), hi = Date.parse(effectiveRange?.to);
    const from = Number.isFinite(lo) ? Math.max(start, lo) : start;
    const to = Number.isFinite(hi) ? Math.min(start + step, hi) : start + step;
    if (Number.isFinite(from) && from < to) onBucket({ from: new Date(from).toISOString(), to: new Date(to).toISOString() });
  } : undefined;
  const lines = clients.flatMap((client) => {
    const row = clientRows.find((row) => row.client === client);
    const partial = row?.cost_partial === true || observedNumber(row?.unpriced) > 0
      || rows.some(period => period.client === client && period.cost_partial === true);
    const status = row?.cost_usd == null ? " · 미산정" : partial ? " · 부분합 포함" : "";
    const basis = `${basisLabel(row?.cost_basis)}${status}`;
    const tokenPartial = row?.tokens_partial === true
      || rows.some((period) => period.client === client && (period.tokens_partial === true || period.observed_tokens === null));
    return [
      ...(metric !== "cost" ? [{ key: `${client}_tokens`, label: `${clientName(client)} 관측 토큰${tokenPartial ? " · 부분합 포함" : ""}`, color: color(client) }] : []),
      ...(metric !== "tokens" ? [{ key: `${client}_cost`, label: `${clientName(client)} 비용 (USD · ${basis})`, color: color(client), axis: metric === "both" ? "right" : "left" }] : []),
    ];
  });
  if (!timeline.some((row) => lines.some((line) => observedNumber(row[line.key]) !== null))) {
    return <Card title={title}><p className="text-sm text-ink-500">표시할 관측값이 없습니다. {EMPTY_VALUE}</p></Card>;
  }
  return <DualLineChart title={title}
    subtitle={`${bucketLabel(bucketHours)} · 브라우저 시간 (${BROWSER_TIME_ZONE}) · 관측 사용량 없음은 0, 사용량 미확인은 공백으로 표시합니다.${metric !== "cost" ? " 관측 토큰은 수집된 값 중 확인된 합계이며, 사용량·메타데이터가 불완전하면 부분합입니다." : ""}${metric !== "tokens" ? " 비용은 알려진 값만 합산합니다." : ""}${onBucket ? " 버킷을 클릭하면 그 구간의 작업 목록을 표시합니다." : ""}`}
    help="0은 해당 시간에 집계된 사용량이 없다는 뜻입니다. 이벤트 자체의 전송 누락은 미사용과 구분할 수 없으며, 차트가 누락된 사용량을 복원하지는 않습니다."
    tooltipFormatter={(value, name, item) => {
      const client = String(item.dataKey).split("_")[0];
      const rejected = rejections.get(`${client}:${item.payload?.t}`);
      const unpriced = String(item.dataKey).endsWith("_cost") && item.payload?.[item.dataKey] == null;
      return [unpriced ? "미산정" : value == null ? "미확인" : value === 0 && rejected > 0
        ? `0 (요청 거절 ${formatObserved(rejected)}건)`
        : item.payload?.empty_clients?.includes(client) ? `${value} (관측 사용량 없음)` : value, name];
    }}
    rows={timeline} xKey="t" zoomDisabled={stale} lines={lines} bucketHours={bucketHours} onBucketClick={pickBucket}
    timeDomain={timeDomain}
    tickFormatter={formatClientTime} valueTickFormatter={compactAxis.format} height={metric === "both" ? 320 : 240} />;
}
