import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RangeProvider, useRange } from "../RangeContext.jsx";
import { DonutBody, DualLineChart, GroupAreaChart, GroupBarChart, SeriesBarChart } from "./GroupCharts.jsx";

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

test("time-axis drag zoom preserves UTC instants, caps the last bucket and ignores clicks", async () => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  function Selection() {
    const { custom } = useRange();
    return <output aria-label="선택 구간">{custom
      ? `${custom.from.toISOString()} / ${custom.to.toISOString()}` : "none"}</output>;
  }
  const start = Date.UTC(2026, 8, 1);
  const { container } = render(<>
    <DualLineChart title="시간 축" xKey="t" bucketHours={1}
      timeDomain={[start, Date.UTC(2026, 8, 1, 11, 30)]}
      rows={[{ t: start, value: 1 }, { t: Date.UTC(2026, 8, 1, 2), value: 2 },
        { t: Date.UTC(2026, 8, 1, 11), value: 3 }]}
      lines={[{ key: "value" }]} />
    <Selection />
  </>, { wrapper: Providers });
  await waitFor(() => expect(container.querySelector(".recharts-wrapper")).not.toBeNull());
  const chart = container.querySelector(".recharts-wrapper");
  const grid = chart.querySelector(".recharts-cartesian-grid-horizontal line");
  const left = Number(grid.getAttribute("x1")), right = Number(grid.getAttribute("x2"));
  const x = (hour) => left + (right - left) * hour / 11.5;
  fireEvent.mouseDown(chart, { clientX: x(2), clientY: 80 });
  fireEvent.mouseUp(chart, { clientX: x(2), clientY: 80 });
  expect(screen.getByLabelText("선택 구간").textContent).toBe("none");
  fireEvent.mouseDown(chart, { clientX: x(2), clientY: 80 });
  fireEvent.mouseMove(chart, { clientX: x(11), clientY: 80 });
  fireEvent.mouseUp(chart, { clientX: x(11), clientY: 80 });
  await waitFor(() => expect(screen.getByLabelText("선택 구간").textContent)
    .toBe("2026-09-01T02:00:00.000Z / 2026-09-01T11:30:00.000Z"));
});

test.each([
  [false, "2026-09-01T00:00:00.000Z / 2026-09-03T01:00:00.000Z", 1],
  [true, "none", 0],
])("SeriesBarChart zoomDisabled=%s: a drag across daily bars with bucketHours=1 sets %s", async (disabled, expected, refAreas) => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  function Selection() {
    const { custom } = useRange();
    return <output aria-label="선택 구간">{custom
      ? `${custom.from.toISOString()} / ${custom.to.toISOString()}` : "none"}</output>;
  }
  const rows = ["2026-09-01", "2026-09-02", "2026-09-03"].map((day) => ({ day, model: "m1", cost: 1 }));
  const { container } = render(<>
    <SeriesBarChart title="모델별 비용 추이" xKey="day" seriesKey="model" valueKey="cost"
      rows={rows} bucketHours={1} zoomDisabled={disabled} />
    <Selection />
  </>, { wrapper: Providers });
  await waitFor(() => expect(container.querySelector(".recharts-wrapper")).not.toBeNull());
  const chart = container.querySelector(".recharts-wrapper");
  const grid = chart.querySelector(".recharts-cartesian-grid-horizontal line");
  const left = Number(grid.getAttribute("x1")), right = Number(grid.getAttribute("x2"));
  const x = (i) => left + (right - left) * (i + 0.5) / 3;
  fireEvent.mouseDown(chart, { clientX: x(0), clientY: 80 });
  fireEvent.mouseMove(chart, { clientX: x(2), clientY: 80 });
  expect(container.querySelectorAll(".recharts-reference-area").length).toBe(refAreas);
  fireEvent.mouseUp(chart, { clientX: x(2), clientY: 80 });
  await waitFor(() => expect(screen.getByLabelText("선택 구간").textContent).toBe(expected));
});

// mouseDown 가드만으로는 부족한 경우: 드래그를 시작한 뒤 놓기 전에 zoomDisabled가 켜지면 mouseUp
// 가드가 줌을 막는다.
test("a drag that becomes zoom-disabled before mouseup does not zoom", async () => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  function Selection() {
    const { custom } = useRange();
    return <output aria-label="선택 구간">{custom
      ? `${custom.from.toISOString()} / ${custom.to.toISOString()}` : "none"}</output>;
  }
  const rows = ["2026-09-01", "2026-09-02", "2026-09-03"].map((day) => ({ day, model: "m1", cost: 1 }));
  const chartWith = (zoomDisabled) => <>
    <SeriesBarChart title="모델별 비용 추이" xKey="day" seriesKey="model" valueKey="cost"
      rows={rows} bucketHours={24} zoomDisabled={zoomDisabled} />
    <Selection />
  </>;
  const { container, rerender } = render(chartWith(false), { wrapper: Providers });
  await waitFor(() => expect(container.querySelector(".recharts-wrapper")).not.toBeNull());
  const chart = container.querySelector(".recharts-wrapper");
  const grid = chart.querySelector(".recharts-cartesian-grid-horizontal line");
  const left = Number(grid.getAttribute("x1")), right = Number(grid.getAttribute("x2"));
  const x = (i) => left + (right - left) * (i + 0.5) / 3;
  fireEvent.mouseDown(chart, { clientX: x(0), clientY: 80 });
  fireEvent.mouseMove(chart, { clientX: x(2), clientY: 80 });
  expect(container.querySelectorAll(".recharts-reference-area").length).toBe(1);
  rerender(chartWith(true));
  fireEvent.mouseUp(container.querySelector(".recharts-wrapper"), { clientX: x(2), clientY: 80 });
  await waitFor(() => expect(screen.getByLabelText("선택 구간").textContent).toBe("none"));
});

// GroupAreaChart와 DualLineChart도 zoomDisabled를 각 줌 훅에 전달해야 한다. DualLineChart는
// 상단·하단 패널이 서로 다른 훅을 쓰므로 두 패널을 각각 드래그해 확인한다.
test.each([
  ["GroupAreaChart", false, 0],
  ["GroupAreaChart", true, 0],
  ["DualLineChart top panel", false, 0],
  ["DualLineChart top panel", true, 0],
  ["DualLineChart bottom panel", false, 1],
  ["DualLineChart bottom panel", true, 1],
])("%s zoomDisabled=%s: a drag across hourly points respects the guard", async (name, disabled, panel) => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  function Selection() {
    const { custom } = useRange();
    return <output aria-label="선택 구간">{custom
      ? `${custom.from.toISOString()} / ${custom.to.toISOString()}` : "none"}</output>;
  }
  const hours = ["2026-09-01 00:00:00", "2026-09-01 01:00:00", "2026-09-01 02:00:00"];
  const areaRows = hours.map((t, i) => ({ t, group: "bedrock", v: 1 + i }));
  const dualRows = hours.map((t, i) => ({ t, a: 1 + i, b: 2 + i }));
  const el = name === "GroupAreaChart"
    ? <GroupAreaChart title="t" xKey="t" valueKey="v" rows={areaRows} zoomDisabled={disabled} />
    : <DualLineChart title="t" xKey="t" rows={dualRows}
      lines={[{ key: "a" }, { key: "b", axis: "right" }]} zoomDisabled={disabled} />;
  const { container } = render(<>{el}<Selection /></>, { wrapper: Providers });
  await waitFor(() => expect(container.querySelectorAll(".recharts-wrapper").length).toBeGreaterThan(panel));
  const chart = container.querySelectorAll(".recharts-wrapper")[panel];
  const grid = chart.querySelector(".recharts-cartesian-grid-horizontal line");
  const left = Number(grid.getAttribute("x1")), right = Number(grid.getAttribute("x2"));
  // 선·영역 차트의 x축은 point 축이므로 점 위치로 계산한다.
  const x = (i) => left + (right - left) * i / 2;
  fireEvent.mouseDown(chart, { clientX: x(0), clientY: 40 });
  fireEvent.mouseMove(chart, { clientX: x(2), clientY: 40 });
  expect(chart.querySelectorAll(".recharts-reference-area").length).toBe(disabled ? 0 : 1);
  fireEvent.mouseUp(chart, { clientX: x(2), clientY: 40 });
  await waitFor(() => expect(screen.getByLabelText("선택 구간").textContent)
    .toBe(disabled ? "none" : "2026-09-01T00:00:00.000Z / 2026-09-01T03:00:00.000Z"));
});

const animationCases = [
  ["GroupAreaChart", () => <GroupAreaChart title="t" xKey="day" valueKey="v"
    rows={[{ day: "2026-09-01", group: "bedrock", v: 1 }, { day: "2026-09-02", group: "bedrock", v: 2 }]} />],
  ["GroupBarChart", () => <GroupBarChart title="t" valueKey="v"
    rows={[{ group: "bedrock", v: 1 }, { group: "enterprise", v: 2 }]} />],
  ["SeriesBarChart", () => <SeriesBarChart title="t" xKey="day" seriesKey="model" valueKey="cost"
    rows={[{ day: "2026-09-01", model: "m1", cost: 1 }, { day: "2026-09-02", model: "m1", cost: 2 }]} />],
  ["DualLineChart", () => <DualLineChart title="t" xKey="t" lines={[{ key: "a" }]}
    rows={[{ t: "2026-09-01", a: 1 }, { t: "2026-09-02", a: 2 }]} />],
  ["DonutBody", () => <DonutBody nameKey="n" valueKey="v" data={[{ n: "x", v: 1 }, { n: "y", v: 2 }]} />],
];

// With series animation on, recharts draws the start frame first (Area: an
// "animationClipPath" clipPath; Line: stroke-dasharray="0px 0px"; Bar/Pie: no shape
// path yet). With isAnimationActive={false} the final geometry renders immediately.
test.each(animationCases)("%s renders its final geometry immediately (series animation disabled)", async (name, el) => {
  const { container } = render(el(), { wrapper: Providers });
  await waitFor(() => expect(container.querySelector(".recharts-wrapper svg")).not.toBeNull());
  switch (name) {
    case "GroupAreaChart": {
      expect(container.querySelectorAll('clipPath[id^="animationClipPath"]').length).toBe(0);
      expect(container.querySelectorAll(".recharts-area-area").length).toBe(1);
      break;
    }
    case "GroupBarChart":
    case "SeriesBarChart": {
      const rectangles = container.querySelectorAll(".recharts-bar-rectangle").length;
      expect(rectangles).toBe(2);
      expect(container.querySelectorAll(".recharts-bar-rectangle path").length).toBe(rectangles);
      break;
    }
    case "DualLineChart": {
      const curve = container.querySelector(".recharts-line-curve");
      expect(curve).not.toBeNull();
      expect(curve.getAttribute("stroke-dasharray")).toBe(null);
      break;
    }
    case "DonutBody": {
      expect(container.querySelectorAll(".recharts-pie-sector path").length).toBe(2);
      break;
    }
  }
});
