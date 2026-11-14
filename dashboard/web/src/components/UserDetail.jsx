import { richMessage, localize, translate, translateSource, useLocale } from "../i18n/index.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { Card, ErrorBox, Loading } from "./Card.jsx";
import { StatTile } from "./StatTile.jsx";
import { DataTable } from "./DataTable.jsx";
import { GroupBarChart } from "./GroupCharts.jsx";
import { SectionLabel } from "./SectionLabel.jsx";
import { ClientTrend } from "./ClientTrend.jsx";
import { TaskList } from "./TaskList.jsx";
import { TaskTraceOverlay } from "./TaskTraceOverlay.jsx";
import { useApi } from "../useApi.js";
import { useRange } from "../RangeContext.jsx";
import { maskEmail } from "../fmt.js";
import { APPROVAL_HELP } from "../score.js";
import { teamSuffix, useTeams } from "../TeamsContext.jsx";
import { formatClientCost, formatObserved } from "../clientUsage.js";
import { clientName, formatClientTimestamp, OBSERVED_TOKEN_HELP, presentationRow } from "../clientPresentation.js";
import { claudeOnlyFields, heatmapDays } from "../userDetail.js";

const DAY = 86400000;
const HEATMAP_DAYS = 90; // server range cap
const GRID = "grid grid-cols-2 xl:grid-cols-4 gap-4";
const CODEX_MISSING = "Codex: 미수집";
const STATUS_COLOR = { accept: "var(--positive)", reject: "var(--negative)" };
const LEVEL_BG = ["var(--ink-100)", "#cfe0fd", "#9dc2fb", "#6ba3f9", "var(--brand-500)"];
const text = (key, label) => ({ key, label, render: (v) => v || "—" });
const APPROVALS = localize([text("tool", "도구"), text("decision", "결정"), text("source", "결정 출처"),
  { key: "count", label: "건수", render: formatObserved }]);
const known = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const sumOf = (rows, key) => {
  const values = (rows || []).map((r) => known(r[key])).filter((v) => v !== null);
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
};

// GitHub-style grid over the last 90 UTC days ending at `to`. Cells are per-bucket session counts
// summed per day ("observed session activity"), not unique sessions. A day with no row is a
// recorded zero; a day whose clients are all unknown stays "미확인".
function Heatmap({ days, to, clients }) {
  const _locale = useLocale();
  const byDay = new Map(days.map((d) => [d.day, d]));
  const max = Math.max(1, ...days.map((d) => d.sessions ?? 0));
  const last = new Date(Date.parse(to) - 1);
  const lastMs = Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate());
  const firstMs = lastMs - (HEATMAP_DAYS - 1) * DAY;
  const gridEnd = lastMs + (6 - new Date(lastMs).getUTCDay()) * DAY;
  const gridStart = firstMs - new Date(firstMs).getUTCDay() * DAY;
  const weeks = [];
  for (let col = gridStart; col <= gridEnd; col += 7 * DAY) {
    weeks.push(Array.from({ length: 7 }, (_, d) => {
      const ms = col + d * DAY;
      if (ms < firstMs || ms > lastMs) return null;
      const key = new Date(ms).toISOString().slice(0, 10);
      const row = byDay.get(key);
      return { key, n: row ? row.sessions : 0, by: row?.by_client || {} };
    }));
  }
  const level = (n) => (n === null ? 0 : n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)));
  const count = (n) => (n === null ? translate("mdc0c487c9693") : formatObserved(n ?? 0));
  const label = (c) => translate("m351448015493", [c.key, count(c.n)])
    + (clients.length > 1 ? ` (${clients.map((cl) => `${clientName(cl)} ${count(c.by[cl])}`).join(" · ")})` : "");
  const monthOf = (col) => col.filter(Boolean).at(-1).key.slice(0, 7);
  const months = weeks.flatMap((col, i) => {
    const month = monthOf(col);
    const previous = i ? monthOf(weeks[i - 1]) : null;
    return month === previous ? [] : [{ column: i, label: translate("m1439158531a2", [Number(month.slice(5))]) }];
  });
  const columns = { gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` };
  return <div className="w-full min-w-0" role="img" aria-label={translate("md45b8c457d55")}>
    <div className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-2 gap-y-2">
      <div aria-hidden="true" />
      <div className="grid gap-1 text-xs text-ink-500" style={columns} aria-hidden="true">
        {months.map((month, i) => <span key={month.column}
          className={`whitespace-nowrap ${(months[i + 1]?.column ?? weeks.length) - month.column === 1 ? "hidden sm:block" : ""}`}
          style={{ gridColumn: `${month.column + 1} / span ${(months[i + 1]?.column ?? weeks.length) - month.column}` }}>
          {month.label}
        </span>)}
      </div>
      <div className="flex flex-col gap-1 text-xs text-ink-500" aria-hidden="true">
        {[translate("mdfc76879e2f5"), translate("med8a406d02b1"), translate("m950afe85bf40"), translate("mdcd19f5b5caa"), translate("m5fbc9add7bd4"), translate("md6f030e0b2b5"), translate("m164f51aa4871")].map((day) =>
          <span key={day} className="flex h-5 items-center justify-center sm:h-7">{day}</span>)}
      </div>
      <div className="grid min-w-0 gap-1" style={columns}>
        {weeks.map((col, i) => <div key={i} className="flex min-w-0 flex-col gap-1">
          {col.map((c, j) => c === null ? <span key={j} className="h-5 sm:h-7" aria-hidden="true" />
            : <span key={j} title={label(c)}
              className="flex h-5 items-center justify-center rounded text-[11px] tabular-nums text-ink-800 sm:h-7"
              style={{ background: c.n === null ? "var(--ink-200)" : LEVEL_BG[level(c.n)] }}>
              <span className="hidden sm:inline" aria-hidden="true">{Number(c.key.slice(8))}</span>
            </span>)}
        </div>)}
      </div>
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-500" aria-hidden="true">
      <span>{new Date(firstMs).toISOString().slice(0, 10)} ~ {new Date(lastMs).toISOString().slice(0, 10)}</span>
      <span className="flex items-center gap-1.5">{richMessage("m51256e975ae1", [LEVEL_BG.map((background) => <span key={background} className="h-3 w-3 rounded-sm" style={{ background }} />), <span className="ml-2 h-3 w-3 rounded-sm bg-ink-200" />])}</span>
    </div>
  </div>;
}

function Summary({ totals }) {
  const _locale = useLocale();
  const row = presentationRow(totals || {});
  return <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
    <StatTile label={translate("me600d4f5926e")} value={formatObserved(row.sessions)} />
    <StatTile label={translate("m24423dd67b3a")} value={formatClientCost(row.cost_usd)} variant="accent" hint={row.cost_basis_label || undefined}
      help={translate("mfb9b76e9f5a3")} />
    <StatTile label={translate("m187f5b1fe374")} value={formatObserved(row.observed_tokens)} hint={row.token_status} help={translateSource(OBSERVED_TOKEN_HELP)} />
  </div>;
}

// Claude-only measures (LOC, commits, code-edit decisions). Codex has no source for them, so a
// Codex selection shows "미수집", never 0. `group` applies here only.
function ClaudeOnly({ daily, decisions, show, codexUnavailable }) {
  const _locale = useLocale();
  const pending = show && (daily.loading || decisions.loading || daily.stale || decisions.stale);
  const error = show && (daily.error || decisions.error);
  const agg = useMemo(() => Object.values((decisions.data || []).reduce((acc, r) => {
    const k = `${r.tool}|${r.decision}`;
    (acc[k] ||= { tool: r.tool, decision: r.decision, n: 0 }).n += Number(r.n) || 0;
    return acc;
  }, {})), [decisions.data, _locale]);
  const accepted = agg.filter((r) => r.decision === "accept").reduce((n, r) => n + r.n, 0);
  const decided = agg.filter((r) => r.decision === "accept" || r.decision === "reject").reduce((n, r) => n + r.n, 0);
  const hint = codexUnavailable ? translateSource(CODEX_MISSING) : undefined;
  const value = (v) => (!show ? translate("m08a739493081") : v);
  return <section aria-label={translate("m42306a6533fe")} className="flex flex-col gap-3">
    <SectionLabel>{translate("m42306a6533fe")}</SectionLabel>
    {error ? <ErrorBox error={error} /> : pending ? <Loading /> : <>
      <div className={GRID}>
        <StatTile label={translate("m81ea6a128280")} value={value(formatObserved(sumOf(daily.data, "loc")))} hint={hint} />
        <StatTile label={translate("ma5d6612cd595")} value={value(formatObserved(sumOf(daily.data, "commits")))} hint={hint} />
        <StatTile label={translate("m114ca4c67ab7")} value={value(decided > 0 ? `${Math.round(accepted / decided * 100)}%` : "—")}
          hint={hint} help={translateSource(APPROVAL_HELP)} />
      </div>
      {show && <GroupBarChart title={translate("m32835514de29")} rows={agg} xKey="tool" valueKey="n" height={180}
        colorFn={(r) => STATUS_COLOR[r.decision] || "var(--ink-400)"} />}
    </>}
  </section>;
}

function CodexDecisions({ api }) {
  const _locale = useLocale();
  const { data, loading, error, stale } = api;
  const rate = data?.summary?.approval_rate;
  return <section aria-label={translate("m464028e3861a")} className="flex flex-col gap-3">
    {error ? <ErrorBox error={error} /> : loading ? <Loading /> : <>
      {data?.coverage?.logs?.status === "limited" && <p role="status" className="text-sm text-warning-text">{translate("m28fc0395ddd7")}</p>}
      <DataTable title={translate("m464028e3861a")} columns={APPROVALS} rows={data?.approvals || []}
        subtitle={translate("mf4a59f2481d6")}
        right={<span className="text-[12px] text-ink-600 tabular">{richMessage("m72a89655c2d4", [rate == null ? "—" : `${Math.round(rate * 1000) / 10}%`])}</span>}
        exportName="user_codex_approvals" stale={stale} />
    </>}
  </section>;
}

// Tasks default to the overview's effective range. A click narrows them to one bucket;
// a global range change (including chart drag) resets that override and the open task.
export function UserDetail({ user, clients, group = null, hours, parentRange, stale, onClose, onBucket = null, children }) {
  const _locale = useLocale();
  const range = useRange();
  const teams = useTeams();
  const headingRef = useRef(null);
  useEffect(() => {
    headingRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    headingRef.current?.focus({ preventScroll: true });
  }, []);
  const { show: showClaude, codexUnavailable } = claudeOnlyFields(clients);
  const showCodex = clients.includes("codex");
  const client = clients.length > 1 ? "all" : clients[0];
  const linked = Boolean(parentRange?.from && parentRange?.to);
  const bounds = linked ? { from: parentRange.from, to: parentRange.to } : {};
  const heatTo = linked ? parentRange.to : range.to.toISOString();
  const heatFrom = new Date(Date.parse(heatTo) - HEATMAP_DAYS * DAY).toISOString();
  const overview = useApi("/api/clients/overview", { client, userExact: user, intervalHours: hours, ...bounds }, true,
    { linkedRange: linked, hold: stale });
  const heat = useApi("/api/clients/activity", { client, userExact: user, intervalHours: 24, from: heatFrom, to: heatTo }, true,
    { linkedRange: linked, hold: stale });
  // Claude-only drilldowns: explicit identity and group, no global filters (these routes reject team).
  const claudeParams = { email: user, ...(group ? { group } : {}), ...bounds };
  const daily = useApi("/api/users/daily", claudeParams, showClaude, { unfiltered: true, linkedRange: linked, hold: stale });
  const decisions = useApi("/api/users/decisions-by-tool", claudeParams, showClaude,
    { unfiltered: true, linkedRange: linked, hold: stale });
  const codexTools = useApi("/api/codex/insights", { client: "codex", profile: "tools", userExact: user, ...bounds }, showCodex,
    { linkedRange: linked, hold: stale });
  const days = useMemo(() => heatmapDays(heat.data?.timeseries, clients), [heat.data, clients.join(","), _locale]);
  // Selected trend bucket and task. Both clear when the user, clients, group or range changes
  // (polling moves parentRange bounds, so the range identity comes from RangeContext).
  const selectionKey = JSON.stringify([user, clients, group, hours, range.days, range.month,
    range.custom?.from?.getTime?.(), range.custom?.to?.getTime?.()]);
  const [selection, setSelection] = useState(null);
  const current = selection?.key === selectionKey ? selection : null;
  const pending = stale || overview.loading || overview.stale;
  const supported = overview.data?.applied_filters?.userExact === user;
  const ready = !pending && !overview.error && supported;
  const bucket = ready ? current?.bucket ?? overview.data?.effective_range : null;
  const taskId = current?.taskId ?? null;
  const selectBucket = (next) => {
    setSelection({ key: selectionKey, bucket: next, taskId: null });
    onBucket?.(next);
  };
  const openTask = (id) => setSelection({ key: selectionKey, bucket: current?.bucket ?? null, taskId: id });
  const closeTask = () => setSelection((s) => (s?.key === selectionKey ? { ...s, taskId: null } : s));

  const heatSupported = heat.data?.applied_filters?.userExact === user;
  return <section aria-label={translate("me83875690673")} className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 ref={headingRef} tabIndex={-1}
        className="min-w-0 max-w-full flex-1 scroll-mt-6 [overflow-wrap:anywhere] text-base font-semibold text-ink-800">
        {translate("m27f4af823e34", [maskEmail(user), teamSuffix(teams, user)])}</h2>
      <button type="button" onClick={onClose} className="rounded-md border border-ink-200 px-3 py-1 text-sm text-ink-700">{translate("mb60e04f43db2")}</button>
    </div>
    {group && <p className="text-[12px] text-ink-500">{richMessage("m9eaf66b62a23", [group])}</p>}
    {overview.error ? <ErrorBox error={overview.error} /> : pending ? <Loading />
      : !supported ? <Card title={translate("m0515f4426203")}>
        <p role="alert" className="text-sm text-ink-700">{translate("mee8dc2be227b")}</p>
      </Card> : <>
        {overview.data.effective_range && <p className="text-[12px] text-ink-500">{richMessage("mec3f9d6d1182", [formatClientTimestamp(overview.data.effective_range.from), formatClientTimestamp(overview.data.effective_range.to)])}</p>}
        <Summary totals={overview.data.totals} />
        <ClientTrend rows={overview.data.timeseries || []} clients={clients} clientRows={overview.data.by_client || []}
          bucketHours={overview.data.bucket_hours || hours} effectiveRange={overview.data.effective_range}
          onBucket={selectBucket} />
      </>}
    {ready && current?.bucket && <div>
      <button type="button" onClick={() => setSelection(null)}
        className="rounded-md border border-ink-200 px-3 py-1 text-sm text-ink-700 hover:bg-ink-50">{translate("mfd07e0d84d12")}</button>
    </div>}
    {bucket?.from && bucket?.to && <TaskList user={user} clients={clients} group={group}
      from={bucket.from} to={bucket.to} onOpen={openTask} selectedId={taskId} />}
    {bucket && taskId && <TaskTraceOverlay key={taskId} taskId={taskId} user={user} from={bucket.from} to={bucket.to}
      onClose={closeTask} />}
    <Card title={translate("m3063271fad21")} subtitle={translate("m0f8bfd1a87ce")}>
      {heat.error ? <ErrorBox error={heat.error} /> : heat.loading || heat.stale || stale ? <Loading />
        : !heatSupported ? <p role="alert" className="text-sm text-ink-700">{translate("mf73b0574988d")}</p>
        : <Heatmap days={days} to={heatTo} clients={clients} />}
    </Card>
    {showCodex && <CodexDecisions api={codexTools} />}
    <ClaudeOnly daily={daily} decisions={decisions} show={showClaude} codexUnavailable={codexUnavailable} />
    {children}
  </section>;
}
