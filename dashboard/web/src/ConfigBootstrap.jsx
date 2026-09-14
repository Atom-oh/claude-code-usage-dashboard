import { useEffect, useState } from "react";
import { setPiiMask } from "./fmt.js";

function isConfig(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return false;
  // Legacy servers omit this field. If present, never turn a malformed list into defaults.
  if (!Object.hasOwn(config, "enabledClients")) return true;
  return Array.isArray(config.enabledClients)
    && config.enabledClients.length > 0
    && new Set(config.enabledClients).size === config.enabledClients.length
    && config.enabledClients.every((client) => client === "claude" || client === "codex");
}

// Only a successful config may initialize routes and their URL-backed state.
export default function ConfigBootstrap({ children }) {
  const [state, setState] = useState({ status: "loading", config: null, attempt: 0 });
  const { attempt } = state;

  useEffect(() => {
    const abort = new AbortController();
    setPiiMask(true);
    const timer = setTimeout(() => {
      abort.abort();
      // Show recovery even if a request/body reader does not settle on abort.
      setState({ status: "error", config: null, attempt, error: "설정 응답 시간이 초과되었습니다. 다시 시도해 주세요." });
    }, 3_000);

    async function loadConfig() {
      // StrictMode cleanup can cancel setup before it sends a duplicate request.
      await Promise.resolve();
      if (abort.signal.aborted) return;
      try {
        const response = await fetch("/api/config", { signal: abort.signal });
        if (abort.signal.aborted) return;
        if (!response.ok) throw new Error("Config request failed");
        const config = await response.json();
        if (abort.signal.aborted) return;
        if (!isConfig(config)) throw new Error("Invalid config response");
        setPiiMask(config.piiMask !== false);
        setState({ status: "ready", config, attempt });
      } catch {
        if (!abort.signal.aborted) setState({ status: "error", config: null, attempt });
      } finally {
        clearTimeout(timer);
      }
    }
    loadConfig();
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [attempt]);

  if (state.status === "ready") return children(state.config);

  const failed = state.status === "error";
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <section className="w-full max-w-md rounded-lg border border-ink-100 bg-card p-6 shadow-card" aria-labelledby="config-bootstrap-title">
        <h1 id="config-bootstrap-title" className="text-lg font-semibold">대시보드 준비</h1>
        <p role={failed ? "alert" : "status"} className="mt-3 break-keep text-sm text-ink-600">
          {failed
            ? state.error || "설정을 불러오지 못했습니다. 연결 상태를 확인한 후 다시 시도해 주세요."
            : "설정을 불러오는 중입니다."}
        </p>
        {failed && (
          <button
            type="button"
            className="mt-5 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
            onClick={() => setState((current) => current.status === "error"
              ? { status: "loading", config: null, attempt: current.attempt + 1 }
              : current)}
          >
            다시 시도
          </button>
        )}
      </section>
    </main>
  );
}
