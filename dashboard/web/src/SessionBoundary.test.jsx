import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import SessionBoundary from "./SessionBoundary.jsx";
import { ConfigProvider } from "./ConfigContext.jsx";
import { AccountMenu } from "./components/AccountMenu.jsx";
import ConfigBootstrap from "./ConfigBootstrap.jsx";
import { apiGet } from "./api.js";
import { FreshnessProvider } from "./FreshnessContext.jsx";
import { streamChat } from "./useChatStream.js";

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

test("freshness and chat 401 responses also remove session views", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401, ok: false,
    json: async () => ({ error: "authentication_required" }) }));
  render(settings(session(), <SessionBoundary><FreshnessProvider><div>private fixture data</div></FreshnessProvider></SessionBoundary>));
  await screen.findByRole("link", { name: "다시 로그인" });
  expect(screen.queryByText("private fixture data")).toBeNull();
  cleanup();
  render(settings(session(), <SessionBoundary><div>private fixture data</div></SessionBoundary>));
  await act(async () => {
    await expect(streamChat([], {})).rejects.toThrow("authentication_required");
  });
  expect(screen.queryByText("private fixture data")).toBeNull();
});

test("Basic challenge offers login retry without an unavailable OIDC route", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401, ok: false,
    headers: { get: () => "Basic realm=fixture" } }));
  render(<ConfigBootstrap>{() => <div>private fixture data</div>}</ConfigBootstrap>);
  expect(await screen.findByRole("button", { name: "로그인 다시 확인" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "다시 로그인" })).toBeNull();
});

const persistentSession = (seconds = 60, refreshSeconds = 3600) => ({ ...session(seconds),
  refreshExpiresAt: new Date(Date.now() + refreshSeconds * 1000).toISOString() });
const successfulSession = body => ({ status: 200, ok: true, json: async () => body });
const advance = async ms => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

test("renewal with unchanged expiry retries and then applies new permissions without stalling", async () => {
  vi.useFakeTimers();
  const initial = persistentSession();
  const renewed = { ...initial, expiresAt: new Date(Date.now() + 660_000).toISOString(),
    role: "admin", permissions: ["telemetry:read", "chat:query", "installation:read"] };
  const fetcher = vi.fn().mockResolvedValueOnce(successfulSession(initial)).mockResolvedValueOnce(successfulSession(renewed));
  vi.stubGlobal("fetch", fetcher);
  render(settings(initial, <SessionBoundary><AccountMenu /><div>private fixture data</div></SessionBoundary>));
  await advance(30_000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await advance(4999);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.getByText("관리자")).toBeTruthy();
  await advance(30_000);
  expect(screen.getByText("private fixture data")).toBeTruthy();
  expect(screen.queryByText("로그인 상태 확인 중")).toBeNull();
});

test("server rollback or missing refresh credential removes renewal capability and expires normally", async () => {
  vi.useFakeTimers();
  const initial = persistentSession();
  const { refreshExpiresAt: _refresh, ...shortOnly } = initial;
  const fetcher = vi.fn().mockResolvedValue(successfulSession(shortOnly));
  vi.stubGlobal("fetch", fetcher);
  render(settings(initial, <SessionBoundary><div>private fixture data</div></SessionBoundary>));
  await advance(30_000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await advance(30_001);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("private fixture data")).toBeNull();
  expect(screen.getByRole("link", { name: "다시 로그인" })).toBeTruthy();
});

test("temporary renewal failures hide expired content and recover on the bounded retry", async () => {
  vi.useFakeTimers();
  const initial = persistentSession(31);
  const fetcher = vi.fn().mockResolvedValue({ status: 503, ok: false });
  vi.stubGlobal("fetch", fetcher);
  render(settings(initial, <SessionBoundary><div>private fixture data</div></SessionBoundary>));
  await advance(31_001);
  expect(screen.queryByText("private fixture data")).toBeNull();
  expect(screen.getByText("로그인 상태 확인 중")).toBeTruthy();
  expect(screen.getByText(/인증 서버에 연결하지 못했습니다/)).toBeTruthy();
  fetcher.mockResolvedValue(successfulSession({ ...initial, expiresAt: new Date(Date.now() + 600_000).toISOString() }));
  await advance(5000);
  expect(screen.getByText("private fixture data")).toBeTruthy();
});

test("absolute refresh expiry ends repeated same-expiry responses without a request loop", async () => {
  vi.useFakeTimers();
  const initial = persistentSession(20, 20);
  const fetcher = vi.fn().mockResolvedValue(successfulSession(initial));
  vi.stubGlobal("fetch", fetcher);
  render(settings(initial, <SessionBoundary><div>private fixture data</div></SessionBoundary>));
  await advance(20_001);
  expect(fetcher.mock.calls.length).toBeLessThanOrEqual(4);
  expect(screen.queryByText("private fixture data")).toBeNull();
  expect(screen.getByRole("link", { name: "다시 로그인" })).toBeTruthy();
});

test("renewal 401 immediately removes data and never retries expired credentials", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValue({ status: 401, ok: false });
  vi.stubGlobal("fetch", fetcher);
  render(settings(persistentSession(), <SessionBoundary><div>private fixture data</div></SessionBoundary>));
  await advance(30_000);
  expect(screen.queryByText("private fixture data")).toBeNull();
  expect(screen.getByRole("link", { name: "다시 로그인" })).toBeTruthy();
  await advance(60_000);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("focus events share an in-flight renewal and cleanup aborts it", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetcher);
  const { unmount } = render(settings(persistentSession(), <SessionBoundary><div>private fixture data</div></SessionBoundary>));
  await advance(30_000);
  fireEvent(window, new Event("focus"));
  fireEvent(document, new Event("visibilitychange"));
  expect(fetcher).toHaveBeenCalledTimes(1);
  const signal = fetcher.mock.calls[0][1].signal;
  expect(signal.aborted).toBe(false);
  unmount();
  expect(signal.aborted).toBe(true);
  await advance(60_000);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
