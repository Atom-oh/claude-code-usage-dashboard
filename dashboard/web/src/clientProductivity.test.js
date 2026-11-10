import { expect, test } from "vitest";
import { hasProductivityObservations } from "./clientProductivity.js";

const row = (extra) => ({ client: "claude", prompts: 0, tool_calls: 0, decisions_total: 0, ttft_samples: 0,
  permission_wait_samples: 0, activity_index_users: 0, top_users: [], active_user_seconds: null,
  active_cli_seconds: null, commits: null, prs: null, loc_added: null, loc_removed: null, ...extra });

test("productivity evidence includes counters observed at 0, waits and scored users", () => {
  expect(hasProductivityObservations({ by_client: [row({})] })).toBe(false);
  expect(hasProductivityObservations(null)).toBe(false);
  expect(hasProductivityObservations({ by_client: [row({ commits: 0 })] })).toBe(true);
  expect(hasProductivityObservations({ by_client: [row({ permission_wait_samples: 2 })] })).toBe(true);
  // Scored activity-index users alone are evidence (review follow-up on #242).
  expect(hasProductivityObservations({ by_client: [row({ activity_index_users: 1 })] })).toBe(true);
  expect(hasProductivityObservations({ by_client: [row({ top_users: [{ user: "a@example.test" }] })] })).toBe(true);
  // A Codex row whose top users are unavailable (null) is not evidence.
  expect(hasProductivityObservations({ by_client: [row({ client: "codex", top_users: null, activity_index_users: null })] })).toBe(false);
});
