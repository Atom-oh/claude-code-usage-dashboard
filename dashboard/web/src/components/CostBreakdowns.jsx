import { richMessage, translate, useLocale } from "../i18n/index.js";
import { Card, ErrorBox, Loading } from "./Card.jsx";
import { DonutBody } from "./GroupCharts.jsx";
import EmptyState from "./EmptyState.jsx";
import { CLIENT_LABELS } from "../ClientContext.jsx";
import { basisLabel, observedNumber, presentationRow } from "../clientPresentation.js";
import { formatClientCost, formatObserved } from "../clientUsage.js";
import { modelColorFor } from "../colors.js";
import { sumKnownSpend } from "../spend.js";

// Keep a card's question visible while its independently requested answer changes.
export function CostBreakdownCard({ loading, error, limited, empty, children, ...props }) {
  const _locale = useLocale();
  return <Card {...props}>
    {error ? <ErrorBox error={error} /> : loading ? <Loading /> : limited
      ? <p role="status" className="text-sm text-warning-text">{translate("m42062d2e94c2")}</p>
      : empty ? <EmptyState /> : children}
  </Card>;
}

function CostShare({ rows, colorOf, legendRenderer }) {
  const _locale = useLocale();
  const values = rows.map((row) => ({ ...row, cost_usd: observedNumber(row.cost_usd),
    cost_partial: row.cost_partial === true || observedNumber(row.unpriced) > 0 }));
  const { total, partial } = sumKnownSpend(values, "cost_usd");
  const known = values.filter((row) => row.cost_usd !== null);
  const unknown = values.filter((row) => row.cost_usd === null);
  const hasUnpriced = values.some((row) => observedNumber(row.unpriced) > 0);
  const bases = [...new Set(values.map((row) => basisLabel(row.cost_basis)))];
  return <>
    <p className="mb-3 text-[12px] text-ink-500">
      {bases.join(" + ")}{total === null ? translate("m698b5f402f04") : partial ? translate("m2457ff7a0742") : translate("m2a587ed86114")}
      {hasUnpriced && translate("m8ed224a1744e")}
    </p>
    {total === null ? <p className="text-sm text-ink-500">{translate("me4559fce2ced")}</p>
      : total === 0 ? <p className="tabular text-sm text-ink-600">{formatClientCost(0)}</p>
        : <DonutBody data={known} nameKey="label" valueKey="cost_usd"
          valueFormatter={formatClientCost} colorOf={colorOf} legendRenderer={legendRenderer} />}
    {unknown.length > 0 && <ul className="mt-3 text-[12px] text-ink-500">
      {unknown.map((row, index) => <li key={index}>{richMessage("m257b66b36f29", [row.label])}</li>)}
    </ul>}
  </>;
}

function InputCache({ row }) {
  const _locale = useLocale();
  const canonical = presentationRow(row);
  const values = [canonical.input_tokens, canonical.cache_read_tokens, canonical.cache_write_tokens];
  if (values.some((value) => value === null) || !Number.isSafeInteger(canonical.input_total)) {
    return <p className="text-sm text-ink-500">{translate("mf3d03b2bd003")}</p>;
  }
  const data = [translate("mc43da268406e"), translate("m12be3da02b6d"), translate("m1be0e1388dc5")].map((label, index) => ({
    label, tokens: values[index],
  }));
  return canonical.input_total === 0 ? <p className="tabular text-sm text-ink-600">{translate("m54962e7598d5")}</p>
    : <DonutBody data={data} nameKey="label" valueKey="tokens" valueFormatter={formatObserved} />;
}

const backendLabel = (backend) => backend === "unknown" ? translate("mf3637bf5089f") : backend;
const modelLabel = (row) => [row.model || translate("m5ac69470a0da"), backendLabel(row.backend) || translate("mf3637bf5089f")].join(" · ");
const modelLegend = (row) => <>
  <span className="block truncate" title={row.model || translate("m5ac69470a0da")}>
    {row.model || translate("m5ac69470a0da")}
  </span>
  <span className="block break-words text-[11px] text-ink-500">
    {backendLabel(row.backend) || translate("mf3637bf5089f")}{row.basis_label && ` · ${row.basis_label}`}
  </span>
</>;
const effortLabel = (row) => [!row.effort || row.effort === "unknown" ? translate("m050d981c6c43") : row.effort,
  backendLabel(row.backend)].filter(Boolean).join(" · ");
const withBasis = (rows, label, fallback) => {
  const bases = new Set(rows.map((row) => row.cost_basis || fallback));
  return rows.map((row) => ({ ...row, cost_basis: row.cost_basis || fallback,
    basis_label: bases.size > 1 ? basisLabel(row.cost_basis || fallback) : null,
    label: `${label(row)}${bases.size > 1 ? ` · ${basisLabel(row.cost_basis || fallback)}` : ""}` }));
};

export default function CostBreakdowns({ clients, data, loading, error, empty, claudeEffort, codexEffort }) {
  const _locale = useLocale();
  const suffix = (title, client) => `${title}${clients.length > 1 ? ` — ${CLIENT_LABELS[client]}` : ""}`;
  return <section aria-label={translate("m43ec4fd210c9")} className="flex flex-col gap-4">
    {clients.map((client) => {
      const row = (data?.by_client || []).find((source) => source.client === client);
      const clientEmpty = empty || row?.observed_records === 0;
      const modelRows = withBasis((data?.by_model || []).filter((source) => source.client === client), modelLabel);
      const effortApi = client === "claude" ? claudeEffort : codexEffort;
      const effortRows = withBasis(effortApi?.data?.effort || [], effortLabel, client === "codex" ? "aws_list_estimate" : undefined);
      const effortCoverage = effortApi?.data?.coverage?.logs;
      const effortLimited = client === "codex" && (effortCoverage?.status === "limited"
        || effortCoverage?.limited_sections?.includes("effort"));
      return <div key={client} className="grid items-start gap-4 xl:grid-cols-3">
        <CostBreakdownCard title={suffix(translate("m05e49b4b2c5c"), client)}
          subtitle={translate("m5854aaf94ba8")}
          loading={loading} error={error} empty={clientEmpty || modelRows.length === 0}>
          <CostShare rows={modelRows} legendRenderer={modelLegend} colorOf={(label, _index, theme) =>
            modelColorFor(modelRows.find((source) => source.label === label)?.model, theme)} />
        </CostBreakdownCard>
        <CostBreakdownCard title={suffix(translate("m8e1da84ed3c8"), client)}
          subtitle={client === "claude"
            ? translate("m7420c81ac222")
            : translate("mfcca8ae98e08")}
          loading={loading || effortApi?.loading} error={error || effortApi?.error}
          limited={effortLimited} empty={effortRows.length === 0}>
          <CostShare rows={effortRows} />
        </CostBreakdownCard>
        <CostBreakdownCard title={suffix(translate("mab19f4bdf408"), client)}
          subtitle={translate("m6f54b5fd03b9")}
          loading={loading} error={error} empty={clientEmpty || !row}>
          <InputCache row={row} />
        </CostBreakdownCard>
      </div>;
    })}
  </section>;
}
