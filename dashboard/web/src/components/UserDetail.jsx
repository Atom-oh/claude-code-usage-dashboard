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
const APPROVALS = [text("tool", "도구"), text("decision", "결정"), text("source", "결정 출처"),
  { key: "count", label: "건수", render: formatObserved }];
const known = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const sumOf = (rows, key) => {
  const values = (rows || []).map((r) => known(r[key])).filter((v) => v !== null);
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
};

// GitHub-style grid over the last 90 UTC days ending at `to`. Cells are per-bucket session counts
// summed per day ("observed session activity"), not unique sessions. A day with no row is a
// recorded zero; a day whose clients are all unknown stays "미확인".
function Heatmap({ days, to, clients }) {
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
  const count = (n) => (n === null ? "미확인" : formatObserved(n ?? 0));
  const label = (c) => `${c.key} · 일별 관측 세션 ${count(c.n)}`
    + (clients.length > 1 ? ` (${clients.map((cl) => `${clientName(cl)} ${count(c.by[cl])}`).join(" · ")})` : "");
  const monthOf = (col) => col.filter(Boolean).at(-1).key.slice(0, 7);
  const months = weeks.flatMap((col, i) => {
    const month = monthOf(col);
    const previous = i ? monthOf(weeks[i - 1]) : null;
    return month === previous ? [] : [{ column: i, label: `${Number(month.slice(5))}월` }];
  });
  const columns = { gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` };
  return <div className="w-full min-w-0" role="img" aria-label="일별 관측 세션 히트맵">
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
        {["일", "월", "화", "수", "목", "금", "토"].map((day) =>
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
      <span className="flex items-center gap-1.5">
        적음 {LEVEL_BG.map((background) => <span key={background} className="h-3 w-3 rounded-sm" style={{ background }} />)} 많음
        <span className="ml-2 h-3 w-3 rounded-sm bg-ink-200" /> 미확인
      </span>
    </div>
  </div>;
}

function Summary({ totals }) {
  const row = presentationRow(totals || {});
  return <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
    <StatTile label="세션" value={formatObserved(row.sessions)} />
    <StatTile label="비용" value={formatClientCost(row.cost_usd)} variant="accent" hint={row.cost_basis_label || undefined}
      help="미산정 기록은 제외하고 알려진 비용만 부분합으로 표시합니다. 클라이언트별 비용 기준이 다를 수 있습니다." />
    <StatTile label="관측 토큰" value={formatObserved(row.observed_tokens)} hint={row.token_status} help={OBSERVED_TOKEN_HELP} />
  </div>;
}

// Claude-only measures (LOC, commits, code-edit decisions). Codex has no source for them, so a
// Codex selection shows "미수집", never 0. `group` applies here only.
function ClaudeOnly({ daily, decisions, show, codexUnavailable }) {
  const pending = show && (daily.loading || decisions.loading || daily.stale || decisions.stale);
  const error = show && (daily.error || decisions.error);
  const agg = useMemo(() => Object.values((decisions.data || []).reduce((acc, r) => {
    const k = `${r.tool}|${r.decision}`;
    (acc[k] ||= { tool: r.tool, decision: r.decision, n: 0 }).n += Number(r.n) || 0;
    return acc;
  }, {})), [decisions.data]);
  const accepted = agg.filter((r) => r.decision === "accept").reduce((n, r) => n + r.n, 0);
  const decided = agg.filter((r) => r.decision === "accept" || r.decision === "reject").reduce((n, r) => n + r.n, 0);
  const hint = codexUnavailable ? CODEX_MISSING : undefined;
  const value = (v) => (!show ? "미수집" : v);
  return <section aria-label="Claude Code에서만 수집" className="flex flex-col gap-3">
    <SectionLabel>Claude Code에서만 수집</SectionLabel>
    {error ? <ErrorBox error={error} /> : pending ? <Loading /> : <>
      <div className={GRID}>
        <StatTile label="추가 코드 라인" value={value(formatObserved(sumOf(daily.data, "loc")))} hint={hint} />
        <StatTile label="커밋" value={value(formatObserved(sumOf(daily.data, "commits")))} hint={hint} />
        <StatTile label="코드 편집 권한 허용률" value={value(decided > 0 ? `${Math.round(accepted / decided * 100)}%` : "—")}
          hint={hint} help={APPROVAL_HELP} />
      </div>
      {show && <GroupBarChart title="도구별 권한 허용/거부 (Claude Code)" rows={agg} xKey="tool" valueKey="n" height={180}
        colorFn={(r) => STATUS_COLOR[r.decision] || "var(--ink-400)"} />}
    </>}
  </section>;
}

function CodexDecisions({ api }) {
  const { data, loading, error, stale } = api;
  const rate = data?.summary?.approval_rate;
  return <section aria-label="Codex 도구 권한 결정" className="flex flex-col gap-3">
    {error ? <ErrorBox error={error} /> : loading ? <Loading /> : <>
      {data?.coverage?.logs?.status === "limited" && <p role="status" className="text-sm text-warning-text">
        Codex 로그가 조회 한도를 넘어 권한 결정을 표시하지 않습니다. 기간을 줄이면 확인할 수 있습니다.</p>}
      <DataTable title="Codex 도구 권한 결정" columns={APPROVALS} rows={data?.approvals || []}
        subtitle="자동 승인을 포함한 권한 결정입니다. 코드 수락률이 아니며 Claude Code 권한 결정과 합산하지 않습니다."
        right={<span className="text-[12px] text-ink-600 tabular">
          승인 비율 {rate == null ? "—" : `${Math.round(rate * 1000) / 10}%`}</span>}
        exportName="user_codex_approvals" stale={stale} />
    </>}
  </section>;
}

// Full-width in-page detail for one exact user across the selected clients. Clicking a trend bucket
// lists that bucket's tasks (TaskList); `onBucket({ from, to })` is also notified when provided.
export function UserDetail({ user, clients, group = null, hours, parentRange, stale, onClose, onBucket = null, children }) {
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
  const days = useMemo(() => heatmapDays(heat.data?.timeseries, clients), [heat.data, clients.join(",")]);
  // Selected trend bucket and task. Both clear when the user, clients, group or range changes
  // (polling moves parentRange bounds, so the range identity comes from RangeContext).
  const selectionKey = JSON.stringify([user, clients, group, hours, range.days, range.month,
    range.custom?.from?.getTime?.(), range.custom?.to?.getTime?.()]);
  const [selection, setSelection] = useState(null);
  const current = selection?.key === selectionKey ? selection : null;
  const bucket = current?.bucket ?? null;
  const taskId = current?.taskId ?? null;
  const selectBucket = (next) => {
    setSelection({ key: selectionKey, bucket: next, taskId: null });
    onBucket?.(next);
  };
  const openTask = (id) => setSelection((s) => (s?.key === selectionKey ? { ...s, taskId: id } : s));
  const closeTask = () => setSelection((s) => (s?.key === selectionKey ? { ...s, taskId: null } : s));

  const pending = stale || overview.loading || overview.stale;
  const supported = overview.data?.applied_filters?.userExact === user;
  const heatSupported = heat.data?.applied_filters?.userExact === user;
  return <section aria-label="사용자 상세" className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 ref={headingRef} tabIndex={-1}
        className="min-w-0 max-w-full flex-1 scroll-mt-6 [overflow-wrap:anywhere] text-base font-semibold text-ink-800">
        {`${maskEmail(user)}${teamSuffix(teams, user)} · 사용자 상세`}</h2>
      <button type="button" onClick={onClose} className="rounded-md border border-ink-200 px-3 py-1 text-sm text-ink-700">상세 닫기</button>
    </div>
    {group && <p className="text-[12px] text-ink-500">그룹({group}) 필터는 Claude 전용 영역에만 적용됩니다</p>}
    {overview.error ? <ErrorBox error={overview.error} /> : pending ? <Loading />
      : !supported ? <Card title="상세 데이터를 확인할 수 없습니다">
        <p role="alert" className="text-sm text-ink-700">선택한 사용자에 대한 집계를 확인하지 못했습니다. 잠시 후 다시 열어 주세요.</p>
      </Card> : <>
        {overview.data.effective_range && <p className="text-[12px] text-ink-500">
          집계 구간: {formatClientTimestamp(overview.data.effective_range.from)} ~ {formatClientTimestamp(overview.data.effective_range.to)}
        </p>}
        <Summary totals={overview.data.totals} />
        <ClientTrend rows={overview.data.timeseries || []} clients={clients} clientRows={overview.data.by_client || []}
          bucketHours={overview.data.bucket_hours || hours} effectiveRange={overview.data.effective_range}
          onBucket={selectBucket} />
      </>}
    {bucket && <TaskList user={user} clients={clients} group={group}
      from={bucket.from} to={bucket.to} onOpen={openTask} selectedId={taskId} />}
    {bucket && taskId && <TaskTraceOverlay key={taskId} taskId={taskId} user={user} from={bucket.from} to={bucket.to}
      onClose={closeTask} />}
    <Card title="활동 히트맵 · 최근 90일" subtitle="UTC 일 기준 · 일별 관측 세션 (버킷별 세션 수의 합이며 고유 세션 수가 아닙니다)">
      {heat.error ? <ErrorBox error={heat.error} /> : heat.loading || heat.stale || stale ? <Loading />
        : !heatSupported ? <p role="alert" className="text-sm text-ink-700">히트맵 집계를 확인하지 못했습니다.</p>
        : <Heatmap days={days} to={heatTo} clients={clients} />}
    </Card>
    {showCodex && <CodexDecisions api={codexTools} />}
    <ClaudeOnly daily={daily} decisions={decisions} show={showClaude} codexUnavailable={codexUnavailable} />
    {children}
  </section>;
}
