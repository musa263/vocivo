# Live operations collector

`collector.py` samples Kamailio `ul.dump` and `dlg.list` through a private Unix
socket, then FreeSWITCH's authenticated loopback ESL (`show channels` / `uuid_dump`).
It posts only registration identity/count/expiry and live-call routing metadata
to `/api/voice/telemetry`. No contact IP, SIP password, SDP or audio is uploaded.
The API resolves identities against its directory and persists encrypted,
tenant-separated snapshots. An older sample cannot replace a newer sample.

Deploy the API first, validate Kamailio's changed socket configuration with the
pinned parser, then enable the collector with `docker compose --profile monitoring
up -d sip-monitor`. The private `monitoring-rpc` volume must exist for Kamailio.
The collector requires the rendered FreeSWITCH configuration read-only to obtain
the generated ESL password. Do not expose the RPC socket, ESL, or that volume.
There is no Docker socket mount and no call-control UI.

Collection failures, oversized datagrams and slow snapshots publish nothing.
After 45 seconds the UI shows unknown rather than zero or offline. Limits are
512 FreeSWITCH channels and 20 seconds per snapshot; test capacity on the actual
edge. Sampling is every 15 seconds; this is bounded-delay monitoring, not a
sub-second event wallboard. Only one collector is supported per edge deployment.
Multi-edge aggregation requires a separate source/epoch contract before scale-out.

Before production enablement, compare actual `ul.dump` / `dlg.list` shapes against
fixtures, verify registration/removal/expiry, internal and PSTN calls, queue wait
and connected states, and loss/restart of each source. Structural tests and mocked
ESL replies do not establish compatibility with the deployed binaries.
