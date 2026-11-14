import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { DeviceTokenError, deviceInput, deviceOwner, deviceView, purgeFor, SECRET_HASH, TOKEN_LIFETIME_MS }
  from "./deviceTokens.js";

export const ENROLLMENT_LIFETIME_MS = 10 * 60000;
export const POLL_INTERVAL_SECONDS = 5;
const HANDLE = /^[a-f0-9]{32}$/;
const POLL_TOKEN = /^cce1\.([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/;
// Consonants only: codes cannot spell words, and no 0/O or 1/I confusion.
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
// Same character set the client configurator accepts for user.email.
const USER_ID = /^[A-Za-z0-9._+@-]{1,254}$/;
const digest = value => createHash("sha256").update(value).digest("hex");
const iso = value => new Date(value).toISOString();
const fail = (code, status) => new DeviceTokenError(code, status);

/** Telemetry user ID derived from the approving login, or null when it has no usable verified email. */
export function enrollmentUserId(principal) {
  return typeof principal?.email === "string" && USER_ID.test(principal.email) ? principal.email : null;
}

function confirmationCode() {
  let code = "";
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Browser device pairing informed by RFC 8628. The terminal holds the future device secret
 * and a polling credential; the browser only sees a lookup handle and the confirmation code.
 */
export function createEnrollmentService({ store, issuer, publicOrigin, now = Date.now, packageHashes = {} }) {
  if (!store || typeof issuer !== "string" || !issuer || typeof publicOrigin !== "string")
    throw new Error("Enrollment service requires a store, issuer and public origin");

  const handleOf = handle => {
    if (typeof handle !== "string" || !HANDLE.test(handle)) throw fail("enrollment_not_found", 404);
    return handle;
  };
  async function load(handle, options) {
    const record = await store.getEnrollment(handleOf(handle), options);
    if (!record || record.id !== handle) throw fail("enrollment_not_found", 404);
    return record;
  }
  const effectiveStatus = (record, at) => record.status === "pending" && record.deadline <= at ? "expired" : record.status;

  // Idempotent: approval and every later poll converge on the one device the approval named.
  async function ensureDevice(record, options) {
    const existing = await store.get(record.deviceOwner, record.deviceId, options);
    if (existing) return existing;
    const expiresAt = record.approvedAt + TOKEN_LIFETIME_MS;
    const device = { owner: record.deviceOwner, id: record.deviceId, name: record.name, platform: record.platform,
      secretHash: record.secretHash, createdAt: record.approvedAt, expiresAt, purgeAt: purgeFor(expiresAt) };
    await store.put(device, options);
    return device;
  }

  return {
    async start(input, options) {
      if (!input || typeof input !== "object" || typeof input.secretHash !== "string" || !SECRET_HASH.test(input.secretHash))
        throw fail("invalid_enrollment");
      const { name, platform } = deviceInput(input);
      const createdAt = now();
      const deadline = createdAt + ENROLLMENT_LIFETIME_MS;
      const handle = randomBytes(16).toString("hex");
      const pollSecret = randomBytes(32).toString("base64url");
      const code = confirmationCode();
      await store.putEnrollment({ id: handle, status: "pending", pollHash: digest(pollSecret),
        secretHash: input.secretHash, name, platform, code, createdAt, deadline,
        purgeAt: Math.floor((deadline + 86400000) / 1000) }, options);
      return { verificationUrl: `${publicOrigin}/collector/connect/${handle}`, code,
        pollToken: `cce1.${handle}.${pollSecret}`, interval: POLL_INTERVAL_SECONDS, expiresAt: iso(deadline) };
    },

    // Read-only: opening the page or returning from SSO never changes the request.
    async view(principal, handle, options) {
      const owner = deviceOwner(issuer, principal?.subject);
      const record = await load(handle, options);
      let status = effectiveStatus(record, now());
      if (status === "approved" && record.deviceOwner !== owner) status = "unavailable";
      return { name: record.name, platform: record.platform, code: record.code, status,
        createdAt: iso(record.createdAt), expiresAt: iso(record.deadline), userId: status === "approved" ? record.userId ?? null : enrollmentUserId(principal) };
    },

    async approve(principal, handle, options) {
      const owner = deviceOwner(issuer, principal?.subject);
      let record = await load(handle, options);
      if (record.status === "pending") {
        const at = now();
        if (record.deadline <= at) throw fail("enrollment_expired", 410);
        const userId = enrollmentUserId(principal);
        const decided = await store.decideEnrollment(handle, { status: "approved", approvedAt: at, deviceOwner: owner,
          deviceId: randomBytes(16).toString("hex"), ...(userId ? { userId } : {}) }, at, options);
        // A lost race or a deadline crossing is resolved from the stored outcome.
        record = await load(handle, options);
        if (!decided && record.status === "pending") throw fail("enrollment_expired", 410);
      }
      if (record.status === "denied") throw fail("enrollment_denied", 409);
      if (record.status !== "approved" || record.deviceOwner !== owner) throw fail("enrollment_unavailable", 409);
      const device = await ensureDevice(record, options);
      return { status: "approved", device: deviceView(device), userId: record.userId ?? null };
    },

    async deny(principal, handle, options) {
      deviceOwner(issuer, principal?.subject);
      const at = now();
      if (await store.decideEnrollment(handleOf(handle), { status: "denied", deniedAt: at }, at, options))
        return { status: "denied" };
      const record = await load(handle, options);
      if (record.status === "denied") return { status: "denied" };
      if (effectiveStatus(record, at) === "expired") throw fail("enrollment_expired", 410);
      throw fail("enrollment_unavailable", 409);
    },

    async poll(token, options) {
      const match = typeof token === "string" && POLL_TOKEN.exec(token);
      if (!match || Buffer.from(match[2], "base64url").toString("base64url") !== match[2])
        throw fail("invalid_enrollment", 401);
      const record = await store.getEnrollment(match[1], options);
      if (!record || record.id !== match[1] || typeof record.pollHash !== "string" || !SECRET_HASH.test(record.pollHash)
        || !timingSafeEqual(Buffer.from(record.pollHash, "hex"), Buffer.from(digest(match[2]), "hex")))
        throw fail("invalid_enrollment", 401);
      // The absolute deadline also ends delivery of an approved result.
      if (record.deadline <= now()) throw fail("enrollment_expired", 410);
      if (record.status === "pending") return { status: "pending", interval: POLL_INTERVAL_SECONDS };
      if (record.status === "denied") throw fail("enrollment_denied", 403);
      if (record.status !== "approved") throw fail("enrollment_unavailable", 409);
      const device = await ensureDevice(record, options);
      if (device.revokedAt !== undefined || !(device.expiresAt > now())) throw fail("device_revoked", 410);
      return { status: "approved", owner: record.deviceOwner, id: record.deviceId, userId: record.userId ?? null,
        expiresAt: iso(device.expiresAt), packageSha256: packageHashes[record.platform] ?? null };
    },
  };
}
