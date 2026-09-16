import { afterEach, expect, test } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { RefreshProvider, useRefresh } from "../RefreshContext.jsx";
import { RefreshControl } from "./RefreshControl.jsx";
let refresh;
function Probe() { refresh = useRefresh(); return <RefreshControl />; }
afterEach(() => { cleanup(); localStorage.clear(); });

test("failed background refresh explicitly discloses retained data", () => {
  render(<RefreshProvider><Probe /></RefreshProvider>);
  act(() => refresh.reportFailure());
  expect(screen.getByRole("status").textContent).toBe("갱신 실패 · 이전 데이터 표시");
});

test("the displayed timestamp describes an attempt, not completed data", () => {
  render(<RefreshProvider><Probe /></RefreshProvider>);
  act(() => refresh.refreshNow());
  expect(screen.getByRole("status").textContent).toContain("갱신 시도");
});

test("pending status remains until every background request ends and ending twice is harmless", () => {
  render(<RefreshProvider><Probe /></RefreshProvider>);
  let first, second;
  act(() => { first = refresh.beginRequest(); second = refresh.beginRequest(); });
  expect(screen.getByRole("status").textContent).toBe("갱신 중 · 이전 데이터 표시");
  act(() => { first(); first(); });
  expect(refresh.isRefreshing).toBe(true);
  act(() => second());
  expect(refresh.isRefreshing).toBe(false);
  expect(refresh.tick).toBe(0);
});
