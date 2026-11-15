import { translate, translateSource, useLocale } from "../i18n/index.js";
// What one Codex turn used (/api/users/tasks/detail `activity`): its skill invocations
// (codex.skill_invocation logs of that turn) and its tool calls by tool name, MCP tools
// marked. An empty list is "none recorded", not "none used": older Codex versions or a
// collector without these events record nothing.
import { Badge } from "./Badge.jsx";
import { formatObserved } from "../clientUsage.js";
import { formatTaskDuration } from "./TaskList.jsx";

const MISSING = "미수집";
const SKILL_LIMIT = 50;

function duration(t) {
  if (t.duration_ms === null || t.duration_ms === undefined) return translateSource(MISSING);
  return `${formatTaskDuration(t.duration_ms)}${t.duration_partial ? translate("m830e860c2bd2") : ""}`;
}

export function TaskCodexActivity({ activity }) {
  const _locale = useLocale();
  if (!activity) return null;
  const { skills = [], skills_limited: skillsLimited, tools = [], tools_partial: toolsPartial } = activity;
  const th = "px-2 py-1 font-medium";
  return <section aria-label={translate("m11cf787f3c11")} className="rounded-lg border border-ink-100 p-4">
    <h3 className="mb-2 text-[14px] font-semibold text-ink-800">{translate("m11cf787f3c11")}</h3>
    <h4 className="mb-1 text-[12px] font-semibold text-ink-600">{translate("m2a84c94ce347")}</h4>
    {skills.length ? <ul aria-label={translate("m2a84c94ce347")} className="flex flex-col gap-1 text-[13px] text-ink-700">
      {skills.map((s, i) => <li key={`${s.name}|${s.invocation}|${s.scope}|${i}`} className="[overflow-wrap:anywhere]">
        {translate("m734e27062552", [s.name ?? translateSource(MISSING),
          s.invocation === "explicit" ? translate("m4268a8e02583") : s.invocation === "implicit" ? translate("m67e7ba0fc025")
            : translateSource(MISSING), formatObserved(s.calls)])}</li>)}
    </ul> : <p className="text-[13px] text-ink-500">{translate("mb57872ccd2ff")}</p>}
    {skillsLimited && <p className="mt-1 text-[12px] text-warning-text">{translate("mbb40fe15a913", [SKILL_LIMIT])}</p>}
    <h4 className="mb-1 mt-3 text-[12px] font-semibold text-ink-600">{translate("me23e8af4e2e7")}</h4>
    {tools.length ? <div className="overflow-x-auto">
      <table className="w-full text-[13px] text-ink-700">
        <thead><tr className="text-left text-[12px] text-ink-500">
          <th className={th}>{translate("m36c416ead2ce")}</th>
          <th className={`${th} text-right`}>{translate("m7ed9c4cb0ba9")}</th>
          <th className={`${th} text-right`}>{translate("m07cdad7a7167")}</th>
        </tr></thead>
        <tbody>{tools.map((t) => <tr key={t.name} className="border-t border-ink-100">
          <td className="px-2 py-1 [overflow-wrap:anywhere]">
            <code className="text-[12px]">{t.name}</code>
            {t.mcp && <Badge tone="brand" className="ml-1 text-[11px]">MCP</Badge>}
            {t.aborted > 0 && <span className="ml-1 text-[12px] text-warning-text">{translate("me1a23d5c2d10", [formatObserved(t.aborted)])}</span>}
          </td>
          <td className="px-2 py-1 text-right tabular-nums">{formatObserved(t.calls)}</td>
          <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">{duration(t)}</td>
        </tr>)}</tbody>
      </table>
    </div> : <p className="text-[13px] text-ink-500">{translate("m4da09def7978")}</p>}
    {toolsPartial && <p className="mt-1 text-[12px] text-warning-text">{translate("m24e46b503f01")}</p>}
    <p className="mt-2 text-[12px] text-ink-500">{translate("ma26970acc182")}</p>
  </section>;
}
