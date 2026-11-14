import { richMessage, translate, translateSource, useLocale } from "../i18n/index.js";
// Full-screen detail of one task (/api/users/tasks/detail): KPI row, agent lane timeline
// (TaskTimeline), cumulative cost band by lane (TaskCostBand), context size by lane
// (TaskContextChart), clicked-span side panel
// (TaskSpanPanel), the "왜 많이 썼나" rules and the per-model call table (모델별 호출), whose
// rows highlight that model's LLM bars. Task ids and raw identities are never shown.
import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorBox, Loading } from "./Card.jsx";
import { Badge } from "./Badge.jsx";
import { StatTile } from "./StatTile.jsx";
import { COST_BASIS, formatTaskDuration, workflowLabel } from "./TaskList.jsx";
import { TaskTimeline } from "./TaskTimeline.jsx";
import { TaskCostBand } from "./TaskCostBand.jsx";
import { TaskContextChart } from "./TaskContextChart.jsx";
import { TaskSpanPanel } from "./TaskSpanPanel.jsx";
import { LanguagePicker } from "./LanguagePicker.jsx";
import { useApi } from "../useApi.js";
import { maskEmail } from "../fmt.js";
import { formatClientCost, formatObserved } from "../clientUsage.js";
import { clientName, formatClientTimestamp, observedNumber } from "../clientPresentation.js";
import { compactCount, laneName, laneOrder, modelBreakdown, modelKey, modelUsage, timelineEnd, withLaneIdentity } from "../taskTrace.js";
import { taskSharePath } from "../clientNavigation.js";

// Copies the task's share link (/tasks/<id>/<from>/<to>; no user in the URL). Without
// clipboard access the link is shown in a read-only field to copy by hand.
function ShareLink({ taskId, from, to }) {
  const _locale = useLocale();
  const [state, setState] = useState(null);
  const url = typeof window === "undefined" ? taskSharePath(taskId, from, to)
    : new URL(taskSharePath(taskId, from, to), window.location.origin).toString();
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(url);
      setState("copied");
    } catch {
      setState("manual");
    }
  };
  return <div className="flex flex-col items-end gap-1">
    <button type="button" onClick={copy} className="rounded-md border border-ink-200 px-3 py-1 text-sm text-ink-700 hover:bg-ink-50">{translate("md6ceeabf7e0a")}</button>
    {state === "copied" && <span role="status" className="text-[12px] text-positive-text">{translate("m7040dc9bdcad")}</span>}
    {state === "manual" && <label className="flex flex-col items-end gap-1 text-[12px] text-ink-500">{richMessage("m476a28b134eb", [<input readOnly value={url} onFocus={(e) => e.target.select()} aria-label={translate("mc20095cd17e4")}
        className="w-72 rounded border border-ink-200 px-2 py-1 text-[12px] text-ink-700" />])}</label>}
  </div>;
}

const MISSING = "미수집";
const TRUNCATED = "일부 span만 표시 — 전체 합계 미표시";
const pct = (v) => `${Math.round(v * 100)}%`;

function Kpis({ task }) {
  const _locale = useLocale();
  const t = task.tokens || {};
  const tokens = compactCount(t.observed_tokens);
  const cost = observedNumber(task.cost_usd);
  const basis = COST_BASIS[task.cost_basis] || undefined;
  const orMissing = (v) => (observedNumber(v) === null ? translateSource(MISSING) : formatObserved(v));
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
    <StatTile label={translate("m217dbc642634")} value={tokens ?? translateSource(MISSING)} hint={t.tokens_partial ? translate("md15c830a6f1c") : undefined} />
    <StatTile label={translate("m24423dd67b3a")} variant="accent" value={cost === null ? translateSource(MISSING) : formatClientCost(cost)}
      hint={[basis, task.cost_partial ? translate("md15c830a6f1c") : null].filter(Boolean).join(" · ") || undefined} />
    <StatTile label={translate("m5570150cd696")} value={orMissing(task.llm_calls)} />
    <StatTile label={translate("m7d688dae8673")} value={orMissing(task.subagents)}
      hint={task.client === "codex" ? translate("m54b53da3d83f") : undefined} />
    <StatTile label={translate("mce075704a738")} value={formatTaskDuration(task.duration_ms)} />
  </div>;
}

// One line per rule; a rule's inputs are never zero-filled by the server, so absent rules are
// simply not listed.
function Why({ why, lanes, numbers, onSelect, usage = [], unlinked = 0 }) {
  const _locale = useLocale();
  const lane = (id) => { const l = lanes.find((x) => x.id === id); return l ? laneName(l) : translate("m7d688dae8673"); };
  const items = why.map(({ rule, value }) => {
    if (rule === "cache_read_share") return { rule, text: translate("mda591ceaccce", [pct(value)]) };
    if (rule === "context_growth") return { rule, text: translate("maaa06a2bc10d", [compactCount(value.first) ?? translateSource(MISSING), compactCount(value.last) ?? translateSource(MISSING), formatObserved(value.calls)]) };
    if (rule === "top_lane_share") return { rule, text: translate("mddf3041d48ec", [lane(value.lane), pct(value.share)]) };
    if (rule === "most_expensive_call") {
      const n = value.span ? numbers.get(value.span) : null;
      return { rule, span: n ? value.span : null,
        text: translate("mbbe5b4baf9a0", [n ? ` #${n}` : "", formatClientCost(value.cost_usd), value.span ? "" : translate("m657642478546")]) };
    }
    if (rule === "retries") return { rule, text: translate("m507c14a43cc0", [formatObserved(value)]) };
    if (rule === "permission_wait") return { rule, text: translate("m350582685bbb", [formatTaskDuration(value)]) };
    return null;
  }).filter(Boolean);
  return <section aria-label={translate("mf10d9745bc89")} className="rounded-lg border border-ink-100 p-4">
    <h3 className="mb-2 text-[14px] font-semibold text-ink-800">{translate("mf10d9745bc89")}</h3>
    {items.length ? <ul className="flex flex-col gap-1 text-[13px] text-ink-700">
      {items.map((it) => <li key={it.rule}>{it.span
        ? <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => onSelect(it.span)}>{it.text}</button>
        : it.text}</li>)}
    </ul> : <p className="text-[13px] text-ink-500">{richMessage("m0c214cb78431", [translateSource(MISSING)])}</p>}
    {usage.length > 0 && <div className="mt-3 border-t border-ink-100 pt-3">
      <h4 className="mb-1 text-[12px] font-semibold text-ink-600">{translate("mf3dbbd426672")}</h4>
      <ul aria-label={translate("mf3dbbd426672")} className="flex flex-col gap-1 text-[13px] text-ink-700">
        {usage.map((u) => <li key={String(u.model)} className="[overflow-wrap:anywhere]">
          {translate("mca019778adb0", [u.model ?? translate("m05d46de99267"), formatObserved(u.calls), u.cost_usd === null ? translate("mbc95745eb452", [translateSource(MISSING)])
            : `${formatClientCost(u.cost_usd)}${u.cost_partial ? translate("m830e860c2bd2") : ""}${u.share === null ? "" : ` · ${pct(u.share)}`}`])}
        </li>)}
      </ul>
      {/* Shares are over the summed span costs: disclose what that base leaves out. */}
      {unlinked > 0 && <p className="mt-1 text-[12px] text-ink-500">
        {translate("m3288821add0c", [formatObserved(unlinked)])}</p>}
      {usage.some((u) => u.cost_usd === null || u.cost_partial) && <p className="mt-1 text-[12px] text-ink-500">{translate("m9227a4fc9c70")}</p>}
    </div>}
  </section>;
}

// What the task's session carried: MCP servers by latest status and loaded plugins with their
// skill/agent/command counts (Claude Code session events, looked up before the task starts),
// plus the first call's input context as the session's setup cost. OTel sends neither the
// tool-definition count nor its token size, so the card says so instead of estimating them.
function SessionEnvironment({ environment, client, context }) {
  const _locale = useLocale();
  const points = (context?.points || []).filter((p) => observedNumber(p.tokens) !== null && observedNumber(p.start_ms) !== null);
  const main = points.filter((p) => p.lane === "main").sort((a, b) => a.start_ms - b.start_ms)[0];
  const first = main ?? [...points].sort((a, b) => a.start_ms - b.start_ms)[0];
  const mcp = environment?.mcp, plugins = environment?.plugins;
  const days = environment?.lookback_days ?? 14;
  let body;
  if (client === "codex") body = <p className="text-[13px] text-ink-500">{translate("m572566f25003")}</p>;
  else if (!environment) body = <p className="text-[13px] text-ink-500">{translate("m6bba464ef7f9", [days])}</p>;
  else body = <div className="flex flex-col gap-2 text-[13px] text-ink-700">
    {mcp ? <div>
      <div>{translate("mbd63e14fa3e0", [formatObserved(mcp.connected), formatObserved(mcp.failed), mcp.other > 0 ? translate("m032ec623cb2d", [formatObserved(mcp.other)]) : ""])}</div>
      {mcp.servers?.length > 0 && <ul aria-label={translate("md1a2b7f9f77d")} className="mt-1 flex min-w-0 flex-wrap gap-1">
        {mcp.servers.filter((server) => server.name !== null).map((server) => <li key={server.name} className="min-w-0 max-w-full">
          <Badge tone={server.status === "failed" ? "warning" : "neutral"} className="max-w-full text-[11px] whitespace-normal! [overflow-wrap:anywhere]">
            {`${server.name}${server.status === "connected" ? "" : server.status === "failed" ? translate("md4fa7d675113")
              : ` ${server.status ?? translateSource(MISSING)}`}`}</Badge></li>)}
        {/* Names that are not label-shaped are withheld by the server; count them once. */}
        {mcp.servers.some((server) => server.name === null) && <li>
          <Badge tone="neutral" className="text-[11px]">{translate("m6b1b874098ea", [formatObserved(mcp.servers.filter((server) => server.name === null).length)])}</Badge></li>}
      </ul>}
    </div> : <div className="text-ink-500">{translate("mc5a7024f18f0")}</div>}
    {plugins ? <div>{translate("mb9010aa60c85", [formatObserved(plugins.count), formatObserved(plugins.skills), formatObserved(plugins.agents), formatObserved(plugins.commands), formatObserved(plugins.with_mcp)])}
      {plugins.counts_partial && <span className="text-ink-500">{translate("m97d12e84cdf0")}</span>}</div>
      : <div className="text-ink-500">{translate("mf9e66b24e7ce")}</div>}
  </div>;
  return <section aria-label={translate("mb758c310997e")} className="rounded-lg border border-ink-100 p-4">
    <h3 className="mb-2 text-[14px] font-semibold text-ink-800">{translate("mb758c310997e")}</h3>
    {body}
    {first && <p className="mt-2 text-[13px] text-ink-700">
      {translate("m39cb736a9f46", [compactCount(first.tokens) ?? translateSource(MISSING), main ? translate("m532fa5422839") : translate("m055ab477f192")])}</p>}
    <p className="mt-2 text-[12px] text-ink-500">{translate("m808720f3a998")}</p>
  </section>;
}

// LLM calls by (model, call source). A row's button toggles the timeline highlight; a
// truncated detail counts only the returned spans and shows no cost sums.
function ModelCalls({ rows, lanes, truncated, activeKey, onToggle }) {
  const _locale = useLocale();
  const laneText = (ids) => {
    const counts = new Map();
    for (const id of ids) {
      const l = lanes.find((x) => x.id === id);
      const name = l ? laneName(l) : translate("m7d688dae8673");
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(", ");
  };
  const cost = (r) => {
    if (truncated) return translate("m8eb8ad978705");
    if (r.cost_usd === null) return translateSource(MISSING);
    return `${formatClientCost(r.cost_usd)}${r.cost_partial ? translate("m830e860c2bd2") : ""}`;
  };
  const th = "px-2 py-1 font-medium";
  return <section aria-label={translate("mc82b2aa2e9a7")} className="rounded-lg border border-ink-100 p-4">
    <h3 className="mb-1 text-[14px] font-semibold text-ink-800">{translate("mc82b2aa2e9a7")}</h3>
    <p className="mb-2 text-[12px] text-ink-500">{richMessage("m4ff4102d4684", [truncated && translate("m0667e1dd2054")])}</p>
    <div className="overflow-x-auto">
      <table className="w-full text-[13px] text-ink-700">
        <thead><tr className="text-left text-[12px] text-ink-500">
          <th className={th}>{translate("mf9f4d4113aa1")}</th><th className={th}>{translate("m6beadae64472")}</th><th className={th}>{translate("m978c24b58ed3")}</th>
          <th className={`${th} text-right`}>{translate("m7ed9c4cb0ba9")}</th><th className={`${th} text-right`}>{translate("m24423dd67b3a")}</th>
        </tr></thead>
        <tbody>{rows.map((r) => {
          const active = r.key === activeKey;
          return <tr key={r.key} data-active={active ? "" : undefined} onClick={() => onToggle(r.key)}
            className={`cursor-pointer border-t border-ink-100 ${active ? "bg-brand-50" : "hover:bg-ink-50"}`}>
            <td className="px-2 py-1"><button type="button" aria-pressed={active}
              className="text-left underline-offset-2 hover:underline [overflow-wrap:anywhere]"
              onClick={(e) => { e.stopPropagation(); onToggle(r.key); }}>{r.model ?? translateSource(MISSING)}</button></td>
            <td className="px-2 py-1">{r.source ?? translateSource(MISSING)}</td>
            <td className="px-2 py-1">{laneText(r.lanes)}</td>
            <td className="px-2 py-1 text-right tabular-nums">{formatObserved(r.calls)}</td>
            <td className="px-2 py-1 text-right tabular-nums">{cost(r)}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  </section>;
}

function Body({ data, selectedId, onSelect, highlightKey, onHighlight }) {
  const _locale = useLocale();
  const { task, truncated } = data;
  const spans = useMemo(() => data.spans || [], [data.spans, _locale]);
  // Display order, then same-name lanes numbered and shaded so each lane reads as its own.
  const lanes = useMemo(() => withLaneIdentity(laneOrder(data.lanes || [], spans)), [data.lanes, spans, _locale]);
  const numbers = useMemo(() => {
    const m = new Map();
    spans.filter((s) => s.kind === "llm").forEach((s, i) => m.set(s.id, i + 1));
    return m;
  }, [spans, _locale]);
  const end = useMemo(() => timelineEnd(spans, task.duration_ms), [spans, task.duration_ms, _locale]);
  const selected = spans.find((s) => s.id === selectedId) || null;
  const priced = spans.some((s) => s.kind === "llm" && Object.prototype.hasOwnProperty.call(s, "cost_usd"));
  const unplaced = spans.filter((s) => observedNumber(s.start_ms) === null).length;
  const unlinked = observedNumber(task.completions_without_span) ?? 0;
  const models = useMemo(() => modelBreakdown(spans), [spans, _locale]);
  const usage = useMemo(() => modelUsage(spans), [spans, _locale]);
  // Call source per span id: the context chart joins only a lane's main source.
  const sourceOf = useMemo(() => {
    const m = new Map(spans.map((x) => [x.id, x.attrs?.query_source_safe ?? null]));
    return (id) => m.get(id) ?? null;
  }, [spans, _locale]);
  const activeKey = models.some((m) => m.key === highlightKey) ? highlightKey : null;
  const highlight = useMemo(() => (activeKey === null ? null : (s) => modelKey(s) === activeKey), [activeKey, _locale]);
  return <>
    {truncated ? <p role="status" className="rounded-md bg-warning-surface px-3 py-2 text-sm text-warning-text">
      <span>{translateSource(TRUNCATED)}</span>{` (span ${formatObserved(spans.length)} / ${formatObserved(data.span_total)})`}</p>
      : <Kpis task={task} />}
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_330px]">
      <div className="min-w-0 rounded-lg border border-ink-100 p-4">
        {lanes.length ? <TaskTimeline lanes={lanes} spans={spans} numbers={numbers} end={end} truncated={truncated}
          selectedId={selectedId} onSelect={onSelect} highlight={highlight} /> : <p className="text-sm text-ink-500">{translate("m435d6f7eb375")}</p>}
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-500">
          <span>{translate("mf91c0b9a8833")}</span><span>{translate("m55b0c0d28741")}</span><span>{translate("m570967649b01")}</span>
          <span>{translate("m3ee958d3d0cd")}</span>
          {unplaced > 0 && <span>{translate("maa375b40dc61", [formatObserved(unplaced)])}</span>}
        </div>
        {!truncated && (priced ? <div className="mt-4">
          <TaskCostBand lanes={lanes} spans={spans} end={end} durationMs={task.duration_ms} />
          <p className="mt-1 text-[12px] text-ink-500">{richMessage("m8994eb3d9eef", [unlinked > 0 && translate("me28cab7df2c6", [formatObserved(unlinked)])])}</p>
        </div> : <p className="mt-4 text-sm text-ink-500">{richMessage("m3e04403f0ff9", [translateSource(MISSING)])}</p>)}
        {data.context && <div className="mt-4 border-t border-ink-100 pt-3">
          <TaskContextChart context={data.context} lanes={lanes} end={end} numbers={numbers} client={task.client}
            sourceOf={sourceOf}
            selectedId={selectedId} onSelect={onSelect} />
        </div>}
      </div>
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-ink-100 p-4">
          <TaskSpanPanel span={selected} lane={selected ? lanes.find((l) => l.id === selected.lane) : null}
            number={selected ? numbers.get(selected.id) : null} codex={task.client === "codex"} />
        </div>
        {!truncated && <Why why={data.why || []} lanes={lanes} numbers={numbers} onSelect={onSelect} usage={usage}
          unlinked={unlinked} />}
        <SessionEnvironment environment={data.environment ?? null} client={task.client} context={data.context} />
      </div>
    </div>
    {models.length > 0 && <ModelCalls rows={models} lanes={lanes} truncated={truncated} activeKey={activeKey}
      onToggle={(key) => onHighlight((k) => (k === key ? null : key))} />}
  </>;
}

// `user` is the exact user the task list belongs to. A shared link has none: the server
// resolves the owner and returns it, and the header masks that instead.
export function TaskTraceOverlay({ taskId, user, from, to, onClose }) {
  const _locale = useLocale();
  const api = useApi("/api/users/tasks/detail", { id: taskId, from, to, userExact: user || undefined }, Boolean(taskId),
    { unfiltered: true });
  const [selectedId, setSelectedId] = useState(null);
  const [highlightKey, setHighlightKey] = useState(null);
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => { setSelectedId(null); setHighlightKey(null); }, [taskId]);
  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
    const onKey = (e) => { if (e.key === "Escape") closeRef.current?.(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const task = api.data?.task;
  const pending = api.loading || api.stale;
  return <div className="fixed inset-0 z-50 overflow-y-auto bg-ink-900/40 p-2 sm:p-6">
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={translate("m0c844f6030e9")} tabIndex={-1}
      className="mx-auto flex max-w-[1320px] flex-col gap-4 rounded-lg bg-card p-4 shadow-pop outline-none sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold text-ink-800">{richMessage("m5e3456c62a13", [<Badge tone="warning">{translate("m2920ea9836d6")}</Badge>, task && <Badge tone={task.client === "codex" ? "brand" : "neutral"}>{clientName(task.client)}</Badge>])}</h2>
          <p className="text-[12px] text-ink-500 [overflow-wrap:anywhere]">{richMessage("m4abad4a9f969", [[task ? formatClientTimestamp(task.started_at) : null, user || api.data?.owner ? maskEmail(user || api.data.owner) : null,
              task?.models?.length ? task.models.join(", ") : null].filter(Boolean).join(" · ")])}</p>
          {task?.workflows?.length > 0 && <p className="text-[12px] text-ink-600 [overflow-wrap:anywhere]">
            {translate("m01175a17535c", [task.workflows.map(workflowLabel).join(", ")])}</p>}
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <LanguagePicker compact />
          <ShareLink taskId={taskId} from={from} to={to} />
          <button type="button" onClick={() => onClose?.()} className="rounded-md border border-ink-200 px-3 py-1 text-sm text-ink-700">{translate("m1e8c10206f5b")}</button>
        </div>
      </div>
      {api.error ? <ErrorBox error={api.error} /> : pending || !api.data ? <Loading />
        : <Body data={api.data} selectedId={selectedId} onSelect={setSelectedId}
          highlightKey={highlightKey} onHighlight={setHighlightKey} />}
    </div>
  </div>;
}
