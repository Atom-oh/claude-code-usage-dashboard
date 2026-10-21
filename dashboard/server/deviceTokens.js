import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const TOKEN_LIFETIME_DAYS = 30;
const LIFETIME_MS = TOKEN_LIFETIME_DAYS * 86400000;
const TOKEN = /^ccd1\.([a-f0-9]{64})\.([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/;
const ID = /^[a-f0-9]{32}$/;
const digest = value => createHash("sha256").update(value).digest("hex");

export class DeviceTokenError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function deviceView(record) {
  const date = value => Number.isFinite(value) ? new Date(value).toISOString() : null;
  return { id: record.id, name: record.name, platform: record.platform,
    createdAt: date(record.createdAt), expiresAt: date(record.expiresAt),
    revokedAt: date(record.revokedAt), lastSeenAt: date(record.lastSeenAt) };
}

/** Store timestamps are milliseconds except DynamoDB TTL purgeAt (seconds). */
export function createDeviceTokenService({ store, issuer, now = Date.now }) {
  if (!store || typeof issuer !== "string" || !issuer)
    throw new Error("Device token service requires a store and issuer");
  const cache = new Map();
  const ownerFor = subject => {
    if (typeof subject !== "string" || !subject || subject.length > 1024)
      throw new DeviceTokenError("authentication_required", 401);
    return digest(issuer + "\0" + subject);
  };
  const cacheKey = (owner, id) => `${owner}:${id}`;

  return {
    async issue(subject, input, options) {
      const owner = ownerFor(subject);
      if (!input || typeof input.name !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(input.name)
        || !input.name.trim() || [...input.name.trim()].length > 64
        || !["linux", "darwin"].includes(input.platform))
        throw new DeviceTokenError("invalid_device");
      const createdAt = now();
      const secret = randomBytes(32).toString("base64url");
      const record = { owner, id: randomBytes(16).toString("hex"),
        name: input.name.trim(), platform: input.platform, secretHash: digest(secret),
        createdAt, expiresAt: createdAt + LIFETIME_MS,
        purgeAt: Math.floor((createdAt + LIFETIME_MS + 7 * 86400000) / 1000) };
      await store.put(record, options);
      return { device: deviceView(record), token: `ccd1.${owner}.${record.id}.${secret}` };
    },

    async list(subject, cursor, options) {
      const owner = ownerFor(subject);
      let key;
      if (cursor !== undefined && cursor !== null && cursor !== "") {
        try {
          if (typeof cursor !== "string" || cursor.length > 512 || !/^[\w-]+$/.test(cursor))
            throw new Error();
          key = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
          if (key.owner !== owner || !ID.test(key.id) || Object.keys(key).length !== 2)
            throw new Error();
        } catch { throw new DeviceTokenError("invalid_cursor"); }
      }
      const { items = [], lastKey } = await store.list(owner, key, options);
      if (items.length > 50 || items.some(item => item.owner !== owner)
        || (lastKey && (lastKey.owner !== owner || !ID.test(lastKey.id))))
        throw new DeviceTokenError("store_unavailable", 503);
      return { devices: items.map(deviceView),
        nextCursor: lastKey ? Buffer.from(JSON.stringify({ owner, id: lastKey.id })).toString("base64url") : null };
    },

    async revoke(subject, id, options) {
      const owner = ownerFor(subject);
      if (typeof id !== "string" || !ID.test(id)) throw new DeviceTokenError("device_not_found", 404);
      if (!await store.revoke(owner, id, now(), options)) throw new DeviceTokenError("device_not_found", 404);
      cache.delete(cacheKey(owner, id));
    },

    async verify(token, options) {
      if (typeof token !== "string") return null;
      const match = TOKEN.exec(token);
      if (!match) return null;
      const [, owner, id, secret] = match;
      if (Buffer.from(secret, "base64url").toString("base64url") !== secret) return null;
      const key = cacheKey(owner, id);
      let cached = cache.get(key);
      if (cached && cached.until <= now()) {
        cache.delete(key);
        cached = undefined;
      }
      const readStarted = now();
      const record = cached?.record || await store.get(owner, id, options);
      if (!record || record.owner !== owner || record.id !== id || record.revokedAt !== undefined
        || !Number.isFinite(record.expiresAt) || record.expiresAt <= now()
        || typeof record.secretHash !== "string" || !/^[a-f0-9]{64}$/.test(record.secretHash)) {
        cache.delete(key);
        return null;
      }
      if (!timingSafeEqual(Buffer.from(record.secretHash, "hex"), Buffer.from(digest(secret), "hex"))) return null;
      if (!cached) {
        if (cache.size >= 2048) cache.delete(cache.keys().next().value);
        cache.set(key, { record, until: Math.min(readStarted + 10000, record.expiresAt) });
      }
      // Internal identity only; callers never receive the stored secret hash.
      return { owner, id };
    },

    async touch(identity, options) {
      if (!identity || !/^[a-f0-9]{64}$/.test(identity.owner) || !ID.test(identity.id))
        throw new DeviceTokenError("invalid_token", 401);
      return store.touch(identity.owner, identity.id, now(), options);
    },
  };
}
