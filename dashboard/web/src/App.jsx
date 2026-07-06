import { NavLink, Route, Routes } from "react-router-dom";
import { RangeProvider, useRange } from "./RangeContext.jsx";
import Overview from "./pages/Overview.jsx";
import Productivity from "./pages/Productivity.jsx";
import Usage from "./pages/Usage.jsx";
import Users from "./pages/Users.jsx";

const TABS = [
  { to: "/", label: "Overview", exact: true },
  { to: "/productivity", label: "Productivity" },
  { to: "/usage", label: "Usage" },
  { to: "/users", label: "Users" },
];

function linkClass({ isActive }) {
  return `px-3 py-1.5 rounded-md text-sm font-medium ${isActive ? "" : ""}`;
}

function RangePicker() {
  const { days, setDays } = useRange();
  return (
    <div className="flex gap-1">
      {[7, 14, 30].map((d) => (
        <button
          key={d}
          onClick={() => setDays(d)}
          className="rounded-md px-2.5 py-1 text-xs font-medium"
          style={{
            background: d === days ? "var(--series-bedrock)" : "transparent",
            color: d === days ? "#fff" : "var(--text-secondary)",
            border: "1px solid var(--grid)",
          }}
        >
          {d}일
        </button>
      ))}
    </div>
  );
}

export default function App() {
  return (
    <RangeProvider>
      <div className="mx-auto max-w-6xl px-4 py-6">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">Claude Code A/B Dashboard</h1>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              bedrock vs enterprise — 텔레메트리 기반 그룹 자동 판별
            </p>
          </div>
          <RangePicker />
        </header>

        <nav className="mb-6 flex gap-1 border-b pb-px" style={{ borderColor: "var(--grid)" }}>
          {TABS.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.exact}
              className={linkClass}
              style={({ isActive }) => ({
                color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                borderBottom: isActive ? "2px solid var(--series-bedrock)" : "2px solid transparent",
              })}
            >
              {t.label}
            </NavLink>
          ))}
        </nav>

        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/productivity" element={<Productivity />} />
          <Route path="/usage" element={<Usage />} />
          <Route path="/users" element={<Users />} />
        </Routes>
      </div>
    </RangeProvider>
  );
}
