import { expect, test } from "vitest";
import { combineCostUsers, projectedCost } from "./clientCost.js";

const user = (client, cost_usd, extra = {}) => ({
  client, user: "alice@example.test", cost_usd, cost_partial: false,
  cost_basis: client === "claude" ? "client_reported" : "aws_list_estimate",
  sessions: 1, observed_tokens: 100, tokens_partial: false, ...extra,
});

test("shared user costs combine exact IDs, retain client amounts and never add model sessions", () => {
  const users = [user("claude", 2), user("codex", 3)];
  const models = [
    { ...users[0], model: "a", cost_usd: 1 },
    { ...users[0], model: "b", cost_usd: 1 },
    { ...users[1], model: "c", cost_usd: 3 },
  ];
  const rows = combineCostUsers(users, models, ["claude", "codex"]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ cost_usd: 5, claude_cost: 2, codex_cost: 3,
    sessions: 2, observed_tokens: 200, cost_partial: false });
  expect(rows[0].models.claude.map(row => row.model)).toEqual(["a", "b"]);
  expect(rows[0].cost_basis_label).toContain("클라이언트 보고");
  expect(rows[0].cost_basis_label).toContain("AWS 정가 추정");
});

test("known user subtotals preserve missing client costs and token coverage", () => {
  const rows = combineCostUsers([user("claude", null, { observed_tokens: null }),
    user("codex", 0.000001)], [], ["claude", "codex"]);
  expect(rows[0]).toMatchObject({ cost_usd: 0.000001, cost_partial: true,
    claude_cost: null, codex_cost: 0.000001, claude_cost_status: "미산정",
    codex_cost_status: "확인됨", observed_tokens: 100, tokens_partial: true });
  expect(combineCostUsers([user("claude", null), user("codex", null)], [], ["claude", "codex"])[0].cost_usd).toBeNull();
  expect(combineCostUsers([user("claude", 0), user("codex", null)], [{ ...user("claude", 0), model: "a" }], ["claude", "codex"])[0].cost_usd).toBe(0);
});

test("operational-only parts without usage-backed model rows never establish a known zero", () => {
  const users = [user("claude", 0, { observed_tokens: 0 }), user("codex", null, { observed_tokens: null })];
  const row = combineCostUsers(users, [{ ...users[1], model: "openai.unpriced" }], ["claude", "codex"])[0];
  expect(row.cost_usd).toBeNull();
  expect(row.cost_partial).toBe(true);
  expect(row.observed_tokens).toBeNull();
  expect(row.claude_cost).toBeNull();
  // Without a breakdown (older responses) the server totals are used unchanged.
  expect(combineCostUsers(users, undefined, ["claude", "codex"])[0].cost_usd).toBe(0);
  // Positive amounts survive even without backed rows.
  expect(combineCostUsers([user("claude", 2)], [], ["claude"])[0].cost_usd).toBe(2);
});

test("missing IDs remain separate by client; selection and exact raw identities are preserved", () => {
  const rows = combineCostUsers([user("claude", 2, { user: "" }), user("codex", 3, { user: "" }),
    user("codex", 9, { user: "Alice@example.test" }), user("codex", 4)],
  [], ["claude", "codex"]);
  expect(rows).toHaveLength(4);
  expect(rows.filter(row => !row.user)).toHaveLength(2);
  const selected = combineCostUsers([user("claude", 2), user("codex", 3)], [], ["codex"]);
  expect(selected[0].cost_usd).toBe(3);
  expect(selected[0].claude_cost).toBeNull();
  expect(selected[0].models).toEqual({});
});

test("30-day extrapolation uses actual effective duration and preserves unavailable/zero", () => {
  const bounds = { from: "2026-09-01T00:00:00Z", to: "2026-09-01T12:00:00Z" };
  expect(projectedCost(2, bounds)).toBe(120);
  expect(projectedCost(0, bounds)).toBe(0);
  expect(projectedCost(null, bounds)).toBeNull();
  expect(projectedCost(2, undefined)).toBeNull();
  expect(projectedCost(2, { from: bounds.to, to: bounds.from })).toBeNull();
});

test("combined observed tokens reject unsafe sums without losing known costs", () => {
  const result = combineCostUsers([user("claude", 2, { observed_tokens: Number.MAX_SAFE_INTEGER }),
    user("codex", 3)], [], ["claude", "codex"])[0];
  expect(result.observed_tokens).toBeNull();
  expect(result.tokens_partial).toBe(true);
  expect(result.cost_usd).toBe(5);
});

test("user cost channels split Claude by inferred channel and keep Codex as the client", async () => {
  const { userCostChannel, userChannelLines } = await import("./clientCost.js");
  expect(userCostChannel({ client: "claude", backend: "anthropic" })).toBe("c4e");
  expect(userCostChannel({ client: "claude", backend: "bedrock-runtime" })).toBe("ccb");
  expect(userCostChannel({ client: "claude", backend: "bedrock-mantle" })).toBe("ccb");
  expect(userCostChannel({ client: "claude", backend: "unknown" })).toBe("claude_unknown");
  // Never infer a client from an OpenAI-style model name.
  expect(userCostChannel({ client: "claude", backend: "bedrock-mantle", model: "openai.gpt-6-sol" })).toBe("ccb");
  expect(userCostChannel({ client: "codex", backend: "bedrock-runtime" })).toBe("codex");
  // The session channel wins over a model-derived backend (bare model ids on Bedrock).
  expect(userCostChannel({ client: "claude", backend: "unknown", channel: "bedrock" })).toBe("ccb");
  expect(userCostChannel({ client: "claude", backend: "anthropic", channel: "enterprise" })).toBe("c4e");
  expect(userCostChannel({ client: "claude", backend: "bedrock-runtime", channel: "unknown" })).toBe("ccb");
  expect(userCostChannel({ client: "claude", backend: "unknown", channel: "unknown" })).toBe("claude_unknown");
  const lines = userChannelLines({
    claude: [
      { client: "claude", backend: "anthropic", model: "claude-opus-5-5", cost_usd: 2 },
      { client: "claude", backend: "anthropic", model: "claude-opus-5-5", cost_usd: 1, cost_partial: true },
      { client: "claude", backend: "bedrock-runtime", model: "global.anthropic.claude-sonnet-5", cost_usd: 0 },
      { client: "claude", backend: "unknown", model: "claude-haiku-4-5", cost_usd: null },
    ],
    codex: [{ client: "codex", backend: "bedrock-mantle", model: "openai.gpt-6.1-sol", cost_usd: 0.5 },
      { client: "codex", backend: "bedrock-mantle", model: "openai.unpriced", cost_usd: null }],
  });
  expect(lines.map((line) => line.key)).toEqual(["ccb", "c4e", "claude_unknown", "codex"]);
  const [ccb, c4e, unknown, codex] = lines;
  expect(ccb).toMatchObject({ total: 0, partial: false, segs: [] });
  expect(c4e).toMatchObject({ total: 3, partial: true, segs: [{ model: "claude-opus-5-5", value: 3 }] });
  expect(unknown).toMatchObject({ total: null, partial: false, segs: [] });
  expect(codex).toMatchObject({ total: 0.5, partial: true, segs: [{ model: "openai.gpt-6.1-sol", value: 0.5 }] });
});
