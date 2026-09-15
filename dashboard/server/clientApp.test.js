import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const script = `
import http from 'node:http';
let dataQueries = 0;
const db = http.createServer(async(req,res)=>{
  let sql=''; for await(const x of req)sql+=x;
  res.setHeader('Content-Type','application/json');
  if (sql.includes("getSetting('readonly')")) return res.end('{"ro":1}\\n');
  if (sql.includes('latest_ms')) return res.end(JSON.stringify({latest_ms:Date.now()})+'\\n');
  const base={t:'2026-09-14T10:00:00Z',session:'one',user:'fixture@example.invalid',model:'openai.gpt-6-astra',
    backend:'bedrock-mantle',kind:'usage',context_tier:'short',count:1,input_tokens_total:100,
    cache_read_tokens:40,cache_write_tokens:11,output_tokens:30,reasoning_tokens:10,invalid:0};
  let rows=[];
  if(sql.includes('unique_events')) {
    dataQueries++;
    if(sql.includes("EventName IN ('codex.sse_event'")) rows=[base];
  } else if(sql.includes('coding-client:claude-usage')) {
    dataQueries++;
    rows=[{...base,model:'claude-sonnet-5',backend:'anthropic',input_tokens:49,reported_cost:2}];
  }
  res.end(rows.length?rows.map(x=>JSON.stringify(x)).join('\\n')+'\\n':'');
});
await new Promise(r=>db.listen(0,'127.0.0.1',r));
process.env.CH_URL='http://127.0.0.1:'+db.address().port;
process.env.BASIC_AUTH_USER='fixture';process.env.BASIC_AUTH_PASSWORD='fixture-pass';
delete process.env.AUTH_ALLOW_INSECURE;delete process.env.ALERT_WEBHOOK_URL;
const {app}=await import('./index.js');
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const base='http://127.0.0.1:'+server.address().port;
const headers={authorization:'Basic '+Buffer.from('fixture:fixture-pass').toString('base64')};
const requests=JSON.parse(process.env.CLIENT_REQUESTS);
const results=[];
for(const path of requests) {
  const before=dataQueries;
  const r=await fetch(base+path,{headers:path.includes('unauth=1')?{}:headers});
  const text=await r.text();let body;try{body=JSON.parse(text)}catch{body=text}
  results.push({status:r.status,body,cache:r.headers.get('cache-control'),dataQueries:dataQueries-before});
}
console.log(JSON.stringify(results));
server.closeAllConnections();server.close();db.closeAllConnections();db.close();
process.exit(0);
`;
const range = "from=2026-09-14T00:00:00Z&to=2026-09-15T00:00:00Z";
async function scenario(claude, codex, paths) {
  const { stdout, stderr } = await run(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL(".", import.meta.url),
    env: { ...process.env, CLAUDE_ENABLED: String(claude), CODEX_ENABLED: String(codex),
      CODEX_PRICING_JSON: "", CLIENT_REQUESTS: JSON.stringify(paths) },
    timeout: 15000,
  });
  const out = JSON.parse(stdout.trim().split("\n").at(-1));
  if(out.some(r => r.status === 500)) console.error(stderr);
  return out;
}

test("Codex-only deployment gates legacy routes and preserves authenticated client data", async () => {
  const rows = await scenario(false, true, [
    "/api/config", `/api/clients/overview?${range}&unauth=1`,
    `/api/cost/summary?${range}`, `/api/clients/overview?${range}`,
    `/api/clients/overview?${range}&client=claude`,
    `/api/clients/overview?${range}&group=enterprise`, "/api/health/data",
  ]);
  assert.deepEqual(rows[0].body.enabledClients, ["codex"]);
  assert.equal(rows[1].status, 401);
  assert.equal(rows[2].status, 404);
  assert.equal(rows[2].dataQueries, 0);
  assert.equal(rows[3].status, 200);
  assert.equal(rows[3].cache, "no-store");
  assert.deepEqual(rows[3].body.clients, ["codex"]);
  assert.equal(rows[3].body.totals.cost_usd, 0.00238425);
  assert.equal(rows[4].status, 400);
  assert.equal(rows[4].dataQueries, 0);
  assert.equal(rows[5].status, 400);
  assert.equal(rows[5].dataQueries, 0);
  assert.equal(rows[6].status, 200);
});

test("client cache identity never reuses a different client's result", async () => {
  const rows = await scenario(true, true, [
    `/api/clients/overview?${range}&client=codex`,
    `/api/clients/overview?${range}&client=claude`,
    `/api/clients/overview?${range}&client=all`,
    `/api/clients/overview?${range}&client=codex`,
  ]);
  for (const row of rows) assert.equal(row.status, 200);
  assert.deepEqual(rows.map((x) => x.body.clients), [["codex"], ["claude"], ["claude", "codex"], ["codex"]]);
  assert.equal(rows[1].body.totals.cost_usd, 2);
  assert.equal(rows[2].body.totals.cost_usd, 2.00238425);
  assert.equal(rows[3].dataQueries, 0);
});

test("Claude-only defaults expose only that client through the new contract", async () => {
  const rows = await scenario(true, false, ["/api/config", `/api/clients/overview?${range}`]);
  assert.deepEqual(rows[0].body.enabledClients, ["claude"]);
  assert.deepEqual(rows[1].body.clients, ["claude"]);
  assert.equal(rows[1].body.totals.cost_usd, 2);
});

test("client defaults and the warmer's interval share the common-view cache key", async () => {
  for (const claude of [false, true]) {
    const rows = await scenario(claude, true, [
      `/api/clients/overview?${range}&intervalHours=1`,
      `/api/clients/overview?${range}&client=${claude ? "all" : "codex"}`,
      `/api/clients/overview?${range}&client=all&backend=all`,
    ]);
    assert.equal(rows[0].status, 200);
    assert.equal(rows[1].status, 200);
    assert.equal(rows[1].dataQueries, 0);
    assert.equal(rows[2].dataQueries, 0);
  }
});

test("Codex insights enforce auth, client flags and backend-isolated cache entries", async () => {
  const path = `/api/codex/insights?${range}`;
  const disabled = await scenario(true, false, [path]);
  assert.equal(disabled[0].status, 404);
  assert.equal(disabled[0].dataQueries, 0);
  const rows = await scenario(true, true, [
    `${path}&unauth=1`, `${path}&client=claude`, `${path}&group=enterprise`,
    `${path}&backend=bedrock-mantle`, `${path}&backend=bedrock-runtime`,
    `${path}&backend=bedrock-mantle`,
  ]);
  assert.deepEqual(rows.map((r) => r.status), [401, 400, 400, 200, 200, 200]);
  assert.equal(rows[3].cache, "no-store");
  assert(rows[3].body.coverage.logs);
  assert.equal(rows[3].dataQueries, 1);
  assert.equal(rows[4].dataQueries, 1);
  assert.equal(rows[5].dataQueries, 0);
});
