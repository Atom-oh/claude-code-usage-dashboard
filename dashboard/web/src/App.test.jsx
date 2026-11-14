import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "./App.jsx";
import { ConfigProvider } from "./ConfigContext.jsx";

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

test("OIDC viewer cannot see SQL chat while analyst and admin retain it", async () => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("fetch", vi.fn(url => Promise.resolve({ ok: true, status: 200,
    json: () => Promise.resolve(String(url).startsWith("/api/health/data")
      ? { status: "ok", ageMinutes: 0, staleAfterMinutes: 360 } : []) })));
  for (const role of ["viewer", "analyst", "admin"]) {
    cleanup();
    const session = { mode: "oidc", name: "Fixture", role,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      permissions: role === "viewer" ? ["telemetry:read"] : ["telemetry:read", "chat:query"] };
    render(<MemoryRouter initialEntries={["/analytics?client=claude&view=detail"]}>
      <ConfigProvider config={{ enabledClients: ["claude"], session }}><App /></ConfigProvider>
    </MemoryRouter>);
    expect(!!screen.queryByRole("button", { name: "Ask Claude" })).toBe(role !== "viewer");
    if (role === "viewer") expect(screen.getByText(/SQL 채팅은 분석 또는 관리자 역할/)).toBeTruthy();
  }
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
    <MemoryRouter initialEntries={["/?client=claude&view=detail"]}>
      <App />
    </MemoryRouter>
  );

  // nav 안으로 한정해 조회한다 — 페이지 본문에도 "Overview" 같은 제목이 있어서
  // screen.getByText("Overview")는 복수 매치로 실패한다(실측).
  const nav = container.querySelector("nav");
  expect(nav).not.toBeNull();
  const hrefs = [...nav.querySelectorAll("a")].map((a) => new URL(a.href).pathname);
  expect(hrefs).toEqual(PAGES.map(([to]) => to));

  for (const [to, label] of PAGES) {
    // 링크 텍스트는 label + hint가 이어져 나오므로(Sidebar.jsx의 NavItem) startsWith로 본다.
    expect([...nav.querySelectorAll("a")].find((a) => new URL(a.href).pathname === to).textContent.startsWith(label)).toBe(true);
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
      <MemoryRouter initialEntries={[`${to}?client=claude&view=detail`]}>
        <App />
      </MemoryRouter>
    );
    expect(c.querySelector("main").children.length).toBe(2);
  }
});

test("direct collector route denies viewers and gives analysts and admins a dedicated setup page", async () => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  const fetch = vi.fn(url => Promise.resolve({ ok: true, status: 200, json: async () =>
    String(url).startsWith("/api/collector/devices") ? { devices: [], nextCursor: null }
      : String(url).startsWith("/api/collector") ? { enabled: true, endpoint: "https://collector.example/api/ingest",
        installScriptUrl: "https://collector.example/api/ingest/install.sh", tokenLifetimeDays: 30, collectorVersion: "0.163.1", platforms: ["linux", "darwin"] }
        : String(url).startsWith("/api/health/data") ? { status: "ok" } : [] }));
  vi.stubGlobal("fetch", fetch);
  for (const role of ["viewer", "analyst", "admin"]) {
    cleanup();
    fetch.mockClear();
    const session = { mode: "oidc", role, expiresAt: new Date(Date.now() + 900000).toISOString(),
      permissions: role === "viewer" ? ["telemetry:read"] : ["telemetry:read", "chat:query", "collector:manage"] };
    const { container } = render(<MemoryRouter initialEntries={["/collector?days=7&model=fixture"]}>
      <ConfigProvider config={{ enabledClients: ["claude", "codex"], session }}><App /></ConfigProvider>
    </MemoryRouter>);
    expect(screen.getByRole("heading", { level: 1, name: "수집기 설치" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ask Claude" })).toBeNull();
    const links = [...container.querySelector("nav").querySelectorAll("a")];
    expect(links.some(link => new URL(link.href).pathname === "/collector")).toBe(role !== "viewer");
    if (role === "viewer") {
      expect(screen.getByRole("alert").textContent).toContain("권한");
      expect(fetch.mock.calls.some(([url]) => String(url).includes("/api/collector"))).toBe(false);
    } else {
      await screen.findByRole("button", { name: "기기 등록 및 토큰 발급" });
      const requests = fetch.mock.calls.filter(([url]) => String(url).includes("/api/collector"));
      expect(requests.every(([url]) => !String(url).includes("days=") && !String(url).includes("model="))).toBe(true);
    }
  }
});

test("the device connection link opens its approval page without chat or a filter bar", async () => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  const handle = "a".repeat(32);
  const fetch = vi.fn(url => Promise.resolve({ ok: true, status: 200, json: async () =>
    String(url).startsWith(`/api/collector/enrollments/${handle}`) ? { name: "EC2 dev", platform: "linux",
      code: "BCDF-GHJK", status: "pending", expiresAt: new Date(Date.now() + 600000).toISOString(), userId: "alice@example.com" }
      : String(url).startsWith("/api/health/data") ? { status: "ok" } : [] }));
  vi.stubGlobal("fetch", fetch);
  const session = { mode: "oidc", role: "analyst", name: "Alice", expiresAt: new Date(Date.now() + 900000).toISOString(),
    permissions: ["telemetry:read", "chat:query", "collector:manage"] };
  render(<MemoryRouter initialEntries={[`/collector/connect/${handle}`]}>
    <ConfigProvider config={{ enabledClients: ["claude", "codex"], session }}><App /></ConfigProvider>
  </MemoryRouter>);
  expect(screen.getByRole("heading", { level: 1, name: "기기 연결 승인" })).toBeTruthy();
  expect((await screen.findByLabelText("확인 코드")).textContent).toBe("BCDF-GHJK");
  expect(screen.queryByRole("button", { name: "Ask Claude" })).toBeNull();
  expect(fetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});

test("revoked session during device registration removes the collector setup", async () => {
  vi.stubGlobal("fetch", vi.fn((url, options = {}) => Promise.resolve({ ok: options.method !== "POST",
    status: options.method === "POST" ? 401 : 200,
    json: async () => String(url).startsWith("/api/collector/devices") ? { devices: [], nextCursor: null }
      : String(url).startsWith("/api/collector") ? { enabled: true, endpoint: "https://collector.example/api/ingest",
        installScriptUrl: "https://collector.example/api/ingest/install.sh", tokenLifetimeDays: 30,
        collectorVersion: "0.163.1", platforms: ["linux", "darwin"] } : { status: "ok" } })));
  const session = { mode: "oidc", role: "analyst", permissions: ["telemetry:read", "collector:manage"],
    expiresAt: new Date(Date.now() + 900000).toISOString() };
  render(<MemoryRouter initialEntries={["/collector"]}>
    <ConfigProvider config={{ session }}><App /></ConfigProvider>
  </MemoryRouter>);
  await screen.findByText("등록한 기기가 없습니다.");
  fireEvent.change(screen.getByLabelText("기기 이름"), { target: { value: "EC2" } });
  const button = screen.getByRole("button", { name: "기기 등록 및 토큰 발급" });
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  expect(await screen.findByRole("heading", { name: "로그인 세션 만료" })).toBeTruthy();
  expect(screen.queryByLabelText("기기 이름")).toBeNull();
});

test("changelog route shows release notes without usage filters and clears the unseen dot", async () => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  const fetch = vi.fn(url => Promise.resolve({ ok: true, status: 200,
    json: async () => String(url).startsWith("/api/health/data") ? { status: "ok", ageMinutes: 0, staleAfterMinutes: 360 } : [] }));
  vi.stubGlobal("fetch", fetch);
  localStorage.removeItem("ccdash.releaseNotesSeen");
  const { container } = render(<MemoryRouter initialEntries={["/?client=all"]}>
    <ConfigProvider config={{ enabledClients: ["claude", "codex"] }}><App /></ConfigProvider>
  </MemoryRouter>);
  const entry = screen.getByRole("link", { name: /^변경 내역, 최신 v\d+\.\d+\.\d+, 새 릴리스$/ });
  // A utility link outside <nav>, so the route/nav contract above is unchanged.
  expect(container.querySelector("nav").contains(entry)).toBe(false);
  fireEvent.click(entry);
  expect(await screen.findByRole("heading", { level: 1, name: "변경 내역" })).toBeTruthy();
  // Like /installation: no FilterBar container, only the page itself.
  expect(container.querySelector("main").children.length).toBe(1);
  expect(screen.getAllByRole("link", { name: /바로 가기/ }).length).toBeGreaterThan(0);
  const detailLink = screen.getAllByRole("link", { name: /바로 가기/ })
    .map(a => new URL(a.href)).find(u => u.searchParams.get("view") === "detail");
  expect(detailLink.searchParams.get("client")).toBe("claude");
  expect(localStorage.getItem("ccdash.releaseNotesSeen")).toMatch(/^\d+\.\d+\.\d+$/);
  // Stays on /changelog: ClientContext treats it as a dashboard path and does not redirect.
  expect(screen.getByRole("link", { name: /^변경 내역, 최신 v\d+\.\d+\.\d+$/ })).toBeTruthy();
});

test("sidebar links the public user guide in a new tab outside the page nav", () => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("fetch", vi.fn(url => Promise.resolve({ ok: true, status: 200,
    json: async () => String(url).startsWith("/api/health/data") ? { status: "ok", ageMinutes: 0, staleAfterMinutes: 360 } : [] })));
  const { container } = render(<MemoryRouter initialEntries={["/?client=all"]}>
    <ConfigProvider config={{ enabledClients: ["claude", "codex"] }}><App /></ConfigProvider>
  </MemoryRouter>);
  const guide = screen.getByRole("link", { name: "사용설명서 (새 탭)" });
  expect(guide.getAttribute("href")).toBe("https://www.atomai.click/claude-code-usage-dashboard/ko/user-guide.html");
  expect(guide.getAttribute("target")).toBe("_blank");
  expect(guide.getAttribute("rel")).toContain("noreferrer");
  expect(container.querySelector("nav").contains(guide)).toBe(false);
});

test("a shared task link opens the task detail without a user and stays on its path", async () => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  const fetch = vi.fn(url => Promise.resolve({ ok: true, status: 200, json: async () => String(url).startsWith("/api/health/data")
    ? { status: "ok", ageMinutes: 0, staleAfterMinutes: 360 } : String(url).startsWith("/api/users/tasks/detail")
      ? { task: { client: "claude", started_at: "2026-11-10T06:00:00Z", duration_ms: 1000, models: [], tokens: {} },
        lanes: [], spans: [], truncated: false, span_total: 0, why: [], owner: "kim@example.test" } : [] }));
  vi.stubGlobal("fetch", fetch);
  const id = "claude:0123456789abcdef0123456789abcdef";
  const { container } = render(<MemoryRouter initialEntries={[
    `/tasks/${[id, "2026-11-10T06:00:00.000Z", "2026-11-10T07:00:00.000Z"].map(encodeURIComponent).join("/")}?days=7`]}>
    <ConfigProvider config={{ enabledClients: ["claude", "codex"], piiMask: true }}><App /></ConfigProvider>
  </MemoryRouter>);
  expect(await screen.findByRole("dialog", { name: "작업 상세" })).toBeTruthy();
  await waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).startsWith("/api/users/tasks/detail"))).toBe(true));
  const detail = new URL(String(fetch.mock.calls.find(([u]) => String(u).startsWith("/api/users/tasks/detail"))[0]), "http://x");
  expect(detail.searchParams.get("id")).toBe(id);
  expect(detail.searchParams.has("userExact")).toBe(false);
  expect(detail.searchParams.get("from")).toBe("2026-11-10T06:00:00.000Z");
  // No usage filter bar on this page.
  expect(container.querySelector("main").children.length).toBe(1);
  cleanup();
  render(<MemoryRouter initialEntries={["/tasks/claude%3Aabc/bad/worse"]}>
    <ConfigProvider config={{ enabledClients: ["claude"] }}><App /></ConfigProvider>
  </MemoryRouter>);
  expect(screen.getByRole("alert").textContent).toContain("작업 링크가 올바르지 않습니다");
});
