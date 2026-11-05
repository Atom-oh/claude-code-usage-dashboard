import { test } from "node:test";
import assert from "node:assert/strict";
import { createFailedAuthLimiter } from "./rateLimit.js";

test("a full failure table never denies an address that has not failed", () => {
  let time = 0;
  const limiter = createFailedAuthLimiter({ max: 2, capacity: 2, now: () => time });
  limiter.failed("a"); limiter.failed("a");
  limiter.failed("b"); limiter.failed("b");
  assert.ok(limiter.retryAfter("a") > 0);
  assert.equal(limiter.retryAfter("new-address"), 0, "an untracked address is admitted at capacity");
});

test("recording into a full table evicts the oldest entry and keeps limiting the new address", () => {
  let time = 0;
  const limiter = createFailedAuthLimiter({ max: 2, capacity: 2, now: () => time });
  limiter.failed("a"); limiter.failed("b");
  limiter.failed("c"); limiter.failed("c");
  assert.ok(limiter.retryAfter("c") > 0, "the newest failing address is limited");
  assert.equal(limiter.retryAfter("a"), 0, "the oldest entry was evicted");
});

test("expired entries are evicted before older live ones", () => {
  let time = 0;
  const limiter = createFailedAuthLimiter({ max: 1, capacity: 2, windowMs: 1000, now: () => time });
  limiter.failed("old");
  time = 500; limiter.failed("live");
  time = 1001; limiter.failed("new");
  assert.ok(limiter.retryAfter("live") > 0, "a live entry survives when an expired one can be evicted");
  assert.ok(limiter.retryAfter("new") > 0);
});
