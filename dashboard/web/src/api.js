export async function apiGet(path, params = {}, signal) {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined))
  );
  const res = await fetch(`${path}?${qs}`, { signal });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}
