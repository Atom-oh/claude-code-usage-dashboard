import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { colorFor } from "../colors.js";
import { pivotByGroup, groupsPresent } from "../pivot.js";

const gridProps = { stroke: "var(--grid)" };
const axisProps = { stroke: "var(--axis)", tick: { fill: "var(--text-muted)", fontSize: 12 } };

// 시계열, 그룹별 라인 하나씩 — one axis, fixed categorical color order.
export function GroupLineChart({ rows, xKey, valueKey, height = 260, tickFormatter }) {
  const data = pivotByGroup(rows, xKey, valueKey);
  const groups = groupsPresent(rows);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ left: 8, right: 8 }}>
        <CartesianGrid strokeDasharray="3 3" {...gridProps} vertical={false} />
        <XAxis dataKey={xKey} {...axisProps} tickFormatter={tickFormatter} />
        <YAxis {...axisProps} width={56} />
        <Tooltip
          contentStyle={{ background: "var(--surface-1)", borderColor: "var(--grid)" }}
          labelFormatter={tickFormatter}
        />
        {groups.length > 1 && <Legend />}
        {groups.map((g) => (
          <Line key={g} type="monotone" dataKey={g} name={g} stroke={colorFor(g)} strokeWidth={2} dot={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

// 그룹 간 단일 지표 비교 — 소수 카테고리 막대 비교. colorFn(row)이 없으면 그룹 색상을 그대로 씀
// (accept/reject처럼 "상태"가 카테고리인 경우엔 colorFn으로 status 팔레트를 넘긴다).
export function GroupBarChart({ rows, xKey = "group", valueKey, height = 220, colorFn }) {
  const data = rows || [];
  const fill = colorFn || ((r) => colorFor(r.group));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ left: 8, right: 8 }}>
        <CartesianGrid strokeDasharray="3 3" {...gridProps} vertical={false} />
        <XAxis dataKey={xKey} {...axisProps} />
        <YAxis {...axisProps} width={56} />
        <Tooltip contentStyle={{ background: "var(--surface-1)", borderColor: "var(--grid)" }} />
        <Bar dataKey={valueKey} radius={[4, 4, 0, 0]} maxBarSize={64}>
          {data.map((r, i) => (
            <Cell key={i} fill={fill(r)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
