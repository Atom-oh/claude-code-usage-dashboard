import { basisLabel, costBasisLabel, observedNumber } from "./clientPresentation.js";
import { observedTokens } from "./clientUsage.js";

// Sum known pieces, retaining unknown and partial coverage rather than substituting zero.
function knownSum(rows, read, partial = () => false) {
  const values = rows.map(row => observedNumber(read(row)));
  const known = values.filter(value => value !== null);
  const total = known.length ? observedNumber(known.reduce((sum, value) => sum + value, 0)) : null;
  return { total, partial: rows.some(partial) || values.includes(null) || total === null };
}

export function projectedCost(cost, range) {
  const amount = observedNumber(cost);
  const duration = Date.parse(range?.to) - Date.parse(range?.from);
  return amount === null || !Number.isFinite(duration) || duration <= 0
    ? null : observedNumber(amount * (30 * 86400000 / duration));
}

export function combineCostUsers(userRows, modelRows, clients) {
  const groups = new Map();
  const identity = row => JSON.stringify(row.user ? [row.user] : [row.client, ""]);
  for (const row of userRows || []) {
    if (!clients.includes(row.client)) continue;
    const key = identity(row);
    const group = groups.get(key) || { user: row.user || "", parts: [], models: {} };
    group.parts.push(row);
    groups.set(key, group);
  }
  for (const row of modelRows || []) {
    if (!clients.includes(row.client)) continue;
    const group = groups.get(identity(row));
    if (group) (group.models[row.client] ||= []).push(row);
  }
  return [...groups.values()].map(({ user, parts, models }) => {
    const cost = knownSum(parts, row => row.cost_usd, row => row.cost_partial === true || row.unpriced > 0);
    const tokens = knownSum(parts, observedTokens, row => row.tokens_partial === true);
    if (tokens.total !== null && !Number.isSafeInteger(tokens.total)) {
      tokens.total = null;
      tokens.partial = true;
    }
    const sessions = parts.map(row => observedNumber(row.sessions));
    const bases = [...new Set(parts.map(row => basisLabel(row.cost_basis)))].join(" + ");
    const row = { user, parts, models, cost_usd: cost.total, cost_partial: cost.partial,
      observed_tokens: tokens.total, tokens_partial: tokens.partial,
      sessions: sessions.includes(null) ? null : observedNumber(sessions.reduce((sum, value) => sum + value, 0)),
      unpriced: parts.reduce((sum, part) => sum + (observedNumber(part.unpriced) || 0), 0),
      cost_estimated: parts.reduce((sum, part) => sum + (observedNumber(part.cost_estimated) || 0), 0),
    };
    for (const client of ["claude", "codex"]) {
      const pieces = parts.filter(part => part.client === client);
      const amount = knownSum(pieces, part => part.cost_usd,
        part => part.cost_partial === true || part.unpriced > 0);
      row[`${client}_cost`] = amount.total;
      row[`${client}_cost_status`] = !pieces.length ? "관측 없음" : amount.total === null
        ? "미산정" : amount.partial ? "부분합" : "확인됨";
    }
    row.cost_basis_label = costBasisLabel(row, bases);
    return row;
  }).sort((a, b) => (b.cost_usd ?? -1) - (a.cost_usd ?? -1)
    || String(a.user).localeCompare(String(b.user)));
}

// Channel lines for the shared user cost table, mirroring the Claude detail
// per-group model bars. CCB/C4E are the inferred Claude session channels
// (`channel`: bedrock/enterprise); older responses without it fall back to the
// shared backend (enterprise → "anthropic", a `bedrock-*` route → CCB); Codex is
// the emitting client. Never infer a client from a model.
export const USER_COST_CHANNELS = [
  { key: "ccb", label: "CCB", title: "Claude Code · Bedrock 채널", color: "var(--series-bedrock)" },
  { key: "c4e", label: "C4E", title: "Claude Code · Enterprise(Anthropic) 채널", color: "var(--series-enterprise)" },
  { key: "claude_unknown", label: "미분류", title: "Claude Code · 채널 미분류", color: "var(--series-unknown)" },
  { key: "codex", label: "Codex", title: "Codex", color: "var(--chart-3)" },
];

export function userCostChannel(row) {
  if (row.client === "codex") return "codex";
  if (row.client !== "claude") return null;
  if (row.channel !== undefined && row.channel !== null && row.channel !== "")
    return row.channel === "bedrock" ? "ccb" : row.channel === "enterprise" ? "c4e" : "claude_unknown";
  if (row.backend === "anthropic") return "c4e";
  return /^bedrock-/.test(row.backend || "") ? "ccb" : "claude_unknown";
}

// One line per observed channel. Segments are known positive model costs; a
// channel whose costs are all unknown stays visible as unavailable (total null),
// and a measured zero keeps total 0, so neither is mistaken for the other.
export function userChannelLines(modelsByClient, order = (a, b) => String(a).localeCompare(String(b))) {
  const byChannel = new Map();
  for (const row of Object.values(modelsByClient || {}).flat()) {
    const channel = userCostChannel(row);
    if (!channel) continue;
    const models = byChannel.get(channel) || new Map();
    const model = row.model || "(미지정)";
    const entry = models.get(model) || { model, values: [], partial: false };
    entry.values.push(observedNumber(row.cost_usd));
    entry.partial ||= row.cost_partial === true || observedNumber(row.unpriced) > 0;
    models.set(model, entry);
    byChannel.set(channel, models);
  }
  return USER_COST_CHANNELS.filter(({ key }) => byChannel.has(key)).map((channel) => {
    const entries = [...byChannel.get(channel.key).values()];
    const segs = entries.map(({ model, values }) => {
      const known = values.filter((value) => value !== null);
      return { model, value: known.length ? observedNumber(known.reduce((sum, value) => sum + value, 0)) : null };
    });
    const known = segs.filter((seg) => seg.value !== null);
    const total = known.length ? observedNumber(known.reduce((sum, seg) => sum + seg.value, 0)) : null;
    return { ...channel, total,
      partial: total !== null && (entries.some((entry) => entry.partial) || known.length < segs.length),
      segs: known.filter((seg) => seg.value > 0).sort((a, b) => order(a.model, b.model)) };
  });
}
