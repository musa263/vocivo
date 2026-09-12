# Operations screens

`OperationsPage` provides Agents & registrations, Queues and Live calls. Agent
preferences are editable by entitled administrators; call state is read-only.
Color dots include text labels. Stale data displays unknown counts.

`ReportsPage` provides date-range call records, hourly/direction charts, top
extensions, wallet analysis, search/filtering, pagination and CSV. Boundaries
are explicitly UTC; chart timezone changes display/grouping. `report-export`
neutralizes spreadsheet formulas and leaves unreconciled costs blank.

`useOperations` owns serial polling, abort and generation guards. Unmount and
workspace changes discard late results. `AdminConsole` passes a captured
`workspaceApi` and keys each page by tenant. Keep both routes in that helper's
scoped route set. See backend operations README for semantics and rollout.

Run from frontend with local Vite:
`PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node --import tsx scripts/test-operations-ui.mjs`.
The script intercepts every API; its sample data is never used in runtime code.
