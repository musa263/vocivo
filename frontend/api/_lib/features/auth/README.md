# Authentication

`routes/auth-login.ts` verifies passwords after IP/account throttling;
`auth.ts` creates signed sessions and exposes `requireSession`, `requireAdmin`
and `requireOwner` as the three authorization entry points. Do not substitute
session presence for role checks. `admin-account-access.ts` controls who may
grant administrative roles and edit other accounts.

Password/profile/session HTTP operations are in `routes/`. The owner credential
store, profile store and session revocation helpers own persistence. Mobile
bootstrap aggregates permitted data after authentication; it is not SIP startup.
Colocated tests cover revocation, role boundaries and escalation. Run frontend
`npm test` and `npm run check:api` after changes.

Session restoration returns 401 for explicit identity/revocation or JWT failures.
Temporary authority, PBX configuration and subscription failures return 503 with
Retry-After, preserving the client's transient-error path and cookies. This does
not authorize requests while a dependency is unavailable. The session route tests
cover both outcomes; browser and physical active-call acceptance remain separate.

## Owner login storage

`owner-password.ts` verifies the owner's bcrypt password using the encrypted
`vocivo/auth/owner.bin` record in the current Prisma Postgres database. Login and
password changes never call Telnyx. A missing record may use the server-only
`APP_PASSWORD_HASH` bootstrap value for a new installation. Database errors or
unreadable stored credentials fail closed; they do not revive a bootstrap hash.
Tenant account passwords remain bcrypt hashes in `vocivo_saas_admins`.

For an installation still using a legacy carrier password tag, run
`node --import tsx scripts/migrate-owner-credential.mjs --env-file /protected/env`
from `frontend` to dry-run. With migration authorization, add `--apply` to copy
and verify the same hash in encrypted storage before deploying this login code.
The import refuses to overwrite an existing different password. Deploy and
verify the new storage path, then run with `--apply --remove-legacy-tag` to
remove only the retired password tag. Preserve unrelated carrier tags.
Neither the migration nor its output contains the plaintext password.

Test with the owner-password regression suite and `bash verify.sh`. Hash equality
proves password preservation; a real signed-in browser remains a separate
acceptance check. The web uses an HttpOnly `vocivo_session` cookie, mobile uses
SecureStore, and both use the Vercel API's signed `vocivo-vercel` sessions.

Mobile bootstrap resolves current tenant carrier records when the company uses
BYOC, exposing only its published numbers and connection status. No carrier
password or Telnyx inventory lookup is part of that response.

Company email/password accounts also support `user` and `manager` roles linked
to a current company extension. The historical `vocivo_saas_admins` table and
function names remain for compatibility; account presence never grants admin
access. `requireAdmin` still permits only company owners/administrators or the
platform owner. New account sessions bind to the current password hash, and
company account sessions cannot omit that binding. Identity, active status, extension
and role are rechecked; password resets invalidate new session generations.
Platform owner sessions also bind to the current encrypted password hash.
Sessions issued before this binding was required must sign in again; password
resets invalidate previously issued owner and company account sessions.
Temporary passwords require the existing first-login password-change flow.
Test `company-account.test.ts` and the complete repository gate.
