# 8. Application security engineer — periodic specialist

**9 open items** — 2 High, 5 Medium, 1 Low, 1 Verify.

> Part of the Vocivo defect allocation. The full picture across all eight roles is in [Vocivo-Open-Defects-by-Role.docx](../Vocivo-Open-Defects-by-Role.docx); the role definitions are in [Vocivo-Engineering-Roles-and-Responsibilities.docx](../Vocivo-Engineering-Roles-and-Responsibilities.docx).

## What this role owns

Tenant isolation, SIP abuse and toll fraud, secrets, authorization and exposed services — reviewed periodically rather than continuously.

## First results to deliver

Review trunk provisioning and call authorization. Test cross-tenant denial, replay protection, destination restrictions and privileged access.

## Required skills

- Threat modelling for multi-tenant applications and SIP systems
- Authentication, role authorization, token signatures, Digest and replay prevention
- Testing tenant isolation, database permissions, API abuse and toll-fraud restrictions
- Reviewing TLS, secret storage and rotation, service ACLs and TURN relay controls
- Scoped penetration tests, inspecting sensitive logging and dependencies, turning findings into regression tests

## Start here

**SEC-1** and **SEC-2** — these are the items a customer feels on an ordinary call.

**SEC-2** is not a code change and does not need an engagement to start: those credentials have been exposed and should be rotated this week regardless of everything else in this document.

---

## Open items

### High — a call is dropped, silenced, misrouted to another company, or a console is unusable

#### SEC-1

**Where** — `frontend/api/_lib/features/numbers/carrier-runtime.ts:71 with kamailio.cfg:505`

Cross-tenant call injection: a platform-assigned DID is matched on digits alone while every address in VOCIVO_TRUNK_SOURCES is trusted, and that list now includes tenant carrier IPs. One tenant’s trunk can ring another tenant’s staff, receptionist and voicemail with a chosen caller ID. This is the highest-risk finding in the review.

**Fix** — Own the threat model and the regression test; fix jointly with Backend (BE-1).

#### SEC-2

**Where** — `Credential rotation backlog`

Every secret that passed through a chat transcript is still live: the Telnyx API key, the APNs key 67M3934HS9, the Firebase service account, and the GitHub token used for pushes. The Telnyx trunk ip_authentication_token was printed once into a workflow log. Any one of these is a direct route to toll fraud or to the deployment pipeline.

**Fix** — Rotate all of them, then verify nothing in the tree or in CI still references the old values.

### Medium — a feature is broken, a setting is silently wrong, or an operator is shown the wrong customer

#### SEC-3

**Where** — `services/sip/freeswitch/autoload_configs/event_socket.conf.xml:10 and directory/default.xml:4`

The default ESL password ClueCon and a hardcoded directory password, mitigated only by a loopback bind — but every container runs network_mode: host, so that loopback is shared with the TTS and receptionist images, both of which pull PyTorch. Any dependency compromise there yields full fs_cli: originate calls, eavesdrop with uuid_record, run system commands.

**Fix** — Generate the ESL password at container start; drop the unused static directory password.

#### SEC-4

**Where** — `services/sip/freeswitch/docker-entrypoint.sh with dialplan/public.xml:44`

The edge secret is rendered into a curl dialplan action that FreeSWITCH prints in its log, and the logs ops action ships those lines into the workflow log. A working secret therefore sits in plaintext on the droplet and in CI output.

**Fix** — Keep the secret out of printed actions; review what the logs action is permitted to ship. Joint with DevOps (OPS-4).

#### SEC-5

**Where** — `mobile sign-out (MOB-3, MOB-6)`

A seven-day Digest password survives sign-out, and each sign-in cycle leaves another live, up to the six-credential cap. A handed-on or lost handset can register and place calls for a week: a toll-fraud exposure, not only a privacy one.

**Fix** — Review the credential lifecycle end to end and add the revocation regression test.

#### SEC-6

**Where** — `services/tts/app/main.py:355-362 with :197`

The audio endpoint is the only route without the authorize dependency, and its id is sha256 of voice, speed and input. Anyone who can guess a tenant’s greeting text and voice, both audible to any caller, can fetch that tenant’s rendered prompt from the public base URL, and can enumerate the fixed canned phrases across all voices.

**Fix** — Key the public path on a random per-render id, or sign the URL as the voicemail upload path already does.

#### SEC-7

**Where** — `Toll fraud and destination restrictions`

The role brief calls for destination restrictions and toll-fraud limits; no per-tenant destination allowlist, spend ceiling or velocity limit was found on the outbound path.

**Fix** — Define and test per-tenant destination and spend restrictions.

### Low — dead code, a cosmetic defect, or a latent hazard

#### SEC-9

**Where** — `frontend/src/shared/api.js:39-40 with :60`

The login path is in the retryable set and 429 is treated as temporary, so a rate-limited user burns three attempts per click and accelerates the lockout the limiter exists to impose.

**Fix** — Exclude 429 from retries on auth paths.

### Verify — a credible defect that could not be proved from the source alone — needs a live call, a physical device or a packet capture

#### SEC-8

**Where** — `sip/routes/voice-sip-auth.ts:55-59 vs :113`

The internal-call authorization path calls authorizeSipCall with a route token and request user but no organizationId, while the Digest path passes the matched organization. A route token presented by a device other than the one it was issued to would be accepted. Not confirmed exploitable: Kamailio reaches ROUTE_CHECK only for registered senders and tokens live 300 seconds.

**Fix** — Bind the token to the issuing credential and prove the negative case.

---

## How these findings were produced

Four independent line-by-line reviews were run against the current head of `main`, one per surface (API, web, mobile, SIP edge and services), each asked to confirm every finding by reading the code path end to end on both sides of any boundary, and to separate what it could prove from what it could not. The build, typecheck and test suites were run for each surface. Live evidence came from the SIP edge itself: a call trace covering ninety minutes of real traffic, which confirmed the receptionist answering, hold music and the speech bed loading, and a caller ending a 109-second conversation normally.

No penetration testing was performed, no physical iOS or Android device was exercised, and no packet captures were taken. Those gaps are why several items are marked *Verify*.
