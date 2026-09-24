import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ConfigProvider } from "./ConfigContext.jsx";
import { RefreshProvider, useRefresh } from "./RefreshContext.jsx";
import { RangeProvider, useRange } from "./RangeContext.jsx";
import { FilterProvider, useFilters } from "./FilterContext.jsx";
import { useApi } from "./useApi.js";
import { Fragment, StrictMode } from "react";

function stubFetch(handler) {
  const fetchMock = vi.fn((url, opts) => {
    const u = String(url);
    if (u.startsWith("/api/config")) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }
    return handler(u, opts);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// 매 호출마다 내용이 같은 **새 객체**를 준다 — 진짜 res.json()이 그렇다(응답마다 새로 파싱).
// 클로저의 객체 하나를 계속 돌려주면 useApi가 참조를 유지하든 매번 교체하든 toBe(first)가
// 통과해서, "같은 payload면 참조 유지" 단정문이 아무것도 검증하지 못한다.
const okFresh = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ...body }) });

// 요청마다 대기 중인 핸들을 쌓는다 — 테스트가 응답 시점과 순서를 직접 정한다. signal은 존중하지
// 않는다(abort돼도 reject하지 않음): 그래야 abort된 요청의 "늦은 응답"을 흉내 낼 수 있다.
function stubPending() {
  const pending = [];
  stubFetch((url, { signal }) => new Promise((resolve, reject) => pending.push({ url, resolve, reject, signal })));
  return pending;
}
const fail503 = () => ({ ok: false, status: 503, json: () => Promise.resolve({}) });

let hook = null;
const loadings = [];
const renders = [];
function Probe({ path = "/api/cost/summary", params = {}, enabled = true, options } = {}) {
  const state = useApi(path, params, enabled, options);
  const refresh = useRefresh();
  const range = useRange();
  const filters = useFilters();
  loadings.push(state.loading);
  renders.push({ days: range.days, stale: state.stale, loading: state.loading });
  hook = { state, refresh, range, filters };
  return state.loading ? <p>Loading</p> : state.error ? <p>Request failed</p>
    : <section aria-label="Loaded data">{state.data?.total}</section>;
}

function Fixture({ strict = false, probeProps } = {}) {
  const Wrapper = strict ? StrictMode : Fragment;
  return (
    <Wrapper>
    <MemoryRouter initialEntries={["/cost"]}>
      <ConfigProvider>
        <RefreshProvider>
          <RangeProvider>
            <FilterProvider>
              <Probe {...probeProps} />
            </FilterProvider>
          </RangeProvider>
        </RefreshProvider>
      </ConfigProvider>
    </MemoryRouter>
    </Wrapper>
  );
}
function mount(options = {}) {
  return render(<Fixture {...options} />);
}

beforeEach(() => {
  hook = null;
  loadings.length = 0;
  renders.length = 0;
  // useApi가 Date.now()를 QUANT_MS 경계로 내려 paramsKey를 만든다 — 실시간 시계로 돌리면
  // 테스트 중에 경계를 넘는 순간 파라미터가 바뀌어 "틱은 파라미터를 바꾸지 않는다"는 전제가 깨진다.
  vi.spyOn(Date, "now").mockReturnValue(new Date("2026-09-04T12:00:00.000Z").getTime());
});

test("StrictMode remount retries an aborted initial request instead of retaining a loading state", async () => {
  stubFetch((_url, { signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({ total: 7 }) }), 10);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    });
  }));
  mount({ strict: true });
  await waitFor(() => expect(hook.state.data).toEqual({ total: 7 }));
  expect(hook.state.loading).toBe(false);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("동일한 payload로 수동 새로고침해도 data 참조가 유지되고 loading이 다시 true가 되지 않는다", async () => {
  const body = { total: 42 };
  const fetchMock = stubFetch(() => okFresh(body));
  mount();
  await waitFor(() => expect(hook.state.loading).toBe(false));
  const first = hook.state.data;
  expect(first).toEqual(body);

  const callsBefore = fetchMock.mock.calls.length;
  await act(async () => {
    hook.refresh.refreshNow();
  });
  await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore));
  await waitFor(() => expect(hook.state.data).toBe(first));

  const firstFalseIdx = loadings.indexOf(false);
  expect(loadings.slice(firstFalseIdx + 1).includes(true)).toBe(false);
});

test("실패한 백그라운드 틱은 기존 데이터를 지우지 않고 lastError만 켠다", async () => {
  const body = { total: 42 };
  let call = 0;
  const fetchMock = stubFetch(() => {
    call += 1;
    if (call === 1) return okFresh(body);
    return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
  });
  mount();
  await waitFor(() => expect(hook.state.loading).toBe(false));
  expect(hook.state.data).toEqual(body);

  await act(async () => {
    hook.refresh.refreshNow();
  });
  await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
  await waitFor(() => expect(hook.refresh.lastError).toBe(true));
  expect(hook.state.data).toEqual(body);
  expect(hook.state.error).toBeNull();
});

test("바뀐 payload를 받은 틱은 새 참조로 교체하고 loading을 true로 되돌리지 않는다", async () => {
  const first = { total: 1 };
  const second = { total: 2 };
  let call = 0;
  stubFetch(() => {
    call += 1;
    return okFresh(call === 1 ? first : second);
  });
  mount();
  await waitFor(() => expect(hook.state.loading).toBe(false));
  expect(hook.state.data).toEqual(first);

  await act(async () => {
    hook.refresh.refreshNow();
  });
  await waitFor(() => expect(hook.state.data).toEqual(second));
  expect(hook.state.data).not.toBe(first);

  const firstFalseIdx = loadings.indexOf(false);
  expect(loadings.slice(firstFalseIdx + 1).includes(true)).toBe(false);
});

// 이 재작성의 핵심 불변식이다: 파라미터 로드가 떠 있는 동안 온 틱은 (1) 그 로드를 abort하지
// 않고 (2) 같은 파라미터로 두 번째 요청을 만들지도 않는다. 옛 코드처럼 cleanup에서 abort하면
// 틱마다 진행 중인 로드가 취소돼 화면이 빈 채로 남는다.
// stub이 signal을 존중해야 의미가 있다 — 무시하면 abort된 요청도 그냥 resolve돼서
// cleanup의 abort가 있으나 없으나 결과가 같아진다.
test("파라미터 로드가 떠 있는 동안 온 틱은 그 로드를 취소하지도, 중복 요청하지도 않는다", async () => {
  let settle = null;
  const fetchMock = stubFetch((_u, opts) =>
    new Promise((resolve, reject) => {
      settle = () => resolve({ ok: true, status: 200, json: () => Promise.resolve({ total: 7 }) });
      opts?.signal?.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    })
  );
  mount();
  await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));
  const dataCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/api/cost")).length;
  expect(dataCalls()).toBe(1);

  await act(async () => {
    hook.refresh.refreshNow();
  });
  // 틱은 버려졌다 — 같은 파라미터로 두 번째 요청이 나가지 않았다.
  expect(dataCalls()).toBe(1);

  await act(async () => {
    settle();
  });
  await waitFor(() => expect(hook.state.loading).toBe(false));
  // 첫 로드가 살아서 도착했다(취소되지 않았다).
  expect(hook.state.data).toEqual({ total: 7 });
  expect(hook.state.error).toBeNull();
});

test("기간 변경(setDays)은 loading을 true로 뒤집지 않고 from을 바꾼다", async () => {
  const fetchMock = stubFetch(() => okFresh({ total: 1 }));
  mount();
  await waitFor(() => expect(hook.state.loading).toBe(false));

  // 슬라이스는 여전히 필요하다 — 마운트 자체가 loading:true를 한 번 기록하므로 자르지 않으면
  // 그 초기 true 때문에 무조건 실패한다. 기간 변경은 loading을 절대 true로 뒤집지 않아야 한다.
  const idxBeforeChange = loadings.length;
  await act(async () => {
    hook.range.setDays(7);
  });
  await waitFor(() => expect(hook.state.loading).toBe(false));
  expect(loadings.slice(idxBeforeChange).includes(true)).toBe(false);

  const lastUrl = String(fetchMock.mock.calls.at(-1)[0]);
  const params = new URLSearchParams(lastUrl.split("?")[1]);
  const from = new Date(params.get("from"));
  const to = new Date(params.get("to"));
  expect(Math.round((to - from) / 86400000)).toBe(7);
});

test("a refresh crossing a quantized boundary retains the data DOM and unchanged payload identity", async () => {
  let resolveRefresh;
  let calls = 0;
  const fetchMock = stubFetch(() => ++calls === 1 ? okFresh({ total: 42 })
    : new Promise((resolve) => { resolveRefresh = resolve; }));
  mount();
  await waitFor(() => expect(hook.state.data?.total).toBe(42));
  const first = hook.state.data;
  const panel = screen.getByRole("region", { name: "Loaded data" });
  const before = loadings.length;
  Date.now.mockReturnValue(Date.now() + 120_000);
  await act(async () => hook.refresh.refreshNow());
  const urls = fetchMock.mock.calls.map(([url]) => url);
  expect(urls[1]).not.toBe(urls[0]);
  expect(hook.state.loading).toBe(false);
  expect(hook.refresh.isRefreshing).toBe(true);
  expect(panel.isConnected).toBe(true);
  expect(screen.getByRole("region", { name: "Loaded data" })).toBe(panel);
  await act(async () => resolveRefresh(await okFresh({ total: 42 })));
  expect(hook.state.data).toBe(first);
  expect(hook.refresh.isRefreshing).toBe(false);
  expect(loadings.slice(before)).not.toContain(true);
});

test("a failed refresh in the next time window preserves the displayed data and reports the failure", async () => {
  let calls = 0;
  stubFetch(() => ++calls === 1 ? okFresh({ total: 42 })
    : Promise.resolve({ ok: false, status: 503 }));
  mount();
  await waitFor(() => expect(hook.state.data?.total).toBe(42));
  const panel = screen.getByRole("region", { name: "Loaded data" });
  Date.now.mockReturnValue(Date.now() + 120_000);
  await act(async () => hook.refresh.refreshNow());
  await waitFor(() => expect(hook.refresh.lastError).toBe(true));
  expect(hook.state.data).toEqual({ total: 42 });
  expect(hook.state.error).toBeNull();
  expect(panel.isConnected).toBe(true);
});

test("late responses from an aborted selection cannot replace the current selection", async () => {
  const pending = [];
  stubFetch((_url, { signal }) => new Promise((resolve) => pending.push({ resolve, signal })));
  mount();
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => hook.range.setDays(7));
  expect(pending).toHaveLength(2);
  expect(pending[0].signal.aborted).toBe(true);
  await act(async () => pending[1].resolve(await okFresh({ total: 7 })));
  await act(async () => pending[0].resolve(await okFresh({ total: 2 })));
  expect(hook.state.data).toEqual({ total: 7 });
});

test("linked server bounds update in place while a changed client still clears the previous selection", async () => {
  let resolveRequest;
  let calls = 0;
  stubFetch(() => ++calls === 1 ? okFresh({ total: 42 })
    : new Promise((resolve) => { resolveRequest = resolve; }));
  const probeProps = { path: "/api/clients/overview", options: { linkedRange: true },
    params: { client: "codex", from: "2026-09-03T11:56:00Z", to: "2026-09-04T11:56:00Z" } };
  const view = mount({ probeProps });
  await waitFor(() => expect(hook.state.data?.total).toBe(42));
  const panel = screen.getByRole("region", { name: "Loaded data" });
  const next = { ...probeProps, params: { ...probeProps.params, to: "2026-09-04T11:58:00Z" } };
  view.rerender(<Fixture probeProps={next} />);
  expect(hook.state.loading).toBe(false);
  expect(hook.refresh.isRefreshing).toBe(true);
  expect(panel.isConnected).toBe(true);
  await act(async () => resolveRequest(await okFresh({ total: 43 })));
  expect(hook.state.data?.total).toBe(43);
  view.rerender(<Fixture probeProps={{ ...next, params: { ...next.params, client: "claude" } }} />);
  expect(hook.state.loading).toBe(true);
  expect(panel.isConnected).toBe(false);
});

test("explicit extra bounds are a period change: the previous data stays until the new response", async () => {
  let calls = 0;
  stubFetch(() => ++calls === 1 ? okFresh({ total: 1 }) : new Promise(() => {}));
  const probeProps = { params: { from: "2026-09-01T00:00:00Z", to: "2026-09-02T00:00:00Z" } };
  const view = mount({ probeProps });
  await waitFor(() => expect(hook.state.data?.total).toBe(1));
  view.rerender(<Fixture probeProps={{ params: { ...probeProps.params, to: "2026-09-03T00:00:00Z" } }} />);
  expect(hook.state.loading).toBe(false);
  expect(hook.state.data).toEqual({ total: 1 });
  expect(hook.refresh.isRefreshing).toBe(true);
});


test("a late rejected background request cannot mark the new selection as failed", async () => {
  const pending = [];
  stubFetch(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  mount();
  await act(async () => pending[0].resolve(await okFresh({ total: 2 })));
  await act(async () => hook.refresh.refreshNow());
  await act(async () => hook.range.setDays(7));
  await act(async () => pending[2].resolve(await okFresh({ total: 7 })));
  const current = hook.state.data;
  await act(async () => pending[1].reject(new Error("Late failure")));
  expect(hook.state.data).toBe(current);
  expect(hook.state.error).toBeNull();
  expect(hook.refresh.lastError).toBe(false);
  expect(hook.refresh.isRefreshing).toBe(false);
});

test("disable and re-enable resets selection identity and rejects the abandoned response", async () => {
  const pending = [];
  stubFetch(() => new Promise((resolve) => pending.push(resolve)));
  const view = mount();
  await act(async () => pending[0](await okFresh({ total: 42 })));
  const first = hook.state.data;
  await act(async () => hook.refresh.refreshNow());
  view.rerender(<Fixture probeProps={{ enabled: false }} />);
  expect(hook.state.loading).toBe(true);
  view.rerender(<Fixture probeProps={{ enabled: true }} />);
  await act(async () => pending[2](await okFresh({ total: 42 })));
  const current = hook.state.data;
  expect(current).not.toBe(first);
  await act(async () => pending[1](await okFresh({ total: 99 })));
  expect(hook.state.data).toBe(current);
  expect(hook.state.data.total).toBe(42);
});

test("a period change keeps the previous data without loading until the new response replaces it", async () => {
  const pending = stubPending();
  mount();
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => pending[0].resolve(await okFresh({ total: 1 })));
  const first = hook.state.data;
  const panel = screen.getByRole("region", { name: "Loaded data" });
  const idxBeforeChange = loadings.length;
  await act(async () => hook.range.setDays(7));
  expect(pending).toHaveLength(2);
  expect(hook.state.loading).toBe(false);
  expect(hook.state.data).toBe(first);
  expect(hook.state.error).toBeNull();
  expect(hook.refresh.isRefreshing).toBe(true);
  expect(panel.isConnected).toBe(true);
  expect(screen.getByRole("region", { name: "Loaded data" })).toBe(panel);
  const params = new URLSearchParams(pending[1].url.split("?")[1]);
  const from = new Date(params.get("from"));
  const to = new Date(params.get("to"));
  expect(Math.round((to - from) / 86400000)).toBe(7);
  await act(async () => pending[1].resolve(await okFresh({ total: 7 })));
  expect(hook.state.data.total).toBe(7);
  expect(hook.refresh.isRefreshing).toBe(false);
  expect(loadings.slice(idxBeforeChange)).not.toContain(true);
});

test.each([
  ["이번 달", () => hook.range.selectMonth(), "from=2026-09-01T00%3A00%3A00.000Z"],
  ["custom range", () => hook.range.setRange(new Date("2026-08-01T00:00:00Z"), new Date("2026-08-10T00:00:00Z"), "calendar"), "from=2026-08-01T00%3A00%3A00.000Z"],
])("%s is a period change that retains the data", async (_name, change, fromParam) => {
  const pending = stubPending();
  mount();
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => pending[0].resolve(await okFresh({ total: 1 })));
  const first = hook.state.data;
  await act(async () => change());
  expect(pending.at(-1).url).toContain(fromParam);
  expect(hook.state.loading).toBe(false);
  expect(hook.state.data).toBe(first);
  expect(hook.refresh.isRefreshing).toBe(true);
  await act(async () => pending.at(-1).resolve(await okFresh({ total: 9 })));
  expect(hook.state.data.total).toBe(9);
  expect(hook.refresh.isRefreshing).toBe(false);
});

test("a failed period change clears to its error instead of showing the previous period", async () => {
  const pending = stubPending();
  mount();
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => pending[0].resolve(await okFresh({ total: 1 })));
  await act(async () => hook.range.setDays(7));
  await act(async () => pending[1].resolve(fail503()));
  expect(hook.state.data).toBeNull();
  expect(hook.state.error.message).toBe("/api/cost/summary -> 503");
  expect(hook.state.loading).toBe(false);
  expect(hook.refresh.lastError).toBe(false);
  expect(hook.refresh.isRefreshing).toBe(false);
  expect(screen.getByText("Request failed")).toBeTruthy();
});

// 회귀 핀: 기간 요청이 떠 있는 동안 양자화된 창이 넘어가 틱 요청이 그 기간 요청을 대체해도, 실패는 기간 변경 실패로 비워야 한다.
test("a quantized window move during a pending period change still clears on failure", async () => {
  const pending = stubPending();
  mount();
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => pending[0].resolve(await okFresh({ total: 1 })));
  const first = hook.state.data;
  await act(async () => hook.range.setDays(7));
  Date.now.mockReturnValue(Date.now() + 120_000);
  await act(async () => hook.refresh.refreshNow());
  expect(pending).toHaveLength(3);
  expect(pending[1].signal.aborted).toBe(true);
  expect(hook.state.loading).toBe(false);
  expect(hook.state.data).toBe(first);
  expect(hook.refresh.isRefreshing).toBe(true);
  await act(async () => pending[2].resolve(fail503()));
  expect(hook.state.data).toBeNull();
  expect(hook.state.error).not.toBeNull();
  expect(hook.state.loading).toBe(false);
  expect(hook.refresh.lastError).toBe(false);
  expect(hook.refresh.isRefreshing).toBe(false);
});

// 회귀 핀: 새 기간의 응답이 성공하면 pending 플래그가 풀려, 이후 백그라운드 실패는 다시 데이터를 유지해야 한다.
test("after the new period arrives, a background failure retains it again", async () => {
  const pending = stubPending();
  mount();
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => pending[0].resolve(await okFresh({ total: 1 })));
  await act(async () => hook.range.setDays(7));
  await act(async () => pending[1].resolve(await okFresh({ total: 7 })));
  const current = hook.state.data;
  await act(async () => hook.refresh.refreshNow());
  await act(async () => pending[2].resolve(fail503()));
  expect(hook.state.data).toBe(current);
  expect(hook.state.error).toBeNull();
  expect(hook.refresh.lastError).toBe(true);
});

test("a filter change (user) still clears to loading", async () => {
  const pending = stubPending();
  mount();
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => pending[0].resolve(await okFresh({ total: 1 })));
  await act(async () => hook.filters.setUser("dev@example.com"));
  // 유저 필터는 FilterProvider가 300ms 디바운스한다 — act 직후에는 아직 요청도 loading 전환도 없다.
  expect(hook.state.loading).toBe(false);
  expect(pending).toHaveLength(1);
  await waitFor(() => expect(hook.state.loading).toBe(true));
  expect(hook.state.data).toBeNull();
  expect(hook.refresh.isRefreshing).toBe(false);
  expect(pending.at(-1).url).toContain("user=dev%40example.com");
});

test("path and non-range extra param changes still clear; a local intervalHours is a period change", async () => {
  const pending = stubPending();
  const probeProps = { path: "/api/cost/by-model-daily", params: { intervalHours: 24 } };
  const view = mount({ probeProps });
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => pending[0].resolve(await okFresh({ total: 1 })));
  const first = hook.state.data;
  view.rerender(<Fixture probeProps={{ ...probeProps, params: { intervalHours: 168 } }} />);
  expect(hook.state.loading).toBe(false);
  expect(hook.state.data).toBe(first);
  expect(hook.refresh.isRefreshing).toBe(true);
  expect(pending.at(-1).url).toContain("intervalHours=168");
  await act(async () => pending.at(-1).resolve(await okFresh({ total: 2 })));
  view.rerender(<Fixture probeProps={{ ...probeProps, params: { intervalHours: 168, includeUnknown: "1" } }} />);
  expect(hook.state.loading).toBe(true);
  expect(hook.state.data).toBeNull();
  expect(hook.refresh.isRefreshing).toBe(false);
  await act(async () => pending.at(-1).resolve(await okFresh({ total: 3 })));
  view.rerender(<Fixture probeProps={{ ...probeProps, path: "/api/cost/by-model", params: { intervalHours: 168, includeUnknown: "1" } }} />);
  expect(hook.state.loading).toBe(true);
  expect(hook.state.data).toBeNull();
});

test("a client extra param change still clears the previous selection", async () => {
  const pending = stubPending();
  const probeProps = { path: "/api/clients/overview", params: { client: "codex" } };
  const view = mount({ probeProps });
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => pending[0].resolve(await okFresh({ total: 1 })));
  const panel = screen.getByRole("region", { name: "Loaded data" });
  view.rerender(<Fixture probeProps={{ ...probeProps, params: { client: "claude" } }} />);
  expect(hook.state.loading).toBe(true);
  expect(hook.state.data).toBeNull();
  expect(panel.isConnected).toBe(false);
});

test("late responses from an aborted previous period cannot replace the retained or the new data", async () => {
  const pending = stubPending();
  mount();
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => pending[0].resolve(await okFresh({ total: 1 })));
  const first = hook.state.data;
  await act(async () => hook.range.setDays(7));
  await act(async () => hook.range.setDays(14));
  expect(pending).toHaveLength(3);
  expect(pending[1].signal.aborted).toBe(true);
  await act(async () => pending[1].resolve(await okFresh({ total: 7 })));
  expect(hook.state.data).toBe(first);
  await act(async () => pending[2].resolve(await okFresh({ total: 14 })));
  expect(hook.state.data.total).toBe(14);
  expect(hook.refresh.isRefreshing).toBe(false);
});

test("beginRequest marks a period change as refreshing only when data is on screen", async () => {
  const pending = stubPending();
  mount();
  await waitFor(() => expect(pending).toHaveLength(1));
  // (a) 아직 데이터가 없다 — 기간 변경은 예전처럼 비운 채 loading으로 시작한다.
  await act(async () => hook.range.setDays(7));
  expect(pending[0].signal.aborted).toBe(true);
  expect(hook.state.loading).toBe(true);
  expect(hook.state.data).toBeNull();
  expect(hook.refresh.isRefreshing).toBe(false);
  await act(async () => pending[1].resolve(await okFresh({ total: 7 })));
  // (b) 이제 데이터가 화면에 있다 — 기간 변경이 refreshing으로 표시된다.
  await act(async () => hook.range.setDays(30));
  expect(hook.refresh.isRefreshing).toBe(true);
  expect(hook.state.loading).toBe(false);
  await act(async () => pending[2].resolve(await okFresh({ total: 30 })));
  expect(hook.refresh.isRefreshing).toBe(false);
  expect(hook.state.data.total).toBe(30);
});

// 회귀 핀: linkedRange의 from/to 이동은 기간 변경으로 취급하면 안 된다 — 같은 뷰의 새로고침으로 남아야 한다.
test("linked bound moves stay a refresh: identical payloads keep their reference and failures retain data", async () => {
  const pending = stubPending();
  const probeProps = { path: "/api/clients/overview", options: { linkedRange: true },
    params: { client: "codex", from: "2026-09-03T11:56:00Z", to: "2026-09-04T11:56:00Z" } };
  const view = mount({ probeProps });
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => pending[0].resolve(await okFresh({ total: 42 })));
  const first = hook.state.data;
  view.rerender(<Fixture probeProps={{ ...probeProps, params: { ...probeProps.params, to: "2026-09-04T11:58:00Z" } }} />);
  expect(hook.state.loading).toBe(false);
  expect(hook.refresh.isRefreshing).toBe(true);
  await act(async () => pending[1].resolve(await okFresh({ total: 42 })));
  expect(hook.state.data).toBe(first);
  view.rerender(<Fixture probeProps={{ ...probeProps, params: { ...probeProps.params, to: "2026-09-04T12:00:00Z" } }} />);
  await act(async () => pending[2].resolve(fail503()));
  expect(hook.state.data).toBe(first);
  expect(hook.state.error).toBeNull();
  expect(hook.refresh.lastError).toBe(true);
});

// 회귀 핀: 선택이 바뀌면 payload 메모도 비워야 한다 — 안 비우면 이전 뷰와 내용이 같은 첫 응답이
// "같은 payload" 경로를 타서, 방금 비운 data(null)를 그대로 둔 채 loading만 false가 된다.
test("a new selection whose first response equals the previous payload still shows it", async () => {
  const pending = stubPending();
  const probeProps = { path: "/api/clients/overview", params: { client: "codex" } };
  const view = mount({ probeProps });
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => pending[0].resolve(await okFresh({ total: 1 })));
  view.rerender(<Fixture probeProps={{ ...probeProps, params: { client: "claude" } }} />);
  expect(hook.state.data).toBeNull();
  await act(async () => pending[1].resolve(await okFresh({ total: 1 })));
  expect(hook.state.loading).toBe(false);
  expect(hook.state.data).toEqual({ total: 1 });
  expect(screen.getByRole("region", { name: "Loaded data" }).textContent).toBe("1");
});

test("stale is true from the first render of a period change until its response replaces the data", async () => {
  const pending = stubPending();
  mount();
  await waitFor(() => expect(pending).toHaveLength(1));
  expect(hook.state.stale).toBe(false);
  expect(hook.state.loading).toBe(true);
  expect(hook.state.data).toBeNull();
  await act(async () => pending[0].resolve(await okFresh({ total: 1 })));
  expect(hook.state.stale).toBe(false);
  expect(hook.state.loading).toBe(false);
  const first = hook.state.data;
  expect(first).toEqual({ total: 1 });

  // stale은 렌더에서 계산되므로 기간이 바뀐 첫 렌더부터 이미 true다.
  const idx = renders.length;
  await act(async () => hook.range.setDays(7));
  expect(renders.slice(idx)[0]).toEqual({ days: 7, stale: true, loading: false });
  expect(hook.state.stale).toBe(true);
  expect(hook.state.loading).toBe(false);
  expect(hook.state.data).toBe(first);
  expect(hook.refresh.isRefreshing).toBe(true);
  expect(pending).toHaveLength(2);

  await act(async () => pending[1].resolve(await okFresh({ total: 7 })));
  expect(hook.state.stale).toBe(false);
  expect(hook.state.data).toEqual({ total: 7 });
  expect(hook.refresh.isRefreshing).toBe(false);

  // 백그라운드 틱은 기간 변경이 아니다 — isRefreshing 동안에도 stale은 false다.
  await act(async () => hook.refresh.refreshNow());
  expect(hook.state.stale).toBe(false);
  expect(hook.state.loading).toBe(false);
  expect(hook.state.data).toEqual({ total: 7 });
  expect(hook.refresh.isRefreshing).toBe(true);
  expect(pending).toHaveLength(3);
  await act(async () => pending[2].resolve(await okFresh({ total: 7 })));
  expect(hook.state.stale).toBe(false);
  expect(hook.state.data).toEqual({ total: 7 });
  expect(hook.refresh.isRefreshing).toBe(false);

  await act(async () => hook.range.setDays(14));
  expect(hook.state.stale).toBe(true);
  expect(hook.state.loading).toBe(false);
  expect(hook.state.data).toEqual({ total: 7 });
  expect(hook.refresh.isRefreshing).toBe(true);
  expect(pending).toHaveLength(4);

  // 기간 변경 실패는 에러로 비운다 — 비워진 화면은 stale이 아니다.
  await act(async () => pending[3].resolve(fail503()));
  expect(hook.state.stale).toBe(false);
  expect(hook.state.data).toBeNull();
  expect(hook.state.error.message).toBe("/api/cost/summary -> 503");
  expect(hook.state.loading).toBe(false);
  expect(hook.refresh.isRefreshing).toBe(false);
  expect(hook.refresh.lastError).toBe(false);
});

test("an identity change is never stale", async () => {
  const pending = stubPending();
  mount();
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => pending[0].resolve(await okFresh({ total: 1 })));
  await act(async () => hook.range.setDays(7));
  expect(hook.state.stale).toBe(true);
  await act(async () => hook.filters.setUser("dev@example.com"));
  // 유저 필터는 FilterProvider가 300ms 디바운스한다 — loading 전환을 기다린다.
  await waitFor(() => expect(hook.state.loading).toBe(true));
  expect(hook.state.stale).toBe(false);
  expect(hook.state.data).toBeNull();
});

test("a disabled hook is never stale", async () => {
  const pending = stubPending();
  const view = mount();
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => pending[0].resolve(await okFresh({ total: 1 })));
  await act(async () => hook.range.setDays(7));
  expect(hook.state.stale).toBe(true);
  view.rerender(<Fixture probeProps={{ enabled: false }} />);
  expect(hook.state.stale).toBe(false);
  expect(hook.state.loading).toBe(true);
  expect(hook.refresh.isRefreshing).toBe(false);
});

test("hold sends no request and keeps its state, but an in-flight request still completes", async () => {
  const pending = stubPending();
  const view = mount({ probeProps: { options: { hold: false } } });
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => pending[0].resolve(await okFresh({ total: 1 })));
  const first = hook.state.data;

  view.rerender(<Fixture probeProps={{ options: { hold: true } }} />);
  expect(hook.state.stale).toBe(false);
  expect(hook.state.loading).toBe(false);
  expect(hook.state.data).toBe(first);
  expect(pending).toHaveLength(1);

  // hold 동안에는 틱이 요청을 만들지 않는다.
  await act(async () => hook.refresh.refreshNow());
  expect(pending).toHaveLength(1);
  expect(hook.refresh.isRefreshing).toBe(false);
  expect(hook.state.data).toBe(first);

  // hold 동안의 기간 변경도 요청을 만들지 않는다 — 이후 매 렌더에서 stale이 true다.
  const idx = renders.length;
  await act(async () => hook.range.setDays(7));
  expect(pending).toHaveLength(1);
  expect(hook.state.data).toBe(first);
  expect(hook.state.loading).toBe(false);
  expect(hook.refresh.isRefreshing).toBe(false);
  expect(renders.length).toBeGreaterThan(idx);
  renders.slice(idx).forEach((r) => expect(r).toEqual({ days: 7, stale: true, loading: false }));

  // 이미 떠 있던 요청은 hold와 무관하게 정상적으로 끝난다.
  view.unmount();
  const second = mount({ probeProps: { options: { hold: false } } });
  await waitFor(() => expect(pending).toHaveLength(2));
  await act(async () => pending[1].resolve(await okFresh({ total: 1 })));
  await act(async () => hook.refresh.refreshNow());
  expect(hook.refresh.isRefreshing).toBe(true);
  expect(pending).toHaveLength(3);
  second.rerender(<Fixture probeProps={{ options: { hold: true } }} />);
  await act(async () => pending[2].resolve(await okFresh({ total: 2 })));
  expect(hook.state.data).toEqual({ total: 2 });
  expect(hook.refresh.isRefreshing).toBe(false);
  const held = hook.state.data;
  await act(async () => hook.range.setDays(7));
  await act(async () => hook.refresh.refreshNow());
  expect(hook.state.stale).toBe(true);
  expect(hook.state.data).toBe(held);
  expect(pending).toHaveLength(3);
});

test("a linked period change made during hold is a period change after release: the new bounds are requested and a failure clears", async () => {
  const pending = stubPending();
  const boundsA = { from: "2026-09-02T12:00:00.000Z", to: "2026-09-04T12:00:00.000Z" };
  const boundsB = { from: "2026-08-28T12:00:00.000Z", to: "2026-09-04T12:00:00.000Z" };
  const propsA = { path: "/api/codex/insights", params: { client: "codex", ...boundsA }, options: { linkedRange: true, hold: false } };
  const view = mount({ probeProps: propsA });
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => pending[0].resolve(await okFresh({ total: 1 })));
  expect(hook.state.stale).toBe(false);

  view.rerender(<Fixture probeProps={{ path: "/api/codex/insights", params: { client: "codex", ...boundsA }, options: { linkedRange: true, hold: true } }} />);
  await act(async () => hook.range.setDays(7));
  expect(hook.state.stale).toBe(true);
  expect(hook.state.loading).toBe(false);
  expect(hook.state.data).toEqual({ total: 1 });
  expect(pending).toHaveLength(1);

  // hold 해제 + 부모의 새 경계 — 보류됐던 기간 변경이 새 경계로 요청된다.
  view.rerender(<Fixture probeProps={{ path: "/api/codex/insights", params: { client: "codex", ...boundsB }, options: { linkedRange: true, hold: false } }} />);
  expect(hook.state.stale).toBe(true);
  expect(hook.state.loading).toBe(false);
  expect(hook.refresh.isRefreshing).toBe(true);
  expect(pending).toHaveLength(2);
  expect(pending[1].url).toBe("/api/codex/insights?from=2026-08-28T12%3A00%3A00.000Z&to=2026-09-04T12%3A00%3A00.000Z&client=codex");

  await act(async () => pending[1].resolve(fail503()));
  expect(hook.state.stale).toBe(false);
  expect(hook.state.data).toBeNull();
  expect(hook.state.error.message).toBe("/api/codex/insights -> 503");
  expect(hook.state.loading).toBe(false);
  expect(hook.refresh.lastError).toBe(false);
  expect(hook.refresh.isRefreshing).toBe(false);
});

test("a linked period change made during hold replaces the data when the new bounds succeed", async () => {
  const pending = stubPending();
  const boundsA = { from: "2026-09-02T12:00:00.000Z", to: "2026-09-04T12:00:00.000Z" };
  const boundsB = { from: "2026-08-28T12:00:00.000Z", to: "2026-09-04T12:00:00.000Z" };
  const view = mount({ probeProps: { path: "/api/codex/insights", params: { client: "codex", ...boundsA }, options: { linkedRange: true, hold: false } } });
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => pending[0].resolve(await okFresh({ total: 1 })));

  view.rerender(<Fixture probeProps={{ path: "/api/codex/insights", params: { client: "codex", ...boundsA }, options: { linkedRange: true, hold: true } }} />);
  await act(async () => hook.range.setDays(7));
  expect(hook.state.stale).toBe(true);
  expect(pending).toHaveLength(1);

  view.rerender(<Fixture probeProps={{ path: "/api/codex/insights", params: { client: "codex", ...boundsB }, options: { linkedRange: true, hold: false } }} />);
  expect(hook.state.stale).toBe(true);
  expect(hook.refresh.isRefreshing).toBe(true);
  expect(pending).toHaveLength(2);

  await act(async () => pending[1].resolve(await okFresh({ total: 7 })));
  expect(hook.state.stale).toBe(false);
  expect(hook.state.loading).toBe(false);
  expect(hook.state.data).toEqual({ total: 7 });
  expect(hook.refresh.isRefreshing).toBe(false);
  expect(hook.refresh.lastError).toBe(false);
});

test("returning to the displayed period is a refresh: stale clears and a failure keeps the data", async () => {
  const pending = stubPending();
  mount();
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => pending[0].resolve(await okFresh({ total: 1 })));
  const first = hook.state.data;

  await act(async () => hook.range.setDays(7));
  expect(hook.state.stale).toBe(true);
  expect(hook.state.data).toBe(first);
  expect(hook.refresh.isRefreshing).toBe(true);
  expect(pending).toHaveLength(2);

  // 화면의 데이터를 가져온 기간으로 되돌아오면 기다릴 새 기간이 없다 — 새로고침이다.
  await act(async () => hook.range.setDays(2));
  expect(hook.state.stale).toBe(false);
  expect(hook.state.loading).toBe(false);
  expect(hook.state.data).toBe(first);
  expect(hook.refresh.isRefreshing).toBe(true);
  expect(pending).toHaveLength(3);
  expect(pending[1].signal.aborted).toBe(true);
  const params = new URLSearchParams(pending[2].url.split("?")[1]);
  expect(Math.round((new Date(params.get("to")) - new Date(params.get("from"))) / 86400000)).toBe(2);

  // 새로고침 실패는 데이터를 두고 refresh 실패로만 보고한다.
  await act(async () => pending[2].resolve(fail503()));
  expect(hook.state.stale).toBe(false);
  expect(hook.state.loading).toBe(false);
  expect(hook.state.data).toBe(first);
  expect(hook.state.error).toBeNull();
  expect(hook.refresh.lastError).toBe(true);
  expect(hook.refresh.isRefreshing).toBe(false);
});

test("returning to the displayed period and succeeding replaces the data", async () => {
  const pending = stubPending();
  mount();
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => pending[0].resolve(await okFresh({ total: 1 })));
  const first = hook.state.data;
  await act(async () => hook.range.setDays(7));
  await act(async () => hook.range.setDays(2));
  expect(hook.state.stale).toBe(false);
  expect(hook.state.data).toBe(first);
  expect(pending).toHaveLength(3);
  await act(async () => pending[2].resolve(await okFresh({ total: 3 })));
  expect(hook.state.stale).toBe(false);
  expect(hook.state.data).toEqual({ total: 3 });
  expect(hook.refresh.isRefreshing).toBe(false);
  expect(hook.refresh.lastError).toBe(false);
});

// 회귀 핀: hold만 풀리고 다른 deps가 그대로여도 보류된 기간 변경을 바로 요청해야 한다 — deps에서
// hold가 빠지면 다음 틱까지 아무 요청도 나가지 않는다. 위의 linked 테스트는 해제와 함께 경계도
// 바뀌어 이 경우를 가리지 못한다.
test("releasing hold alone sends the held period change as a period change", async () => {
  const pending = stubPending();
  const view = mount({ probeProps: { options: { hold: false } } });
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => pending[0].resolve(await okFresh({ total: 1 })));
  view.rerender(<Fixture probeProps={{ options: { hold: true } }} />);
  await act(async () => hook.range.setDays(7));
  expect(pending).toHaveLength(1);
  view.rerender(<Fixture probeProps={{ options: { hold: false } }} />);
  expect(pending).toHaveLength(2);
  expect(hook.state.stale).toBe(true);
  expect(hook.state.loading).toBe(false);
  expect(hook.refresh.isRefreshing).toBe(true);
  const params = new URLSearchParams(pending[1].url.split("?")[1]);
  expect(Math.round((new Date(params.get("to")) - new Date(params.get("from"))) / 86400000)).toBe(7);
  await act(async () => pending[1].resolve(fail503()));
  expect(hook.state.data).toBeNull();
  expect(hook.state.error.message).toBe("/api/cost/summary -> 503");
  expect(hook.refresh.lastError).toBe(false);
});

// 정체성과 기간이 한 렌더에서 함께 바뀌면 다른 뷰다 — 화면의 데이터가 곧 비워지므로 stale이 아니다.
test("an identity change in the same render as a period change is never stale", async () => {
  const pending = stubPending();
  const view = mount();
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => pending[0].resolve(await okFresh({ total: 1 })));
  const idx = renders.length;
  await act(async () => {
    hook.range.setDays(7);
    view.rerender(<Fixture probeProps={{ path: "/api/cost/by-model" }} />);
  });
  expect(renders.length).toBeGreaterThan(idx);
  expect(renders.slice(idx).map((r) => r.stale)).not.toContain(true);
  expect(hook.state.loading).toBe(true);
  expect(hook.state.data).toBeNull();
});
