# Billing and Wallets

`wallet-store.ts` owns wallet balances, ledgers, top-ups and usage accounting.
`routes/admin-wallets.ts` exposes authorized platform/company wallet operations;
`routes/telnyx-account.ts` maps account/rate data for the client. `rates.ts` is the
rate catalog, while `outbound-policy.ts` checks allowed outbound use.

Keep provider costs separate from customer charges. Internal SIP routing bypasses
carrier balance checks in `calling/voice-provider.ts`; it must not turn a customer
extension call into a paid PSTN route. Never mutate balances outside the ledger
helpers. Colocated tests cover accounting and policy; run frontend `npm test`.

SIP external forwarding and simultaneous ring use `authorizeOutboundCall` with
the owning extension's permissions and the company's rules. An unknown numbering
region cannot establish a domestic-call exemption when international calling is
disabled. Test allowed domestic destinations as well as rejected international
and unknown-region destinations.
