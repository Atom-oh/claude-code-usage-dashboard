import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { CLIENT_PAGES } from "./clientNavigation.js";
import { LATEST_RELEASE, RELEASES, SEEN_KEY, hasUnseenRelease, markSeen, releaseLink, seenVersion } from "./releaseNotes.js";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const parts = (v) => v.split(".").map(Number);
const newer = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
const readJson = (path) => JSON.parse(readFileSync(resolve(path), "utf8"));
// vitest runs with dashboard/web as the working directory.
const changelog = readFileSync(resolve("../../CHANGELOG.md"), "utf8");
const releasedHeadings = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/gm)]
  .map(([, version, date]) => ({ version, date }));

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)) };
}

test("releases are unique semver versions, newest first, with ISO dates", () => {
  expect(RELEASES.length).toBeGreaterThan(0);
  expect(LATEST_RELEASE).toBe(RELEASES[0]);
  for (const [i, release] of RELEASES.entries()) {
    expect(release.version).toMatch(SEMVER);
    expect(release.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(`${release.date}T00:00:00Z`))).toBe(false);
    if (i > 0) {
      expect(newer(RELEASES[i - 1].version, release.version)).toBe(true);
      expect(RELEASES[i - 1].date >= release.date).toBe(true);
    }
  }
});

test("the latest release matches both package versions", () => {
  // A release bumps web and server together (docs/runbooks/releases.md).
  for (const path of ["package.json", "package-lock.json", "../server/package.json", "../server/package-lock.json"]) {
    expect([path, readJson(path).version]).toEqual([path, LATEST_RELEASE.version]);
  }
});

test("every in-app release has the same version and date in CHANGELOG.md, in the same order", () => {
  expect(changelog).toMatch(/^## \[Unreleased\]$/m);
  expect(releasedHeadings.slice(0, RELEASES.length))
    .toEqual(RELEASES.map(({ version, date }) => ({ version, date })));
  // Unreleased stays above the newest version heading.
  expect(changelog.indexOf("## [Unreleased]")).toBeLessThan(changelog.indexOf(`## [${LATEST_RELEASE.version}]`));
});

test("items have a known kind, Korean copy, PR references and reachable routes", () => {
  const routes = new Set(CLIENT_PAGES.map((p) => p.to));
  for (const release of RELEASES) {
    expect(release.items.length).toBeGreaterThan(0);
    for (const item of release.items) {
      expect(["new", "improved", "fixed"]).toContain(item.kind);
      for (const text of [item.title, item.body]) expect(text).toMatch(/[가-힣]/);
      expect(item.where.length).toBeGreaterThan(0);
      expect(item.refs.every((n) => Number.isInteger(n) && n > 0)).toBe(true);
      if (item.to === null) expect(item.detail).toBeUndefined();
      else expect(routes.has(item.to)).toBe(true);
    }
  }
});

test("links keep the shared client selection or switch to Claude detail", () => {
  const shared = { to: "/users" };
  const detail = { to: "/cost", detail: true };
  expect(releaseLink(shared, "?client=codex&view=detail&group=a&project=p&days=7", ["claude", "codex"]))
    .toEqual({ pathname: "/users", search: "?client=codex&days=7" });
  expect(releaseLink(detail, "?client=all&backend=bedrock&days=7", ["claude", "codex"]))
    .toEqual({ pathname: "/cost", search: "?client=claude&days=7&view=detail" });
  expect(releaseLink(shared, "", ["codex"])).toEqual({ pathname: "/users", search: "" });
  // Claude detail pages do not exist on a Codex-only installation.
  expect(releaseLink(detail, "", ["codex"])).toBeNull();
  expect(releaseLink({ to: null }, "?client=all", ["claude"])).toBeNull();
});

test("seen state survives missing or throwing storage", () => {
  const storage = memoryStorage();
  expect(hasUnseenRelease(storage)).toBe(true);
  markSeen(LATEST_RELEASE.version, storage);
  expect(storage.getItem(SEEN_KEY)).toBe(LATEST_RELEASE.version);
  expect(hasUnseenRelease(storage)).toBe(false);
  markSeen("0.0.1", storage);
  expect(hasUnseenRelease(storage)).toBe(true);

  const throwing = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceeded"); } };
  expect(seenVersion(throwing)).toBeNull();
  expect(() => markSeen(LATEST_RELEASE.version, throwing)).not.toThrow();
  expect(hasUnseenRelease(throwing)).toBe(true);
});
