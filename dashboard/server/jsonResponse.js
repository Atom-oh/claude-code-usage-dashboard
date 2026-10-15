import { gzip } from "node:zlib";
import { promisify } from "node:util";

const compress = promisify(gzip);
const escapes = { "<": "\\u003c", ">": "\\u003e", "&": "\\u0026" };

// Cached route values are immutable. Share their representations only while a
// response/compression is active; keep no settled encoding cache or source copy.
export function createJsonResponder({ compressor = compress } = {}) {
  const applications = new WeakMap();
  function borrow(app, value) {
    const replacer = app.get("json replacer"), spaces = app.get("json spaces");
    const escape = app.get("json escape");
    // Custom replacers/boxed spacing can be stateful. Preserve their per-response evaluation.
    if (!value || typeof value !== "object" || replacer != null
        || spaces != null && !["string", "number"].includes(typeof spaces)) return null;
    let policy = applications.get(app);
    if (!policy || policy.replacer !== replacer || policy.spaces !== spaces || policy.escape !== escape) {
      policy = { replacer, spaces, escape, values: new WeakMap() };
      applications.set(app, policy);
    }
    let entry = policy.values.get(value);
    if (!entry) {
      let body = JSON.stringify(value, replacer, spaces);
      if (body === undefined || Buffer.byteLength(body) < 4096) return null;
      if (escape) body = body.replace(/[<>&]/g, character => escapes[character]);
      entry = { body: Buffer.from(body), active: 0, compressing: false, gzip: null };
      policy.values.set(value, entry);
    }
    const forget = () => {
      if (entry.active === 0 && !entry.compressing && policy.values.get(value) === entry)
        policy.values.delete(value);
    };
    entry.active++;
    let released = false;
    return {
      body: entry.body,
      gzip() {
        if (!entry.gzip) {
          entry.compressing = true;
          entry.gzip = Promise.resolve().then(() => compressor(entry.body, { level: 4 }))
            .finally(() => { entry.compressing = false; forget(); });
        }
        return entry.gzip;
      },
      release() {
        if (!released) { released = true; entry.active--; forget(); }
      },
    };
  }
  return async function sendJson(req, res, value) {
    res.vary("Accept-Encoding");
    if (res.destroyed || res.writableEnded) return;
    const encoding = req.acceptsEncodings("gzip");
    const type = res.get("Content-Type");
    if (!encoding && type && !/^application\/json(?:;\s*charset=utf-8)?$/i.test(type))
      return res.json(value);
    const representation = borrow(req.app, value);
    if (!representation) {
      if (!encoding) return res.json(value);
      let body = JSON.stringify(value, req.app.get("json replacer"), req.app.get("json spaces"));
      if (body === undefined || Buffer.byteLength(body) < 4096) return res.json(value);
      if (req.app.get("json escape")) body = body.replace(/[<>&]/g, character => escapes[character]);
      const compressed = await compressor(body, { level: 4 });
      if (res.destroyed) return;
      return res.set({ "Content-Type": "application/json; charset=utf-8", "Content-Encoding": "gzip" }).send(compressed);
    }
    const finish = () => {
      representation.release();
      res.removeListener("finish", finish);
      res.removeListener("close", finish);
    };
    res.once("finish", finish);
    res.once("close", finish);
    try {
      if (encoding) {
        const compressed = await representation.gzip();
        if (res.destroyed || res.writableEnded) { finish(); return; }
        return res.set({ "Content-Type": "application/json; charset=utf-8", "Content-Encoding": "gzip" }).send(compressed);
      }
      return res.set("Content-Type", "application/json; charset=utf-8").send(representation.body);
    } catch (error) {
      finish();
      throw error;
    }
  };
}

// Data routes only; auth/cache/status and streaming responses keep their owners.
export const sendJson = createJsonResponder();
