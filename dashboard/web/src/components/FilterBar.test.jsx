import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

test("single 모드에서도 사용자/모델 검색 입력창은 그대로 렌더된다", () => {
  mount(cfg({ groupMode: "single" }));
  expect(screen.getByPlaceholderText("사용자 검색")).toBeTruthy();
  expect(screen.getByPlaceholderText("모델 검색")).toBeTruthy();
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

test("projectColumns가 true면 프로젝트 입력창이 렌더된다", () => {
  mount(cfg({ schema: { projectColumns: true } }));
  expect(screen.getByPlaceholderText("프로젝트")).toBeTruthy();
});

// false/null/누락은 전부 "적용 안 됨"이다 — null(프로브 실패)이 통과하면 아무 일도 하지 않는
// 입력창이 보이고, 서버는 그 파라미터를 버린다.
test("projectColumns가 true가 아니면 프로젝트 입력창이 없다", () => {
  for (const schema of [{ projectColumns: false }, { projectColumns: null }, {}, undefined]) {
    mount(cfg({ schema }));
    expect(screen.queryByPlaceholderText("프로젝트")).toBeNull();
    cleanup();
  }
});

// 프로젝트 필터가 실제로 적용되는 라우트는 4개뿐이라(queries.js에서 cols.project를 넘기는 쿼리)
// 적용 범위를 UI에 적는다 — PR #31 리뷰 MAJOR-3의 선택지 (a). 값이 들어 있을 때만 띄운다:
// Executive/Trends의 "모델 필터 미적용" 배지와 같은 규약이고, 빈 칸에서도 늘 보이면 필터 줄이
// 경고문으로 덮인다. 문장 전체를 정확일치로 찾는다 — 입력창 title에도 비슷한 문구가 있지만
// title은 텍스트 노드가 아니라 속성이라 getByText가 잡지 않는다.
const SCOPE_NOTE = "프로젝트 필터는 Usage의 프로젝트·진입점·권한 모드·승인 출처 카드에만 적용됩니다.";

test("프로젝트 입력이 비어 있으면 적용 범위 안내는 보이지 않는다", () => {
  mount(cfg({ schema: { projectColumns: true } }));
  expect(screen.getByPlaceholderText("프로젝트")).toBeTruthy();
  expect(screen.queryByText(SCOPE_NOTE)).toBeNull();
});

test("프로젝트 값을 입력하면 적용 범위 안내가 보인다", () => {
  mount(cfg({ schema: { projectColumns: true } }));
  fireEvent.change(screen.getByPlaceholderText("프로젝트"), { target: { value: "repo-a" } });
  expect(screen.getByText(SCOPE_NOTE)).toBeTruthy();
});
