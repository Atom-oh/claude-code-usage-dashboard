import { useMemo, useState } from "react";
import { Card } from "./Card.jsx";
import { colorFor } from "../colors.js";
import EmptyState from "./EmptyState.jsx";
import { Download } from "lucide-react";
import { useRange } from "../RangeContext.jsx";
import { useConfig } from "../ConfigContext.jsx";
import { toCsv, csvFilename, downloadCsv } from "../csv.js";

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

export function DataTable({ columns, rows, groupKey = "group", title, subtitle, right, onRowClick, exportName }) {
  const [sort, setSort] = useState(null);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    return [...rows].sort((ra, rb) => compareValues(ra[sort.key], rb[sort.key], sort.dir));
  }, [rows, sort]);

  const toggleSort = (key) => setSort((prev) => (prev?.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  const range = useRange();
  const { piiMask } = useConfig();

  // exportName이 없으면 버튼도 없다(opt-in) — 내보낼 이름이 없는 표는 CSV도 없다.
  // 기존 right 슬롯을 덮지 않고 감싼다: 이 슬롯을 이미 쓰는 호출자가 있다(Cost.jsx의
  // "unknown 그룹 포함" 체크박스). 클래스는 RangePicker의 확대 해제 버튼과 같은 규격.
  // 내보내는 건 sortedRows다 — 헤더 클릭으로 정렬한 순서가 곧 화면이다.
  const rightWithExport = exportName ? (
    <div className="flex items-center gap-2">
      {right}
      <button
        type="button"
        disabled={!rows || rows.length === 0}
        onClick={() => downloadCsv(csvFilename(exportName, range?.from, range?.to), toCsv(columns, sortedRows, { piiMask }))}
        className="flex items-center gap-1 rounded-md bg-brand-50 px-2 py-1 text-[11px] font-medium text-brand-700 whitespace-nowrap hover:bg-brand-100 disabled:cursor-not-allowed disabled:opacity-40"
        title="현재 표를 CSV로 내려받기"
      >
        <Download size={12} />
        CSV
      </button>
    </div>
  ) : (
    right
  );

  if (!rows || rows.length === 0) {
    return (
      <Card title={title} subtitle={subtitle} right={rightWithExport} padded={false}>
        <EmptyState className="m-3" />
      </Card>
    );
  }

  return (
    <Card title={title} subtitle={subtitle} right={rightWithExport} padded={false}>
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
