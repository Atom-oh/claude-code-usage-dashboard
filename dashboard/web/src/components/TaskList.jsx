import { localize, translate, translateSource, useLocale } from "../i18n/index.js";
import { useMemo, useState } from "react";
import { Card, ErrorBox, Loading } from "./Card.jsx";
import { Badge } from "./Badge.jsx";
import { DataTable } from "./DataTable.jsx";
import { SegmentedControl } from "./SegmentedControl.jsx";
import { useApi } from "../useApi.js";
import { useFilters } from "../FilterContext.jsx";
import { formatClientCost, formatObserved } from "../clientUsage.js";
import { clientName, formatClientTime, formatClientTimestamp, observedNumber } from "../clientPresentation.js";

const DAY = 86400000;
const TRACE_RETENTION_DAYS = 90; // trace TTL
const MISSING = "미수집";
export const SORTS = localize([
  { value: "tokens", label: "토큰 많은 순" }, { value: "cost", label: "비용 높은 순" },
  { value: "subagents", label: "서브에이전트 많은 순" }, { value: "duration", label: "느린 순" },
]);
export const COST_BASIS = localize({
  client_reported: "클라이언트 보고", computed: "계산 추정", aws_list_estimate: "AWS 정가 추정",
  mixed: "혼합 기준", linked_estimate: "연결 추정",
});
const SEGMENTS = localize([
  { key: "input", label: "입력", color: "var(--chart-1)" },
  { key: "cache_read", label: "캐시 읽기", color: "var(--chart-2)" },
  { key: "cache_write", label: "캐시 쓰기", color: "var(--chart-3)" },
  { key: "output", label: "출력", color: "var(--chart-4)" },
]);

const orMissing = (value, format = formatObserved) => (observedNumber(value) === null ? translateSource(MISSING) : format(value));

export function formatTaskDuration(ms) {
  const n = observedNumber(ms);
  if (n === null) return translateSource(MISSING);
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60000) return translate("me747de4794a8", [(n / 1000).toFixed(1)]);
  const s = Math.round(n / 1000);
  if (s < 3600) return translate("mb1d874237718", [Math.floor(s / 60), s % 60]);
  return translate("mb741be1f240d", [Math.floor(s / 3600), Math.floor((s % 3600) / 60)]);
}

// Disjoint components (input is the uncached remainder for both clients), shown as shares of
// their known sum. Unknown components are omitted and flagged, never drawn as zero.
function TokenBar({ tokens }) {
  const _locale = useLocale();
  const parts = SEGMENTS.map((s) => ({ ...s, n: observedNumber(tokens?.[s.key]) }));
  const known = parts.filter((p) => p.n !== null);
  const sum = known.reduce((a, p) => a + p.n, 0);
  if (!known.length) return <span className="text-ink-500">{translateSource(MISSING)}</span>;
  const label = parts.map((p) => `${p.label} ${p.n === null ? translateSource(MISSING) : formatObserved(p.n)}`).join(" · ");
  return <span role="img" aria-label={translate("m575f8181a9a2", [label])} title={label}
    className="inline-flex h-2 w-24 overflow-hidden rounded-full bg-ink-100 align-middle">
    {sum > 0 && known.map((p) => <span key={p.key} style={{ width: `${(p.n / sum) * 100}%`, background: p.color }} />)}
  </span>;
}

// A workflow run as the API lists it ({run_id, name}); a run without a valid name shows its id.
export const workflowLabel = (run) => run?.name || run?.run_id || translateSource(MISSING);

// Badges for a task's workflow runs; each narrows the list to that run. Clicking a badge does
// not open the task (the row's own click handler).
function Workflows({ runs, onPick }) {
  const _locale = useLocale();
  if (!Array.isArray(runs) || runs.length === 0) return <span className="text-ink-400">—</span>;
  return <span className="inline-flex flex-wrap gap-1">
    {runs.map((run) => <button key={run.run_id} type="button" aria-label={translate("mb14290aa499f", [workflowLabel(run)])}
      title={run.run_id} onClick={(e) => { e.stopPropagation(); onPick(run); }}
      className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700 hover:bg-brand-100 [overflow-wrap:anywhere]">
      {workflowLabel(run)}</button>)}
  </span>;
}

function Cost({ row }) {
  const _locale = useLocale();
  if (observedNumber(row.cost_usd) === null) return <span className="text-ink-500">{translateSource(MISSING)}</span>;
  const basis = COST_BASIS[row.cost_basis] || row.cost_basis || translate("m46b2992298c1");
  return <span className="inline-flex flex-wrap items-center gap-1">
    <span>{formatClientCost(row.cost_usd)}</span>
    <Badge tone={row.client === "codex" ? "warning" : "neutral"}>{basis}</Badge>
    {row.cost_partial && <Badge>{translate("md15c830a6f1c")}</Badge>}
  </span>;
}

// Top-20 tasks (Claude interactions, Codex turns) of one exact user in the selected range, from
// /api/users/tasks. Task ids are opaque and never displayed; rows show time and model instead.
export function TaskList({ user, clients, group = null, from, to, onOpen, selectedId = null }) {
  const _locale = useLocale();
  const [sort, setSort] = useState("tokens");
  const { backend } = useFilters();
  // Workflow run chosen from a task's badge; it narrows the list to that run's interactions.
  // It belongs to the scope it was picked in: a new user, bucket, client selection, group or
  // backend drops it on the same render, so no request mixes the old run with the new scope.
  const scope = JSON.stringify([user, from, to, clients, group, backend]);
  const [picked, setPicked] = useState(null);
  const workflow = picked?.scope === scope ? picked.run : null;
  const setWorkflow = (run) => setPicked(run ? { scope, run } : null);
  const expired = Date.parse(from) < Date.now() - TRACE_RETENTION_DAYS * DAY;
  // Workflow runs are Claude Code spans: the server filters them only for client=claude.
  const client = workflow ? "claude" : clients.length > 1 ? "all" : clients[0];
  // group is Claude-only (the server rejects it otherwise); team never applies here.
  const params = { from, to, userExact: user, client, sort,
    ...(group && clients.includes("claude") ? { group } : {}), ...(backend ? { backend } : {}),
    ...(workflow ? { workflowRunId: workflow.run_id } : {}) };
  const api = useApi("/api/users/tasks", params, !expired, { unfiltered: true });
  const rows = useMemo(() => (api.data?.tasks || []).map((t) => ({
    ...t, model: t.models?.length ? t.models.join(", ") : null, observed_tokens: t.tokens?.observed_tokens ?? null,
  })), [api.data, _locale]);

  const open = (id) => onOpen?.(id);
  const columns = [
    { key: "started_at", label: translate("mb1f28cd21af7"), render: (v, r) => <button type="button" className="text-left underline-offset-2 hover:underline"
      onClick={(e) => { e.stopPropagation(); open(r.id); }}>{formatClientTime(v)}</button> },
    { key: "client", label: translate("mb367c7d58dda"), render: (v) => <Badge tone={v === "codex" ? "brand" : "neutral"}>{clientName(v)}</Badge> },
    { key: "model", label: translate("mf9f4d4113aa1"), render: (v) => v || translateSource(MISSING) },
    { key: "workflows", label: translate("m7e991f82224a"), render: (v) => <Workflows runs={v} onPick={setWorkflow} /> },
    { key: "llm_calls", label: translate("m5570150cd696"), render: (v) => orMissing(v) },
    { key: "subagents", label: translate("m7d688dae8673"), render: (v) => orMissing(v) },
    { key: "tokens", label: translate("m1e3af36b77f5"), render: (v) => <TokenBar tokens={v} /> },
    { key: "observed_tokens", label: translate("m217dbc642634"), render: (v, r) => observedNumber(v) === null ? translateSource(MISSING)
      : <span>{formatObserved(v)}{r.tokens?.tokens_partial && <span className="text-ink-500">{translate("m7cf5cd1a2243")}</span>}</span> },
    { key: "cost_usd", label: translate("m24423dd67b3a"), render: (_v, r) => <Cost row={r} /> },
    { key: "duration_ms", label: translate("mce075704a738"), render: (v) => formatTaskDuration(v) },
  ];

  const title = translate("me9d1d2c612dd");
  const subtitle = `${formatClientTimestamp(from)} ~ ${formatClientTimestamp(to)}`;
  const right = <div className="flex flex-wrap items-center justify-end gap-2">
    <Badge tone="warning">{translate("m2920ea9836d6")}</Badge>
    {!expired && <SegmentedControl options={SORTS} value={sort} onChange={setSort} />}
  </div>;
  const notice = (body) => <Card title={title} subtitle={subtitle} right={right}>{body}</Card>;
  const help = translate("mf5e2785adcb2");

  let body;
  if (expired) body = notice(<p role="status" className="text-sm text-ink-700">{translate("m3908d92493c6")}</p>);
  else if (api.error) body = notice(<ErrorBox error={api.error} />);
  else if (api.loading || api.stale) body = notice(<Loading />);
  else if (!rows.length) body = notice(<p role="status" className="text-sm text-ink-700">{translate("m435d6f7eb375")}</p>);
  else body = <DataTable title={title} subtitle={subtitle} help={help} right={right} columns={columns} rows={rows}
    onRowClick={(r) => open(r.id)} isRowSelected={(r) => r.id === selectedId} />;

  const data = !expired && !api.error && !api.loading && !api.stale ? api.data : null;
  const unattached = data?.unattached_codex;
  const skipped = observedNumber(unattached?.turns_without_conversation) ?? 0;
  const nonUnique = observedNumber(unattached?.turns_without_unique_id) ?? 0;
  // Claude cost is priced after the query, so sort=cost ranks the server's token-ordered pool.
  const costPool = sort === "cost" && data?.sort_candidates?.limited === true;
  const showUnattached = unattached && ((observedNumber(unattached.completions) ?? 0) > 0 || skipped > 0 || nonUnique > 0);
  return <section aria-label={translate("maccf825e71d8")} className="flex flex-col gap-2">
    {workflow && <p role="status" aria-label={translate("ma65bdeeec6c8")}
      className="flex flex-wrap items-center gap-2 text-[12px] text-ink-700">
      <Badge tone="brand">{translate("m01175a17535c", [workflowLabel(workflow)])}</Badge>
      <span>{translate("m818038e067f6")}</span>
      <button type="button" aria-label={translate("me9d016c9f20e")} onClick={() => setWorkflow(null)}
        className="rounded border border-ink-200 px-2 py-0.5 text-[12px] text-ink-700 hover:bg-ink-50">{translate("m293182ec397e")}</button>
    </p>}
    {data?.coverage?.codex === "limited" && <p role="status" className="text-sm text-warning-text">{translate("mdbc43708d09e")}</p>}
    {costPool && <p role="note" className="text-[12px] text-ink-600">
      {translate("m512526d16c07", [formatObserved(data.sort_candidates.claude_limit ?? 100)])}</p>}
    {showUnattached && <p className="text-[12px] text-ink-600">
      {translate("mdf5e4b19672c", [formatObserved(unattached.completions ?? 0), orMissing(unattached.cost_usd, formatClientCost)])}
      {unattached.cost_partial && translate("m830e860c2bd2")}
      {skipped > 0 && translate("mca1933aa7dd8", [formatObserved(skipped)])}
      {nonUnique > 0 && translate("m412101d2d06c", [formatObserved(nonUnique)])}
    </p>}
    {body}
  </section>;
}
