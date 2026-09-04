import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../App.jsx";
import { ConfigProvider } from "../ConfigContext.jsx";

// Cost.test.js는 순수 함수(mergeUserModelRows/groupShareText)만 본다 — 그래서 "single 모드면
// 그룹 비중 컬럼을 아예 렌더하지 않는다"와 "CSV가 화면과 같은 문자열을 내보낸다"는 그 파일로는
// 검증되지 않는다(실측: groupMode 가드를 지워도 Cost.test.js는 6/6 통과). 이 파일이 그 두 층을 잡는다.
//
// 두 가지 함정:
// 1) App은 /api/config를 스스로 fetch하지 않는다 — main.jsx가 받아 ConfigProvider의 prop으로
//    넘긴다. fetch 목만 바꾸면 groupMode는 영원히 기본값("ab")이라 single 케이스가 무의미해진다.
// 2) jsdom엔 ResizeObserver가 없고 recharts ResponsiveContainer가 mount effect에서 바로 쓴다
//    (App.test.jsx와 같은 이유) — 스텁을 지우면 렌더가 ReferenceError로 죽는다.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// a@x.com은 양 그룹을 오간 straddler(비용 기준), b@x.com은 단가표에 없는 모델이라 cost가 null
// (토큰 기준 폴백). unknown 행까지 넣어 세 번째 세그먼트 색까지 확인한다.
const ROWS = [
  { user: "a@x.com", group: "bedrock", model: "claude-sonnet-5", cost: 12.34, reported_cost: 10, tokens: 1000, unpriced: false },
  { user: "a@x.com", group: "enterprise", model: "claude-sonnet-5", cost: 7.21, reported_cost: 6, tokens: 500, unpriced: false },
  { user: "b@x.com", group: "bedrock", model: "titan-text-lite", cost: null, reported_cost: 0, tokens: 700, unpriced: true },
  { user: "b@x.com", group: "unknown", model: "titan-text-lite", cost: null, reported_cost: 0, tokens: 300, unpriced: true },
];

function mount(groupMode) {
  // /api/config는 객체, /api/health/data는 status를 가진 객체, 나머지는 배열 — shape가 다르므로
  // 하나로 뭉뚱그리면 렌더 중에 터진다(App.test.jsx와 같은 규칙).
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const u = String(url);
      const body = u.startsWith("/api/config")
        ? { piiMask: false, groupMode, schema: {} }
        : u.startsWith("/api/health/data")
          ? { status: "ok", latest: null, ageMinutes: 0, staleAfterMinutes: 360 }
          : u.startsWith("/api/cost/by-user-model")
            ? ROWS
            : [];
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    })
  );
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  return render(
    <ConfigProvider config={{ piiMask: false, groupMode, schema: {} }}>
      <MemoryRouter initialEntries={["/cost"]}>
        <App />
      </MemoryRouter>
    </ConfigProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const headers = (container) => [...container.querySelectorAll("th")].map((th) => th.textContent);
// 막대는 title을 가진 유일한 div다 — 텍스트가 없어 role/text 조회로는 잡히지 않는다.
const shareBars = (container) => [...container.querySelectorAll("div[title]")].filter((d) => d.getAttribute("title").includes("bedrock"));

test("그룹 비중 막대: 계산 비용 비율과 토큰 폴백이 세그먼트 폭·색으로 나온다", async () => {
  const { container } = mount("ab");
  await waitFor(() => expect(headers(container).some((h) => h.includes("그룹 비중"))).toBe(true));

  const bars = shareBars(container);
  const titles = bars.map((d) => d.getAttribute("title"));
  expect(titles).toContain("bedrock $12.34 (63%) · enterprise $7.21 (37%)");
  expect(titles).toContain("bedrock 700토큰 (70%) · unknown 300토큰 (30%)");

  // 폭은 반올림한 툴팁 %가 아니라 실수 비율이다(12.34/19.55) — 툴팁의 63%와 혼동하면 안 된다.
  const straddler = bars.find((d) => d.getAttribute("title").startsWith("bedrock $12.34"));
  const segs = [...straddler.querySelectorAll("span")].map((s) => s.getAttribute("style"));
  expect(segs.length).toBe(2);
  expect(segs[0]).toMatch(/width:\s*63\.12/);
  expect(segs[0]).toContain("background: var(--series-bedrock)");
  expect(segs[1]).toMatch(/width:\s*36\.87/);
  expect(segs[1]).toContain("background: var(--series-enterprise)");

  const fallback = bars.find((d) => d.getAttribute("title").includes("unknown"));
  const fbSegs = [...fallback.querySelectorAll("span")].map((s) => s.getAttribute("style"));
  expect(fbSegs[0]).toMatch(/width:\s*70%/);
  expect(fbSegs[1]).toMatch(/width:\s*30%/);
  expect(fbSegs[1]).toContain("background: var(--series-unknown)");
});

test("single 모드에선 그룹 비중 컬럼이 렌더되지 않는다", async () => {
  const { container } = mount("single");
  await waitFor(() => expect(headers(container).some((h) => h.includes("사용자"))).toBe(true));
  expect(headers(container).some((h) => h.includes("그룹 비중"))).toBe(false);
  // 컬럼만 숨기는 게 아니라 막대 자체가 없어야 한다 — 컬럼을 지우고 셀만 남기는 실수를 잡는다.
  expect(shareBars(container).length).toBe(0);
});

test("CSV 내보내기가 화면의 그룹 비중 문자열을 그대로 담는다", async () => {
  const { container } = mount("ab");
  await waitFor(() => expect(headers(container).some((h) => h.includes("그룹 비중"))).toBe(true));

  // toCsv는 render를 절대 호출하지 않으므로(csv.js) toText가 빠지면 이 열이 빈 칸으로 나간다 —
  // 그걸 잡으려면 실제 다운로드 경로를 타야 한다. jsdom엔 createObjectURL이 없어 그냥 대입한다.
  let captured = null;
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => {
    captured = blob;
    return "blob:test";
  };
  URL.revokeObjectURL = () => {};
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  try {
    const btn = [...container.querySelectorAll("button")].find(
      (b) => b.textContent.includes("CSV") && b.closest("div")?.textContent?.includes("unknown 그룹 포함")
    );
    expect(btn).toBeTruthy();
    btn.click();
    expect(captured).not.toBeNull();
    const text = await captured.text();
    expect(text).toContain("그룹 비중");
    expect(text).toContain("bedrock $12.34 (63%) · enterprise $7.21 (37%)");
    expect(text).toContain("bedrock 700토큰 (70%) · unknown 300토큰 (30%)");
  } finally {
    clickSpy.mockRestore();
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  }
});
