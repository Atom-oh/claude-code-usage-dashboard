# ADR-006: Display masking baseline; defer server-side pseudonyms

- Status: Accepted
- Date: 2026-09-03
- Reconciled: 2026-09-13

## Context and decision

Keep display masking for the single authorized audience described by
[ADR-004](ADR-004-basic-auth-baseline-and-sso-upgrade-path.md). The purpose is to reduce
incidental email exposure in screens, exports, and chat, not to prevent an authenticated
viewer from reading the dataset through the API.

`PII_MASK_ENABLED` reaches the SPA as `/api/config.piiMask`. Current behavior is split across
[fmt.js](../../dashboard/web/src/fmt.js), [csv.js](../../dashboard/web/src/csv.js),
[ConfigContext.jsx](../../dashboard/web/src/ConfigContext.jsx), and
[chat.js](../../dashboard/server/chat.js):

- UI email formatting and centralized CSV handling for columns keyed `user` honor masking.
  Other identity-bearing CSV fields require their own formatter; a missing per-column
  `toText` on a `user` column is not itself a leak.
- Chat conditionally masks email-like values and object keys in SQL result rows **before
  sending them to the model**. It also masks email-shaped text on specified SQL-status,
  reasoning, and error paths. This is broader than one `UserEmail` field, but not a universal
  scrub of every identifier or model-generated string.
- Ordinary API responses still contain raw user identifiers. A viewer can inspect the
  network response even when the screen is masked. Masking is not authorization or an
  exfiltration boundary, and it does not change retained telemetry.

The app defaults off when the env setting is absent; `1` or `true` enables it. Terraform
`pii_mask_enabled` defaults true, while the workshop/Compose configuration can disable it
for synthetic identifiers. `ConfigContext` defaults `piiMask` to true on missing/failed
configuration, which is a display fallback, not a server-wide fail-closed privacy guarantee.
Verify actual settings and data before relying on synthetic-only identity assumptions.

## Deferred pseudonym design

The original option was a keyed handle derived from
`hex(sipHash64Keyed(k0, k1, UserEmail))`, with a proposed `PII_HANDLE_KEY`, used consistently
in responses, drawer identity, and exact-match user filtering. Neither that variable nor a
pseudonym protocol is implemented. It is a design sketch requiring validation of key
management, collision behavior, joins, and migration before adoption.

This would replace today's human-readable address and substring-filter contract. It is not
an additive toggle merely because `piiMask` already exists, and pseudonyms alone do not
implement per-viewer data access. Revisit the design if the audience or roles expand.

## Rationale and alternatives

For viewers already authorized to see all rows, immediate pseudonymization adds key rotation
and compatibility work without defining new access rights. Response-boundary email
rewriting was rejected because filters and drawers need consistent round-trippable identity.
Removing identity fields entirely would undermine the existing per-user views. These
trade-offs explain the current baseline; they do not authorize publishing raw data or
sharing the admin credential with a broader audience.

Use [web guidance](../../dashboard/web/AGENTS.md) and the
[security reference](../reference/security.md) for the maintained implementation contract.
