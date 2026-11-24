import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ConfigProvider } from "../ConfigContext.jsx";
import { RefreshProvider } from "../RefreshContext.jsx";
import { RangeProvider } from "../RangeContext.jsx";
import { FilterProvider } from "../FilterContext.jsx";
import { setPiiMask } from "../fmt.js";
import { UserDevices } from "./UserDevices.jsx";

const USER = "alice@example.test";
const OWNER = "a".repeat(64);
const MAC = `${OWNER}.abc123${"0".repeat(26)}`;
const EC2 = `${OWNER}.def456${"0".repeat(26)}`;
const OLD = `${OWNER}.0dd000${"0".repeat(26)}`;
const BODY = {
  names_available: true, devices_truncated: false, unattributed_sessions: 3, sessions: {},
  devices: [
    { device: MAC, name: "Alice MacBook", platform: "darwin", revoked: false, clients: ["claude", "codex"],
      os_types: ["darwin"], sessions: 4, first_seen: "2026-09-01 00:00:00.000000000", last_seen: "2026-09-03 10:00:00.123456789" },
    { device: EC2, name: "EC2", platform: "linux", revoked: true, clients: ["claude"], os_types: ["linux"],
      sessions: 1, first_seen: "2026-09-02 00:00:00.000", last_seen: "2026-09-02 00:00:00.000" },
    { device: OLD, deleted: true, clients: ["codex"], os_types: [], sessions: 2,
      first_seen: "2026-09-01 00:00:00.000", last_seen: "2026-09-01 01:00:00.000" },
  ],
};

let fetchMock;
let body;
beforeEach(() => {
  body = BODY;
  fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => body }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setPiiMask(true);
});

const PARENT = { from: "2026-09-01T00:00:00.000Z", to: "2026-09-04T00:00:00.000Z" };
function mount(piiMask) {
  setPiiMask(piiMask);
  return render(
    <MemoryRouter>
      <ConfigProvider config={{ piiMask }}>
        <RefreshProvider><RangeProvider><FilterProvider>
          <UserDevices user={USER} clients={["claude", "codex"]} bounds={PARENT} linked />
        </FilterProvider></RangeProvider></RefreshProvider>
      </ConfigProvider>
    </MemoryRouter>,
  );
}

test("lists the user's devices with names, platform, clients and revoked marker", async () => {
  mount(false);
  const region = await screen.findByRole("region", { name: "기기" });
  expect(await within(region).findByText("Alice MacBook")).toBeTruthy();
  expect(within(region).getByText("Claude Code, Codex")).toBeTruthy();
  expect(within(region).getByText("해지됨")).toBeTruthy();
  expect(within(region).getByText("삭제된 기기 **·0dd000")).toBeTruthy();
  expect(within(region).getByText(/기기 정보가 없는 세션 3개/)).toBeTruthy();
  // ClickHouse DateTime64(9) text renders as a timestamp, not "—".
  expect(within(region).getByText(/^2026-09-03 \d\d:00:00\.123 /)).toBeTruthy();
  const url = new URL(String(fetchMock.mock.calls[0][0]), "http://localhost");
  expect(url.pathname).toBe("/api/users/devices");
  expect(url.searchParams.get("userExact")).toBe(USER);
  expect(url.searchParams.get("client")).toBe("all");
  expect(url.searchParams.get("from")).toBe(PARENT.from);
  expect(url.searchParams.get("team")).toBeNull();
});

test("masks device names under the PII mask and shows IDs when names are unavailable", async () => {
  mount(true);
  const region = await screen.findByRole("region", { name: "기기" });
  expect(await within(region).findByText("**·abc123")).toBeTruthy();
  expect(within(region).queryByText("Alice MacBook")).toBeNull();
  cleanup();
  body = { ...BODY, names_available: false, devices: BODY.devices.map(({ name: _n, ...d }) => d) };
  mount(false);
  const again = await screen.findByRole("region", { name: "기기" });
  expect(await within(again).findByText("**·abc123")).toBeTruthy();
  expect(within(again).getByText("기기 이름을 불러오지 못해 ID로 표시합니다.")).toBeTruthy();
});

test("a masked deployment shows IDs without the names-unavailable note", async () => {
  body = { ...BODY, names_masked: true, names_available: false, devices: BODY.devices.map(({ name: _n, ...d }) => d) };
  mount(true);
  const region = await screen.findByRole("region", { name: "기기" });
  expect(await within(region).findByText("**·abc123")).toBeTruthy();
  expect(within(region).queryByText("기기 이름을 불러오지 못해 ID로 표시합니다.")).toBeNull();
});

test("shows the empty state when no enrolled device sent data", async () => {
  body = { names_available: true, devices: [], devices_truncated: false, sessions: {}, unattributed_sessions: 0 };
  mount(false);
  const region = await screen.findByRole("region", { name: "기기" });
  expect(await within(region).findByText("기기 수집기로 등록된 기기에서 받은 로그만 구분됩니다.")).toBeTruthy();
  expect(within(region).queryByRole("note")).toBeNull();
});
