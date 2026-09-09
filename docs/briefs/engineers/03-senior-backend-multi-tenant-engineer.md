# 3. Senior backend / multi-tenant engineer

**16 open items** — 1 High, 4 Medium, 7 Low, 4 Verify.

> Part of the Vocivo defect allocation. The full picture across all eight roles is in [Vocivo-Open-Defects-by-Role.docx](../Vocivo-Open-Defects-by-Role.docx); the role definitions are in [Vocivo-Engineering-Roles-and-Responsibilities.docx](../Vocivo-Engineering-Roles-and-Responsibilities.docx).

## What this role owns

frontend/api, the encrypted PBX configuration store, number assignment and carrier activation, wallets and billing.

## First results to deliver

Consistent tenant-owned trunk management, accurate activation status and secure user login. Prevent cross-company routing or data access, and duplicate charges or events.

## Required skills

- TypeScript and Node APIs within Vercel execution limits
- PostgreSQL schema design, migrations, transactions, locking and optimistic concurrency
- Enforcing tenant ownership and role permissions
- Verifying signed tokens, expiry and route grants; encrypting carrier secrets
- Idempotent event processing, accurate billing ledgers and carrier activation reconciliation
- Writing authorization, concurrency and API integration tests

## Start here

**BE-1** — this is the item a customer feels on an ordinary call.

The number-lifecycle items chain: **BE-3** lets a tenant tombstone their own main line and **BE-2** makes that permanent. Fix BE-2 first so BE-3 is recoverable, then close BE-3.

---

## Open items

### High — a call is dropped, silenced, misrouted to another company, or a console is unusable

#### BE-1

**Where** — `frontend/api/_lib/features/numbers/carrier-runtime.ts:71`

For a platform-assigned DID the inbound match is on the dialled digits alone; the source IP is never consulted, while Kamailio trusts every address in VOCIVO_TRUNK_SOURCES and that list now includes tenant-owned BYOC carrier IPs. Tenant A’s carrier can INVITE tenant B’s platform DID and reach B’s staff, B’s receptionist and B’s voicemail with an attacker-chosen caller ID. Carrier-sourced numbers are protected; platform ones are not.

**Fix** — Partition VOCIVO_TRUNK_SOURCES into platform and per-tenant sets and require source membership in both branches. Joint with Security (SEC-1).

### Medium — a feature is broken, a setting is silently wrong, or an operator is shown the wrong customer

#### BE-2

**Where** — `organizations/tenancy.ts:45 with numbers/carrier-number-service.ts:77`

detachCompanyNumber sets disabled: true and keeps organizationId; every later assignNumberToOrganization merges over current with a patch that never contains disabled, so the tombstone survives. The number becomes invisible in every listing, outbound with it is refused, inbound is quarantined, and numberAssignmentConflict blocks any other tenant from claiming it. Only applyCarrierNumbers ever clears the flag, and only for carrier trunks.

**Fix** — Write disabled: false explicitly in the assignment, or make an absent patch field mean cleared.

#### BE-3

**Where** — `numbers/routes/admin-carrier-trunks.ts:34-36 with carrier-number-service.ts:110-114`

remove-company-number is gated on entitlements only; detachCompanyNumber checks ownership but not source and not calling mode. A company admin on managed calling with no carrier trunk can tombstone their own main DID, after which inbound is quarantined and, because of BE-2, there is no route back.

**Fix** — Require source === "carrier" and carrier calling mode, and expose a managed-number equivalent through the numbers screen.

#### BE-4

**Where** — `numbers/routes/admin-numbers.ts:131-144 (same shape at platform-resource.ts:142-148, admin-extensions.ts:59-62)`

The plan limit is checked against a config read before the carrier order, and assignNumberToOrganization enforces nothing inside the transaction. Two concurrent purchases each see zero assigned, both pass the check, and a two-number plan buys four numbers, at recurring monthly cost.

**Fix** — Enforce the limit inside the savePbxConfig updater, as carrier-number-service.ts:101-106 already does for carrier DIDs, and release on overflow.

#### BE-5

**Where** — `calling/routes/voice-transfer.ts:29 and voice-merge.ts:145`

Both require route stores written only by voice-webhook.ts and the parked-client handler, which never run for a call carried by Vocivo’s own Kamailio. With the SIP edge active, Merge always fails with "both calls must be connected through Vocivo" and Transfer with "this call is not an active routed business call", while both controls remain enabled in the web and mobile UIs.

**Fix** — Implement the SIP-edge equivalents, or expose a capability flag the clients gate on until then.

### Low — dead code, a cosmetic defect, or a latent hazard

#### BE-6

**Where** — `billing/wallet-store.ts:467`

A tenant-scoped wallet read calls setContext(transaction, organizationId, true), setting platform access even though every query in the transaction already filters organization_id. The vocivo_wallet_tenant_isolation policy is a no-op for the one call every mobile bootstrap and outbound route makes, removing the database-level backstop.

**Fix** — Pass false so the row-level policy applies.

#### BE-7

**Where** — `billing/routes/admin-wallets.ts:123`

The endpoint mints its own idempotency key when the client omits one, silently disabling the idempotency that recordWalletAdjustment implements. A double-click or a retried timeout credits the customer twice.

**Fix** — Reject the request when idempotencyKey is absent.

#### BE-8

**Where** — `organizations/routes/admin-saas.ts:68, 78-152; billing/routes/admin-wallets.ts:97, 105-159`

Both accept GET, PUT and DELETE, return early only for GET, then dispatch purely on req.body.action. A DELETE carrying action save_company creates a customer and a DELETE carrying adjust_wallet moves money, bypassing any proxy rule or audit keyed on the verb.

**Fix** — Bind each action to its verb before dispatching.

#### BE-9

**Where** — `numbers/routes/telnyx-numbers.ts:30, 40`

For the platform owner organizationId is set to the empty string and sessionCanAccessNumber short-circuits to true, so the caller-ID picker lists every customer’s DIDs mixed together with no active-organization gate, unlike every /api/admin/* route.

**Fix** — Route the superadmin through requestOrganizationId, or require workspace selection.

#### BE-10

**Where** — `auth/auth.ts:236 vs organizations/saas-access.ts:13`

One predicate accepts owner and superadmin, the other only superadmin. A session with role owner would pass requireAdmin as superadmin but fall through to accessForOrganization("") and throw Organization inactive, answering a platform owner with a "not enabled for this company" 403. Dead today only because createSession hardcodes superadmin.

**Fix** — Share one predicate.

#### BE-11

**Where** — `calling/voice-provider.ts:16, :26 and pbx-config-store.ts:61 with mergePbxConfig:133-138`

voiceEdge ignores the config argument that eight call sites pass; voiceProvider is deprecated and referenced only by its own test; platform.voiceProvider, controlPlane and sipDomain are never carried through the merge, so they are always the literal defaults yet are returned to superadmins. An operator changing them sees the save succeed and nothing change.

**Fix** — Delete the dead export and the unused parameter, and either persist or remove the non-functional platform fields.

#### BE-12

**Where** — `sip/sip-credential-store.ts:107`

readSipCredential has no callers anywhere. It returns the most recently issued live password for a username, exactly the shape a future caller would misuse now that multiple devices hold concurrent credentials.

**Fix** — Remove it.

### Verify — a credible defect that could not be proved from the source alone — needs a live call, a physical device or a packet capture

#### BE-13

**Where** — `ai/receptionist.ts:176-177 vs sip/sip-inbound.ts:61`

receptionistFor ignores assignment.disabled while lookupSipInbound honours it. Not reachable today because entryActions refuses disabled DIDs first, but the two paths disagree about the same fact.

**Fix** — Apply the same check in both.

#### BE-14

**Where** — `numbers/routes/verified-numbers.ts:66-76`

action "request" starts a carrier SMS or voice verification against any E.164 number with no ownership pre-check and no rate limit; a conflict is only detected later at assignment, and that error falls through to a generic 500.

**Fix** — Pre-check ownership, rate-limit per tenant, and map the conflict to a 409.

#### BE-15

**Where** — `numbers/number-config.ts:175-191`

saveBusinessVoiceConfig commits the configuration, then issues N carrier PATCHes under Promise.all. One carrier failure rejects after the durable write, leaving numbers split across connections while the caller sees a 500.

**Fix** — Reconcile after the write, or make the carrier step idempotent and retried.

#### BE-16

**Where** — `calling/call-event-store.ts:44-50 with sip/sip-cdr.ts:187`

storeCallEvent accepts whatever vocivo_org the CDR carries without checking it against config.organizations, so orphan events are storable by anything holding SIP_EDGE_SECRET.

**Fix** — Validate the organization id against the config before storing.

---

## How these findings were produced

Four independent line-by-line reviews were run against the current head of `main`, one per surface (API, web, mobile, SIP edge and services), each asked to confirm every finding by reading the code path end to end on both sides of any boundary, and to separate what it could prove from what it could not. The build, typecheck and test suites were run for each surface. Live evidence came from the SIP edge itself: a call trace covering ninety minutes of real traffic, which confirmed the receptionist answering, hold music and the speech bed loading, and a caller ending a 109-second conversation normally.

No penetration testing was performed, no physical iOS or Android device was exercised, and no packet captures were taken. Those gaps are why several items are marked *Verify*.
