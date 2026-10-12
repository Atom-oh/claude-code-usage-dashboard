export async function apiGet(path, params = {}, signal) {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined))
  );
  const res = await fetch(`${path}?${qs}`, { signal });
  checkAuthentication(res);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}
export function checkAuthentication(response) {
  if (response.status === 401 && typeof window !== "undefined")
    window.dispatchEvent(new Event("ccdash:authentication-required"));
}
