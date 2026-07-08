import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { apiGet } from "../api.js";
import { useRange } from "../RangeContext.jsx";
import { Card, Loading, ErrorBox } from "./Card.jsx";
import { StatTile } from "./StatTile.jsx";
import { DualLineChart, GroupBarChart } from "./GroupCharts.jsx";
import { makeTickFmt } from "../fmt.js";

const fmt = (n) => Number(n || 0).toLocaleString();
const STATUS_COLOR = { accept: "var(--positive)", reject: "var(--negative)" };

// GitHub식 활동 히트맵 — 13주 × 7일 그리드, 세션 수 5단계 농도.
function Heatmap({ rows, to }) {
  const byDay = new Map((rows || []).map((r) => [r.d, Number(r.sessions)]));
  const max = Math.max(1, ...byDay.values());
  const DAY = 86400000;
  const end = new Date(to);
  // 그리드 끝을 토요일로 정렬해 주 단위 열이 깔끔하게 떨어지게 한다.
  const endMs = end.getTime() + (6 - end.getDay()) * DAY;
  const weeks = [];
  for (let w = 12; w >= 0; w--) {
    const col = [];
    for (let d = 0; d < 7; d++) {
      const ms = endMs - (w * 7 + (6 - d)) * DAY;
      if (ms > end.getTime()) { col.push(null); continue; }
      const key = new Date(ms).toISOString().slice(0, 10);
      col.push({ key, n: byDay.get(key) || 0 });
    }
    weeks.push(col);
  }
  const level = (n) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)));
  const LEVEL_BG = ["var(--ink-100)", "#cfe0fd", "#9dc2fb", "#6ba3f9", "var(--brand-500)"];
  return (
    <div className="flex gap-[3px]">
      {weeks.map((col, i) => (
        <div key={i} className="flex flex-col gap-[3px]">
          {col.map((c, j) =>
            c === null ? (
              <span key={j} className="h-3 w-3" />
            ) : (
              <span key={j} title={`${c.key} · 세션 ${c.n}`} className="h-3 w-3 rounded-[2px]" style={{ background: LEVEL_BG[level(c.n)] }} />
            )
          )}
        </div>
      ))}
    </div>
  );
}

// 리더보드 행 클릭 → 우측 드로어. row는 리더보드가 이미 계산한 유저 집계(세션/LOC/점수 등).
export function UserDrawer({ row, onClose }) {
  const { from, to, days } = useRange();
  const fmtTick = makeTickFmt(24);
  const [state, setState] = useState({ loading: true, error: null, daily: [], byTool: [], heatmap: [] });

  useEffect(() => {
    if (!row) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    const params = { from: from.toISOString(), to: to.toISOString(), email: row.user };
    Promise.all([apiGet("/api/users/daily", params), apiGet("/api/users/decisions-by-tool", params), apiGet("/api/users/heatmap", params)])
      .then(([daily, byTool, heatmap]) => !cancelled && setState({ loading: false, error: null, daily, byTool, heatmap }))
      .catch((error) => !cancelled && setState((s) => ({ ...s, loading: false, error })));
    return () => {
      cancelled = true;
    };
  }, [row?.user, from.getTime(), to.getTime()]);

  if (!row) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <aside className="fixed right-0 top-0 z-50 h-screen w-full max-w-xl overflow-y-auto bg-page border-l border-ink-100 shadow-xl p-6 flex flex-col gap-4 animate-fade-in">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[18px] font-semibold text-ink-800 truncate">{row.user}</h2>
            {/* 아래 차트들은 전역 필터(group/model) 미적용 — 유저 개인의 전체 활동 기준.
                리더보드 행(필터 적용 집계)과 모수가 다를 수 있어 라벨로 명시한다. */}
            <p className="text-[12px] text-ink-400 mt-0.5">
              {row.group} · 최근 {days}일 · 생산성 점수 {Number(row.productivity_score).toFixed(1)} · 전체 활동 기준(필터 미적용)
            </p>
          </div>
          <button onClick={onClose} className="shrink-0 rounded-md p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-600">
            <X size={18} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <StatTile label="세션" value={fmt(row.sessions)} />
          <StatTile label="추가 라인" value={fmt(row.loc)} />
          <StatTile label="커밋 · PR" value={`${fmt(row.commits)} · ${fmt(row.prs)}`} />
          <StatTile label="수락률" value={`${(Number(row.accept_rate) * 100).toFixed(0)}%`} />
        </div>

        {state.loading ? (
          <Loading />
        ) : state.error ? (
          <ErrorBox error={state.error} />
        ) : (
          <>
            <Card title="활동 히트맵" subtitle="최근 13주 · 일별 세션 수">
              <Heatmap rows={state.heatmap} to={to} />
            </Card>
            <DualLineChart
              title="일별 활동"
              rows={state.daily}
              xKey="t"
              height={200}
              tickFormatter={fmtTick}
              lines={[
                { key: "sessions", label: "세션", axis: "left" },
                { key: "loc", label: "추가 라인", axis: "right" },
              ]}
            />
            <GroupBarChart
              title="도구별 수락/거부"
              rows={state.byTool}
              xKey="tool"
              valueKey="n"
              height={180}
              colorFn={(r) => STATUS_COLOR[r.decision] || "var(--ink-400)"}
            />
          </>
        )}
      </aside>
    </>
  );
}
