// 16x16 stroke icons for task trace lanes and tools (keys from taskTrace.js iconFor).
const PATHS = {
  main: "M2 3h12v10H2z M4 6l2 2-2 2 M8 10h4",
  "general-purpose": "M4 5h8v7H4z M8 2v3 M6 8h0.01 M10 8h0.01 M6 10.5h4 M2 8h2 M12 8h2",
  Explore: "M7 3a4 4 0 1 1 0 8a4 4 0 1 1 0-8 M10 10l4 4",
  fork: "M5 2v6 M11 2v2 M11 4c0 3-6 2-6 6v4",
  custom: "M8 2l2 4 4 .5-3 3 .8 4.5L8 12l-3.8 2 .8-4.5-3-3L6 6z",
  Bash: "M2 3h12v10H2z M4 7l2 1.5L4 10",
  Read: "M4 2h6l3 3v9H4z M10 2v3h3 M6 8h5 M6 10.5h5",
  Edit: "M3 13l1-3 7-7 2 2-7 7z M9.5 4.5l2 2",
  Write: "M4 2h6l3 3v9H4z M10 2v3h3 M8.5 7.5v5 M6 10h5",
  Grep: "M2 4h7 M2 7h5 M2 10h4 M11 8a2 2 0 1 1 0 4a2 2 0 1 1 0-4 M12.5 11.5L14 13",
  Glob: "M2 4h7 M2 7h5 M2 10h4 M11 8a2 2 0 1 1 0 4a2 2 0 1 1 0-4 M12.5 11.5L14 13",
  WebFetch: "M8 2a6 6 0 1 1 0 12a6 6 0 1 1 0-12 M2 8h12 M8 2c2.5 2 2.5 10 0 12 M8 2c-2.5 2-2.5 10 0 12",
  WebSearch: "M8 2a6 6 0 1 1 0 12a6 6 0 1 1 0-12 M2 8h12 M8 2c2.5 2 2.5 10 0 12 M8 2c-2.5 2-2.5 10 0 12",
  mcp: "M6 2v4 M10 2v4 M4 6h8v3a4 4 0 0 1-8 0z M8 13v2",
  wait: "M8 2a6 6 0 1 1 0 12a6 6 0 1 1 0-12 M8 5v3l2 2",
  tool: "M10.5 2.5a3 3 0 0 0-3.9 3.9L2.5 10.5l3 3 4.1-4.1a3 3 0 0 0 3.9-3.9l-2 2-2-2z",
};

const stroke = (color) => ({ fill: "none", stroke: color, strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" });

// Inside an SVG: a group at (x, y) scaled to `size`.
export function TaskIconMark({ icon, x = 0, y = 0, size = 16, color = "currentColor" }) {
  return <g transform={`translate(${x},${y}) scale(${size / 16})`} aria-hidden="true">
    <path d={PATHS[icon] || PATHS.tool} style={stroke(color)} />
  </g>;
}

// Standalone inline icon for HTML content.
export function TaskIcon({ icon, size = 16, color = "currentColor", className }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden="true">
    <path d={PATHS[icon] || PATHS.tool} style={stroke(color)} />
  </svg>;
}
