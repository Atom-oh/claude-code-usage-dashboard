export function Card({ title, children, className = "" }) {
  return (
    <div
      className={`rounded-lg border p-4 ${className}`}
      style={{ background: "var(--surface-1)", borderColor: "var(--grid)" }}
    >
      {title && (
        <h3 className="mb-3 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
          {title}
        </h3>
      )}
      {children}
    </div>
  );
}

export function KpiTile({ label, value, sub }) {
  return (
    <div className="flex-1 min-w-[140px]">
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>
        {label}
      </div>
      <div className="text-2xl font-semibold tabular-nums" style={{ color: "var(--text-primary)" }}>
        {value}
      </div>
      {sub && (
        <div className="text-xs" style={{ color: "var(--text-secondary)" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

export function Loading() {
  return <div style={{ color: "var(--text-muted)" }}>불러오는 중...</div>;
}

export function ErrorBox({ error }) {
  return (
    <div className="text-sm" style={{ color: "var(--status-critical)" }}>
      오류: {error.message}
    </div>
  );
}
