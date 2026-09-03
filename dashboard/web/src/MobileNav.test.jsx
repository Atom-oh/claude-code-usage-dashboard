import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "./App.jsx";

// jsdom에는 ResizeObserver가 없고 recharts의 ResponsiveContainer는 mount effect에서 그걸
// 바로 쓴다 — 스텁이 없으면 렌더가 `ReferenceError: ResizeObserver is not defined`로 죽는다
// (App.test.jsx와 동일한 스텁).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("mobile drawer adds a second nav only while open", async () => {
  // /api/config는 객체, /api/health/data는 status를 가진 객체, 나머지 데이터 라우트는 배열 —
  // App.test.jsx와 동일한 shape(하나로 뭉뚱그리면 렌더 중에 터진다).
  const fetchMock = vi.fn((url) => {
    const u = String(url);
    const body = u.startsWith("/api/config")
      ? { piiMask: true, pricing: { cacheWriteTtl: "1h", overriddenModels: [] }, schema: {} }
      : u.startsWith("/api/health/data")
        ? { status: "ok", latest: null, ageMinutes: 0, staleAfterMinutes: 360 }
        : [];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);

  const { container } = render(
    <MemoryRouter initialEntries={["/"]}>
      <App />
    </MemoryRouter>
  );

  // 이펙트가 플러시될 때까지 기다린다 — 없으면 아래 단정문들이 절반만 마운트된 트리를 본다.
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());

  // Tailwind 클래스는 jsdom에서 아무것도 숨기지 않는다: `lg:hidden`과 `hidden lg:flex`는
  // jsdom에서 비활성이라(레이아웃 엔진이 없어 미디어 쿼리가 평가되지 않는다) 이 테스트는
  // 항상 DOM 존재 여부만 본다, 가시성은 절대 보지 않는다.
  const btn = container.querySelector('[aria-label="메뉴 열기"]');
  expect(container.querySelectorAll("nav").length).toBe(1);
  expect(btn.getAttribute("aria-expanded")).toBe("false");

  fireEvent.click(btn);

  expect(container.querySelectorAll("nav").length).toBe(2);
  expect(btn.getAttribute("aria-expanded")).toBe("true");

  // 두 nav의 링크 목록이 같아야 한다 — 순서 무관 비교. 드로어의 <nav>가 DOM에서 먼저
  // 나온다(MobileNav가 Sidebar보다 앞에 렌더되므로) 이므로 인덱스로 비교해도 되지만,
  // 이 순서는 구현 세부라서 두 목록을 서로 비교하는 형태로 둔다.
  const navs = [...container.querySelectorAll("nav")];
  const hrefsOf = (n) => [...n.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  expect(hrefsOf(navs[0])).toEqual(hrefsOf(navs[1]));

  fireEvent.keyDown(document, { key: "Escape" });

  expect(container.querySelectorAll("nav").length).toBe(1);
  expect(btn.getAttribute("aria-expanded")).toBe("false");
});
