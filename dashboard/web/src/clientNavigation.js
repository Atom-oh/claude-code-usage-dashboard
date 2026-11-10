export const CLIENT_PAGES = [
  { to: "/", key: "overview", label: "Overview", hint: "핵심 지표 요약", exact: true },
  { to: "/exec", key: "exec", label: "Executive", hint: "활용·비용 요약" },
  { to: "/trends", key: "trends", label: "Trends", hint: "사용량·비용 추이" },
  { to: "/productivity", key: "productivity", label: "Productivity", hint: "관측 효율·활동" },
  { to: "/usage", key: "usage", label: "Usage", hint: "토큰·도구 사용" },
  { to: "/users", key: "users", label: "Users", hint: "사용자별 활용" },
  { to: "/cost", key: "cost", label: "Cost", hint: "비용·모델별 비교" },
  { to: "/reliability", key: "reliability", label: "Reliability", hint: "오류·응답 시간" },
  { to: "/analytics", key: "analytics", label: "Analytics", hint: "모델·진단 분석" },
];
export const COLLECTOR_PAGE = { to: "/collector", key: "collector", label: "수집기 설치", hint: "기기 연결·수집 토큰" };
export const clientPage = (pathname) => pathname === COLLECTOR_PAGE.to ? COLLECTOR_PAGE
  : CLIENT_PAGES.find((p) => p.to === pathname) || CLIENT_PAGES[0];
export const isClientPath = (pathname) => CLIENT_PAGES.some((p) => p.to === pathname);
export const CHANGELOG_PATH = "/changelog";
// Public product documentation (site/, published by .github/workflows/pages.yml).
export const USER_GUIDE_URL = "https://www.atomai.click/claude-code-usage-dashboard/";
// Shared task links: /tasks/<task id>/<bucket from>/<bucket to>, each segment URI-encoded.
// The bucket lives in the path because the range state owns (and rewrites) the query string.
// No user in the URL: the server resolves the task's owner.
export const TASK_PATH_PREFIX = "/tasks/";
export const isTaskPath = (pathname) => pathname.startsWith(TASK_PATH_PREFIX) && pathname.length > TASK_PATH_PREFIX.length;
export function taskSharePath(taskId, from, to) {
  return TASK_PATH_PREFIX + [taskId, from, to].map(encodeURIComponent).join("/");
}
export function parseTaskPath(pathname) {
  if (!isTaskPath(pathname)) return null;
  const parts = pathname.slice(TASK_PATH_PREFIX.length).split("/");
  if (parts.length !== 3) return null;
  let id, from, to;
  try { [id, from, to] = parts.map(decodeURIComponent); } catch { return null; }
  const valid = (v) => /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v));
  return id && valid(from) && valid(to) && Date.parse(from) < Date.parse(to) ? { id, from, to } : null;
}
export const isDashboardPath = (pathname) => isClientPath(pathname) || pathname === "/installation"
  || pathname === COLLECTOR_PAGE.to || pathname === CHANGELOG_PATH || isTaskPath(pathname);
