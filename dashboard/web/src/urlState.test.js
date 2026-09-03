import { describe, expect, test } from "vitest";
import { parseUrlState, serializeUrlState } from "./urlState.js";

describe("urlState", () => {
  test("round trip, preset", () => {
    const p = serializeUrlState({
      range: { days: 7, custom: null },
      filters: { group: "bedrock", user: "", model: "claude-sonnet-5" },
      piiMask: false,
    });
    const parsed = parseUrlState(p);
    expect(parsed.range.days).toBe(7);
    expect(parsed.range.custom).toBe(null);
    expect(parsed.filters.group).toBe("bedrock");
    expect(parsed.filters.model).toBe("claude-sonnet-5");
  });

  test("round trip, custom range", () => {
    const from = new Date("2026-08-01T00:00:00.000Z");
    const to = new Date("2026-08-08T00:00:00.000Z");
    const p = serializeUrlState({
      range: { days: 2, custom: { from, to } },
      filters: { group: "", user: "", model: "" },
      piiMask: true,
    });
    const parsed = parseUrlState(p, { defaultDays: 2 });
    // expect(dateA).toBe(dateB) fails for two distinct Date instances holding the same
    // instant -- compare getTime() instead.
    expect(parsed.range.custom.from.getTime()).toBe(from.getTime());
    expect(parsed.range.custom.to.getTime()).toBe(to.getTime());
    expect(parsed.range.days).toBe(2);
  });

  test("URL beats the config default", () => {
    const parsed = parseUrlState(new URLSearchParams("days=30"), { defaultDays: 2 });
    expect(parsed.range.days).toBe(30);
  });

  test("garbage falls back to the default", () => {
    // days=3 is a valid integer that is not an offered preset -- accepting an arbitrary
    // integer would let a link request a range the picker cannot represent.
    for (const qs of ["days=abc", "days=0", "days=3", "days="]) {
      const parsed = parseUrlState(new URLSearchParams(qs), { defaultDays: 2 });
      expect(parsed.range.days).toBe(2);
    }
  });

  test("half a custom range is not a custom range", () => {
    const cases = [
      "from=2026-08-01T00:00:00.000Z",
      "to=2026-08-08T00:00:00.000Z",
      "from=2026-08-08T00:00:00.000Z&to=2026-08-01T00:00:00.000Z",
    ];
    for (const qs of cases) {
      const parsed = parseUrlState(new URLSearchParams(qs));
      expect(parsed.range.custom).toBe(null);
    }
  });

  test("empty filters are omitted, not written as empty", () => {
    const p = serializeUrlState({
      range: { days: 2, custom: null },
      filters: { group: "", user: "", model: "" },
      piiMask: false,
    });
    // p.get("group") === null would pass both for an absent key and for one written as "" --
    // only has() can tell those apart.
    expect(p.has("group")).toBe(false);
    expect(p.has("user")).toBe(false);
    expect(p.has("model")).toBe(false);
  });

  test("user is omitted from the URL while masking is on, written while it is off", () => {
    const masked = serializeUrlState({
      range: { days: 2, custom: null },
      filters: { group: "", user: "a@x.com", model: "" },
      piiMask: true,
    });
    expect(masked.has("user")).toBe(false);

    const unmasked = serializeUrlState({
      range: { days: 2, custom: null },
      filters: { group: "", user: "a@x.com", model: "" },
      piiMask: false,
    });
    expect(unmasked.get("user")).toBe("a@x.com");
  });

  test("user is dropped on the way in too, while masking is on", () => {
    const parsed = parseUrlState(new URLSearchParams("user=a%40x.com"), { piiMask: true });
    expect(parsed.filters.user).toBe("");
  });
});
