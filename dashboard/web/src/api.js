export async function apiGet(path, params = {}, signal) {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined))
  );
  const res = await fetchWithCapacityRetry(`${path}?${qs}`, { signal });
  checkAuthentication(res);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

function pause(milliseconds, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    const abort = () => { clearTimeout(timer); cleanup(); reject(signal.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function fetchWithCapacityRetry(url, options = {}, {
  request = fetch, wait = pause, random = Math.random,
} = {}) {
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    const response = await request(url, options);
    if (response.status !== 503 || attempt >= 3) return response;
    const seconds = Number(response.headers?.get("Retry-After"));
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 5) return response;
    let body;
    try { body = await response.clone().json(); } catch { return response; }
    if (body?.code !== "capacity_exhausted") return response;
    const delay = seconds * 1000 + Math.min(attempt, 2) * 1000 + Math.floor(random() * 1000);
    await wait(delay, options.signal);
  }
}
export function checkAuthentication(response) {
  if (response.status === 401 && typeof window !== "undefined")
    window.dispatchEvent(new Event("ccdash:authentication-required"));
}
