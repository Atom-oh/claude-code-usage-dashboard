import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../App.jsx";
import { ConfigProvider } from "../ConfigContext.jsx";
import { setPiiMask } from "../fmt.js";
import { clientOverview, costClientOverview, codexUsage } from "../test/clientOverview.js";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const RANGE = { from: "2026-09-01T00:00:00.000Z", to: "2026-09-02T00:00:00.000Z" };
const claude = { ...codexUsage, client: "claude", model: "claude-sonnet-5", backend: "anthropic",
  cost_usd: 3, cost_basis: "client_reported" };
const codex = { ...codexUsage, model: "openai.gpt-6-astra", cost_usd: 2 };
const overview = (overrides = {}) => clientOverview({
  clients: ["claude", "codex"], effective_range: RANGE,
  by_client: [claude, codex], by_model: [claude, codex], ...overrides,
});
const codexDetail = (effort = [{ effort: "high", cost_usd: 2, cost_partial: false, unpriced: 0,
  requests: 1, tokens: 270, observed_tokens: 270, tokens_partial: false,
  cache_hit_rate: 0.25, reasoning_share: 0.3 }]) => ({
  range: RANGE, coverage: { logs: { status: "observed", records: 1 },
    metrics: { status: "not_requested" }, traces: { status: "not_requested" } },
  summary: {}, completion_usage: {}, completeness: {}, effort, latency: [], tools: [], approvals: [],
  runtime: [], metrics: [], spans: [], traces: [], events: [], limitations: [],
});
const claudeDetail = (effort = [{ effort: "medium", backend: "anthropic", cost_usd: 3,
  cost_partial: false, cost_basis: "client_reported", unpriced: 0 }]) => ({
  range: RANGE, effort, cost_scope: "reported_or_rescaled_counters",
});
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

function mount({ entry = "/cost?client=all", enabledClients = ["claude", "codex"],
  data = overview(), insights = codexDetail(), effort = claudeDetail(), respond } = {}) {
  setPiiMask(false);
  const requests = [];
  const fetchMock = vi.fn((url) => {
    const u = new URL(String(url), "http://localhost");
    requests.push(u);
    const response = respond?.(u);
    if (response !== undefined) return response;
    return Promise.resolve(ok(u.pathname === "/api/clients/overview" ? costClientOverview(data)
      : u.pathname === "/api/codex/insights" ? insights
        : u.pathname === "/api/clients/claude-effort" ? effort
          : u.pathname === "/api/health/data" ? { status: "ok" } : []));
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  const rendered = render(<MemoryRouter initialEntries={[entry]}>
    <ConfigProvider config={{ enabledClients, piiMask: false, schema: { projectColumns: true } }}>
      <App />
    </ConfigProvider>
  </MemoryRouter>);
  return { ...rendered, requests, fetchMock };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); setPiiMask(true); });
const card = (title) => screen.getByText(title, { exact: true }).closest(".shadow-card");
const TITLES = ["모델별 비용 비중", "Effort별 비용 비중", "입력·캐시 구성"];

test("common Cost places the same three breakdowns per client before trends and shares one Codex detail response", async () => {
  mount();
  await screen.findByText("Effort별 비용 비중 — Claude Code", { exact: true });
  await waitFor(() => expect(card("Effort별 비용 비중 — Claude Code").textContent).toContain("medium"));
  expect(card("Effort별 비용 비중 — Codex").textContent).toContain("high");
  for (const client of ["Claude Code", "Codex"]) {
    for (const title of TITLES) {
      const element = card(`${title} — ${client}`);
      expect(element).toBeTruthy();
      expect(element.compareDocumentPosition(card("비용 추이")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  }
  expect(card("Effort별 사용량·비용").textContent).toContain("high");
});

test.each(["pending", "failed", "empty"])("breakdown titles remain visible while the overview is %s", async (state) => {
  mount({ enabledClients: ["codex"], entry: "/cost?client=codex",
    data: overview({ observed_records: 0, by_client: [], by_model: [], timeseries: [] }),
    respond: (u) => u.pathname === "/api/clients/overview" && state !== "empty"
      ? state === "pending" ? new Promise(() => {}) : Promise.resolve({ ok: false, status: 500, json: async () => ({}) })
      : undefined });
  for (const title of TITLES) expect(await screen.findByText(title, { exact: true })).toBeTruthy();
  if (state === "failed") {
    for (const title of TITLES) {
      await waitFor(() => expect(card(title).textContent).toContain("데이터를 불러오지 못했습니다."));
      expect(card(title).textContent).not.toContain("불러오는 중...");
    }
    const details = screen.getByRole("heading", { name: "Codex 상세 관측" }).closest("section");
    await waitFor(() => expect(details.textContent).toContain("데이터를 불러오지 못했습니다."));
    expect(details.textContent).not.toContain("불러오는 중...");
  }
  if (state === "empty") await waitFor(() => expect(card(TITLES[0]).textContent).toContain("데이터가 없습니다"));
});

test.each(["claude", "codex"])("effort uses its own observations when the %s overview has no logs", async (client) => {
  mount({ enabledClients: [client], entry: `/cost?client=${client}`,
    data: overview({ observed_records: 0, by_client: [], by_model: [], timeseries: [] }) });
  await waitFor(() => expect(card(TITLES[1]).textContent).toContain(client === "claude" ? "medium" : "high"));
  expect(card(TITLES[1]).textContent).not.toContain("데이터가 없습니다");
});

test.each(["logs", "effort", "tool"])("Codex effort distinguishes %s coverage limits from no observations", async (section) => {
  const insights = codexDetail(section === "tool" ? undefined : []);
  insights.coverage.logs = section === "logs" ? { status: "limited", records: null }
    : { status: "observed", records: 1, limited_sections: [section] };
  mount({ enabledClients: ["codex"], entry: "/cost?client=codex", insights });
  await waitFor(() => expect(card(TITLES[1]).textContent).toContain(section === "tool" ? "high" : "조회 한도"));
  expect(card(TITLES[1]).textContent).not.toContain("데이터가 없습니다");
  if (section !== "tool") expect(card(TITLES[1]).querySelector("svg.recharts-surface")).toBeNull();
});

test.each([0, null])("model and effort cards preserve partial zero or all-unknown costs (%s)", async (cost_usd) => {
  const rows = [{ ...codex, cost_usd, cost_partial: true, unpriced: 1 }];
  mount({ enabledClients: ["codex"], entry: "/cost?client=codex",
    data: overview({ by_client: rows, by_model: rows }),
    insights: codexDetail([{ effort: "high", cost_usd, cost_partial: true, unpriced: 1 }]) });
  await screen.findByText(TITLES[1], { exact: true });
  await waitFor(() => expect(card(TITLES[1]).textContent).toContain("미산정"));
  for (const title of TITLES.slice(0, 2)) {
    expect(card(title).textContent).toContain(cost_usd === null ? "—" : "$0");
    expect(card(title).textContent).toContain(cost_usd === null ? "미산정" : "부분합");
    if (cost_usd === null) expect(card(title).textContent).not.toContain("$0");
  }
});

test("input cache composition uses only the canonical nonoverlapping input components", async () => {
  mount({ enabledClients: ["codex"], entry: "/cost?client=codex" });
  await screen.findByText(TITLES[2], { exact: true });
  await waitFor(() => expect(card(TITLES[2]).textContent).toContain("220"));
  const composition = card(TITLES[2]);
  for (const value of ["98", "100", "22"]) expect(composition.textContent).toContain(value);
  expect(within(composition).queryByText("출력", { exact: true })).toBeNull();
  expect(within(composition).queryByText("추론", { exact: true })).toBeNull();
});

test("a missing canonical cache component stays unavailable despite an observed token subtotal", async () => {
  const row = { ...codex, cache_write_tokens: null, observed_tokens: 270, tokens_partial: true };
  mount({ enabledClients: ["codex"], entry: "/cost?client=codex",
    data: overview({ by_client: [row], by_model: [row] }) });
  await screen.findByText(TITLES[2], { exact: true });
  await waitFor(() => expect(card(TITLES[2]).textContent).toContain("구성 미확인"));
  expect(card(TITLES[2]).textContent).toContain("—");
  expect(card(TITLES[2]).querySelector("svg.recharts-surface")).toBeNull();
});

test("excluded cost scopes do not claim that Claude model/session counts are completion request counts", async () => {
  mount({ effort: claudeDetail([{ effort: "medium", backend: "anthropic", cost_usd: 3,
    cost_partial: true, cost_basis: "client_reported", unpriced: 7 }]),
  insights: codexDetail([{ effort: "high", cost_usd: 2, cost_partial: true, unpriced: 7 }]) });
  for (const client of ["Claude Code", "Codex"]) {
    const title = `Effort별 비용 비중 — ${client}`;
    await screen.findByText(title, { exact: true });
    await waitFor(() => expect(card(title).textContent).toContain("미산정 범위 포함"));
    expect(card(title).textContent).not.toContain("7건 제외");
  }
});

test("model versions and their backend identities remain separate and keep family shades", async () => {
  const older = { ...claude, model: "claude-sonnet-4-5", backend: "bedrock-runtime", cost_usd: 1 };
  mount({ enabledClients: ["claude"], entry: "/cost?client=claude",
    data: overview({ by_client: [claude], by_model: [claude, older] }) });
  await screen.findByText(TITLES[0], { exact: true });
  await waitFor(() => expect(card(TITLES[0]).textContent).toContain("claude-sonnet-4-5"));
  const model = card(TITLES[0]);
  expect(model.textContent).toContain("claude-sonnet-5 · anthropic");
  expect(model.textContent).toContain("claude-sonnet-4-5 · bedrock-runtime");
  const swatches = [...model.querySelectorAll("li span[style]")].map((node) => node.style.background);
  expect(swatches).toContain("rgb(53, 95, 199)");
  expect(swatches).toContain("rgb(45, 86, 186)");
});

test("effort requests share effective bounds and supported filters while independent failures leave model and cache usable", async () => {
  const { requests } = mount({ entry: "/cost?client=all&view=common&user=fixture&model=sonnet&backend=bedrock-runtime",
    respond: (u) => u.pathname === "/api/clients/claude-effort"
      ? Promise.resolve({ ok: false, status: 500, json: async () => ({}) }) : undefined });
  await screen.findByText("Effort별 비용 비중 — Claude Code", { exact: true });
  await waitFor(() => expect(card("Effort별 비용 비중 — Claude Code").textContent).toContain("데이터를 불러오지 못했습니다."));
  const effortRequests = requests.filter((u) => ["/api/clients/claude-effort", "/api/codex/insights"].includes(u.pathname));
  expect(effortRequests).toHaveLength(2);
  for (const u of effortRequests) {
    expect(u.searchParams.get("from")).toBe(RANGE.from);
    expect(u.searchParams.get("to")).toBe(RANGE.to);
    expect(u.searchParams.get("user")).toBe("fixture");
    expect(u.searchParams.get("model")).toBe("sonnet");
    expect(u.searchParams.get("backend")).toBe("bedrock-runtime");
    expect(u.searchParams.has("group")).toBe(false);
    expect(u.searchParams.has("project")).toBe(false);
  }
  expect(effortRequests.find((u) => u.pathname === "/api/codex/insights").searchParams.get("profile")).toBe("effort");
  expect(card("모델별 비용 비중 — Claude Code").textContent).toContain("claude-sonnet-5");
  expect(card("입력·캐시 구성 — Claude Code").textContent).toContain("220");
});

test("unknown Claude effort backend uses the shared Korean placeholder", async () => {
  mount({ enabledClients: ["claude"], entry: "/cost?client=claude",
    effort: claudeDetail([{ effort: "medium", backend: "unknown", cost_usd: 3,
      cost_partial: false, unpriced: 0, cost_basis: "client_reported" }]) });
  await waitFor(() => expect(card(TITLES[1]).textContent).toContain("medium · 백엔드 미제공"));
  expect(card(TITLES[1]).textContent).not.toContain("unknown");
});

test("changing the client clears old breakdown identities and does not request disabled-client effort", async () => {
  const { requests } = mount({ respond: (u) => u.pathname === "/api/clients/overview" && u.searchParams.get("client") === "claude"
    ? new Promise(() => {}) : undefined });
  await screen.findByText("모델별 비용 비중 — Codex", { exact: true });
  await waitFor(() => expect(card("Effort별 비용 비중 — Codex").textContent).toContain("high"));
  fireEvent.change(screen.getByRole("combobox", { name: "클라이언트" }), { target: { value: "claude" } });
  await waitFor(() => expect(screen.queryByText("모델별 비용 비중 — Codex", { exact: true })).toBeNull());
  expect(card(TITLES[0]).textContent).not.toContain("openai.gpt-6-astra");
  expect(requests.filter((u) => u.pathname === "/api/codex/insights")).toHaveLength(1);
});

test("a range change holds effort requests at the old response bounds until overview replacement", async () => {
  const pending = [];
  let holdOverview = false;
  const { requests } = mount({ enabledClients: ["codex"], entry: "/cost?client=codex",
    respond: (u) => u.pathname === "/api/clients/overview" && holdOverview
      ? new Promise((resolve) => pending.push(resolve)) : undefined });
  await screen.findByText(TITLES[1], { exact: true });
  await waitFor(() => expect(card(TITLES[1]).textContent).toContain("high"));
  holdOverview = true;
  fireEvent.click(screen.getByRole("button", { name: "7일", exact: true }));
  await waitFor(() => expect(pending).toHaveLength(1));
  expect(requests.filter((u) => u.pathname === "/api/codex/insights")).toHaveLength(1);
  expect(card(TITLES[1]).textContent).toContain("high");
  const nextRange = { from: "2026-08-26T00:00:00.000Z", to: RANGE.to };
  await act(async () => pending[0](ok(costClientOverview(overview({ effective_range: nextRange })))));
  await waitFor(() => expect(requests.filter((u) => u.pathname === "/api/codex/insights")).toHaveLength(2));
  expect(requests.filter((u) => u.pathname === "/api/codex/insights").at(-1).searchParams.get("from")).toBe(nextRange.from);
});
