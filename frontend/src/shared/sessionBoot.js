/**
 * The opening screen is a first-load screen only.
 *
 * It replaces the whole shell, and the shell is where the `remoteMedia` audio
 * element holding a live call's MediaStream lives, along with the incoming and
 * active call overlays. The session effect re-runs on every session identity
 * change — including the eight-second retry that hands `setSession` a fresh
 * object after a backend blip — and returning to the opening screen there
 * unmounted the audio mid-call. `attachSipMedia` only re-attaches on a new
 * track or a fresh transition to Established, so the call carried on over the
 * wire with no sound and no hangup button, every eight seconds until the
 * backend came back.
 */
export function showsOpeningScreen(loading, profile) {
  return Boolean(loading) && !profile;
}
