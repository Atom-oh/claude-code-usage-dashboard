import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfigProvider } from "../ConfigContext.jsx";
import { MemoryRouter } from "react-router-dom";
import Installation from "./Installation.jsx";
import App from "../App.jsx";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const permissions = ["installation:read", "telemetry:read", "chat:query"];
const renderPage = (role = "admin") => render(<ConfigProvider config={{ session: {
  mode: "oidc", role, permissions: role === "admin" ? permissions : ["telemetry:read"],
  expiresAt: new Date(Date.now() + 900000).toISOString(),
} }}><Installation /></ConfigProvider>);
const fixture = {
  checkedAt: "2026-10-12T12:00:00Z", state: "needs_attention", release: { version: "1.0.0", revision: null },
  authentication: { state: "oidc_configured" }, database: { state: "reachable", readonly: "confirmed" },
  schema: { migrations: [], counterIdentity: "unavailable", projectFields: "unconfirmed" },
  clients: [{ client: "claude", state: "empty", latest: null }, { client: "codex", state: "unavailable", latest: null }],
  staleAfterMinutes: 360,
};
const response = data => ({ ok: true, status: 200, json: async () => data });

test("non-admin installation views never make diagnostic requests", () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  renderPage("viewer");
  expect(screen.getByRole("alert").textContent).toContain("조직 관리자만");
  expect(fetch).not.toHaveBeenCalled();
});

test("admin sees empty versus unavailable, missing release identity and schema limits", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(fixture)));
  renderPage();
  expect(await screen.findByText("최근 7일 수신 없음")).toBeTruthy();
  expect(screen.getAllByText("확인 불가").length).toBeGreaterThan(0);
  expect(screen.getByText(/릴리스 식별자 미확인/)).toBeTruthy();
  expect(screen.getByText(/이력만으로 실제 DDL/)).toBeTruthy();
  expect(screen.getByText(/사용량 0으로 해석할 수 없습니다/)).toBeTruthy();
});

test("failed refresh labels retained data as previous and permits retry", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response(fixture)).mockResolvedValueOnce({ ok: false, status: 500 })
    .mockResolvedValue(response({ ...fixture, state: "operational" }));
  vi.stubGlobal("fetch", fetch);
  renderPage();
  await screen.findByText("최근 7일 수신 없음");
  fireEvent.click(screen.getByRole("button", { name: "상태 새로고침" }));
  expect((await screen.findByRole("alert")).textContent).toContain("이전 확인 결과");
  expect(screen.getByText("최근 7일 수신 없음")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "상태 새로고침" }));
  expect(await screen.findByText("현재 연결·수신 상태가 확인되었습니다.")).toBeTruthy();
});

test("installation route survives client normalization and hides usage filters/chat", async () => {
  class Observer { observe() {} unobserve() {} disconnect() {} }
  vi.stubGlobal("ResizeObserver", Observer);
  vi.stubGlobal("fetch", vi.fn(url => Promise.resolve(response(String(url).startsWith("/api/installation")
    ? fixture : String(url).startsWith("/api/health/data") ? { status: "ok" } : []))));
  render(<MemoryRouter initialEntries={["/installation?client=all"]}><ConfigProvider config={{
    enabledClients: ["claude", "codex"], session: { mode: "basic", role: "admin", permissions },
  }}><App /></ConfigProvider></MemoryRouter>);
  expect(await screen.findByText("최근 7일 수신 없음")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Ask Claude" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "클라이언트" })).toBeNull();
  expect(screen.getByRole("link", { name: /설치 상태/ }).getAttribute("href")).toContain("/installation");
  await waitFor(() => expect(document.title).toBe("설치 상태 · AI 사용량 대시보드"));
});
