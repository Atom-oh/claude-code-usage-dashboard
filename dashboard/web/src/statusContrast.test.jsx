import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Loading } from "./components/Card.jsx";
import { SegmentedControl } from "./components/SegmentedControl.jsx";

afterEach(cleanup);

const css = readFileSync(resolve("src/index.css"), "utf8");
const rgb = token => {
  const match = css.match(new RegExp(`--${token}:\\s*#([0-9a-f]{6})`, "i"));
  if (!match) throw new Error(`missing status color token: ${token}`);
  return match[1].match(/../g).map(value => parseInt(value, 16));
};
const luminance = values => values.map(value => {
  const n = value / 255;
  return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
}).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
const contrast = (fg, bg) => {
  const a = luminance(fg), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

test("partial-coverage warning text has normal-text contrast on its actual surface", () => {
  expect(contrast(rgb("warning-text"), rgb("warning-surface"))).toBeGreaterThanOrEqual(4.5);
});

test("selected resolution controls expose their state and readable text contrast", () => {
  render(<SegmentedControl options={["10분", "시간별"]} value="시간별" />);
  const selected = screen.getByRole("button", { name: "시간별" });
  expect(selected.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "10분" }).getAttribute("aria-pressed")).toBe("false");
  expect(selected.className).toContain("bg-brand-700");
  expect(contrast(rgb("white"), rgb("brand-700"))).toBeGreaterThanOrEqual(4.5);
});

test("active loading uses readable ink on page and card surfaces", () => {
  render(<Loading />);
  expect(screen.getByText("불러오는 중...").className).toContain("text-ink-500");
  for (const background of [rgb("paper"), rgb("white")])
    expect(contrast(rgb("ink-500"), background)).toBeGreaterThanOrEqual(4.5);
});

test("channel label ink retains contrast on each 9 percent tint and supported light surface", () => {
  for (const surface of [rgb("paper"), rgb("white")]) {
    for (const channel of [rgb("chart-1"), rgb("chart-2"), rgb("ink-400")]) {
      for (const strength of [0.06, 0.09]) {
        const tint = channel.map((value, i) => strength * value + (1 - strength) * surface[i]);
        expect(contrast(rgb("ink-700"), tint)).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
});
