import { createContext, useContext, useEffect, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useConfig } from "./ConfigContext.jsx";
import { clientPage, isClientPath } from "./clientNavigation.js";

export const CLIENT_LABELS = { all: "전체", claude: "Claude Code", codex: "Codex" };
const ClientContext = createContext({ client: "claude", common: true, detail: false, enabledClients: ["claude"] });

export function ClientProvider({ children }) {
  const { enabledClients, piiMask } = useConfig();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const query = new URLSearchParams(search);
  const requested = query.get("client");
  const legacyFilter = !!(query.get("group") || query.get("project"));
  const legacyLink = !requested && legacyFilter && enabledClients.includes("claude");
  const fallback = legacyLink ? "claude" : enabledClients.length > 1 ? "all" : enabledClients[0];
  const client = enabledClients.includes(requested) || (requested === "all" && enabledClients.length > 1)
    ? requested : fallback;
  const detail = client === "claude" && (query.get("view") === "detail" || (!query.has("view") && legacyFilter));
  const common = !detail;

  useEffect(() => {
    document.title = `${clientPage(pathname).label} · ${client === "all" ? "Claude + Codex" : CLIENT_LABELS[client]}${detail ? " 상세" : ""}`;
  }, [client, detail, pathname]);

  // Gate rendering immediately; normalization must never briefly mount a disabled route.
  useEffect(() => {
    const params = new URLSearchParams(search);
    if (requested && requested !== client || legacyLink) params.set("client", client);
    if (common) {
      params.delete("group");
      params.delete("project");
      params.delete("view");
    } else {
      params.delete("backend");
      params.set("view", "detail");
    }
    if (piiMask) params.delete("user");
    params.sort();
    const nextPath = isClientPath(pathname) ? pathname : "/";
    const nextSearch = params.toString() ? `?${params}` : "";
    if (nextPath !== pathname || nextSearch !== search) {
      navigate({ pathname: nextPath, search: nextSearch }, { replace: true });
    }
  }, [client, common, pathname, search, requested, legacyLink, piiMask, navigate]);

  const value = useMemo(() => ({
    client, common, detail, enabledClients,
    setClient(next) {
      if (!enabledClients.includes(next) && !(next === "all" && enabledClients.length > 1)) return;
      const params = new URLSearchParams(search);
      params.set("client", next);
      if (next !== "claude" || common) {
        params.delete("group");
        params.delete("project");
        params.delete("view");
      } else {
        params.delete("backend");
      }
      if (piiMask) params.delete("user");
      params.sort();
      navigate({ pathname: isClientPath(pathname) ? pathname : "/", search: `?${params}` }, { replace: true });
    },
    setDetail(value) {
      if (client !== "claude") return;
      const params = new URLSearchParams(search);
      params.set("client", "claude");
      if (value) {
        params.set("view", "detail");
        params.delete("backend");
      } else {
        params.delete("view");
        params.delete("group");
        params.delete("project");
      }
      if (piiMask) params.delete("user");
      params.sort();
      navigate({ pathname: isClientPath(pathname) ? pathname : "/", search: `?${params}` }, { replace: true });
    },
  }), [client, common, detail, enabledClients, search, pathname, piiMask, navigate]);

  return <ClientContext.Provider value={value}>{children}</ClientContext.Provider>;
}

export function useClient() {
  return useContext(ClientContext);
}
