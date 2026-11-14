import { translate, useLocale } from "./i18n/index.js";
import { useEffect, useState } from "react";
import { LanguagePicker } from "./components/LanguagePicker.jsx";
import { useConfig } from "./ConfigContext.jsx";

export default function SessionBoundary({ children }) {
  const _locale = useLocale();
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
      clearTimeout(retryTimer);
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
        // Clock skew can put the browser ahead of the server's renewal window.
        // An unchanged expiry does not rerun this effect, so keep a bounded retry.
        if (Date.parse(next.expiresAt) === expires) retryTimer = setTimeout(renew, 5000);
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
        <h1 className="text-lg font-semibold">{translate("m793bfa35f3fe")}</h1>
        <p className="mt-3 text-sm text-ink-600">{retrying
          ? translate("m1f6777776c90")
          : translate("m81d158eed4fb")}</p>
        <LanguagePicker />
      </section>
    </main>
  );
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <section className="w-full max-w-md rounded-lg border border-ink-100 bg-card p-6" aria-labelledby="session-expired-title">
        <h1 id="session-expired-title" className="text-lg font-semibold">{translate("m6dfad6acf115")}</h1>
        <p role="alert" className="mt-3 text-sm text-ink-600">{translate("me00efee2869c")}</p>
        <a href="/auth/login" className="mt-5 inline-block rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600">{translate("m0f222845b51a")}</a>
        <LanguagePicker />
      </section>
    </main>
  );
}
