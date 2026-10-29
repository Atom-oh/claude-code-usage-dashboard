import { claudeDetail } from "../test/claudeDetail.js";
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
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

function mount(groupMode, responses = {}, pricing = { cacheWriteTtl: "5m", overriddenModels: [] }, path = "/cost", requestOverride) {
  setPiiMask(false);
  // /api/config는 객체, /api/health/data는 status를 가진 객체, 나머지는 배열 — shape가 다르므로
  // 하나로 뭉뚱그리면 렌더 중에 터진다(App.test.jsx와 같은 규칙).
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const u = String(url);
      const path = u.split("?")[0];
      const override = requestOverride?.(path);
      if (override !== undefined) return override;
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
      <MemoryRouter initialEntries={[claudeDetail(path)]}>
        <App />
      </MemoryRouter>
    </ConfigProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  vi.unstubAllGlobals();
  setPiiMask(true);
});

const headers = (container) => [...container.querySelectorAll("th")].map((th) => th.textContent);
// 스택 바 줄은 aria-label을 가진 유일한 요소다(BarTip) — 텍스트가 없어 role/text 조회로는 잡히지 않는다.
// 상세 툴팁은 hover 시 fixed로 뜨는 커스텀(BarTip)이고, 같은 문자열이 aria-label로 상시 노출된다.
const mirrorBars = (container) => [...container.querySelectorAll("[aria-label]")].filter((d) => (d.getAttribute("aria-label") || "").includes("bedrock"));

test.each([
  ["/api/cost/effort-mix", "Effort 수준별 보고 비용", "loading"],
  ["/api/cost/effort-mix", "Effort 수준별 보고 비용", "error"],
  ["/api/cost/by-model", "모델별 비용 비중", "loading"],
  ["/api/cost/by-model", "모델별 비용 비중", "error"],
  ["/api/cost/summary", "토큰 유형별 사용량", "loading"],
  ["/api/cost/summary", "토큰 유형별 사용량", "error"],
])("Claude detail keeps card headings for %s (%s) during %s", async (endpoint, heading, state) => {
  mount("ab", {}, undefined, "/cost", (path) => path === endpoint
    ? state === "loading" ? new Promise(() => {})
      : Promise.resolve({ ok: false, status: 500, json: async () => ({}) }) : undefined);
  for (const group of ["bedrock", "enterprise"]) {
    const title = await screen.findByText(`${heading} — ${group}`, { exact: true });
    await waitFor(() => expect(title.closest(".shadow-card").textContent).toContain(
      state === "loading" ? "불러오는 중..." : "데이터를 불러오지 못했습니다."));
    expect(title.closest(".shadow-card").querySelector(".shadow-card")).toBeNull();
  }
});

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
  // The Sonnet family hue follows the model across backend channels.
  // jsdom normalizes #355FC7 to rgb(53, 95, 199).
  expect([...bLine.querySelectorAll("span")].some((x) => /rgb\(53,\s*95,\s*199\)|#355FC7/i.test(x.getAttribute("style") || ""))).toBe(true);

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

test("default spend view hides computed amounts and exports only reported cost columns", async () => {
  mount("single", {
    "/api/cost/summary": [summary],
    "/api/cost/by-model": [{ group: "bedrock", model: "model", cost: 7817.28, reported_cost: 6647.79, tokens: 100 }],
    "/api/cost/effort-mix": [{ group: "bedrock", effort: "high", cost: 7817.28, reported_cost: 6647.79, tokens: 100 }],
    "/api/cost/tiers": { bedrock: { cacheRead: 100, cacheWrite: 400, output: 6500, uncachedInput: 817.28 } },
  });
  await waitFor(() => expect(card("총 비용").textContent).toContain("$6,647.79"));
  expect(screen.queryByText("토큰 단가 계산 비용", { exact: true })).toBeNull();
  expect(screen.queryByText("토큰 유형별 계산 비용 — bedrock", { exact: true })).toBeNull();
  expect(screen.queryByRole("region", { name: "계산 비용 교차검증" })).toBeNull();
  expect(screen.queryByText("$7,817.28", { exact: true })).toBeNull();
  expect(within(card("모델별 비용과 토큰")).queryByText("토큰 단가 계산값")).toBeNull();
  expect((await exportTable("모델별 비용과 토큰"))).not.toContain("7817.28");
  expect((await exportTable("모델별 비용과 토큰"))).not.toContain("토큰 단가 계산값");
});

test("computed comparison is opt-in and preserves the original values and TTL assumption", async () => {
  mount("single", {
    "/api/cost/summary": [summary],
    "/api/cost/tiers": { bedrock: { cacheRead: 100, cacheWrite: 400, output: 6500, uncachedInput: 817.28 } },
  });
  await waitFor(() => expect(card("총 비용").textContent).toContain("$6,647.79"));
  fireEvent.click(screen.getByRole("checkbox", { name: "계산 비용 비교" }));
  const comparison = screen.getByRole("region", { name: "계산 비용 교차검증" });
  expect(comparison.textContent).toContain("$7,817.28");
  expect(comparison.textContent).toContain("토큰 유형별 계산 비용 — bedrock");
  expect(comparison.textContent).toContain("TTL 가정: 5분");
  expect(card("총 비용").textContent).toContain("$6,647.79");
  fireEvent.click(screen.getByRole("checkbox", { name: "계산 비용 비교" }));
  expect(screen.queryByRole("region", { name: "계산 비용 교차검증" })).toBeNull();
});

test("computed comparison names the AWS Price List source and fetch time", async () => {
  mount("single", {
    "/api/cost/summary": [summary],
    "/api/cost/tiers": { bedrock: { cacheRead: 100, cacheWrite: 400, output: 6500, uncachedInput: 817.28 } },
  }, { cacheWriteTtl: "5m", overriddenModels: [], priceList: { source: "snapshot", fetchedAt: "2026-10-28T12:00:00Z", models: ["claude-fable-5-1"] } });
  await waitFor(() => expect(card("총 비용").textContent).toContain("$6,647.79"));
  fireEvent.click(screen.getByRole("checkbox", { name: "계산 비용 비교" }));
  const comparison = screen.getByRole("region", { name: "계산 비용 교차검증" });
  expect(comparison.textContent).toContain("단가 출처: AWS Price List 빌드 스냅샷(2026-10-28 ");
});

test("computed comparison keeps an unknown price source explicit for older servers", async () => {
  mount("single", { "/api/cost/summary": [summary] });
  await waitFor(() => expect(card("총 비용").textContent).toContain("$6,647.79"));
  fireEvent.click(screen.getByRole("checkbox", { name: "계산 비용 비교" }));
  expect(screen.getByRole("region", { name: "계산 비용 교차검증" }).textContent).toContain("단가 출처: 미확인.");
});

test("Effort donut total and legend use the same cent precision as reported totals", async () => {
  mount("single", {
    "/api/cost/summary": [{ ...summary, reported_cost: 77.64 }],
    "/api/cost/effort-mix": [
      { group: "bedrock", effort: "high", cost: 90, reported_cost: 52.19, tokens: 100 },
      { group: "bedrock", effort: "medium", cost: 40, reported_cost: 25.45, tokens: 100 },
    ],
  });
  await waitFor(() => expect(card("총 비용").textContent).toContain("$77.64"));
  const effort = screen.getByText(/^Effort 수준별 (보고 )?비용 — bedrock$/).closest(".rounded-lg");
  expect(effort.querySelector(".pointer-events-none .tabular").textContent).toBe("$77.64");
  const legend = effort.querySelector("ul");
  expect(legend.textContent).toContain("$52.19");
  expect(legend.textContent).toContain("$25.45");
});

test("leaving comparison mode clears sorting by hidden computed columns", async () => {
  mount("single", {
    "/api/cost/by-model": [
      { group: "bedrock", model: "reported-first", cost: 1, reported_cost: 30, tokens: 100 },
      { group: "bedrock", model: "computed-first", cost: 900, reported_cost: 10, tokens: 100 },
    ],
  });
  await waitFor(() => expect(cells("모델별 비용과 토큰")).toHaveLength(2));
  expect(cells("모델별 비용과 토큰")[0][0]).toBe("reported-first");
  fireEvent.click(screen.getByRole("checkbox", { name: "계산 비용 비교" }));
  const computed = within(card("모델별 비용과 토큰")).getByText("토큰 단가 계산값");
  fireEvent.click(computed);
  fireEvent.click(computed);
  expect(cells("모델별 비용과 토큰")[0][0]).toBe("computed-first");
  fireEvent.click(screen.getByRole("checkbox", { name: "계산 비용 비교" }));
  expect(cells("모델별 비용과 토큰")[0][0]).toBe("reported-first");
  expect(within(card("모델별 비용과 토큰")).queryByText("토큰 단가 계산값")).toBeNull();
});

test("reported total 6647.79 drives forecasts and per-user spend; 7817.28 stays diagnostic with TTL", async () => {
  mount("single", {
    "/api/cost/summary": [summary],
    "/api/overview/active-users": { users: 2, bedrock_users: 2 },
    "/api/cost/tiers": { bedrock: { cacheRead: 1, cacheWrite: 2, output: 3, uncachedInput: 4 } },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "계산 비용 비교" }));
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
  fireEvent.click(screen.getByRole("checkbox", { name: "계산 비용 비교" }));
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
  fireEvent.click(screen.getByRole("checkbox", { name: "계산 비용 비교" }));
  await waitFor(() => expect(cells("모델별 비용과 토큰")).toHaveLength(2));
  await waitFor(() => expect(cells("모델별 비용과 토큰")[0]).toEqual(["reported-leader", "$30", "단가 미등록", "75.0%", "+200.0%", "0", "0", "확인됨"]));
  expect(cells("모델별 비용과 토큰")[1]).toEqual(["computed-leader", "$10", "$900", "25.0%", "-50.0%", "0", "0", "확인됨"]);
  const csv = await exportTable("모델별 비용과 토큰");
  expect(csv).toContain("reported-leader,30,,75.0%,+200.0%");
  expect(csv).toContain("computed-leader,10,900,25.0%,-50.0%");
  fireEvent.click(within(card("모델별 비용과 토큰")).getByText("비용", { exact: true }));
  expect(cells("모델별 비용과 토큰")[0][0]).toBe("computed-leader");
  const sortedCsv = await exportTable("모델별 비용과 토큰");
  expect(sortedCsv.indexOf("computed-leader")).toBeLessThan(sortedCsv.indexOf("reported-leader"));
});

test("partial model and user folds render known subtotals labelled 부분합 and export numeric spend", async () => {
  const rows = [
    { user: "partial", model: "partial-model", group: "bedrock", cost: 99, reported_cost: 10, tokens: 100 },
    { user: "partial", model: "partial-model", group: "enterprise", cost: 55, reported_cost: 0, tokens: 100 },
    { user: "known", model: "known-model", group: "bedrock", cost: 77, reported_cost: 5, tokens: 100 },
  ];
  mount("ab", {
    "/api/cost/by-model": rows,
    "/api/cost/by-user-model": rows,
    "/api/cost/by-model-compare": [
      { model: "partial-model", cost: 99, reported_cost: 10, prev_cost: 50, prev_reported_cost: 5 },
      { model: "known-model", cost: 77, reported_cost: 5, prev_cost: 40, prev_reported_cost: 4 },
    ],
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "계산 비용 비교" }));
  await waitFor(() => expect(cells("모델별 비용과 토큰")).toHaveLength(2));
  // Known subtotal $10 of $15 known spend; a partial subtotal is not compared with the previous period.
  await waitFor(() => expect(cells("모델별 비용과 토큰")[1][4]).toBe("+25.0%"));
  expect(cells("모델별 비용과 토큰")[0]).toEqual(["partial-model", "$10부분합", "$154", "66.7%", "확인 필요", "0", "0", "부분합"]);
  expect(cells("모델별 비용과 토큰")[1]).toEqual(["known-model", "$5", "$77", "33.3%", "+25.0%", "0", "0", "확인됨"]);
  expect(headers(card("모델별 비용과 토큰")).at(-1)).toMatch(/^비용 상태/);
  const modelCsv = await exportTable("모델별 비용과 토큰");
  expect(modelCsv).toContain("partial-model,10,154,66.7%,,0,0,부분합");
  expect(modelCsv).toContain("known-model,5,77,33.3%,+25.0%,0,0,확인됨");
  expect(cells("사용자 · 모델별 비용").map((r) => r[0])).toEqual(["partial", "known"]);
  expect(cells("사용자 · 모델별 비용")[0][1]).toContain("$10부분합");
  expect(cells("사용자 · 모델별 비용")[0].at(-1)).toBe("부분합");
  expect(cells("사용자 · 모델별 비용")[1].at(-1)).toBe("확인됨");
  const userCsv = await exportTable("사용자 · 모델별 비용");
  expect(userCsv).toContain("partial,$10 — bedrock $10 · enterprise 확인 필요,154,200 — bedrock 100토큰 · enterprise 100토큰,부분합");
  expect(userCsv).toContain("known,$5 — bedrock $5,77,100 — bedrock 100토큰,확인됨");
});

test("model donuts disclose the same known partial subtotal as the model table", async () => {
  const rows = [
    { group: "bedrock", model: "dup-model", cost: 9, reported_cost: 10, tokens: 100 },
    { group: "bedrock", model: "dup-model", cost: 4, reported_cost: 0, tokens: 100 },
  ];
  mount("single", { "/api/cost/by-model": rows });
  await waitFor(() => expect(cells("모델별 비용과 토큰")).toHaveLength(1));
  expect(cells("모델별 비용과 토큰")[0].slice(0, 2)).toEqual(["dup-model", "$10부분합"]);
  expect(card("모델별 비용 비중 — bedrock").textContent).toContain("알려진 보고 비용 부분합");
  expect(card("모델별 비용 비중 — bedrock").querySelector(".pointer-events-none .tabular").textContent).toBe("$10");
});

test("monthly Bedrock Effort preserves known amounts and lists unavailable scopes", async () => {
  mount("single", {
    "/api/cost/effort-mix": [
      { group: "bedrock", effort: "high", reported_cost: null, known_reported_cost: 5, reported_partial: true, computed_cost: 99, tokens: 100 },
      { group: "bedrock", effort: "medium", reported_cost: 2, known_reported_cost: 2, reported_partial: false, tokens: 100 },
      { group: "bedrock", effort: "xhigh", reported_cost: 0, known_reported_cost: null, tokens: 100 },
      { group: "bedrock", effort: "unknown", reported_cost: 0, known_reported_cost: null, tokens: 0 },
    ],
  }, undefined, "/cost?period=month&group=bedrock");
  await waitFor(() => expect(screen.queryByText("Effort 수준별 보고 비용 — bedrock")).not.toBeNull());
  const effort = card("Effort 수준별 보고 비용 — bedrock");
  expect(effort.textContent).toContain("알려진 보고 비용 부분합");
  expect(effort.textContent).toContain("일부 보고값 누락 또는 검증 불가");
  expect(effort.querySelector(".pointer-events-none .tabular").textContent).toBe("$7");
  expect(effort.textContent).toContain("high: $5 (부분합)");
  expect(effort.textContent).toContain("medium: $2");
  expect(effort.textContent).toContain("xhigh: 확인 필요");
  expect(effort.textContent).toContain("미지정: 확인 필요");
  expect(effort.textContent).not.toContain("$99");
});

test("all-unknown Effort and model shares stay unavailable without inventing zero", async () => {
  mount("single", {
    "/api/cost/effort-mix": [{ group: "bedrock", effort: "high", reported_cost: 0, known_reported_cost: null, tokens: 100 }],
    "/api/cost/by-model": [{ group: "bedrock", model: "unknown-model", reported_cost: null, tokens: 100 }],
  });
  await waitFor(() => expect(screen.queryByText("Effort 수준별 보고 비용 — bedrock")).not.toBeNull());
  for (const title of ["Effort 수준별 보고 비용 — bedrock", "모델별 비용 비중 — bedrock"]) {
    expect(card(title).textContent).toContain("보고 비용 확인 필요");
    expect(card(title).textContent).not.toContain("$0");
    expect(card(title).textContent).not.toContain("알려진 보고 비용 부분합");
  }
});

test("empty responses and empty selected channels keep the existing no-data state", async () => {
  const view = mount("single", {
    "/api/cost/effort-mix": [],
    "/api/cost/by-model": [],
  });
  await waitFor(() => expect(screen.queryByText("Effort 수준별 보고 비용 — bedrock")).not.toBeNull());
  for (const title of ["Effort 수준별 보고 비용 — bedrock", "모델별 비용 비중 — bedrock"]) {
    expect(card(title).textContent).toContain("선택한 기간에 데이터가 없습니다.");
    expect(card(title).textContent).not.toContain("$0");
  }
  view.unmount();
  mount("ab", {
    "/api/cost/effort-mix": [{ group: "bedrock", effort: "high", reported_cost: 2, tokens: 10 }],
    "/api/cost/by-model": [{ group: "bedrock", model: "known", reported_cost: 2, tokens: 10 }],
  }, undefined, "/cost?group=enterprise");
  await waitFor(() => expect(screen.queryByText("Effort 수준별 보고 비용 — enterprise")).not.toBeNull());
  for (const title of ["Effort 수준별 보고 비용 — enterprise", "모델별 비용 비중 — enterprise"]) {
    expect(card(title).textContent).toContain("선택한 기간에 데이터가 없습니다.");
    expect(card(title).textContent).not.toContain("$0");
  }
});

test("observed partial zero stays visible beside unknown Effort and model scopes", async () => {
  mount("single", {
    "/api/cost/effort-mix": [{ group: "bedrock", effort: "high", reported_cost: null, known_reported_cost: 0, reported_partial: true, tokens: 100 }],
    "/api/cost/by-model": [
      { group: "bedrock", model: "measured-zero", reported_cost: 0, known_reported_cost: 0, cost_counter_rows: 1, observed_usage_rows: 1, tokens: 0 },
      { group: "bedrock", model: "missing", reported_cost: null, known_reported_cost: null, observed_usage_rows: 1, tokens: 100 },
    ],
  });
  await waitFor(() => expect(screen.queryByText("Effort 수준별 보고 비용 — bedrock")).not.toBeNull());
  for (const title of ["Effort 수준별 보고 비용 — bedrock", "모델별 비용 비중 — bedrock"]) {
    expect(card(title).textContent).toContain("알려진 보고 비용 부분합");
    expect(card(title).textContent).toContain("$0");
    expect(card(title).textContent).not.toContain("보고 비용 확인 필요 —");
  }
  expect(card("모델별 비용 비중 — bedrock").textContent).toContain("missing: 확인 필요");
});

test("historical model zeros cannot make current unknown spend a partial zero", async () => {
  mount("single", {
    "/api/cost/by-model": [
      { group: "bedrock", model: "historical", reported_cost: 0, known_reported_cost: null, cost_counter_rows: 0, observed_usage_rows: "0", tokens: 0 },
      { group: "bedrock", model: "current-unknown", reported_cost: null, known_reported_cost: null, observed_usage_rows: 1, tokens: 100 },
    ],
  });
  await waitFor(() => expect(screen.queryByText("모델별 비용 비중 — bedrock")).not.toBeNull());
  const model = card("모델별 비용 비중 — bedrock");
  expect(model.textContent).toContain("보고 비용 확인 필요 —");
  expect(model.textContent).not.toContain("$0");
  expect(model.textContent).not.toContain("부분합");
  expect(model.textContent).not.toContain("historical");
});

test("historical-only model scopes remain no data in current Cost panels", async () => {
  mount("single", {
    "/api/cost/by-model": [
      { group: "bedrock", model: "historical", reported_cost: 0, known_reported_cost: null, cost_counter_rows: 0, observed_usage_rows: 0, tokens: 0 },
    ],
  });
  await waitFor(() => expect(screen.queryByText("모델별 비용 비중 — bedrock")).not.toBeNull());
  const model = card("모델별 비용 비중 — bedrock");
  expect(model.textContent).toContain("선택한 기간에 데이터가 없습니다.");
  expect(model.textContent).not.toContain("$0");
});

test("agent and efficiency amounts disclose partial coverage in the table and CSV", async () => {
  mount("single", {
    "/api/cost/by-agent": [
      { group: "bedrock", agent: "mixed", reported_cost: null, known_reported_cost: 5, reported_partial: true, computed_cost: 99, tokens: 20 },
      { group: "bedrock", agent: "unknown", reported_cost: 0, known_reported_cost: null, tokens: 10 },
    ],
    "/api/users/cost-efficiency": [
      { user: "partial@example.invalid", group: "bedrock", reported_cost: 6, reported_unpriced: true, known_reported_cost: 6, reported_partial: true, computed_cost: 99, loc: 10, commits: 2, cost_per_loc: null, cost_per_commit: null },
      { user: "complete@example.invalid", group: "bedrock", reported_cost: 2, known_reported_cost: 2, reported_partial: false, loc: 10, commits: 2, cost_per_loc: 0.2, cost_per_commit: 1 },
      { user: "unknown@example.invalid", group: "bedrock", reported_cost: 0, reported_unpriced: true, known_reported_cost: null, reported_partial: false, loc: 10, commits: 2, cost_per_loc: null, cost_per_commit: null },
    ],
  });
  await waitFor(() => expect(cells("에이전트별 비용")).toHaveLength(2));
  expect(cells("에이전트별 비용")[0]).toEqual(["mixed", "bedrock", "$5부분합", "20", "부분합"]);
  expect(cells("에이전트별 비용")[1]).toEqual(["unknown", "bedrock", "확인 필요", "10", "확인 필요"]);
  const efficiency = cells("비용 효율 ($/LOC · $/커밋)");
  expect(efficiency[0][0]).toBe("complete@example.invalid");
  expect(efficiency[1]).toEqual(["partial@example.invalid", "bedrock", "$6부분합", "10", "2", "$0.6000부분합", "$3부분합", "부분합"]);
  expect(efficiency[2].slice(5, 7)).toEqual(["확인 필요", "확인 필요"]);
  const agentCsv = await exportTable("에이전트별 비용");
  expect(agentCsv).toContain("mixed,bedrock,5,20,부분합");
  expect(agentCsv).toContain("unknown,bedrock,,10,확인 필요");
  const efficiencyCsv = await exportTable("비용 효율 ($/LOC · $/커밋)");
  expect(efficiencyCsv).toContain("partial@example.invalid,bedrock,6,10,2,0.6,3,부분합");
  expect(efficiencyCsv).not.toContain("99");
  expect(agentCsv).not.toContain("99");
});

test("model shares use the known total when one model has no usable report", async () => {
  mount("single", {
    "/api/cost/by-model": [
      { group: "bedrock", model: "known-model", cost: 40, reported_cost: 30, tokens: 100 },
      { group: "bedrock", model: "other-model", cost: 12, reported_cost: 10, tokens: 100 },
      { group: "bedrock", model: "unlisted-model", cost: null, reported_cost: null, unpriced: true, tokens: 50 },
    ],
  });
  await waitFor(() => expect(cells("모델별 비용과 토큰")).toHaveLength(3));
  expect(cells("모델별 비용과 토큰").map((r) => [r[0], r[1], r[2], r.at(-1)])).toEqual([
    ["known-model", "$30", "75.0%", "확인됨"],
    ["other-model", "$10", "25.0%", "확인됨"],
    ["unlisted-model", "확인 필요", "확인 필요", "확인 필요"],
  ]);
  expect(await exportTable("모델별 비용과 토큰")).toContain("unlisted-model,,,,0,0,확인 필요");
});

test("an unlisted model without a usable report keeps the user's known spend as a disclosed partial", async () => {
  const rows = [
    { user: "mixed", model: "claude-opus-5", group: "bedrock", cost: 2400, reported_cost: 2100, tokens: 1000 },
    { user: "mixed", model: "unlisted-model", group: "bedrock", cost: null, reported_cost: null, unpriced: true, tokens: 50 },
    { user: "missing", model: "unlisted-model", group: "bedrock", cost: null, reported_cost: null, unpriced: true, tokens: 40 },
    { user: "known", model: "claude-opus-5", group: "enterprise", cost: 6, reported_cost: 5, tokens: 10 },
  ];
  const { container } = mount("ab", { "/api/cost/by-user-model": rows });
  await waitFor(() => expect(cells("사용자 · 모델별 비용")).toHaveLength(3));
  const table = cells("사용자 · 모델별 비용");
  expect(table.map((r) => [r[0], r.at(-1)])).toEqual([["mixed", "부분합"], ["known", "확인됨"], ["missing", "확인 필요"]]);
  expect(table[0][1]).toContain("$2,100부분합");
  expect(table[2][1]).toContain("확인 필요");
  const labels = [...container.querySelectorAll("[aria-label]")].map((d) => d.getAttribute("aria-label"));
  expect(labels).toContain("bedrock $2,100 (부분합) — claude-opus-5 $2,100");
  expect(labels).toContain("enterprise $5 — claude-opus-5 $5");
  expect(screen.getByText("모델별 보고 비용 구성 · 보고 비용 확인 필요 사용자 1명 제외 · 부분합 사용자 1명 포함")).toBeTruthy();
  const csv = await exportTable("사용자 · 모델별 비용");
  expect(csv).toContain('mixed,"$2,100 — bedrock $2,100 (부분합)","1,050 — bedrock 1,050토큰",부분합');
  expect(csv).toContain("missing,,40 — bedrock 40토큰,확인 필요");
});

test("summary with one usable and one unusable report shows the known subtotal labelled 부분합", async () => {
  mount("ab", {
    "/api/cost/summary": [summary, { ...summary, group: "enterprise", computed_cost: 10, reported_cost: 0 }],
    "/api/overview/active-users": { users: 2, bedrock_users: 2, enterprise_users: 1 },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "계산 비용 비교" }));
  await waitFor(() => expect(card("총 비용").textContent).toContain("$6,647.79"));
  expect(card("총 비용").textContent).toContain("알려진 보고 비용 부분합 · 일부 보고값 누락");
  expect(card("30일 예상 비용").textContent).toContain("$99,716.85");
  expect(card("30일 예상 비용").textContent).toContain("부분합 기준");
  expect(card("개발자당 비용").textContent).toContain("$3,323.9");
  expect(card("개발자당 비용").textContent).toContain("2명 기준 · 부분합 기준");
  expect(card("사용자당 비용 — bedrock").textContent).toContain("$3,323.9");
  expect(card("사용자당 비용 — bedrock").textContent).not.toContain("부분합");
  expect(card("사용자당 비용 — enterprise").textContent).toContain("확인 필요");
  expect(card("비교 기준 보고 비용").textContent).toContain("$6,647.79");
  expect(card("비교 기준 보고 비용").textContent).toContain("부분합");
  expect(card("토큰 단가 계산 비용").textContent).toContain("$7,827.28");
});

test("one Bedrock group retains its known model subtotal when another model is unavailable", async () => {
  mount("ab", {
    "/api/cost/summary": [{ ...summary, reported_cost: null, known_reported_cost: 6647.79, reported_partial: true }],
    "/api/overview/active-users": { users: 2, bedrock_users: 2 },
  }, undefined, "/cost?period=month&group=bedrock");
  await waitFor(() => expect(card("총 비용").textContent).toContain("$6,647.79"));
  expect(card("총 비용").textContent).toContain("알려진 보고 비용 부분합");
  expect(card("사용자당 비용 — bedrock").textContent).toContain("$3,323.9");
  expect(card("사용자당 비용 — bedrock").textContent).toContain("부분합");
  expect(card("30일 예상 비용").textContent).toContain("부분합 기준");
  expect(vi.mocked(fetch).mock.calls.some(([url]) => {
    const query = new URL(String(url), "https://example.invalid");
    return query.pathname === "/api/cost/summary" && new Date(query.searchParams.get("from")).getUTCDate() === 1
      && query.searchParams.get("group") === "bedrock";
  })).toBe(true);
});

test("an entirely unpriced Bedrock summary still has no known cost", async () => {
  mount("single", {
    "/api/cost/summary": [{ ...summary, reported_cost: null, known_reported_cost: null, reported_partial: false }],
  });
  await waitFor(() => expect(card("총 비용").textContent).toContain("확인 필요"));
  expect(card("총 비용").textContent).not.toContain("$");
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
  fireEvent.click(screen.getByRole("checkbox", { name: "계산 비용 비교" }));
  await waitFor(() => expect(cells("에이전트별 비용")).toHaveLength(2));
  expect(cells("에이전트별 비용")[0]).toEqual(["메인 세션", "bedrock", "$20", "$1", "10", "확인됨"]);
  expect(card("Effort 수준별 보고 비용 — bedrock").textContent).toContain("high: $7 (계산값 $100)");
  expect(card("Effort 수준별 보고 비용 — bedrock").textContent).toContain("medium: $9");
  expect(card("Effort 수준별 보고 비용 — bedrock").textContent).toContain("미지정: 확인 필요");
  await waitFor(() => expect(cells("비용 효율 ($/LOC · $/커밋)")).toHaveLength(3));
  expect(cells("비용 효율 ($/LOC · $/커밋)")[0].slice(0, 7)).toEqual(["reported-best", "bedrock", "$10", "10", "2", "$1.0000", "$5"]);
  expect((await exportTable("에이전트별 비용"))).toContain("메인 세션,bedrock,20,1,10");
  const efficiencyCsv = await exportTable("비용 효율 ($/LOC · $/커밋)");
  expect(efficiencyCsv).toContain("reported-best,bedrock,10,10,2,1,5");
  expect(efficiencyCsv).toContain("missing,bedrock,,10,2,,");
});

// 추이 차트 드래그는 레이아웃이 필요하다(GroupCharts.test.jsx와 같은 치수 스텁).
let location;
function LocationSpy() { location = useLocation(); return null; }
// One model across three days: one stacked area and three known bucket marks.
const DAILY = ["2026-09-01", "2026-09-02", "2026-09-03"].map((day) => ({ day, group: "bedrock", model: "m1", cost: 1, reported_cost: 1 }));
const MODELS = [{ group: "bedrock", model: "m1", cost: 3, reported_cost: 3, tokens: 10 }];
const USER_MODELS = [{ user: "u@x.com", group: "bedrock", model: "m1", cost: 3, reported_cost: 3, tokens: 10 }];
function mountHeld() {
  setPiiMask(false);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 800, height: 300, top: 0, left: 0, right: 800, bottom: 300, x: 0, y: 0 });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  const held = [];
  const gate = { models: false, userModels: false };
  vi.stubGlobal("fetch", vi.fn((url) => {
    const u = new URL(String(url), "http://localhost");
    const body = u.pathname === "/api/health/data" ? { status: "ok", latest: null, ageMinutes: 0, staleAfterMinutes: 360 }
      : u.pathname === "/api/cost/by-model-daily" ? DAILY : u.pathname === "/api/cost/by-model" ? MODELS : u.pathname === "/api/cost/by-user-model" ? USER_MODELS : [];
    if (u.pathname === "/api/cost/by-model-daily" && u.searchParams.get("intervalHours") === "1")
      return new Promise((resolve) => held.push({ u, resolve }));
    if (gate.models && u.pathname === "/api/cost/by-model") return new Promise((resolve) => held.push({ u, resolve }));
    if (gate.userModels && u.pathname === "/api/cost/by-user-model") return new Promise((resolve) => held.push({ u, resolve }));
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  }));
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  render(
    <ConfigProvider config={{ piiMask: false, groupMode: "single", schema: {}, pricing: { cacheWriteTtl: "5m", overriddenModels: [] } }}>
      <MemoryRouter initialEntries={[claudeDetail("/cost?days=7")]}><LocationSpy /><App /></MemoryRouter>
    </ConfigProvider>
  );
  return { held, gate };
}
async function dailyChart() {
  const card = (await screen.findByText("모델별 비용 추이", { exact: true })).closest(".rounded-lg");
  await waitFor(() => expect(card.querySelectorAll(".recharts-area-area").length).toBe(1));
  expect(card.querySelectorAll('[data-state="known"]').length).toBe(3);
  return card;
}
function dragAcross(card) {
  const chart = card.querySelector(".recharts-wrapper");
  const grid = chart.querySelector(".recharts-cartesian-grid-horizontal line");
  const left = Number(grid.getAttribute("x1")), right = Number(grid.getAttribute("x2"));
  const x = (i) => left + (right - left) * (i + 0.5) / 3;
  fireEvent.mouseDown(chart, { clientX: x(0), clientY: 80 });
  fireEvent.mouseMove(chart, { clientX: x(2), clientY: 80 });
  fireEvent.mouseUp(chart, { clientX: x(2), clientY: 80 });
}
const csvButton = (title) => within(screen.getByText(title, { exact: true }).closest(".rounded-lg")).getByRole("button", { name: "CSV" });

test("dragging the daily cost trend zooms the whole page to their full days", async () => {
  // The zoom is clamped to the selected range, so the clock must put the fixture days inside it.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
  mountHeld();
  const chartCard = await dailyChart();
  dragAcross(chartCard);
  await act(async () => {});
  const params = new URLSearchParams(location.search);
  expect(params.get("from")).toBe("2026-09-01T00:00:00.000Z");
  expect(params.get("to")).toBe("2026-09-04T00:00:00.000Z");
  expect(screen.queryByTitle("확대 해제")).not.toBeNull();
  vi.useRealTimers();
});

test("a pending granularity change blocks drag zoom on the retained daily trend", async () => {
  const { held } = mountHeld();
  const chartCard = await dailyChart();
  fireEvent.click(within(chartCard).getByRole("button", { name: "시간별" }));
  await act(async () => {});
  expect(held.length).toBe(1);
  expect(chartCard.querySelectorAll(".recharts-area-area").length).toBe(1);
  expect(chartCard.querySelectorAll('[data-state="known"]').length).toBe(3);
  dragAcross(chartCard);
  await act(async () => {});
  expect(new URLSearchParams(location.search).get("from")).toBe(null);
  expect(screen.queryByTitle("확대 해제")).toBeNull();
});

test("a period change disables CSV export until the new rows arrive", async () => {
  const { held, gate } = mountHeld();
  await dailyChart();
  expect(csvButton("모델별 비용과 토큰").disabled).toBe(false);
  gate.models = true;
  fireEvent.click(screen.getByRole("button", { name: "30일", exact: true }));
  await act(async () => {});
  expect(csvButton("모델별 비용과 토큰").disabled).toBe(true);
  const req = held.find((h) => h.u.pathname === "/api/cost/by-model");
  await act(async () => req.resolve({ ok: true, status: 200, json: async () => MODELS }));
  await waitFor(() => expect(csvButton("모델별 비용과 토큰").disabled).toBe(false));
});

test("clicking a model row opens a per-user share panel beside the table and toggles it closed", async () => {
  mount("single", {
    "/api/cost/by-model": [{ group: "bedrock", model: "claude-sonnet-5", cost: 20, reported_cost: 20, tokens: 1500 }],
  });
  await waitFor(() => expect(cells("모델별 비용과 토큰")).toHaveLength(1));
  const row = within(card("모델별 비용과 토큰")).getAllByRole("row")[1];
  fireEvent.click(row);
  const panel = screen.getByText(/— 사용자별 비용$/).closest(".rounded-lg");
  expect(panel.textContent).toContain("a@x.com");
  expect(panel.textContent).toContain("$16");
  expect(panel.textContent).toContain("100.0%");
  expect(panel.textContent).not.toContain("사용자 ID 없음");
  expect(row.getAttribute("data-selected")).toBe("true");
  fireEvent.click(row);
  expect(screen.queryByText(/— 사용자별 비용$/)).toBeNull();
});

test("a period change holds the model user panel until the user rows are for the new period", async () => {
  const { held, gate } = mountHeld();
  await dailyChart();
  fireEvent.click(within(screen.getByText("모델별 비용과 토큰", { exact: true }).closest(".rounded-lg")).getAllByRole("row")[1]);
  const panel = () => screen.getByText(/— 사용자별 비용$/).closest(".rounded-lg");
  await waitFor(() => expect(panel().textContent).toContain("100.0%"));
  gate.userModels = true;
  fireEvent.click(screen.getByRole("button", { name: "30일", exact: true }));
  await act(async () => {});
  expect(panel().textContent).toContain("불러오는 중");
  expect(panel().textContent).not.toContain("100.0%");
  const pending = held.filter((h) => h.u.pathname === "/api/cost/by-user-model");
  expect(pending.length).toBeGreaterThan(0);
  await act(async () => { for (const h of pending) h.resolve({ ok: true, status: 200, json: async () => USER_MODELS }); });
  await waitFor(() => expect(panel().textContent).toContain("100.0%"));
});
