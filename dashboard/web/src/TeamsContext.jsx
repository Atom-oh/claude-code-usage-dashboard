import { translate, translateSource, useLocale } from "./i18n/index.js";
import { createContext, useContext, useMemo } from "react";
import { useApi } from "./useApi.js";

// Range-only team lookups (GET /api/teams, /api/users/teams) shared by the filter control and every
// user-level view. Filters never change them, so they are requested unfiltered. Team is client-provided
// attribution, not verified identity. byUser is null while unavailable (loading or failed), which is
// shown differently from a user without a team.
// Exported so tests can supply a fixed lookup without the fetching provider.
export const TeamsContext = createContext(null);
const UNAVAILABLE = { options: [], byUser: null, loading: false, labels: {}, sources: {}, userSources: new Map(),
  historyStart: null, directory: false };

// Appended to a team shown outside CSV when its value came only from the device (OTel), not the directory,
// and only while directory teams are applied. Source message; render through translateSource.
export const DEVICE_TEAM_MARKER = "(기기 제공 값)";

// Tooltip wherever the marker can appear: unmarked teams come from the directory, marked ones from the device.
export const teamSourceHelp = () => translate("m38089c0f4351", [translateSource(DEVICE_TEAM_MARKER)]);

// A roster still showing the previous period (useApi stale) or loading is unavailable for the current
// one: a user missing from it is not known to have no team, and its labels must not reach a new
// range's table or CSV.
export function teamsValue(list, users) {
  const pending = users.loading || users.stale;
  return {
    options: Array.isArray(list.data?.teams) ? list.data.teams : [],
    byUser: !pending && Array.isArray(users.data?.users)
      ? new Map(users.data.users.map((row) => [row.user, row.teams])) : null,
    loading: pending,
    // Absent on an older server: no labels, no source information, no history boundary.
    labels: list.data?.labels && typeof list.data.labels === "object" ? list.data.labels : {},
    sources: list.data?.sources && typeof list.data.sources === "object" ? list.data.sources : {},
    // user -> sources[], parallel to byUser's teams[] for the same user.
    userSources: !pending && Array.isArray(users.data?.users)
      ? new Map(users.data.users.map((row) => [row.user, Array.isArray(row.sources) ? row.sources : []])) : new Map(),
    historyStart: Number.isFinite(list.data?.historyStart) ? list.data.historyStart : null,
    // Without directory teams every team is device-provided, so nothing is marked (pre-directory display).
    directory: list.data?.directory === true,
  };
}

// Label when one exists, else the raw value. Raw values stay the filter/URL identity.
export const teamName = (teams, raw) => teams.labels?.[raw] || raw;

// Only a device-only source is marked, and only while directory teams apply; "directory" and "both" render alike.
export const isDeviceMarked = (teams, source) => teams.directory === true && source === "device";
export const teamDisplay = (teams, raw, source) => isDeviceMarked(teams, source)
  ? `${teamName(teams, raw)} ${translateSource(DEVICE_TEAM_MARKER)}` : teamName(teams, raw);

export function TeamsProvider({ children }) {
  const _locale = useLocale();
  const list = useApi("/api/teams", {}, true, { unfiltered: true });
  const users = useApi("/api/users/teams", {}, true, { unfiltered: true });
  const value = useMemo(() => teamsValue(list, users),
    [list.data, users.data, users.loading, users.stale]);
  return <TeamsContext.Provider value={value}>{children}</TeamsContext.Provider>;
}

export function useTeams() {
  const _locale = useLocale();
  return useContext(TeamsContext) || UNAVAILABLE;
}

// undefined: unavailable · []: no team observed · [primary, ...others]: most recent first.
const teamsOf = (teams, user) => (teams.byUser ? teams.byUser.get(user) || [] : undefined);

export function teamText(teams, user, { csv = false } = {}) {
  const list = teamsOf(teams, user);
  if (!list) return teams.loading && !csv ? "…" : translate("m298859a04696");
  if (!list.length) return csv ? "" : "—";
  const sources = teams.userSources?.get(user) || [];
  return list.map((raw, i) => csv ? teamName(teams, raw) : teamDisplay(teams, raw, sources[i])).join(", ");
}

// Chart labels carry a suffix only for a known team; unavailable and none add nothing.
export function teamSuffix(teams, user) {
  const list = teamsOf(teams, user);
  if (!list?.length) return "";
  const sources = teams.userSources?.get(user) || [];
  return ` · ${list.map((raw, i) => teamDisplay(teams, raw, sources[i])).join(", ")}`;
}

// Team column right after the user column; rows gain a sortable primary `team` value.
export function withTeamColumn(columns, teams) {
  const index = columns.findIndex((column) => column.key === "user");
  if (index < 0) return columns;
  const marked = (user) => (teams.userSources?.get(user) || []).some((source) => isDeviceMarked(teams, source));
  const column = { key: "team", label: translate("m321639b7ad86"), render: (_value, row) => marked(row.user)
    ? <span title={teamSourceHelp()}>{teamText(teams, row.user)}</span> : teamText(teams, row.user),
    toText: (_value, row) => teamText(teams, row.user, { csv: true }) };
  return [...columns.slice(0, index + 1), column, ...columns.slice(index + 1)];
}

export function withTeams(rows, teams) {
  return (rows || []).map((row) => ({ ...row, team: teamsOf(teams, row.user)?.[0] ?? null }));
}
