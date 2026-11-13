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

const text = (v) => (typeof v === "string" && v !== "" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : MISSING);
const count = (v) => (observedNumber(v) === null ? MISSING : formatObserved(v));
const duration = (v) => (observedNumber(v) === null ? MISSING : formatTaskDuration(v));
const offset = (v) => (observedNumber(v) === null ? MISSING : `+${formatTaskDuration(v)}`);
const outcome = (attrs) => attrs.aborted === true ? "중단" : attrs.success === true ? "성공"
  : attrs.success === false ? "실패" : attrs.aborted === false ? "완료" : MISSING;

function Cost({ span }) {
  if (observedNumber(span.cost_usd) === null) return MISSING;
  return <span className="inline-flex items-center gap-1">
    {formatClientCost(span.cost_usd)}
    <Badge tone={span.cost_basis === "linked_estimate" ? "warning" : "neutral"}>
      {COST_BASIS[span.cost_basis] || "기준 미제공"}</Badge>
  </span>;
}

function Mix({ tokens }) {
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
    ["모델", text(a.model ?? c.model)], ["시작", offset(span.start_ms)], ["소요", duration(span.duration_ms)],
    ["TTFT", duration(a.ttft_ms ?? c.ttft_ms)], ["컨텍스트(입력 합계)", count(contextOf(t))],
    ["cache read", count(t?.cache_read)], ["cache write", count(t?.cache_write)], ["input", count(t?.input)],
    ["output", count(t?.output)], ["비용", <Cost span={span} />],
    ["호출 출처", text(a.query_source_safe)], ["종료 사유", text(a.stop_reason)],
    ["시도", codex ? MISSING : count(a.attempt)], ["effort", text(a.effort ?? c.effort)],
  ];
  if (a.speed) rows.push(["speed", text(a.speed)]);
  if (a.error_class || a.status_code) rows.push(["오류", [a.error_class, a.status_code].filter(Boolean).join(" · ")]);
  if (observedNumber(c.count) > 1) rows.push(["연결된 completion", `${formatObserved(c.count)}건`]);
  return rows;
}

function toolRows(span) {
  const a = span.attrs || {};
  const rows = [["도구", text(a.tool_name ?? span.name)]];
  if (a["anthropic.mcp.server.name"]) rows.push(["MCP 서버", text(a["anthropic.mcp.server.name"])]);
  if (a.subagent_type) rows.push(["서브에이전트 종류", text(a.subagent_type)]);
  if (a.skill_name) rows.push(["스킬", text(a.skill_name)]);
  if (a.bash_command_class) rows.push(["분류", text(a.bash_command_class)]);
  rows.push(["결과", outcome(a)]);
  if (a.error_class) rows.push(["오류", text(a.error_class)]);
  // A Claude tool bar folds its tool.execution span: the bar is the whole call (including any
  // permission wait) and execution_ms the execution part.
  if (span.execution_ms !== undefined)
    rows.push(["시작", offset(span.start_ms)], ["소요", duration(span.duration_ms)], ["실행 시간", duration(span.execution_ms)]);
  else rows.push(["시작", offset(span.start_ms)], ["실행 시간", duration(span.duration_ms)]);
  return rows;
}

const waitRows = (span) => [["결정", text(span.attrs?.decision)], ["결정 출처", text(span.attrs?.source)],
  ["시작", offset(span.start_ms)], ["대기 시간", duration(span.duration_ms)]];

export function TaskSpanPanel({ span, lane, number, codex }) {
  if (!span) return <section aria-label="선택한 span 상세" className="text-sm text-ink-500">
    타임라인의 막대를 누르면 호출·도구 상세가 표시됩니다.</section>;
  const title = span.kind === "llm" ? `LLM 호출 #${number}` : span.kind === "wait" ? "권한 대기"
    : text(span.attrs?.tool_name ?? span.name);
  const icon = span.kind === "llm" ? iconFor(lane?.kind, "agent") : span.kind === "wait" ? "wait"
    : iconFor(span.attrs?.tool_name ?? span.name);
  const color = span.kind === "llm" ? laneColor(lane) : span.kind === "wait" ? "var(--negative)" : "var(--ink-500)";
  const rows = span.kind === "llm" ? llmRows(span, codex) : span.kind === "wait" ? waitRows(span) : toolRows(span);
  return <section aria-label="선택한 span 상세">
    <h3 className="flex items-center gap-2 text-[14px] font-semibold text-ink-800">
      <TaskIcon icon={icon} size={18} color={color} />{title}</h3>
    <div className="text-[12px] text-ink-500">{lane ? laneName(lane) : MISSING}</div>
    {span.kind === "llm" && <Mix tokens={span.tokens} />}
    {codex && span.kind === "llm" && !span.completion && <p className="text-[12px] text-ink-500">
      연결된 completion 없음 · 토큰·비용 미수집</p>}
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
      {rows.map(([label, value]) => [<dt key={`${label}-t`} className="text-ink-500">{label}</dt>,
        <dd key={`${label}-d`} className="m-0 text-right tabular text-ink-800">{value}</dd>])}
    </dl>
  </section>;
}
