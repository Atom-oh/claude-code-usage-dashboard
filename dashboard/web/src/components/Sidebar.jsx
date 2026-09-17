import { NavLink, useLocation } from "react-router-dom";
import { LayoutDashboard, Briefcase, LineChart, TrendingUp, Wrench, Users as UsersIcon, DollarSign, Sparkles, ShieldAlert } from "lucide-react";
import { cn } from "../cn.js";
import { CLIENT_LABELS, useClient } from "../ClientContext.jsx";
import { CLIENT_PAGES } from "../clientNavigation.js";

const ICONS = [LayoutDashboard, Briefcase, LineChart, TrendingUp, Wrench, UsersIcon, DollarSign, ShieldAlert, Sparkles];
export const NAV = CLIENT_PAGES.map((page, i) => ({ ...page, icon: ICONS[i] }));
export const COMMON_NAV = NAV;

export function useNavigation() {
  const { common, enabledClients } = useClient();
  return {
    items: NAV,
    brand: enabledClients.length > 1 ? "Claude + Codex" : CLIENT_LABELS[enabledClients[0]],
    subtitle: common ? "통합 사용량 대시보드" : "Claude 상세 분석",
    common,
  };
}

// ../awsops web/components/shell/Sidebar.tsx 포팅 (256px, 고정 nav — 계정/리전 셀렉터 등은 해당 없음).

export function NavItem({ to, label, hint, icon: Icon, exact }) {
  const { search } = useLocation();
  return (
    <NavLink
      to={{ pathname: to, search }}
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
  const { items, brand, subtitle, common } = useNavigation();
  return (
    <aside className="hidden lg:flex h-screen w-64 shrink-0 flex-col overflow-y-auto border-r border-chrome-border bg-chrome-muted px-4 pb-4 pt-[22px]">
      <div className="mb-5 flex items-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-brand-500 text-white font-bold text-[15px]">CC</div>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold leading-tight text-chrome-fg">{brand}</div>
          <div className="text-[10px] text-chrome-fg-muted">{subtitle}</div>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5">
        {items.map((item) => (
          <NavItem key={item.to} {...item} />
        ))}
      </nav>

      <div className="mt-4 border-t border-chrome-border pt-3">
        <div className="flex items-center gap-1.5 px-0.5 text-[11px] text-chrome-fg-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-positive" />
          <span>{common ? "클라이언트별 수집 데이터 기준" : "채널(bedrock / enterprise)은 세션별로 자동 판별"}</span>
        </div>
      </div>
    </aside>
  );
}
