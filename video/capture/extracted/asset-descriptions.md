# Historical capture asset inventory

The recorded workflow used seven supplied dashboard screenshots instead of crawling the
Basic-Auth-protected service. The original storyboard associates them with the two-day
2026-07-26 to 2026-07-28 sample. This inventory was reconciled on 2026-09-13; it describes
existing media, not a fresh capture or a complete privacy audit.

Tracked sources are under `site/assets/img/`. `video/capture/assets/` and `video/assets/`
are ignored local copies and can be absent in a clean checkout. Paths below link to the
tracked sources; runtime paths are relative to the video project, as used by its HTML.

| Source image | Dimensions | Existing content, described in English | Actual role |
|---|---|---|---|
| [overview.png](../../../site/assets/img/overview.png) | 2132x1714 | KPI tiles with 72 users, 1,587 sessions, 46,539 lines, roughly 405M tokens, and channel summaries. | Runtime `assets/overview.png` in `02-product.html`; hook/other callouts reuse sample figures. |
| [executive.png](../../../site/assets/img/executive.png) | 2132x1714 | Executive summary with people, activity, and cost sections. | Reference only; no standalone Executive scene in the current timeline. |
| [executive-charts.png](../../../site/assets/img/executive-charts.png) | 2132x1888 | Executive charts for active users and model-level spend. | Reference only; not loaded by a current frame. |
| [cost.png](../../../site/assets/img/cost.png) | 2132x1714 | Historical computed spend of $507.88 and cache-tier charts. | Runtime `assets/cost.png` in `04-cost.html`. |
| [productivity.png](../../../site/assets/img/productivity.png) | 2132x1714 | Activity/line counts, an approval-rate display, and anonymized user rankings. | Reference only; no separate Productivity scene. |
| [users.png](../../../site/assets/img/users.png) | 2132x1888 | Channel/user comparisons, historical scores, and anonymized leaderboards. | Reference for HTML-composed `03-ab.html` figures; the frame does not load this PNG. |
| [analytics.png](../../../site/assets/img/analytics.png) | 2132x1888 | Existing assistant conversation and result table, with Korean product text. | Runtime `assets/analytics.png` behind the precomposed answer in `05-agent.html`. |

The inventory's intended labels are anonymized synthetic participant handles. Do not restore
raw customer/account captures into the video, and do not assume client-side dashboard
masking alone certifies an image for publication. No actual screenshots, labels, or captions
were changed by this documentation reconciliation.

Captured computed-cost values are historical estimates. They do not supersede today's
reported-primary contract or prove invoice accuracy. Users can appear in both inferred
channels; scores and approval rates do not establish causal productivity or code quality.
Use [STORYBOARD.md](../../STORYBOARD.md) for exact composed values, timing, and discrepancies,
and [AGENTS.md](../../AGENTS.md) for the authorized asset-restoration workflow.
