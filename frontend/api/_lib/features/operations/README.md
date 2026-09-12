# Phone operations and reporting

Shared by company administration and the Vocivo superadmin's selected customer
workspace. Flutter and native mobile source are unchanged.

## Contracts

- `GET /api/admin/operations`: administrative session, explicit tenant, analytics
  entitlement. SIP registration is observed, not inferred from account status.
  Samples expire after 45 seconds. Missing/stale or managed-Telnyx telemetry
  returns unknown counts, never invented zeroes.
- `PATCH /api/admin/operations`: administrative session and queues entitlement;
  body `{extensionId, state, version}`. Only active members of the selected tenant
  can be edited. Available/On Break are persisted; On Call is derived from
  signaling. Concurrent edits return HTTP 409.
- `GET /api/admin/reports?from=...&to=...&timezone=...`: authorized tenant reporting,
  inclusive start/exclusive end, at most 31 days, IANA chart timezone. At most
  20,000 events are scanned; `complete: false` warns of a partial report.
- `POST /api/voice/telemetry`: SIP-edge authentication only. Complete samples
  resolve SIP usernames to tenant members, omit ambiguous/conflicting ownership,
  strip transport details and save encrypted snapshots.

## Responsibilities and limits

`agent-store` uses the Postgres object transaction lock plus version comparison.
Breaks exclude members from subsequent queue attempts on SIP and managed edges.
They do not cancel ringing legs, disable direct calls or act as global DND.
A separate main-line fallback retains its configured routing policy.

`telemetry-store` encrypts AES-GCM snapshots and rejects older observations.
`telemetry` validates/splits tenants. `admin-operations` combines preferences,
registrations, calls and queues. On Call means answered signaling, not proven RTP.

`call-report` deduplicates events and joins route/session/leg aliases. It excludes
other tenants and standalone forks, anchors durations to the relevant leg and
does not use parked internal caller answers as destination answers. A ringing
loser is not the reported colleague. Ambiguous multiple answers are not assigned
an invented winner. SIP identities resolve through the tenant directory.

Answered inbound calls include IVR/AI answers. Missing terminal events mean
incomplete records, not presumed live calls. Missing upstream/deleted CDRs cannot
be reconstructed. Live counters are separate from historical reporting.

`analyzeCalls` produces top extensions, hourly bins, directions and talk time.
`wallet-store.readWalletReport` groups real movements by currency, direction and
type without changing balances. Per-call carrier costs are not yet reconciled:
cost is null, not zero. Wallet movements are not usage charges or markup profit.

## Verification and rollout

Run `bash verify.sh`, Python monitor tests and the operations browser script.
Fixtures cover tenant denial, CAS, stale data, fork correlation, queue breaks,
CSV formula injection and workspace binding. A live Postgres/edge acceptance
run remains separate. Deploy API/web before the optional collector described in
`services/sip/monitor/README.md`. Vercel alone does not start SIP monitoring.
No new database table migration is required; existing object/ledger stores are used.
