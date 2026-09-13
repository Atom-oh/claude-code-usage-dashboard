# Historical cost-accuracy review: cache TTL and reported spend

- Review date: 2026-09-10
- Reviewed source: `de0eb9f7bfdaa67ba570e0489bc9722c2bb6445b`
- Input: a user-supplied 2026-09-09 analysis of workshop aggregates covering 82 users and 231 rows
- Documentation reconciliation: 2026-09-13

**Historical, non-normative investigation.** This records the pre-correction analysis and
its evidence limits. It is not a current implementation plan, deployment record, or invoice
reconciliation. The accepted consumer change and current opt-in computed view are described
in [ADR-009](decisions/ADR-009-reported-spend-with-computed-diagnostics.md). Root/scoped
AGENTS guidance owns current engineering conventions.

## Finding and limits

The review recommended client-reported cost as the default spend basis while preserving
existing token-priced API fields. The supplied difference was consistent with applying
one-hour cache-write prices to traffic recalculated at five-minute prices. The original
231 rows and AWS billing data were not available to independently repeat the event-wide
recalculation, establish collection coverage, or compare an invoice.

Recalculating costs from API token counts and candidate prices is a consistency check for the
**one-hour price assumption**, not proof that all other query, grouping, collection, or
pricing errors are absent. Specifically:

- $6,640.33 is a five-minute-price recalculation, not an AWS invoice amount.
- Reports depend on client price knowledge and captured usage; they are neither universally
  accurate nor a guaranteed billing lower bound.
- Observing four metrics in one run does not establish that the product emits only four.
  The checked-in collector allows eight metric names.
- The four stored token categories do not identify each write's TTL. That is narrower than
  claiming no telemetry extension could ever capture it.
- Existing aggregate report fields can drive spend displays without SQL changes. They do
  not provide complete per-request missingness evidence.

## 1. Source prices and arithmetic

[pricing.js](../dashboard/server/pricing.js) defaults `PRICING_CACHE_WRITE_TTL` to `1h`.
`withComputedCost()` and `tierCosts()` use that global setting; it neither measures request
TTL nor changes the provider's cache behavior. The historical review checked these source
rates with one million cache-write tokens:

| Model | Input | Output | Cache read | Write 5m | Write 1h | Write difference |
|---|---:|---:|---:|---:|---:|---:|
| `claude-opus-5` | 5 | 25 | 0.50 | 6.25 | 10 | 3.75 |
| `claude-sonnet-5` | 2 | 10 | 0.20 | 2.50 | 4 | 1.50 |
| `claude-haiku-4-5` | 1 | 5 | 0.10 | 1.25 | 2 | 0.75 |

Units: USD per million tokens in the repository price table. Provider documentation cited
on 2026-09-10 agreed with these rows; this reconciliation does not re-verify current
provider pricing or account-specific commercial terms. For these rates, the TTL difference is:

```text
sum(cache_write_tokens / 1,000,000 * input_price * 0.75)
```

The supplied aggregates give:

| Comparison | Difference | Difference / second amount |
|---|---:|---:|
| Computed 7,817.28 minus five-minute recalculation 6,640.33 | 1,176.95 | 17.72427% |
| Reported 6,647.79 minus five-minute recalculation 6,640.33 | 7.46 | 0.11234% |
| Computed 7,817.28 minus reported 6,647.79 | 1,169.49 | 17.59216% |

Thus the computed-versus-reported difference is 17.59%; 17.72% uses the recalculation as
its denominator. The $7.46 residual was unexplained, not confirmed to be rounding.

## 2. Distinct TTLs and comparison populations

| Mechanism | Evidence and relevance |
|---|---|
| Provider prompt-cache TTL | The 2026-09-10 review cited five-minute defaults and one-hour options for supported models. Actual request settings/version behavior still required verification. |
| Diagnostic price TTL | Repository-wide `1h` default with `5m` override; mixed write TTLs cannot be recovered from one total. |
| API response cache | `index.js` uses `CACHE_TTL_MS=320_000`; this can delay observations but does not change a fixed historical price calculation. |
| Frontend live-window timing | `useApi.js` uses a 120-second boundary and 150-second grace, typically placing the live upper bound 150-270 seconds behind wall-clock time. |
| ClickHouse TTL | Table retention/movement policies affect available history; they are unrelated to prompt-cache price tiers. Source SQL is not evidence that those policies are deployed. |

`TOKEN_SUMS` sums increments from `incFlat()`, not raw cumulative `otel_metrics_sum.Value`.
Keep that counter handling and the segment-key decision in
[ADR-003](decisions/ADR-003-fold-start-time-into-series-key.md). Changing spend presentation
does not authorize raw counter summation or establish migration 003 completion.

Additional comparisons must align UTC range, channel/model/user filters, unknown-session
inclusion, and identity presence. `costSummary` includes unknown sessions; `costByUserModel`
ordinarily excludes unknown sessions and empty user identities. Longer ranges use hourly
rollups with boundary approximations, while log queries can read exact timestamp bounds.
The three-day baseline lookback, process resets, delayed arrival, missing samples, and
retention can all matter. Their contribution to this workshop difference was not measured.

## 3. Report quality and possible TTL evidence

The repository records a 2026-09-03 observation that client 2.1.251 priced
`claude-fable-5-1` using the opus-5 row, reporting roughly half the relevant list estimate;
2.1.258 differed. That historical binary/statement was not revalidated here, but it limits
any claim that reports are correct for all clients and models.

`/api/reliability/reported-vs-computed` compares API-log reports and calculated costs by
`AppVersion`, model, and channel. A mismatch against one-hour pricing alone does not identify
a client bug. Comparing five-minute and one-hour scenarios was proposed as an additional
diagnostic, not implemented by this review. Falling between the scenarios would still not
prove correct TTL attribution, complete collection, or valid invoice pricing.

The current log query reads `cost_usd`. The historical proposal to inspect
`cost_usd_micros` and use it as an alternative source at `/1e6` remains separate work; the
fields must not be added together. A positive report for every user establishes report
presence per user, not that every request was collected. SQL sums can conceal missing
components. Never use an unlabeled `reported_cost || cost` fallback to hide missingness.

The monitoring documentation cited in the original review described token categories
`input`, `output`, `cacheRead`, and `cacheCreation`, without a TTL dimension in that metric.
It also described optional raw request/response body events via `OTEL_LOG_RAW_API_BODIES`.
The review did **not** prove that field availability or behavior for the workshop's
2.1.263/2.1.266 clients and Bedrock responses. Claims about `promptCacheTtl` and
`subagentPromptCacheTtl` came from the supplied analysis, not independent confirmation on
the settings page.

No raw-body logging was enabled by the review. Such bodies can contain conversations, and
the cited inline mode had a 60KB default truncation limit. The collector's `prompt` and
`prompt_text` key removal is not a full-body scrub. A future experiment needs approved local
extraction of only required usage fields and disposal of the body before telemetry export.
It is not a prerequisite for using already available reported totals.

## 4. Original proposals versus current implementation

The final correction scope excluded SQL, pricing/rollup, provider TTL, collector, and
infrastructure changes. Current consumers are governed by ADR-009:

| Topic in the original review | Reconciled status on 2026-09-13 |
|---|---|
| Spend totals, forecasts, ranks, comparisons, and exports | Frontend `spend.js` selects reports and preserves computed values. Missingness is retained through consumer folds. |
| Per-user efficiency | `costEfficiency.js` uses reported cost for unit costs and retains separate computed/unpriced fields. User plus channel remains the join key. |
| Computed diagnostics | Cost starts with `showComputed=false`; comparison columns/CSV, effort annotations, totals, and token-tier charts are opt-in. Reliability keeps both bases. |
| Runtime price assumption | `ConfigContext.jsx` now retains `pricing`; Cost displays the configured assumption. The historical claim that it drops pricing is no longer current. |
| Agent ranking before cutoff | Proposed SQL/aggregation reordering was outside final scope. `agentCost()` still sorts computed cost before its top-30 cutoff; report ranking is only within that subset. |
| Scores | `productivity.js` and `score.js` do not require a score-formula change for the spend correction. |
| Chat prompt | Ordinary cost queries already use reports. Legacy wording tying the Cost card to computed cost remains a separate prompt inconsistency. |
| Per-request coverage, microdollar precision, two-TTL scenarios | Separate proposals, not features implemented by this review or implied by positive aggregates. |

Existing project/entrypoint/skill report paths should not be converted twice. Model-price
absence and report absence remain independent. Unknown-price models can have valid reports;
a known price cannot certify complete reporting. Neither calculation is automatically an
invoice, minimum invoice, or causal productivity measure.

## 5. Historical release evidence

The Sonnet 5 source-rate change from $3/$15 to $2/$10 was recorded at
`0654c6d29579866aeb60929888481de687081cc4` on 2026-09-02. A separate workshop repository's
handoff record linked `ed7919950caf6c73d5bdfa8d8aac99e520613156` to image tag
`cc-ab-dashboard:20260905-131041`, with:

```text
Recorded archive size: 61,969,752 bytes
Recorded MD5: f5047d53787c951a2573702ff6f42850
Recorded RepoTag count: 1
pricing.js SHA-256: 7244945a42ac2ad45e3d6f6708688a60607878901dc2add6c1108b510c36d23f
Source Sonnet 5 base rates: input=2, output=10
```

The original review found the handoff source and reviewed `pricing.js` identical. The
2026-09-13 local source still has the recorded SHA-256. These identify **source defaults**,
not the contents of an unexamined tarball, running image digest, or active pricing overrides.
`assets/cc-dashboard-arm.tar.gz` and `docs/INFRA.md` were external handoff references and
are not files in this repository. They are not broken local prerequisites to invent here.

A release manifest linking source commit, image digest, archive SHA-256, and running image
ID was recommended. It was not created by this investigation. Actual account configuration
and any `PRICING_JSON` override require separate operator evidence; private negotiated
prices need not be exposed through the authenticated runtime-config response.

## 6. Verification record and unresolved questions

The 2026-09-10 review recorded passing existing tests with this command:

```bash
(cd dashboard/server && node --test pricing.test.js pricing.ttl5m.test.js costEfficiency.test.js queries.test.js)
```

That was evidence about the then-current code, not proof that every proposal was implemented.
It also recorded in-memory checks of the three one-million-write rates and aggregate
arithmetic. The documentation reconciliation did not rerun cloud queries, model requests,
image deployment, archive inspection, or event-level billing comparison.

Remaining evidence needs are the original 231 rows, matched account/channel/date/usage-type
billing records, precise deployed configuration, and collection coverage before aggregation.
Do not combine Enterprise reported cost with an AWS Bedrock invoice. A workshop configuration
change date does not prove that every existing session adopted a new TTL. Regional price
normalization was also raised: source model normalization removes profile prefixes, while
account/SKU pricing may differ. This was not established as the cause of this event's gap.

## Historical external references

The original review recorded retrieval of official HTML on **2026-09-10**. These references
preserve provenance; their current contents were not fetched in this documentation pass.

- S1, Bedrock prompt caching: `https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html`
- S2, Anthropic pricing: `https://platform.claude.com/docs/en/about-claude/pricing`
- S3, Claude Code monitoring: `https://code.claude.com/docs/en/monitoring-usage`
- Additional pages: `https://code.claude.com/docs/en/settings` and
  `https://aws.amazon.com/bedrock/pricing/`. The earlier HTML review did not establish the
  two settings keys or the account/region's effective AWS SKU price from those pages.
