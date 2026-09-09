/**
 * Loads the company menu and greeting configuration for a workspace.
 *
 * `/api/voice/settings` refuses any organization that is not an active
 * business account, and a superadmin can open an individual customer just as
 * easily as a company. Fetching it as a required resource meant that 403 threw
 * out of the console's load before it had its configuration, so the console
 * never left its loading screen — and with an individual customer stored as
 * the active workspace it was bricked on mount. A workspace with no company
 * voice settings is a workspace whose Voice & AI section does not apply, which
 * is what `null` says here.
 */
export async function loadBusinessVoiceSettings(api, allowed) {
  if (!allowed) return null;
  return api('/api/voice/settings').then((result) => result?.config ?? null, () => null);
}
