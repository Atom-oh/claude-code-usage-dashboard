import { test, expect } from "vitest";
import { fetchWithCapacityRetry } from "./api.js";

const overloaded = () => new Response('{"code":"capacity_exhausted"}',
  { status: 503, headers: { "Retry-After": "1", "Content-Type": "application/json" } });

test("only coded capacity responses retry with bounded delay", async () => {
  const delays = [];
  let calls = 0;
  const response = await fetchWithCapacityRetry("/api/fixture", {}, {
    request: async () => ++calls === 1 ? overloaded() : new Response('{"tokens":0}'),
    wait: async delay => delays.push(delay), random: () => 0.5,
  });
  expect(calls).toBe(2);
  expect(delays).toEqual([1500]);
  expect(await response.json()).toEqual({ tokens: 0 });
});

test("generic errors, authentication and absent Retry-After never retry", async () => {
  for (const response of [new Response("error", { status: 500 }), new Response("auth", { status: 401 }),
    new Response("{}", { status: 503 }), new Response('{"code":"other"}', {
      status: 503, headers: { "Retry-After": "1" } })]) {
    let calls = 0;
    await fetchWithCapacityRetry("/api/fixture", {}, { request: async () => { calls++; return response; } });
    expect(calls).toBe(1);
  }
});

test("capacity retries stop after four attempts and abort cancels pending work", async () => {
  let calls = 0;
  const response = await fetchWithCapacityRetry("/api/fixture", {}, {
    request: async () => { calls++; return overloaded(); }, wait: async () => {}, random: () => 0,
  });
  expect(response.status).toBe(503);
  expect(calls).toBe(4);
  const controller = new AbortController();
  await expect(fetchWithCapacityRetry("/api/fixture", { signal: controller.signal }, {
    request: async () => overloaded(),
    wait: async () => { controller.abort(); controller.signal.throwIfAborted(); },
  })).rejects.toHaveProperty("name", "AbortError");
});
