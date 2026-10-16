import { test } from "node:test";
import assert from "node:assert/strict";
import { createWarmingPlan } from "./warming.js";

test("default warming covers shared full and cost keys without unused legacy queries", () => {
  const plan = createWarmingPlan();
  const handler = () => {};
  plan.register("/api/clients/overview", handler);
  plan.register("/api/users/leaderboard", handler);
  assert.deepEqual(plan.jobs().map(job => [job.path, job.params]), [
    ["/api/clients/overview", {}],
    ["/api/clients/overview", { view: "cost", modelTime: "1", timeFormat: "compact" }],
  ]);
});

test("legacy routes warm only after unfiltered demand and expire without weakening handlers", () => {
  let clock = 0;
  const plan = createWarmingPlan({ now: () => clock });
  const handler = () => {};
  plan.register("/api/cost/summary", handler);
  plan.requested("/api/cost/summary", { user: "fixture" });
  assert.deepEqual(plan.jobs(), []);
  plan.requested("/api/cost/summary", {});
  assert.equal(plan.jobs()[0].handler, handler);
  clock = 600_000;
  assert.deepEqual(plan.jobs(), []);
});

test("snapshot/disabled/unregistered paths cannot create background work", () => {
  const plan = createWarmingPlan();
  plan.requested("/api/installation", {});
  assert.deepEqual(plan.jobs(), []);
});

test("historical or custom ranges do not warm unrelated default windows", () => {
  const clock = Date.parse("2026-10-15T08:00:00Z");
  const plan = createWarmingPlan({ now: () => clock, defaultDays: 1 });
  plan.register("/api/cost/summary", () => {});
  plan.requested("/api/cost/summary", {
    from: "2026-10-13T00:00:00Z", to: "2026-10-14T00:00:00Z" });
  plan.requested("/api/cost/summary", {
    from: "2026-10-15T00:00:00Z", to: "2026-10-15T08:00:00Z" });
  assert.deepEqual(plan.jobs(), []);
  plan.requested("/api/cost/summary", {
    from: "2026-10-14T07:58:00Z", to: "2026-10-15T07:58:00Z" });
  assert.equal(plan.jobs().length, 1);
});
