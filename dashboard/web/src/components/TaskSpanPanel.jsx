import { translate, translateSource, useLocale } from "../i18n/index.js";
// Side panel for the clicked span. It renders a fixed field list per span kind from the
// allowlisted payload keys only; any other key in the payload is never read. Values the
// client does not emit (Codex has no TTFT breakdown, call source or stop reason) show
// "미수집".
import { Badge } from "./Badge.jsx";
import { COST_BASIS, formatTaskDuration } from "./TaskList.jsx";
import { formatClientCost, formatObserved } from "../clientUsage.js";
import { observedNumber } from "../clientPresentation.js";
import { contextOf, iconFor, laneColor, laneName } from "../taskTrace.js";
import { TaskIcon } from "./taskIcons.jsx";

const MISSING = "미수집";
const MIX = [
  { key: "cache_read", label: "cache read", color: "var(--chart-1)" },
  { key: "cache_write", label: "cache write", color: "var(--chart-2)" },
  { key: "input", label: "input", color: "var(--chart-3)" },
  { key: "output", label: "output", color: "var(--chart-4)" },
];

const text = (v) => (typeof v === "string" && v !== "" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : translateSource(MISSING));
const count = (v) => (observedNumber(v) === null ? translateSource(MISSING) : formatObserved(v));
const duration = (v) => (observedNumber(v) === null ? translateSource(MISSING) : formatTaskDuration(v));
const offset = (v) => (observedNumber(v) === null ? translateSource(MISSING) : `+${formatTaskDuration(v)}`);
const outcome = (attrs) => attrs.aborted === true ? translate("mf14d9681be15") : attrs.success === true ? translate("mb4f76a33b89b")
  : attrs.success === false ? translate("m2743911f83e1") : attrs.aborted === false ? translate("m727333ab0740") : translateSource(MISSING);

function Cost({ span }) {
  const _locale = useLocale();
  if (observedNumber(span.cost_usd) === null) return translateSource(MISSING);
  return <span className="inline-flex items-center gap-1">
    {formatClientCost(span.cost_usd)}
    <Badge tone={span.cost_basis === "linked_estimate" ? "warning" : "neutral"}>
      {COST_BASIS[span.cost_basis] || translate("m46b2992298c1")}</Badge>
  </span>;
}

function Mix({ tokens }) {
  const _locale = useLocale();
  const parts = MIX.map((m) => ({ ...m, n: observedNumber(tokens?.[m.key]) })).filter((p) => p.n !== null);
  const sum = parts.reduce((a, p) => a + p.n, 0);
  if (!sum) return null;
  return <div className="my-2 flex h-3 overflow-hidden rounded" aria-hidden="true">
    {parts.map((p) => <span key={p.key} style={{ width: `${(p.n / sum) * 100}%`, background: p.color }} />)}
  </div>;
}

function llmRows(span, codex) {
  const a = span.attrs || {}, c = span.completion || {}, t = span.tokens;
  const rows = [
    [translate("mf9f4d4113aa1"), text(a.model ?? c.model)], [translate("mb1f28cd21af7"), offset(span.start_ms)], [translate("mce075704a738"), duration(span.duration_ms)],
    ["TTFT", duration(a.ttft_ms ?? c.ttft_ms)], [translate("m6e818134e504"), count(contextOf(t))],
    ["cache read", count(t?.cache_read)], ["cache write", count(t?.cache_write)], ["input", count(t?.input)],
    ["output", count(t?.output)], [translate("m24423dd67b3a"), <Cost span={span} />],
    [translate("m6beadae64472"), text(a.query_source_safe)], [translate("m0c7fe607f5d9"), text(a.stop_reason)],
    [translate("maf50f8684235"), codex ? translateSource(MISSING) : count(a.attempt)], ["effort", text(a.effort ?? c.effort)],
  ];
  if (a.speed) rows.push(["speed", text(a.speed)]);
  if (a.error_class || a.status_code) rows.push([translate("mb49f20d86148"), [a.error_class, a.status_code].filter(Boolean).join(" · ")]);
  if (observedNumber(c.count) > 1) rows.push([translate("m0b9c768d0296"), translate("mefd506fcc7af", [formatObserved(c.count)])]);
  return rows;
}

function toolRows(span) {
  const a = span.attrs || {};
  const rows = [[translate("m36c416ead2ce"), text(a.tool_name ?? span.name)]];
  if (a["anthropic.mcp.server.name"]) rows.push([translate("md1a2b7f9f77d"), text(a["anthropic.mcp.server.name"])]);
  if (a.subagent_type) rows.push([translate("m247f3895088c"), text(a.subagent_type)]);
  if (a.skill_name) rows.push([translate("m2a84c94ce347"), text(a.skill_name)]);
  if (a.bash_command_class) rows.push([translate("m4b6d64452264"), text(a.bash_command_class)]);
  rows.push([translate("m109383e344db"), outcome(a)]);
  if (a.error_class) rows.push([translate("mb49f20d86148"), text(a.error_class)]);
  // A Claude tool bar folds its tool.execution span: the bar is the whole call (including any
  // permission wait) and execution_ms the execution part.
  if (span.execution_ms !== undefined)
    rows.push([translate("mb1f28cd21af7"), offset(span.start_ms)], [translate("mce075704a738"), duration(span.duration_ms)], [translate("mb19fdfc3d2f7"), duration(span.execution_ms)]);
  else rows.push([translate("mb1f28cd21af7"), offset(span.start_ms)], [translate("mb19fdfc3d2f7"), duration(span.duration_ms)]);
  return rows;
}

const waitRows = (span) => [[translate("m372556724699"), text(span.attrs?.decision)], [translate("m4cd8ef8740db"), text(span.attrs?.source)],
  [translate("mb1f28cd21af7"), offset(span.start_ms)], [translate("mc7be98a60828"), duration(span.duration_ms)]];

export function TaskSpanPanel({ span, lane, number, codex }) {
  const _locale = useLocale();
  if (!span) return <section aria-label={translate("m4fe6a1f8abc7")} className="text-sm text-ink-500">{translate("m9246b83d7489")}</section>;
  const title = span.kind === "llm" ? translate("m187e5a1cadcd", [number]) : span.kind === "wait" ? translate("mde4e757d14bf")
    : text(span.attrs?.tool_name ?? span.name);
  const icon = span.kind === "llm" ? iconFor(lane?.kind, "agent") : span.kind === "wait" ? "wait"
    : iconFor(span.attrs?.tool_name ?? span.name);
  const color = span.kind === "llm" ? laneColor(lane) : span.kind === "wait" ? "var(--negative)" : "var(--ink-500)";
  const rows = span.kind === "llm" ? llmRows(span, codex) : span.kind === "wait" ? waitRows(span) : toolRows(span);
  return <section aria-label={translate("m4fe6a1f8abc7")}>
    <h3 className="flex items-center gap-2 text-[14px] font-semibold text-ink-800">
      <TaskIcon icon={icon} size={18} color={color} />{title}</h3>
    <div className="text-[12px] text-ink-500">{lane ? laneName(lane) : translateSource(MISSING)}</div>
    {span.kind === "llm" && <Mix tokens={span.tokens} />}
    {codex && span.kind === "llm" && !span.completion && <p className="text-[12px] text-ink-500">{translate("m0706bd3e4072")}</p>}
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
      {rows.map(([label, value]) => [<dt key={`${label}-t`} className="text-ink-500">{label}</dt>,
        <dd key={`${label}-d`} className="m-0 text-right tabular text-ink-800">{value}</dd>])}
    </dl>
  </section>;
}
