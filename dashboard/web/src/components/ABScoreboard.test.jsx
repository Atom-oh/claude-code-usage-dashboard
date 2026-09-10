import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ABScoreboard from "./ABScoreboard.jsx";

afterEach(cleanup);

function costSplit(bedrock, enterprise) {
  render(<ABScoreboard rows={[{ label: "기간 비용", format: "usd", betterIs: "low", bedrock, enterprise }]} />);
  const row = screen.getByText("기간 비용").parentElement.parentElement;
  return row.lastElementChild;
}

test.each([
  [null, 7],
  [7, null],
  [undefined, 7],
  [7, undefined],
  [NaN, 7],
  [7, NaN],
  [Infinity, 7],
  [7, -Infinity],
  ["invalid", 7],
])("unavailable A/B operands (%s, %s) render a neutral track, not a complete split", (bedrock, enterprise) => {
  const track = costSplit(bedrock, enterprise);
  expect(track.children).toHaveLength(0);
  expect(screen.queryByLabelText("우세")).toBeNull();
  expect(screen.getByText("—")).toBeTruthy();
});

test.each([
  [0, 7, "0%"],
  [7, 0, "100%"],
  ["0", "7", "0%"],
  [7, 7, "50%"],
])("valid A/B operands (%s, %s) retain the actual share %s", (bedrock, enterprise, width) => {
  const track = costSplit(bedrock, enterprise);
  expect(track.children).toHaveLength(3);
  expect(track.firstElementChild.style.width).toBe(width);
});

test("two legitimate zeros retain the neutral no-share track", () => {
  const track = costSplit(0, 0);
  expect(track.children).toHaveLength(0);
  expect(screen.getAllByText("$0.00")).toHaveLength(2);
});
