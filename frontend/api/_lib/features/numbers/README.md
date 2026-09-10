# Numbers and Carrier Access

`phone-number-access.ts` lists assigned caller IDs and verifies their organization
before use. `number-config.ts` handles business line configuration and safe carrier
tags; `trunk-policy-store.ts` controls allowed trunk policy. `carrier-access.ts`
separates platform carrier metadata from company-visible data.

`routes/` contains company number/trunk administration and stable Telnyx number
API implementations. `verified-numbers.ts` requires administrative authorization
for mutations. The public URLs remain under `api/telnyx/` for compatibility.
Test ownership, internal tag filtering and trunk policy through frontend `npm test`.

## Company carrier configurations

`/api/admin/carrier-trunks` exposes GET/PUT/PATCH for company administrators in their
authenticated organization, or a platform administrator with an explicit customer
workspace. The route checks the `sipTrunks` entitlement and validates extension,
ring group, queue and IVR destinations against that company. Unassigned destinations
are supported so administrators can enter their carrier details before routing.

`carrier-trunk-store.ts` normalizes the provider, account reference, endpoint,
transport, public IP, authentication method and individual DID/caller-ID pairs.
It stores encrypted, tenant-specific objects using the shared transactional store.
Revisions reject stale edits with 409; repeated identical creates are idempotent.
Malformed or moved encrypted data fails closed instead of resetting configuration.

An unpublished record remains a draft. PATCH `use-carrier-numbers` atomically
publishes its DIDs and sets company carrier mode. PUT edits to a published trunk
update inventory metadata but preserve canonical destinations. Passwords remain encrypted; company responses expose
only `hasPassword`. No company request can authorize a carrier source or declare
a gateway deployed. Connection status comes from the operator deployment record.
The existing `/api/admin/trunks` Telnyx external-PBX registration contract is separate.

Carrier drafts also support a main trunk number, optional outbound proxy/port,
simultaneous call limit and explicit inbound/outbound permissions. The main number
must exist in that trunk's DID list. Older records without these fields remain
readable and display unspecified values; missing permissions do not imply enabled
calling. These fields remain configuration data until SIP edge activation.

Regression: `node --import tsx --test api/_lib/features/numbers/carrier-trunk-store.test.ts`
from `frontend`, then root `bash verify.sh`. The tests use encrypted in-memory
persistence and real route logic; they do not connect to a carrier.

## Tenant BYOC calling

Operator deployment records may include a canonical UTC `expiresAt` deadline
for a temporary test. Expired records stop outbound grant/bridge admission and
inbound resolution; invalid deadlines fail closed. An empty `inboundSources`
array permits an outbound-only test and explicitly reports inbound as undeployed.
It must not be used to claim an incoming carrier route exists.

`carrier-number-service` publishes canonical ownership and disabled tombstones.
`carrier-runtime` checks the operator deployment allowlist, source-bound inbound
aliases, current revisions and explicit call direction. `carrier-gateway-config`
exports a deterministic per-tenant gateway; it does not activate it. See the
[activation runbook](../../../../../docs/runbooks/tenant-carrier-trunks.md).
Run carrier store/runtime/number-service regressions and the SIP outbound XML
regressions, then root `bash verify.sh` and the Docker carrier workflow.
# Administrator-assigned outgoing line

`dialing-defaults.ts` resolves a user's saved caller ID, then the company default,
only against enabled same-tenant number assignments. Carrier mode excludes managed
numbers. Its country comes from the matching published trunk's main DID/caller ID
pair, with the assigned E.164 number as fallback. No device locale guesses are used
for business calls. Mobile bootstrap and number inventory publish these defaults.
`voice-route` chooses them server-side, and `assertCallerIdForSession` also rejects
unassigned overrides on conference/call paths. Admin PBX saves validate changed
user/default lines against current ownership before the existing CAS save.

## Canonical user and shared routing

`number-routing.ts` owns scoped routing snapshots and pure mutation validation;
`routes/admin-number-routing.ts` exposes GET/PUT through `/api/admin/[resource]`.
Every request requires verified administrator access and the phoneNumbers
entitlement. Superadmin must select a workspace explicitly. Responses whitelist
number/user/target fields, never directory SIP credentials or another tenant.

PUT carries `version`, `organizationId` and one action:

- `user`: `extensionId`, `inboundNumbers`, `outboundCallerId`, and explicit
  `confirmReassignment` when taking a number with another live destination.
  Saves direct routes and caller ID in one PBX transaction, preserving other
  profile fields. Deselected direct DIDs return to `main`; blank outbound inherits.
- `route`: `number`, `destinationType`, `destinationId`. Edits the same records
  used by the user screen and SIP/managed inbound routers. Targets must be active
  same-tenant users or the tenant's configured ring groups, queues or IVRs.
- `remove`: `number`. Leaves a disabled tombstone, clears matching user/default
  caller IDs, and keeps the carrier asset. It does not release or purchase numbers.

The version covers tenant numbers, outgoing assignments and valid destinations.
It is checked against the latest config **inside** `savePbxConfig`'s existing
transaction. Invalid inputs or stale versions do not partially write. The tenant
mutation lease also serializes these writes with administrator user deletion.
Verified-only numbers cannot receive calls, and carrier mode rejects managed lines.
Missing legacy source with no destination is treated conservatively as verified,
consistent with the existing phone-number access layer.

`withLiveNumberRoutes` overlays canonical assignments on carrier read responses.
`applyCarrierNumbers` only seeds destinations on first publication; republishing
must not restore an older carrier-form route. This changes neither SIP transport
nor the carrier activation contract. Existing `profile.did` values are not migrated
into routes: that field never proved number ownership or caller intent.

Validation: `number-routing.test.ts`, `carrier-number-service.test.ts`, the browser
regression in the admin README, and root `bash verify.sh`. These prove local route
selection and isolation with fixtures, not live carrier reachability or audio.

Carrier form saves and publication now lock the encrypted trunk record and PBX
configuration in one object-group transaction. Validation or plan-limit failure
rolls back both; publishing a stale revision fails. Company feature checks happen
before mutation. Disabled-number tombstones survive later trunk edits and cannot
become the default outgoing line. GET/PUT agree on their unassigned presentation.
Inventory reports inbound availability only when the deployment actually includes
inbound sources. Managed source admission uses `VOCIVO_MANAGED_TRUNK_SOURCES`,
independently of BYOC deployment entries.
