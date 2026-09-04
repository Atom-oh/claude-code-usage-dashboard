import { useEffect, useState } from "react";
import { Info, X } from "lucide-react";
import { apiGet } from "../api.js";
import { useRange } from "../RangeContext.jsx";
import { Card, Loading, ErrorBox } from "./Card.jsx";
import { StatTile } from "./StatTile.jsx";
import { DualLineChart, GroupBarChart } from "./GroupCharts.jsx";
import { BarTip } from "./BarTip.jsx";
import { makeTickFmt, maskEmail, parseUtc } from "../fmt.js";

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

const secs = (ms) => `${(Number(ms) / 1000).toFixed(1)}s`;

// 턴(interaction)별 워터폴 — traces beta(§F4) 드릴다운. resp는 {unsupported, rows} 그대로.
// max는 리스트 전체에서 한 번만 구한다: 행마다 다시 구하면 모든 바가 꽉 차 비교가 무의미해진다.
function InteractionWaterfall({ resp }) {
  if (resp.unsupported) {
    return (
      <Card
        title="턴별 워터폴"
        subtitle={`데이터 없음: traces beta(CLAUDE_CODE_ENHANCED_TELEMETRY_BETA)가 아직 이 구간에 배포되지 않았거나, interaction 스팬이 Claude Code v${resp.minVersion} 미만에서는 나오지 않습니다 — 0이 아니라 "미수집"입니다.`}
      >
        <p className="text-[12px] text-ink-400">미수집 (traces beta)</p>
      </Card>
    );
  }

  const rows = resp.rows || [];
  const max = Math.max(0, ...rows.map((r) => Number(r.interaction_ms)));

  return (
    <Card
      title="턴별 워터폴"
      subtitle="턴(interaction)별 소요 시간과 그 안의 LLM 호출 · 툴 실행 · 권한 대기 구간. 구간은 동시에 진행될 수 있어(툴 스팬의 duration_ms는 권한 대기 + 실행을 함께 담는다) 세 구간의 합이 총 시간을 넘을 수 있다 — 구성비가 아니라 각 구간이 쓴 시간으로 읽을 것."
    >
      <div className="max-h-64 overflow-y-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr>
              {["시각", "세션", "총 시간", "구간", "에이전트", "LLM"].map((h) => (
                <th key={h} className="text-[11px] text-ink-400 font-medium text-left py-1.5 pr-2">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const segs = [
                { key: "llm", label: "LLM 호출", value: Number(r.llm_ms), color: "var(--chart-1)" },
                { key: "tool", label: "툴 실행", value: Number(r.tool_exec_ms), color: "var(--chart-3)" },
                { key: "blocked", label: "권한 대기", value: Number(r.blocked_ms), color: "var(--chart-4)" },
              ].filter((s) => s.value > 0);
              const segSum = segs.reduce((sum, s) => sum + s.value, 0);
              return (
                <tr key={r.trace_id} className="border-t border-ink-100">
                  <td className="py-1.5 pr-2 tabular">
                    {parseUtc(r.started_at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </td>
                  <td className="py-1.5 pr-2">
                    <span className="text-ink-400">{String(r.session_id).slice(0, 8)}</span>
                  </td>
                  <td className="py-1.5 pr-2 tabular">{secs(r.interaction_ms)}</td>
                  <td className="py-1.5 pr-2">
                    {max > 0 &&
                      (segSum === 0 ? (
                        <BarTip
                          className="inline-block h-1.5 w-24 shrink-0 rounded-full bg-ink-100 align-middle"
                          label={`총 ${secs(r.interaction_ms)}`}
                          tip={
                            <span className="flex flex-col gap-0.5">
                              <span className="flex items-center gap-1.5 font-semibold">
                                총 시간<span className="tabular ml-auto pl-4">{secs(r.interaction_ms)}</span>
                              </span>
                            </span>
                          }
                        >
                          <span className="block h-full rounded-full bg-ink-200" style={{ width: `${Math.max(1, (Number(r.interaction_ms) / max) * 100)}%` }} />
                        </BarTip>
                      ) : (
                        <BarTip
                          className="inline-block h-1.5 w-24 shrink-0 rounded-full bg-ink-100 align-middle"
                          label={`총 ${secs(r.interaction_ms)} — ${segs.map((s) => `${s.label} ${secs(s.value)}`).join(" · ")}`}
                          tip={
                            <span className="flex flex-col gap-0.5">
                              <span className="flex items-center gap-1.5 font-semibold">
                                총 시간<span className="tabular ml-auto pl-4">{secs(r.interaction_ms)}</span>
                              </span>
                              {segs.map((s) => (
                                <span key={s.key} className="flex items-center gap-1.5">
                                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
                                  {s.label}
                                  <span className="tabular ml-auto pl-4">{secs(s.value)}</span>
                                </span>
                              ))}
                            </span>
                          }
                        >
                          <span className="flex h-full overflow-hidden rounded-full" style={{ width: `${Math.max(1, (Number(r.interaction_ms) / max) * 100)}%` }}>
                            {segs.map((s) => (
                              <span key={s.key} style={{ width: `${(s.value / segSum) * 100}%`, minWidth: "1px", background: s.color }} />
                            ))}
                          </span>
                        </BarTip>
                      ))}
                  </td>
                  <td className="py-1.5 pr-2 tabular">{fmt(r.agents)}</td>
                  <td className="py-1.5 pr-2 tabular">{fmt(r.llm_calls)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// 리더보드 행 클릭 → 우측 드로어. row는 리더보드가 이미 계산한 유저 집계(세션/LOC/점수 등).
export function UserDrawer({ row, onClose }) {
  const { from, to } = useRange();
  const fmtTick = makeTickFmt(24);
  const [state, setState] = useState({ loading: true, error: null, daily: [], byTool: [], heatmap: [], interactions: null });

  useEffect(() => {
    if (!row) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    // group을 넘겨 리더보드 행(유저×그룹, 필터된 값)과 드릴다운 모수를 맞춘다 — 안 그러면
    // straddler의 bedrock 행을 열어도 아래 차트는 양 그룹 합산으로 나와 상단 타일과 안 맞는다.
    const params = { from: from.toISOString(), to: to.toISOString(), email: row.user, group: row.group };
    Promise.all([apiGet("/api/users/daily", params), apiGet("/api/users/decisions-by-tool", params), apiGet("/api/users/heatmap", params), apiGet("/api/users/interactions", params)])
      .then(([daily, byTool, heatmap, interactions]) => !cancelled && setState({ loading: false, error: null, daily, byTool, heatmap, interactions }))
      .catch((error) => !cancelled && setState((s) => ({ ...s, loading: false, error })));
    return () => {
      cancelled = true;
    };
  }, [row?.user, row?.group, from.getTime(), to.getTime()]);

  // state.byTool은 group×tool×decision 원본(codeEditDecisionsByTool)이라, 이 유저가 bedrock/
  // enterprise 세션을 모두 가지면 같은 tool+decision이 그룹별 다중 row로 내려와 GroupBarChart가
  // 중복 렌더한다 — Productivity.jsx의 decisionsByToolAgg와 동일하게 tool+decision으로 합산.
  const decisionsByToolAgg = Object.values(
    (state.byTool || []).reduce((acc, r) => {
      const k = `${r.tool}|${r.decision}`;
      (acc[k] ||= { tool: r.tool, decision: r.decision, n: 0 }).n += Number(r.n);
      return acc;
    }, {})
  );

  if (!row) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <aside className="fixed right-0 top-0 z-50 h-screen w-full max-w-xl overflow-y-auto bg-paper border-l border-ink-100 shadow-xl p-6 flex flex-col gap-4 animate-fade-in">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[18px] font-semibold text-ink-800 truncate">{maskEmail(row.user)}</h2>
            {/* 아래 차트들은 row.group(이 유저×그룹 행)으로만 필터 — 전역 model 필터는 여전히
                미적용이라 model 필터가 켜진 상태에서 리더보드 행과 정확히 일치하진 않는다. */}
            <p className="text-[12px] text-ink-400 mt-0.5 inline-flex items-center gap-1">
              {row.group} · 생산성 점수 {Number(row.productivity_score).toFixed(1)}
              <Info
                size={12}
                className="shrink-0 text-ink-400"
                title="이 채널에서의 활동만 집계합니다. 아래 차트에는 상단 모델 필터가 적용되지 않아, 필터를 켠 상태에서는 위 요약 수치와 차이가 날 수 있습니다."
                aria-label="이 채널에서의 활동만 집계합니다. 아래 차트에는 상단 모델 필터가 적용되지 않아, 필터를 켠 상태에서는 위 요약 수치와 차이가 날 수 있습니다."
              />
            </p>
          </div>
          <button onClick={onClose} className="shrink-0 rounded-md p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-600">
            <X size={18} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <StatTile label="세션" value={fmt(row.sessions)} />
          <StatTile label="추가 코드 라인" value={fmt(row.loc)} />
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
                { key: "loc", label: "추가 코드 라인", axis: "right" },
              ]}
            />
            <GroupBarChart
              title="도구별 수락/거부"
              rows={decisionsByToolAgg}
              xKey="tool"
              valueKey="n"
              height={180}
              colorFn={(r) => STATUS_COLOR[r.decision] || "var(--ink-400)"}
            />
            {state.interactions && <InteractionWaterfall resp={state.interactions} />}
          </>
        )}
      </aside>
    </>
  );
}
