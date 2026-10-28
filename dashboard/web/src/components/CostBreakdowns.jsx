import { Card, ErrorBox, Loading } from "./Card.jsx";
import { DonutBody } from "./GroupCharts.jsx";
import EmptyState from "./EmptyState.jsx";
import { CLIENT_LABELS } from "../ClientContext.jsx";
import { basisLabel, observedNumber, presentationRow } from "../clientPresentation.js";
import { formatClientCost, formatObserved } from "../clientUsage.js";
import { modelColorFor } from "../colors.js";
import { sumKnownSpend } from "../spend.js";

// Keep a card's question visible while its independently requested answer changes.
export function CostBreakdownCard({ loading, error, empty, children, ...props }) {
  return <Card {...props}>
    {error ? <ErrorBox error={error} /> : loading ? <Loading /> : empty ? <EmptyState /> : children}
  </Card>;
}

function CostShare({ rows, colorOf }) {
  const values = rows.map((row) => ({ ...row, cost_usd: observedNumber(row.cost_usd),
    cost_partial: row.cost_partial === true || observedNumber(row.unpriced) > 0 }));
  const { total, partial } = sumKnownSpend(values, "cost_usd");
  const known = values.filter((row) => row.cost_usd !== null);
  const unknown = values.filter((row) => row.cost_usd === null);
  const hasUnpriced = values.some((row) => observedNumber(row.unpriced) > 0);
  const bases = [...new Set(values.map((row) => basisLabel(row.cost_basis)))];
  return <>
    <p className="mb-3 text-[12px] text-ink-500">
      {bases.join(" + ")}{total === null ? " · 비용 미산정" : partial ? " · 알려진 비용 부분합" : " · 알려진 비용"}
      {hasUnpriced && " · 미산정 범위 포함"}
    </p>
    {total === null ? <p className="text-sm text-ink-500">— · 비용 미산정</p>
      : total === 0 ? <p className="tabular text-sm text-ink-600">{formatClientCost(0)}</p>
        : <DonutBody data={known} nameKey="label" valueKey="cost_usd"
          valueFormatter={formatClientCost} colorOf={colorOf} />}
    {unknown.length > 0 && <ul className="mt-3 text-[12px] text-ink-500">
      {unknown.map((row, index) => <li key={index}>{row.label}: — · 미산정</li>)}
    </ul>}
  </>;
}

function InputCache({ row }) {
  const canonical = presentationRow(row);
  const values = [canonical.input_tokens, canonical.cache_read_tokens, canonical.cache_write_tokens];
  if (values.some((value) => value === null) || !Number.isSafeInteger(canonical.input_total)) {
    return <p className="text-sm text-ink-500">— · 입력·캐시 구성 미확인</p>;
  }
  const data = ["비캐시 입력", "캐시 읽기", "캐시 쓰기"].map((label, index) => ({
    label, tokens: values[index],
  }));
  return canonical.input_total === 0 ? <p className="tabular text-sm text-ink-600">0 토큰 · 전체 입력</p>
    : <DonutBody data={data} nameKey="label" valueKey="tokens" valueFormatter={formatObserved} />;
}

const backendLabel = (backend) => backend === "unknown" ? "백엔드 미제공" : backend;
const modelLabel = (row) => [row.model || "(모델 미지정)", backendLabel(row.backend) || "백엔드 미제공"].join(" · ");
const effortLabel = (row) => [!row.effort || row.effort === "unknown" ? "미지정" : row.effort,
  backendLabel(row.backend)].filter(Boolean).join(" · ");
const withBasis = (rows, label, fallback) => {
  const bases = new Set(rows.map((row) => row.cost_basis || fallback));
  return rows.map((row) => ({ ...row, cost_basis: row.cost_basis || fallback,
    label: `${label(row)}${bases.size > 1 ? ` · ${basisLabel(row.cost_basis || fallback)}` : ""}` }));
};

export default function CostBreakdowns({ clients, data, loading, error, empty, claudeEffort, codexEffort }) {
  const suffix = (title, client) => `${title}${clients.length > 1 ? ` — ${CLIENT_LABELS[client]}` : ""}`;
  return <section aria-label="비용 구성" className="flex flex-col gap-4">
    {clients.map((client) => {
      const row = (data?.by_client || []).find((source) => source.client === client);
      const clientEmpty = empty || row?.observed_records === 0;
      const modelRows = withBasis((data?.by_model || []).filter((source) => source.client === client), modelLabel);
      const effortApi = client === "claude" ? claudeEffort : codexEffort;
      const effortRows = withBasis(effortApi?.data?.effort || [], effortLabel, client === "codex" ? "aws_list_estimate" : undefined);
      return <div key={client} className="grid items-start gap-4 xl:grid-cols-3">
        <CostBreakdownCard title={suffix("모델별 비용 비중", client)}
          subtitle="모델 버전·백엔드별 알려진 비용 · 실청구와 다를 수 있습니다."
          loading={loading} error={error} empty={clientEmpty || modelRows.length === 0}>
          <CostShare rows={modelRows} colorOf={(label, _index, theme) =>
            modelColorFor(modelRows.find((source) => source.label === label)?.model, theme)} />
        </CostBreakdownCard>
        <CostBreakdownCard title={suffix("Effort별 비용 비중", client)}
          subtitle={client === "claude"
            ? "보고·재산정 비용 카운터 기준 · 토큰 계산으로 채운 비용은 제외합니다."
            : "기록된 완료 응답의 AWS 정가 추정 · 실청구와 다를 수 있습니다."}
          loading={loading || effortApi?.loading} error={error || effortApi?.error}
          empty={clientEmpty || effortRows.length === 0}>
          <CostShare rows={effortRows} />
        </CostBreakdownCard>
        <CostBreakdownCard title={suffix("입력·캐시 구성", client)}
          subtitle="전체 입력 = 비캐시 입력 + 캐시 읽기 + 캐시 쓰기 · 출력·추론은 별도입니다."
          loading={loading} error={error} empty={clientEmpty || !row}>
          <InputCache row={row} />
        </CostBreakdownCard>
      </div>;
    })}
  </section>;
}
