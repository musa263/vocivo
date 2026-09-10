import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { AppState, NativeModules, Platform } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { createManagedTokenConfig as createTokenConfig, isManagedPushLaunch } from '../runtime/managedVoiceRuntime';
import { api } from '../../../shared/api';
import { pushEnvironment } from '../runtime/pushEnvironment';
import { applyIncomingRingtone, defaultRingtone, loadIncomingRingtone } from '../media/ringtone';
import { getVoicePushToken, loadVoiceSession, persistVoiceSession, rememberVoicePushDeviceId, voicePushDeviceId, voipClient, type VoiceDeviceRegistration } from '../runtime/voipClient';
import { ensureSipRegistration, onSipRegistration, onVocivoPushToken, refreshVocivoSip, unregisterVocivoSip } from '../runtime/sipNative';
import { sipEngine, telnyxEngine } from './engines';
import { voice } from './voiceClientFacade';
import { isVoiceSessionFresh } from '../media/voiceRecovery';
import { shouldUseSipNative, voiceEdgeFromConfig, type VoiceEdgeConfig, type VoiceEdge } from '../runtime/voiceEdge';
import type { ActiveCall } from '../../../shared/types';
import type { VoiceContextValue, VoiceLoginConfig, VoiceTokenResponse } from './contracts';
import { voiceLoginConfig } from './session';

type VoiceRegistrationInput = {
  onEngineSelected?: (edge: VoiceEdge | null) => void;
  activeCallRef: MutableRefObject<ActiveCall | null>;
  bootstrapSession?: VoiceLoginConfig | null;
  isAuthenticated: boolean;
  loading: boolean;
  loginConfigRef: MutableRefObject<VoiceLoginConfig | null>;
  reportVoiceError: (operation: string, failure: unknown) => void;
  setError: Dispatch<SetStateAction<string | null>>;
  setPushRegistration: Dispatch<SetStateAction<VoiceContextValue['pushRegistration']>>;
};

/**
 * How many times the OS may answer "no push token yet" before the app stops
 * calling it a registration in progress. Two attempts is a few seconds of the
 * ordinary case — the token is usually there on the first or second ask — and
 * anything past that is a phone whose owner has refused notifications.
 */
const unavailablePushAttempts = 2;

export function useVoiceRegistration({
  onEngineSelected,
  activeCallRef,
  bootstrapSession,
  isAuthenticated,
  loading,
  loginConfigRef,
  reportVoiceError,
  setError,
  setPushRegistration,
}: VoiceRegistrationInput) {
  // A late push bootstrap is input to startup, not a new account/engine login.
  const bootstrapSessionRef = useRef(bootstrapSession);
  bootstrapSessionRef.current = bootstrapSession;
  useEffect(() => {
    if (loading) return;
    if (!isAuthenticated) {
      onEngineSelected?.(null);
      loginConfigRef.current = null;
      // Both stacks. The carrier client alone was signed out, and the SIP
      // user agent kept its registration alive: the signed-out phone went on
      // ringing with the previous user's calls until the app was killed.
      unregisterVocivoSip().catch((failure) => reportVoiceError('SIP unregister', failure));
      voice.logout().catch((failure) => reportVoiceError('logout', failure));
      setPushRegistration('unavailable');
      return;
    }

    let canceled = false;
    let pushTokenTimer: ReturnType<typeof setTimeout> | undefined;
    let sessionRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    let activeRegistrationTimer: ReturnType<typeof setTimeout> | undefined;
    let networkRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    let sipCredentialTimer: ReturnType<typeof setTimeout> | undefined;
    let sipAuthTimer: ReturnType<typeof setTimeout> | undefined;
    let sipAuthSubscription: { remove: () => void } | undefined;
    let sipAuthAttempts = 0;
    let sipRecoveryAttempts = 0;
    let sipRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
    let startupRetryTimer: ReturnType<typeof setTimeout> | undefined;
    let appStateSubscription: ReturnType<typeof AppState.addEventListener> | undefined;
    let networkSubscription: (() => void) | undefined;
    let pushTokenSubscription: { remove: () => void } | undefined;

    const connect = async () => {
      try {
        const edgeConfig = await api.get<VoiceEdgeConfig>('/api/voice/config');
        if (canceled) return;
        const onSipEdge = voiceEdgeFromConfig(edgeConfig) === 'sip';
        if (onSipEdge && !shouldUseSipNative('sip', NativeModules)) {
          throw new Error('This build does not include Vocivo SIP calling. Install the latest app build.');
        }
        const launchedFromPush = !onSipEdge && await isManagedPushLaunch();
        if (canceled) return;
        let ringtone = defaultRingtone;
        const prepareRingtone = async () => {
          const selected = await loadIncomingRingtone();
          if (canceled) return;
          ringtone = selected;
          await applyIncomingRingtone(selected);
        };
        if (onSipEdge) {
          // Native ringtone preferences do not gate authenticated SIP signaling.
          prepareRingtone().catch((failure) => reportVoiceError('prepare incoming ringtone', failure));
        } else {
          await prepareRingtone();
        }
        if (canceled) return;
        const bootstrap = launchedFromPush
          ? bootstrapSessionRef.current || await loadVoiceSession()
          : null;
        if (canceled) return;
        const pushBootstrap = launchedFromPush && bootstrap && isVoiceSessionFresh(bootstrap, 30_000)
          ? { ...bootstrap, ringtone }
          : null;
        const initialSession = onSipEdge ? null : pushBootstrap
          || voiceLoginConfig(await api.post<VoiceTokenResponse>('/api/telnyx/token', {}), ringtone);
        if (canceled) return;
        loginConfigRef.current = initialSession;
        if (initialSession) await persistVoiceSession(initialSession);
        const pushNotificationDeviceToken = onSipEdge ? undefined : await getVoicePushToken();
        if (canceled) return;
        let storedPushToken: string | undefined;
        if (pushNotificationDeviceToken) {
          try {
            const deviceId = await voicePushDeviceId();
            const registration = await api.post<VoiceDeviceRegistration>('/api/voice/devices', {
              platform: Platform.OS === 'ios' ? 'ios' : 'android',
              token: pushNotificationDeviceToken,
              environment: pushEnvironment(NativeModules.VocivoSip?.pushEnvironment, __DEV__),
              bundleId: 'app.vocivo.mobile',
              ...(deviceId ? { deviceId } : {}),
            });
            await rememberVoicePushDeviceId(registration?.device?.id);
            storedPushToken = pushNotificationDeviceToken;
          } catch (failure) {
            reportVoiceError('register Vocivo wakeup token', failure);
          }
        }
        if (canceled) return;
        // Which engine carries the call. Until this point the app has been
        // registering with a carrier and with Vocivo's own edge both; from here
        // exactly one of them is the client the UI talks to.
        // The SIP password has a life of its own, and re-registering with an
        // expired one is refused: the registrar drops the phone and calls stop
        // arriving with nothing on screen to say so. Ask for a new one at four
        // fifths of its life, and register again with it.
        const registerOnSipEdge = async (renew = false) => {
          const expiresIn = await ensureSipRegistration(renew);
          if (canceled) return;
          scheduleSipCredentialRefresh(expiresIn);
        };

        const scheduleSipCredentialRefresh = (expiresInSeconds: number) => {
          if (sipCredentialTimer) clearTimeout(sipCredentialTimer);
          const lifetime = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds * 1000 : 60 * 60 * 1000;
          const delay = Math.min(Math.max(1000, lifetime * 0.8), 2 ** 31 - 1);
          sipCredentialTimer = setTimeout(() => {
            refreshSipCredentials().catch((failure) => reportVoiceError('scheduled SIP credential refresh', failure));
          }, delay);
        };

        const refreshSipCredentials = async () => {
          if (canceled || !onSipEdge) return;
          // Registering again re-offers the phone's contact, which a call in
          // progress does not need disturbed.
          if (activeCallRef.current) {
            if (sipCredentialTimer) clearTimeout(sipCredentialTimer);
            sipCredentialTimer = setTimeout(() => {
              refreshSipCredentials().catch((failure) => reportVoiceError('deferred SIP credential refresh', failure));
            }, 60_000);
            return;
          }
          try {
            await registerOnSipEdge(true);
          } catch (failure) {
            reportVoiceError('renew Vocivo SIP credentials', failure);
            if (canceled) return;
            if (sipCredentialTimer) clearTimeout(sipCredentialTimer);
            sipCredentialTimer = setTimeout(() => {
              refreshSipCredentials().catch((error) => reportVoiceError('SIP credential refresh retry', error));
            }, 60_000);
          }
        };

        const recoverSip = async (renew = false, renewDuringCall = false) => {
          if (canceled) return;
          if (sipRecoveryTimer) clearTimeout(sipRecoveryTimer);
          try {
            // A new stack would dispose an active/incoming call. Preserve it
            // and let signaling/media recovery run on the existing stack.
            // A Digest refusal needs fresh HTTPS credentials even in a call.
            // SipStackBridge updates same-identity credentials in place and
            // refuses identity changes while a call owns the stack.
            if (!renewDuringCall && (activeCallRef.current || (voice.currentCalls?.length ?? 0) > 0)) await refreshVocivoSip();
            else await registerOnSipEdge(renew);
            sipRecoveryAttempts = 0;
          } catch (failure) {
            reportVoiceError('recover SIP registration', failure);
            if (!canceled) sipRecoveryTimer = setTimeout(() => { void recoverSip(renew, renewDuringCall); }, Math.min(60_000, 5000 * 2 ** Math.min(sipRecoveryAttempts++, 4)));
          }
        };

        if (onSipEdge) {
          const engine = sipEngine();
          voice.use(engine.name, engine.client, engine.platform);
          onEngineSelected?.('sip');
          sipAuthSubscription?.remove();
          sipAuthSubscription = onSipRegistration((state, reason) => {
            if (canceled) return;
            if (state === 'ok') {
              setError(current => current === 'Calling service is reconnecting. Please try again in a moment.' ? null : current);
              sipAuthAttempts = 0;
              if (sipAuthTimer) clearTimeout(sipAuthTimer);
              sipAuthTimer = undefined;
            } else if (/^40[13]\b/.test(reason || '') && !sipAuthTimer) {
              // Final rejection only: SIP.js has already handled normal Digest
              // challenges. Repeating the rejected password cannot recover it.
              sipAuthTimer = setTimeout(() => {
                sipAuthTimer = undefined;
                void recoverSip(true, true);
              }, Math.min(300_000, 3000 * 2 ** Math.min(sipAuthAttempts++, 7)));
            }
          });
          await registerOnSipEdge();
        } else {
          const engine = telnyxEngine();
          voice.use(engine.name, engine.client, engine.platform);
          onEngineSelected?.('telnyx');
        }
        if (canceled) return;
        let registeredToken = storedPushToken;
        let registrationBusy = false;
        let sessionRefreshBusy = false;
        let missingTokenAttempts = 0;
        let pushTokenAttempt = 0;

        const login = async (pushToken?: string, session = loginConfigRef.current) => {
          // On the SIP edge the phone is already registered with Vocivo's own
          // Kamailio. Logging into the carrier as well would keep a second
          // signalling socket open, and route the calls it carries back through
          // the carrier — which is the whole thing this move is undoing.
          if (onSipEdge) return;
          if (!session) throw new Error('The calling session is unavailable.');
          let lastError: unknown;
          for (let attempt = 0; attempt < 3 && !canceled; attempt += 1) {
            try {
              await voipClient.loginWithToken(createTokenConfig(session.token, {
                debug: __DEV__,
                pushNotificationDeviceToken: pushToken,
                pushWhenActive: true,
                enableMissedCallNotifications: true,
                incomingCallRingtone: ringtone,
                useTrickleIce: true,
                ...(session.iceServers ? { iceServers: session.iceServers } : {}),
              }));
              return;
            } catch (loginError) {
              lastError = loginError;
              if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
            }
          }
          throw lastError instanceof Error ? lastError : new Error('Unable to connect to calling service.');
        };

        const scheduleSessionRefresh = (session: VoiceLoginConfig) => {
          if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer);
          // Refresh two minutes ahead of expiry; short-lived tokens refresh at
          // half-life, with a 250ms floor to avoid a hot loop.
          const untilExpiry = session.expiresAt - Date.now();
          const delay = Math.max(250, untilExpiry - 120_000, untilExpiry / 2);
          sessionRefreshTimer = setTimeout(() => {
            refreshSession().catch((failure) => reportVoiceError('scheduled session refresh', failure));
          }, delay);
        };

        const refreshSession = async () => {
          if (canceled || sessionRefreshBusy) return;
          if (activeCallRef.current) {
            if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer);
            sessionRefreshTimer = setTimeout(() => {
              refreshSession().catch((failure) => reportVoiceError('deferred session refresh', failure));
            }, 60_000);
            return;
          }
          sessionRefreshBusy = true;
          try {
            if (onSipEdge) return;
            const fresh = voiceLoginConfig(
              await api.post<VoiceTokenResponse>('/api/telnyx/token', {}),
              ringtone,
            );
            await persistVoiceSession(fresh);
            await login(registeredToken, fresh);
            loginConfigRef.current = fresh;
            scheduleSessionRefresh(fresh);
          } catch (refreshError) {
            if (!canceled) setError(refreshError instanceof Error ? refreshError.message : 'Calling session refresh failed.');
            if (!canceled) {
              if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer);
              sessionRefreshTimer = setTimeout(() => {
                refreshSession().catch((failure) => reportVoiceError('session refresh retry', failure));
              }, 60_000);
            }
          } finally {
            sessionRefreshBusy = false;
          }
        };

        const registerLatestDevice = async () => {
          if (canceled || registrationBusy) return;
          registrationBusy = true;
          try {
            const token = await getVoicePushToken();
            if (canceled) return;
            if (!token) {
              // Notifications refused, or the OS has simply not minted a token
              // yet. Say so rather than sitting on "registering" forever, and
              // let the caller decide how long to keep asking. Checked before
              // comparing with the registered token, which is itself undefined
              // until the first registration succeeds.
              missingTokenAttempts += 1;
              if (missingTokenAttempts >= unavailablePushAttempts) setPushRegistration('unavailable');
              return;
            }
            missingTokenAttempts = 0;
            if (token === registeredToken) return;
            setPushRegistration('registering');
            const deviceId = await voicePushDeviceId();
            const registration = await api.post<VoiceDeviceRegistration>('/api/voice/devices', {
              platform: Platform.OS === 'ios' ? 'ios' : 'android', token,
              environment: pushEnvironment(NativeModules.VocivoSip?.pushEnvironment, __DEV__), bundleId: 'app.vocivo.mobile',
              ...(deviceId ? { deviceId } : {}),
            });
            await rememberVoicePushDeviceId(registration?.device?.id);
            if (canceled) return;
            await login(token);
            registeredToken = token;
            if (!canceled) setPushRegistration('registered');
          } catch (failure) {
            reportVoiceError('register refreshed push token', failure);
            if (!canceled) setPushRegistration('unavailable');
          } finally {
            registrationBusy = false;
          }
        };

        /**
         * Keeps asking the OS for a push token until it has one.
         *
         * This used to be a two-second interval with no end to it: on a phone
         * whose owner refused notifications there is no token coming, and the
         * poll ran for as long as the app did while the UI still said push was
         * registering. Backing off caps that at one attempt a minute, and the
         * PushKit callback (`onVocivoPushToken`) short-circuits the wait when a
         * token does arrive.
         */
        const pollForPushToken = () => {
          if (canceled || registeredToken) return;
          if (pushTokenTimer) clearTimeout(pushTokenTimer);
          pushTokenTimer = setTimeout(() => {
            pushTokenTimer = undefined;
            registerLatestDevice()
              .catch((failure) => reportVoiceError('refresh push registration token', failure))
              .finally(() => { pushTokenAttempt += 1; pollForPushToken(); });
          }, Math.min(60_000, 2000 * 2 ** Math.min(pushTokenAttempt, 5)));
        };

        if (!launchedFromPush) await login(pushNotificationDeviceToken);
        if (canceled) return;
        if (initialSession) scheduleSessionRefresh(initialSession);
        setPushRegistration(registeredToken ? 'registered' : 'registering');
        if (!registeredToken) {
          // SIP can become connected while push delivery is still registering.
          // Keep push status separate and retry failures without restarting SIP.
          if (onSipEdge) {
            registerLatestDevice().catch((failure) => reportVoiceError('register Vocivo wakeup token', failure));
            pushTokenSubscription = onVocivoPushToken(() => {
              registerLatestDevice().catch((failure) => reportVoiceError('register issued VoIP token', failure));
            });
          }
          pollForPushToken();
        }
        appStateSubscription = AppState.addEventListener('change', (state) => {
          if (state !== 'active' || canceled) return;
          if (activeRegistrationTimer) clearTimeout(activeRegistrationTimer);
          activeRegistrationTimer = setTimeout(() => {
            if (onSipEdge) {
              // The socket to Vocivo's edge rarely survives a spell in the
              // background; make sure the phone is registered again before
              // the person tries to dial.
              void recoverSip(false);
              registerLatestDevice().catch((failure) => reportVoiceError('foreground SIP push token refresh', failure));
              return;
            }
            const operation = isVoiceSessionFresh(loginConfigRef.current, 30_000)
              ? registerLatestDevice()
              : refreshSession();
            operation.catch((failure) => reportVoiceError('foreground voice session validation', failure));
          }, 250);
        });
        if (onSipEdge) {
          // Wi-Fi to cellular and back changes the phone's address; the old
          // socket is dead even when the OS has not said so yet.
          let lastNetworkKey = '';
          networkSubscription = NetInfo.addEventListener((netState) => {
            if (canceled) return;
            const address = netState.details && 'ipAddress' in netState.details ? netState.details.ipAddress : '';
            const reachable = netState.isConnected === true && netState.isInternetReachable !== false;
            const key = `${netState.type}:${reachable}:${address}`;
            if (!lastNetworkKey) { lastNetworkKey = key; return; }
            if (key === lastNetworkKey || !reachable) { lastNetworkKey = key; return; }
            lastNetworkKey = key;
            if (networkRefreshTimer) clearTimeout(networkRefreshTimer);
            networkRefreshTimer = setTimeout(() => {
              void recoverSip(true);
            }, 1_000);
          });
        }
      } catch (voiceError) {
        reportVoiceError('initialize configured voice engine', voiceError);
        if (!canceled) {
          setPushRegistration('unavailable');
          setError(voiceError instanceof Error ? voiceError.message : 'Unable to connect to calling service.');
          startupRetryTimer = setTimeout(connect, 5_000);
        }
      }
    };

    connect();
    return () => {
      canceled = true;
      if (pushTokenTimer) clearTimeout(pushTokenTimer);
      pushTokenSubscription?.remove();
      if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer);
      if (activeRegistrationTimer) clearTimeout(activeRegistrationTimer);
      if (networkRefreshTimer) clearTimeout(networkRefreshTimer);
      if (sipCredentialTimer) clearTimeout(sipCredentialTimer);
      if (sipRecoveryTimer) clearTimeout(sipRecoveryTimer);
      if (sipAuthTimer) clearTimeout(sipAuthTimer);
      sipAuthSubscription?.remove();
      if (startupRetryTimer) clearTimeout(startupRetryTimer);
      appStateSubscription?.remove();
      networkSubscription?.();
    };
  }, [activeCallRef, isAuthenticated, loading, loginConfigRef, reportVoiceError, setError, setPushRegistration, onEngineSelected]);
}
