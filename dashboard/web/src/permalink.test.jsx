import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import App from "./App.jsx";
import { ConfigProvider } from "./ConfigContext.jsx";

// urlState.test.js는 순수 매핑만 핀다. 여기서는 RangeProvider/FilterProvider가 실제로 URL을
// 읽고 되쓰는 경로를 본다 — 두 provider가 마운트 시 같은 틱에 setSearchParams를 부르고 마지막
// navigate가 이기므로, 한쪽이 다른 쪽의 키를 잘못 보존하면 순수 테스트는 그대로 통과한다
// (실측 2026-09-03: 마스킹 ON에서 RangeProvider가 들어온 user를 보존해 원본 이메일이 URL에
// 남았다).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let loc = null;
function LocationSpy() {
  loc = useLocation();
  return null;
}

function stubFetch() {
  const fetchMock = vi.fn((url) => {
    const u = String(url);
    const body = u.startsWith("/api/config")
      ? { piiMask: false, pricing: { cacheWriteTtl: "1h", overriddenModels: [] }, schema: {} }
      : u.startsWith("/api/health/data")
        ? { status: "ok", latest: null, ageMinutes: 0, staleAfterMinutes: 360 }
        : [];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  loc = null;
});

function mount(entry, config) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <ConfigProvider config={config}>
        <LocationSpy />
        <App />
      </ConfigProvider>
    </MemoryRouter>
  );
}

const cfg = (extra = {}) => ({ piiMask: false, groupMode: "ab", defaultRangeDays: 7, rangeCapDays: 90, schema: {}, ...extra });

const presetButtons = (container) => [...container.querySelectorAll("button")].filter((b) => /^\d+일$/.test(b.textContent));
// SegmentedControl은 활성 옵션에만 bg-brand-500을 준다 — aria-pressed가 없어 클래스로 본다.
const activePreset = (container) => presetButtons(container).find((b) => b.className.includes("bg-brand-500"))?.textContent;
const dataCalls = (fetchMock, prefix) => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith(prefix));

test("링크의 days/group/user가 range picker와 필터를 시딩하고 마운트 후에도 URL에 남는다 (마스킹 OFF)", async () => {
  const fetchMock = stubFetch();
  const { container } = mount("/cost?days=30&group=bedrock&user=alice%40example.com", cfg());
  await waitFor(() => expect(dataCalls(fetchMock, "/api/cost").length).toBeGreaterThan(0));
  expect(activePreset(container)).toBe("30일");
  const p = new URLSearchParams(loc.search);
  expect(p.get("days")).toBe("30");
  expect(p.get("group")).toBe("bedrock");
  expect(p.get("user")).toBe("alice@example.com");
  // 입력창만 시딩되고 debounce 값이 비면 첫 fetch가 무필터로 나간다 — 첫 호출부터 필터가 실려야 한다.
  expect(dataCalls(fetchMock, "/api/cost")[0]).toMatch(/group=bedrock/);
  expect(dataCalls(fetchMock, "/api/cost")[0]).toMatch(/user=alice/);
});

test("빈 URL은 config의 defaultRangeDays를 쓰고, 프리셋을 바꾸면 days가 URL에 써진다", async () => {
  const fetchMock = stubFetch();
  const { container } = mount("/cost", cfg());
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(activePreset(container)).toBe("7일");
  fireEvent.click(presetButtons(container).find((b) => b.textContent === "14일"));
  await waitFor(() => expect(new URLSearchParams(loc.search).get("days")).toBe("14"));
  expect(activePreset(container)).toBe("14일");
});

test("마스킹 ON: 링크의 user는 필터로도 URL로도 살아나지 않고, group은 유지된다", async () => {
  const fetchMock = stubFetch();
  mount("/cost?days=7&group=enterprise&user=alice%40example.com", cfg({ piiMask: true }));
  await waitFor(() => expect(dataCalls(fetchMock, "/api/cost").length).toBeGreaterThan(0));
  expect(dataCalls(fetchMock, "/api/cost").every((u) => !/user=/.test(u))).toBe(true);
  const p = new URLSearchParams(loc.search);
  expect(p.get("group")).toBe("enterprise");
  expect(p.get("user")).toBeNull();
});

test("rangeCapDays보다 긴 프리셋은 picker에 나오지 않는다", async () => {
  const fetchMock = stubFetch();
  const { container } = mount("/cost", cfg({ rangeCapDays: 14, defaultRangeDays: 2 }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(presetButtons(container).map((b) => b.textContent)).toEqual(["1일", "2일", "7일", "14일"]);
});
