import { Card, KpiTile, Loading, ErrorBox } from "../components/Card.jsx";
import { GroupLineChart, GroupBarChart } from "../components/GroupCharts.jsx";
import { SimpleTable } from "../components/SimpleTable.jsx";
import { useApi } from "../useApi.js";

const fmtTick = (t) => new Date(t).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
const fmt = (n) => Number(n || 0).toLocaleString();

export default function Overview() {
  const kpi = useApi("/api/overview/kpi");
  const tokens = useApi("/api/overview/tokens-timeseries");
  const cache = useApi("/api/overview/cache-efficiency");
  const models = useApi("/api/overview/model-distribution");

  return (
    <div className="grid gap-4">
      <Card title="그룹별 KPI 요약">
        {kpi.loading ? (
          <Loading />
        ) : kpi.error ? (
          <ErrorBox error={kpi.error} />
        ) : (
          <SimpleTable
            columns={[
              { key: "group", label: "그룹" },
              { key: "users", label: "유저", render: fmt },
              { key: "sessions", label: "세션", render: fmt },
              { key: "commits", label: "커밋", render: fmt },
              { key: "prs", label: "PR", render: fmt },
              { key: "total_tokens", label: "토큰", render: fmt },
              { key: "lines_of_code", label: "추가 라인", render: fmt },
            ]}
            rows={kpi.data}
          />
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="토큰 사용량 시계열">
          {tokens.loading ? <Loading /> : tokens.error ? <ErrorBox error={tokens.error} /> : (
            <GroupLineChart rows={tokens.data} xKey="t" valueKey="tokens" tickFormatter={fmtTick} />
          )}
        </Card>
        <Card title="캐시 재사용률 (cacheRead / (input+cacheRead))">
          {cache.loading ? <Loading /> : cache.error ? <ErrorBox error={cache.error} /> : (
            <GroupBarChart rows={cache.data} valueKey="cache_read_ratio" />
          )}
        </Card>
      </div>

      <Card title="모델별 토큰 분포 (그룹 간 모델 차이 = 교란 요인 점검용)">
        {models.loading ? (
          <Loading />
        ) : models.error ? (
          <ErrorBox error={models.error} />
        ) : (
          <SimpleTable
            columns={[
              { key: "group", label: "그룹" },
              { key: "model", label: "모델" },
              { key: "tokens", label: "토큰", render: fmt },
            ]}
            rows={models.data}
          />
        )}
      </Card>
    </div>
  );
}
