import { gzip } from "node:zlib";
import { promisify } from "node:util";

const compress = promisify(gzip);
const escapes = { "<": "\\u003c", ">": "\\u003e", "&": "\\u0026" };

// Data-route JSON only: streaming chat and health responses keep their own
// response handling. Compression does not change authentication or cache policy.
export async function sendJson(req, res, value) {
  res.vary("Accept-Encoding");
  if (!req.acceptsEncodings("gzip")) return res.json(value);
  let body = JSON.stringify(value, req.app.get("json replacer"), req.app.get("json spaces"));
  if (body === undefined || Buffer.byteLength(body) < 4096) return res.json(value);
  if (req.app.get("json escape")) body = body.replace(/[<>&]/g, character => escapes[character]);
  const compressed = await compress(body, { level: 4 });
  if (res.destroyed) return;
  return res.type("json").set("Content-Encoding", "gzip").send(compressed);
}
