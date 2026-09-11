import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../App.jsx";
import { ConfigProvider } from "../ConfigContext.jsx";

// 2026-09-09 project.name 배선의 렌더 테스트. 호스트가 뮤테이션 5개로 커밋된 스위트의 구멍을
// 실측했고, 살아남은 셋이 이 파일의 존재 이유다: (1) Usage.jsx의 프로젝트 카드 게이트를 항상
// 참으로, (2) useApi.js가 project를 요청에 안 싣기, (3) useApi.js의 paramsKey/deps에서 project
// 제거 — 전부 페이지를 마운트해야만 보이는 배선이라 순수 모듈 테스트로는 닿지 않는다.
//
// 두 가지 함정(호스트 실측, GroupFilter.render.test.jsx와 같은 규약):
// 1) App은 /api/config를 스스로 fetch하지 않는다 — main.jsx가 받아 ConfigProvider의 prop으로
//    넘긴다. fetch 목만 바꾸면 schema는 영원히 기본값(undefined)이라 게이트 테스트가 조용히
//    무의미해진다. ConfigProvider에 config prop을 명시로 넘겨야 한다.
// 2) "진입점"은 카드 제목이면서 그 표의 컬럼 헤더이기도 해서 정확일치 조회가 2개를 돌려준다 —
//    카드 존재는 고유한 subtitle "Claude Code를 어디서 실행했는지"로 핀한다.
//    container.textContent.includes(...)는 사이드바 nav 힌트와 부분문자열이 충돌할 수 있어
//    쓰지 않는다 — 전부 queryAllByText 정확일치로 단정한다.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// 호스트가 실제 서버를 실제 ClickHouse에 붙여 받은 응답 그대로 — 다시 계산하지 않는다.
// count()/uniqExact()가 문자열("2", "1")로 오는 것이 요점(드라이버 실측): 프론트의
// Number(n || 0) 경로를 실제로 태워야 포맷터 버그가 잡힌다.
const PAYLOAD = {
  "/api/usage/entrypoints": [
    { group: "bedrock", entrypoint: "vscode", requests: "2", sessions: "1", cost_usd: 0.04, users: "1" },
    { group: "enterprise", entrypoint: "terminal", requests: "2", sessions: "2", cost_usd: 0.15000000000000002, users: "2" },
  ],
  "/api/usage/projects": [
    { group: "bedrock", project: "repo-a", cost_usd: 2, tokens: 200, sessions: "1", users: "1" },
    { group: "enterprise", project: "repo-b", cost_usd: 0.5, tokens: 1000, sessions: "1", users: "1" },
    { group: "enterprise", project: "(untagged)", cost_usd: 0.25, tokens: 0, sessions: "1", users: "1" },
  ],
  "/api/usage/permission-modes": [
    { group: "bedrock", from_mode: "plan", to_mode: "auto", changes: "2", sessions: "1" },
    { group: "enterprise", from_mode: "bypassPermissions", to_mode: "auto", changes: "1", sessions: "1" },
  ],
  "/api/usage/decision-sources": [
    { group: "bedrock", decision_source: "config", decision_type: "accept", tool_results: "3", share: 0.75 },
    { group: "bedrock", decision_source: "user_temporary", decision_type: "accept", tool_results: "1", share: 0.25 },
    { group: "enterprise", decision_source: "hook", decision_type: "reject", tool_results: "1", share: 1 },
  ],
};

// /api/config는 객체, /api/health/data는 status를 가진 객체, 나머지는 배열 — shape가 다르므로
// 하나로 뭉뚱그리면 렌더 중에 터진다(Cost.render.test.jsx와 같은 규칙). PAYLOAD 조회를 위해
// 쿼리스트링을 잘라낸 경로로 분기하고, 요청 URL은 calls에 모아 테스트 3·4가 읽는다.
// ConfigProvider의 config와 /api/config 응답에 같은 schema를 넣는다 — 두 소스가 어긋나면
// 어느 쪽을 SPA가 읽는지에 따라 테스트가 조용히 다른 것을 검증하게 된다.
function mount(entry, schema) {
  const calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const u = String(url);
      calls.push(u);
      const path = u.split("?")[0];
      const body =
        path === "/api/config"
          ? { piiMask: false, groupMode: "ab", schema }
          : path === "/api/health/data"
            ? { status: "ok", latest: null, ageMinutes: 0, staleAfterMinutes: 360 }
            : (PAYLOAD[path] ?? []);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    })
  );
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  const utils = render(
    <ConfigProvider config={{ piiMask: false, groupMode: "ab", schema }}>
      <MemoryRouter initialEntries={[entry]}>
        <App />
      </MemoryRouter>
    </ConfigProvider>
  );
  return { ...utils, calls };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// 뮤테이션 커버리지가 아니라 값 전달 검증 — 라벨 매퍼(entrypointLabel/decisionSourceLabel)와
// 포맷터(pct0/fmt)가 서버의 문자열/숫자 혼용 페이로드를 실제 DOM까지 나른다.
test("projectColumns: true — 네 카드가 다 렌더되고 라벨 매퍼·포맷터 결과가 DOM에 닿는다", async () => {
  mount("/usage", { projectColumns: true });
  await waitFor(() => expect(screen.queryAllByText("Claude Code를 어디서 실행했는지").length).toBe(1), { timeout: 5000 });
  expect(screen.queryAllByText("프로젝트별 사용").length).toBe(1);
  expect(screen.queryAllByText("권한 모드 전환").length).toBe(1);
  expect(screen.queryAllByText("도구 승인 출처").length).toBe(1);
  // entrypointLabel: vscode → "VS Code 확장", 빈 값은 서버가 이미 'terminal'로 바꿔 내려준다.
  expect(screen.queryAllByText("VS Code 확장").length).toBe(1);
  expect(screen.queryAllByText("터미널").length).toBe(1);
  // decisionSourceLabel — tool_decision의 SOURCE_LABEL과 별개 맵이라 따로 확인한다.
  expect(screen.queryAllByText("설정 자동 승인").length).toBe(1);
  expect(screen.queryAllByText("사용자(1회)").length).toBe(1);
  expect(screen.queryAllByText("훅").length).toBe(1);
  // pct0가 0-1 소수를 퍼센트로.
  expect(screen.queryAllByText("75%").length).toBe(1);
  expect(screen.queryAllByText("25%").length).toBe(1);
  // fmt의 천단위 구분 — 서버가 준 숫자/문자열 혼용을 Number(n || 0) 경로로 통과해야 한다.
  expect(screen.queryAllByText("(untagged)").length).toBe(1);
  expect(screen.queryAllByText("1,000").length).toBeGreaterThanOrEqual(1);
  // 권한 모드 이름은 매핑하지 않고 그대로 보여준다.
  expect(screen.queryAllByText("bypassPermissions").length).toBe(1);
  expect(screen.getByPlaceholderText("프로젝트")).toBeTruthy();
});

// "Usage.jsx의 카드 게이트를 항상 참으로" 뮤테이션을 죽인다. false와 null 양쪽을 단정해야
// 한다 — null(프로브 실패)이 통과하면 "확인 못 함"이 "적용됨"으로 읽힌다.
test("projectColumns가 false/null — 프로젝트 카드와 필터 입력창이 사라지고 나머지 세 카드는 남는다", async () => {
  for (const schema of [{ projectColumns: false }, { projectColumns: null }]) {
    mount("/usage", schema);
    await waitFor(() => expect(screen.queryAllByText("Claude Code를 어디서 실행했는지").length).toBe(1), { timeout: 5000 });
    expect(screen.queryAllByText("프로젝트별 사용").length).toBe(0);
    expect(screen.queryByPlaceholderText("프로젝트")).toBeNull();
    expect(screen.queryAllByText("권한 모드 전환").length).toBe(1);
    expect(screen.queryAllByText("도구 승인 출처").length).toBe(1);
    cleanup();
  }
});

// "useApi.js가 project를 요청에 안 싣기" 뮤테이션을 죽인다 — URL의 ?project=가 모든 데이터
// 요청에 실제로 실리는지는 페이지를 마운트해야만 보인다.
test("?project=repo-a — /api/usage/·/api/overview/ 요청 전부가 그 파라미터를 싣는다", async () => {
  const { calls } = mount("/usage?project=repo-a", { projectColumns: true });
  await waitFor(() => expect(screen.queryAllByText("Claude Code를 어디서 실행했는지").length).toBe(1), { timeout: 5000 });
  const dataCalls = calls.filter((u) => u.startsWith("/api/usage/") || u.startsWith("/api/overview/"));
  expect(dataCalls.length).toBeGreaterThan(0);
  for (const u of dataCalls) expect(u).toContain("project=repo-a");
  // 새 엔드포인트 4개가 실제로 호출됐는지도 각각 — 훅이 빠지면 위 전수 검사가 공허해진다.
  for (const p of ["/api/usage/projects?", "/api/usage/permission-modes?", "/api/usage/decision-sources?", "/api/usage/entrypoints?"]) {
    expect(calls.some((u) => u.startsWith(p))).toBe(true);
  }
});

// 3번과 짝: 필터가 없을 때 파라미터가 새지 않는지. 실측(2026-09-09, 호스트 뮤테이션): 이
// 테스트와 3번 둘 다 "paramsKey/deps에서 project 제거"는 **잡지 못한다** — 마운트 시점의
// 요청은 클로저의 project 값을 그대로 실어 지나가고, 재요청이 죽는 것은 값이 *바뀐 뒤*에만
// 드러난다. 그 뮤테이션은 아래 마지막 테스트가 죽인다.
test("URL에 필터가 없으면 어떤 요청에도 project=가 붙지 않는다", async () => {
  const { calls } = mount("/usage", { projectColumns: true });
  await waitFor(() => expect(screen.queryAllByText("Claude Code를 어디서 실행했는지").length).toBe(1), { timeout: 5000 });
  expect(calls.filter((u) => u.includes("project="))).toEqual([]);
});

// 호스트 추가(2026-09-09) — useApi의 **deps 배열**에서 project가 빠지는 것을 죽이는 유일한
// 형태다. 위 세 테스트는 전부 마운트 직후만 보는데, 그 시점 요청은 deps와 무관하게 클로저의
// 값을 싣고 지나간다(실측: deps 뮤테이션이 위 네 테스트를 전부 통과했다). 배선이 깨지는 것은
// 마운트 뒤 값이 *바뀔* 때 — 재요청이 아예 나가지 않아 화면이 조용히 낡은 데이터를 보여준다.
// 입력창은 FilterContext에서 300ms debounce되므로 waitFor 안에 새 요청이 떠야 한다.
//
// 실측으로 갈린 짝(2026-09-09): deps에서 빼면 이 테스트가 빨개지지만, `paramsKey`에서만
// 빼면 **이 파일의 어떤 테스트도 빨개지지 않는다** — deps가 살아 있으면 effect는 여전히
// 재실행되고 요청은 새 값으로 나가므로, paramsKey의 역할은 loading 전이/이전 요청 abort/
// 틱 실패 구분 같은 부기(簿記)뿐이라 결과 데이터로는 구별되지 않는다. 그쪽은 커버리지 구멍이
// 아니라 해피 패스에서 중복인 가드다 — 새 테스트로 억지로 덮지 않는다.
test("프로젝트 입력값을 바꾸면 debounce 뒤 그 값으로 다시 요청한다 (useApi deps)", async () => {
  const { calls } = mount("/usage", { projectColumns: true });
  await waitFor(() => expect(screen.queryAllByText("Claude Code를 어디서 실행했는지").length).toBe(1), { timeout: 5000 });
  const before = calls.length;
  fireEvent.change(screen.getByPlaceholderText("프로젝트"), { target: { value: "repo-b" } });
  await waitFor(() => expect(calls.filter((u) => u.includes("project=repo-b")).length).toBeGreaterThan(0), { timeout: 3000 });
  expect(calls.length).toBeGreaterThan(before);
});

// 호스트 추가(2026-09-10, PR #31 리뷰 L4 MINOR-1) — 입력창이 숨겨진 상태에서 URL의 ?project=가
// 조용히 모든 요청에 실려 나가는 것을 죽인다. 실측(변경 전, 같은 마운트 헬퍼로): projectColumns가
// false / null / 키 없음 세 경우 모두 17개 요청 중 16개가 project=repo-a를 실었다(싣지 않은 둘은
// /api/config와 /api/health/data). 게이트가 parseUrlState 단계에 있어 FilterContext의 상태 자체가
// 비고, useApi의 게이트는 이중 안전이다 — 그래서 이 테스트는 두 게이트 중 어느 쪽을 지워도
// 빨개지지 않고 둘 다 지워야 빨개진다는 점을 기억할 것(호스트가 뮤테이션으로 확인).
test("projectColumns가 true가 아니면 URL의 ?project=가 어떤 요청에도 실리지 않는다", async () => {
  for (const schema of [{ projectColumns: false }, { projectColumns: null }, {}]) {
    const { calls } = mount("/usage?project=repo-a", schema);
    await waitFor(() => expect(screen.queryAllByText("Claude Code를 어디서 실행했는지").length).toBe(1), { timeout: 5000 });
    expect(calls.filter((u) => u.includes("project="))).toEqual([]);
    cleanup();
  }
});
