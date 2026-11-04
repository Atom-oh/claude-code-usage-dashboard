import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { setPiiMask } from "../fmt.js";
import { DailyInsightsView, DISCLAIMER, footerText, periodOptions, statsText, userLabel } from "./DailyInsights.jsx";
afterEach(() => { cleanup(); setPiiMask(true); });

const READY = {
  enabled: true, status: "ready", period: "2026-10-29", generatedAt: "2026-10-30T00:40:00.000Z",
  model: "global.anthropic.claude-haiku-5-5", empty: false, summary: "요약입니다",
  caveats: ["일부 비용은 확인할 수 없습니다."],
  findings: [
    { user: "alice@example.invalid", pseudonym: "U1", title: "U1 비용 증가", detail: "U1의 비용이 기준 대비 150% 증가했습니다.", metric: "+150%" },
    { user: null, pseudonym: null, title: "모델 구성", detail: "sonnet 비중이 높습니다.", metric: "" },
  ],
  org: { period: { cost_usd: 1.2346, cost_partial: true, sessions: 3, turns: 7, cost_per_turn: 0.2 }, baseline_daily: null },
  users: [
    { pseudonym: "U1", user: "alice@example.invalid", cost_usd: 1, cost_partial: false, sessions: 2, turns: 5, cost_per_turn: 0.2 },
    { pseudonym: "U2", user: "bob@example.invalid", cost_usd: null, cost_partial: false, sessions: 1, turns: 2, cost_per_turn: null },
  ],
  usage: { inputTokens: 2000, outputTokens: 500, estimatedCostUsd: 0.00045 },
  available: ["2026-10-29", "2026-10-27"],
};
const view = (props) => render(<DailyInsightsView loading={false} error={null} period={null} onPeriod={() => {}} {...props} />);

test("ready insight shows summary, findings, stored numbers and the disclaimer", () => {
  setPiiMask(true);
  view({ data: READY });
  screen.getByText("AI 인사이트 (Haiku 5.5 · 매일)");
  screen.getByText("요약입니다");
  screen.getByText("U1 비용 증가");
  screen.getByText("U1 · al******@example.invalid");
  screen.getByText("조직 전체");
  screen.getByText("저장된 집계: 보고 비용 $1.00 · 턴 5 · 턴당 비용 $0.2");
  screen.getByText("보고 비용 $1.23 (부분합) · 턴 7 · 턴당 비용 $0.2 · 세션 3");
  screen.getByText("+150%");
  screen.getByText("일부 비용은 확인할 수 없습니다.");
  screen.getByText(DISCLAIMER);
  screen.getByText(footerText(READY));
  expect(screen.queryByText(/alice@example\.invalid/)).toBeNull();
});

test("footer reports model, tokens and estimated call cost", () => {
  const generated = new Date("2026-10-30T00:40:00.000Z").toLocaleString("ko-KR");
  expect(footerText(READY)).toBe(`생성 ${generated} · global.anthropic.claude-haiku-5-5 · 입력 2,000 / 출력 500 토큰 · 추정 호출 비용 $0.00045`);
  expect(footerText({ ...READY, usage: null, model: null })).toBe(`생성 ${generated}`);
});

test("model text renders as plain text", () => {
  const { container } = view({ data: { ...READY, summary: "<b>굵게</b> **강조** [링크](http://x)" } });
  screen.getByText("<b>굵게</b> **강조** [링크](http://x)");
  expect(container.querySelector("b")).toBeNull();
  expect(container.querySelector("strong")).toBeNull();
  expect(container.querySelector("a")).toBeNull();
});

test("pending, failed and empty periods show their state", () => {
  view({ data: { enabled: true, period: "2026-10-29", status: "pending", available: [] } });
  screen.getByText("2026-10-29 인사이트는 아직 생성되지 않았습니다. 매일 00:30 UTC 이후 생성됩니다.");
  screen.getByText(DISCLAIMER);
  cleanup();
  view({ data: { enabled: true, period: "2026-10-29", status: "failed", available: [] } });
  screen.getByText("2026-10-29 인사이트를 생성하지 못했습니다.");
  cleanup();
  view({ data: { ...READY, empty: true, summary: "", findings: [], caveats: [] } });
  screen.getByText("2026-10-29에는 집계할 사용 데이터가 없습니다.");
});

test("disabled feature and non-object payloads render nothing", () => {
  for (const value of [{ enabled: false }, [], null]) {
    const { container } = view({ data: value });
    expect(container.firstChild).toBeNull();
    cleanup();
  }
});

test("period selector lists stored days and reports the choice", () => {
  expect(periodOptions(READY)).toEqual(["2026-10-29", "2026-10-27"]);
  expect(periodOptions({ period: "2026-10-28", available: ["2026-10-29", "2026-10-27"] })).toEqual(["2026-10-29", "2026-10-28", "2026-10-27"]);
  expect(periodOptions({})).toEqual([]);
  const onPeriod = vi.fn();
  view({ data: READY, onPeriod });
  fireEvent.change(screen.getByLabelText("인사이트 날짜"), { target: { value: "2026-10-27" } });
  expect(onPeriod).toHaveBeenCalledWith("2026-10-27");
});

test("loading, error and labels", () => {
  view({ loading: true });
  screen.getByText("불러오는 중...");
  cleanup();
  view({ error: new Error("x") });
  screen.getByText("데이터를 불러오지 못했습니다.");
  setPiiMask(true);
  expect(userLabel("U2", "bob@example.invalid")).toBe("U2 · bo******@example.invalid");
  expect(userLabel("U3", null)).toBe("U3 · (미식별)");
  expect(userLabel(null, null)).toBe("조직 전체");
  expect(statsText({ cost_usd: null, cost_partial: false, turns: 2, cost_per_turn: null })).toBe("보고 비용 확인 필요 · 턴 2 · 턴당 비용 —");
});
