import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, waitFor, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../App.jsx";
import { ConfigProvider } from "../ConfigContext.jsx";

// 상단 채널 필터(FilterBar의 세그먼트 = URL의 ?group=)가 걸리면 그룹 카드도 그 채널만 남아야
// 한다. pivot.test.js는 groupsShown의 순수 규칙만 본다 — "페이지가 실제로 그 규칙을 통해
// 카드를 그리는가"는 이 파일만 잡는다(실측: 변경 전 트리에서는 ?group=bedrock에도
// "캐시 효율 — enterprise" 카드가 빈 상태로 함께 렌더됐다).
//
// 두 가지 함정:
// 1) 라우트는 Overview가 "/", Executive가 "/exec"다(App.jsx의 라우트 표) — "/overview"는 없다.
// 2) await waitFor(...)로 mount effect를 flush해야 한다 — 지우면 카드가 그려지기 전에 단정이
//    돌아 테스트가 깨진다(실측 2026-09-07). ResizeObserver 스텁은 이 파일에선 지워도 통과한다
//    (fetch 목이 빈 배열을 주므로 recharts ResponsiveContainer까지 도달하지 않는다) —
//    Cost.render.test.jsx/App.test.jsx와 같은 마운트 규약을 유지하려고 남긴다. 목에 실제 행을
//    채우는 순간 없으면 ReferenceError로 죽는다.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// /api/config는 객체, /api/health/data는 status를 가진 객체, 나머지는 배열 — shape가 다르므로
// 하나로 뭉뚱그리면 렌더 중에 터진다(Cost.render.test.jsx와 같은 규칙). 카드 가시성만 보므로
// 데이터 자체는 빈 배열로 충분하다(ab 모드는 응답이 비어도 두 카드를 그리는 것이 기존 동작).
function mount(entry, groupMode = "ab") {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const u = String(url);
      const body = u.startsWith("/api/config")
        ? { piiMask: false, groupMode, schema: {} }
        : u.startsWith("/api/health/data")
          ? { status: "ok", latest: null, ageMinutes: 0, staleAfterMinutes: 360 }
          : [];
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    })
  );
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  return render(
    <ConfigProvider config={{ piiMask: false, groupMode, schema: {} }}>
      <MemoryRouter initialEntries={[entry]}>
        <App />
      </MemoryRouter>
    </ConfigProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("Overview에 ?group=bedrock: bedrock 카드만 남고 enterprise 카드는 사라진다", async () => {
  const { container } = mount("/?group=bedrock");
  await waitFor(() => expect(container.textContent).toContain("캐시 효율"));
  expect(screen.queryAllByText("캐시 효율 — bedrock").length).toBe(1);
  expect(screen.queryAllByText("캐시 효율 — enterprise").length).toBe(0);
  expect(screen.queryAllByText("모델별 토큰 분포 — bedrock").length).toBe(1);
  expect(screen.queryAllByText("모델별 토큰 분포 — enterprise").length).toBe(0);
});

test("Overview 무필터(ab): 두 채널 카드가 그대로 나온다", async () => {
  const { container } = mount("/");
  await waitFor(() => expect(container.textContent).toContain("캐시 효율"));
  expect(screen.queryAllByText("캐시 효율 — bedrock").length).toBe(1);
  expect(screen.queryAllByText("캐시 효율 — enterprise").length).toBe(1);
  expect(screen.queryAllByText("모델별 토큰 분포 — bedrock").length).toBe(1);
  expect(screen.queryAllByText("모델별 토큰 분포 — enterprise").length).toBe(1);
});

test("Executive에 ?group=bedrock: A/B 스코어보드 대신 단일 채널 핵심 지표", async () => {
  const { container } = mount("/exec?group=bedrock");
  await waitFor(() => expect(container.textContent).not.toContain("불러오는 중"), { timeout: 5000 });
  expect(screen.queryAllByText("핵심 지표 — bedrock").length).toBe(1);
  expect(container.textContent).not.toContain("스코어보드");
});

test("Executive 무필터(ab): A/B 스코어보드가 그대로 나온다", async () => {
  const { container } = mount("/exec");
  await waitFor(() => expect(container.textContent).not.toContain("불러오는 중"), { timeout: 5000 });
  expect(container.textContent).toContain("스코어보드");
});
