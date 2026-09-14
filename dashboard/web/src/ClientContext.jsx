import { createContext, useContext, useEffect, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useConfig } from "./ConfigContext.jsx";

export const CLIENT_LABELS = { all: "전체", claude: "Claude Code", codex: "Codex" };
const ClientContext = createContext({ client: "claude", common: false, enabledClients: ["claude"] });

export function ClientProvider({ children }) {
  const { enabledClients, piiMask } = useConfig();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const requested = new URLSearchParams(search).get("client");
  const fallback = enabledClients.length > 1 ? "all" : enabledClients[0];
  const client = enabledClients.includes(requested) || (requested === "all" && enabledClients.length > 1)
    ? requested : fallback;
  const common = client !== "claude";

  useEffect(() => {
    document.title = common
      ? `${client === "all" ? "Claude + Codex" : "Codex"} 사용량·비용`
      : "Claude Code A/B Dashboard";
  }, [client, common]);

  // Gate rendering immediately; normalization must never briefly mount a disabled route.
  useEffect(() => {
    const params = new URLSearchParams(search);
    if (requested && requested !== client) params.set("client", client);
    if (common) {
      params.delete("group");
      params.delete("project");
    } else {
      params.delete("backend");
    }
    if (piiMask) params.delete("user");
    const nextPath = common ? "/" : pathname;
    const nextSearch = params.toString() ? `?${params}` : "";
    if (nextPath !== pathname || nextSearch !== search) {
      navigate({ pathname: nextPath, search: nextSearch }, { replace: true });
    }
  }, [client, common, pathname, search, requested, piiMask, navigate]);

  const value = useMemo(() => ({
    client, common, enabledClients,
    setClient(next) {
      if (!enabledClients.includes(next) && !(next === "all" && enabledClients.length > 1)) return;
      const params = new URLSearchParams(search);
      params.set("client", next);
      if (next !== "claude") {
        params.delete("group");
        params.delete("project");
      } else {
        params.delete("backend");
      }
      if (piiMask) params.delete("user");
      navigate({ pathname: next === "claude" ? pathname : "/", search: `?${params}` }, { replace: true });
    },
  }), [client, common, enabledClients, search, pathname, piiMask, navigate]);

  return <ClientContext.Provider value={value}>{children}</ClientContext.Provider>;
}

export function useClient() {
  return useContext(ClientContext);
}
