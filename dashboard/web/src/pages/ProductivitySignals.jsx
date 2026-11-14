import { localeTag, localize, translate, useLocale } from "../i18n/index.js";
import { Card, ErrorBox, Loading } from "../components/Card.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { useApi } from "../useApi.js";

const number = (value) => value == null ? "—" : Number(value).toLocaleString(localeTag(), { maximumFractionDigits: 2 });
const percent = (value) => value == null ? "—" : `${(Number(value) * 100).toFixed(1)}%`;
const count = (key, label) => ({ key, label, render: number });
const ratio = (key, label) => ({ key, label, render: percent, toText: percent });
const CHANNEL = localize({ key: "group", label: "채널" });

function SignalTable({ response, title, subtitle, help, columns, exportName }) {
  const _locale = useLocale();
  if (response.loading) return <Loading />;
  if (response.error) return <ErrorBox error={response.error} />;
  if (response.data?.limited) {
    return <Card title={title}><p role="status" className="text-sm text-ink-600">{translate("m062a814bc556")}</p></Card>;
  }
  return <DataTable title={title}
    subtitle={response.data?.unsupported ? translate("mff58a9a8bbd3") : subtitle}
    help={help} columns={columns} rows={Array.isArray(response.data) ? response.data : response.data?.rows || []}
    exportName={exportName} stale={response.stale} />;
}

export function OutcomeMetricsNotice() {
  const _locale = useLocale();
  return <Card title={translate("m106e9c0450f6")}>
    <p className="text-sm text-ink-600">{translate("m53bdc0431899")}</p>
  </Card>;
}

export default function ProductivitySignals() {
  const _locale = useLocale();
  const density = useApi("/api/productivity/activity-density");
  const outcomes = useApi("/api/productivity/tool-outcomes");
  const occupancy = useApi("/api/productivity/permission-occupancy");
  return <section aria-label={translate("m5eddf39901f2")} className="flex min-w-0 flex-col gap-4 [&_th]:whitespace-nowrap [&_td]:whitespace-nowrap">
    <p className="text-sm text-ink-600">{translate("me5adfdc64c4c")}</p>
    <SignalTable response={density} title={translate("me4051fc01846")}
      subtitle={translate("m48b96031cb2a")}
      help={translate("mf7a11667fabe")}
      columns={[CHANNEL, count("commits_per_user_hour", translate("m64181848aa76")),
        count("matched_commits", translate("m293e85802e34")), count("user_hours", translate("m2ac4c41dee11")),
        count("matched_scopes", translate("me713563324fb")), count("observed_scopes", translate("mc6e7a8f342a7")), ratio("coverage", translate("mfb7f5f6eba5c"))]}
      exportName="activity_density" />
    <SignalTable response={occupancy} title={translate("ma65e75f5c83c")}
      subtitle={translate("m68f1ecba1764")}
      help={translate("m7e526969d146")}
      columns={[CHANNEL, ratio("blocked_share", translate("m49f9fd482493")),
        count("blocked_ms", translate("m0ec4be8a5eed")), count("interaction_ms", translate("m8e1cff229d97")),
        count("matched_interactions", translate("ma1a22fede54c")), count("interactions", translate("mc50821f76e3a")),
        count("ambiguous_interactions", translate("m837719783d45")), ratio("coverage", translate("mfba5f6c5e3e0"))]}
      exportName="permission_occupancy" />
    <SignalTable response={outcomes} title={translate("m1b92bf7d38c5")}
      subtitle={translate("m00c31e1cef65")}
      help={translate("m8505bb22abb7")}
      columns={[CHANNEL, ratio("success_rate", translate("m2738ed40c03d")), count("succeeded", translate("mb4f76a33b89b")),
        count("failed", translate("m2743911f83e1")), count("unknown", translate("m7dbf532ffe7a")), count("total", translate("m81c5469e58f0")), ratio("unknown_rate", translate("mb8c4b0f3572a"))]}
      exportName="tool_outcomes" />
    <OutcomeMetricsNotice />
  </section>;
}
