import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RangeProvider } from "../RangeContext.jsx";
import { ConfigProvider } from "../ConfigContext.jsx";
import { maskEmail, setPiiMask } from "../fmt.js";
import { TERM_LABELS } from "../tokenEconomics.js";
import TokenEconomics, { MODEL_COLUMNS, modelRows } from "./TokenEconomics.jsx";
import { toCsv } from "../csv.js";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeEach(() => { vi.stubGlobal("ResizeObserver", ResizeObserverStub); setPiiMask(true); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// Synthetic data; no production identities.
const overviewRange = { from: "2026-09-08T00:20:00.000Z", to: "2026-09-15T00:00:00.000Z" };
const effective = { from: "2026-09-08T00:00:00.000Z", to: "2026-09-15T00:00:00.000Z" };
const factors = (f) => ({ users: f[0], sessions_per_user: f[1], turns_per_session: f[2], requests_per_turn: f[3],
  tokens_per_request: f[4], cost_per_token: f[5] });
const contributions = { users: 595.8845, sessions_per_user: 79.4409, turns_per_session: -181.9964,
  requests_per_turn: 182.0223, tokens_per_request: 231.9086, cost_per_token: -282.2599 };
const decomposition = { contributions, bundles: { growth: 675.3254, waste: 231.9345, price: -282.2599 },
  total_change: 625, unavailable: null };

function claude(extra = {}) {
  return { client: "claude", cost_basis: "client_reported",
    current: { users: 42, sessions: 756, turns: 6804, requests: 43546, tokens: 1654748000, cost: 3144,
      factors: factors([42, 18, 9, 6.4, 38000, 0.0000019]), cost_per_million_tokens: 1.9, unavailable: null },
    previous: { users: 34, sessions: 595, turns: 5712, requests: 34272, tokens: 1197024000, cost: 2519,
      factors: factors([34, 17.5, 9.6, 6, 34990, 0.0000021]), cost_per_million_tokens: 2.1, unavailable: null },
    decomposition, unavailable: { chain: null, decomposition: null, outcome: null },
    coverage: { sessions: 800, matched_sessions: 756, excluded: { no_turns: 30, no_requests: 4, cost_incomplete: 10, tokens_invalid: 0 },
      cost_known: 3300, cost_matched: 3144, cost_unattributed: 6 },
    previous_coverage: null,
    trend: [{ t: "2026-09-08T00:00:00.000Z", cost_per_user: 10, cost_per_session: 1, cost_per_1k_requests: 0.07,
      tokens_per_request: 38000, cache_hit_rate: 0.7 }],
    models: [{ model: "claude-sonnet-5-5", cost: 1980, requests: 25000, request_share: 0.58, tokens: 800000000,
      cost_per_million_tokens: 2.4, small: false },
      { model: "claude-haiku-5-5", cost: 90, requests: 11000, request_share: 0.27, tokens: 400000000,
        cost_per_million_tokens: 0.21, small: true }],
    outcome: { commits: 750, prs: 168, loc_added: 1497000, cost_per_commit: 4.192, cost_per_pr: 18.71, cost_per_kloc: 2.1 },
    previous_outcome: { commits: 535, prs: 126, loc_added: 1235000, cost_per_commit: 4.708, cost_per_pr: 19.99, cost_per_kloc: 2.04 },
    exemplars: { eligible_users: 12, levers: [
      { lever: "tokens_per_request", direction: "lower", median: 41000,
        top: [{ user: "alice@example.test", value: 22000, sessions: 9, turns: 80, commits: 12 }] },
      { lever: "cache_hit_rate", direction: "higher", median: 0.71,
        top: [{ user: "bob@example.test", value: 0.93, sessions: 6, turns: 40, commits: null }] }] },
    ...extra };
}
function codex(extra = {}) {
  return { ...claude(), client: "codex", cost_basis: "aws_list_estimate",
    unavailable: { chain: null, decomposition: null, outcome: "not_collected" }, outcome: null, previous_outcome: null,
    exemplars: { eligible_users: 1, levers: [{ lever: "requests_per_turn", direction: "lower", median: 3,
      top: [{ user: "carol@example.test", value: 2, sessions: 5, turns: 25, commits: null }] }] }, ...extra };
}
const response = (byClient, extra = {}) => ({ effective_range: effective,
  previous_range: { from: "2026-09-01T00:00:00.000Z", to: effective.from }, bucket_hours: 24, by_client: byClient,
  combined: { cost: 6288, previous_cost: 5038, decomposition: { ...decomposition,
    contributions: Object.fromEntries(Object.entries(contributions).map(([k, v]) => [k, 2 * v])),
    bundles: { growth: 1350.6508, waste: 463.869, price: -564.5198 }, total_change: 1250 } },
  ...extra });
const gated = (client, reason) => ({ client, cost_basis: client === "claude" ? "client_reported" : "aws_list_estimate",
  current: null, previous: null,
  decomposition: { contributions: null, bundles: null, total_change: null, unavailable: reason },
  unavailable: { chain: reason, decomposition: reason, outcome: client === "codex" ? "not_collected" : reason },
  coverage: null, previous_coverage: null, trend: null, models: null, outcome: null, previous_outcome: null, exemplars: null });

function mount({ data, clients = ["claude"], stale = false, apiStale = false, loading = false, error = null, range = overviewRange }) {
  const api = { data, loading, error, stale: apiStale };
  return render(<MemoryRouter><ConfigProvider config={{ piiMask: true }}><RangeProvider>
    <TokenEconomics api={api} range={range} clients={clients} stale={stale} />
  </RangeProvider></ConfigProvider></MemoryRouter>);
}
const strip = (client) => screen.getByRole("group", { name: `${client} 비용 방정식` });

test("the equation strip shows six terms joined by × and the total with the period change", () => {
  mount({ data: response([claude()]) });
  const eq = strip("Claude Code");
  for (const label of Object.values(TERM_LABELS)) expect(within(eq).getByText(label)).toBeTruthy();
  expect(within(eq).getAllByText("×")).toHaveLength(5);
  expect(within(eq).getByText("=")).toBeTruthy();
  expect(within(eq).getByText("총 비용")).toBeTruthy();
  expect(within(eq).getByText("$3,144")).toBeTruthy();
  expect(within(eq).getByText("직전 대비 +23.5%")).toBeTruthy();
  expect(within(eq).getByText("$1.9")).toBeTruthy();
  expect(screen.getByText("세션·턴·요청·토큰·비용이 모두 관측된 세션 756/800개 · 제외 비용 4.73%")).toBeTruthy();
  expect(screen.getByText("성장 +$675.33 · 낭비 +$231.93 · 단가 −$282.26")).toBeTruthy();
  const steps = screen.getByRole("list", { name: "드라이버 분해 단계" });
  expect(within(steps).getByText("+$595.88")).toBeTruthy();
  expect(within(steps).getByText("−$182")).toBeTruthy();
});

test("an unavailable chain renders the reason label and no amount", () => {
  const { container } = mount({ data: response([gated("claude", "not_backfilled")], {
    combined: { cost: null, previous_cost: null, decomposition: { contributions: null, bundles: null,
      total_change: null, unavailable: "not_backfilled" } } }) });
  expect(screen.getAllByText("백필 전").length).toBeGreaterThan(0);
  expect(container.textContent).not.toMatch(/\$\s?\d/);
  expect(container.textContent).not.toContain("$0");
});

test("Codex outcome renders 미수집 and a missing Claude count is never zero", () => {
  const partial = claude({ outcome: { commits: null, prs: 3, loc_added: null, cost_per_commit: null,
    cost_per_pr: 1048, cost_per_kloc: null } });
  mount({ data: response([partial, codex()]), clients: ["claude", "codex"] });
  const table = screen.getByText("성과 단위 비용").closest(".shadow-card");
  expect(within(table).getAllByText("미수집").length).toBe(6);
  expect(within(table).getAllByText("미집계").length).toBe(4);
  expect(within(table).getByText("관측된 텔레메트리 활동 기준 · 머지된 PR/검증된 성과 아님")).toBeTruthy();
  const commits = within(table).getByText("커밋").closest("tr");
  expect(commits.textContent).not.toMatch(/(^|\D)0(\D|$)/);
});

test("model economics marks a partial cost and never shows an unknown cost as $0", () => {
  const models = [
    { model: "claude-sonnet-5-5", cost: 1980, cost_partial: true, requests: 25000, request_share: 0.58,
      tokens: 800000000, cost_per_million_tokens: 2.4, small: false },
    { model: "claude-opus-5-5", cost: null, cost_partial: false, requests: 400, request_share: 0.01,
      tokens: null, cost_per_million_tokens: null, small: false }];
  mount({ data: response([claude({ models })]) });
  const table = screen.getByText("모델 경제").closest(".shadow-card");
  const sonnet = within(table).getByText("claude-sonnet-5-5").closest("tr");
  expect(within(sonnet).getAllByText("부분합").length).toBe(2);
  expect(sonnet.textContent).toContain("$1,980");
  const opus = within(table).getByText("claude-opus-5-5").closest("tr");
  expect(opus.textContent).not.toContain("$0");
  expect(opus.textContent).not.toContain("부분합");
  expect(opus.textContent).toContain("—");
  const csv = toCsv(MODEL_COLUMNS, modelRows([claude({ models })])).split("\r\n");
  expect(csv[1]).toContain("1980 (부분합)");
  expect(csv[1]).toContain("2.4 (부분합)");
  expect(csv[2]).not.toContain("부분합");
  expect(csv[2]).not.toMatch(/,0,/);
});

test("all clients render one strip per client and the combined waterfall", () => {
  mount({ data: response([claude(), codex()]), clients: ["claude", "codex"] });
  expect(strip("Claude Code")).toBeTruthy();
  expect(strip("Codex")).toBeTruthy();
  expect(screen.getByText("합계 드라이버 분해")).toBeTruthy();
  expect(screen.getByText("성장 +$1,350.65 · 낭비 +$463.87 · 단가 −$564.52")).toBeTruthy();
});

test("exemplar identities pass through maskEmail and keep the contact caption", () => {
  const { container } = mount({ data: response([claude(), codex()]), clients: ["claude", "codex"] });
  expect(screen.getByText(maskEmail("alice@example.test"))).toBeTruthy();
  expect(screen.getByText(maskEmail("carol@example.test"))).toBeTruthy();
  expect(container.textContent).not.toContain("alice@example.test");
  expect(screen.getByText("최소 활동량(세션 5개·턴 20개) 충족 사용자만 · 연락해 사용 방식을 공유받는 용도이며 성과 평가가 아닙니다")).toBeTruthy();
});

test.each([
  ["a stale hook", { apiStale: true }],
  ["a stale overview", { stale: true }],
  ["a response for another window", { range: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-15T00:00:00.000Z" } }],
])("%s shows the pending state instead of numbers", (_, options) => {
  const { container } = mount({ data: response([claude()]), ...options });
  expect(screen.getByText("불러오는 중...")).toBeTruthy();
  expect(container.textContent).not.toContain("$3,144");
});

test("a failed request shows the error box", () => {
  mount({ data: null, error: new Error("boom") });
  expect(screen.getByText("데이터를 불러오지 못했습니다.")).toBeTruthy();
});

test("multi mode with one client blocking shows each client's waterfall and names the blocker", () => {
  const idle = codex({ previous: null, previous_coverage: null,
    decomposition: { contributions: null, bundles: null, total_change: null, unavailable: "no_previous" },
    unavailable: { chain: null, decomposition: "no_previous", outcome: "not_collected" } });
  mount({ data: response([claude(), idle], { combined: { cost: 6288, previous_cost: null,
    decomposition: { contributions: null, bundles: null, total_change: null, unavailable: "no_previous" },
    unavailable_clients: [{ client: "codex", reason: "no_previous" }] } }), clients: ["claude", "codex"] });
  const combined = screen.getByText("합계 드라이버 분해").closest(".shadow-card");
  expect(within(combined).getByText("Codex: 직전 기간 없음")).toBeTruthy();
  expect(within(combined).queryByText("Claude Code: 직전 기간 없음")).toBeNull();
  expect(within(combined).getByText("이번 기간 대상 세션 비용 합계 $6,288")).toBeTruthy();
  // Claude's own decomposition renders its bars and steps; Codex's card shows its reason.
  const claudeCard = screen.getByText("Claude Code 드라이버 분해").closest(".shadow-card");
  expect(within(within(claudeCard).getByRole("list", { name: "드라이버 분해 단계" })).getByText("+$595.88")).toBeTruthy();
  expect(within(claudeCard).getByText("성장 +$675.33 · 낭비 +$231.93 · 단가 −$282.26")).toBeTruthy();
  const codexCard = screen.getByText("Codex 드라이버 분해").closest(".shadow-card");
  expect(within(codexCard).getByText("직전 기간 없음")).toBeTruthy();
  expect(within(codexCard).queryByRole("list", { name: "드라이버 분해 단계" })).toBeNull();
  // The combined sum is not drawn.
  expect(screen.getAllByRole("list", { name: "드라이버 분해 단계" })).toHaveLength(1);
});

test("a gated previous window keeps the current equation and labels only the decomposition", () => {
  const row = claude({ previous: null, previous_coverage: null, previous_outcome: null,
    decomposition: { contributions: null, bundles: null, total_change: null, unavailable: "not_backfilled" },
    unavailable: { chain: null, decomposition: "not_backfilled", outcome: null } });
  mount({ data: response([row]) });
  const eq = strip("Claude Code");
  expect(within(eq).getByText("$3,144")).toBeTruthy();
  expect(within(eq).queryByText("백필 전")).toBeNull();
  const card = screen.getByText("Claude Code 드라이버 분해").closest(".shadow-card");
  expect(within(card).getByText("백필 전")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "드라이버 분해 단계" })).toBeNull();
});

test("a missing client row or combined block falls back to the chain reason", () => {
  const { container } = mount({ data: response([claude()], { combined: undefined }), clients: ["claude", "codex"] });
  const combined = screen.getByText("합계 드라이버 분해").closest(".shadow-card");
  expect(within(combined).getByText("Codex: 대상 세션 없음")).toBeTruthy();
  const codexCard = screen.getByText("Codex 드라이버 분해").closest(".shadow-card");
  expect(within(codexCard).getByText("대상 세션 없음")).toBeTruthy();
  expect(within(codexCard).queryByText("직전 기간 없음")).toBeNull();
  expect(container.textContent).not.toContain("이번 기간 대상 세션 비용 합계");
});
