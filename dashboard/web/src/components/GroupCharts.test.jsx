import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RangeProvider } from "../RangeContext.jsx";
import { SeriesBarChart } from "./GroupCharts.jsx";

// jsdom has no layout or ResizeObserver. Keep the real Recharts render path and
// supply only the browser dimensions its ResponsiveContainer needs.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 800, height: 300, top: 0, left: 0, right: 800, bottom: 300, x: 0, y: 0,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Providers({ children }) {
  return <MemoryRouter><RangeProvider>{children}</RangeProvider></MemoryRouter>;
}

const props = { title: "모델별 비용 추이", xKey: "day", seriesKey: "model", valueKey: "cost", valuePrefix: "$" };
const known = { day: "2026-09-08", model: "claude-opus-5", cost: 7 };
const missing = { day: "2026-09-08", model: "claude-sonnet-5", cost: null };

function mount(rows, extra = {}) {
  return render(<SeriesBarChart {...props} rows={rows} {...extra} />, { wrapper: Providers });
}

test("a mixed known/null bucket suppresses the entire stack and identifies the unavailable date/model", () => {
  const { container } = mount([known, missing]);
  const status = screen.getByRole("status");
  expect(status.textContent).toContain("확인 필요");
  expect(status.textContent).toContain("2026-09-08");
  expect(status.textContent).toContain("claude-sonnet-5");
  expect(status.textContent).not.toContain("claude-opus-5");
  expect(container.querySelector(".recharts-wrapper")).toBeNull();
  expect(container.querySelector(".recharts-tooltip-wrapper")).toBeNull();
  expect(screen.getByText("모델별 비용 추이")).toBeTruthy();
});

test("all-null buckets name every affected pair instead of looking like zero activity", () => {
  const { container } = mount([missing, { ...known, day: "2026-09-09", cost: null }]);
  const status = screen.getByRole("status");
  const items = within(status).getAllByRole("listitem");
  expect(items.map((li) => li.textContent)).toEqual([
    expect.stringContaining("2026-09-08"),
    expect.stringContaining("2026-09-09"),
  ]);
  expect(items[0].textContent).toContain("claude-sonnet-5");
  expect(items[1].textContent).toContain("claude-opus-5");
  expect(container.querySelector(".recharts-wrapper")).toBeNull();
});

test.each([undefined, NaN, Infinity, -Infinity, "", " ", "invalid", false, []])(
  "invalid selected metric %j suppresses the stack before numeric coercion",
  (cost) => {
    const { container } = mount([known, { ...missing, cost }]);
    expect(screen.getByRole("status").textContent).toContain("claude-sonnet-5");
    expect(container.querySelector(".recharts-wrapper")).toBeNull();
  }
);

test.each([
  [0, 7],
  ["0", "7"],
  [0, 0],
])("legitimate values (%s, %s) still render the real chart", async (first, second) => {
  const { container } = mount([{ ...known, cost: first }, { ...missing, cost: second }]);
  await waitFor(() => expect(container.querySelector(".recharts-wrapper svg")).not.toBeNull());
  expect(screen.queryByRole("status")).toBeNull();
  expect(container.querySelector(".recharts-legend-wrapper").textContent).toContain("claude-sonnet-5");
});

test("incomplete state bounds the affected list and reports how many pairs are affected", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ day: "2026-09-08", model: `model-${i}`, cost: null }));
  mount(rows);
  const status = screen.getByRole("status");
  const items = within(status).getAllByRole("listitem");
  expect(items.length).toBeGreaterThan(0);
  expect(items.length).toBeLessThan(12);
  expect(status.textContent).toContain("12개");
  expect(status.textContent).toMatch(/외 \d+개/);
});

test("selected metric alone controls incompleteness and the axis formatter still masks user labels", async () => {
  const { container, rerender } = mount([known, missing], { valueKey: "tokens", rows: [{ ...missing, tokens: 12 }] });
  await waitFor(() => expect(container.querySelector(".recharts-wrapper svg")).not.toBeNull());
  expect(screen.queryByRole("status")).toBeNull();
  rerender(<SeriesBarChart {...props} xKey="user" rows={[{ ...missing, user: "private@example.com" }]} tickFormatter={() => "pr***"} />);
  const status = screen.getByRole("status");
  expect(status.textContent).toContain("pr***");
  expect(status.textContent).not.toContain("private@example.com");
});

test("header controls recover from incomplete data without changing hook order", async () => {
  function RangeControlChart() {
    const [complete, setComplete] = useState(false);
    return <SeriesBarChart {...props}
      rows={complete ? [known, { ...missing, cost: 0 }] : [known, missing]}
      subtitle="선택 기간"
      right={<button onClick={() => setComplete((v) => !v)}>기간 변경</button>}
    />;
  }
  const { container } = render(<RangeControlChart />, { wrapper: Providers });
  expect(screen.getByRole("status")).toBeTruthy();
  expect(screen.getByText("선택 기간")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "기간 변경" }));
  await waitFor(() => expect(container.querySelector(".recharts-wrapper svg")).not.toBeNull());
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "기간 변경" }));
  expect(screen.getByRole("status")).toBeTruthy();
  expect(container.querySelector(".recharts-wrapper")).toBeNull();
});
