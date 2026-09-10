# Administration UI

Company user creation includes email and a temporary web sign-in password for
employees as well as administrators. The users table shows whether web sign-in
is enabled. Existing QR-only users can enable it through Edit; role permissions
remain enforced by the API. `scripts/test-company-user-form.mjs` mounts the real
form and verifies employee credentials without granting an admin role.

`AdminConsole.jsx` owns navigation, profile/access loading and page composition.
It is no longer the implementation of every admin screen. Page folders are:

- `overview/`: company dashboard.
- `users/`: users list and tabbed `UserEditor`, including its own `userTabs`.
- `ai/`: voice/receptionist configuration.
- `routing/`: outbound rules, office hours and call handling.
- `numbers/`: company number and trunk setup.
- `diagnostics/`: reports and events.
- `settings/`: system and password/security settings.
- `platform/`: platform dashboard, companies, subscriptions, feature access and API keys.
- `WalletsPage.jsx`: platform/customer wallet management.
- `components/ui.jsx`: shared admin fields, toggles, status, headers and modals.

`configuration.js` contains defaults and navigation metadata, not authorization.
Backend routes remain the security boundary even when the UI hides a page.
Company membership must not grant Vocivo platform privileges. Validate both role
views with browser tests after changing imports, page props or entitlement names.

## Customer workspace requests

Opening a customer is a GET, not a saved platform preference. `workspace-api.js`
captures that tab's organization ID and adds `?organizationId=...` to tenant
requests. Pass this client to child pages that call tenant APIs; never infer their
target from a mutable server default. The load generation discards responses from
an earlier workspace, and failed voice-settings loads must not leave another
company's editable voice form behind.

PBX forms retain the returned `config.workspaceVersion` when saving. A stale
same-company form receives HTTP 409; editing another company does not invalidate
it. Global SaaS/wallet actions keep their separate, explicit target contracts.

Regression: `node --import tsx scripts/test-admin-workspaces.mjs` from `frontend`
with `VOCIVO_TEST_ORIGIN` set to the local Vite URL and `PLAYWRIGHT_MODULE` set if
Playwright is installed outside this project. All APIs are intercepted. This
tests two real console tabs, not production carrier calls or production storage.

Initial PBX and SaaS reads run concurrently. Once the workspace and entitlements
are resolved, independent scoped reads also run concurrently; the generation
guard still discards superseded responses before publishing state. Required-read
failure retains the existing error path, and optional reads retain their fallbacks.
`node --import tsx scripts/test-web-branding.mjs` holds the first read open to
verify this dependency order and checks the shared top brand on all viewport sizes.

`numbers/CarrierTrunksPanel.jsx` adds editable company carrier configuration to
SIP trunks. It uses the captured workspace API and remounts when the company
changes. Carrier forms edit inventory and connection settings, not published routing.
The panel labels saved configuration **Pending activation** because this form
does not provision the SIP edge. Authentication is explicitly unconfirmed until
the administrator selects the provider's method; the account reference is separate.
Browser acceptance covers create, reopen, edit and retention of live destinations.
Carrier call acceptance remains a separate gate.

`CarrierTrunkDetails.jsx` displays every saved company carrier entry with General,
Options and a complete DID table directly on the SIP trunks page. No edit dialog
is needed to see account/server/authentication, public IP, capacity, call directions,
or per-number caller IDs and destinations. `Add SIP trunk` opens the company
carrier form; the separate external connection action is `Add PBX registration`.
The scoped stylesheet keeps number rows readable on narrow screens. Confirm the
saved entry remains visible after a fresh page load, including unassigned DIDs.
## User and shared number assignments

- **Users > Edit > Numbers**: `users/UserNumbers.jsx` assigns zero or more direct
  inbound numbers and a separate outbound caller ID. Blank outgoing selection
  explicitly inherits the company default. Create the user first, then assign
  numbers. The Users table and search include both assignments.
- **Phone numbers**: `numbers/NumbersPage.jsx` edits each published number's
  extension, main/receptionist, ring group, queue or IVR destination. This is also
  the shared-routing view, not a second carrier configuration form.
- **SIP trunks**: provider credentials, connection settings and DID inventory.
  Published destinations are read-only here and cannot be overwritten by an old
  carrier draft. Activation status remains distinct from number assignment.

Both routing editors use `numbers/useNumberRouting.js` and the tenant-scoped
`/api/admin/number-routing` endpoint. Inbound assignments are derived from live
`numberAssignments`; there is no duplicate user DID list. The old `profile.did`
metadata field is no longer editable and is cleared on a number-assignment save.
The editor confirms reassignment from another destination; removing a direct
number from a user returns that number to main/receptionist routing. This does
not detach the number from the company. Explicit company removal is a separate,
confirmed action on Phone numbers.

Numbers save independently of identity/preferences. `AdminConsole.saveUser`
retains fresh routing fields when saving General, avoiding stale-profile undo.
Routing mutations carry a snapshot version; a conflict keeps the editor open
and requires Reload numbers. No carrier activation or call is performed by save.

Regression: `node --import tsx scripts/test-user-number-routing.mjs` mounts the
real console with real route handlers and isolated persistence/auth fixtures.
It exercises company admin and superadmin workflows, tenant filtering, distinct
lines, shared routing, stale edits and narrow layouts. The carrier form regression
remains `node scripts/test-carrier-admin.mjs`. Set `VOCIVO_TEST_ORIGIN` and
`PLAYWRIGHT_MODULE` for the local environment.

The overview uses published tenant carrier inventory for BYOC workspaces and
never requests Telnyx inventory or balance for their SIP calling service. The
platform settings display the configured calling engine/domain and APNs/FCM
configuration. Missing subscription data stays unavailable; configured SIP does
not imply measured socket/media health. Overview route tests cover disabled DID
exclusion and absence of managed-carrier requests.
