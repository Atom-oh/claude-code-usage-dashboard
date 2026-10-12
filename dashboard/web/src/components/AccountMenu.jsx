import { LogOut, UserRound } from "lucide-react";
import { useConfig } from "../ConfigContext.jsx";
import { maskEmail } from "../fmt.js";

const ROLE_LABELS = { viewer: "조회", analyst: "분석", admin: "관리자" };

export function AccountMenu() {
  const { session } = useConfig();
  if (session?.mode !== "oidc") return null;
  return (
    <section aria-label="내 계정" className="mt-3 rounded-md border border-chrome-border bg-white p-3">
      <div className="flex items-center gap-2 text-[13px] text-chrome-fg">
        <UserRound aria-hidden="true" size={16} className="shrink-0" />
        <span className="min-w-0 flex-1 break-words">{maskEmail(session.name || "조직 사용자")}</span>
        <span className="shrink-0 rounded bg-ink-100 px-1.5 py-0.5 text-xs">{ROLE_LABELS[session.role] || "조회"}</span>
      </div>
      <form action="/auth/logout" method="post" className="mt-2">
        <button type="submit" className="flex w-full items-center justify-center gap-2 rounded-md px-2 py-1.5 text-xs text-ink-600 hover:bg-ink-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600">
          <LogOut aria-hidden="true" size={14} />로그아웃
        </button>
      </form>
    </section>
  );
}
