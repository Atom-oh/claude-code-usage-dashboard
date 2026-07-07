import { useMemo, useState } from "react";
import { Card } from "./Card.jsx";
import { colorFor } from "../colors.js";

// ../awsops web/components/ui/DataTable.tsx 포팅 (정렬 가능한 테이블, Card로 감쌈).
function compareValues(a, b, dir) {
  const ea = a == null || a === "";
  const eb = b == null || b === "";
  if (ea && eb) return 0;
  if (ea) return 1;
  if (eb) return -1;
  const cmp = String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  return dir === "asc" ? cmp : -cmp;
}

export function DataTable({ columns, rows, groupKey = "group", title, subtitle, right, onRowClick }) {
  const [sort, setSort] = useState(null);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    return [...rows].sort((ra, rb) => compareValues(ra[sort.key], rb[sort.key], sort.dir));
  }, [rows, sort]);

  const toggleSort = (key) => setSort((prev) => (prev?.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  if (!rows || rows.length === 0) {
    return (
      <Card title={title} subtitle={subtitle} right={right} padded={false}>
        <div className="py-6 px-3 text-center text-[14px] text-ink-400">데이터 없음</div>
      </Card>
    );
  }

  return (
    <Card title={title} subtitle={subtitle} right={right} padded={false}>
      <div className="overflow-x-auto">
        <table className="w-full text-[14px]">
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    onClick={() => toggleSort(c.key)}
                    className={`text-left text-[11px] uppercase tracking-[0.04em] font-medium py-2.5 px-3 border-b border-ink-100 cursor-pointer select-none hover:text-ink-600 ${active ? "text-brand-700" : "text-ink-400"}`}
                  >
                    <span className="inline-flex items-center gap-1">
                      {c.label}
                      <span className="text-[9px] leading-none">{active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((r, i) => (
              <tr
                key={i}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                className={`border-t border-ink-100 hover:bg-ink-50 ${onRowClick ? "cursor-pointer" : ""}`}
              >
                {columns.map((c) => (
                  <td key={c.key} className="py-2.5 px-3 text-ink-800 align-top tabular">
                    {c.key === groupKey ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="inline-block h-2 w-2 rounded-full" style={{ background: colorFor(r[groupKey]) }} />
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
    </Card>
  );
}
