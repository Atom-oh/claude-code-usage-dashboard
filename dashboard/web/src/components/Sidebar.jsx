import { NavLink } from "react-router-dom";
import { LayoutDashboard, Briefcase, LineChart, TrendingUp, Wrench, Users as UsersIcon, DollarSign } from "lucide-react";
import { cn } from "../cn.js";

// ../awsops web/components/shell/Sidebar.tsx 포팅 (256px, 고정 nav — 계정/리전 셀렉터 등은 해당 없음).
const NAV = [
  { to: "/", label: "Overview", hint: "KPI 및 요약", icon: LayoutDashboard, exact: true },
  { to: "/exec", label: "Executive", hint: "경영 보고용 원페이지", icon: Briefcase },
  { to: "/trends", label: "Trends", hint: "DAU / WAU / MAU", icon: LineChart },
  { to: "/productivity", label: "Productivity", hint: "토큰 정규화 생산성", icon: TrendingUp },
  { to: "/usage", label: "Usage", hint: "Tool / MCP / Skill", icon: Wrench },
  { to: "/users", label: "Users", hint: "유저별 생산성", icon: UsersIcon },
  { to: "/cost", label: "Cost", hint: "토큰 · 모델별 비용(근사치)", icon: DollarSign },
];

function NavItem({ to, label, hint, icon: Icon, exact }) {
  return (
    <NavLink
      to={to}
      end={exact}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13px] font-medium no-underline transition-colors duration-[120ms]",
          isActive ? "bg-chrome-active text-chrome-active-fg shadow-sm" : "text-chrome-fg-muted hover:bg-ink-100 hover:text-chrome-fg"
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon size={16} strokeWidth={1.7} className={cn("shrink-0", isActive ? "text-chrome-active-fg" : "text-chrome-fg-muted")} />
          <span className="min-w-0">
            <span className="block truncate">{label}</span>
            <span className={cn("block truncate text-[10px] leading-tight", isActive ? "text-brand-600" : "text-chrome-fg-muted")}>{hint}</span>
          </span>
        </>
      )}
    </NavLink>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden lg:flex h-screen w-64 shrink-0 flex-col overflow-y-auto border-r border-chrome-border bg-chrome-muted px-4 pb-4 pt-[22px]">
      <div className="mb-5 flex items-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-brand-500 text-white font-bold text-[15px]">CC</div>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold leading-tight text-chrome-fg">Claude Code</div>
          <div className="text-[10px] text-chrome-fg-muted">A/B Dashboard</div>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5">
        {NAV.map((item) => (
          <NavItem key={item.to} {...item} />
        ))}
      </nav>

      <div className="mt-4 border-t border-chrome-border pt-3">
        <div className="flex items-center gap-1.5 px-0.5 text-[11px] text-chrome-fg-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-positive" />
          <span>bedrock vs enterprise · 자동 판별</span>
        </div>
      </div>
    </aside>
  );
}
