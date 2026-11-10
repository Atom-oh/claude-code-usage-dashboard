// Full-screen detail of one task (/api/users/tasks/detail): KPI row, agent lane timeline
// (TaskTimeline), cumulative cost band by lane (TaskCostBand), clicked-span side panel
// (TaskSpanPanel), the "왜 많이 썼나" rules and the per-model call table (모델별 호출), whose
// rows highlight that model's LLM bars. Task ids and raw identities are never shown.
import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorBox, Loading } from "./Card.jsx";
import { Badge } from "./Badge.jsx";
import { StatTile } from "./StatTile.jsx";
import { COST_BASIS, formatTaskDuration } from "./TaskList.jsx";
import { TaskTimeline } from "./TaskTimeline.jsx";
import { TaskCostBand } from "./TaskCostBand.jsx";
import { TaskSpanPanel } from "./TaskSpanPanel.jsx";
import { useApi } from "../useApi.js";
import { maskEmail } from "../fmt.js";
import { formatClientCost, formatObserved } from "../clientUsage.js";
import { clientName, formatClientTimestamp, observedNumber } from "../clientPresentation.js";
import { compactCount, laneName, laneOrder, modelBreakdown, modelKey, timelineEnd } from "../taskTrace.js";
import { taskSharePath } from "../clientNavigation.js";

// Copies the task's share link (/tasks/<id>/<from>/<to>; no user in the URL). Without
// clipboard access the link is shown in a read-only field to copy by hand.
function ShareLink({ taskId, from, to }) {
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
    <button type="button" onClick={copy} className="rounded-md border border-ink-200 px-3 py-1 text-sm text-ink-700 hover:bg-ink-50">
      링크 복사</button>
    {state === "copied" && <span role="status" className="text-[12px] text-positive-text">링크를 복사했습니다</span>}
    {state === "manual" && <label className="flex flex-col items-end gap-1 text-[12px] text-ink-500">
      자동 복사가 막혀 있어 직접 복사하세요
      <input readOnly value={url} onFocus={(e) => e.target.select()} aria-label="작업 링크"
        className="w-72 rounded border border-ink-200 px-2 py-1 text-[12px] text-ink-700" />
    </label>}
  </div>;
}

const MISSING = "미수집";
const TRUNCATED = "일부 span만 표시 — 전체 합계 미표시";
const pct = (v) => `${Math.round(v * 100)}%`;

function Kpis({ task }) {
  const t = task.tokens || {};
  const tokens = compactCount(t.observed_tokens);
  const cost = observedNumber(task.cost_usd);
  const basis = COST_BASIS[task.cost_basis] || undefined;
  const orMissing = (v) => (observedNumber(v) === null ? MISSING : formatObserved(v));
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
    <StatTile label="총 토큰" value={tokens ?? MISSING} hint={t.tokens_partial ? "부분합" : undefined} />
    <StatTile label="비용" variant="accent" value={cost === null ? MISSING : formatClientCost(cost)}
      hint={[basis, task.cost_partial ? "부분합" : null].filter(Boolean).join(" · ") || undefined} />
    <StatTile label="LLM 호출" value={orMissing(task.llm_calls)} />
    <StatTile label="서브에이전트" value={orMissing(task.subagents)}
      hint={task.client === "codex" ? "Codex: 미수집" : undefined} />
    <StatTile label="소요" value={formatTaskDuration(task.duration_ms)} />
  </div>;
}

// One line per rule; a rule's inputs are never zero-filled by the server, so absent rules are
// simply not listed.
function Why({ why, lanes, numbers, onSelect }) {
  const lane = (id) => { const l = lanes.find((x) => x.id === id); return l ? laneName(l) : "서브에이전트"; };
  const items = why.map(({ rule, value }) => {
    if (rule === "cache_read_share") return { rule, text: `cache read ${pct(value)} — 큰 컨텍스트로 호출 반복` };
    if (rule === "context_growth") return { rule, text: `호출당 컨텍스트 ${compactCount(value.first) ?? MISSING} → ${
      compactCount(value.last) ?? MISSING} (메인 세션 ${formatObserved(value.calls)}회)` };
    if (rule === "top_lane_share") return { rule, text: `${lane(value.lane)} 레인이 비용의 ${pct(value.share)}` };
    if (rule === "most_expensive_call") {
      const n = value.span ? numbers.get(value.span) : null;
      return { rule, span: n ? value.span : null,
        text: `가장 비싼 호출${n ? ` #${n}` : ""} ${formatClientCost(value.cost_usd)}${value.span ? "" : " (span 미연결)"}` };
    }
    if (rule === "retries") return { rule, text: `재시도 ${formatObserved(value)}회` };
    if (rule === "permission_wait") return { rule, text: `권한 대기 ${formatTaskDuration(value)}` };
    return null;
  }).filter(Boolean);
  return <section aria-label="왜 많이 썼나" className="rounded-lg border border-ink-100 p-4">
    <h3 className="mb-2 text-[14px] font-semibold text-ink-800">왜 많이 썼나</h3>
    {items.length ? <ul className="flex flex-col gap-1 text-[13px] text-ink-700">
      {items.map((it) => <li key={it.rule}>{it.span
        ? <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => onSelect(it.span)}>{it.text}</button>
        : it.text}</li>)}
    </ul> : <p className="text-[13px] text-ink-500">근거 {MISSING}</p>}
  </section>;
}

// LLM calls by (model, call source). A row's button toggles the timeline highlight; a
// truncated detail counts only the returned spans and shows no cost sums.
function ModelCalls({ rows, lanes, truncated, activeKey, onToggle }) {
  const laneText = (ids) => {
    const counts = new Map();
    for (const id of ids) {
      const l = lanes.find((x) => x.id === id);
      const name = l ? laneName(l) : "서브에이전트";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(", ");
  };
  const cost = (r) => {
    if (truncated) return "합계 미표시";
    if (r.cost_usd === null) return MISSING;
    return `${formatClientCost(r.cost_usd)}${r.cost_partial ? " (부분합)" : ""}`;
  };
  const th = "px-2 py-1 font-medium";
  return <section aria-label="모델별 호출" className="rounded-lg border border-ink-100 p-4">
    <h3 className="mb-1 text-[14px] font-semibold text-ink-800">모델별 호출</h3>
    <p className="mb-2 text-[12px] text-ink-500">행을 누르면 타임라인에서 그 모델의 LLM 호출만 강조합니다. 다시 누르면 해제됩니다.
      {truncated && " 일부 span 기준입니다."}</p>
    <div className="overflow-x-auto">
      <table className="w-full text-[13px] text-ink-700">
        <thead><tr className="text-left text-[12px] text-ink-500">
          <th className={th}>모델</th><th className={th}>호출 출처</th><th className={th}>레인</th>
          <th className={`${th} text-right`}>호출</th><th className={`${th} text-right`}>비용</th>
        </tr></thead>
        <tbody>{rows.map((r) => {
          const active = r.key === activeKey;
          return <tr key={r.key} data-active={active ? "" : undefined} onClick={() => onToggle(r.key)}
            className={`cursor-pointer border-t border-ink-100 ${active ? "bg-brand-50" : "hover:bg-ink-50"}`}>
            <td className="px-2 py-1"><button type="button" aria-pressed={active}
              className="text-left underline-offset-2 hover:underline [overflow-wrap:anywhere]"
              onClick={(e) => { e.stopPropagation(); onToggle(r.key); }}>{r.model ?? MISSING}</button></td>
            <td className="px-2 py-1">{r.source ?? MISSING}</td>
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
  const { task, truncated } = data;
  const spans = useMemo(() => data.spans || [], [data.spans]);
  const lanes = useMemo(() => laneOrder(data.lanes || [], spans), [data.lanes, spans]);
  const numbers = useMemo(() => {
    const m = new Map();
    spans.filter((s) => s.kind === "llm").forEach((s, i) => m.set(s.id, i + 1));
    return m;
  }, [spans]);
  const end = useMemo(() => timelineEnd(spans, task.duration_ms), [spans, task.duration_ms]);
  const selected = spans.find((s) => s.id === selectedId) || null;
  const priced = spans.some((s) => s.kind === "llm" && Object.prototype.hasOwnProperty.call(s, "cost_usd"));
  const unplaced = spans.filter((s) => observedNumber(s.start_ms) === null).length;
  const unlinked = observedNumber(task.completions_without_span) ?? 0;
  const models = useMemo(() => modelBreakdown(spans), [spans]);
  const activeKey = models.some((m) => m.key === highlightKey) ? highlightKey : null;
  const highlight = useMemo(() => (activeKey === null ? null : (s) => modelKey(s) === activeKey), [activeKey]);
  return <>
    {truncated ? <p role="status" className="rounded-md bg-warning-surface px-3 py-2 text-sm text-warning-text">
      <span>{TRUNCATED}</span>{` (span ${formatObserved(spans.length)} / ${formatObserved(data.span_total)})`}</p>
      : <Kpis task={task} />}
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_330px]">
      <div className="min-w-0 rounded-lg border border-ink-100 p-4">
        {lanes.length ? <TaskTimeline lanes={lanes} spans={spans} numbers={numbers} end={end} truncated={truncated}
          selectedId={selectedId} onSelect={onSelect} highlight={highlight} /> : <p className="text-sm text-ink-500">trace 미수집</p>}
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-500">
          <span>LLM 호출 (진할수록 입력 컨텍스트 큼)</span><span>회색 = 도구 실행</span><span>빨강 = 권한 대기</span>
          <span>점선 = 서브에이전트 생성</span>
          {unplaced > 0 && <span>{`시작 시각 미수집 span ${formatObserved(unplaced)}개는 표시하지 않음`}</span>}
        </div>
        {!truncated && (priced ? <div className="mt-4">
          <TaskCostBand lanes={lanes} spans={spans} end={end} durationMs={task.duration_ms} />
          <p className="mt-1 text-[12px] text-ink-500">누적 비용을 레인 색으로 쌓았습니다. 마우스를 올리면 그 시점의 레인별 누적 금액이 표시됩니다.
            {unlinked > 0 && ` span과 연결되지 않은 Codex completion ${formatObserved(unlinked)}건은 띠에 포함되지 않습니다.`}</p>
        </div> : <p className="mt-4 text-sm text-ink-500">호출별 비용 {MISSING}</p>)}
      </div>
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-ink-100 p-4">
          <TaskSpanPanel span={selected} lane={selected ? lanes.find((l) => l.id === selected.lane) : null}
            number={selected ? numbers.get(selected.id) : null} codex={task.client === "codex"} />
        </div>
        {!truncated && <Why why={data.why || []} lanes={lanes} numbers={numbers} onSelect={onSelect} />}
      </div>
    </div>
    {models.length > 0 && <ModelCalls rows={models} lanes={lanes} truncated={truncated} activeKey={activeKey}
      onToggle={(key) => onHighlight((k) => (k === key ? null : key))} />}
  </>;
}

// `user` is the exact user the task list belongs to. A shared link has none: the server
// resolves the owner and returns it, and the header masks that instead.
export function TaskTraceOverlay({ taskId, user, from, to, onClose }) {
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
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="작업 상세" tabIndex={-1}
      className="mx-auto flex max-w-[1320px] flex-col gap-4 rounded-lg bg-card p-4 shadow-pop outline-none sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold text-ink-800">
            작업 상세 <Badge tone="warning">부분 수집</Badge>
            {task && <Badge tone={task.client === "codex" ? "brand" : "neutral"}>{clientName(task.client)}</Badge>}
          </h2>
          <p className="text-[12px] text-ink-500 [overflow-wrap:anywhere]">
            {[task ? formatClientTimestamp(task.started_at) : null, user || api.data?.owner ? maskEmail(user || api.data.owner) : null,
              task?.models?.length ? task.models.join(", ") : null].filter(Boolean).join(" · ")}
            {" · trace를 켠 사용자만 수집 · 프롬프트·명령·경로 원문은 표시하지 않습니다"}</p>
        </div>
        <div className="flex items-start gap-2">
          <ShareLink taskId={taskId} from={from} to={to} />
          <button type="button" onClick={() => onClose?.()} className="rounded-md border border-ink-200 px-3 py-1 text-sm text-ink-700">닫기</button>
        </div>
      </div>
      {api.error ? <ErrorBox error={api.error} /> : pending || !api.data ? <Loading />
        : <Body data={api.data} selectedId={selectedId} onSelect={setSelectedId}
          highlightKey={highlightKey} onHighlight={setHighlightKey} />}
    </div>
  </div>;
}
