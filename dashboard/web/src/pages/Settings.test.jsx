import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfigProvider } from "../ConfigContext.jsx";
import Settings from "./Settings.jsx";
import { localeStore, translate } from "../i18n/index.js";
import { maskTeam, setTeamMask } from "../fmt.js";

afterEach(async () => { cleanup(); vi.unstubAllGlobals(); await act(() => localeStore.select("ko")); });
const session = permissions => ({ mode: "oidc", role: "admin", permissions,
  expiresAt: new Date(Date.now() + 900000).toISOString() });
const renderPage = (permissions = ["settings:manage"]) => render(
  <ConfigProvider config={{ session: session(permissions) }}><Settings /></ConfigProvider>);
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const base = {
  available: true, reason: null, poolId: "ap-northeast-2_Example",
  status: { available: true, lastSync: Date.parse("2026-11-10T03:00:00Z"), lastError: null, stale: false,
    users: 42, historyStart: Date.parse("2026-10-01T00:00:00Z"), reason: null },
  attributes: [{ attribute: "custom:team", from: 0 }], current: "custom:team", labels: { platform: "플랫폼" },
  options: ["custom:team", "custom:department"], directoryError: null, version: 3,
};
const previews = {
  "custom:team": { attribute: "custom:team", values: [{ value: "platform", users: 5 }, { value: "data", users: 2 }], missing: 3, excluded: 1 },
  "custom:department": { attribute: "custom:department", values: [{ value: "eng", users: 7 }], missing: 0, excluded: 4 },
};
const display = (override = null, deployment = true, extra = {}) => ({ available: true, reason: null,
  teamMask: { deployment, override, effective: override ?? deployment }, version: override === null ? null : 1, ...extra });
function stubApi(overrides = {}, put, displayState = display()) {
  const fetch = vi.fn((url, options = {}) => {
    const path = String(url);
    if (path.startsWith("/api/settings/display")) {
      if (options.method !== "PUT") return Promise.resolve(response(displayState));
      const { teamMask } = JSON.parse(options.body);
      return Promise.resolve(response(display(teamMask, displayState.teamMask.deployment)));
    }
    if (options.method === "PUT") return Promise.resolve(put ? put(options) : response(base));
    if (path.startsWith("/api/settings/teams/preview")) {
      const attribute = new URL(path, "http://x").searchParams.get("attribute");
      return Promise.resolve(response(previews[attribute]));
    }
    return Promise.resolve(response({ ...base, ...overrides }));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const putCalls = fetch => fetch.mock.calls.filter(([url, options]) => options?.method === "PUT"
  && !String(url).startsWith("/api/settings/display"));

test("users without settings:manage see a denial and make no requests", () => {
  const fetch = stubApi();
  renderPage(["telemetry:read"]);
  expect(screen.getByRole("alert").textContent).toContain("권한");
  expect(fetch).not.toHaveBeenCalled();
});

test("renders directory status, options with the current one marked, and the current preview", async () => {
  stubApi();
  renderPage();
  expect(await screen.findByText("ap-northeast-2_Example")).toBeTruthy();
  expect(screen.getByText("42")).toBeTruthy();
  expect(screen.getByRole("radio", { name: /custom:team/ }).checked).toBe(true);
  expect(screen.getByRole("radio", { name: /custom:department/ }).checked).toBe(false);
  expect(screen.getByText("현재")).toBeTruthy();
  expect((await screen.findByLabelText("platform 표시 이름")).value).toBe("플랫폼");
  expect(screen.getByLabelText("data 표시 이름").value).toBe("");
  expect(screen.getAllByRole("columnheader").map(h => h.textContent.replace(/[▲▼↕]/g, "").trim())).toEqual(["값", "사용자 수", "표시 이름"]);
  expect(screen.getByText(/지금부터 적용됩니다. 이전 사용량의 팀은 바뀌지 않습니다/)).toBeTruthy();
  expect(screen.queryByText(/오래되었습니다/)).toBeNull();
});

test("selecting an option loads its preview counts without saving", async () => {
  const fetch = stubApi();
  renderPage();
  await screen.findByLabelText("platform 표시 이름");
  fireEvent.click(screen.getByRole("radio", { name: /custom:department/ }));
  expect(await screen.findByLabelText("eng 표시 이름")).toBeTruthy();
  expect(fetch.mock.calls.some(([url]) => String(url) === "/api/settings/teams/preview?attribute=custom%3Adepartment")).toBe(true);
  expect(screen.getByText("4").closest("p").textContent).toContain("이메일이 없거나");
  expect(screen.queryByLabelText("platform 표시 이름")).toBeNull();
  expect(putCalls(fetch)).toHaveLength(0);
});

test("save sends attribute, non-blank labels and version, then shows success", async () => {
  const fetch = stubApi({}, () => response({ ...base, version: 4, labels: { platform: "플랫폼", data: "데이터" } }));
  renderPage();
  fireEvent.change(await screen.findByLabelText("data 표시 이름"), { target: { value: " 데이터 " } });
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  expect((await screen.findByRole("status")).textContent).toContain("저장했습니다");
  const [[url, options]] = putCalls(fetch);
  expect(url).toBe("/api/settings/teams");
  expect(options.credentials).toBe("same-origin");
  expect(JSON.parse(options.body)).toEqual({ attribute: "custom:team", version: 3,
    labels: { platform: "플랫폼", data: "데이터" } });
});

test("saving keeps stored labels for values outside the preview", async () => {
  const fetch = stubApi({ labels: { platform: "플랫폼", retired: "옛 팀" } });
  renderPage();
  fireEvent.change(await screen.findByLabelText("data 표시 이름"), { target: { value: "데이터" } });
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  await waitFor(() => expect(putCalls(fetch)).toHaveLength(1));
  expect(JSON.parse(putCalls(fetch)[0][1].body).labels).toEqual({ platform: "플랫폼", retired: "옛 팀", data: "데이터" });
});

test("clearing a row's name removes only that key", async () => {
  const fetch = stubApi({ labels: { platform: "플랫폼", retired: "옛 팀" } });
  renderPage();
  fireEvent.change(await screen.findByLabelText("platform 표시 이름"), { target: { value: " " } });
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  await waitFor(() => expect(putCalls(fetch)).toHaveLength(1));
  expect(JSON.parse(putCalls(fetch)[0][1].body).labels).toEqual({ retired: "옛 팀" });
});

test("switching attribute prefills matching stored labels and saves the merged map", async () => {
  const fetch = stubApi({ labels: { platform: "플랫폼", eng: "엔지니어링" } });
  renderPage();
  await screen.findByLabelText("platform 표시 이름");
  fireEvent.click(screen.getByRole("radio", { name: /custom:department/ }));
  expect((await screen.findByLabelText("eng 표시 이름")).value).toBe("엔지니어링");
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  await waitFor(() => expect(putCalls(fetch)).toHaveLength(1));
  expect(JSON.parse(putCalls(fetch)[0][1].body)).toEqual({ attribute: "custom:department", version: 3,
    labels: { platform: "플랫폼", eng: "엔지니어링" } });
});

test("status reason and last error are explained", async () => {
  stubApi({ status: { ...base.status, reason: "directory_too_large", lastError: "sync_failed" } });
  renderPage();
  expect(await screen.findByText(/이력 항목이 너무 많아/)).toBeTruthy();
  expect(screen.getByText(/동기화에 실패했습니다/)).toBeTruthy();
});

test("a version conflict asks for a reload and reloading refetches the settings", async () => {
  const fetch = stubApi({}, () => response({ error: "version_conflict" }, 409));
  renderPage();
  await screen.findByLabelText("platform 표시 이름");
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  const reload = await screen.findByRole("button", { name: "최신 설정 불러오기" });
  expect(screen.getByRole("button", { name: "저장" }).disabled).toBe(true);
  const before = fetch.mock.calls.filter(([url]) => String(url) === "/api/settings/teams?").length;
  fireEvent.click(reload);
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url) === "/api/settings/teams?").length).toBe(before + 1));
  await waitFor(() => expect(screen.queryByRole("button", { name: "최신 설정 불러오기" })).toBeNull());
});

test("a duplicate label error is explained", async () => {
  stubApi({}, () => response({ error: "duplicate_label" }, 400));
  renderPage();
  await screen.findByLabelText("platform 표시 이름");
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  expect((await screen.findByRole("alert")).textContent).toContain("같은 표시 이름");
});

test("an unavailable directory hides the form and explains the reason", async () => {
  stubApi({ available: false, reason: "basic_auth", status: null, options: [], current: null, version: null });
  renderPage();
  expect((await screen.findByRole("status")).textContent).toContain("조직 SSO");
  expect(screen.queryByRole("radio", { name: /custom:/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "저장" })).toBeNull();
});

test("stale status warns and a directory outage disables the picker but keeps stored settings", async () => {
  const fetch = stubApi({ options: null, directoryError: "directory_unavailable", status: { ...base.status, stale: true } });
  renderPage();
  expect(await screen.findByText(/동기화가 오래되었습니다/)).toBeTruthy();
  expect(screen.getByText(/일시적으로 연결할 수 없어/)).toBeTruthy();
  expect(screen.queryByRole("radio", { name: /custom:/ })).toBeNull();
  expect(screen.getByText(/현재 기준: custom:team/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "저장" })).toBeNull();
  expect(fetch.mock.calls.some(([url]) => String(url).startsWith("/api/settings/teams/preview"))).toBe(false);
});

test("the first save says current directory values apply to all earlier usage; later saves apply from now", async () => {
  stubApi({ attributes: [], current: null, labels: {}, version: null,
    status: { ...base.status, historyStart: null, lastSync: null, users: 0 } });
  renderPage();
  fireEvent.click(await screen.findByRole("radio", { name: /custom:department/ }));
  expect(await screen.findByText(/첫 저장 시 지금 디렉터리 값이 이전 사용량 전체에도 적용됩니다/)).toBeTruthy();
  expect(screen.getByText(/이후 기준을 바꾸면 저장한 시점부터 적용됩니다/)).toBeTruthy();
  expect(screen.queryByText(/이전 사용량의 팀은 바뀌지 않습니다/)).toBeNull();
  cleanup();
  stubApi();
  renderPage();
  expect(await screen.findByText(/지금부터 적용됩니다. 이전 사용량의 팀은 바뀌지 않습니다/)).toBeTruthy();
  expect(screen.queryByText(/첫 저장 시/)).toBeNull();
});


test("language changes retain the draft, selected attribute and save error without new requests", async () => {
  const fetch = stubApi({}, () => response({ error: "duplicate_label" }, 400));
  renderPage();
  const input = await screen.findByLabelText("platform 표시 이름");
  fireEvent.change(input, { target: { value: "내 팀 {0}" } });
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  await screen.findByRole("alert");
  const calls = fetch.mock.calls.length;
  for (const locale of ["en", "zh-CN", "ja", "es", "ko"]) {
    await act(async () => { expect(await localeStore.select(locale)).toBe(true); });
    expect(screen.getByRole("heading", { name: translate("m115bced49291") })).toBeTruthy();
    expect(screen.getByLabelText(translate("m102db82683f0", ["platform"]))).toBe(input);
    expect(input.value).toBe("내 팀 {0}");
    expect(screen.getByRole("radio", { name: /custom:team/ }).checked).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe(translate("mde7e132c2622"));
    expect(fetch.mock.calls).toHaveLength(calls);
  }
  expect(putCalls(fetch)).toHaveLength(1);
  const sent = JSON.parse(putCalls(fetch)[0][1].body);
  expect(sent).toEqual({ attribute: "custom:team", version: 3, labels: { platform: "내 팀 {0}" } });
});

test("team name masking shows the deployment default and saves an administrator override", async () => {
  const fetch = stubApi({}, undefined, display(null, true));
  renderPage();
  expect(await screen.findByText(/배포 설정 따름 \(켜짐\)/)).toBeTruthy();
  const save = screen.getByRole("button", { name: "마스킹 설정 저장" });
  expect(save.disabled).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "끄기" }));
  fireEvent.click(screen.getByRole("button", { name: "마스킹 설정 저장" }));
  await screen.findByText(/저장했습니다. 이 화면에는 바로/);
  const call = fetch.mock.calls.find(([url, options]) => String(url) === "/api/settings/display" && options?.method === "PUT");
  expect(JSON.parse(call[1].body)).toEqual({ teamMask: false, version: null });
  expect(maskTeam("alpha")).toBe("alpha", "the page applies the saved value at once");
  setTeamMask(true);
});

test("the masking card follows the selected language, including the save confirmation", async () => {
  stubApi({}, undefined, display(null, true));
  renderPage();
  fireEvent.click(await screen.findByRole("radio", { name: "끄기" }));
  fireEvent.click(screen.getByRole("button", { name: "마스킹 설정 저장" }));
  await screen.findByText(/저장했습니다. 이 화면에는 바로/);
  for (const locale of ["en", "zh-CN", "ja", "es", "ko"]) {
    await act(async () => { expect(await localeStore.select(locale)).toBe(true); });
    expect(screen.getByText(translate("m9c03c20c5604"), { selector: "h2, h3, legend" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: translate("mdd8b273b7cee") }).checked).toBe(true);
    expect(screen.getByRole("button", { name: translate("m64ce1b37ca97") })).toBeTruthy();
    expect(screen.getByText(translate("m32099c994906"))).toBeTruthy();
  }
  setTeamMask(true);
});

test("without the settings store the deployment value applies and no override is offered", async () => {
  stubApi({}, undefined, display(null, false, { available: false, reason: "ingest_disabled" }));
  renderPage();
  expect(await screen.findByText(/설정 저장소가 없어 배포 설정을 따릅니다/)).toBeTruthy();
  expect(screen.queryByRole("radio", { name: "끄기" })).toBeNull();
});
