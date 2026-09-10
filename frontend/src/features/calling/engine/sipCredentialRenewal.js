/**
 * When the browser phone may replace its SIP password.
 *
 * Replacing it tears the phone down and brings it back, so a call in progress
 * is waited out, and a connection still being built has nothing to replace
 * yet. Both cases have to come back and ask again: the pending branch used to
 * return without arming anything, and a short credential whose renewal landed
 * before `connectSipUserAgent` resolved ended the renewal chain for good — the
 * password then expired under a running phone, the next re-registration was
 * refused, and calls stopped arriving with "Ready for calls" still on screen.
 *
 * Pure logic, so it is tested without a phone.
 *
 * @returns {number|null} milliseconds to wait before asking again, or null to
 * renew now.
 */
export function credentialRenewalDelayMs({ onCall, connectionPending }) {
  if (onCall) return 60_000;
  if (connectionPending) return 5_000;
  return null;
}
