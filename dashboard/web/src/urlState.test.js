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
    // integer would let a link request a range the picker cannot represent. days=14/90 were
    // offered presets until the picker was cut to 1/2/7/30, so old links now fall back
    // exactly like days=3.
    for (const qs of ["days=abc", "days=0", "days=3", "days=14", "days=90", "days="]) {
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

  test("period=month round trip", () => {
    const p = serializeUrlState({
      range: { days: 7, custom: null, month: true },
      filters: {},
      piiMask: true,
    });
    expect(p.get("period")).toBe("month");
    expect(p.has("days")).toBe(false);
    const parsed = parseUrlState(p);
    expect(parsed.range.month).toBe(true);
  });

  test("period=garbage is not month", () => {
    const parsed = parseUrlState(new URLSearchParams("period=garbage"));
    expect(parsed.range.month).toBe(false);
  });

  test("from/to together with period=month -- custom wins", () => {
    const parsed = parseUrlState(
      new URLSearchParams("from=2026-08-01T00:00:00.000Z&to=2026-08-08T00:00:00.000Z&period=month")
    );
    expect(parsed.range.custom).not.toBe(null);
    expect(parsed.range.month).toBe(false);
  });

  test("custom range with both bounds on UTC midnight is a calendar pick", () => {
    const parsed = parseUrlState(
      new URLSearchParams("from=2026-09-01T00:00:00.000Z&to=2026-09-05T00:00:00.000Z")
    );
    expect(parsed.range.custom.source).toBe("calendar");
  });

  test("custom range with bounds off UTC midnight is a zoom pick", () => {
    const parsed = parseUrlState(
      new URLSearchParams("from=2026-09-01T03:15:00.000Z&to=2026-09-01T07:45:00.000Z")
    );
    expect(parsed.range.custom.source).toBe("zoom");
  });

  // project는 URL 왕복에 포함된다(이메일이 아니라 저장소 이름이라 piiMask와 무관). 비어 있으면
  // 다른 필터들과 같이 키 자체를 쓰지 않는다 — ?project= 가 링크에 남으면 필터가 걸린 것처럼
  // 읽힌다.
  test("project round-trips through the URL and is omitted when empty", () => {
    const p = serializeUrlState({
      range: { days: 7, custom: null },
      filters: { group: "", user: "", model: "", project: "repo-a" },
      piiMask: true,
    });
    expect(p.get("project")).toBe("repo-a");
    expect(parseUrlState(p).filters.project).toBe("repo-a");

    const empty = serializeUrlState({
      range: { days: 7, custom: null },
      filters: { group: "", user: "", model: "", project: "" },
      piiMask: true,
    });
    expect(empty.has("project")).toBe(false);
    expect(parseUrlState(empty).filters.project).toBe("");
  });
});
