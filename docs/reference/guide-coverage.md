# Product guide coverage map

The [English user guide](../../site/user-guide.html) covers the product menus and
five-language interface. UI availability depends on configuration, permission,
schema, retention and observed data. Implementation and tests remain authoritative.

Illustrated paths: [user and task](../../site/user-guide.html#trace-workflow),
[cost efficiency](../../site/user-guide.html#cost-workflow),
[tools and MCP](../../site/user-guide.html#tools-workflow), and
[architecture](../../site/user-guide.html#system-overview).
[Capture sources](../../scripts/docs-capture/README.md) identify the synthetic examples.
Language selection and state retention are owned by
`dashboard/web/src/i18n/` and `components/LanguagePicker.jsx`; translated copy does
not change collected values, identifiers, time-zone conventions or API filters.

| Guide section | Routes or feature groups | Implementation owners |
|---|---|---|
| [Start](../../site/user-guide.html#start), [access](../../site/user-guide.html#access) | First visit, roles, session expiry, logout, mobile navigation, help and release notes | `dashboard/web/src/{App,SessionBoundary,ClientContext}.jsx`, `components/{Sidebar,MobileNav,AccountMenu,ReleaseLink}.jsx`, `pages/Changelog.jsx`, `clientNavigation.js`, `releaseNotes.js` |
| [Controls](../../site/user-guide.html#common-controls), [troubleshooting](../../site/user-guide.html#troubleshooting) | Client/detail routing, channel/backend, range, filters, refresh, charts, tables, exports, masking and coverage | `dashboard/web/src/{ClientContext,RangeContext,FilterContext,RefreshContext}.jsx`, `components/{FilterBar,RangePicker,DateRangePopover,RefreshControl,GroupCharts,ModelCostTrend,DataTable,FreshnessBanner}.jsx`, `csv.js`, `clientPresentation.js`, `pages/Clients.jsx`; [frontend](frontend.md), [UI](ui.md) |
| [Overview](../../site/user-guide.html#overview) | `/`, shared and Claude detail, session/turn and optional daily insights | `pages/{Clients,ClientPanels,Overview}.jsx`, `components/{SessionTurns,DailyInsights}.jsx` |
| [Executive](../../site/user-guide.html#exec) | `/exec`, shared comparisons and Claude channel scoreboard | `pages/{Clients,ClientPanels,Executive}.jsx`, `components/ABScoreboard.jsx` |
| [Trends](../../site/user-guide.html#trends) | `/trends`, previous period, resolution, Claude adoption | `pages/{Clients,ClientPanels,Trends}.jsx`, `components/{ClientTrend,ModelCostTrend}.jsx`, `costResolution.js` |
| [Productivity](../../site/user-guide.html#productivity) | `/productivity`, token economics, eight shared sections, Claude activity and flow | `pages/{Clients,ClientPanels,ClientProductivity,TokenEconomics,Productivity,ProductivitySignals}.jsx` |
| [Usage](../../site/user-guide.html#usage) | `/usage`, token/tool comparison, Claude tools, MCP, Skills, plugins and related signals; Codex tools and approvals | `pages/{Clients,ClientPanels,Usage,CodexInsights}.jsx` |
| [Users](../../site/user-guide.html#users) | `/users`, user tables, detail, heatmap and task entry | `pages/{Clients,ClientPanels,Users}.jsx`, `components/{UserDetail,TaskList}.jsx` |
| [Cost](../../site/user-guide.html#cost) | `/cost`, breakdowns, model/user drilldowns, effort, Claude team and calculated comparison | `pages/{Clients,ClientPanels,ClientCostUsers,Cost,CodexInsights}.jsx`, `components/{CostBreakdowns,ModelCostTrend,TeamCostSection}.jsx`, `spend.js` |
| [Reliability](../../site/user-guide.html#reliability) | `/reliability`, shared diagnostics, Claude error/version/cost checks, Codex performance | `pages/{Clients,ClientPanels,Reliability,CodexInsights}.jsx` |
| [Analytics](../../site/user-guide.html#analytics), [assistant](../../site/user-guide.html#assistant) | `/analytics`, shared diagnostics, Claude chat, Codex metric search/Trace preview, questions and charts | `pages/{Clients,ClientPanels,Analytics,CodexInsights}.jsx`, `components/{FloatingChat,ChatCharts,ChatTrace}.jsx`, `useChatStream.js`, `chatCharts.js` |
| [Collector](../../site/user-guide.html#collector), [installation](../../site/user-guide.html#installation) | `/collector`, `/installation`, device registration/revocation and administrator checks | `pages/{CollectorSetup,CollectorGuide,Installation}.jsx`, `components/Sidebar.jsx`, `dashboard/server/collectorRoutes.js` (server routes are also indexed in [API reference](../api-reference.md)) |
| [Tasks](../../site/user-guide.html#tasks) | User task list, workflow filter, trace overlay, links, lanes, environment, context and bounds | `components/{UserDetail,TaskList,TaskTraceOverlay,TaskTimeline,TaskSpanPanel,TaskCostBand,TaskContextChart}.jsx`, `pages/SharedTask.jsx`, `taskTrace.js`, [API reference](../api-reference.md#users) |
| [Workflows](../../site/user-guide.html#workflows) | Spend, coverage, costly tasks, client/model comparison and device lifecycle | Menu and feature owners above; [installation](../../site/installation.html), [operations](../../site/operations.html), [architecture](../../site/architecture.html), [API](../../site/api.html) |

Paths without a prefix are under `dashboard/web/src/`. Task and diagnostic trace
limits are distinct; see [Codex observability](codex-observability.md) and the
[API reference](../api-reference.md). Guide totals preserve reported versus
estimated cost and partial observed-token semantics; see
[ADR-013](../decisions/ADR-013-known-cost-subtotals.md) and
[ADR-014](../decisions/ADR-014-observed-token-subtotals.md).
