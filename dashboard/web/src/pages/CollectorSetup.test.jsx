import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConfigProvider } from "../ConfigContext.jsx";
import CollectorSetup from "./CollectorSetup.jsx";

const config = {
  enabled: true, endpoint: "https://collector.example/api/ingest",
  tokenLifetimeDays: 30, collectorVersion: "0.163.1", platforms: ["linux", "darwin"],
};
const device = {
  id: "device-one", name: "작업용 Mac", platform: "darwin",
  createdAt: "2026-10-20T12:00:00Z", expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
  revokedAt: null, lastSeenAt: null,
};
const token = "ccd1.fixture-owner.fixture-device.fixture-secret";
const response = (body, status = 200, type = "application/json") => ({
  ok: status >= 200 && status < 300, status, headers: new Headers({ "Content-Type": type }),
  json: async () => body, blob: async () => new Blob([body], { type }),
});
function installFetch(overrides = {}) {
  const fetch = vi.fn(async (url, options = {}) => {
    const parsed = new URL(String(url), "https://dashboard.example");
    if (overrides.request) {
      const result = overrides.request(parsed, options);
      if (result !== undefined) return result;
    }
    if (parsed.pathname === "/api/collector") return response(overrides.config ?? config);
    if (parsed.pathname === "/api/collector/devices" && !options.method)
      return response({ devices: overrides.devices ?? [], nextCursor: null });
    throw new Error(`Unexpected request ${options.method || "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
function mount(permissions = ["telemetry:read", "collector:manage"]) {
  return render(<ConfigProvider config={{ session: { mode: "oidc", permissions } }}>
    <CollectorSetup />
  </ConfigProvider>);
}
async function register() {
  await screen.findByRole("button", { name: "기기 등록 및 토큰 발급" });
  fireEvent.click(screen.getByRole("button", { name: /macOS 선택/ }));
  fireEvent.change(screen.getByLabelText("기기 이름"), { target: { value: "  작업용 Mac  " } });
  await waitFor(() => expect(screen.getByRole("button", { name: "기기 등록 및 토큰 발급" }).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "기기 등록 및 토큰 발급" }));
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("viewer and absent permissions make no requests and cannot access setup", () => {
  const fetch = installFetch();
  for (const permissions of [["telemetry:read"], []]) {
    const view = mount(permissions);
    expect(screen.getByRole("alert").textContent).toContain("권한");
    expect(screen.queryByRole("button", { name: /다운로드/ })).toBeNull();
    expect(screen.queryByLabelText("기기 이름")).toBeNull();
    view.unmount();
  }
  expect(fetch).not.toHaveBeenCalled();
});

test("loads only management snapshots, shows both clients and feature-disabled state", async () => {
  const fetch = installFetch();
  mount();
  expect(await screen.findByText("등록한 기기가 없습니다.")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "터미널에서 설치" })).toBeTruthy();
  expect(screen.getAllByText(/Claude Code와 Codex/).length).toBeGreaterThan(0);
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(["/api/collector?", "/api/collector/devices?"]);
  expect(screen.getByText(/브라우저 로그인 세션과 별개/)).toBeTruthy();
  cleanup();
  fetch.mockClear();
  installFetch({ config: { ...config, enabled: false, endpoint: undefined } });
  mount();
  expect(await screen.findByText(/기기 수집이 아직 활성화되지 않았습니다/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /다운로드/ })).toBeNull();
});

test("issues once while pending, copies and clears a transient token without embedding it in commands or storage", async () => {
  let finish;
  const fetch = installFetch({
    request: (url, options) => options.method === "POST"
      ? new Promise(resolve => { finish = () => resolve(response({ device, token }, 201)); }) : undefined,
  });
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  const storage = vi.spyOn(Storage.prototype, "setItem");
  const view = mount();
  await register();
  expect(screen.getByRole("button", { name: "발급 중..." }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "발급 중..." }));
  expect(fetch.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(1);
  const [, issue] = fetch.mock.calls.find(([, options]) => options.method === "POST");
  expect(JSON.parse(issue.body)).toEqual({ name: "작업용 Mac", platform: "darwin" });
  finish();
  expect((await screen.findByLabelText("기기 수집 토큰")).value).toBe(token);
  expect(screen.getByLabelText("설치 명령").textContent).toContain("ccdash-collector-darwin.tar.gz");
  expect(screen.getByLabelText("설치 명령").textContent).toContain("python3 ccdash-collector/install.py install --endpoint");
  expect(screen.getByLabelText("설치 명령").textContent).not.toContain(token);
  fireEvent.click(screen.getByRole("button", { name: "토큰 복사" }));
  await screen.findByText("토큰을 복사했습니다.");
  expect(writeText).toHaveBeenCalledWith(token);
  fireEvent.click(screen.getByRole("button", { name: "화면에서 토큰 지우기" }));
  expect(screen.queryByLabelText("기기 수집 토큰")).toBeNull();
  expect(screen.getByText(/화면에서 토큰을 지웠습니다/)).toBeTruthy();
  expect(storage).not.toHaveBeenCalled();
  expect(fetch.mock.calls.every(([url]) => !String(url).includes(token))).toBe(true);
  view.unmount();
  mount();
  await screen.findByText("등록한 기기가 없습니다.");
  expect(screen.queryByLabelText("기기 수집 토큰")).toBeNull();
});

test("keeps cursor pagination and confirms revocation before changing a device", async () => {
  const second = { ...device, id: "device-two", name: "EC2 개발", platform: "linux" };
  const fetch = installFetch({
    request: (url, options) => {
      if (options.method === "DELETE") return response(null, 204);
      if (url.pathname === "/api/collector/devices") return response(url.searchParams.has("cursor")
        ? { devices: [second], nextCursor: null } : { devices: [device], nextCursor: "opaque+/cursor=" });
    },
  });
  mount();
  expect(await screen.findByText("작업용 Mac")).toBeTruthy();
  expect(screen.getByText("수신 기록 없음")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "기기 더 보기" }));
  expect(await screen.findByText("EC2 개발")).toBeTruthy();
  const page = fetch.mock.calls.find(([url]) => String(url).includes("cursor="));
  expect(new URL(String(page[0]), "https://dashboard.example").searchParams.get("cursor")).toBe("opaque+/cursor=");
  fireEvent.click(screen.getByRole("button", { name: "작업용 Mac 해지" }));
  expect(fetch.mock.calls.some(([, options]) => options.method === "DELETE")).toBe(false);
  const confirm = screen.getByRole("group", { name: "작업용 Mac 해지 확인" });
  fireEvent.click(within(confirm).getByRole("button", { name: "해지 확인" }));
  expect(await screen.findByText("해지됨")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "작업용 Mac 해지" })).toBeNull();
  expect(fetch.mock.calls.find(([, options]) => options.method === "DELETE")[0]).toBe("/api/collector/devices/device-one");
});

test("downloads an authenticated archive and rejects JSON or failed responses", async () => {
  const createObjectURL = vi.fn().mockReturnValue("blob:collector");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = revokeObjectURL;
  });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  let download = response("archive", 200, "application/gzip");
  const fetch = installFetch({
    request: url => url.pathname.startsWith("/api/collector/package/") ? download : undefined,
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Linux 패키지 다운로드" }));
  await waitFor(() => expect(click).toHaveBeenCalledOnce());
  const [url, options] = fetch.mock.calls.find(([url]) => String(url).includes("/package/"));
  expect(url).toBe("/api/collector/package/linux");
  expect(options.credentials).toBe("same-origin");
  expect(click.mock.instances[0].download).toBe("ccdash-collector-linux.tar.gz");
  expect(createObjectURL).toHaveBeenCalledOnce();
  await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:collector"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Linux 패키지 다운로드" }).disabled).toBe(false));
  download = response({ code: "package_unavailable" }, 503);
  fireEvent.click(screen.getByRole("button", { name: "Linux 패키지 다운로드" }));
  expect((await screen.findByRole("alert")).textContent).toContain("다운로드하지 못했습니다");
  expect(click).toHaveBeenCalledOnce();
  download = response({ error: "unexpected json" });
  fireEvent.click(screen.getByRole("button", { name: "Linux 패키지 다운로드" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Linux 패키지 다운로드" }).disabled).toBe(false));
  expect(click).toHaveBeenCalledOnce();
});

test("download session rejection triggers the shared authentication boundary", async () => {
  const rejected = vi.fn();
  window.addEventListener("ccdash:authentication-required", rejected);
  installFetch({ request: url => url.pathname.includes("/package/") ? response({}, 401) : undefined });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Linux 패키지 다운로드" }));
  await waitFor(() => expect(rejected).toHaveBeenCalledOnce());
  window.removeEventListener("ccdash:authentication-required", rejected);
});

test("loading errors expose a retry and hide internal server details", async () => {
  let broken = true;
  installFetch({ request: url => url.pathname === "/api/collector" && broken
    ? response({ error: "private SDK credentials" }, 503) : undefined });
  mount();
  expect(screen.getByText("불러오는 중...")).toBeTruthy();
  expect((await screen.findByRole("alert")).textContent).toContain("불러오지 못했습니다");
  expect(screen.queryByText(/private SDK/)).toBeNull();
  broken = false;
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(await screen.findByText("등록한 기기가 없습니다.")).toBeTruthy();
});

test("a failed first-page refresh retries that page and preserves its pagination cursor", async () => {
  let lists = 0;
  const fetch = installFetch({ request: (url, options) => {
    if (url.pathname !== "/api/collector/devices" || options.method) return;
    lists++;
    return lists === 2 ? response({ code: "registry_unavailable" }, 503)
      : response({ devices: [device], nextCursor: "next-page" });
  } });
  mount();
  await screen.findByText(device.name);
  fireEvent.click(screen.getByRole("button", { name: "목록 새로고침" }));
  expect((await screen.findByRole("alert")).textContent).toContain("이전 확인 결과");
  expect(screen.getByText(device.name)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "기기 목록 다시 시도" }));
  await waitFor(() => expect(lists).toBe(3));
  expect(fetch.mock.calls.filter(([url]) => String(url).includes("/devices")).map(([url]) => String(url)))
    .toEqual(["/api/collector/devices?", "/api/collector/devices?", "/api/collector/devices?"]);
  expect(screen.getByRole("button", { name: "기기 더 보기" })).toBeTruthy();
});

test("a failed next page can retry without losing already loaded devices", async () => {
  let more = 0;
  const second = { ...device, id: "device-two", name: "EC2" };
  installFetch({ request: (url, options) => {
    if (url.pathname !== "/api/collector/devices" || options.method) return;
    if (!url.searchParams.has("cursor")) return response({ devices: [device], nextCursor: "next-page" });
    more++;
    return more === 1 ? response({}, 503) : response({ devices: [second], nextCursor: null });
  } });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "기기 더 보기" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "기기 목록 다시 시도" }));
  expect(await screen.findByText("EC2")).toBeTruthy();
  expect(screen.getByText(device.name)).toBeTruthy();
});

test("issue and revoke failures preserve the available recovery actions", async () => {
  let revokeFailed = true;
  installFetch({ devices: [device], request: (_url, options) => {
    if (options.method === "POST") return response({ error: "private SDK error" }, 503);
    if (options.method === "DELETE") return response({}, revokeFailed ? 503 : 204);
  } });
  mount();
  await register();
  expect((await screen.findByRole("alert")).textContent).toContain("토큰을 발급하지 못했습니다");
  expect(screen.queryByLabelText("기기 수집 토큰")).toBeNull();
  expect(screen.getByRole("button", { name: "기기 등록 및 토큰 발급" }).disabled).toBe(false);
  expect(screen.queryByText(/private SDK/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: `${device.name} 해지` }));
  fireEvent.click(screen.getByRole("button", { name: "해지 확인" }));
  await screen.findByText(/기기를 해지하지 못했습니다/);
  expect(screen.queryByText("해지됨")).toBeNull();
  revokeFailed = false;
  fireEvent.click(screen.getByRole("button", { name: "해지 확인" }));
  expect(await screen.findByText("해지됨")).toBeTruthy();
});

test("clearing a token while clipboard access is pending cannot restore its copy status", async () => {
  let finishCopy;
  vi.stubGlobal("navigator", { ...navigator, clipboard: {
    writeText: () => new Promise(resolve => { finishCopy = resolve; }),
  } });
  installFetch({ request: (_url, options) => options.method === "POST" ? response({ device, token }, 201) : undefined });
  mount();
  await register();
  await screen.findByLabelText("기기 수집 토큰");
  fireEvent.click(screen.getByRole("button", { name: "토큰 복사" }));
  fireEvent.click(screen.getByRole("button", { name: "화면에서 토큰 지우기" }));
  finishCopy();
  await waitFor(() => expect(screen.getByText(/화면에서 토큰을 지웠습니다/)).toBeTruthy());
  expect(screen.queryByText("토큰을 복사했습니다.")).toBeNull();
});

test("command copy feedback stays next to the terminal command", async () => {
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  installFetch();
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "설치 명령 복사" }));
  const message = await screen.findByText("설치 명령을 복사했습니다.");
  expect(message.parentElement.contains(screen.getByLabelText("설치 명령"))).toBe(true);
});

test("installation commands shell-quote endpoint apostrophes and expansions", async () => {
  const endpoint = "https://collector.example/api/ingest?value='$(example)";
  installFetch({ config: { ...config, endpoint } });
  mount();
  expect((await screen.findByLabelText("설치 명령")).textContent).toBe(
    "sudo loginctl enable-linger \"$USER\"\ntar -xzf ccdash-collector-linux.tar.gz\npython3 ccdash-collector/install.py install --endpoint 'https://collector.example/api/ingest?value='\"'\"'$(example)'"
  );
});

test("Linux setup explains logout persistence and Python minimum while macOS omits the Linux command", async () => {
  installFetch();
  mount();
  const command = await screen.findByLabelText("설치 명령");
  expect(command.textContent).toContain('sudo loginctl enable-linger "$USER"');
  expect(screen.getByText(/SSH 로그아웃·재부팅 후에도/)).toBeTruthy();
  expect(screen.getByText(/Python 3\.9\+/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "macOS 선택" }));
  expect(command.textContent).not.toContain("loginctl");
  expect(screen.queryByText(/SSH 로그아웃·재부팅 후에도/)).toBeNull();
});

test("registration waits for the initial device list before submitting", async () => {
  let finishList;
  const fetch = installFetch({ request: (url, options) => {
    if (options.method === "POST") return response({ device, token }, 201);
    if (url.pathname === "/api/collector/devices") return new Promise(resolve => {
      finishList = () => resolve(response({ devices: [], nextCursor: null }));
    });
  } });
  mount();
  const registering = register();
  await waitFor(() => expect(screen.getByLabelText("기기 이름").value).toBe("  작업용 Mac  "));
  expect(screen.getByRole("button", { name: "기기 등록 및 토큰 발급" }).disabled).toBe(true);
  expect(fetch.mock.calls.some(([, options]) => options.method === "POST")).toBe(false);
  await act(async () => finishList());
  await registering;
  expect((await screen.findByLabelText("기기 수집 토큰")).value).toBe(token);
});

test("removing collector permission unmounts the token and aborts pending download work", async () => {
  let downloadOptions;
  installFetch({ request: (url, options) => {
    if (options.method === "POST") return response({ device, token }, 201);
    if (url.pathname.includes("/package/")) {
      downloadOptions = options;
      return new Promise(() => {});
    }
  } });
  const view = mount();
  await register();
  await screen.findByLabelText("기기 수집 토큰");
  fireEvent.click(screen.getByRole("button", { name: "macOS 패키지 다운로드" }));
  view.rerender(<ConfigProvider config={{ session: { mode: "oidc", permissions: ["telemetry:read"] } }}>
    <CollectorSetup />
  </ConfigProvider>);
  expect(screen.queryByLabelText("기기 수집 토큰")).toBeNull();
  expect(screen.queryByRole("button", { name: /패키지 다운로드/ })).toBeNull();
  expect(downloadOptions.signal.aborted).toBe(true);
});

test("device dates use compact local time and preserve the exact ISO timestamp in the title", async () => {
  const createdAt = "2026-10-20T12:34:56.823Z";
  installFetch({ devices: [{ ...device, createdAt }] });
  mount();
  await screen.findByText(device.name);
  const displayed = screen.getByTitle(createdAt);
  expect(displayed.tagName).toBe("TIME");
  expect(displayed.getAttribute("datetime")).toBe(createdAt);
  expect(displayed.textContent).not.toContain(".823");
  expect(displayed.textContent).not.toContain("Z");
  const hours = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date(createdAt));
  expect(displayed.textContent).toContain(hours);
});

test("expiry status updates while the setup page remains open", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  installFetch({ devices: [{ ...device, expiresAt: new Date(Date.now() + 15000).toISOString() }] });
  mount();
  await screen.findByText(device.name);
  expect(screen.getByText("등록됨")).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect(screen.getByText("만료됨")).toBeTruthy();
  expect(screen.queryByRole("button", { name: `${device.name} 해지` })).toBeNull();
});
