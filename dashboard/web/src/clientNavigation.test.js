import { expect, test } from "vitest";
import { isDashboardPath, isTaskPath, parseTaskPath, taskSharePath } from "./clientNavigation.js";

const FROM = "2026-11-10T06:00:00.000Z", TO = "2026-11-10T07:00:00.000Z";

test("task share paths round-trip Claude and Codex ids without a user", () => {
  for (const id of ["claude:0123456789abcdef0123456789abcdef", "codex:019a-conv_1:019a5f3e-7c2b-7d41-9a3e-0f1e2d3c4b5a"]) {
    const path = taskSharePath(id, FROM, TO);
    const url = new URL(path, "https://dash.example");
    expect(url.pathname.startsWith("/tasks/")).toBe(true);
    expect(url.search).toBe("");
    expect(parseTaskPath(url.pathname)).toEqual({ id, from: FROM, to: TO });
    expect(isDashboardPath(url.pathname)).toBe(true);
  }
});

test("invalid task links are rejected", () => {
  expect(isTaskPath("/tasks/")).toBe(false);
  expect(isDashboardPath("/tasks/")).toBe(false);
  const enc = encodeURIComponent;
  expect(parseTaskPath(`/tasks/abc/x/y`)).toBeNull();
  expect(parseTaskPath(`/tasks/abc/${enc(TO)}/${enc(FROM)}`)).toBeNull();
  expect(parseTaskPath(`/tasks/abc/${enc(FROM)}`)).toBeNull();
  expect(parseTaskPath(`/tasks/abc/${enc(FROM)}/${enc(TO)}/extra`)).toBeNull();
  expect(parseTaskPath(`/tasks/abc/1/2`)).toBeNull();
  expect(parseTaskPath(`/tasks/%E0%A4%A/${enc(FROM)}/${enc(TO)}`)).toBeNull();
  expect(parseTaskPath(`/users/${enc(FROM)}/${enc(TO)}`)).toBeNull();
});
