import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ConfigProvider } from "../ConfigContext.jsx";
import { FilterProvider } from "../FilterContext.jsx";
import { FilterBar } from "./FilterBar.jsx";

afterEach(() => cleanup());

const cfg = (extra = {}) => ({ piiMask: false, groupMode: "ab", defaultRangeDays: 7, rangeCapDays: 90, schema: {}, ...extra });

function mount(config) {
  return render(
    <MemoryRouter initialEntries={["/cost"]}>
      <ConfigProvider config={config}>
        <FilterProvider>
          <FilterBar />
        </FilterProvider>
      </ConfigProvider>
    </MemoryRouter>
  );
}

test("ab 모드에서는 채널 컨트롤(전체/bedrock/enterprise)이 모두 보인다", () => {
  mount(cfg());
  expect(screen.getByText("bedrock")).toBeTruthy();
  expect(screen.getByText("enterprise")).toBeTruthy();
  expect(screen.getByText("전체")).toBeTruthy();
});

test("single 모드에서는 채널 컨트롤이 통째로 사라진다", () => {
  mount(cfg({ groupMode: "single" }));
  expect(screen.queryByText("bedrock")).toBeNull();
  expect(screen.queryByText("enterprise")).toBeNull();
  expect(screen.queryByText("전체")).toBeNull();
});

test("single 모드에서도 유저/모델 검색 입력창은 그대로 렌더된다", () => {
  mount(cfg({ groupMode: "single" }));
  expect(screen.getByPlaceholderText("유저 검색...")).toBeTruthy();
  expect(screen.getByPlaceholderText("모델 검색...")).toBeTruthy();
});

test("ConfigProvider가 없어도 기본값(ab)이라 채널 컨트롤이 보인다", () => {
  render(
    <MemoryRouter initialEntries={["/cost"]}>
      <FilterProvider>
        <FilterBar />
      </FilterProvider>
    </MemoryRouter>
  );
  expect(screen.getByText("bedrock")).toBeTruthy();
});
