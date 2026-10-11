export const PERMISSION_SPAN_LIMIT = 20000;

function unionDuration(intervals) {
  let total = 0;
  let previousEnd = -Infinity;
  for (const [start, end] of intervals.sort((left, right) => left[0] - right[0])) {
    total += Math.max(0, end - Math.max(start, previousEnd));
    previousEnd = Math.max(previousEnd, end);
  }
  return total;
}

export function permissionOccupancy(rows, from, to) {
  if (rows.length > PERMISSION_SPAN_LIMIT) {
    return { unsupported: false, limited: true, rows: [] };
  }
  const groups = new Map();
  const traces = new Map();
  const unique = new Map();
  for (const row of rows) {
    if (!row.trace_id || !row.span_id) continue;
    const identity = JSON.stringify([row.trace_id, row.span_id]);
    const previous = unique.get(identity);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) {
      return { unsupported: false, limited: true, rows: [] };
    }
    unique.set(identity, row);
  }
  for (const row of unique.values()) {
    const start = Number(row.start_ms);
    const duration = Number(row.duration_ms);
    if (!row.trace_id || !row.span_id || !row.session_id || row.start_ms == null || row.duration_ms == null
      || !Number.isFinite(start) || !Number.isFinite(duration) || duration < 0) continue;
    const end = Math.min(start + duration, Number(to));
    if (start < Number(from) || start >= Number(to) || end < start) continue;
    const key = JSON.stringify([row.group, row.trace_id, row.session_id]);
    const trace = traces.get(key) || { interactions: [], waits: [] };
    if (row.span_type === "interaction" && end > start) {
      trace.interactions.push({ start, end, waits: [], ambiguous: false });
      const group = groups.get(row.group) || { group: row.group, interactions: 0,
        matched_interactions: 0, ambiguous_interactions: 0, interaction_ms: 0, blocked_ms: 0 };
      group.interactions += 1;
      groups.set(row.group, group);
    } else if (row.span_type === "tool.blocked_on_user") {
      trace.waits.push({ start, end });
    }
    traces.set(key, trace);
  }
  for (const [key, trace] of traces) {
    const group = groups.get(JSON.parse(key)[0]);
    if (!group) continue;
    for (const wait of trace.waits) {
      const candidates = trace.interactions.filter((interaction) =>
        wait.start < interaction.end && wait.end >= interaction.start
        && (wait.end > interaction.start || wait.start === wait.end));
      if (candidates.length === 1) {
        const interaction = candidates[0];
        interaction.waits.push([Math.max(wait.start, interaction.start), Math.min(wait.end, interaction.end)]);
      } else if (candidates.length > 1) {
        for (const interaction of candidates) interaction.ambiguous = true;
      }
    }
    for (const interaction of trace.interactions) {
      if (interaction.ambiguous) {
        group.ambiguous_interactions += 1;
      } else if (interaction.waits.length) {
        group.matched_interactions += 1;
        group.interaction_ms += interaction.end - interaction.start;
        group.blocked_ms += unionDuration(interaction.waits);
      }
    }
  }
  const result = [...groups.values()].sort((left, right) => left.group.localeCompare(right.group))
    .map((group) => ({
      ...group,
      blocked_ms: group.matched_interactions ? group.blocked_ms : null,
      interaction_ms: group.matched_interactions ? group.interaction_ms : null,
      blocked_share: group.interaction_ms > 0 ? group.blocked_ms / group.interaction_ms : null,
      coverage: group.matched_interactions / group.interactions,
    }));
  return { unsupported: result.length === 0, limited: false, rows: result };
}
