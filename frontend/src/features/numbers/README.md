# Web Numbers

`CallerIdMenu` selects an assigned caller ID. `VerifiedNumbersPanel` manages
verification actions. `RatesView` displays destination rates; `countries.js`
provides country metadata used by the dialer. These components cannot authorize
a number themselves; backend number routes enforce organization ownership.

Validate external versus extension mode, an empty number list, and long country
labels at mobile widths. Run frontend tests and build after changes.

Company administration is BYOC-first: `admin/numbers/NumbersPage` shows previous
company numbers with an accessible removal modal, and links to SIP trunks for the
carrier form. `CarrierTrunksPanel` lives on the SIP trunks section alone — two
copies of it gave one trunk two revision counters — where it publishes the
inventory and edits individual destinations.
Every saved DID is visible even when unassigned or pending activation. Password
fields are write-only; details show whether one is stored. Test with
`node scripts/test-carrier-admin.mjs` using the Playwright module and Vite on 5191.

App bootstrap retains `source: carrier` entries in the caller-ID menu. Pending
lines remain visible with their status; the dialer disables external calls for
them while internal calls remain independent. The full-App startup browser
harness covers all five imported DIDs, pending admission and ready selection.

`useCallerNumbers.ts` refreshes the lightweight tenant number endpoint separately
from wallet/rates bootstrap. It single-flights requests within the current
account, ignores late responses from an old scope, and preserves loaded choices
on temporary failure. The picker exposes loading, empty and retry states. A
refresh does not change the SIP session identity or restart calling. The full-App
test covers carrier selection and recovery from an inventory outage.
