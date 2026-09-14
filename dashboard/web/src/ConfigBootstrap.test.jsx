import { StrictMode, useEffect, useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import ConfigBootstrap from "./ConfigBootstrap.jsx";
import { ConfigProvider, useConfig } from "./ConfigContext.jsx";
import { maskEmail, setPiiMask } from "./fmt.js";

const EMAIL = "fixture@example.test";
const CODEX_CONFIG = { enabledClients: ["codex"], groupMode: "single", schema: { projectColumns: true } };
const response = (config) => ({ ok: true, json: async () => config });
let fetchMock;
let initialUrl;

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function ChildProbe({ config }) {
  const settings = useConfig();
  const [firstPaintEmail] = useState(() => maskEmail(EMAIL));
  useEffect(() => {
    window.history.replaceState(null, "", "/?route-mounted=1");
    fetch("/api/route-probe");
  }, []);
  return (
    <>
      <output aria-label="received config">{JSON.stringify(config)}</output>
      <output aria-label="settings">{JSON.stringify(settings)}</output>
      <output aria-label="first paint email">{firstPaintEmail}</output>
    </>
  );
}

function renderBootstrap({ strict = false } = {}) {
  const gate = (
    <ConfigBootstrap>
      {(config) => <ConfigProvider config={config}><ChildProbe config={config} /></ConfigProvider>}
    </ConfigBootstrap>
  );
  return render(strict ? <StrictMode>{gate}</StrictMode> : gate);
}

function expectBlocked(configRequests = 1) {
  expect(screen.queryByLabelText("received config")).toBeNull();
  expect(window.location.href).toBe(initialUrl);
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(Array(configRequests).fill("/api/config"));
  expect(maskEmail(EMAIL)).toBe("fi******@example.test");
}

beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/cost?client=codex&days=7#details");
  initialUrl = window.location.href;
  // A new bootstrap must restore safe defaults even after an unmasked app.
  setPiiMask(false);
  fetchMock = vi.fn(() => Promise.resolve(response([])));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  setPiiMask(true);
});

test("pending config shows Korean loading without mounting children or changing the URL", async () => {
  fetchMock.mockReturnValueOnce(new Promise(() => {}));
  renderBootstrap();
  expect(screen.getByRole("status").textContent).toMatch(/설정.*불러오는 중/);
  await act(async () => {});
  expectBlocked();
  expect(screen.queryByRole("button")).toBeNull();
});

test.each([
  ["network failure", () => Promise.reject(new TypeError(EMAIL))],
  ["HTTP failure", () => Promise.resolve({ ok: false, status: 503, json: async () => ({ piiMask: false }) })],
  ["invalid JSON", () => Promise.resolve({ ok: true, json: async () => { throw new SyntaxError(EMAIL); } })],
])("%s remains unknown with a safe retry UI", async (_name, result) => {
  fetchMock.mockImplementationOnce(result);
  renderBootstrap();
  await act(async () => {});
  expectBlocked();
  expect(screen.getByRole("alert").textContent).toMatch(/설정/);
  expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
  expect(document.body.textContent).not.toContain(EMAIL);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  ["null", null],
  ["array", []],
  ["string", "claude"],
  ["number", 42],
  ["boolean", false],
  ["null enabledClients", { enabledClients: null, piiMask: false }],
  ["non-array enabledClients", { enabledClients: "codex", piiMask: false }],
  ["empty enabledClients", { enabledClients: [], piiMask: false }],
  ["blank client", { enabledClients: [" "], piiMask: false }],
  ["non-string client", { enabledClients: ["codex", false], piiMask: false }],
  ["unsupported client", { enabledClients: ["other"], piiMask: false }],
  ["untrimmed client", { enabledClients: [" codex "], piiMask: false }],
  ["duplicate client", { enabledClients: ["codex", "codex"], piiMask: false }],
])("malformed config (%s) cannot initialize defaults or disable masking", async (_name, config) => {
  fetchMock.mockResolvedValueOnce(response(config));
  renderBootstrap();
  await act(async () => {});
  expectBlocked();
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
});

test("retry passes a valid Codex-only config unchanged and mounts without reloading", async () => {
  fetchMock.mockRejectedValueOnce(new TypeError("Offline"));
  const { container } = renderBootstrap();
  await act(async () => {});
  expectBlocked();
  const retry = deferred();
  fetchMock.mockReturnValueOnce(retry.promise);
  const button = screen.getByRole("button", { name: "다시 시도" });
  await act(async () => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  expect(screen.getByRole("status")).toBeTruthy();
  expectBlocked(2);
  await act(async () => { retry.resolve(response(CODEX_CONFIG)); });

  expect(JSON.parse(screen.getByLabelText("received config").textContent)).toEqual(CODEX_CONFIG);
  expect(screen.getByLabelText("first paint email").textContent).toBe("fi******@example.test");
  expect(container.isConnected).toBe(true);
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/config", "/api/config", "/api/route-probe"]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["request", "body"])("a stalled %s times out, and its late success cannot win a retry", async (stage) => {
  const stale = deferred();
  fetchMock.mockReturnValueOnce(stage === "request"
    ? stale.promise
    : Promise.resolve({ ok: true, json: () => stale.promise }));
  renderBootstrap();
  await act(async () => {});
  const originalSignal = fetchMock.mock.calls[0][1].signal;
  await act(async () => { vi.advanceTimersByTime(2_999); });
  expect(screen.getByRole("status")).toBeTruthy();
  expectBlocked();
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(screen.getByRole("alert").textContent).toMatch(/시간.*초과/);
  expect(originalSignal.aborted).toBe(true);
  expectBlocked();

  const retry = deferred();
  fetchMock.mockReturnValueOnce(retry.promise);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "다시 시도" })); });
  const obsolete = { enabledClients: ["claude"], piiMask: false };
  await act(async () => { stale.resolve(stage === "request" ? response(obsolete) : obsolete); });
  expect(screen.getByRole("status")).toBeTruthy();
  expectBlocked(2);
  await act(async () => { retry.resolve(response(CODEX_CONFIG)); });
  expect(JSON.parse(screen.getByLabelText("received config").textContent)).toEqual(CODEX_CONFIG);
  await act(async () => { vi.advanceTimersByTime(10_000); });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

test("an obsolete rejection cannot replace a successful retry", async () => {
  const stale = deferred();
  fetchMock.mockReturnValueOnce(stale.promise);
  renderBootstrap();
  await act(async () => {});
  await act(async () => { vi.advanceTimersByTime(3_000); });
  fetchMock.mockResolvedValueOnce(response(CODEX_CONFIG));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "다시 시도" })); });
  await act(async () => { stale.reject(new TypeError("Late failure")); });
  expect(JSON.parse(screen.getByLabelText("received config").textContent)).toEqual(CODEX_CONFIG);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a successful legacy object without enabledClients retains safe provider defaults", async () => {
  fetchMock.mockResolvedValueOnce(response({}));
  renderBootstrap();
  await act(async () => {});
  expect(JSON.parse(screen.getByLabelText("received config").textContent)).toEqual({});
  expect(JSON.parse(screen.getByLabelText("settings").textContent)).toEqual({
    groupMode: "ab", defaultRangeDays: 2, rangeCapDays: 90, piiMask: true,
    enabledClients: ["claude"], codexEndpoint: "mantle",
  });
  expect(screen.getByLabelText("first paint email").textContent).toBe("fi******@example.test");
});

test.each([true, null, "false", 0, false])("piiMask=%s is applied safely before the first child render", async (piiMask) => {
  fetchMock.mockResolvedValueOnce(response({ piiMask }));
  renderBootstrap();
  await act(async () => {});
  expect(screen.getByLabelText("first paint email").textContent).toBe(piiMask === false ? EMAIL : "fi******@example.test");
  expect(JSON.parse(screen.getByLabelText("settings").textContent).piiMask).toBe(piiMask !== false);
});

test("StrictMode sends one config request and cleanup aborts it without late side effects", async () => {
  const pending = deferred();
  fetchMock.mockReturnValueOnce(pending.promise);
  const { unmount } = renderBootstrap({ strict: true });
  await act(async () => {});
  expectBlocked();
  const signal = fetchMock.mock.calls[0][1].signal;
  expect(signal.aborted).toBe(false);
  unmount();
  expect(signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => { pending.resolve(response({ piiMask: false })); });
  expectBlocked();
});
