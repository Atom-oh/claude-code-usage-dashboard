# ADR-018: Preserve unavailable activity inputs and indices

Status: accepted, 2026-10-11.

## Context

A zero counter sum can come from a lookback-only series or another metric creating
the returned channel row. A permission ratio with no decisions has no denominator.
Displaying these as zero makes absent evidence appear measured and changes activity
rankings or population means.

## Decision

- Keep existing numeric counter totals and add metric-specific observation flags to
  KPI outcome counts and user/CLI active time. Evidence matches session, user, metric
  and type after the existing filters. Lookback-only samples do not establish zero.
- Use raw observations through four hours. Longer windows use raw first-hour evidence
  and later hourly rollup presence. Historical ends retain existing alignment; live
  trailing hours retain partial-hour approximation. Evidence does not prove exact
  boundaries, complete collection or coverage of every user.
- Detail Productivity and Executive withhold aggregate outcomes/time if any returned
  channel lacks relevant evidence. Explicitly observed zero remains zero. Unknown
  channels follow each endpoint's existing population policy.
- The activity index keeps its weights/caps for users with a positive permission
  denominator. Without it, both the index and approval ratio are null. This rule
  does not validate the heuristic or establish complete telemetry for its inputs.
- User/channel means require an available index for every returned target user;
  an empty population stays unavailable. Averaging only available users would
  silently change that population. Rankings omit unavailable indices and disclose
  that selection; tables and CSV keep the users with unavailable values.

## Consequences

Sparse or unsupported telemetry can make these cards unavailable even when another
signal is positive. This is preferable to treating absence as a measured zero.
No missing activity is reconstructed and no employee productivity, quality or causal
ROI claim is introduced.

Cost and token subtotal policies remain owned by
[ADR-013](ADR-013-known-cost-subtotals.md) and
[ADR-014](ADR-014-observed-token-subtotals.md). See the
[API](../api-reference.md), [metrics](../metrics.md#productivity-and-users), and
[frontend](../reference/frontend.md) for fields and presentation.
