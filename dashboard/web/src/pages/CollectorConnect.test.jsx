import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfigProvider } from "../ConfigContext.jsx";
import CollectorConnect from "./CollectorConnect.jsx";

const handle = "a".repeat(32);
const pending = { name: "EC2 dev", platform: "linux", code: "BCDF-GHJK", status: "pending",
  expiresAt: "2026-11-14T10:00:00.000Z", userId: "alice@example.com" };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status,
  headers: new Headers({ "Content-Type": "application/json" }), json: async () => body });

function installFetch({ view = pending, viewStatus = 200, decision = () => response({ status: "approved" }) } = {}) {
  const fetch = vi.fn(async (url, options = {}) => {
    const path = new URL(String(url), "https://dashboard.example").pathname;
    if (path === `/api/collector/enrollments/${handle}` && !options.method) return response(view, viewStatus);
    if (path.startsWith(`/api/collector/enrollments/${handle}/`) && options.method === "POST")
      return decision(path.split("/").at(-1));
    throw new Error(`Unexpected request ${options.method || "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
function mount(permissions = ["telemetry:read", "collector:manage"], id = handle) {
  return render(<ConfigProvider config={{ session: { mode: "oidc", name: "Alice", permissions } }}>
    <CollectorConnect handle={id} />
  </ConfigProvider>);
}
const posts = fetch => fetch.mock.calls.filter(([, options]) => options?.method === "POST");
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("viewers and malformed links make no requests", () => {
  const fetch = installFetch();
  mount(["telemetry:read"]);
  expect(screen.getByRole("alert").textContent).toContain("권한");
  cleanup();
  mount(undefined, "not-a-handle");
  expect(screen.getByRole("status").textContent).toContain("연결 요청을 찾을 수 없습니다");
  expect(fetch).not.toHaveBeenCalled();
});

test("opening the link only shows the request; one explicit click approves it", async () => {
  const fetch = installFetch();
  mount();
  expect((await screen.findByLabelText("확인 코드")).textContent).toBe("BCDF-GHJK");
  expect(screen.getByText("EC2 dev")).toBeTruthy();
  expect(screen.getByText("Linux")).toBeTruthy();
  expect(screen.getByText("Alice")).toBeTruthy();
  expect(screen.getByText("alice@example.com")).toBeTruthy();
  expect(screen.getByText(/본인이 방금 터미널에서 시작한 설치만/)).toBeTruthy();
  expect(posts(fetch)).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "이 기기 연결" }));
  expect((await screen.findByRole("status")).textContent).toContain("이 기기를 연결했습니다");
  expect(posts(fetch).map(([url, options]) => [String(url), options.credentials]))
    .toEqual([[`/api/collector/enrollments/${handle}/approve`, "same-origin"]]);
  expect(screen.queryByRole("button", { name: "이 기기 연결" })).toBeNull();
});

test("denial, expiry, another owner and missing requests show terminal outcomes", async () => {
  for (const [decision, expected] of [
    ["deny", "연결을 거부했습니다"],
    [() => response({ error: "enrollment_expired" }, 410), "승인 시간이 지났습니다"],
    [() => response({ error: "enrollment_unavailable" }, 409), "이미 처리된 요청"],
    [() => response({ error: "enrollment_denied" }, 409), "연결을 거부했습니다"],
  ]) {
    cleanup();
    installFetch({ decision: typeof decision === "function" ? decision : () => response({ status: "denied" }) });
    mount();
    await screen.findByLabelText("확인 코드");
    fireEvent.click(screen.getByRole("button", { name: decision === "deny" ? "거부" : "이 기기 연결" }));
    expect((await screen.findByRole("status")).textContent).toContain(expected);
  }
  for (const [view, status, expected] of [
    [{ ...pending, status: "approved" }, 200, "이 기기를 연결했습니다"],
    [{ ...pending, status: "expired" }, 200, "승인 시간이 지났습니다"],
    [{ error: "enrollment_not_found" }, 404, "연결 요청을 찾을 수 없습니다"],
  ]) {
    cleanup();
    installFetch({ view, viewStatus: status });
    mount();
    expect((await screen.findByRole("status")).textContent).toContain(expected);
    expect(screen.queryByRole("button", { name: "이 기기 연결" })).toBeNull();
  }
});

test("a temporary approval failure can be retried and never double-submits", async () => {
  let finish;
  let attempts = 0;
  const fetch = installFetch({ decision: () => {
    attempts++;
    return attempts === 1 ? response({ error: "store_unavailable" }, 503)
      : new Promise(resolve => { finish = () => resolve(response({ status: "approved" })); });
  } });
  mount();
  await screen.findByLabelText("확인 코드");
  fireEvent.click(screen.getByRole("button", { name: "이 기기 연결" }));
  expect((await screen.findByRole("alert")).textContent).toContain("중복 등록되지 않습니다");
  fireEvent.click(screen.getByRole("button", { name: "이 기기 연결" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "연결 중..." }).disabled).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "연결 중..." }));
  finish();
  expect((await screen.findByRole("status")).textContent).toContain("이 기기를 연결했습니다");
  expect(posts(fetch)).toHaveLength(2);
});

test("a request without a verified email names the installer default", async () => {
  installFetch({ view: { ...pending, userId: null } });
  mount();
  expect(await screen.findByText("설치 기기의 로그인 이름")).toBeTruthy();
});
