import { colorFor } from "../colors.js";

// 카디널리티가 큰 카테고리(툴/스킬/유저) 비교는 차트보다 표가 낫다 — dataviz choosing-a-form.
export function SimpleTable({ columns, rows, groupKey = "group" }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr style={{ borderBottom: "1px solid var(--grid)" }}>
            {columns.map((c) => (
              <th key={c.key} className="px-2 py-1.5 text-left font-medium" style={{ color: "var(--text-secondary)" }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(rows || []).map((r, i) => (
            <tr key={i} style={{ borderBottom: "1px solid var(--grid)" }}>
              {columns.map((c) => (
                <td key={c.key} className="px-2 py-1.5 tabular-nums" style={{ color: "var(--text-primary)" }}>
                  {c.key === groupKey ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ background: colorFor(r[groupKey]) }}
                      />
                      {r[groupKey]}
                    </span>
                  ) : c.render ? (
                    c.render(r[c.key], r)
                  ) : (
                    r[c.key]
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
