import { useMemo, useState } from "react";
import { Badge } from "../components/Badge.jsx";
import { BarTip } from "../components/BarTip.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { USER_COST_CHANNELS, combineCostUsers, userChannelLines } from "../clientCost.js";
import { presentationRow } from "../clientPresentation.js";
import { formatClientCost, formatObserved } from "../clientUsage.js";
import { byModelLegendOrder, modelColorFor } from "../colors.js";
import { maskEmail } from "../fmt.js";
import { modelLabel } from "../modelCostTrend.js";
import { useTeams, withTeamColumn, withTeams } from "../TeamsContext.jsx";

// Help text names only the selected clients (shared views never mention an unselected client).
function help(clients) {
  const claude = clients.includes("claude"), codex = clients.includes("codex");
  const channels = [claude && "CCB: Claude Code Bedrock 채널, C4E: Claude Code Enterprise 채널", codex && "Codex"].filter(Boolean).join(", ");
  const bases = [claude && "Claude Code는 클라이언트 보고 비용", codex && "Codex는 AWS 정가 추정"].filter(Boolean).join(", ");
  return `알려진 보고·추정 비용만 합산합니다. 미산정 금액은 제외하고 부분합으로 표시하며, 모두 미산정이면 —입니다. 같은 사용자 ID를 한 행으로 합치지만 직원 신원을 확인한 값은 아닙니다. 비용 옆 막대의 줄은 ${claude ? "채널" : "클라이언트"}(${channels}), 색은 모델입니다.${claude ? " CCB·C4E는 세션 단위로 추론한 접근 채널입니다." : ""} ${bases}이며 실청구와 다를 수 있습니다.`;
}

const lineAmount = (line) => line.total === null ? "미산정" : `${formatClientCost(line.total)}${line.partial ? " (부분합)" : ""}`;
export const channelTotalsText = (lines) => lines.map((line) => `${line.label} ${lineAmount(line)}`).join(" · ");

function Dot({ color }) {
  return <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />;
}

// Claude detail's UserGroupModelBars vocabulary: the leading dot is the channel,
// segment colors are models, and line length shares one column-wide maximum.
function ChannelModelBars({ lines, max }) {
  if (!lines.length) return null;
  return <span className="inline-flex w-36 shrink-0 flex-col gap-[3px] align-middle">
    {lines.map((line) => <BarTip key={line.key} className="flex items-center gap-1.5"
      label={`${line.label} ${lineAmount(line)}${line.segs.length ? ` — ${line.segs.map((seg) => `${modelLabel(seg.model)} ${formatClientCost(seg.value)}`).join(" · ")}` : ""}`}
      tip={<span className="flex flex-col gap-0.5">
        <span className="flex items-center gap-1.5 font-semibold">
          <Dot color={line.color} />{line.title}
          <span className="tabular ml-auto pl-4">{lineAmount(line)}</span>
        </span>
        {line.segs.map((seg) => <span key={seg.model} className="flex items-center gap-1.5">
          <Dot color={modelColorFor(seg.model) ?? "var(--ink-300)"} />{modelLabel(seg.model)}
          <span className="tabular ml-auto pl-4">{formatClientCost(seg.value)}</span>
        </span>)}
      </span>}>
      <Dot color={line.color} />
      <span className="h-1.5 min-w-0 flex-1">
        {line.segs.length && max > 0
          ? <span className="flex h-full overflow-hidden rounded-full" style={{ width: `${Math.max(1, line.total / max * 100)}%` }}>
            {line.segs.map((seg) => <span key={seg.model} style={{ width: `${seg.value / line.total * 100}%`, minWidth: "1px",
              background: modelColorFor(seg.model) ?? "var(--ink-300)" }} />)}
          </span>
          : <span className="block text-[10px] leading-[6px] text-ink-500">{line.total === null ? "미산정" : formatClientCost(line.total)}</span>}
      </span>
    </BarTip>)}
  </span>;
}

function Legend({ lines }) {
  return <span className="inline-flex items-center gap-2">
    {lines.map((line) => <span key={line.key} className="inline-flex items-center gap-1" title={line.title}>
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: line.color }} />{line.label}
    </span>)}
  </span>;
}

const amount = (value, row) => <span className="inline-flex items-center gap-1.5">
  {formatClientCost(value)}{value !== null && row?.cost_partial && <Badge tone="warning">부분합</Badge>}
</span>;
const link = (label, onClick, disabled) => <button type="button" onClick={onClick} disabled={disabled}
  className="text-left text-brand-700 underline decoration-brand-200 underline-offset-4 hover:decoration-brand-700 disabled:text-ink-500 disabled:no-underline">{label}</button>;

export function CostUsers({ users, modelRows, clients, stale, onSelect }) {
  const teams = useTeams();
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo(() => combineCostUsers(users, modelRows, clients).map((row) => ({
    ...presentationRow(row), cost_basis_label: row.cost_basis_label,
    lines: userChannelLines(row.models, byModelLegendOrder),
  })), [users, modelRows, clients]);
  const max = Math.max(0, ...rows.flatMap((row) => row.lines.map((line) => line.total || 0)));
  const legend = USER_COST_CHANNELS.filter(({ key }) => rows.some((row) => row.lines.some((line) => line.key === key)));
  const visible = expanded ? rows : rows.slice(0, 20);
  const multi = clients.length > 1;
  const columns = withTeamColumn([
    { key: "user", label: "사용자", render: (value, row) => link(maskEmail(value) || "(미식별)",
      () => onSelect({ kind: "user", client: multi ? "all" : clients[0], user: value }), stale || !value),
    toText: maskEmail },
    { key: "cost_usd", label: "비용 (USD)", render: (value, row) => <span className="inline-flex items-center gap-3">
      <span className="min-w-[4.5rem]">{amount(value, row)}</span>
      <ChannelModelBars lines={row.lines} max={max} />
    </span>,
    toText: (value, row) => {
      if (value === null) return "";
      const split = channelTotalsText(row.lines);
      return split ? `${formatClientCost(value)} — ${split}` : formatClientCost(value);
    } },
    { key: "sessions", label: "세션", render: formatObserved },
    { key: "cost_per_session", label: "세션당 비용 (USD)", render: amount },
    { key: "observed_tokens", label: "관측 토큰", render: formatObserved },
    { key: "token_status", label: "토큰 상태" },
    { key: "cost_basis_label", label: "비용 기준" },
  ], teams);
  const unidentified = rows.filter((row) => !row.user).length;
  return <DataTable title="사용자별 비용"
    subtitle={<span className="inline-flex flex-wrap items-center gap-x-1.5">
      {`사용자 단위로 합산 · 막대의 줄은 채널, 색은 모델${unidentified ? ` · 미식별 ${unidentified}행 포함` : ""}${rows.length > 20 ? ` · ${visible.length}/${rows.length}행 표시` : ""}`}
      <Legend lines={legend} />
    </span>}
    help={help(clients)} columns={columns} rows={withTeams(visible, teams)} exportName="clients_user_costs" stale={stale}
    right={rows.length > 20 ? <button type="button" onClick={() => setExpanded((value) => !value)}
      className="text-[11px] font-medium text-brand-700 whitespace-nowrap">{expanded ? "20행만 보기" : `전체 ${rows.length}행 보기`}</button> : undefined} />;
}
