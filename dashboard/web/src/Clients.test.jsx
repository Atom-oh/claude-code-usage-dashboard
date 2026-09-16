import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import App from "./App.jsx";
import { ConfigProvider } from "./ConfigContext.jsx";
import { setPiiMask } from "./fmt.js";
import { clientOverview, codexUsage } from "./test/clientOverview.js";
import * as csv from "./csv.js";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let location;
function LocationSpy() {
  location = useLocation();
  return null;
}

function mount({ enabledClients, entry = "/", piiMask = true, response = clientOverview(), pending = false, failed = false } = {}) {
  setPiiMask(piiMask);
  const fetchMock = vi.fn((url) => {
    const path = String(url).split("?")[0];
    if (path === "/api/clients/overview" && pending) return new Promise(() => {});
    const body = path === "/api/health/data" ? { status: "ok" }
      : path === "/api/clients/overview" ? response : [];
    return Promise.resolve({ ok: !(failed && path === "/api/clients/overview"), status: failed ? 500 : 200, json: async () => body });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  const rendered = render(
    <MemoryRouter initialEntries={[entry]}>
      <ConfigProvider config={{ enabledClients, piiMask, schema: { projectColumns: true } }}>
        <LocationSpy />
        <App />
      </ConfigProvider>
    </MemoryRouter>,
  );
  return { ...rendered, fetchMock };
}

const requests = (mock) => mock.mock.calls.map(([url]) => new URL(url, "http://localhost"));
const commonRequests = (mock) => requests(mock).filter((url) => url.pathname === "/api/clients/overview");
const selection = () => screen.queryByRole("combobox", { name: "클라이언트" });
const tile = (label) => screen.getByText(label, { selector: "span.truncate" }).parentElement.parentElement;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setPiiMask(true);
});

test.each([undefined, ["claude"]])("explicit Claude detail preserves legacy navigation and API scope: %j", async (enabledClients) => {
  const { fetchMock, container } = mount({ enabledClients, entry: "/?client=claude&view=detail" });
  await waitFor(() => expect(requests(fetchMock).some((url) => url.pathname === "/api/overview/kpi")).toBe(true));
  expect(selection()).toBeNull();
  expect(container.querySelector("nav").textContent).toContain("Productivity");
  expect(screen.getByRole("button", { name: "enterprise", exact: true })).toBeTruthy();
  expect(commonRequests(fetchMock)).toHaveLength(0);
});

test.each([
  [["claude"], "claude"],
  [["codex"], "codex"],
  [["claude", "codex"], "all"],
])("activation %j defaults to %s and exposes only common navigation", async (enabledClients, client) => {
  const { fetchMock, container } = mount({ enabledClients });
  await screen.findByRole("heading", { name: "Overview" });
  await waitFor(() => expect(commonRequests(fetchMock).length).toBeGreaterThan(0));
  expect(commonRequests(fetchMock)[0].searchParams.get("client")).toBe(client);
  expect(Boolean(selection())).toBe(enabledClients.length > 1);
  expect([...container.querySelector("nav").querySelectorAll("a")].map((a) => new URL(a.href).pathname)).toEqual(["/", "/exec", "/trends", "/productivity", "/usage", "/users", "/cost", "/reliability", "/analytics"]);
  expect(screen.queryByRole("button", { name: "enterprise", exact: true })).toBeNull();
  expect(screen.queryByPlaceholderText("프로젝트")).toBeNull();
  expect(container.textContent).not.toContain("A/B Dashboard");
  expect(document.title).toContain("Overview");
  expect(document.title).not.toContain("A/B");
  expect(requests(fetchMock).every((url) => ["/api/clients/overview", "/api/codex/insights", "/api/health/data"].includes(url.pathname))).toBe(true);
});

test.each(["/productivity", "/analytics", "/users", "/cost", "/missing"])("Codex deep URL %s redirects with supported filters before any legacy fetch", async (path) => {
  const { fetchMock } = mount({
    enabledClients: ["codex"], piiMask: false,
    entry: `${path}?client=claude&days=7&group=enterprise&project=repo&user=alice&model=fixture&backend=bedrock-mantle`,
  });
  await waitFor(() => expect(location.pathname).toBe(path === "/missing" ? "/" : path));
  const params = new URLSearchParams(location.search);
  expect(params.get("days")).toBe("7");
  expect(params.get("user")).toBe("alice");
  expect(params.get("model")).toBe("fixture");
  expect(params.get("backend")).toBe("bedrock-mantle");
  expect(params.has("group")).toBe(false);
  expect(params.has("project")).toBe(false);
  for (const url of requests(fetchMock)) {
    expect(["/api/clients/overview", "/api/codex/insights", "/api/health/data"]).toContain(url.pathname);
    expect(url.searchParams.has("group")).toBe(false);
    expect(url.searchParams.has("project")).toBe(false);
  }
  expect(commonRequests(fetchMock)[0].searchParams.get("user")).toBe("alice");
  expect(commonRequests(fetchMock)[0].searchParams.get("backend")).toBe("bedrock-mantle");
});

test("switching from Claude clears incompatible filters, preserves range/user/model and closes schema-specific chat", async () => {
  const { fetchMock, container } = mount({
    enabledClients: ["claude", "codex"], piiMask: false,
    entry: "/cost?client=claude&from=2026-09-01T00:00:00.000Z&to=2026-09-03T00:00:00.000Z&group=enterprise&project=repo&model=fixture&user=alice",
  });
  await screen.findByRole("heading", { name: "Cost" });
  expect(screen.getByRole("button", { name: "Ask Claude", exact: true })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Ask Claude", exact: true }));
  expect(screen.getByPlaceholderText("사용량에 대해 질문하세요")).toBeTruthy();
  fireEvent.change(selection(), { target: { value: "codex" } });
  await waitFor(() => expect(selection().value).toBe("codex"));
  expect(location.pathname).toBe("/cost");
  await waitFor(() => expect(commonRequests(fetchMock).length).toBeGreaterThan(0));
  const first = commonRequests(fetchMock)[0].searchParams;
  expect(first.get("from")).toBe("2026-09-01T00:00:00.000Z");
  expect(first.get("to")).toBe("2026-09-03T00:00:00.000Z");
  expect(first.get("user")).toBe("alice");
  expect(first.get("model")).toBe("fixture");
  expect(first.has("group")).toBe(false);
  expect(first.has("project")).toBe(false);
  expect(screen.queryByRole("button", { name: "Ask Claude", exact: true })).toBeNull();
  expect(screen.queryByPlaceholderText("사용량에 대해 질문하세요")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "7일", exact: true }));
  await waitFor(() => expect(new URLSearchParams(location.search).get("days")).toBe("7"));
  expect(selection().value).toBe("codex");
  fireEvent.change(selection(), { target: { value: "all" } });
  await waitFor(() => expect(commonRequests(fetchMock).at(-1).searchParams.get("client")).toBe("all"));
  fireEvent.change(selection(), { target: { value: "claude" } });
  await screen.findByRole("heading", { name: "Cost" });
  expect(screen.queryByPlaceholderText("프로젝트")).toBeNull();
  expect(screen.getByRole("button", { name: "Claude 상세 보기" })).toBeTruthy();
  expect(container.querySelector("nav").textContent).toContain("Productivity");
  expect(new URLSearchParams(location.search).has("group")).toBe(false);
});

test("a disabled Codex selection falls back to Claude without removing its supported detail URL", async () => {
  const { fetchMock } = mount({ enabledClients: ["claude"], entry: "/cost?client=codex&days=7&group=bedrock" });
  await screen.findByRole("heading", { name: "Cost" });
  await waitFor(() => expect(new URLSearchParams(location.search).get("client")).toBe("claude"));
  expect(location.pathname).toBe("/cost");
  expect(new URLSearchParams(location.search).get("group")).toBe("bedrock");
  expect(commonRequests(fetchMock)).toHaveLength(0);
  expect(selection()).toBeNull();
});

test("common mobile navigation uses the same supported route and closes after a client switch", async () => {
  const { container } = mount({ enabledClients: ["claude", "codex"] });
  await waitFor(() => expect(document.querySelector("main h1")).not.toBeNull());
  await waitFor(() => expect(container.querySelectorAll("nav")).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "메뉴 열기" }));
  expect(container.querySelectorAll("nav")).toHaveLength(2);
  const links = (nav) => [...nav.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  const [mobile, desktop] = container.querySelectorAll("nav");
  expect(links(mobile)).toEqual(links(desktop));
  expect(links(mobile)).toHaveLength(9);
  fireEvent.change(selection(), { target: { value: "claude" } });
  await screen.findByRole("heading", { name: "Overview" });
  expect(container.querySelectorAll("nav")).toHaveLength(1);
});

test("common dashboard preserves token subsets, tiny costs, unavailable operations and server unique-user totals", async () => {
  mount({ enabledClients: ["claude", "codex"], response: clientOverview({
    totals: { ...codexUsage, users: null, requests: null, ttft_ms: null },
    by_client: [codexUsage, { ...codexUsage, client: "claude", cost_basis: "client_reported" }],
  }) });
  await waitFor(() => expect(document.querySelector("main h1")).not.toBeNull());
  expect(tile("전체 토큰").textContent).toContain("270");
  expect(tile("비용 (USD)").textContent).toContain("$0.0042405");
  expect(tile("관측 사용자 ID").textContent).toContain("—");

  expect(screen.getAllByText("AWS 정가 추정").length).toBeGreaterThan(0);
  expect(screen.getByRole("region", { name: "클라이언트 비교" }).textContent).toContain("클라이언트 보고");
  expect(screen.getByText("사용량·비용 추이", { selector: "div" })).toBeTruthy();
});

test("incomplete costs remain unavailable and disclose quality instead of summing priced rows", async () => {
  mount({ enabledClients: ["codex"], response: clientOverview({
    totals: { ...codexUsage, cost_usd: null, unpriced: 1 },
    quality: { unpriced: 1, invalid: 1 },
  }) });
  await waitFor(() => expect(document.querySelector("main h1")).not.toBeNull());
  expect(tile("비용 (USD)").textContent).toContain("—");
  expect(screen.getByRole("status").textContent).toContain("미산정 1");
  expect(screen.getByRole("status").textContent).toContain("유효하지 않은 데이터 1");
});

test("user CSV is masked, follows visible columns and sorted order, and omits hidden row fields", async () => {
  const download = vi.spyOn(csv, "downloadCsv").mockImplementation(() => {});
  mount({ enabledClients: ["codex"], entry: "/users?client=codex", response: clientOverview({
    by_user: [
      { ...codexUsage, user: "zoe@example.test", hidden: "private-data" },
      { ...codexUsage, user: "alice@example.test", hidden: "private-data" },
    ],
  }) });
  const title = await screen.findByText("사용자별 사용량");
  const card = title.closest(".shadow-card");
  expect(card.textContent).not.toContain("alice@example.test");
  expect(card.textContent).toContain("al******@example.test");
  fireEvent.click(within(card).getByRole("columnheader", { name: /사용자/ }));
  fireEvent.click(within(card).getByRole("button", { name: "CSV" }));
  const text = download.mock.calls[0][1];
  expect(text).toContain("al******@example.test");
  expect(text).not.toMatch(/alice@|zoe@|private-data|hidden/);
  expect(text.indexOf("al******")).toBeLessThan(text.indexOf("zo******"));
  expect(text.replace(/^\uFEFF/, "").split("\r\n")[0].split(",")).toHaveLength(within(card).getAllByRole("columnheader").length);
});

test("common user/model/backend filters debounce, preserve client/range, and never put masked identity in the URL", async () => {
  const { fetchMock } = mount({ enabledClients: ["codex"], entry: "/?client=codex&days=7&user=secret%40example.test" });
  await waitFor(() => expect(document.querySelector("main h1")).not.toBeNull());
  expect(commonRequests(fetchMock)[0].searchParams.has("user")).toBe(false);
  fireEvent.change(screen.getByPlaceholderText("사용자 검색"), { target: { value: "alice@example.test" } });
  fireEvent.change(screen.getByPlaceholderText("모델 검색"), { target: { value: "fixture" } });
  const backend = screen.getByRole("combobox", { name: "백엔드" });
  expect([...backend.options].map((option) => option.value)).toEqual(["", "bedrock-mantle", "bedrock-runtime", "anthropic", "unknown"]);
  fireEvent.change(backend, { target: { value: "bedrock-mantle" } });
  await waitFor(() => {
    const params = commonRequests(fetchMock).at(-1).searchParams;
    expect(params.get("user")).toBe("alice@example.test");
    expect(params.get("model")).toBe("fixture");
    expect(params.get("backend")).toBe("bedrock-mantle");
  });
  expect(new URLSearchParams(location.search).get("client")).toBe("codex");
  expect(new URLSearchParams(location.search).get("days")).toBe("7");
  expect(new URLSearchParams(location.search).has("user")).toBe(false);
});

test("common dashboard discloses the shared effective range when historical alignment trims its end", async () => {
  mount({ enabledClients: ["claude", "codex"], response: clientOverview({
    effective_range: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-02T10:00:00.000Z", requested_to: "2026-09-02T10:45:00.000Z" },
  }) });
  const notice = await screen.findByText(/집계 종료 시각/);
  expect(notice.textContent).toContain("2026-09-02 10:00:00 UTC");
  expect(notice.textContent).toContain("선택한 클라이언트");
});

test("All-client historical insights use the overview's trimmed effective interval", async () => {
  const from = "2026-09-01T00:00:00.000Z", requested = "2026-09-02T10:45:00.000Z";
  const to = "2026-09-02T10:00:00.000Z";
  const { fetchMock } = mount({ enabledClients: ["claude", "codex"],
    entry: `/cost?from=${from}&to=${requested}`,
    response: clientOverview({ effective_range: { from, to, requested_to: requested } }) });
  await waitFor(() => {
    const insights = requests(fetchMock).filter((r) => r.pathname === "/api/codex/insights");
    expect(insights.length).toBeGreaterThan(0);
    expect(insights.at(-1).searchParams.get("from")).toBe(from);
    expect(insights.at(-1).searchParams.get("to")).toBe(to);
  });
});

test("changing the overview range preserves the selected Codex tab and metric search", async () => {
  mount({ enabledClients: ["codex"], entry: "/analytics?client=codex" });
  await screen.findByRole("button", { name: "런타임·메트릭" });
  fireEvent.click(screen.getByRole("button", { name: "런타임·메트릭" }));
  fireEvent.change(screen.getByPlaceholderText("메트릭 이름 검색"), { target: { value: "turn" } });
  fireEvent.click(screen.getByRole("button", { name: "7일", exact: true }));
  await waitFor(() => expect(screen.getByPlaceholderText("메트릭 이름 검색").value).toBe("turn"));
});

test.each(["loading", "error", "empty"])("common %s state does not claim measured zero", async (state) => {
  mount({
    enabledClients: ["codex"], pending: state === "loading", failed: state === "error",
    response: clientOverview({ observed_records: 0, totals: {}, by_client: [{ ...codexUsage, tokens: 0, cost_usd: 0 }], by_user: [], by_model: [], timeseries: [], tools: [] }),
  });
  await screen.findAllByText(state === "loading" ? "불러오는 중..." : state === "error" ? "데이터를 불러오지 못했습니다." : "선택한 기간에 데이터가 없습니다.");
  expect(screen.queryByText("$0")).toBeNull();
});
