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
const SORTS = [{ value: "tokens", label: "토큰 많은 순" }, { value: "duration", label: "느린 순" }];
const COST_BASIS = {
  client_reported: "클라이언트 보고", computed: "계산 추정", aws_list_estimate: "AWS 정가 추정",
  mixed: "혼합 기준", linked_estimate: "연결 추정",
};
const SEGMENTS = [
  { key: "input", label: "입력", color: "var(--chart-1)" },
  { key: "cache_read", label: "캐시 읽기", color: "var(--chart-2)" },
  { key: "cache_write", label: "캐시 쓰기", color: "var(--chart-3)" },
  { key: "output", label: "출력", color: "var(--chart-4)" },
];

const orMissing = (value, format = formatObserved) => (observedNumber(value) === null ? MISSING : format(value));

export function formatTaskDuration(ms) {
  const n = observedNumber(ms);
  if (n === null) return MISSING;
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)}초`;
  const s = Math.round(n / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}분 ${s % 60}초`;
  return `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분`;
}

// Disjoint components (input is the uncached remainder for both clients), shown as shares of
// their known sum. Unknown components are omitted and flagged, never drawn as zero.
function TokenBar({ tokens }) {
  const parts = SEGMENTS.map((s) => ({ ...s, n: observedNumber(tokens?.[s.key]) }));
  const known = parts.filter((p) => p.n !== null);
  const sum = known.reduce((a, p) => a + p.n, 0);
  if (!known.length) return <span className="text-ink-500">{MISSING}</span>;
  const label = parts.map((p) => `${p.label} ${p.n === null ? MISSING : formatObserved(p.n)}`).join(" · ");
  return <span role="img" aria-label={`토큰 구성: ${label}`} title={label}
    className="inline-flex h-2 w-24 overflow-hidden rounded-full bg-ink-100 align-middle">
    {sum > 0 && known.map((p) => <span key={p.key} style={{ width: `${(p.n / sum) * 100}%`, background: p.color }} />)}
  </span>;
}

function Cost({ row }) {
  if (observedNumber(row.cost_usd) === null) return <span className="text-ink-500">{MISSING}</span>;
  const basis = COST_BASIS[row.cost_basis] || row.cost_basis || "기준 미제공";
  return <span className="inline-flex flex-wrap items-center gap-1">
    <span>{formatClientCost(row.cost_usd)}</span>
    <Badge tone={row.client === "codex" ? "warning" : "neutral"}>{basis}</Badge>
    {row.cost_partial && <Badge>부분합</Badge>}
  </span>;
}

// Top-20 tasks (Claude interactions, Codex turns) of one exact user in one trend bucket, from
// /api/users/tasks. Task ids are opaque and never displayed; rows show time and model instead.
export function TaskList({ user, clients, group = null, from, to, onOpen, selectedId = null }) {
  const [sort, setSort] = useState("tokens");
  const { backend } = useFilters();
  const expired = Date.parse(from) < Date.now() - TRACE_RETENTION_DAYS * DAY;
  const client = clients.length > 1 ? "all" : clients[0];
  // group is Claude-only (the server rejects it otherwise); team never applies here.
  const params = { from, to, userExact: user, client, sort,
    ...(group && clients.includes("claude") ? { group } : {}), ...(backend ? { backend } : {}) };
  const api = useApi("/api/users/tasks", params, !expired, { unfiltered: true });
  const rows = useMemo(() => (api.data?.tasks || []).map((t) => ({
    ...t, model: t.models?.length ? t.models.join(", ") : null, observed_tokens: t.tokens?.observed_tokens ?? null,
  })), [api.data]);

  const open = (id) => onOpen?.(id);
  const columns = [
    { key: "started_at", label: "시작", render: (v, r) => <button type="button" className="text-left underline-offset-2 hover:underline"
      onClick={(e) => { e.stopPropagation(); open(r.id); }}>{formatClientTime(v)}</button> },
    { key: "client", label: "클라이언트", render: (v) => <Badge tone={v === "codex" ? "brand" : "neutral"}>{clientName(v)}</Badge> },
    { key: "model", label: "모델", render: (v) => v || MISSING },
    { key: "llm_calls", label: "LLM 호출", render: (v) => orMissing(v) },
    { key: "subagents", label: "서브에이전트", render: (v) => orMissing(v) },
    { key: "tokens", label: "토큰 구성", render: (v) => <TokenBar tokens={v} /> },
    { key: "observed_tokens", label: "총 토큰", render: (v, r) => observedNumber(v) === null ? MISSING
      : <span>{formatObserved(v)}{r.tokens?.tokens_partial && <span className="text-ink-500"> · 부분합</span>}</span> },
    { key: "cost_usd", label: "비용", render: (_v, r) => <Cost row={r} /> },
    { key: "duration_ms", label: "소요", render: (v) => formatTaskDuration(v) },
  ];

  const title = "작업 목록 · 상위 20개";
  const subtitle = `${formatClientTimestamp(from)} ~ ${formatClientTimestamp(to)}`;
  const right = <div className="flex items-center gap-2">
    <Badge tone="warning">부분 수집</Badge>
    {!expired && <SegmentedControl options={SORTS} value={sort} onChange={setSort} />}
  </div>;
  const notice = (body) => <Card title={title} subtitle={subtitle} right={right}>{body}</Card>;
  const help = "trace를 켠 사용자·클라이언트의 작업만 표시합니다. Codex 비용·토큰은 같은 대화의 완료 로그를 시간 구간으로 연결한 추정입니다.";

  let body;
  if (expired) body = notice(<p role="status" className="text-sm text-ink-700">trace 보관 기간(90일) 경과 · 미수집</p>);
  else if (api.error) body = notice(<ErrorBox error={api.error} />);
  else if (api.loading || api.stale) body = notice(<Loading />);
  else if (!rows.length) body = notice(<p role="status" className="text-sm text-ink-700">trace 미수집</p>);
  else body = <DataTable title={title} subtitle={subtitle} help={help} right={right} columns={columns} rows={rows}
    onRowClick={(r) => open(r.id)} isRowSelected={(r) => r.id === selectedId} />;

  const data = !expired && !api.error && !api.loading && !api.stale ? api.data : null;
  const unattached = data?.unattached_codex;
  const skipped = observedNumber(unattached?.turns_without_conversation) ?? 0;
  const showUnattached = unattached && ((observedNumber(unattached.completions) ?? 0) > 0 || skipped > 0);
  return <section aria-label="작업 목록" className="flex flex-col gap-2">
    {data?.coverage?.codex === "limited" && <p role="status" className="text-sm text-warning-text">
      Codex 로그가 조회 한도를 넘어 일부 Codex 작업과 연결 정보가 누락될 수 있습니다. 비용은 부분합입니다.</p>}
    {showUnattached && <p className="text-[12px] text-ink-600">
      {`trace와 연결되지 않은 Codex completion ${formatObserved(unattached.completions ?? 0)}건 · ${orMissing(unattached.cost_usd, formatClientCost)}`}
      {unattached.cost_partial && " (부분합)"}
      {skipped > 0 && ` · conversation id가 없어 제외한 turn ${formatObserved(skipped)}건`}
    </p>}
    {body}
  </section>;
}
