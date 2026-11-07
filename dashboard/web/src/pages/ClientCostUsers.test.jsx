import { expect, test } from "vitest";
import { render, within } from "@testing-library/react";
import { CostUsers, channelTotalsText } from "./ClientCostUsers.jsx";
import { userChannelLines } from "../clientCost.js";

const user = (client, cost_usd, extra = {}) => ({ client, user: "alice@example.test", cost_usd,
  cost_basis: client === "claude" ? "client_reported" : "aws_list_estimate", sessions: 1,
  observed_records: 1, input_tokens: 10, output_tokens: 5, ...extra });
const model = (client, backend, name, cost_usd) => ({ ...user(client, cost_usd), backend, model: name });
const users = [user("claude", 3), user("codex", 0.5)];
const models = [model("claude", "bedrock-runtime", "global.anthropic.claude-opus-5-5", 1),
  model("claude", "anthropic", "claude-sonnet-5", 2), model("codex", "bedrock-mantle", "openai.gpt-6.1-sol", 0.5)];

test("all view draws one channel line per CCB, C4E and Codex with a shared legend", () => {
  const { container } = render(<CostUsers users={users} modelRows={models} clients={["claude", "codex"]} onSelect={() => {}} />);
  const rows = container.querySelectorAll("tbody tr");
  expect(rows).toHaveLength(1);
  const labels = [...rows[0].querySelectorAll("[aria-label]")].map((node) => node.getAttribute("aria-label"));
  expect(labels).toEqual([
    "CCB $1 — global.anthropic.claude-opus-5-5 $1",
    "C4E $2 — claude-sonnet-5 $2",
    "Codex $0.5 — openai.gpt-6.1-sol $0.5",
  ]);
  const legend = container.querySelector("header, [class*='subtitle']") || container;
  for (const label of ["CCB", "C4E", "Codex"]) expect(within(legend).getAllByText(label).length).toBeGreaterThan(0);
  expect(container.querySelectorAll("th").length).toBe(8);
});

test("single-client views keep the same columns and never mention the other client", () => {
  const headers = (clients) => {
    const { container, unmount } = render(<CostUsers users={users} modelRows={models} clients={clients} onSelect={() => {}} />);
    const result = { headers: [...container.querySelectorAll("th")].map((th) => th.textContent), text: container.textContent };
    unmount();
    return result;
  };
  const all = headers(["claude", "codex"]), codex = headers(["codex"]), claude = headers(["claude"]);
  expect(codex.headers).toEqual(all.headers);
  expect(claude.headers).toEqual(all.headers);
  expect(codex.text).not.toMatch(/Claude Code|CCB|C4E/);
  expect(claude.text).not.toContain("Codex");
});

test("CSV text lists channel totals and keeps unavailable distinct from zero", () => {
  const lines = userChannelLines({ claude: [model("claude", "anthropic", "claude-sonnet-5", 0),
    model("claude", "unknown", "claude-sonnet-5", null)] });
  expect(channelTotalsText(lines)).toBe("C4E $0 · 미분류 미산정");
});
