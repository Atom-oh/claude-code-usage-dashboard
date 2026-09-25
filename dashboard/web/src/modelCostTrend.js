// Partial-preserving model cost cells for ModelCostTrend: known amounts are summed as they are,
// unavailable is never zero, a measured $0 stays distinct, and idle cells follow ADR-015.
import { MODEL_TREND_COLORS, MODEL_TREND_OTHERS, MODEL_TREND_VENDOR_RAMPS, modelColorFor } from "./colors.js";

export const MAX_INTERVALS = 5000;
export const OTHERS_KEY = "__others";
export const OTHERS_COLOR_KEY = "others";
export const REASON_GROUPS = [
  { key: "report_missing", label: "보고 비용 없음", reasons: ["report_missing"] },
  { key: "report_zero_with_tokens", label: "보고 0·토큰 있음", reasons: ["report_zero_with_tokens"] },
  { key: "scope", label: "범위·백엔드 불일치", reasons: ["scope", "unknown_backend"] },
  { key: "unknown_model", label: "단가 미등록 모델", reasons: ["unknown_model"] },
  { key: "invalid_usage", label: "유효하지 않은 사용량", reasons: ["invalid_usage"] },
  { key: "missing_usage", label: "사용량 미기록", reasons: ["missing_usage"] },
  { key: "unspecified", label: "사유 미확인", reasons: ["unspecified"] },
];
export const STATE_LABELS = {
  known: "확인됨", zero: "$0 (측정값)", partial: "부분합",
  unavailable: "확인 불가", idle: "기록된 사용 없음", nodata: "데이터 없음",
};

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

// Finite amount >= 0 from a number or a non-blank numeric string; anything else is null.
function amount(v) {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

function count(v) {
  const n = amount(v);
  return n === null ? null : Math.floor(n);
}

// Sum of known values: null stays out of the sum and the sum stays null when nothing is known.
function addKnown(sum, v) {
  if (v === null || v === undefined) return sum;
  return (sum ?? 0) + v;
}

function mergeReasons(target, reasons) {
  for (const [key, n] of Object.entries(reasons || {})) {
    if (n > 0) target[key] = (target[key] ?? 0) + n;
  }
  return target;
}

function parseUtcKey(t) {
  return Date.parse(String(t).replace(" ", "T") + "Z");
}

export function bucketKey(value) {
  let ms;
  if (typeof value === "number") {
    ms = value;
  } else if (value instanceof Date) {
    ms = value.getTime();
  } else if (typeof value === "string") {
    const s = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) ms = Date.parse(s + "T00:00:00Z");
    else if (/[zZ]$/.test(s) || /[+-]\d{2}:\d{2}$/.test(s)) ms = Date.parse(s);
    else ms = Date.parse(s.replace(" ", "T") + "Z");
  } else {
    ms = NaN;
  }
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

// Same rules as the server's normalizeModelId, applied in the same order.
export function displayModel(raw) {
  return String(raw ?? "")
    .replace(/\[[^\]]*\]$/, "")
    .replace(/^(?:us|us-gov|eu|apac|jp|au|global)\./, "")
    .replace(/^anthropic\./, "")
    .replace(/-v\d+(?::\d+)?$/, "")
    .replace(/-\d{8}$/, "");
}

export function modelLabel(displayKey) {
  return displayKey === "" ? "(모델 미상)" : displayKey;
}

export function identityLabel(model, channel) {
  const part = model === null ? "모델 미귀속" : model === "" ? "(모델 미상)" : model;
  return typeof channel === "string" && channel !== "" ? `${part} · ${channel}` : part;
}

export function reasonLabel(reason) {
  const group = REASON_GROUPS.find((g) => g.reasons.includes(reason));
  return group ? group.label : "사유 미확인";
}

function idleCell(t) {
  return { t, model: null, channel: null, known: null, partial: false, unavailable: 0, reasons: {}, observed_tokens: null, idle: true, estimated: false };
}

// Shared fix-up for every non-idle cell an adapter builds (design §B4). `estimated`: ADR-017.
function finishCell(t, model, channel, known, unavailableInput, reasonsInput, partialFlag, observedTokens, estimated = false) {
  const reasons = {};
  let sumR = 0;
  for (const [key, value] of Object.entries(reasonsInput || {})) {
    const n = count(value);
    if (n !== null && n > 0) {
      reasons[key] = n;
      sumR += n;
    }
  }
  let unavailable = Math.max(count(unavailableInput) ?? 0, sumR);
  if (unavailable > sumR) reasons.unspecified = (reasons.unspecified ?? 0) + (unavailable - sumR);
  const partial = known !== null && (partialFlag === true || unavailable > 0);
  if ((known === null || partial) && unavailable === 0) {
    unavailable = 1;
    reasons.unspecified = 1;
  }
  return { t, model, channel, known, partial, unavailable, reasons, observed_tokens: observedTokens,
    estimated: known !== null && estimated === true };
}

// Cell order: t, model === null first, model, channel (null first), then idle before metadata.
function compareCells(a, b) {
  if (a.t !== b.t) return a.t < b.t ? -1 : 1;
  if ((a.model === null) !== (b.model === null)) return a.model === null ? -1 : 1;
  if (a.model !== b.model) return a.model < b.model ? -1 : 1;
  if (a.channel !== b.channel) {
    if (a.channel === null) return -1;
    if (b.channel === null) return 1;
    return a.channel < b.channel ? -1 : 1;
  }
  const ai = a.idle === true, bi = b.idle === true;
  if (ai !== bi) return ai ? -1 : 1;
  return 0;
}

export function fromByModelDaily(rows) {
  const cells = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const t = bucketKey(row.day);
    if (t === null) continue;
    const known = row.reported_all_unavailable === true ? null : amount(row.reported_cost);
    cells.push(finishCell(t, String(row.model ?? ""), row.group || "unknown", known,
      row.reported_unavailable, row.reported_reasons || {}, row.reported_partial, amount(row.observed_tokens)));
  }
  return cells.sort(compareCells);
}

const isEstimatedBasis = (basis) => basis === "computed_estimate" || basis === "mixed";

export function fromByModelTime(data, client) {
  if (!Array.isArray(data?.by_model_time)) return null;
  const cells = [];
  const modelByT = new Map();
  for (const row of data.by_model_time) {
    if (!row || row.client !== client) continue;
    const t = bucketKey(row.t);
    if (t === null) continue;
    const cell = finishCell(t, typeof row.model === "string" ? row.model : "", row.backend || "unknown",
      amount(row.cost_usd), row.unpriced, row.unpriced_reasons || {}, row.cost_partial, amount(row.observed_tokens),
      isEstimatedBasis(row.cost_basis));
    cells.push(cell);
    if (!modelByT.has(t)) modelByT.set(t, []);
    modelByT.get(t).push(cell);
  }

  const rr = client === "claude" ? "report_missing" : "missing_usage";
  const meta = (t, known, unavailable, reasons, partialFlag, estimated) =>
    finishCell(t, null, null, known, unavailable, reasons, partialFlag, null, estimated);
  const tsKeys = new Set();
  for (const ts of Array.isArray(data.timeseries) ? data.timeseries : []) {
    if (!ts || ts.client !== client) continue;
    const t = bucketKey(ts.t);
    if (t === null) continue;
    tsKeys.add(t);
    const M = modelByT.get(t) || [];
    const covered = M.reduce((s, cell) => s + cell.unavailable, 0);
    const residual = Math.max(0, (count(ts.unpriced) ?? 0) - covered);
    const cost = amount(ts.cost_usd);
    const tsEstimated = isEstimatedBasis(ts.cost_basis);
    if (M.length === 0) {
      if (cost === null) {
        const n = Math.max(residual, 1);
        cells.push(meta(t, null, n, { [rr]: n }, false));
      } else if (cost > 0) {
        cells.push(meta(t, cost, residual, residual > 0 ? { [rr]: residual } : {}, ts.cost_partial, tsEstimated));
      } else if (ts.cost_partial === true || residual > 0) {
        const n = Math.max(residual, 1);
        cells.push(meta(t, 0, n, { [rr]: n }, false));
      } else {
        cells.push(idleCell(t));
      }
    } else {
      // Keep known evidence (an observed $0 timeline) no model row carries; add only residual counts.
      const extra = cost !== null && M.every((cell) => cell.known === null) ? cost : null;
      if (extra !== null || residual > 0) cells.push(meta(t, extra, residual, residual > 0 ? { [rr]: residual } : {}, false, tsEstimated));
    }
  }

  // Idle fill (ADR-015) only for a client that emitted at least one row in this response.
  if (cells.length > 0 || tsKeys.size > 0) {
    const from = Date.parse(data.effective_range?.from);
    const to = Date.parse(data.effective_range?.to);
    const bucketMs = Number(data.bucket_hours) * HOUR_MS;
    if (Number.isFinite(from) && Number.isFinite(to) && from < to
        && Number.isInteger(bucketMs) && bucketMs >= 1000
        && Math.ceil(to / bucketMs) - Math.floor(from / bucketMs) <= MAX_INTERVALS) {
      for (let time = from; time < to; time = (Math.floor(time / bucketMs) + 1) * bucketMs) {
        const key = bucketKey(time);
        if (!tsKeys.has(key) && !modelByT.has(key)) cells.push(idleCell(key));
      }
    }
  }
  return cells.sort(compareCells);
}

// Interval width matching ClickHouse toStartOfInterval(ts, INTERVAL n DAY|HOUR|MINUTE) in UTC.
function stepMs(hours) {
  return hours >= 24 ? Math.max(1, Math.round(hours / 24)) * DAY_MS : Math.round(hours * HOUR_MS);
}

export function rollupBuckets(cells, targetHours, { sourceHours } = {}) {
  if (!Array.isArray(cells)) return null;
  if (!(targetHours > 0) || !(sourceHours > 0) || targetHours < sourceHours) {
    throw new RangeError("rollupBuckets: target bucket is smaller than the source bucket");
  }
  const step = stepMs(targetHours);
  const groups = new Map();
  for (const cell of cells) {
    const ms = parseUtcKey(cell.t);
    if (!Number.isFinite(ms)) continue;
    const t = bucketKey(Math.floor(ms / step) * step);
    const isIdle = cell.idle === true;
    const key = JSON.stringify([t, cell.model, cell.channel, isIdle]);
    let group = groups.get(key);
    if (!group) {
      group = { t, model: cell.model, channel: cell.channel, idle: isIdle, members: [] };
      groups.set(key, group);
    }
    group.members.push(cell);
  }
  const out = [];
  for (const group of groups.values()) {
    if (group.idle) {
      out.push(idleCell(group.t));
      continue;
    }
    let known = null, observedTokens = null, unavailable = 0, estimated = false;
    const reasons = {};
    for (const member of group.members) {
      known = addKnown(known, member.known);
      observedTokens = addKnown(observedTokens, member.observed_tokens);
      unavailable += member.unavailable;
      mergeReasons(reasons, member.reasons);
      if (member.estimated) estimated = true;
    }
    const partial = known !== null && (group.members.some((m) => m.partial) || unavailable > 0);
    out.push({ t: group.t, model: group.model, channel: group.channel, known, partial, unavailable, reasons,
      observed_tokens: observedTokens, estimated: known !== null && estimated });
  }
  return out.sort(compareCells);
}

export function cellState(cell) {
  if (cell.idle === true) return "idle";
  if (cell.known === null) return "unavailable";
  if (cell.partial) return "partial";
  if (cell.known === 0) return "zero";
  return "known";
}

// A measured $0 is known (zero + unavailable is a partial $0); idle is not (idle + unavailable stays unavailable).
export function bucketState(members) {
  if (members.length === 0) return "nodata";
  const s = new Set(members.map(cellState));
  if (s.has("known") || s.has("partial")) return s.has("partial") || s.has("unavailable") ? "partial" : "known";
  if (s.has("unavailable")) return s.has("zero") ? "partial" : "unavailable";
  if (s.has("zero")) return "zero";
  return "idle";
}

// Descending with null after every number; equal values (including two nulls) compare 0.
function compareDescNullLast(x, y) {
  if (x === y) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return y - x;
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseBound(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value);
  return NaN;
}

export function buildModelCostFrame(cells, { top = 6, pinned = [], bounds, bucketHours, maxIntervals = MAX_INTERVALS } = {}) {
  const list = Array.isArray(cells) ? cells : [];
  const isModelCell = (cell) => cell.idle !== true && cell.model !== null;

  // 1. Stats per display key.
  const stats = new Map();
  for (const cell of list) {
    if (!isModelCell(cell)) continue;
    const key = displayModel(cell.model);
    let s = stats.get(key);
    if (!s) {
      s = { known: null, observed_tokens: null, hasIssue: false };
      stats.set(key, s);
    }
    s.known = addKnown(s.known, cell.known);
    s.observed_tokens = addKnown(s.observed_tokens, cell.observed_tokens);
    if (cell.known === null || cell.partial) s.hasIssue = true;
  }

  // 2. Rank: known cost, then observed tokens (unknown last), then name.
  const ranked = [...stats.keys()].sort((a, b) => {
    const A = stats.get(a), B = stats.get(b);
    return compareDescNullLast(A.known, B.known)
      || compareDescNullLast(A.observed_tokens, B.observed_tokens)
      || compareText(a, b);
  });

  // 3. Series membership: top-N plus pinned models present in the period, in ranked order.
  const pinnedKeys = new Set((Array.isArray(pinned) ? pinned : []).filter(Boolean).map(displayModel));
  const picked = new Set(ranked.slice(0, top));
  for (const key of pinnedKeys) {
    if (stats.has(key)) picked.add(key);
  }
  const seriesKeys = ranked.filter((key) => picked.has(key));

  const series = seriesKeys.map((model, i) => {
    const s = stats.get(model);
    const { key: colorKey, hatch } = modelColorKey(model);
    return { key: "s" + i, model, label: modelLabel(model), colorKey, hatch, known: s.known,
      observed_tokens: s.observed_tokens, pinned: pinnedKeys.has(model), hasIssue: s.hasIssue };
  });
  const seriesByModel = new Map(series.map((s) => [s.model, s.key]));
  // A model === null cell never belongs to a series even though displayModel(null) is "".
  const seriesOf = (cell) => (cell.model === null ? null : seriesByModel.get(displayModel(cell.model)) ?? null);

  // 5. 기타 summary over every non-idle cell outside the series.
  const otherModels = ranked.filter((key) => !seriesByModel.has(key));
  let othersKnown = null;
  for (const cell of list) {
    if (cell.idle !== true && seriesOf(cell) === null) othersKnown = addKnown(othersKnown, cell.known);
  }
  const others = { key: OTHERS_KEY, label: otherModels.length ? `기타 ${otherModels.length}개 모델` : "모델 미귀속", count: otherModels.length,
    models: otherModels, known: othersKnown, affected: otherModels.filter((key) => stats.get(key).hasIssue) };

  // 6. Bucket keys: every cell's t plus the bounded grid when it fits the interval cap.
  const keySet = new Set(list.map((cell) => cell.t));
  let sparse = true;
  const from = parseBound(bounds?.from), to = parseBound(bounds?.to);
  if (Number.isFinite(from) && Number.isFinite(to) && from < to && bucketHours > 0) {
    const step = stepMs(bucketHours);
    // First key: the floor for detail cells, `from` for shared ones (greatest(bucket, from)).
    const floor = Math.floor(from / step) * step;
    const first = keySet.has(bucketKey(floor)) ? floor : from;
    if (Math.ceil(to / step) - Math.floor(from / step) <= maxIntervals) {
      for (let time = first; time < to; time = (Math.floor(time / step) + 1) * step) keySet.add(bucketKey(time));
      sparse = false;
    }
  }
  const keys = [...keySet].sort();

  const byT = new Map();
  for (const cell of list) {
    if (!byT.has(cell.t)) byT.set(cell.t, []);
    byT.get(cell.t).push(cell);
  }
  const buckets = keys.map((t) => {
    const members = byT.get(t) || [];
    const state = bucketState(members);
    const segments = {};
    for (const s of series) segments[s.key] = null;
    let othersSum = null, total = null, unavailable = 0, hasEstimate = false;
    const reasons = {};
    const issues = [];
    for (const cell of members) {
      unavailable += cell.unavailable;
      mergeReasons(reasons, cell.reasons);
      if (cell.idle === true) continue;
      const sk = seriesOf(cell);
      if (sk !== null) segments[sk] = addKnown(segments[sk], cell.known);
      else othersSum = addKnown(othersSum, cell.known);
      total = addKnown(total, cell.known);
      if (cell.estimated) hasEstimate = true;
      if (cell.known === null || cell.partial) {
        issues.push({ model: cell.model, channel: cell.channel, label: identityLabel(cell.model, cell.channel),
          unavailable: cell.unavailable, reasons: cell.reasons, series: sk ?? OTHERS_KEY });
      }
    }
    const partialSeries = series.map((s) => s.key).filter((key) => issues.some((issue) => issue.series === key));
    const othersPartial = issues.some((issue) => issue.series === OTHERS_KEY);
    return { t, state, total, segments, others: othersSum, unavailable, reasons, issues, partialSeries, othersPartial,
      hasEstimate: total !== null && hasEstimate };
  });

  let totalsKnown = null;
  let reviewBuckets = 0, idleBuckets = 0, estimateBuckets = 0;
  for (const b of buckets) {
    totalsKnown = addKnown(totalsKnown, b.total);
    if (b.state === "partial" || b.state === "unavailable") reviewBuckets += 1;
    if (b.state === "idle") idleBuckets += 1;
    if (b.hasEstimate) estimateBuckets += 1;
  }
  const allReasons = {};
  for (const cell of list) mergeReasons(allReasons, cell.reasons);
  const issueCells = list.filter((cell) => cell.idle !== true && (cell.known === null || cell.partial));
  const identityKey = (cell) => JSON.stringify([cell.model, cell.channel]);
  const identityCount = new Set(issueCells.map(identityKey)).size;
  const issues = [];
  for (const group of REASON_GROUPS) {
    const groupCount = group.reasons.reduce((s, r) => s + (allReasons[r] ?? 0), 0);
    if (groupCount <= 0) continue;
    const perIdentity = new Map();
    for (const cell of issueCells) {
      const n = group.reasons.reduce((s, r) => s + (cell.reasons?.[r] ?? 0), 0);
      if (n <= 0) continue;
      const key = identityKey(cell);
      let entry = perIdentity.get(key);
      if (!entry) {
        entry = { model: cell.model, channel: cell.channel, label: identityLabel(cell.model, cell.channel),
          count: 0, inOthers: seriesOf(cell) === null };
        perIdentity.set(key, entry);
      }
      entry.count += n;
    }
    const identities = [...perIdentity.values()].sort((a, b) => (b.count - a.count) || compareText(a.label, b.label));
    issues.push({ key: group.key, label: group.label, count: groupCount, identities });
  }
  const totals = { known: totalsKnown, reviewBuckets, idleBuckets, estimateBuckets, reasons: allReasons, issues, identityCount };

  // 9. 기타 breakdown by (model, channel).
  const breakdown = new Map();
  for (const cell of list) {
    if (cell.idle === true || seriesOf(cell) !== null) continue;
    const key = identityKey(cell);
    let entry = breakdown.get(key);
    if (!entry) {
      entry = { model: cell.model, label: identityLabel(cell.model, null), channel: cell.channel, known: null, unavailable: 0 };
      breakdown.set(key, entry);
    }
    entry.known = addKnown(entry.known, cell.known);
    entry.unavailable += cell.unavailable;
  }
  const othersBreakdown = [...breakdown.values()].sort((a, b) =>
    compareDescNullLast(a.known, b.known)
    || (b.unavailable - a.unavailable)
    || compareText(a.label, b.label)
    || compareText(a.channel ?? "", b.channel ?? ""));

  return { series, others, buckets, totals, othersBreakdown, sparse, empty: list.length === 0,
    allUnavailable: totals.known === null && totals.reviewBuckets > 0 };
}

export function formatUsd(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v > 0 && v < 0.01) return "<$0.01";
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatUsdPrecise(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return "$" + v.toLocaleString("en-US", { maximumSignificantDigits: 6 });
}

export function formatAxisUsd(v) {
  if (!Number.isFinite(v)) return "";
  if (v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1000) return "$" + new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v);
  if (abs >= 1) return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return "$" + v.toLocaleString("en-US", { maximumSignificantDigits: 2 });
}

function nameHash(s) {
  let h = 0;
  for (const ch of String(s)) h = (Math.imul(h, 31) + ch.codePointAt(0)) >>> 0;
  return h;
}

// The key depends only on the model name, never on rank, order or other models.
export function modelColorKey(model) {
  const name = displayModel(model);
  const registered = MODEL_TREND_COLORS.light;
  if (Object.hasOwn(registered, name)) return { key: name, hatch: false };
  if (Object.hasOwn(registered, "openai." + name)) return { key: "openai." + name, hatch: false };
  // Other known Claude models and families keep their modelColorFor color, solid: the hatch marks
  // only models outside both sets, so an older Claude model never reads as unknown.
  if (modelColorFor(name)) return { key: `family:${name}`, hatch: false };
  const vendor = /^claude/.test(name) ? "anthropic" : /^(?:openai\.|gpt-)/.test(name) ? "openai" : "other";
  return { key: `${vendor}-${nameHash(name) % 3}`, hatch: true };
}

export function trendColor(key, theme = "light") {
  const mode = theme === "dark" ? "dark" : "light";
  const k = String(key ?? "");
  if (Object.hasOwn(MODEL_TREND_COLORS[mode], k)) return MODEL_TREND_COLORS[mode][k];
  if (k === OTHERS_COLOR_KEY) return MODEL_TREND_OTHERS[mode];
  // modelColorFor has one set for both themes.
  if (k.startsWith("family:")) return modelColorFor(k.slice(7)) ?? MODEL_TREND_OTHERS[mode];
  const ramp = /^(anthropic|openai|other)-(\d+)$/.exec(k);
  if (ramp) {
    const color = MODEL_TREND_VENDOR_RAMPS[ramp[1]][mode][Number(ramp[2])];
    if (color) return color;
  }
  return MODEL_TREND_OTHERS[mode];
}

// Accepts #rgb, #rrggbb or rgb(r, g, b); anything else is unparsable.
function parseSurface(value) {
  const s = String(value ?? "").trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [...m[1]].map((ch) => parseInt(ch + ch, 16));
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(s);
  if (m) return [m[1], m[2], m[3]].map(Number);
  return null;
}

// Relative luminance of the card surface below 0.2 selects the dark palette.
export function chartTheme(surface) {
  const rgb = parseSurface(surface);
  if (!rgb) return "light";
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.2 ? "dark" : "light";
}
