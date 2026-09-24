import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import express from "express";
import { sendJson } from "./jsonResponse.js";

test("large JSON negotiates gzip without changing nulls, escaping, status, or private cache policy", async t => {
  const app = express();
  app.set("json escape", true);
  const value = { rows: Array.from({ length: 500 }, (_, i) =>
    ({ tokens: i, cost: null, label: "<관측>&", partial: true })) };
  app.get("/data", async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("Vary", "Origin");
    res.status(202);
    await sendJson(req, res, value);
  });
  app.get("/small", (req, res) => sendJson(req, res, { value: null }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const get = (path, encoding, method = "GET") => new Promise((resolve, reject) => {
    http.request({ host: "127.0.0.1", port: server.address().port, path, method,
      headers: encoding === undefined ? {} : { "Accept-Encoding": encoding } }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks) }));
    }).on("error", reject).end();
  });
  const identity = await get("/data", "identity");
  const zipped = await get("/data", "gzip");
  assert.equal(zipped.status, 202);
  assert.equal(zipped.headers["cache-control"], "no-store");
  assert.equal(zipped.headers["content-encoding"], "gzip");
  assert.equal(zipped.headers.vary, "Origin, Accept-Encoding");
  assert.equal(zipped.headers["content-type"], identity.headers["content-type"]);
  assert.equal(Number(zipped.headers["content-length"]), zipped.body.length);
  assert(zipped.body.length < identity.body.length / 4);
  assert.deepEqual(gunzipSync(zipped.body), identity.body);
  assert.deepEqual(JSON.parse(gunzipSync(zipped.body)), value);
  assert(!identity.body.toString().includes("<"));
  for (const encoding of ["gzip;q=0, identity", "br", undefined]) {
    const response = await get("/data", encoding);
    assert.equal(response.headers["content-encoding"], undefined);
    assert.deepEqual(response.body, identity.body);
  }
  const small = await get("/small", "gzip");
  assert.equal(small.headers["content-encoding"], undefined);
  assert.equal(small.body.toString(), '{"value":null}');
  const head = await get("/data", "gzip", "HEAD");
  assert.equal(head.headers["content-encoding"], "gzip");
  assert.equal(Number(head.headers["content-length"]), zipped.body.length);
  assert.equal(head.body.length, 0);
});
