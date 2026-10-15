import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RangeProvider } from "../RangeContext.jsx";
import { ModelCostTrend } from "./ModelCostTrend.jsx";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 390, height: 300, top: 0, left: 0, right: 390, bottom: 300, x: 0, y: 0,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const time = "2026-09-01 00:00:00";
const cell = (model, known, extra = {}) => ({
  t: time, model, channel: "bedrock", known, partial: false,
  unavailable: 0, reasons: {}, observed_tokens: 10, estimated: false, ...extra,
});

function mount(dimension, cells, extra = {}) {
  const title = `Codex ${dimension === "user" ? "사용자" : "모델"}별 비용 추이`;
  render(
    <MemoryRouter><RangeProvider>
      <ModelCostTrend title={title} dimension={dimension} cells={cells}
        bucketHours={1} bounds={{ from: "2026-09-01T00:00:00Z", to: "2026-09-01T01:00:00Z" }}
        {...extra} />
    </RangeProvider></MemoryRouter>,
  );
  return title;
}

// JSDOM cannot prove actual scrolling. This guards the focusable overflow boundary;
// the rendered-image mobile gate checks real width, keyboard scroll and final columns.
test.each(["model", "user"])("%s tables expose a named keyboard-focusable horizontal scroll region", (dimension) => {
  const title = mount(dimension, [
    cell("fixture-long-name-a@example.invalid", 2),
    cell("fixture-long-name-b@example.invalid", 0.25, {
      partial: true, unavailable: 1, reasons: { missing_usage: 1 },
    }),
  ]);
  expect(screen.queryByRole("region", { name: `${title} 표` })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "표 보기" }));
  const region = screen.getByRole("region", { name: `${title} 표` });
  expect(region.classList.contains("overflow-x-auto")).toBe(true);
  expect(region.tabIndex).toBe(0);
  region.focus();
  expect(document.activeElement).toBe(region);
  const table = within(region).getByRole("table", { name: "버킷별 비용 표" });
  expect(table.querySelector("th").classList.contains("whitespace-nowrap")).toBe(true);
  expect(table.querySelector("tr[data-bucket] td").classList.contains("whitespace-nowrap")).toBe(true);
  const values = [...table.querySelector("tr[data-bucket]").querySelectorAll("td")].map(td => td.textContent);
  expect(values.slice(1)).toEqual(["$2", "$0.25 ⚠", "$2.25", "부분합"]);
  fireEvent.click(screen.getByRole("button", { name: "표 보기" }));
  expect(screen.queryByRole("region", { name: `${title} 표` })).toBeNull();
});

test.each(["model", "user"])("%s unavailable costs remain unavailable inside the scroll region", (dimension) => {
  const title = mount(dimension, [cell("fixture-unknown@example.invalid", null, {
    unavailable: 1, reasons: { missing_usage: 1 },
  })]);
  fireEvent.click(screen.getByRole("button", { name: "표 보기" }));
  const region = screen.getByRole("region", { name: `${title} 표` });
  const row = within(region).getByRole("table", { name: "버킷별 비용 표" }).querySelector("tr[data-bucket]");
  expect([...row.querySelectorAll("td")].slice(1).map(td => td.textContent))
    .toEqual(["— ⚠", "—", "확인 불가"]);
});

test.each(["model", "user"])("%s overflow details share the same accessible scroll boundary", (dimension) => {
  const title = mount(dimension, [
    cell("fixture-top@example.invalid", 2),
    cell("fixture-other@example.invalid", 0.25),
  ], { top: 1 });
  fireEvent.click(screen.getByRole("button", { name: "표 보기" }));
  const region = screen.getByRole("region", { name: `${title} 표` });
  expect(within(region).getAllByRole("table")).toHaveLength(2);
  const details = within(region).getByRole("table", {
    name: `기타 ${dimension === "user" ? "사용자" : "모델"} 내역`,
  });
  expect(details.querySelector("tbody").textContent).toContain("$0.25");
});
