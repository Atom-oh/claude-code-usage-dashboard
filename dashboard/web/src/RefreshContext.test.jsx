import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { RefreshProvider, useRefresh } from "./RefreshContext.jsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

let api = null;
function Probe() {
  api = useRefresh();
  return <span data-testid="v">{`${api.tick}|${api.intervalMs}|${api.lastError}`}</span>;
}

test("default interval is 60000 and tick is 0 at first paint", () => {
  vi.useFakeTimers();
  render(
    <RefreshProvider>
      <Probe />
    </RefreshProvider>
  );
  // tick이 0이어야 한다 — visibilitychange 이펙트 본문에서 bump()가 호출되면 마운트 시
  // tick이 1이 되어 모든 페이지가 첫 로드에 두 번 fetch하게 된다.
  expect(api.intervalMs).toBe(60_000);
  expect(api.tick).toBe(0);
});

test("advancing one interval produces tick 1", () => {
  vi.useFakeTimers();
  render(
    <RefreshProvider>
      <Probe />
    </RefreshProvider>
  );
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(api.tick).toBe(1);
});

test("setIntervalMs(0) disables the timer entirely", () => {
  vi.useFakeTimers();
  render(
    <RefreshProvider>
      <Probe />
    </RefreshProvider>
  );
  act(() => api.setIntervalMs(0));
  act(() => {
    vi.advanceTimersByTime(300_000);
  });
  expect(api.tick).toBe(0);
});

test("setIntervalMs persists to localStorage", () => {
  vi.useFakeTimers();
  render(
    <RefreshProvider>
      <Probe />
    </RefreshProvider>
  );
  act(() => api.setIntervalMs(15_000));
  expect(localStorage.getItem("ccdash.refreshMs")).toBe("15000");
});

// readStored의 두 방향을 함께 핀다: 저장된 값은 그대로 살아나야 하고, 그중 "0"(끔)도
// 살아나야 한다. 캐스팅을 raw || DEFAULT 나 Number(raw) 로 되돌리면 둘 중 하나가 깨진다 —
// 후자는 키가 아예 없을 때 Number(null)===0 이라 첫 방문자가 끔으로 시작한다.
test("stored interval hydrates, including an explicit 0 (끔)", () => {
  vi.useFakeTimers();
  localStorage.setItem("ccdash.refreshMs", "15000");
  render(
    <RefreshProvider>
      <Probe />
    </RefreshProvider>
  );
  expect(api.intervalMs).toBe(15_000);
  cleanup();

  localStorage.setItem("ccdash.refreshMs", "0");
  render(
    <RefreshProvider>
      <Probe />
    </RefreshProvider>
  );
  expect(api.intervalMs).toBe(0);
  cleanup();

  // 알 수 없는 값·빈 문자열은 기본값으로 접힌다.
  for (const bad of ["99", "abc", ""]) {
    localStorage.setItem("ccdash.refreshMs", bad);
    render(
      <RefreshProvider>
        <Probe />
      </RefreshProvider>
    );
    expect(api.intervalMs).toBe(60_000);
    cleanup();
  }
});

test("backoff: a failure sets lastError, skips the next tick, then resumes", () => {
  vi.useFakeTimers();
  render(
    <RefreshProvider>
      <Probe />
    </RefreshProvider>
  );
  act(() => api.reportFailure());
  expect(api.lastError).toBe(true);

  // 실패 다음 틱은 건너뛴다 — tick은 그대로다.
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(api.tick).toBe(0);
  expect(api.lastError).toBe(true);

  // 그 다음 틱은 정상적으로 진행되어 tick이 늘고 lastError가 풀린다.
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(api.tick).toBe(1);
  expect(api.lastError).toBe(false);
});

test("hidden tab skips ticks; returning to visible bumps once", () => {
  vi.useFakeTimers();
  render(
    <RefreshProvider>
      <Probe />
    </RefreshProvider>
  );
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(api.tick).toBe(0);

  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(api.tick).toBe(1);
});
