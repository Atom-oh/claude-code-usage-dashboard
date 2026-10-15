// Execute the product's actual GET retry policy inside the owned private fixture network.
import { fetchWithCapacityRetry } from "/capacity-api.mjs";
import { performance } from "node:perf_hooks";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const data = JSON.parse(input);
if (!/^[a-f0-9]{12}$/.test(data.runId) || !Array.isArray(data.paths) ||
  data.paths.length < 1 || data.paths.length > 140 ||
  !data.paths.every(path => path.startsWith("/api/clients/overview?")))
  throw new Error("invalid owned fixture workload");
const base = `http://proxy-${data.runId}:8080`;
let release;
const ready = new Promise(resolve => { release = resolve; });
const jobs = data.paths.map(async path => {
  await ready;
  const started = performance.now(), attempts = [];
  try {
    const response = await fetchWithCapacityRetry(base + path, {
      headers: { Authorization: data.authorization }, signal: AbortSignal.timeout(75_000),
    }, { request: async (url, options) => {
      const response = await fetch(url, options);
      attempts.push(response.status);
      return response;
    } });
    return { status: response.status, body: await response.json(),
      elapsedMs: performance.now() - started, attempts,
      retryAfter: response.headers.get("Retry-After") };
  } catch (error) {
    return { status: "transport_error", elapsedMs: performance.now() - started,
      attempts, errorType: error.name };
  }
});
release();
process.stdout.write(JSON.stringify(await Promise.all(jobs)) + "\n");
