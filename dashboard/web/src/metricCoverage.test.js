import { expect, test } from "vitest";
import { sumObservedMetric } from "./metricCoverage.js";

test("counter totals distinguish measured zero, absent channels and unsafe values", () => {
  expect(sumObservedMetric([], "prs")).toBeNull();
  expect(sumObservedMetric([{ prs: 0, prs_observed: 0 }], "prs")).toBeNull();
  expect(sumObservedMetric([{ prs: 0, prs_observed: 1 }], "prs")).toBe(0);
  expect(sumObservedMetric([{ prs: "2", prs_observed: true }, { prs: 3, prs_observed: 1 }], "prs")).toBe(5);
  expect(sumObservedMetric([{ prs: 2, prs_observed: 1 }, { prs: 0, prs_observed: 0 }], "prs")).toBeNull();
  for (const prs of [null, undefined, Infinity, -1, "", " ", false]) {
    expect(sumObservedMetric([{ prs, prs_observed: 1 }], "prs")).toBeNull();
  }
});
