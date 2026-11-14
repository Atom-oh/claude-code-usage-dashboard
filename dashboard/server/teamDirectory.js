import { createHash } from "node:crypto";

const ISSUER = /^https:\/\/cognito-idp\.([a-z0-9-]+)\.amazonaws\.com\/([a-z0-9-]+_[A-Za-z0-9]+)\/?$/;
const ASCII_EMAIL = /^[\x21-\x7e]+$/;
const MAX_VALUE_LENGTH = 256;
const OPEN_END = 4102444800000; // 2100-01-01T00:00:00Z
const digest = value => createHash("sha256").update(value).digest("hex");

export const DERIVED_ATTRIBUTES = ["email_domain"];

export function parseCognitoIssuer(issuer) {
  const match = typeof issuer === "string" ? ISSUER.exec(issuer) : null;
  return match ? { region: match[1], poolId: match[2] } : null;
}

export function attributeValue(user, attribute) {
  let raw;
  if (attribute === "email_domain") {
    const email = user?.email;
    raw = typeof email === "string" && email.includes("@") ? email.slice(email.lastIndexOf("@") + 1).toLowerCase() : null;
  } else {
    raw = user?.attributes?.[attribute];
  }
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value && value.length <= MAX_VALUE_LENGTH ? value : null;
}

export const userKey = (issuer, sub) => digest(`${issuer}\0${sub}`);

export function emailKey(issuer, email) {
  if (typeof email !== "string" || !ASCII_EMAIL.test(email) || !email.includes("@")) return null;
  return digest(`${issuer}\0${email.toLowerCase()}`);
}

/**
 * Splits listed directory users into those the sync can attribute and a count of the rest: users without
 * a `sub` or a usable email digest, and users sharing an email digest (ambiguous; they keep device teams).
 */
export function attributableUsers(issuer, listed) {
  const keyed = listed.filter((user) => user?.sub && emailKey(issuer, user.email));
  const counts = new Map();
  for (const { email } of keyed) counts.set(emailKey(issuer, email), (counts.get(emailKey(issuer, email)) ?? 0) + 1);
  const users = keyed.filter(({ email }) => counts.get(emailKey(issuer, email)) === 1);
  return { users, excluded: listed.length - users.length };
}

/** `firstFrom` is the first entry's start: epoch on the first sync, the observation time once history began. */
export function appendHistory(entries, { team, emailKey: key }, at, { firstFrom = 0 } = {}) {
  const latest = entries.at(-1);
  if (latest && latest.team === team && latest.emailKey === key) return null;
  return [...entries, { team, from: latest ? at : firstFrom, emailKey: key }];
}

export const INTERVAL_LIMIT = 4000;

export function flattenIntervals({ attributes, histories, limit = INTERVAL_LIMIT }) {
  const out = { keys: [], teams: [], froms: [], tos: [] };
  for (const [index, { attribute, from: windowFrom }] of attributes.entries()) {
    const windowTo = attributes[index + 1]?.from ?? OPEN_END;
    for (const { entries } of histories[attribute] ?? []) {
      for (const [i, entry] of entries.entries()) {
        const from = Math.max(entry.from, windowFrom);
        const to = Math.min(entries[i + 1]?.from ?? OPEN_END, windowTo);
        if (from >= to) continue;
        if (out.keys.length >= limit) return { error: "directory_too_large" };
        out.keys.push(entry.emailKey);
        out.teams.push(entry.team ?? "");
        out.froms.push(from);
        out.tos.push(to);
      }
    }
  }
  return out;
}
