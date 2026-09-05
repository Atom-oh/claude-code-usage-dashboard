import { Check } from "lucide-react";
import { cn } from "../cn.js";

// Executive 히어로 스플릿 밴드 — 행마다 bedrock(좌)/enterprise(우) 값을 중앙 라벨을 축으로
// 맞세우고, 6px 스플릿 바 하나가 두 값의 비중을 나눈다. 장식은 이 스플릿 모티프가 전부.
// rows: [{ label, bedrock, enterprise, format('number'|'usd'|'pct'|'hours'), betterIs('high'|'low'|null) }]

const COLS = "grid grid-cols-[1fr_10rem_1fr] items-stretch";

// pct는 RingGauge와 같은 0~1 분율 계약(96% → 0.96) — %값(96)을 그대로 넘기면 9600%가 된다.
// usd 소수 처리는 DonutBody의 fmt와 동일($10 미만은 센트 단위 유지).
export function fmtValue(v, format) {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return "—";
  if (format === "usd") return `$${n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString()}`;
  if (format === "pct") {
    const p = n * 100;
    return `${p.toFixed(p < 10 ? 1 : 0)}%`;
  }
  if (format === "hours") return `${n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 1 : 0 })}시간`;
  return n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 1 : 0 });
}

function winnerOf({ bedrock, enterprise, betterIs }) {
  const b = Number(bedrock);
  const e = Number(enterprise);
  if (!betterIs || bedrock == null || enterprise == null || !Number.isFinite(b) || !Number.isFinite(e) || b === e) return null;
  return (betterIs === "high") === b > e ? "bedrock" : "enterprise";
}

// HBarList와 같은 최소 가시폭(2%) — 양쪽 다 0보다 클 때만. 진짜 0은 0으로 보여준다.
function splitShare({ bedrock, enterprise }) {
  const b = Math.max(0, Number(bedrock) || 0);
  const e = Math.max(0, Number(enterprise) || 0);
  if (b + e <= 0) return null;
  if (b === 0) return 0;
  if (e === 0) return 100;
  return Math.min(98, Math.max(2, (b / (b + e)) * 100));
}

// 지표별 격차를 한 축에 — 0(동률) 기준선에서 값이 큰 그룹 쪽으로 뻗는 다이버징 바(dataviz:
// 기준선 대비 위/아래는 다이버징). 스코어보드는 지표당 한 행이라 "어느 지표의 격차가 가장
// 큰가"는 못 보여준다 — 이 차트가 그 일을 맡는다. 격차는 (b−e)/평균의 대칭 백분율이라 어느
// 쪽이 커도 같은 크기로 읽히고, ±100%로 캡. 색은 값이 큰 그룹의 시리즈 색(우세 판정 아님 —
// 지출처럼 큰 게 나쁜 지표도 있어서 방향은 크기만 나른다).
export function DeltaBars({ rows }) {
  const items = (rows || [])
    .map((r) => {
      const b = Number(r.bedrock), e = Number(r.enterprise);
      if (r.bedrock == null || r.enterprise == null || !Number.isFinite(b) || !Number.isFinite(e) || b + e === 0) return null;
      const delta = ((b - e) / ((b + e) / 2)) * 100;
      return { label: r.label, delta: Math.max(-100, Math.min(100, delta)) };
    })
    .filter(Boolean);
  if (items.length === 0) return null;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.04em]">
        <span style={{ color: "var(--series-bedrock)" }}>◀ Bedrock이 큼</span>
        <span className="text-ink-400">동률</span>
        <span style={{ color: "var(--series-enterprise)" }}>Enterprise가 큼 ▶</span>
      </div>
      <ul className="space-y-2">
        {items.map((it) => {
          const bedrockSide = it.delta > 0;
          const w = Math.abs(it.delta) / 2; // 절반 트랙 기준 %
          return (
            <li key={it.label} className="flex items-center gap-3">
              <span className="w-28 shrink-0 truncate text-right text-[12px] text-ink-600" title={it.label}>{it.label}</span>
              <div className="relative h-4 flex-1" title={`${it.label}: ${bedrockSide ? "bedrock" : "enterprise"} +${Math.abs(it.delta).toFixed(0)}%`}>
                <div className="absolute inset-y-1.5 left-0 right-0 rounded-full bg-ink-100" />
                <div className="absolute inset-y-0 left-1/2 w-px bg-ink-300" />
                <div
                  className="absolute inset-y-1 rounded-full"
                  style={{
                    background: bedrockSide ? "var(--series-bedrock)" : "var(--series-enterprise)",
                    ...(bedrockSide ? { right: "50%", width: `${w}%` } : { left: "50%", width: `${w}%` }),
                  }}
                />
              </div>
              <span className="tabular w-14 shrink-0 text-[12px] font-medium text-ink-800">
                {it.delta === 0 ? "동률" : `+${Math.abs(it.delta).toFixed(0)}%`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function ABScoreboard({ rows }) {
  return (
    <div className="overflow-hidden rounded-lg border border-ink-100 bg-card shadow-card">
      <div className={cn(COLS, "border-b border-ink-100")}>
        <div
          className="py-2.5 pl-5 text-[11px] font-semibold uppercase tracking-[0.04em]"
          style={{ color: "var(--series-bedrock)", background: "var(--series-bedrock-tint)" }}
        >
          Bedrock
        </div>
        <div />
        <div
          className="py-2.5 pr-5 text-right text-[11px] font-semibold uppercase tracking-[0.04em]"
          style={{ color: "var(--series-enterprise)", background: "var(--series-enterprise-tint)" }}
        >
          Enterprise
        </div>
      </div>
      {(rows || []).map((row, i) => {
        const win = winnerOf(row);
        const share = splitShare(row);
        return (
          <div key={row.label ?? i} className="border-b border-ink-100 last:border-b-0">
            <div className={COLS}>
              <div className="flex items-center justify-end gap-2 py-3.5 pl-5 pr-4" style={{ background: "var(--series-bedrock-tint)" }}>
                {win === "bedrock" && (
                  <Check size={14} strokeWidth={3} className="shrink-0" style={{ color: "var(--series-bedrock)" }} aria-label="우세" />
                )}
                <span className="tabular text-[24px] font-semibold leading-none" style={{ color: "var(--series-bedrock)" }}>
                  {fmtValue(row.bedrock, row.format)}
                </span>
              </div>
              <div className="flex items-center justify-center px-2 py-3.5 text-center text-[11px] font-semibold uppercase leading-snug tracking-[0.04em] text-ink-400">
                {row.label}
              </div>
              <div className="flex items-center gap-2 py-3.5 pl-4 pr-5" style={{ background: "var(--series-enterprise-tint)" }}>
                <span className="tabular text-[24px] font-semibold leading-none" style={{ color: "var(--series-enterprise)" }}>
                  {fmtValue(row.enterprise, row.format)}
                </span>
                {win === "enterprise" && (
                  <Check size={14} strokeWidth={3} className="shrink-0" style={{ color: "var(--series-enterprise)" }} aria-label="우세" />
                )}
              </div>
            </div>
            {share == null ? (
              <div className="h-[6px] w-full bg-ink-100" />
            ) : (
              <div className="flex h-[6px] w-full">
                <span style={{ width: `${share}%`, background: "var(--series-bedrock)" }} />
                <span className="w-px shrink-0" style={{ background: "var(--white)" }} />
                <span className="flex-1" style={{ background: "var(--series-enterprise)" }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
