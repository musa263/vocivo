# 5. DevOps / Site Reliability Engineer

**8 open items** — 6 Medium, 1 Low, 1 Verify.

> Part of the Vocivo defect allocation. The full picture across all eight roles is in [Vocivo-Open-Defects-by-Role.docx](../Vocivo-Open-Defects-by-Role.docx); the role definitions are in [Vocivo-Engineering-Roles-and-Responsibilities.docx](../Vocivo-Engineering-Roles-and-Responsibilities.docx).

## What this role owns

The droplet, Docker Compose, Nginx, firewalls and certificates, the GitHub Actions ops workflows, backups and rollback.

## First results to deliver

Reproducible deployments, correct signalling and media ports, durable WSS connections, correlated call diagnostics and verified restoration after temporary carrier tests.

## Required skills

- Linux networking and DigitalOcean administration
- Docker Compose, Nginx WebSocket proxying, TLS and DNS
- Diagnosing routing, NAT and firewall rules with tcpdump, ss and UFW/nftables
- Managing signalling and RTP port ranges, restricted service access and expiring test rules
- Coordinated releases, health checks, rollback and backup restoration
- Monitoring call failures and resource capacity

## Start here

**OPS-7** — this is the item a customer feels on an ordinary call.

**OPS-2** matters most on the day it is needed least: it only bites on a first deployment or after a backup clean, which is exactly when the edge is being rebuilt under pressure.

---

## Open items

### Medium — a feature is broken, a setting is silently wrong, or an operator is shown the wrong customer

#### OPS-1

**Where** — `.github/workflows/ops-sip-edge.yml:280`

The status action, documented as a diagnostic, runs fsctl loglevel debug and permanently raises the core log level on a live media host. Anyone running status leaves the switch at DEBUG until the next restart, with per-packet SIP logging on a droplet that also holds the prompt cache and the CDR error log, and measurable CPU cost on a box carrying real-time audio.

**Fix** — Read the level rather than set it, or restore the previous value afterwards.

#### OPS-2

**Where** — `.github/workflows/ops-sip-edge.yml:358 and :459`

Two set -e traps abort sync-config on a first deployment. At :358 the [ -d /opt/vocivo/sip ] && cp -a list returns 1 when the directory does not exist and kills the shell before the staging tar. At :459 the backup ls lacks the || true its twin at :588 has, so an empty backup directory aborts the run just before the swap, after all the download and convert work.

**Fix** — Use an if block for the copy and guard the ls with || true.

#### OPS-3

**Where** — `services/sip/docker-compose.yml:3-4`

rtpengine is pinned to :latest while FreeSWITCH is digest-pinned and Kamailio version-pinned. The deploy action runs docker compose pull, so an upstream push silently swaps the component that terminates DTLS-SRTP and rewrites every SDP, with no review and no image rollback (rollback-config restores files only).

**Fix** — Pin by tag and digest like the FreeSWITCH image.

#### OPS-4

**Where** — `services/sip/freeswitch/docker-entrypoint.sh:37-41, 71-74, 84-87`

SIP_EDGE_SECRET is substituted with sed using # as the delimiter and an unescaped replacement, so a secret containing # breaks the render and & or backslash is reinterpreted. The result is an Authorization: Bearer header inside a curl dialplan action, which FreeSWITCH prints as an EXECUTE line, and the logs ops action greps EXECUTE and ships it into the workflow log.

**Fix** — Substitute with awk or python, and keep the secret out of a printed dialplan action. Joint with Security (SEC-3).

#### OPS-7

**Where** — `SIP droplet capacity`

The receptionist prompt cache grew without eviction on the same volume as Kamailio, FreeSWITCH, rtpengine and coturn, so a disk-full there is a telephony outage rather than a degraded assistant. An eviction sweep is written but not yet deployed, and there is no disk or capacity alert.

**Fix** — Deploy the sweep, then add disk, CPU and call-failure alerting. Pairs with AI-3.

#### OPS-8

**Where** — `Droplet hardening and capacity backlog`

Carried over and still open: UFW is not configured on the droplet; TURN is not offered on 443 for restrictive networks; TTS latency is bounded by the droplet’s CPU share, which is what makes the receptionist feel slow under load.

**Fix** — Firewall the host, add TURN on 443, and size the box against measured first-audio latency.

### Low — dead code, a cosmetic defect, or a latent hazard

#### OPS-5

**Where** — `.github/workflows/ops-sip-edge.yml:484 and :557`

The Kamailio noise filter uses grep -v with | alternation in a basic regex, so nothing is filtered and the error summary is flooded with TCP keepalive churn, pushing real ERROR and CRITICAL lines out of the annotation budget.

**Fix** — Use grep -vE.

### Verify — a credible defect that could not be proved from the source alone — needs a live call, a physical device or a packet capture

#### OPS-6

**Where** — `.github/workflows/ops-sip-edge.yml:483, :560`

docker compose ps | grep -q "Up" assumes the v1 status string; several compose v2 releases print "running", which would end every sync-config with a false "kamailio did not come back".

**Fix** — Check against the installed compose version and match both.

---

## How these findings were produced

Four independent line-by-line reviews were run against the current head of `main`, one per surface (API, web, mobile, SIP edge and services), each asked to confirm every finding by reading the code path end to end on both sides of any boundary, and to separate what it could prove from what it could not. The build, typecheck and test suites were run for each surface. Live evidence came from the SIP edge itself: a call trace covering ninety minutes of real traffic, which confirmed the receptionist answering, hold music and the speech bed loading, and a caller ending a 109-second conversation normally.

No penetration testing was performed, no physical iOS or Android device was exercised, and no packet captures were taken. Those gaps are why several items are marked *Verify*.
