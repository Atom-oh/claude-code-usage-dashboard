import { useEffect, useState } from "react";
import { useConfig } from "./ConfigContext.jsx";

export default function SessionBoundary({ children }) {
  const { session, updateSession } = useConfig();
  const oidc = session?.mode === "oidc";
  const expires = oidc ? Date.parse(session.expiresAt) : Infinity;
  const refreshExpires = oidc ? Date.parse(session.refreshExpiresAt) : NaN;
  const renewable = Number.isFinite(refreshExpires) && refreshExpires > Date.now();
  const [unauthorized, setUnauthorized] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const expired = oidc && (unauthorized || !Number.isFinite(expires) || expires <= Math.max(clock, Date.now()));
  useEffect(() => {
    if (!oidc || unauthorized) return;
    const invalidate = () => setUnauthorized(true);
    window.addEventListener("ccdash:authentication-required", invalidate);
    if (!renewable) {
      const timer = setTimeout(invalidate, Math.min(2147483647, Math.max(0, expires - Date.now())));
      return () => {
        clearTimeout(timer);
        window.removeEventListener("ccdash:authentication-required", invalidate);
      };
    }
    let active = true;
    let request;
    let retryTimer;
    const deadline = setTimeout(() => setClock(Date.now()), Math.max(0, expires - Date.now()));
    const renew = async () => {
      if (request || !active) return;
      if (Date.now() >= refreshExpires) return invalidate();
      const controller = new AbortController();
      request = controller;
      const timeout = setTimeout(() => controller.abort(), 25000);
      try {
        const response = await fetch("/api/session", { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        if (!active) return;
        if (response.status === 401) return invalidate();
        if (!response.ok) throw new Error("Session renewal unavailable");
        const next = await response.json();
        if (!active) return;
        if (next.mode !== "oidc" || !Number.isFinite(Date.parse(next.expiresAt)) || Date.parse(next.expiresAt) <= Date.now())
          throw new Error("Invalid session response");
        setRetrying(false);
        updateSession(next);
      } catch {
        if (active) {
          setRetrying(true);
          setClock(Date.now());
          retryTimer = setTimeout(renew, 5000);
        }
      } finally {
        clearTimeout(timeout);
        request = null;
      }
    };
    const onFocus = () => {
      setClock(Date.now());
      if (document.visibilityState !== "hidden" && Date.now() >= expires - 30000) void renew();
    };
    const timer = setTimeout(renew, Math.max(0, expires - Date.now() - 30000));
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      active = false;
      request?.abort();
      clearTimeout(timer);
      clearTimeout(deadline);
      clearTimeout(retryTimer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("ccdash:authentication-required", invalidate);
    };
  }, [oidc, expires, refreshExpires, renewable, unauthorized, updateSession]);
  if (!expired) return children;
  if (renewable && !unauthorized) return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <section role="status" className="w-full max-w-md rounded-lg border border-ink-100 bg-card p-6">
        <h1 className="text-lg font-semibold">로그인 상태 확인 중</h1>
        <p className="mt-3 text-sm text-ink-600">{retrying
          ? "인증 서버에 연결하지 못했습니다. 잠시 후 자동으로 다시 시도합니다."
          : "조직 계정의 로그인 상태를 갱신하고 있습니다."}</p>
      </section>
    </main>
  );
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <section className="w-full max-w-md rounded-lg border border-ink-100 bg-card p-6" aria-labelledby="session-expired-title">
        <h1 id="session-expired-title" className="text-lg font-semibold">로그인 세션 만료</h1>
        <p role="alert" className="mt-3 text-sm text-ink-600">데이터를 계속 확인하려면 조직 계정으로 다시 로그인해 주세요.</p>
        <a href="/auth/login" className="mt-5 inline-block rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600">다시 로그인</a>
      </section>
    </main>
  );
}
