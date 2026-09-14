import { useEffect } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { useConfig } from "./ConfigContext.jsx";

const bootstrap = vi.hoisted(() => ({ root: null }));
vi.mock("react-dom/client", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    createRoot: (...args) => (bootstrap.root = original.createRoot(...args)),
  };
});

// Mounting a route can immediately fetch data and normalize the URL.
vi.mock("./App.jsx", () => ({
  default: function RouteProbe() {
    const config = useConfig();
    useEffect(() => {
      window.history.replaceState(null, "", "/?client=claude");
      fetch("/api/overview");
    }, []);
    return <output aria-label="mounted app">{config.groupMode}</output>;
  },
}));

afterEach(() => {
  act(() => bootstrap.root?.unmount());
  bootstrap.root = null;
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

test("main keeps failed config unknown and retries before mounting the router and App", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  window.history.replaceState(null, "", "/cost?client=codex&days=7#details");
  const initialUrl = window.location.href;
  const fetchMock = vi.fn((url) => {
    if (url === "/api/config") return Promise.reject(new TypeError("Network unavailable"));
    return Promise.resolve({ ok: true, json: async () => [] });
  });
  vi.stubGlobal("fetch", fetchMock);

  await act(async () => { await import("./main.jsx"); });

  expect(window.location.href).toBe(initialUrl);
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/config"]);
  expect(screen.queryByLabelText("mounted app")).toBeNull();
  expect(screen.getByRole("alert").textContent).toMatch(/설정/);

  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ enabledClients: ["codex"], groupMode: "single" }),
  });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "다시 시도" })); });

  expect(screen.getByLabelText("mounted app").textContent).toBe("single");
  expect(fetchMock.mock.calls.filter(([url]) => url === "/api/config")).toHaveLength(2);
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/overview")).toBe(true);
});
