import { createClient } from "@clickhouse/client";

// ponytail: single shared client, no pool wrapper — @clickhouse/client already pools HTTP keep-alive connections.
const client = createClient({
  url: process.env.CH_URL || `http://${process.env.CH_HOST || "localhost"}:${process.env.CH_PORT || "8123"}`,
  database: process.env.CH_DB || "claude_code",
  username: process.env.CH_USER || "default",
  password: process.env.CH_PASSWORD || "",
  request_timeout: 15000,
});

export function toChDateTime(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export async function query(sql, query_params = {}) {
  const rs = await client.query({ query: sql, query_params, format: "JSONEachRow" });
  return rs.json();
}

export async function ping() {
  const r = await client.ping();
  return r.success;
}
