export function claudeDetail(entry) {
  const url = new URL(entry, "http://localhost");
  url.searchParams.set("client", "claude");
  url.searchParams.set("view", "detail");
  return url.pathname + url.search + url.hash;
}
