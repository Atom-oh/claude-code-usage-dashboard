import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as csv from "../csv.js";
import { DataTable } from "./DataTable.jsx";

// DataTable은 프로바이더 없이 렌더된다(useRange()/useConfig()는 기본값으로 동작).
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const columns = [{ key: "a", label: "A" }];

test("a stale table disables CSV export and explains why", () => {
  const spy = vi.spyOn(csv, "downloadCsv").mockImplementation(() => {});
  render(<DataTable title="표" columns={columns} rows={[{ a: 1 }]} exportName="x" stale />);
  const button = screen.getByRole("button", { name: "CSV" });
  expect(button.disabled).toBe(true);
  expect(button.title).toBe("새 기간의 데이터를 불러오는 중에는 내보낼 수 없습니다");
  fireEvent.click(button);
  expect(spy).not.toHaveBeenCalled();
});

test("the same table exports again once it is no longer stale", () => {
  const spy = vi.spyOn(csv, "downloadCsv").mockImplementation(() => {});
  const { rerender } = render(<DataTable title="표" columns={columns} rows={[{ a: 1 }]} exportName="x" stale />);
  rerender(<DataTable title="표" columns={columns} rows={[{ a: 1 }]} exportName="x" />);
  const button = screen.getByRole("button", { name: "CSV" });
  expect(button.disabled).toBe(false);
  expect(button.title).toBe("현재 표를 CSV로 내려받기");
  fireEvent.click(button);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0][1]).toContain("A");
  expect(spy.mock.calls[0][1]).toContain("1");
});

test("an empty table stays disabled without stale", () => {
  vi.spyOn(csv, "downloadCsv").mockImplementation(() => {});
  render(<DataTable title="표" columns={columns} rows={[]} exportName="x" />);
  expect(screen.getByRole("button", { name: "CSV" }).disabled).toBe(true);
});
