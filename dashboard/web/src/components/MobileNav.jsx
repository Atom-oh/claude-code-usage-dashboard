import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { Menu, X } from "lucide-react";
import { NAV, NavItem } from "./Sidebar.jsx";

// lg(1024px) 미만에서는 SPA에 내비게이션이 아예 없었다 — Sidebar가 `hidden lg:flex`라
// 모바일/태블릿에서 페이지를 옮길 방법이 주소창 말고 없다. 데스크톱과 같은 NAV·NavItem을
// 그대로 쓴다: 클래스를 복제하면 활성 표시 규칙이 두 벌로 갈라진다.
//
// <nav>는 열려 있을 때만 렌더한다. App.test.jsx는 container.querySelector("nav")로 "첫
// 번째" <nav>를 집어 라우트↔nav 링크 집합을 검사하는데, MobileNav가 Sidebar보다 앞에
// 렌더되므로 닫힌 상태에도 <nav>가 있으면 그 단정문의 대상이 사이드바가 아니라 이 드로어로
// 조용히 바뀐다. 여기서 같은 NAV를 재사용하므로 링크 목록이 동일해 테스트는 그대로 통과한다
// (실측 2026-09-03: open 가드를 지워도 App.test.jsx는 통과) — 즉 실패로 드러나지 않고
// 사이드바 커버리지만 사라진다. 상단 바는 <main> 바깥에 놓는다 — 같은 테스트가 main의
// 자식 수를 2로 고정한다.
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();

  // 경로가 바뀌면 닫는다 — 링크로 이동한 뒤 드로어가 화면을 덮은 채 남지 않게.
  useEffect(() => setOpen(false), [pathname]);

  // Escape 리스너는 열려 있을 때만 붙인다 — 닫힌 상태에서 전역 keydown을 잡고 있을 이유가 없다.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="lg:hidden">
      <div className="flex items-center gap-2.5 border-b border-chrome-border bg-chrome-muted px-4 py-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-brand-500 text-white font-bold text-[15px]">CC</div>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold leading-tight text-chrome-fg">Claude Code</div>
          <div className="text-[10px] text-chrome-fg-muted">A/B Dashboard</div>
        </div>
        <button
          type="button"
          aria-label="메뉴 열기"
          aria-expanded={open}
          aria-controls="mobile-nav"
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 rounded-md p-2 text-chrome-fg-muted hover:bg-ink-100 hover:text-chrome-fg"
        >
          <Menu size={20} strokeWidth={1.7} />
        </button>
      </div>

      {open && (
        <>
          {/* 백드롭/패널 형태는 이 저장소의 기존 슬라이드오버(UserDrawer.jsx)와 같은 규칙 —
              z-40 백드롭 + z-50 패널, 백드롭 클릭으로 닫기. */}
          <div className="fixed inset-0 z-40 bg-black/20" onClick={() => setOpen(false)} />
          <div
            id="mobile-nav"
            className="fixed inset-y-0 left-0 z-50 flex w-64 flex-col overflow-y-auto border-r border-chrome-border bg-chrome-muted px-4 pb-4 pt-[22px] shadow-xl animate-fade-in"
          >
            <div className="mb-5 flex items-center justify-between gap-2">
              <div className="text-[15px] font-semibold leading-tight text-chrome-fg">Claude Code</div>
              <button
                type="button"
                aria-label="메뉴 닫기"
                onClick={() => setOpen(false)}
                className="shrink-0 rounded-md p-1.5 text-chrome-fg-muted hover:bg-ink-100 hover:text-chrome-fg"
              >
                <X size={18} strokeWidth={1.7} />
              </button>
            </div>
            <nav className="flex-1 space-y-0.5">
              {NAV.map((item) => (
                <NavItem key={item.to} {...item} />
              ))}
            </nav>
          </div>
        </>
      )}
    </div>
  );
}
