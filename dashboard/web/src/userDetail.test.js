import { describe, expect, it } from "vitest";
import { claudeOnlyFields, combineUsers, heatmapDays } from "./userDetail.js";

const row = (over) => ({
  client: "claude", user: "alice@example.test", sessions: 1, cost_usd: 1,
  cost_partial: false, observed_tokens: 10, tokens_partial: false, ...over,
});

describe("combineUsers", () => {
  it("merges claude and codex rows of one user", () => {
    const rows = [
      row({ client: "claude", sessions: 3, observed_tokens: 100, cost_usd: 1.5 }),
      row({ client: "codex", sessions: 2, observed_tokens: null, cost_usd: 0.5 }),
    ];
    const [merged, ...rest] = combineUsers(rows, ["claude", "codex"]);
    expect(rest).toEqual([]);
    expect(merged).toMatchObject({
      user: "alice@example.test", clients: ["claude", "codex"], sessions: 5,
      observed_tokens: 100, tokens_partial: true, cost_usd: 2, cost_partial: false,
    });
    expect(merged.parts).toEqual(rows);
  });

  it("marks cost partial when one part is unknown or partial", () => {
    const [unknownPart] = combineUsers([row({ cost_usd: 2 }), row({ client: "codex", cost_usd: null })], ["claude", "codex"]);
    expect(unknownPart).toMatchObject({ cost_usd: 2, cost_partial: true });
    const [partialPart] = combineUsers([row({ cost_usd: 2, cost_partial: true }), row({ client: "codex", cost_usd: 1 })], ["claude", "codex"]);
    expect(partialPart).toMatchObject({ cost_usd: 3, cost_partial: true });
  });

  it("keeps all-unknown tokens, cost and sessions null", () => {
    const [merged] = combineUsers([
      row({ observed_tokens: null, cost_usd: null, sessions: null }),
      row({ client: "codex", observed_tokens: null, cost_usd: null, sessions: null }),
    ], ["claude", "codex"]);
    expect(merged).toMatchObject({ observed_tokens: null, tokens_partial: false, cost_usd: null, sessions: null });
  });

  it("keeps unidentified rows per client", () => {
    const out = combineUsers([row({ user: "" }), row({ user: "", client: "codex" })], ["claude", "codex"]);
    expect(out).toHaveLength(2);
    expect(out.map(r => r.clients)).toEqual([["claude"], ["codex"]]);
  });

  it("only includes selected clients", () => {
    const out = combineUsers([row(), row({ client: "codex" })], ["codex"]);
    expect(out).toHaveLength(1);
    expect(out[0].clients).toEqual(["codex"]);
  });
});

describe("heatmapDays", () => {
  it("groups by UTC day and keeps per-client values", () => {
    const days = heatmapDays([
      { client: "claude", t: "2026-09-01T23:00:00.000Z", sessions: 2 },
      { client: "claude", t: "2026-09-01T01:00:00.000Z", sessions: 1 },
      { client: "codex", t: "2026-09-01T05:00:00.000Z", sessions: null },
      { client: "codex", t: "2026-09-02 00:00:00", sessions: 4 },
    ], ["claude", "codex"]);
    expect(days).toEqual([
      { day: "2026-09-01", sessions: 3, by_client: { claude: 3, codex: null } },
      { day: "2026-09-02", sessions: 4, by_client: { codex: 4 } },
    ]);
  });

  it("ignores unselected clients and unparsable timestamps", () => {
    const days = heatmapDays([
      { client: "claude", t: "2026-09-01T00:00:00Z", sessions: 2 },
      { client: "codex", t: "bad", sessions: 5 },
    ], ["claude", "codex"]);
    expect(days).toEqual([{ day: "2026-09-01", sessions: 2, by_client: { claude: 2 } }]);
    expect(heatmapDays([{ client: "claude", t: "2026-09-01T00:00:00Z", sessions: 2 }], ["codex"])).toEqual([]);
  });
});

describe("claudeOnlyFields", () => {
  it("handles codex-only, claude-only and both", () => {
    expect(claudeOnlyFields(["codex"])).toEqual({ show: false, codexUnavailable: true });
    expect(claudeOnlyFields(["claude"])).toEqual({ show: true, codexUnavailable: false });
    expect(claudeOnlyFields(["claude", "codex"])).toEqual({ show: true, codexUnavailable: true });
  });
});
