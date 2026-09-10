// 이 파일의 달력 단정문은 로컬/UTC 포맷터 차이를 봐야 한다 — 이 머신과 CI가 모두 UTC라
// TZ를 고정하지 않으면 하루 밀리는 버그가 보이지 않는다(한국 사용자에게만 보인다).
process.env.TZ = "Asia/Seoul";

import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import App from "./App.jsx";
import { ConfigProvider } from "./ConfigContext.jsx";

// urlState.test.js는 순수 매핑만 핀다. 여기서는 RangeProvider/FilterProvider가 실제로 URL을
// 읽고 되쓰는 경로를 본다 — 두 provider가 마운트 시 같은 틱에 setSearchParams를 부르고 마지막
// navigate가 이기므로, 한쪽이 다른 쪽의 키를 잘못 보존하면 순수 테스트는 그대로 통과한다
// (실측 2026-09-03: 마스킹 ON에서 RangeProvider가 들어온 user를 보존해 원본 이메일이 URL에
// 남았다).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let loc = null;
function LocationSpy() {
  loc = useLocation();
  return null;
}

function stubFetch() {
  const fetchMock = vi.fn((url) => {
    const u = String(url);
    const body = u.startsWith("/api/config")
      ? { piiMask: false, pricing: { cacheWriteTtl: "1h", overriddenModels: [] }, schema: {} }
      : u.startsWith("/api/health/data")
        ? { status: "ok", latest: null, ageMinutes: 0, staleAfterMinutes: 360 }
        : [];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  loc = null;
});

function mount(entry, config) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <ConfigProvider config={config}>
        <LocationSpy />
        <App />
      </ConfigProvider>
    </MemoryRouter>
  );
}

const cfg = (extra = {}) => ({ piiMask: false, groupMode: "ab", defaultRangeDays: 7, rangeCapDays: 90, schema: {}, ...extra });

const presetButtons = (container) => [...container.querySelectorAll("button")].filter((b) => /^\d+일$/.test(b.textContent));
// SegmentedControl은 활성 옵션에만 bg-brand-500을 준다 — aria-pressed가 없어 클래스로 본다.
const activePreset = (container) => presetButtons(container).find((b) => b.className.includes("bg-brand-500"))?.textContent;
const dataCalls = (fetchMock, prefix) => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith(prefix));

test("링크의 days/group/user가 range picker와 필터를 시딩하고 마운트 후에도 URL에 남는다 (마스킹 OFF)", async () => {
  const fetchMock = stubFetch();
  const { container } = mount("/cost?days=30&group=bedrock&user=alice%40example.com", cfg());
  await waitFor(() => expect(dataCalls(fetchMock, "/api/cost").length).toBeGreaterThan(0));
  expect(activePreset(container)).toBe("30일");
  const p = new URLSearchParams(loc.search);
  expect(p.get("days")).toBe("30");
  expect(p.get("group")).toBe("bedrock");
  expect(p.get("user")).toBe("alice@example.com");
  // 입력창만 시딩되고 debounce 값이 비면 첫 fetch가 무필터로 나간다 — 첫 호출부터 필터가 실려야 한다.
  expect(dataCalls(fetchMock, "/api/cost")[0]).toMatch(/group=bedrock/);
  expect(dataCalls(fetchMock, "/api/cost")[0]).toMatch(/user=alice/);
});

test("빈 URL은 config의 defaultRangeDays를 쓰고, 프리셋을 바꾸면 days가 URL에 써진다", async () => {
  const fetchMock = stubFetch();
  const { container } = mount("/cost", cfg());
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(activePreset(container)).toBe("7일");
  fireEvent.click(presetButtons(container).find((b) => b.textContent === "30일"));
  await waitFor(() => expect(new URLSearchParams(loc.search).get("days")).toBe("30"));
  expect(activePreset(container)).toBe("30일");
});

test("마스킹 ON: 링크의 user는 필터로도 URL로도 살아나지 않고, group은 유지된다", async () => {
  const fetchMock = stubFetch();
  mount("/cost?days=7&group=enterprise&user=alice%40example.com", cfg({ piiMask: true }));
  await waitFor(() => expect(dataCalls(fetchMock, "/api/cost").length).toBeGreaterThan(0));
  expect(dataCalls(fetchMock, "/api/cost").every((u) => !/user=/.test(u))).toBe(true);
  const p = new URLSearchParams(loc.search);
  expect(p.get("group")).toBe("enterprise");
  expect(p.get("user")).toBeNull();
});

test("rangeCapDays보다 긴 프리셋은 picker에 나오지 않는다", async () => {
  const fetchMock = stubFetch();
  const { container } = mount("/cost", cfg({ rangeCapDays: 7, defaultRangeDays: 2 }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  // "이번 달" 버튼은 presetButtons의 /^\d+일$/ 정규식에 걸리지 않아 여기 안 잡힌다.
  expect(presetButtons(container).map((b) => b.textContent)).toEqual(["1일", "2일", "7일"]);
});

test("period=month는 필터가 바뀌어도 URL에 남고, 프리셋을 누르면 period가 사라진다", async () => {
  const fetchMock = stubFetch();
  const { container } = mount("/cost?period=month", cfg());
  await waitFor(() => expect(dataCalls(fetchMock, "/api/cost").length).toBeGreaterThan(0));
  fireEvent.click([...container.querySelectorAll("button")].find((b) => b.textContent === "bedrock"));
  await waitFor(() => {
    const p = new URLSearchParams(loc.search);
    expect(p.get("period")).toBe("month");
    expect(p.get("group")).toBe("bedrock");
    expect(p.has("days")).toBe(false);
  });
  fireEvent.click(presetButtons(container).find((b) => b.textContent === "7일"));
  await waitFor(() => {
    const p = new URLSearchParams(loc.search);
    expect(p.get("days")).toBe("7");
    expect(p.has("period")).toBe(false);
  });
});

test("days=7은 defaultRangeDays=7과 일치해 7일 프리셋이 그대로 활성 상태다", async () => {
  const fetchMock = stubFetch();
  const { container } = mount("/cost?days=7", cfg());
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(activePreset(container)).toBe("7일");
});

test("달력으로 고른 구간은 UTC 경계로 URL에 쓰이고, 알약은 선택한 종료일을 그대로 보여준다", async () => {
  const fetchMock = stubFetch();
  const { container } = mount("/cost", cfg());
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  fireEvent.click(container.querySelector('[aria-label="기간 직접 선택"]'));
  fireEvent.change(screen.getByLabelText("시작일"), { target: { value: "2026-09-01" } });
  fireEvent.change(screen.getByLabelText("종료일"), { target: { value: "2026-09-04" } });
  fireEvent.click([...container.querySelectorAll("button")].find((b) => b.textContent === "적용"));
  await waitFor(() => {
    const p = new URLSearchParams(loc.search);
    expect(p.get("from")).toBe("2026-09-01T00:00:00.000Z");
    expect(p.get("to")).toBe("2026-09-05T00:00:00.000Z");
    expect(p.has("days")).toBe(false);
    expect(p.has("period")).toBe(false);
  });
  // TZ=Asia/Seoul에서 로컬 포맷터였다면 "9. 5."가 나온다 — UTC 포맷터와 -1ms가 맞을 때만 "9. 4."다.
  const pill = [...container.querySelectorAll("button")].find((b) => b.title === "기간 선택 해제");
  expect(pill.textContent).toBe("9. 1. – 9. 4.");
});

test("배타적 종료 경계는 재오픈 시 선택한 날짜 그대로 되돌아온다", async () => {
  const fetchMock = stubFetch();
  const { container } = mount("/cost", cfg());
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  fireEvent.click(container.querySelector('[aria-label="기간 직접 선택"]'));
  fireEvent.change(screen.getByLabelText("시작일"), { target: { value: "2026-09-01" } });
  fireEvent.change(screen.getByLabelText("종료일"), { target: { value: "2026-09-04" } });
  fireEvent.click([...container.querySelectorAll("button")].find((b) => b.textContent === "적용"));
  await waitFor(() => expect(new URLSearchParams(loc.search).get("from")).toBe("2026-09-01T00:00:00.000Z"));
  fireEvent.click(container.querySelector('[aria-label="기간 직접 선택"]'));
  // 내부 custom.to는 다음 UTC 날 자정(배타)이다 — 입력창은 -1해서 사용자가 고른 날을 그대로 보여줘야 한다.
  expect(screen.getByLabelText("종료일").value).toBe("2026-09-04");
});

test("상한과 정확히 같은 길이는 통과하고, 하루 더 긴 길이는 서버와 같은 기준으로 거부된다", async () => {
  const fetchMock = stubFetch();
  const { container } = mount("/cost", cfg({ rangeCapDays: 7 }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  fireEvent.click(container.querySelector('[aria-label="기간 직접 선택"]'));
  fireEvent.change(screen.getByLabelText("시작일"), { target: { value: "2026-09-01" } });
  fireEvent.change(screen.getByLabelText("종료일"), { target: { value: "2026-09-08" } });
  const searchBefore = loc.search;
  fireEvent.click([...container.querySelectorAll("button")].find((b) => b.textContent === "적용"));
  await screen.findByText("최대 7일까지 선택할 수 있습니다");
  expect(document.querySelectorAll('input[type="date"]').length).toBe(2);
  expect(loc.search).toBe(searchBefore);
  // 거부 후에도 팝오버가 열려 있으니 같은 테스트에서 입력을 바꿔 다시 적용할 수 있다.
  fireEvent.change(screen.getByLabelText("종료일"), { target: { value: "2026-09-07" } });
  fireEvent.click([...container.querySelectorAll("button")].find((b) => b.textContent === "적용"));
  await waitFor(() => {
    const p = new URLSearchParams(loc.search);
    expect(p.get("from")).toBe("2026-09-01T00:00:00.000Z");
    expect(p.get("to")).toBe("2026-09-08T00:00:00.000Z");
  });
});

test("시작일이 종료일보다 늦으면 거부되고 URL은 바뀌지 않는다", async () => {
  const fetchMock = stubFetch();
  const { container } = mount("/cost", cfg());
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  fireEvent.click(container.querySelector('[aria-label="기간 직접 선택"]'));
  fireEvent.change(screen.getByLabelText("시작일"), { target: { value: "2026-09-05" } });
  fireEvent.change(screen.getByLabelText("종료일"), { target: { value: "2026-09-01" } });
  const searchBefore = loc.search;
  fireEvent.click([...container.querySelectorAll("button")].find((b) => b.textContent === "적용"));
  await screen.findByText("시작일이 종료일보다 늦습니다");
  expect(loc.search).toBe(searchBefore);
});

// 호스트 추가(2026-09-10, PR #31 리뷰 L4 MINOR-1의 URL 쪽). 두 가지를 핀한다. 하나는 게이트가
// 켜졌을 때 링크의 project가 실제로 요청에 실린다는 것 — /cost는 그 파라미터를 무시하는
// 라우트인데도 실려 나가고, 그것이 MAJOR-3에서 고른 "적용 범위를 표시만 한다" 쪽의 귀결이다.
// 다른 하나는 실측으로 드러난, 이 변경과 무관한 기존 동작이다(호스트가 변경 전/후 같은 프로브로
// 확인): RangeContext의 URL 라이터는 group/model(마스킹 OFF면 user)만 보존하고 project는 애초에
// 옮기지 않는다. 그 라이터가 바깥 provider라 마운트 시 나중에 돌기 때문에, 게이트가 켜져 있어도
// 공유된 ?project= 링크는 주소창에서 키를 잃는다 — 필터 자체는 계속 걸린 상태다. URL 왕복
// 충실성 문제이고 필터 정확성 문제가 아니라 이 PR에서는 고치지 않았다(고치려면 RangeContext에도
// 같은 스키마 게이트를 넣어야 하고, 게이트 없이 보존만 추가하면 마스킹 ON의 user가 되살아났던
// 것과 같은 함정을 project에 다시 만든다). 여기서 단정해 두면 다음 사람이 놀라지 않는다.
test("projectColumns: true면 링크의 project가 모든 요청에 실린다 (URL 키는 기존 동작대로 사라진다)", async () => {
  const fetchMock = stubFetch();
  mount("/cost?days=7&project=repo-a", cfg({ schema: { projectColumns: true } }));
  await waitFor(() => expect(dataCalls(fetchMock, "/api/cost").length).toBeGreaterThan(0));
  expect(dataCalls(fetchMock, "/api/cost").every((u) => /project=repo-a/.test(u))).toBe(true);
  // 기존 동작(이 변경 전에도 같았다): RangeContext의 라이터가 project를 보존하지 않아 키가 빠진다.
  expect(new URLSearchParams(loc.search).has("project")).toBe(false);
  expect(new URLSearchParams(loc.search).get("days")).toBe("7");
});

test("projectColumns가 true가 아니면 링크의 project는 어떤 요청에도 실리지 않는다", async () => {
  for (const schema of [{ projectColumns: false }, { projectColumns: null }, {}]) {
    const fetchMock = stubFetch();
    mount("/cost?days=7&group=bedrock&project=repo-a", cfg({ schema }));
    await waitFor(() => expect(dataCalls(fetchMock, "/api/cost").length).toBeGreaterThan(0));
    expect(dataCalls(fetchMock, "/api/cost").every((u) => !/project=/.test(u))).toBe(true);
    expect(new URLSearchParams(loc.search).has("project")).toBe(false);
    // 대조 — 게이트가 URL을 통째로 비우는 게 아니다. 같은 링크의 다른 필터는 그대로 살아 있다.
    expect(new URLSearchParams(loc.search).get("group")).toBe("bedrock");
    expect(new URLSearchParams(loc.search).get("days")).toBe("7");
    cleanup();
    vi.unstubAllGlobals();
  }
});
