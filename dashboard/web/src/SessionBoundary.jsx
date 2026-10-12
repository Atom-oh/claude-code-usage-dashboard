import { useEffect, useState } from "react";
import { useConfig } from "./ConfigContext.jsx";

export default function SessionBoundary({ children }) {
  const { session } = useConfig();
  const oidc = session?.mode === "oidc";
  const expires = oidc ? Date.parse(session.expiresAt) : Infinity;
  const [unauthorized, setUnauthorized] = useState(false);
  const expired = oidc && (unauthorized || !Number.isFinite(expires) || expires <= Date.now());
  useEffect(() => {
    if (!oidc || expired) return;
    const invalidate = () => setUnauthorized(true);
    const timer = setTimeout(invalidate, Math.max(0, expires - Date.now()));
    window.addEventListener("ccdash:authentication-required", invalidate);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("ccdash:authentication-required", invalidate);
    };
  }, [oidc, expires, expired]);
  if (!expired) return children;
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
