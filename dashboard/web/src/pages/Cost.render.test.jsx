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
  { user: "b@x.com", group: "bedrock", model: "titan-text-lite", cost: null, reported_cost: 7, tokens: 700, unpriced: true },
  { user: "b@x.com", group: "unknown", model: "titan-text-lite", cost: null, reported_cost: 3, tokens: 300, unpriced: true },
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
// 스택 바 줄은 aria-label을 가진 유일한 요소다(BarTip) — 텍스트가 없어 role/text 조회로는 잡히지 않는다.
// 상세 툴팁은 hover 시 fixed로 뜨는 커스텀(BarTip)이고, 같은 문자열이 aria-label로 상시 노출된다.
const mirrorBars = (container) => [...container.querySelectorAll("[aria-label]")].filter((d) => (d.getAttribute("aria-label") || "").includes("bedrock"));

test("그룹별 모델 스택 바 두 줄: 줄=그룹, 색 분할=모델, 길이는 컬럼 최대 그룹 줄 대비", async () => {
  const { container } = mount("ab");
  await waitFor(() => expect(mirrorBars(container).length).toBeGreaterThan(0));

  const lines = [...container.querySelectorAll("[aria-label]")].filter((d) => /^(bedrock|enterprise|미분류) /.test(d.getAttribute("aria-label") || ""));
  const titles = lines.map((d) => d.getAttribute("aria-label"));
  // 지출 셀 — 그룹 합계 + 모델 내역이 hover에 담긴다
  expect(titles).toContain("bedrock $12.34 — claude-sonnet-5 $12.34");
  expect(titles).toContain("enterprise $7.21 — claude-sonnet-5 $7.21");
  // 토큰 셀 — 미산정 모델도 토큰 줄에는 있다
  expect(titles).toContain("bedrock 700토큰 — titan-text-lite 700토큰");
  expect(titles).toContain("미분류 300토큰 — titan-text-lite 300토큰");

  // 지출 축 max = 12.34 → bedrock 줄 100%, enterprise 줄 58.43%. 폭은 줄의 안쪽 스택 컨테이너에.
  const bLine = lines.find((d) => d.getAttribute("aria-label") === "bedrock $12.34 — claude-sonnet-5 $12.34");
  expect([...bLine.querySelectorAll("span")].some((x) => /width:\s*100%/.test(x.getAttribute("style") || ""))).toBe(true);
  const eLine = lines.find((d) => d.getAttribute("aria-label") === "enterprise $7.21 — claude-sonnet-5 $7.21");
  expect([...eLine.querySelectorAll("span")].some((x) => /width:\s*58\.4/.test(x.getAttribute("style") || ""))).toBe(true);
  // 모델 세그먼트 색 = MODEL_COLOR(sonnet-5) — 그룹 색이 아니라 모델 색.
  // jsdom은 hex를 rgb()로 정규화한다 — #6C7CE0 = rgb(108, 124, 224)
  expect([...bLine.querySelectorAll("span")].some((x) => /rgb\(108,\s*124,\s*224\)|#6C7CE0/i.test(x.getAttribute("style") || ""))).toBe(true);

  // b@x.com 지출 셀: 전 모델이 단가표 밖(계산 비용 0 처리)이라 지출 줄 자체가 없다 — $0 숫자만.
  expect(titles.some((t) => t.startsWith("bedrock $") && t.includes("titan"))).toBe(false);
  // 토큰 축 max = 1,000 → b@x의 bedrock 줄 70%, unknown 줄 30%. 미등록 모델은 잉크 회색.
  const tLine = lines.find((d) => d.getAttribute("aria-label") === "bedrock 700토큰 — titan-text-lite 700토큰");
  expect([...tLine.querySelectorAll("span")].some((x) => /width:\s*70%/.test(x.getAttribute("style") || ""))).toBe(true);
  expect([...tLine.querySelectorAll("span")].some((x) => (x.getAttribute("style") || "").includes("var(--ink-300)"))).toBe(true);
});

test("single 모드에선 그룹 줄 스택 바가 렌더되지 않는다", async () => {
  const { container } = mount("single");
  await waitFor(() => expect(headers(container).some((h) => h.includes("사용자"))).toBe(true));
  // 그룹이 하나면 줄 구분이 정보량 0 — 숫자만 남는다.
  expect(mirrorBars(container).length).toBe(0);
});

test("CSV 내보내기가 화면의 그룹 분해 문자열을 그대로 담는다", async () => {
  const { container } = mount("ab");
  await waitFor(() => expect(mirrorBars(container).length).toBeGreaterThan(0));

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
      (b) => b.textContent.includes("CSV") && b.closest("div")?.textContent?.includes("미분류 포함")
    );
    expect(btn).toBeTruthy();
    btn.click();
    expect(captured).not.toBeNull();
    const text = await captured.text();
    expect(text).toContain("$19.55 — bedrock $12.34 · enterprise $7.21");
    expect(text).toContain("$0");
    expect(text).toContain("bedrock 1,000토큰 · enterprise 500토큰");
    expect(text).toContain("bedrock 700토큰 · 미분류 300토큰");
  } finally {
    clickSpy.mockRestore();
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  }
});
