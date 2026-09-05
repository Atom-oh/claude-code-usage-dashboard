import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "./App.jsx";

// App.jsx의 <Route path>와 Sidebar.jsx의 NAV가 같은 집합인지 보는 스모크 테스트다 —
// 라우트만 추가하고 nav를 빼먹으면(또는 그 반대) 빌드는 통과하고 화면에서만 사라진다.
const PAGES = [
  ["/", "Overview"],
  ["/exec", "Executive"],
  ["/trends", "Trends"],
  ["/productivity", "Productivity"],
  ["/usage", "Usage"],
  ["/users", "Users"],
  ["/cost", "Cost"],
  ["/reliability", "Reliability"],
  ["/analytics", "Analytics"],
];

// jsdom에는 ResizeObserver가 없고 recharts의 ResponsiveContainer는 mount effect에서 그걸
// 바로 쓴다 — 스텁이 없으면 렌더가 `ReferenceError: ResizeObserver is not defined`로 죽는다
// (실측 2026-09-02: recharts/lib/component/ResponsiveContainer.js). 이 테스트에서 가장
// 지우기 쉬운 줄이면서 지우면 바로 깨지는 줄이다.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("every App route has a matching sidebar nav link", async () => {
  // /api/config는 객체, /api/health/data는 status를 가진 객체, 나머지 데이터 라우트는 배열 —
  // 소비자들이 기대하는 shape가 다르므로 하나로 뭉뚱그리면 렌더 중에 터진다.
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

  // nav 안으로 한정해 조회한다 — 페이지 본문에도 "Overview" 같은 제목이 있어서
  // screen.getByText("Overview")는 복수 매치로 실패한다(실측).
  const nav = container.querySelector("nav");
  expect(nav).not.toBeNull();
  const hrefs = [...nav.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  expect(hrefs).toEqual(PAGES.map(([to]) => to));

  for (const [to, label] of PAGES) {
    // 링크 텍스트는 label + hint가 이어져 나오므로(Sidebar.jsx의 NavItem) startsWith로 본다.
    expect(nav.querySelector(`a[href="${to}"]`).textContent.startsWith(label)).toBe(true);
  }

  // 렌더만 되는 게 아니라 실제로 API를 호출하는 데까지 갔는지 — 이펙트가 돌지 않으면
  // 위 단정문들은 정적인 nav만 확인하고 끝난다(실측: / 에서 8건 호출).
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());

  // 위 단정문들은 Sidebar의 NAV만 핀다 — App.jsx에서 <Route>만 지우면 nav 링크는 그대로
  // 남아 통과한다(실측: 뮤테이션 생존). 그래서 각 경로로 실제 렌더해 <Routes>가 매칭됐는지
  // 본다. main의 자식은 FilterBar 컨테이너 + 매칭된 라우트 = 2개이고, 매칭이 없으면
  // <Routes>가 아무것도 렌더하지 않아 1개가 된다(실측 2026-09-03).
  for (const [to] of PAGES) {
    cleanup();
    const { container: c } = render(
      <MemoryRouter initialEntries={[to]}>
        <App />
      </MemoryRouter>
    );
    expect(c.querySelector("main").children.length).toBe(2);
  }
});
