# Client observability implementation record

[Accepted scope](../specs/2026-09-14-client-observability.md).
Authentication and Claude counter semantics remain; docs are English, UI Korean.

Implemented client flags, Codex log normalization/pricing, nullable common aggregates,
navigation/filtering, startup recovery and owning references. Review fixes cover
Claude event names, model-less attribution, missing usage, cache identity, config
retry and Collector validation/recovery. Canonical contracts live in the linked spec's
references rather than being duplicated here.

Validation: server 205 tests; real ClickHouse 16; web 217 plus production build;
harness 115 passed with eight documented optional-tooling/Collector skips. Actual
Collector replay passed separately. Terraform format/validation and real local
Express/ClickHouse browser checks covered client modes, totals, filters, missing/empty
data, masked CSV, mobile navigation and config retry.

Native Codex 0.154 supplied local tool/OTLP fixtures. Seven bounded raw AWS calls
verified endpoint streaming/functions and Runtime's hosted-search limitation;
they do not establish live CLI authentication or invoice coverage.

Release gates follow AGENTS.md. Validation is not deployment.
