import { translate, useLocale } from "../i18n/index.js";
import { clientName } from "../clientPresentation.js";
import { SeriesBarChart } from "./GroupCharts.jsx";

export function ClientTokenComposition({ rows, parts, help }) {
  const _locale = useLocale();
  const clients = rows.map(row => {
    // Explicitly unavailable observed parts must not fall back to strict counts.
    const values = Object.hasOwn(row, "observed_token_parts") ? row.observed_token_parts : row;
    const counts = parts.map(part => values?.[part.key]);
    const available = row.observed_records !== 0
      && counts.every(value => Number.isSafeInteger(value) && value >= 0)
      && Number.isSafeInteger(counts.reduce((sum, value) => sum + value, 0));
    return { client: row.client, values, available, partial: available && values.partial === true };
  });
  const available = clients.filter(client => client.available);
  const warnings = clients.filter(client => !client.available || client.partial);
  // A client with no usable cohort cannot erase another client's known chart.
  // If none is available, retain the standard incomplete-chart explanation.
  const chartClients = available.length > 0 ? available : clients;
  return <SeriesBarChart title={translate("md382a04533c1")} help={help}
    subtitle={<>
      <span>{translate("m05a8d473d0d5")}</span>
      {warnings.map(client => <p key={client.client} role={available.length > 0 ? "status" : undefined}
        className="mt-1 text-warning-text">
        <span>{clientName(client.client)}</span>{" · "}
        <span>{translate(client.available ? "ma1a91661679d" : "mdc0c487c9693")}</span>
      </p>)}
    </>}
    rows={chartClients.flatMap(client => parts.map(part => ({
      client: clientName(client.client), part: part.key, value: client.available ? client.values[part.key] : null,
    })))} xKey="client" seriesKey="part" valueKey="value" horizontal
    seriesLabel={key => parts.find(part => part.key === key)?.label ?? key} />;
}
