import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../App.jsx";
import { ConfigProvider } from "../ConfigContext.jsx";
import { setPiiMask } from "../fmt.js";

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
// 이지만 양수 보고값은 비용에 포함한다. unknown 행으로 세 번째 세그먼트도 확인한다.
const ROWS = [
  { user: "a@x.com", group: "bedrock", model: "claude-sonnet-5", cost: 12.34, reported_cost: 10, tokens: 1000, unpriced: false },
  { user: "a@x.com", group: "enterprise", model: "claude-sonnet-5", cost: 7.21, reported_cost: 6, tokens: 500, unpriced: false },
  { user: "b@x.com", group: "bedrock", model: "titan-text-lite", cost: null, reported_cost: 7, tokens: 700, unpriced: true },
  { user: "b@x.com", group: "unknown", model: "titan-text-lite", cost: null, reported_cost: 3, tokens: 300, unpriced: true },
];

function mount(groupMode, responses = {}, pricing = { cacheWriteTtl: "5m", overriddenModels: [] }) {
  setPiiMask(false);
  // /api/config는 객체, /api/health/data는 status를 가진 객체, 나머지는 배열 — shape가 다르므로
  // 하나로 뭉뚱그리면 렌더 중에 터진다(App.test.jsx와 같은 규칙).
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const u = String(url);
      const path = u.split("?")[0];
      const body = Object.hasOwn(responses, path) ? responses[path] : u.startsWith("/api/config")
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
    <ConfigProvider config={{ piiMask: false, groupMode, schema: {}, pricing }}>
      <MemoryRouter initialEntries={["/cost"]}>
        <App />
      </MemoryRouter>
    </ConfigProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setPiiMask(true);
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
  expect(titles).toContain("bedrock $10 — claude-sonnet-5 $10");
  expect(titles).toContain("enterprise $6 — claude-sonnet-5 $6");
  // 토큰 셀 — 미산정 모델도 토큰 줄에는 있다
  expect(titles).toContain("bedrock 700토큰 — titan-text-lite 700토큰");
  expect(titles).toContain("미분류 300토큰 — titan-text-lite 300토큰");

  // 보고 지출 max = 10 → bedrock 100%, enterprise 60%.
  const bLine = lines.find((d) => d.getAttribute("aria-label") === "bedrock $10 — claude-sonnet-5 $10");
  expect([...bLine.querySelectorAll("span")].some((x) => /width:\s*100%/.test(x.getAttribute("style") || ""))).toBe(true);
  const eLine = lines.find((d) => d.getAttribute("aria-label") === "enterprise $6 — claude-sonnet-5 $6");
  expect([...eLine.querySelectorAll("span")].some((x) => /width:\s*60%/.test(x.getAttribute("style") || ""))).toBe(true);
  // 모델 세그먼트 색 = MODEL_COLOR(sonnet-5) — 그룹 색이 아니라 모델 색.
  // jsdom은 hex를 rgb()로 정규화한다 — #6C7CE0 = rgb(108, 124, 224)
  expect([...bLine.querySelectorAll("span")].some((x) => /rgb\(108,\s*124,\s*224\)|#6C7CE0/i.test(x.getAttribute("style") || ""))).toBe(true);

  // 단가표 밖 모델도 유효한 보고값은 지출 막대에 포함된다.
  expect(titles).toContain("bedrock $7 — titan-text-lite $7");
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
    expect(text).toContain("$16 — bedrock $10 · enterprise $6");
    expect(text).toContain("$10 — bedrock $7 · 미분류 $3");
    expect(text).toContain("bedrock 1,000토큰 · enterprise 500토큰");
    expect(text).toContain("bedrock 700토큰 · 미분류 300토큰");
  } finally {
    clickSpy.mockRestore();
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  }
});


const card = (title) => screen.getByText(title, { exact: true }).closest(".rounded-lg");
const cells = (title) => [...card(title).querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));

async function exportTable(title) {
  let captured;
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => { captured = blob; return "blob:test"; };
  URL.revokeObjectURL = () => {};
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  try {
    fireEvent.click(within(card(title)).getByRole("button", { name: "CSV" }));
    return await captured.text();
  } finally {
    click.mockRestore();
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
  }
}

const summary = { group: "bedrock", computed_cost: 7817.28, reported_cost: 6647.79, input_tokens: 1000, output_tokens: 100, cache_read_tokens: 20, cache_write_tokens: 30, unpriced_tokens: 0, sessions: 2 };

test("reported total 6647.79 drives forecasts and per-user spend; 7817.28 stays diagnostic with TTL", async () => {
  mount("single", {
    "/api/cost/summary": [summary],
    "/api/overview/active-users": { users: 2, bedrock_users: 2 },
    "/api/cost/tiers": { bedrock: { cacheRead: 1, cacheWrite: 2, output: 3, uncachedInput: 4 } },
  });
  await waitFor(() => expect(card("총 비용").textContent).toContain("$6,647.79"));
  expect(card("토큰 단가 계산 비용").textContent).toContain("$7,817.28");
  expect(card("개발자당 비용").textContent).toContain("$3,323.9");
  expect(card("사용자당 비용 — bedrock").textContent).toContain("$3,323.9");
  expect(card("30일 예상 비용").textContent).toContain("$99,716.85");
  expect(card("토큰 유형별 계산 비용 — bedrock").textContent).toContain("TTL 가정: 5분");
});

test("missing summary spend renders unavailable totals and forecasts without computed fallback", async () => {
  mount("single", {
    "/api/cost/summary": [{ ...summary, reported_cost: 0 }],
    "/api/overview/active-users": { users: 2, bedrock_users: 2 },
  });
  await waitFor(() => expect(card("총 비용").textContent).toContain("확인 필요"));
  for (const title of ["30일 예상 비용", "개발자당 비용", "사용자당 비용 — bedrock"]) {
    expect(card(title).textContent).toContain("확인 필요");
  }
  expect(card("토큰 단가 계산 비용").textContent).toContain("$7,817.28");
});

test("model sorting, shares, period changes and CSV use reported spend including unpriced models", async () => {
  mount("single", {
    "/api/cost/by-model": [
      { model: "computed-leader", group: "bedrock", cost: 900, reported_cost: 10, tokens: 100 },
      { model: "reported-leader", group: "bedrock", cost: null, unpriced: true, reported_cost: 30, tokens: 100 },
    ],
    "/api/cost/by-model-compare": [
      { model: "computed-leader", cost: 900, reported_cost: 10, prev_cost: 100, prev_reported_cost: 20 },
      { model: "reported-leader", cost: null, reported_cost: 30, prev_cost: null, prev_reported_cost: 10 },
    ],
  });
  await waitFor(() => expect(cells("모델별 비용과 토큰")).toHaveLength(2));
  await waitFor(() => expect(cells("모델별 비용과 토큰")[0]).toEqual(["reported-leader", "$30", "단가 미등록", "75.0%", "+200.0%", "0", "0"]));
  expect(cells("모델별 비용과 토큰")[1]).toEqual(["computed-leader", "$10", "$900", "25.0%", "-50.0%", "0", "0"]);
  const csv = await exportTable("모델별 비용과 토큰");
  expect(csv).toContain("reported-leader,30,,75.0%,+200.0%");
  expect(csv).toContain("computed-leader,10,900,25.0%,-50.0%");
  fireEvent.click(within(card("모델별 비용과 토큰")).getByText("비용", { exact: true }));
  expect(cells("모델별 비용과 토큰")[0][0]).toBe("computed-leader");
  const sortedCsv = await exportTable("모델별 비용과 토큰");
  expect(sortedCsv.indexOf("computed-leader")).toBeLessThan(sortedCsv.indexOf("reported-leader"));
});

test("partial model and user folds render unavailable and export blank spend cells", async () => {
  const rows = [
    { user: "partial", model: "partial-model", group: "bedrock", cost: 99, reported_cost: 10, tokens: 100 },
    { user: "partial", model: "partial-model", group: "enterprise", cost: 55, reported_cost: 0, tokens: 100 },
    { user: "known", model: "known-model", group: "bedrock", cost: 77, reported_cost: 5, tokens: 100 },
  ];
  mount("ab", { "/api/cost/by-model": rows, "/api/cost/by-user-model": rows });
  await waitFor(() => expect(cells("모델별 비용과 토큰")).toHaveLength(2));
  expect(cells("모델별 비용과 토큰")[1].slice(0, 5)).toEqual(["partial-model", "확인 필요", "$154", "확인 필요", "확인 필요"]);
  expect(cells("모델별 비용과 토큰")[0][3]).toBe("확인 필요");
  expect((await exportTable("모델별 비용과 토큰"))).toContain("partial-model,,154,,,");
  expect(cells("사용자 · 모델별 비용")[1][1]).toContain("확인 필요");
  expect((await exportTable("사용자 · 모델별 비용"))).toContain("partial,,154,");
});

test("effort, agents and efficiency use reported spend with computed secondary diagnostics", async () => {
  mount("single", {
    "/api/cost/effort-mix": [
      { group: "bedrock", effort: "high", cost: 100, reported_cost: 7, tokens: 10 },
      { group: "bedrock", effort: "medium", cost: 0, reported_cost: 9, tokens: 10, unpriced_tokens: 10 },
      { group: "bedrock", effort: "unknown", cost: 3, reported_cost: 0, tokens: 10 },
    ],
    "/api/cost/by-agent": [
      { group: "bedrock", agent: "computed-leader", cost: 100, reported_cost: 2, tokens: 10 },
      { group: "bedrock", agent: "main", cost: 1, reported_cost: 20, tokens: 10 },
    ],
    "/api/users/cost-efficiency": [
      { user: "computed-best", group: "bedrock", cost: 1, reported_cost: 20, reported_unpriced: false, loc: 10, commits: 2, cost_per_loc: 2, cost_per_commit: 10 },
      { user: "reported-best", group: "bedrock", cost: 99, reported_cost: 10, reported_unpriced: false, loc: 10, commits: 2, unpriced: true, cost_per_loc: 1, cost_per_commit: 5 },
      { user: "missing", group: "bedrock", cost: 10, reported_cost: 0, reported_unpriced: true, loc: 10, commits: 2, cost_per_loc: null, cost_per_commit: null },
    ],
  });
  await waitFor(() => expect(cells("에이전트별 비용")).toHaveLength(2));
  expect(cells("에이전트별 비용")[0]).toEqual(["메인 세션", "bedrock", "$20", "$1", "10"]);
  expect(card("Effort 수준별 비용 — bedrock").textContent).toContain("high: $7 (계산값 $100)");
  expect(card("Effort 수준별 비용 — bedrock").textContent).toContain("medium: $9");
  expect(card("Effort 수준별 비용 — bedrock").textContent).toContain("미지정: 확인 필요");
  await waitFor(() => expect(cells("비용 효율 ($/LOC · $/커밋)")).toHaveLength(3));
  expect(cells("비용 효율 ($/LOC · $/커밋)")[0].slice(0, 7)).toEqual(["reported-best", "bedrock", "$10", "10", "2", "$1.0000", "$5"]);
  expect((await exportTable("에이전트별 비용"))).toContain("메인 세션,bedrock,20,1,10");
  const efficiencyCsv = await exportTable("비용 효율 ($/LOC · $/커밋)");
  expect(efficiencyCsv).toContain("reported-best,bedrock,10,10,2,1,5");
  expect(efficiencyCsv).toContain("missing,bedrock,,10,2,,");
});
