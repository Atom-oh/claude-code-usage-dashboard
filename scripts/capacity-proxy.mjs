// Private synthetic benchmark transport. No public listener or caller-selected targets.
import http from "node:http";

const targets = JSON.parse(process.env.CAPACITY_TARGETS || "null");
if (!targets || !["api", "database"].every(key =>
  Array.isArray(targets[key]) && targets[key].length > 0 &&
  targets[key].every(value => /^http:\/\/(?:app|ch)-[a-f0-9]+-[0-2]:(?:8080|8123)$/.test(value))))
  throw new Error("invalid private benchmark targets");

for (const [kind, port] of [["api", 8080], ["database", 8123]]) {
  let index = 0;
  http.createServer((request, response) => {
    if (!request.url?.startsWith("/") || request.url.startsWith("//")) {
      response.writeHead(400); response.end(); return;
    }
    const target = new URL(targets[kind][index++ % targets[kind].length]);
    const outgoing = http.request({
      hostname: target.hostname, port: target.port, path: request.url, method: request.method,
      headers: { ...request.headers, host: target.host }, timeout: 65_000,
    }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
    });
    outgoing.on("timeout", () => outgoing.destroy());
    outgoing.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    response.on("close", () => { if (!response.writableFinished) outgoing.destroy(); });
    request.pipe(outgoing);
  }).listen(port, "0.0.0.0");
}
