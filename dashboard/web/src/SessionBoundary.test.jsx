import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import SessionBoundary from "./SessionBoundary.jsx";
import { ConfigProvider } from "./ConfigContext.jsx";
import { AccountMenu } from "./components/AccountMenu.jsx";
import ConfigBootstrap from "./ConfigBootstrap.jsx";
import { apiGet } from "./api.js";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const settings = (session, child) => <ConfigProvider config={{ session }}>{child}</ConfigProvider>;
const session = (seconds = 900) => ({ mode: "oidc", name: "Fixture User", role: "viewer",
  permissions: ["telemetry:read"], expiresAt: new Date(Date.now() + seconds * 1000).toISOString() });

test("OIDC account shows current role and submits local logout without tokens", () => {
  const { container } = render(settings(session(), <AccountMenu />));
  expect(screen.getByText("Fi******")).toBeTruthy();
  expect(screen.queryByText("Fixture User")).toBeNull();
  expect(screen.getByText("조회")).toBeTruthy();
  const form = container.querySelector("form");
  expect(form.action.endsWith("/auth/logout")).toBe(true);
  expect(form.method).toBe("post");
  expect(form.querySelectorAll("input").length).toBe(0);
  expect(screen.getByRole("button", { name: "로그아웃" })).toBeTruthy();
});

test("legacy and Basic authentication have no pretend logout control", () => {
  const { container } = render(settings({ mode: "basic", role: "admin" }, <AccountMenu />));
  expect(container.innerHTML).toBe("");
});

test("session expiration removes loaded data and offers login", () => {
  vi.useFakeTimers();
  render(settings(session(1), <SessionBoundary><div>private fixture data</div></SessionBoundary>));
  expect(screen.getByText("private fixture data")).toBeTruthy();
  act(() => vi.advanceTimersByTime(1001));
  expect(screen.queryByText("private fixture data")).toBeNull();
  expect(screen.getByRole("link", { name: "다시 로그인" }).getAttribute("href")).toBe("/auth/login");
});

test("an API 401 clears the OIDC view; transient 500 does not expire the session", async () => {
  render(settings(session(), <SessionBoundary><div>private fixture data</div></SessionBoundary>));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ status: 500, ok: false })
    .mockResolvedValueOnce({ status: 401, ok: false }));
  await expect(apiGet("/api/data")).rejects.toThrow("500");
  expect(screen.getByText("private fixture data")).toBeTruthy();
  await act(async () => { await expect(apiGet("/api/data")).rejects.toThrow("401"); });
  expect(screen.queryByText("private fixture data")).toBeNull();
});

test("malformed OIDC expiration fails closed and Basic views preserve behavior", () => {
  const { rerender } = render(settings({ ...session(), expiresAt: "bad" },
    <SessionBoundary><div>private fixture data</div></SessionBoundary>));
  expect(screen.queryByText("private fixture data")).toBeNull();
  rerender(settings({ mode: "basic" }, <SessionBoundary><div>private fixture data</div></SessionBoundary>));
  fireEvent(window, new Event("ccdash:authentication-required"));
  expect(screen.getByText("private fixture data")).toBeTruthy();
});

test("config bootstrap distinguishes expired login from a connection error", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401, ok: false }));
  render(<ConfigBootstrap>{() => <div>private fixture data</div>}</ConfigBootstrap>);
  expect(await screen.findByRole("link", { name: "다시 로그인" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
  expect(screen.queryByText("private fixture data")).toBeNull();
});
