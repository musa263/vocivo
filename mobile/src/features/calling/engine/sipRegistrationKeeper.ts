/**
 * Keeps a SIP registration alive across a phone's ordinary life: the socket to
 * the edge drops when the app goes to the background, when Wi-Fi hands over to
 * cellular, when a lift door closes. SIP.js itself never reconnects and never
 * re-REGISTERs after a reconnect, so without this a phone that changed
 * networks once silently stopped ringing until the app was restarted.
 *
 * Pure logic, so it is tested without a socket: the stack hands in the four
 * things it can do (is the transport up, reconnect it, send REGISTER, is the
 * registration current) and this decides when to do them.
 */

export type RegistrationKeeperDeps = {
  isConnected: () => boolean;
  reconnect: () => Promise<void>;
  /** Sends REGISTER. Rejects on failure; the keeper reports the reason. */
  register: () => Promise<void>;
  isRegistered: () => boolean;
  /**
   * Reports a state the UI should show: `Reconnecting` while the socket is
   * being brought back or credentials are renewing (bounded media grace),
   * `Unregistered` for a non-recoverable registrar refusal.
   */
  notify: (state: 'Unregistered' | 'Reconnecting', reason: string) => void;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
  /** A rejection that means "a REGISTER is already in flight", not a failure. */
  isPending?: (error: unknown) => boolean;
};

/**
 * How long to wait before the n-th attempt to get the socket back: 1s, 2s, 4s,
 * 8s, 16s, then every 30s for as long as the registration is wanted. A phone
 * that lost coverage in a lift is back within the first few; one that is off
 * the network for an hour keeps trying quietly rather than giving up.
 */
export function reconnectDelayMs(attempt: number) {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, Math.min(attempt, 5)));
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createRegistrationKeeper(deps: RegistrationKeeperDeps) {
  const schedule = deps.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const cancelSchedule = deps.cancelSchedule ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const isPending = deps.isPending ?? (() => false);
  let wanted = false;
  let attempt = 0;
  let timer: unknown = null;
  let generation = 0;
  let running = false;
  let needsRegistration = false;

  const clearRetry = () => {
    if (timer !== null) cancelSchedule(timer);
    timer = null;
  };

  const scheduleRetry = () => {
    if (!wanted || timer !== null) return;
    const current = generation;
    timer = schedule(() => {
      if (current !== generation) return;
      timer = null;
      void recover('retry');
    }, reconnectDelayMs(attempt++));
  };

  const recover = async (why: string) => {
    if (!wanted || running) return;
    const current = generation;
    running = true;
    try {
      if (!deps.isConnected()) {
        needsRegistration = true;
        await deps.reconnect();
      }
      if (!wanted || current !== generation) return;
      if (needsRegistration || !deps.isRegistered()) {
        needsRegistration = false;
        await deps.register();
      }
      if (deps.isRegistered()) {
        attempt = 0;
        clearRetry();
      }
    } catch (error) {
      if (wanted && current === generation && !isPending(error)) {
        needsRegistration = true;
        deps.notify('Reconnecting', `${why}: ${describe(error)}`);
      }
    } finally {
      running = false;
      if (wanted && current === generation && (needsRegistration || !deps.isConnected() || !deps.isRegistered())) scheduleRetry();
    }
  };

  return {
    onConnect: () => { void recover('reconnected'); },
    onRegistered: () => {
      needsRegistration = false;
      attempt = 0;
      clearRetry();
    },
    onUnregistered: () => {
      if (!wanted) return;
      needsRegistration = true;
      // SIP.js emits Unregistered before its final-response delegate. It can
      // mean expiry or a temporary failure. Credential refusals also get the
      // bounded grace while HTTPS renewal establishes whether access is valid.
      deps.notify('Reconnecting', 'registration is being renewed');
      scheduleRetry();
    },
    onRejected: (status: number, reason: string) => {
      if (!wanted) return;
      needsRegistration = true;
      const temporary = status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
      deps.notify(temporary || !deps.isConnected() ? 'Reconnecting' : 'Unregistered', `${status} ${reason}`);
      scheduleRetry();
    },
    onDisconnect: (error?: unknown) => {
      if (!wanted) return;
      needsRegistration = true;
      deps.notify('Reconnecting', error ? `connection lost: ${describe(error)}` : 'connection closed');
      scheduleRetry();
    },
    start: async () => {
      wanted = true;
      await recover('register');
    },
    stop: () => {
      wanted = false;
      generation += 1;
      clearRetry();
    },
    refresh: async () => {
      // Local Connected/Registered flags can survive an OS network migration.
      // An explicit refresh must validate the contact with the registrar.
      needsRegistration = true;
      clearRetry();
      await recover('refresh');
    },
    get wanted() { return wanted; },
  };
}

export type RegistrationKeeper = ReturnType<typeof createRegistrationKeeper>;
