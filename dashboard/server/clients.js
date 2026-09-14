import { ValidationError } from "./http.js";

function enabled(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  if (/^(true|1)$/i.test(String(value))) return true;
  if (/^(false|0)$/i.test(String(value))) return false;
  throw new Error(`${name} must be true or false`);
}

export function parseClients(env) {
  const enabledClients = [];
  if (enabled(env.CLAUDE_ENABLED, true, "CLAUDE_ENABLED")) enabledClients.push("claude");
  if (enabled(env.CODEX_ENABLED, false, "CODEX_ENABLED")) enabledClients.push("codex");
  if (!enabledClients.length) throw new Error("At least one coding client must be enabled");
  const codexEndpoint = env.CODEX_BEDROCK_ENDPOINT || "mantle";
  if (!["mantle", "runtime"].includes(codexEndpoint))
    throw new Error("CODEX_BEDROCK_ENDPOINT must be mantle or runtime");
  return { enabledClients, codexEndpoint };
}

export function selectClients(value, enabledClients) {
  if (value === undefined || value === "" || value === "all") return [...enabledClients];
  if (typeof value !== "string" || !enabledClients.includes(value))
    throw new ValidationError("invalid client", "select an enabled coding client");
  return [value];
}
