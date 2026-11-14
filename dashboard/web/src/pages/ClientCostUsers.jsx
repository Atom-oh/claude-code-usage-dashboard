import { translate, useLocale } from "../i18n/index.js";
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
  const channels = [claude && translate("mafec9acfc7c7"), codex && "Codex"].filter(Boolean).join(", ");
  const bases = [claude && translate("m372aa9d8fef9"), codex && translate("m4c489bbbb28f")].filter(Boolean).join(", ");
  return translate("m8a698417b4e2", [claude ? translate("ma391a59a3eb6") : translate("mb367c7d58dda"), channels, claude ? translate("m0508af52364b") : "", bases]);
}

const lineAmount = (line) => line.total === null ? translate("ma8761601c736") : `${formatClientCost(line.total)}${line.partial ? translate("m830e860c2bd2") : ""}`;
export const channelTotalsText = (lines) => lines.map((line) => `${line.label} ${lineAmount(line)}`).join(" · ");
const csvAmount = (value, row) => value === null ? "" : `${formatClientCost(value)}${row?.cost_partial ? translate("m830e860c2bd2") : ""}`;

function Dot({ color }) {
  const _locale = useLocale();
  return <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />;
}

// Claude detail's UserGroupModelBars vocabulary: the leading dot is the channel,
// segment colors are models, and line length shares one column-wide maximum.
function ChannelModelBars({ lines, max }) {
  const _locale = useLocale();
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
          : <span className="block text-[10px] leading-[6px] text-ink-500">{line.total === null ? translate("ma8761601c736") : formatClientCost(line.total)}</span>}
      </span>
    </BarTip>)}
  </span>;
}

function Legend({ lines }) {
  const _locale = useLocale();
  return <span className="inline-flex items-center gap-2">
    {lines.map((line) => <span key={line.key} className="inline-flex items-center gap-1" title={line.title}>
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: line.color }} />{line.label}
    </span>)}
  </span>;
}

const amount = (value, row) => <span className="inline-flex items-center gap-1.5">
  {formatClientCost(value)}{value !== null && row?.cost_partial && <Badge tone="warning">{translate("md15c830a6f1c")}</Badge>}
</span>;
const link = (label, onClick, disabled) => <button type="button" onClick={onClick} disabled={disabled}
  className="text-left text-brand-700 underline decoration-brand-200 underline-offset-4 hover:decoration-brand-700 disabled:text-ink-500 disabled:no-underline">{label}</button>;

export function CostUsers({ users, modelRows, clients, stale, onSelect }) {
  const _locale = useLocale();
  const teams = useTeams();
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo(() => combineCostUsers(users, modelRows, clients).map((row) => ({
    ...presentationRow(row), cost_basis_label: row.cost_basis_label,
    lines: userChannelLines(row.models, byModelLegendOrder),
  })), [users, modelRows, clients, _locale]);
  const max = Math.max(0, ...rows.flatMap((row) => row.lines.map((line) => line.total || 0)));
  const legend = USER_COST_CHANNELS.filter(({ key }) => rows.some((row) => row.lines.some((line) => line.key === key)));
  const visible = expanded ? rows : rows.slice(0, 20);
  const multi = clients.length > 1;
  const columns = withTeamColumn([
    { key: "user", label: translate("m1ac6e422b7dc"), render: (value, row) => link(maskEmail(value) || translate("m4083695f59ed"),
      () => onSelect({ kind: "user", client: multi ? "all" : clients[0], user: value }), stale || !value),
    toText: maskEmail },
    { key: "cost_usd", label: translate("m1f44dc9c08e3"), render: (value, row) => <span className="inline-flex items-center gap-3">
      <span className="min-w-[4.5rem]">{amount(value, row)}</span>
      <ChannelModelBars lines={row.lines} max={max} />
    </span>,
    toText: (value, row) => {
      if (value === null) return "";
      const split = channelTotalsText(row.lines);
      return split ? `${csvAmount(value, row)} — ${split}` : csvAmount(value, row);
    } },
    { key: "sessions", label: translate("me600d4f5926e"), render: formatObserved },
    { key: "cost_per_session", label: translate("ma70ae1584644"), render: amount, toText: csvAmount },
    { key: "observed_tokens", label: translate("m187f5b1fe374"), render: formatObserved },
    { key: "token_status", label: translate("mf7ef1510e99b") },
    { key: "cost_basis_label", label: translate("m6b64da4fb26b") },
  ], teams);
  const unidentified = rows.filter((row) => !row.user).length;
  return <DataTable title={translate("m15bf7dd3ba7f")}
    subtitle={<span className="inline-flex flex-wrap items-center gap-x-1.5">
      {translate("m8abcc39f5c2a", [unidentified ? translate("mf4a4d88e55a4", [unidentified]) : "", rows.length > 20 ? translate("m03d982ec16fc", [visible.length, rows.length]) : ""])}
      <Legend lines={legend} />
    </span>}
    help={help(clients)} columns={columns} rows={withTeams(visible, teams)} exportName="clients_user_costs" stale={stale}
    right={rows.length > 20 ? <button type="button" onClick={() => setExpanded((value) => !value)}
      className="text-[11px] font-medium text-brand-700 whitespace-nowrap">{expanded ? translate("m9ac43a97b2a3") : translate("m24714483a922", [rows.length])}</button> : undefined} />;
}
