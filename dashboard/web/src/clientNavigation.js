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
export const clientPage = (pathname) => CLIENT_PAGES.find((p) => p.to === pathname) || CLIENT_PAGES[0];
export const isClientPath = (pathname) => CLIENT_PAGES.some((p) => p.to === pathname);
