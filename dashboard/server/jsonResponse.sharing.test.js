import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { gzipSync, gunzipSync } from "node:zlib";
import { createJsonResponder } from "./jsonResponse.js";

const value = { rows: Array.from({ length: 500 }, (_, i) =>
  ({ user: i, cost: null, known: 0, tiny: 0.000001, partial: true, label: "<관측>&" })) };
const app = () => {
  const settings = new Map([["json escape", true]]);
  return { get: key => settings.get(key), set: (key, setting) => settings.set(key, setting) };
};
const json = (application, input) => {
  let body = JSON.stringify(input, application.get("json replacer"), application.get("json spaces"));
  if (application.get("json escape") && body)
    body = body.replace(/[<>&]/g, c => ({ "<": "\\u003c", ">": "\\u003e", "&": "\\u0026" })[c]);
  return body;
};
class Response extends EventEmitter {
  headers = {};
  destroyed = false;
  writableEnded = false;
  jsonCalls = 0;
  constructor(application) { super(); this.app = application; }
  vary(value) { this.headers.vary = value; return this; }
  get(key) { return this.headers[key.toLowerCase()]; }
  set(key, value) {
    if (typeof key === "object") for (const [k, v] of Object.entries(key)) this.set(k, v);
    else this.headers[key.toLowerCase()] = value;
    return this;
  }
  send(body) { assert.equal(this.destroyed, false); this.body = body; return this; }
  json(input) { this.jsonCalls++; this.body = json(this.app, input); return this; }
  finish() { this.writableEnded = true; this.emit("finish"); this.emit("close"); }
  close() { this.destroyed = true; this.emit("close"); }
}
const request = (application, gzip = false) =>
  ({ app: application, acceptsEncodings: () => gzip ? "gzip" : false });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

test("140 active identity responses share exact bytes and release them after the last response", async () => {
  const application = app(), send = createJsonResponder();
  const responses = Array.from({ length: 140 }, () => new Response(application));
  await Promise.all(responses.map(res => send(request(application), res, value)));
  const expected = Buffer.from(json(application, value));
  assert.deepEqual(responses[0].body, expected);
  assert.deepEqual(JSON.parse(expected), value);
  for (const res of responses) {
    assert.equal(res.body, responses[0].body);
    assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(res.headers.vary, "Accept-Encoding");
    assert.equal(res.listenerCount("finish"), 1);
    res.finish();
    assert.equal(res.listenerCount("finish"), 0);
    assert.equal(res.listenerCount("close"), 0);
  }
  const next = new Response(application);
  await send(request(application), next, value);
  assert.notEqual(next.body, responses[0].body);
  assert.deepEqual(next.body, expected);
  next.finish();
});

test("140 gzip consumers share one compression while disconnected consumers cannot send", async () => {
  const application = app(), boundary = deferred();
  let calls = 0;
  const send = createJsonResponder({ compressor: async bytes => {
    calls++; await boundary.promise; return gzipSync(bytes);
  } });
  const responses = Array.from({ length: 140 }, () => new Response(application));
  const pending = responses.map(res => send(request(application, true), res, value));
  await tick();
  assert.equal(calls, 1);
  for (const res of responses.slice(0, 40)) res.close();
  boundary.resolve();
  await Promise.all(pending);
  for (const res of responses.slice(0, 40)) assert.equal(res.body, undefined);
  const active = responses.slice(40);
  for (const res of active) {
    assert.equal(res.body, active[0].body);
    assert.equal(res.headers["content-encoding"], "gzip");
    assert.deepEqual(gunzipSync(res.body), Buffer.from(json(application, value)));
    res.finish();
  }
});

test("abandoned gzip work remains shared until settlement and is never a settled encoding cache", async () => {
  const application = app(), boundary = deferred();
  let calls = 0;
  const send = createJsonResponder({ compressor: async bytes => {
    calls++; await boundary.promise; return gzipSync(bytes);
  } });
  const first = new Response(application);
  const pending = send(request(application, true), first, value);
  await tick();
  first.close();
  const second = new Response(application);
  const shared = send(request(application, true), second, value);
  await tick();
  assert.equal(calls, 1);
  boundary.resolve();
  await Promise.all([pending, shared]);
  second.finish();
  const third = new Response(application);
  await send(request(application, true), third, value);
  assert.equal(calls, 2);
  third.finish();
});

test("different applications and changed JSON policies cannot share the wrong bytes", async () => {
  const firstApp = app(), secondApp = app(), send = createJsonResponder();
  secondApp.set("json escape", false);
  secondApp.set("json spaces", 2);
  const first = new Response(firstApp), second = new Response(secondApp);
  await send(request(firstApp), first, value);
  await send(request(secondApp), second, value);
  assert.deepEqual(first.body, Buffer.from(json(firstApp, value)));
  assert.deepEqual(second.body, Buffer.from(json(secondApp, value)));
  assert.notDeepEqual(first.body, second.body);
  const before = first.body;
  firstApp.set("json escape", false);
  const changed = new Response(firstApp);
  await send(request(firstApp), changed, value);
  assert.notEqual(changed.body, before);
  assert.equal(before.includes("<"), false);
  assert.equal(changed.body.includes("<"), true);
  first.finish(); second.finish(); changed.finish();
});

test("stateful replacers and custom identity content types retain Express's original path", async () => {
  const application = app(), send = createJsonResponder();
  let sequence = 0;
  application.set("json replacer", (key, field) => key === "tiny" ? ++sequence : field);
  const first = new Response(application), second = new Response(application);
  await send(request(application), first, value);
  await send(request(application), second, value);
  assert.equal(first.jsonCalls, 1);
  assert.equal(second.jsonCalls, 1);
  assert.notEqual(JSON.parse(first.body).rows[0].tiny, JSON.parse(second.body).rows[0].tiny);
  const keys = ["rows", "tiny"];
  application.set("json replacer", keys);
  const before = new Response(application), after = new Response(application);
  await send(request(application), before, value);
  keys[1] = "known";
  await send(request(application), after, value);
  assert.deepEqual(JSON.parse(before.body).rows[0], { tiny: 0.000001 });
  assert.deepEqual(JSON.parse(after.body).rows[0], { known: 0 });
  application.set("json replacer", undefined);
  const custom = new Response(application).set("Content-Type", "application/json; profile=fixture");
  await send(request(application), custom, value);
  assert.equal(custom.jsonCalls, 1);
  assert.equal(custom.get("Content-Type"), "application/json; profile=fixture");
});

test("compression errors release every borrower and a later request can recover", async () => {
  const application = app(), original = new Error("synthetic compression failure");
  let calls = 0;
  const send = createJsonResponder({ compressor: bytes => {
    if (++calls === 1) throw original;
    return gzipSync(bytes);
  } });
  const responses = Array.from({ length: 140 }, () => new Response(application));
  const results = await Promise.allSettled(responses.map(res => send(request(application, true), res, value)));
  assert.equal(calls, 1);
  for (const [i, result] of results.entries()) {
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, original);
    assert.equal(responses[i].listenerCount("finish"), 0);
    assert.equal(responses[i].listenerCount("close"), 0);
  }
  const recovered = new Response(application);
  await send(request(application, true), recovered, value);
  assert.equal(calls, 2);
  assert.deepEqual(JSON.parse(gunzipSync(recovered.body)), value);
  recovered.finish();
});
