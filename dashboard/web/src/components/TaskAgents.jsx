import { translate, translateSource, useLocale } from "../i18n/index.js";
// Codex subagent calls of one task (/api/users/tasks/detail `agents`): the parent turn that
// started this one, the subagent turns this turn started (nested ones indented) with their
// own calls and linked cost estimates, and the turn's total including them. Links are found
// through the trace's parent-span chain, so an absent link is unknown, never zero subagents.
import { formatClientCost, formatObserved } from "../clientUsage.js";
import { formatClientTimestamp, observedNumber } from "../clientPresentation.js";
import { taskSharePath } from "../clientNavigation.js";
import { formatTaskDuration } from "./TaskList.jsx";

const MISSING = "미수집";

function cost(value, partial) {
  if (observedNumber(value) === null) return translateSource(MISSING);
  return `${formatClientCost(value)}${partial ? translate("m830e860c2bd2") : ""}`;
}

export function TaskAgents({ agents, from, to }) {
  const _locale = useLocale();
  if (!agents) return null;
  const { parent, children = [], total, unlinked_calls: unlinked, limited } = agents;
  const th = "px-2 py-1 font-medium";
  const link = "text-brand-700 underline-offset-2 hover:underline";
  return <section aria-label={translate("mdf62edb62607")} className="rounded-lg border border-ink-100 p-4">
    <h3 className="mb-2 text-[14px] font-semibold text-ink-800">{translate("mdf62edb62607")}</h3>
    {parent && <p className="mb-2 text-[13px] text-ink-700">
      {translate("ma5f1a83f15da", [parent.tool ?? translateSource(MISSING)])}{" "}
      <a className={link} href={taskSharePath(parent.id, from, to)}>{translate("mbac6e1b660b1")}</a></p>}
    {children.length > 0 ? <>
      <p className="mb-2 text-[13px] font-medium text-ink-800">
        {/* One partial mark at the end covers calls and cost: both sum the same known turns. */}
        {translate("m850bec9b93cc", [observedNumber(total?.llm_calls) === null ? translateSource(MISSING)
          : formatObserved(total.llm_calls), cost(total?.cost_usd, total?.cost_partial || total?.llm_calls_partial)])}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px] text-ink-700">
          <thead><tr className="text-left text-[12px] text-ink-500">
            <th className={th}>{translate("mdbd1ade42624")}</th><th className={th}>{translate("m0d31ae34c7ed")}</th>
            <th className={th}>{translate("mf9f4d4113aa1")}</th><th className={th}>{translate("mb1f28cd21af7")}</th>
            <th className={`${th} text-right`}>{translate("mce075704a738")}</th>
            <th className={`${th} text-right`}>{translate("m5570150cd696")}</th>
            <th className={`${th} text-right`}>{translate("m24423dd67b3a")}</th>
          </tr></thead>
          <tbody>{children.map((c, i) => <tr key={c.id ?? i} className="border-t border-ink-100">
            <td className="px-2 py-1 whitespace-nowrap" style={{ paddingLeft: `${0.5 + (c.depth - 1) * 1.25}rem` }}>
              {c.depth > 1 ? "└ " : ""}{c.id ? <a className={link} href={taskSharePath(c.id, from, to)}
                aria-label={`${translate("mdbd1ade42624")} #${i + 1} ${translate("m2668bc818e5b")}`}>#{i + 1}</a> : `#${i + 1}`}</td>
            <td className="px-2 py-1"><code className="text-[12px]">{c.tool ?? translateSource(MISSING)}</code></td>
            <td className="px-2 py-1 [overflow-wrap:anywhere]">{c.models?.length ? c.models.join(", ") : translateSource(MISSING)}</td>
            <td className="px-2 py-1 whitespace-nowrap">{c.started_at ? formatClientTimestamp(c.started_at) : translateSource(MISSING)}</td>
            <td className="px-2 py-1 text-right tabular-nums">{formatTaskDuration(c.duration_ms)}</td>
            <td className="px-2 py-1 text-right tabular-nums">{observedNumber(c.llm_calls) === null ? translateSource(MISSING) : formatObserved(c.llm_calls)}</td>
            <td className="px-2 py-1 text-right tabular-nums">{cost(c.cost_usd, c.cost_partial)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </> : !parent && <p className="text-[13px] text-ink-500">{translate("mc6dc5f0f3a29")}</p>}
    {unlinked > 0 && <p className="mt-2 text-[12px] text-ink-500">{translate("mdaa24361cf11", [formatObserved(unlinked)])}</p>}
    {limited && <p className="mt-1 text-[12px] text-warning-text">{translate("me9647623a44e")}</p>}
    <p className="mt-2 text-[12px] text-ink-500">{translate("mb94cdf6330f5")}</p>
  </section>;
}
