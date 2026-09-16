import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ConfigProvider } from "./ConfigContext.jsx";
import { RefreshProvider, useRefresh } from "./RefreshContext.jsx";
import { RangeProvider, useRange } from "./RangeContext.jsx";
import { FilterProvider } from "./FilterContext.jsx";
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

let hook = null;
const loadings = [];
function Probe({ path = "/api/cost/summary", params = {}, enabled = true, options } = {}) {
  const state = useApi(path, params, enabled, options);
  const refresh = useRefresh();
  const range = useRange();
  loadings.push(state.loading);
  hook = { state, refresh, range };
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

test("실제 파라미터 변경(setDays)은 loading을 true로 뒤집고 from을 바꾼다", async () => {
  const fetchMock = stubFetch(() => okFresh({ total: 1 }));
  mount();
  await waitFor(() => expect(hook.state.loading).toBe(false));

  // 마운트 자체가 loading:true를 한 번 기록하므로 loadings.includes(true)는 무조건 참이다 —
  // 파라미터 변경 이후 구간만 잘라서 봐야 이 케이스가 (a)~(c)의 대조군 역할을 한다.
  const idxBeforeChange = loadings.length;
  await act(async () => {
    hook.range.setDays(7);
  });
  await waitFor(() => expect(hook.state.loading).toBe(false));
  expect(loadings.slice(idxBeforeChange).includes(true)).toBe(true);

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
  expect(panel.isConnected).toBe(true);
  expect(screen.getByRole("region", { name: "Loaded data" })).toBe(panel);
  await act(async () => resolveRefresh(await okFresh({ total: 42 })));
  expect(hook.state.data).toBe(first);
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
  expect(panel.isConnected).toBe(true);
  await act(async () => resolveRequest(await okFresh({ total: 43 })));
  expect(hook.state.data?.total).toBe(43);
  view.rerender(<Fixture probeProps={{ ...next, params: { ...next.params, client: "claude" } }} />);
  expect(hook.state.loading).toBe(true);
  expect(panel.isConnected).toBe(false);
});

test("explicit extra bounds remain a new selection unless linked to the parent response", async () => {
  let calls = 0;
  stubFetch(() => ++calls === 1 ? okFresh({ total: 1 }) : new Promise(() => {}));
  const probeProps = { params: { from: "2026-09-01T00:00:00Z", to: "2026-09-02T00:00:00Z" } };
  const view = mount({ probeProps });
  await waitFor(() => expect(hook.state.data?.total).toBe(1));
  view.rerender(<Fixture probeProps={{ params: { ...probeProps.params, to: "2026-09-03T00:00:00Z" } }} />);
  expect(hook.state.loading).toBe(true);
  expect(hook.state.data).toBeNull();
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
