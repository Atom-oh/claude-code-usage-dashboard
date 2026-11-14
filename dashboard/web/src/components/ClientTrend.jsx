import { richMessage, localizedFormat, translate, translateSource, useLocale } from "../i18n/index.js";
import { useMemo } from "react";
import { Card } from "./Card.jsx";
import { DualLineChart } from "./GroupCharts.jsx";
import { costResolutionLabel as bucketLabel } from "../costResolution.js";
import { parseUtc } from "../fmt.js";
import { clientTimeline, formatObserved } from "../clientUsage.js";
import { basisLabel, BROWSER_TIME_ZONE, clientName, formatClientTime, observedNumber } from "../clientPresentation.js";

const compactAxis = localizedFormat("NumberFormat", { notation: "compact", maximumSignificantDigits: 3 });
export const clientColor = (client) => client === "claude" ? "var(--chart-1)" : "var(--chart-2)";
const color = clientColor;
export const EMPTY_VALUE = "—는 미수집·미지원·미산정 값입니다. 관측된 0과 구분합니다.";

// Per-client token/cost trend from /api/clients/overview timeseries. Bases differ, so client
// series are drawn side by side and never summed. onBucket({ from, to }) (optional): a click on a
// bucket reports its UTC bounds, clamped to the effective range.
export function ClientTrend({ rows, clients, clientRows, bucketHours, effectiveRange, metric = "both", title = translate("m38098ab0a940"), stale = false, onBucket }) {
  const _locale = useLocale();
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
  }, [rows, bucketHours, effectiveRange?.from, effectiveRange?.to, _locale]);
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
    const status = row?.cost_usd == null ? translate("m8ef5953a7940") : partial ? translate("m4bd689a8ae70") : "";
    const basis = `${basisLabel(row?.cost_basis)}${status}`;
    const tokenPartial = row?.tokens_partial === true
      || rows.some((period) => period.client === client && (period.tokens_partial === true || period.observed_tokens === null));
    return [
      ...(metric !== "cost" ? [{ key: `${client}_tokens`, label: translate("m5a70d52ce95f", [clientName(client), tokenPartial ? translate("m4bd689a8ae70") : ""]), color: color(client) }] : []),
      ...(metric !== "tokens" ? [{ key: `${client}_cost`, label: translate("ma89ad7ace959", [clientName(client), basis]), color: color(client), axis: metric === "both" ? "right" : "left" }] : []),
    ];
  });
  if (!timeline.some((row) => lines.some((line) => observedNumber(row[line.key]) !== null))) {
    return <Card title={title}><p className="text-sm text-ink-500">{richMessage("m7a7c3c31b087", [translateSource(EMPTY_VALUE)])}</p></Card>;
  }
  return <DualLineChart title={title}
    subtitle={translate("m958523211c79", [bucketLabel(bucketHours), BROWSER_TIME_ZONE, metric !== "cost" ? translate("m2931538aee1f") : "", metric !== "tokens" ? translate("m5bf7937c46cb") : "", onBucket ? translate("md512b1ff45e2") : ""])}
    help={translate("m59fde76bfc00")}
    tooltipFormatter={(value, name, item) => {
      const client = String(item.dataKey).split("_")[0];
      const rejected = rejections.get(`${client}:${item.payload?.t}`);
      const unpriced = String(item.dataKey).endsWith("_cost") && item.payload?.[item.dataKey] == null;
      return [unpriced ? translate("ma8761601c736") : value == null ? translate("mdc0c487c9693") : value === 0 && rejected > 0
        ? translate("m09ae0ef88ef3", [formatObserved(rejected)])
        : item.payload?.empty_clients?.includes(client) ? translate("m9ceb0b8b8595", [value]) : value, name];
    }}
    rows={timeline} xKey="t" zoomDisabled={stale} lines={lines} bucketHours={bucketHours} onBucketClick={pickBucket}
    timeDomain={timeDomain}
    tickFormatter={formatClientTime} valueTickFormatter={compactAxis.format} height={metric === "both" ? 320 : 240} />;
}
