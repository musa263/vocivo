import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import NetInfo, { type NetInfoStateType } from '@react-native-community/netinfo';
import { AppState, NativeModules, Platform } from 'react-native';
import { createManagedTokenConfig as createTokenConfig, ManagedVoiceRuntime } from './runtime/managedVoiceRuntime';
import type { VoiceEdge } from './runtime/voiceEdge';
import { ensureSipRegistration } from './runtime/sipNative';
import { api } from '../../shared/api';
import { pushEnvironment } from './runtime/pushEnvironment';
import { loadIncomingRingtone } from './media/ringtone';
import { persistVoiceSession, rememberVoicePushDeviceId, voicePushDeviceId, voipClient, type VoiceDeviceRegistration } from './runtime/voipClient';
import { CallState, ConnectionState, isTerminalVoiceCallState, type VoiceCall, type VoiceCallState, type VoiceConnectionState } from './engine/voiceEngine';
import { voice } from './engine/voiceClientFacade';
import { CallLifecycleRegistry, isSettledLocalHangupError, isTerminalCallState, transactCallWaiting } from './state/callLifecycle';
import { attachIceFailureListener, isSetupSignalingBlip, isTransportNetworkMigration, isVoiceSessionFresh, VoiceMediaRecoveryCoordinator, waitForBidirectionalMedia } from './media/voiceRecovery';
import { ensureCallMicrophonePermission } from './media/callAudioPermission';
import type { ActiveCall, CallerNumber, CallRate, MergedConference } from '../../shared/types';
import { identityExtension, inviteHeader, visibleCallAddress, visibleCallerName } from './engine/callIdentity';
import { toLifecycleState, toUiCallPhase, waitForCallState } from './engine/callState';
import type { VoiceContextValue, VoiceLoginConfig, VoiceTokenResponse } from './engine/contracts';
import { createRouteId, outboundHeaders, voiceLoginConfig, waitForVoiceConnection, waitForVoicePushToken } from './engine/session';
import { useVoiceRegistration } from './engine/useVoiceRegistration';
import { useAuth } from '../auth/AuthContext';
import { routeCancellations } from './runtime/routeCancellation';
import { useVoicePresence } from './state/useVoicePresence';

/** A call that is over: nothing more will happen on it. */
const isTerminalCall = (state: VoiceCallState) => isTerminalVoiceCallState(state);

/** A call with media negotiated: talking, or on hold. */
const isConnectedCall = (state: VoiceCallState) => state === CallState.ACTIVE || state === CallState.HELD;

/** A call still being set up — no audio yet either way. */
const isSettingUpCall = (state: VoiceCallState) => state === CallState.RINGING || state === CallState.CONNECTING;

/** A call worth watching the media of — it is up, or on its way up. */
const isLiveCall = (state: VoiceCallState) => state === CallState.CONNECTING || state === CallState.ACTIVE || state === CallState.DROPPED;

const VoiceContext = createContext<VoiceContextValue | null>(null);

/**
 * How long a call is kept while the signalling socket to Vocivo's edge is being
 * reconnected. Long enough for a lift or a Wi-Fi-to-cellular handover, short
 * enough that a caller is not left talking to a dead line for minutes.
 */
const signallingReconnectGraceMs = 45_000;

export function VoiceProvider({ children, bootstrapSession, onEngineSelected }: { children: React.ReactNode; bootstrapSession?: VoiceLoginConfig | null; onEngineSelected?: (edge: VoiceEdge | null) => void }) {
  const { loading, isAuthenticated, addHistory, profile } = useAuth();
  const [connection, setConnection] = useState(voice.currentConnectionState);
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [waitingCall, setWaitingCall] = useState<ActiveCall | null>(null);
  const [heldCall, setHeldCall] = useState<ActiveCall | null>(null);
  useVoicePresence(isAuthenticated && profile?.account_type === 'business' && profile?.organization_id && profile?.id
    ? JSON.stringify([profile.organization_id, profile.id]) : '', connection === ConnectionState.CONNECTED, Boolean(activeCall || waitingCall || heldCall));
  // Read by callbacks the subscription effect depends on. Listing `heldCall`
  // itself in their dependencies re-ran that effect on every change; the
  // calls subject replays on subscribe and the handler built a new object
  // each time, so holding a second call looped the provider until React gave
  // up and the boundary showed "Vocivo could not start" mid-call.
  const heldCallRef = useRef<ActiveCall | null>(null);
  heldCallRef.current = heldCall;
  const [conference, setConference] = useState<MergedConference | null>(null);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pushRegistration, setPushRegistration] = useState<VoiceContextValue['pushRegistration']>('registering');
  const callRef = useRef<VoiceCall | null>(null);
  const callMetaRef = useRef(new Map<string, Partial<ActiveCall>>());
  const callRouteIdsRef = useRef(new Map<string, string>());
  const conferenceCallIdsRef = useRef(new Set<string>());
  const multiCallBusyRef = useRef(false);
  const startingCallRef = useRef(false);
  const startAttemptRef = useRef(0);
  const attachTimersRef = useRef(new Map<string, Array<ReturnType<typeof setTimeout>>>());
  const activeCallRef = useRef<ActiveCall | null>(null);
  const durationRef = useRef(0);
  const loggedCalls = useRef(new Set<string>());
  const lifecycleRef = useRef(new CallLifecycleRegistry());
  const callSubscriptions = useRef(new Map<string, Array<{ unsubscribe: () => void }>>());
  const routePollsRef = useRef(new Map<string, { cancelled: boolean; timer?: ReturnType<typeof setTimeout>; wake?: () => void }>());
  const routePhaseByCallRef = useRef(new Map<string, string>());
  const mediaConfirmInFlightRef = useRef(new Set<string>());
  const mediaConfirmationAbortsRef = useRef(new Map<string, AbortController>());
  const loginConfigRef = useRef<VoiceLoginConfig | null>(null);
  const iceListenerCleanupRef = useRef(new Map<string, () => void>());
  const lastNetworkTypeRef = useRef<NetInfoStateType | null>(null);
  const networkMigrationGraceUntilRef = useRef(0);
  const transportLossTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reportVoiceError = useCallback((operation: string, failure: unknown) => {
    const normalized = failure instanceof Error ? failure : new Error(String(failure));
    console.error(`[Vocivo Voice] ${operation} failed`, { message: normalized.message, stack: normalized.stack });
  }, []);
  const mediaRecoveryRef = useRef(new VoiceMediaRecoveryCoordinator(
    (operation, failure) => {
      const normalized = failure instanceof Error ? failure : new Error(String(failure));
      console.error(`[Vocivo Voice] ${operation} failed`, { message: normalized.message, stack: normalized.stack });
    },
  ));

  // SIP ringback is driven by actual 180/183 progress in callUi and native audio.
  // Route reservation alone must never synthesize a ringing recipient.
  const startRingback = useCallback(() => undefined, []);
  const stopRingback = useCallback(() => undefined, []);

  const cancelRoutePolling = useCallback((callId?: string) => {
    const targets = callId
      ? [[callId, routePollsRef.current.get(callId)] as const]
      : Array.from(routePollsRef.current.entries());
    targets.forEach(([id, monitor]) => {
      if (!monitor) return;
      monitor.cancelled = true;
      if (monitor.timer) clearTimeout(monitor.timer);
      monitor.wake?.();
      routePollsRef.current.delete(id);
    });
  }, []);

  const clearCallSubscriptions = useCallback((callId?: string) => {
    const ids = callId ? [callId] : [...new Set([...callSubscriptions.current.keys(), ...mediaConfirmationAbortsRef.current.keys()])];
    ids.forEach((id) => {
      mediaConfirmationAbortsRef.current.get(id)?.abort();
      mediaConfirmationAbortsRef.current.delete(id);
      mediaRecoveryRef.current.cancel(id);
      iceListenerCleanupRef.current.get(id)?.();
      iceListenerCleanupRef.current.delete(id);
      callSubscriptions.current.get(id)?.forEach((subscription) => subscription.unsubscribe());
      callSubscriptions.current.delete(id);
      (attachTimersRef.current.get(id) || []).forEach((timer) => clearTimeout(timer));
      attachTimersRef.current.delete(id);
    });
    if (!callId) {
      attachTimersRef.current.forEach((timers) => timers.forEach((timer) => clearTimeout(timer)));
      attachTimersRef.current.clear();
    }
  }, []);

  const cancelRemoteRoute = useCallback((routeId?: string) => {
    if (!routeId) return Promise.resolve();
    return routeCancellations.cancel(routeId);
  }, []);

  const terminateCall = useCallback((callId: string, routeId?: string) => lifecycleRef.current.terminate(callId, async () => {
    const call = voice.getCall(callId);
    // Retain an observed result while SIP terminates, so a fast HTTP failure
    // cannot become an unhandled rejection. Both operations must complete.
    const cancelRemote = cancelRemoteRoute(routeId).then(() => null, (failure: unknown) => ({ failure }));
    try {
      if (call) await call.hangup();
      else await voice.endNativeCall(callId);
    } catch (error) {
      const latest = voice.getCall(callId);
      const alreadyEnded = !latest
        || isTerminalCall(latest.currentState)
        || isTerminalCallState(lifecycleRef.current.state(callId))
        || isSettledLocalHangupError(error);
      if (!alreadyEnded) throw error;
    }
    const canceled = await cancelRemote;
    if (canceled) throw canceled.failure;
  }), [cancelRemoteRoute]);

  const retryRemoteCancellations = useCallback(() => {
    void routeCancellations.flush().catch(failure => reportVoiceError('retry queued call cancellation', failure));
  }, [reportVoiceError]);

  useEffect(() => {
    retryRemoteCancellations();
    const resume = AppState.addEventListener('change', state => { if (state === 'active') retryRemoteCancellations(); });
    const timer = setInterval(retryRemoteCancellations, 30_000);
    return () => { resume.remove(); clearInterval(timer); };
  }, [retryRemoteCancellations]);

  useEffect(() => { activeCallRef.current = activeCall; }, [activeCall]);
  useEffect(() => { durationRef.current = duration; }, [duration]);

  const describeCall = useCallback((call: VoiceCall): ActiveCall => {
    const meta = callMetaRef.current.get(call.callId) ?? {};
    const displayMatch = call.callerName?.trim().match(/^(.+?)\s*-\s*Ext(?:ension)?\s+(\d{2,5})$/i);
    const internalExtension = identityExtension(inviteHeader(call, 'X-Vocivo-Caller-Extension') || '') || displayMatch?.[2];
    const internalName = inviteHeader(call, 'X-Vocivo-Caller-Name') || displayMatch?.[1];
    const isInternal = Boolean(internalExtension || inviteHeader(call, 'X-Vocivo-Call-Type') === 'internal' || meta.destinationCountry === 'Internal');
    const fallbackNumber = call.isIncoming ? call.callerNumber : call.destination;
    const usableCallerName = /^vocivo$/i.test(call.callerName?.trim() || '') ? '' : visibleCallerName(call.callerName);
    const fallbackName = usableCallerName || (isInternal ? 'Company colleague' : visibleCallAddress(call.destination));
    return {
      id: call.callId,
      number: meta.number || internalExtension || visibleCallAddress(fallbackNumber),
      displayName: visibleCallerName(meta.displayName) || visibleCallerName(internalName) || fallbackName,
      identityAddress: fallbackNumber,
      destinationCountry: meta.destinationCountry || (isInternal ? 'Internal' : undefined),
      countryCode: meta.countryCode,
      ratePerMinute: meta.ratePerMinute,
      phase: toUiCallPhase(call.currentState, meta.connectedAt),
      startedAt: meta.startedAt || Date.now(),
      connectedAt: meta.connectedAt,
      muted: call.currentIsMuted,
      speaker: false,
      onHold: call.currentIsHeld,
      isIncoming: call.isIncoming,
      photoUrl: meta.photoUrl || inviteHeader(call, 'X-Vocivo-Caller-Photo') || undefined,
      routeId: meta.routeId || inviteHeader(call, 'X-Vocivo-Route-ID'),
      callerId: meta.callerId,
    };
  }, []);

  const finalizeCall = useCallback((phase: 'ended' | 'failed', callId?: string) => {
    const current = activeCallRef.current;
    const id = callId || current?.id || '';
    const nativeCall = id ? voice.getCall(id) : undefined;
    const meta = id ? callMetaRef.current.get(id) : undefined;
    const described = nativeCall ? describeCall(nativeCall) : null;
    const snapshot = current?.id === id ? current : described ? { ...described, ...meta, id } : null;
    if (!snapshot || !id) return;
    routePhaseByCallRef.current.delete(id);
    if (loggedCalls.current.has(id)) return;
    loggedCalls.current.add(id);
    const seconds = current?.id === id
      ? durationRef.current
      : nativeCall?.currentDuration ?? (snapshot.connectedAt ? Math.max(0, Math.floor((Date.now() - snapshot.connectedAt) / 1000)) : 0);
    const totalCost = snapshot.ratePerMinute ? Math.ceil(seconds / 60) * snapshot.ratePerMinute : 0;
    const historyEntry = {
      id,
      destination_number: snapshot.number === 'Internal call' ? snapshot.identityAddress || snapshot.number : snapshot.number,
      destination_name: snapshot.displayName !== snapshot.destinationCountry ? snapshot.displayName : undefined,
      destination_country: snapshot.destinationCountry,
      duration_seconds: seconds,
      total_cost: Number(totalCost.toFixed(4)),
      status: phase === 'ended' && Boolean(snapshot.connectedAt) ? 'completed' : snapshot.isIncoming ? 'missed' : 'no_answer',
      started_at: new Date(snapshot.startedAt).toISOString(),
      // Every row the server sends carries a direction, and the merge matches on
      // it. Logging this one without meant the same call could not recognise
      // itself once it came back from the server, so every outbound call showed
      // up twice in Recents after the first sync.
      direction: snapshot.isIncoming ? 'incoming' as const : 'outgoing' as const,
      internal: snapshot.destinationCountry === 'Internal',
    } as const;

    try {
      void Promise.resolve(addHistory(historyEntry)).catch((failure) => {
        loggedCalls.current.delete(id);
        reportVoiceError('save call history', failure);
      });
    } catch (failure) {
      loggedCalls.current.delete(id);
      reportVoiceError('save call history', failure);
    }
  }, [addHistory, describeCall, reportVoiceError]);

  const confirmMediaConnected = useCallback(async (call: VoiceCall) => {
    if (mediaConfirmInFlightRef.current.has(call.callId)) return;
    mediaConfirmInFlightRef.current.add(call.callId);
    const abort = new AbortController();
    mediaConfirmationAbortsRef.current.set(call.callId, abort);
    try {
    const stillThisCall = () => !abort.signal.aborted && activeCallRef.current?.id === call.callId
      && call.currentState === CallState.ACTIVE
      && !lifecycleRef.current.isTerminating(call.callId);
    if (!stillThisCall()) return;
    // Telnyx answers the local agent leg before the destination. Its existing
    // route monitor supplies the remote answer; direct SIP needs no such leg.
    if (voice.currentEngine !== 'sip' && !call.isIncoming && callRouteIdsRef.current.has(call.callId)
      && routePhaseByCallRef.current.get(call.callId) !== 'connected') return;
    const existing = callMetaRef.current.get(call.callId) ?? {};
    const connectedAt = existing.connectedAt ?? Date.now();
    callMetaRef.current.set(call.callId, { ...existing, connectedAt });
    cancelRoutePolling(call.callId);
    setActiveCall((current) => {
      if (current?.id !== call.callId) return current;
      const next = { ...current, phase: 'active' as const, connectedAt };
      activeCallRef.current = next;
      return next;
    });
    let mediaReady = await waitForBidirectionalMedia(call, 8_000, abort.signal);
    if (!stillThisCall()) return;
    if (!mediaReady) {
      try {
        await mediaRecoveryRef.current.recover(call, 'active-call-media-not-ready');
      } catch (failure) {
        reportVoiceError('recover active call media', failure);
      }
      if (!stillThisCall()) return;
      mediaReady = await waitForBidirectionalMedia(call, 8_000, abort.signal);
    }
    if (!mediaReady) {
      if (stillThisCall()) setError('The call is connected, but audio is still starting. Stay on the call.');
      return;
    }
    setError(null);
    } finally {
      mediaConfirmInFlightRef.current.delete(call.callId);
      if (mediaConfirmationAbortsRef.current.get(call.callId) === abort) mediaConfirmationAbortsRef.current.delete(call.callId);
    }
  }, [cancelRoutePolling, reportVoiceError]);

  const attachCall = useCallback((call: VoiceCall | null) => {
    callRef.current = call;
    if (!call) {
      activeCallRef.current = null;
      durationRef.current = 0;
      setActiveCall(null);
      setDuration(0);
      return;
    }
    const currentLifecycle = lifecycleRef.current.state(call.callId);
    if (isTerminalCallState(currentLifecycle)) return;
    if (lifecycleRef.current.isTerminating(call.callId) && !isTerminalCall(call.currentState)) {
      return;
    }
    const initialLifecycle = toLifecycleState(call.currentState);
    lifecycleRef.current.transition(call.callId, initialLifecycle);
    if (isTerminalCallState(initialLifecycle)) return;

    const base = describeCall(call);
    setNotice(null);
    const bindIceListener = () => {
      if (iceListenerCleanupRef.current.has(call.callId)) return;
      const cleanup = attachIceFailureListener(call, (reason) => {
        mediaRecoveryRef.current.recover(call, reason).catch((failure) => reportVoiceError(reason, failure));
      });
      if (cleanup) iceListenerCleanupRef.current.set(call.callId, cleanup);
    };
    bindIceListener();
    if (!callMetaRef.current.has(call.callId)) {
      callMetaRef.current.set(call.callId, {
        startedAt: base.startedAt,
        connectedAt: base.connectedAt,
        routeId: inviteHeader(call, 'X-Vocivo-Route-ID') || undefined,
      });
    }
    const incomingRouteId = inviteHeader(call, 'X-Vocivo-Route-ID');
    if (incomingRouteId && !callRouteIdsRef.current.has(call.callId)) callRouteIdsRef.current.set(call.callId, incomingRouteId);
    // The observable replays ACTIVE synchronously below; publish the ref
    // before subscribing rather than waiting for React to run an updater.
    const attached = { ...base, speaker: activeCallRef.current?.speaker ?? base.speaker };
    activeCallRef.current = attached;
    setActiveCall(attached);
    const connectedAt = callMetaRef.current.get(call.callId)?.connectedAt;
    const seconds = connectedAt ? Math.max(0, Math.floor((Date.now() - connectedAt) / 1000)) : 0;
    durationRef.current = seconds;
    setDuration(seconds);

    if (callSubscriptions.current.has(call.callId)) return;
    const subscriptions = [
      call.callState$.subscribe((state) => {
        if (isLiveCall(state)) bindIceListener();
        const lifecycleState = toLifecycleState(state);
        const previousLifecycleState = lifecycleRef.current.state(call.callId);
        const transitioned = lifecycleRef.current.transition(call.callId, lifecycleState);
        if (!transitioned && previousLifecycleState !== lifecycleState) {
          return;
        }
        if (state === CallState.ACTIVE) {
          stopRingback();
          void confirmMediaConnected(call).catch((failure) => reportVoiceError('confirm bidirectional media', failure));
        }
        const phase = toUiCallPhase(state, callMetaRef.current.get(call.callId)?.connectedAt);
        const takeRemainingCall = (remaining: typeof call) => {
          if (remaining.currentState === CallState.HELD) remaining.resume().catch((failure) => reportVoiceError('resume remaining call', failure));
          voice.setActiveCall(remaining.callId);
          attachCall(remaining);
        };
        if (phase === 'ended' || phase === 'failed') {
          if (!call.isIncoming && !callMetaRef.current.get(call.callId)?.connectedAt) {
            if ([408, 480].includes(call.terminationCode ?? 0)) {
              setNotice(`${base.displayName || 'The person you called'} is unavailable right now. Please try again later.`);
            } else if ([486, 600].includes(call.terminationCode ?? 0)) {
              setNotice('The line is busy. Please try again later.');
            } else if (call.terminationCode === 603) {
              setNotice('The call was declined.');
            }
          }
          cancelRoutePolling(call.callId);
          stopRingback();
          finalizeCall(phase, call.callId);
          callRouteIdsRef.current.delete(call.callId);
          callMetaRef.current.delete(call.callId);
          clearCallSubscriptions(call.callId);
          const remainingNow = voice.currentCalls.find((candidate) => candidate.callId !== call.callId && !isTerminalCall(candidate.currentState));
          if (remainingNow) {
            takeRemainingCall(remainingNow);
            return;
          }
          const releaseTimer = setTimeout(() => lifecycleRef.current.release(call.callId), 60_000);
          const resumeTimer = setTimeout(() => {
            // A newer call (optimistic or attached) now owns the UI; this ended call's teardown must not clear it.
            if (activeCallRef.current && activeCallRef.current.id !== call.callId) return;
            const remaining = voice.currentCalls.find((candidate) => candidate.callId !== call.callId && !isTerminalCall(candidate.currentState));
            if (remaining) {
              takeRemainingCall(remaining);
              return;
            }
            setActiveCall((current) => {
              if (current?.id !== call.callId) return current;
              const next = { ...current, phase };
              activeCallRef.current = next;
              return next;
            });
            attachCall(null);
          }, 200);
          attachTimersRef.current.set(call.callId, [releaseTimer, resumeTimer]);
          return;
        }
        setActiveCall((current) => {
          if (current?.id !== call.callId) return current;
          const next = { ...current, phase, connectedAt: callMetaRef.current.get(call.callId)?.connectedAt ?? current.connectedAt };
          activeCallRef.current = next;
          return next;
        });
      }),
      call.isMuted$.subscribe((muted) => setActiveCall((current) => current?.id === call.callId ? { ...current, muted } : current)),
      call.isHeld$.subscribe((onHold) => setActiveCall((current) => current?.id === call.callId ? { ...current, onHold } : current)),
    ];
    callSubscriptions.current.set(call.callId, subscriptions);
  }, [cancelRoutePolling, clearCallSubscriptions, confirmMediaConnected, describeCall, finalizeCall, reportVoiceError, stopRingback]);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((network) => {
      if (network.isConnected === true) retryRemoteCancellations();
      const previous = lastNetworkTypeRef.current;
      lastNetworkTypeRef.current = network.type;
      if (!isTransportNetworkMigration(previous, network.type) || network.isConnected !== true) return;
      networkMigrationGraceUntilRef.current = Date.now() + 5_000;
      const current = callRef.current;
      const phase = activeCallRef.current?.phase;
      if (!current || !['active', 'connecting', 'ringing'].includes(phase || '')) return;
      mediaRecoveryRef.current.recover(current, `network-${previous}-to-${network.type}`)
        .catch((failure) => reportVoiceError('network migration recovery', failure));
    });
    return unsubscribe;
  }, [reportVoiceError, retryRemoteCancellations]);

  const emergencyTransportCleanup = useCallback((state: VoiceConnectionState) => {
    startAttemptRef.current += 1;
    if (transportLossTimerRef.current) clearTimeout(transportLossTimerRef.current);
    transportLossTimerRef.current = null;
    networkMigrationGraceUntilRef.current = 0;
    const calls = voice.currentCalls.filter((call) => !isTerminalCall(call.currentState));
    if (activeCallRef.current) finalizeCall('failed', activeCallRef.current.id);
    const held = heldCallRef.current;
    if (held) finalizeCall('failed', held.id);
    calls.forEach((call) => {
      if (call.callId !== activeCallRef.current?.id && call.callId !== held?.id) finalizeCall('failed', call.callId);
    });
    if (!calls.length && !activeCallRef.current) return;
    cancelRoutePolling();
    stopRingback();
    clearCallSubscriptions();
    conferenceCallIdsRef.current.clear();
    setConference(null);
    setWaitingCall(null);
    setHeldCall(null);
    setDuration(0);
    durationRef.current = 0;
    activeCallRef.current = null;
    callRef.current = null;
    setActiveCall(null);
    setError(`The calling connection was lost (${state.toLowerCase()}). The call was closed safely.`);
    calls.forEach((call) => {
      lifecycleRef.current.transition(call.callId, 'FAILED');
      const routeId = callRouteIdsRef.current.get(call.callId) || callMetaRef.current.get(call.callId)?.routeId;
      void cancelRemoteRoute(routeId).catch(failure => {
        reportVoiceError('queue remote cancellation after transport loss', failure);
        setNotice('Call closed on this device. Remote cancellation will retry when connected.');
      });
      void voice.emergencyEndCall(call.callId).catch((failure) => reportVoiceError('dispose call after transport loss', failure));
      callRouteIdsRef.current.delete(call.callId);
      callMetaRef.current.delete(call.callId);
    });
  }, [cancelRemoteRoute, cancelRoutePolling, clearCallSubscriptions, finalizeCall, reportVoiceError, stopRingback]);

  /**
   * Holds a call while the signalling is away, and closes it if it stays away.
   *
   * Media does not travel over the signalling socket, so a call already up
   * survives losing it. Repeated failures cannot extend the original deadline.
   */
  const armSignallingGrace = useCallback((state: VoiceConnectionState) => {
    if (transportLossTimerRef.current) return;
    transportLossTimerRef.current = setTimeout(() => {
      transportLossTimerRef.current = null;
      if (voice.currentConnectionState !== ConnectionState.CONNECTED) emergencyTransportCleanup(state);
    }, signallingReconnectGraceMs);
  }, [emergencyTransportCleanup]);

  useEffect(() => {
    const connectionSubscription = voice.connectionState$.subscribe((state) => {
      setConnection(state);
      if (state === ConnectionState.CONNECTED) {
        retryRemoteCancellations();
        if (transportLossTimerRef.current) clearTimeout(transportLossTimerRef.current);
        transportLossTimerRef.current = null;
        const current = callRef.current;
        if (current && networkMigrationGraceUntilRef.current > Date.now()) {
          mediaRecoveryRef.current.recover(current, 'signaling-reconnected-after-network-migration')
            .catch((failure) => reportVoiceError('post-migration media recovery', failure));
        }
        networkMigrationGraceUntilRef.current = 0;
        return;
      }
      if (state === ConnectionState.DISCONNECTED && networkMigrationGraceUntilRef.current > Date.now()) {
        if (transportLossTimerRef.current) clearTimeout(transportLossTimerRef.current);
        const delay = Math.max(0, networkMigrationGraceUntilRef.current - Date.now());
        transportLossTimerRef.current = setTimeout(() => {
          if (voice.currentConnectionState !== ConnectionState.CONNECTED) emergencyTransportCleanup(state);
        }, delay);
        return;
      }
      if (state === ConnectionState.RECONNECTING) {
        // The signalling socket dropped and the stack is bringing it back.
        armSignallingGrace(ConnectionState.DISCONNECTED);
        return;
      }
      const liveCalls = voice.currentCalls.filter((call) => !isTerminalCall(call.currentState));
      if (state === ConnectionState.DISCONNECTED && isSetupSignalingBlip(liveCalls.length, activeCallRef.current?.id)) return;
      if (state === ConnectionState.ERROR || state === ConnectionState.DISCONNECTED) {
        // A registration that is refused for good — a 403 on one of the
        // periodic re-REGISTERs, say — arrives here as ERROR rather than
        // RECONNECTING, and used to close the call on the spot. The audio of a
        // call already up owes nothing to that registration, so it is given the
        // same grace: if the edge is still gone when the deadline passes, the
        // call is treated as lost, and if it is not, the conversation carried on
        // through a refusal the person never had to hear about.
        if (liveCalls.length) {
          armSignallingGrace(state);
          return;
        }
        emergencyTransportCleanup(state);
      }
    });
    const callsSubscription = voice.calls$.subscribe((calls) => {
      const currentId = voice.currentActiveCall?.callId;
      const waiting = calls.find((call) => call.callId !== currentId && call.isIncoming && call.currentState === CallState.RINGING);
      const held = calls.find((call) => call.callId !== currentId && call.currentState === CallState.HELD);
      setWaitingCall(waiting ? describeCall(waiting) : null);
      const mergedCalls = Array.from(conferenceCallIdsRef.current)
        .map((id) => calls.find((call) => call.callId === id))
        .filter((call): call is VoiceCall => Boolean(call && !isTerminalCall(call.currentState)));
      if (conferenceCallIdsRef.current.size && mergedCalls.length >= 1) {
        setHeldCall(null);
      } else {
        if (conferenceCallIdsRef.current.size) {
          conferenceCallIdsRef.current.clear();
          setConference(null);
        }
        const next = held ? describeCall(held) : null;
        setHeldCall((previous) => (previous && next && (['id', 'phase', 'number', 'onHold', 'muted', 'connectedAt', 'displayName'] as const).every((key) => previous[key] === next[key]) ? previous : next));
      }
    });
    const callSubscription = voice.activeCall$.subscribe(attachCall);
    if (voice.currentActiveCall) attachCall(voice.currentActiveCall);
    return () => {
      connectionSubscription.unsubscribe();
      callsSubscription.unsubscribe();
      callSubscription.unsubscribe();
      if (transportLossTimerRef.current) clearTimeout(transportLossTimerRef.current);
      transportLossTimerRef.current = null;
      clearCallSubscriptions();
      lifecycleRef.current.clear();
    };
  }, [armSignallingGrace, attachCall, clearCallSubscriptions, describeCall, emergencyTransportCleanup, reportVoiceError, retryRemoteCancellations]);

  useEffect(() => {
    if (!isAuthenticated) return;
    void ensureCallMicrophonePermission().catch((failure) => reportVoiceError('request microphone permission', failure));
  }, [isAuthenticated, reportVoiceError]);

  useVoiceRegistration({
    onEngineSelected,
    activeCallRef,
    bootstrapSession,
    isAuthenticated,
    loading,
    loginConfigRef,
    reportVoiceError,
    setError,
    setPushRegistration,
  });

  const refreshIncomingCalls = useCallback(async () => {
    try {
      setPushRegistration('registering');
      if (!voice.currentEngine) throw new Error('The calling service is still starting up.');
      if (voice.currentEngine === 'sip') {
        await ensureSipRegistration(true);
        const pushToken = await waitForVoicePushToken();
        if (!pushToken) {
          setPushRegistration('unavailable');
          throw new Error('The device has not provided a calling push token. Allow notifications and try again.');
        }
        const deviceId = await voicePushDeviceId();
        const registration = await api.post<VoiceDeviceRegistration>('/api/voice/devices', {
          platform: Platform.OS === 'ios' ? 'ios' : 'android', token: pushToken,
          environment: pushEnvironment(NativeModules.VocivoSip?.pushEnvironment, __DEV__), bundleId: 'app.vocivo.mobile',
          ...(deviceId ? { deviceId } : {}),
        });
        await rememberVoicePushDeviceId(registration?.device?.id);
        setPushRegistration('registered');
        return;
      }
      let data = loginConfigRef.current;
      if (!isVoiceSessionFresh(data, 60_000)) {
        const session = await api.post<VoiceTokenResponse>('/api/telnyx/token', {});
        data = voiceLoginConfig(session, await loadIncomingRingtone());
      }
      loginConfigRef.current = data;
      await persistVoiceSession(data);
      const pushToken = await waitForVoicePushToken();
      if (!pushToken) {
        setPushRegistration('unavailable');
        throw new Error(`${Platform.OS === 'ios' ? 'iPhone' : 'Android'} did not provide a push token. Allow notifications, then reopen Vocivo and try again.`);
      }
      await voipClient.loginWithToken(createTokenConfig(data.token, {
        debug: __DEV__, pushNotificationDeviceToken: pushToken, pushWhenActive: true,
        enableMissedCallNotifications: true, incomingCallRingtone: data.ringtone, useTrickleIce: true,
        ...(data.iceServers ? { iceServers: data.iceServers } : {}),
      }));
      setPushRegistration('registered');
    } catch (failure) {
      setPushRegistration('unavailable');
      throw failure;
    }
  }, []);

  const followRoute = useCallback(async (routeId: string, callId: string) => {
    cancelRoutePolling(callId);
    const monitor: { cancelled: boolean; timer?: ReturnType<typeof setTimeout>; wake?: () => void } = { cancelled: false };
    routePollsRef.current.set(callId, monitor);
    let lastRouteError: unknown;
    for (let attempt = 0; attempt < 100 && !monitor.cancelled; attempt += 1) {
      try {
        const result = await api.get<{ phase: 'dialing' | 'ringing' | 'connected' | 'ended' | 'failed'; connectedAt?: string; failureCause?: string }>(`/api/voice/status?routeId=${encodeURIComponent(routeId)}`);
        if (result.phase === 'connected') {
          routePhaseByCallRef.current.set(callId, 'connected');
          stopRingback();
          const answered = voice.getCall(callId);
          if (answered?.currentState === CallState.ACTIVE) {
            void confirmMediaConnected(answered).catch((failure) => reportVoiceError('confirm answered route media', failure));
          }
        }
        if (monitor.cancelled) return;
        const sdkCall = voice.getCall(callId);
        const sdkIsLive = Boolean(sdkCall && isConnectedCall(sdkCall.currentState));
        // On Vocivo's own edge nothing ever advances an outbound external route
        // to 'connected': voice-progress is posted by the callee, and only on
        // internal calls. The engine's own ACTIVE is the answer here. Waiting
        // for the route instead let the poll run to its end about fifty-five
        // seconds into a conversation that was already up, and told the caller
        // that setting the call up was taking longer than expected.
        if (sdkIsLive && voice.currentEngine === 'sip') {
          cancelRoutePolling(callId);
          stopRingback();
          return;
        }
        if (sdkIsLive && (result.phase === 'connected' || result.phase === 'ended' || result.phase === 'failed')) {
          cancelRoutePolling(callId);
          stopRingback();
          if (result.phase === 'connected') return;
        }
        if (result.phase === 'failed' || result.phase === 'ended') {
          stopRingback();
          if (result.phase === 'failed' && result.failureCause) setError(`Call failed: ${result.failureCause.replaceAll('_', ' ')}.`);
          // Yield once so an SDK ACTIVE event queued with this webhook wins the
          // state mutex before route cleanup can claim a ringing call.
          await new Promise((resolve) => setTimeout(resolve, 0));
          const latestSdkCall = voice.getCall(callId);
          const latestLifecycle = lifecycleRef.current.state(callId);
          const isNowLive = Boolean(latestSdkCall && isConnectedCall(latestSdkCall.currentState))
            || ['ACTIVE', 'HELD'].includes(latestLifecycle);
          if (isNowLive || monitor.cancelled) {
            cancelRoutePolling(callId);
            return;
          }
          if (!latestSdkCall || isSettingUpCall(latestSdkCall.currentState)) {
            try {
              await terminateCall(callId, routeId);
            } catch (failure) {
              reportVoiceError('terminate failed route', failure);
              setError('The call route ended, but signaling cleanup failed. Tap end call to retry.');
            }
          }
          return;
        }
      } catch (routeError) {
        // Route status is advisory; the Telnyx SDK owns the live media call.
        // A brief Vercel/network polling failure must never tear down a healthy
        // SIP session. Keep polling and only fail at the full setup deadline.
        lastRouteError = routeError;
        if (attempt === 9 || attempt === 39) reportVoiceError('poll extension route status', routeError);
      }
      await new Promise<void>((resolve) => {
        monitor.wake = resolve;
        monitor.timer = setTimeout(resolve, attempt < 40 ? 250 : 750);
      });
      monitor.timer = undefined;
      monitor.wake = undefined;
    }
    if (!monitor.cancelled) {
      stopRingback();
      setError(lastRouteError instanceof Error ? 'Call status could not be confirmed. The live call remains available.' : 'Call setup is taking longer than expected.');
    }
    if (routePollsRef.current.get(callId) === monitor) routePollsRef.current.delete(callId);
  }, [cancelRoutePolling, confirmMediaConnected, reportVoiceError, stopRingback, terminateCall]);

  const startCall = useCallback(async (number: string, rate: CallRate, callerNumber?: CallerNumber | null, displayName?: string, photoUrl?: string) => {
    setError(null);
    if (startingCallRef.current) throw new Error('A call is already starting.');
    startingCallRef.current = true;
    const guardAttempt = startAttemptRef.current;
    try {
      await ensureCallMicrophonePermission();
      await waitForVoiceConnection();
    } catch (setupError) {
      if (startAttemptRef.current === guardAttempt) startingCallRef.current = false;
      throw setupError;
    }
    const routeId = createRouteId();
    const attempt = ++startAttemptRef.current;
    const startedAt = Date.now();
    const optimisticCall: ActiveCall = { number, displayName: displayName || rate.country_name, destinationCountry: rate.country_name, countryCode: rate.country_code, ratePerMinute: rate.rate_per_min ?? undefined, photoUrl, phase: 'connecting', startedAt, muted: false, speaker: false, onHold: false, routeId };
    activeCallRef.current = optimisticCall;
    setActiveCall(optimisticCall);
    try {
      const reservation = await api.post<{ routeId: string; routeToken: string; callerId?: string }>('/api/voice/route', { routeId, destination: number, callerId: callerNumber?.phone_number, flow: 'outbound' });
      if (startAttemptRef.current !== attempt) {
        await api.post('/api/voice/cancel', { routeId }).catch((failure) => reportVoiceError('cancel failed outbound route', failure));
        return;
      }
      startRingback();
      const call = await voice.newCall(number, profile?.full_name || 'Vocivo', reservation.callerId, outboundHeaders(number, reservation.callerId, 'outbound', routeId, reservation.routeToken));
      if (startAttemptRef.current !== attempt) {
        await Promise.all([
          call.hangup().catch((failure) => reportVoiceError('hang up failed outbound call', failure)),
          api.post('/api/voice/cancel', { routeId }).catch((failure) => reportVoiceError('cancel rejected outbound route', failure)),
        ]);
        return;
      }
      callRouteIdsRef.current.set(call.callId, routeId);
      callMetaRef.current.set(call.callId, { displayName: displayName || rate.country_name, destinationCountry: rate.country_name, countryCode: rate.country_code, ratePerMinute: rate.rate_per_min ?? undefined, photoUrl, startedAt, routeId, callerId: reservation.callerId });
      attachCall(call);
      followRoute(routeId, call.callId);
    } catch (startError) {
      stopRingback();
      await api.post('/api/voice/cancel', { routeId }).catch((failure) => reportVoiceError('cancel failed outbound route', failure));
      if (startAttemptRef.current === attempt) {
        activeCallRef.current = null;
        setActiveCall(null);
      }
      throw startError;
    } finally {
      if (startAttemptRef.current === attempt) startingCallRef.current = false;
    }
  }, [attachCall, followRoute, profile?.full_name, startRingback, stopRingback]);

  const startSecondCall = useCallback(async (number: string, rate: CallRate, callerNumber?: CallerNumber | null) => {
    if (connection !== ConnectionState.CONNECTED) throw new Error('Call service is still connecting.');
    if (multiCallBusyRef.current) throw new Error('Another call action is still completing.');
    if (voice.currentCalls.some((call) => call.currentState === CallState.HELD)) throw new Error('Resume or merge the held call before adding another caller.');
    const current = voice.currentActiveCall;
    if (!current || current.currentState !== CallState.ACTIVE) throw new Error('Connect the first call before adding another caller.');
    if (!callerNumber?.phone_number) throw new Error('Choose a caller ID before adding an external caller.');
    multiCallBusyRef.current = true;
    const routeId = createRouteId();
    const attempt = startAttemptRef.current;
    try {
      await current.hold();
      if (startAttemptRef.current !== attempt) throw new Error('The first call ended before the second caller could be added.');
      const reservation = await api.post<{ routeId: string; routeToken: string; callerId?: string }>('/api/voice/route', { routeId, destination: number, callerId: callerNumber?.phone_number, flow: 'outbound' });
      if (startAttemptRef.current !== attempt) {
        await api.post('/api/voice/cancel', { routeId }).catch((failure) => reportVoiceError('cancel superseded second-call route', failure));
        throw new Error('The first call ended before the second caller could be added.');
      }
      startRingback();
      const call = await voice.newCall(number, profile?.full_name || 'Vocivo', reservation.callerId, outboundHeaders(number, reservation.callerId, 'outbound', routeId, reservation.routeToken));
      if (startAttemptRef.current !== attempt) {
        await Promise.all([
          call.hangup().catch((failure) => reportVoiceError('hang up superseded second call', failure)),
          api.post('/api/voice/cancel', { routeId }).catch((failure) => reportVoiceError('cancel superseded second-call route', failure)),
        ]);
        throw new Error('The first call ended before the second caller could be added.');
      }
      callRouteIdsRef.current.set(call.callId, routeId);
      callMetaRef.current.set(call.callId, { displayName: rate.country_name, countryCode: rate.country_code, ratePerMinute: rate.rate_per_min ?? undefined, startedAt: Date.now(), routeId, callerId: reservation.callerId });
      voice.setActiveCall(call.callId);
      attachCall(call);
      followRoute(routeId, call.callId);
    } catch (secondCallError) {
      stopRingback();
      await api.post('/api/voice/cancel', { routeId }).catch((failure) => reportVoiceError('cancel failed second-call route', failure));
      await current.resume().catch((failure) => reportVoiceError('roll back held outbound call', failure));
      voice.setActiveCall(current.callId);
      attachCall(current);
      throw secondCallError;
    } finally {
      multiCallBusyRef.current = false;
    }
  }, [attachCall, connection, followRoute, profile?.full_name, startRingback, stopRingback]);

  const startInternalCall = useCallback(async (sipUsername: string, extension: string, displayName: string, photoUrl?: string) => {
    setError(null);
    if (startingCallRef.current) throw new Error('A call is already starting.');
    startingCallRef.current = true;
    const guardAttempt = startAttemptRef.current;
    try {
      await ensureCallMicrophonePermission();
      await waitForVoiceConnection();
    } catch (setupError) {
      if (startAttemptRef.current === guardAttempt) startingCallRef.current = false;
      throw setupError;
    }
    // The API decides which host an extension lives on (Vocivo's own edge or
    // the carrier) and answers with the address to dial; the bare username is
    // enough to ask. A hard-coded carrier host here dialled the wrong edge.
    const destination = sipUsername ? `sip:${sipUsername}` : '';
    const routeId = createRouteId();
    const attempt = ++startAttemptRef.current;
    const startedAt = Date.now();
    const optimisticCall: ActiveCall = { number: extension, displayName, destinationCountry: 'Internal', photoUrl, phase: 'connecting', startedAt, muted: false, speaker: false, onHold: false, routeId };
    activeCallRef.current = optimisticCall;
    setActiveCall(optimisticCall);
    try {
      const reservation = await api.post<{ routeToken: string; callerName: string; callerExtension: string; destinationName?: string; destinationExtension?: string; destination: string }>('/api/voice/route', { routeId, destination, targetExtension: extension, flow: 'internal' });
      if (startAttemptRef.current !== attempt) {
        await api.post('/api/voice/cancel', { routeId }).catch((failure) => reportVoiceError('cancel failed internal route', failure));
        return;
      }
      startRingback();
      const remoteName = reservation.destinationName || displayName;
      const remoteExtension = reservation.destinationExtension || extension;
      const call = await voice.newCall(
        reservation.destination,
        reservation.callerName || profile?.full_name || 'Vocivo',
        reservation.callerExtension || profile?.extension,
        outboundHeaders(reservation.destination, undefined, 'internal', routeId, reservation.routeToken, { name: remoteName, extension: remoteExtension }),
      );
      if (startAttemptRef.current !== attempt) {
        await Promise.all([
          call.hangup().catch((failure) => reportVoiceError('hang up failed internal call', failure)),
          api.post('/api/voice/cancel', { routeId }).catch((failure) => reportVoiceError('cancel rejected internal route', failure)),
        ]);
        return;
      }
      callRouteIdsRef.current.set(call.callId, routeId);
      callMetaRef.current.set(call.callId, { number: remoteExtension, displayName: remoteName, destinationCountry: 'Internal', photoUrl, startedAt, routeId });
      attachCall(call);
      followRoute(routeId, call.callId);
    } catch (startError) {
      stopRingback();
      await api.post('/api/voice/cancel', { routeId }).catch((failure) => reportVoiceError('cancel failed internal route', failure));
      if (startAttemptRef.current === attempt) {
        activeCallRef.current = null;
        setActiveCall(null);
      }
      throw startError;
    } finally {
      if (startAttemptRef.current === attempt) startingCallRef.current = false;
    }
  }, [attachCall, followRoute, profile?.extension, profile?.full_name, startRingback, stopRingback]);

  const transferCall = useCallback(async (targetExtensionId: string) => {
    await api.post('/api/voice/transfer', { targetExtensionId });
  }, []);

  const answerWaitingCall = useCallback(async () => {
    if (!waitingCall?.id) return;
    const incoming = voice.getCall(waitingCall.id);
    const current = voice.currentActiveCall;
    if (!incoming) return;
    await ensureCallMicrophonePermission();
    await transactCallWaiting({
      answerIncoming: async () => {
        await incoming.answer();
        await waitForCallState(incoming, CallState.ACTIVE);
      },
      isIncomingAcknowledged: () => incoming.currentState === CallState.ACTIVE,
      holdCurrent: async () => {
        if (current && current.callId !== incoming.callId && current.currentState === CallState.ACTIVE) await current.hold();
      },
      activateIncoming: () => {
        voice.setActiveCall(incoming.callId);
        attachCall(incoming);
      },
      rollbackIncoming: async () => {
        try {
          await incoming.hangup();
        } catch (rollbackFailure) {
          reportVoiceError('roll back waiting call', rollbackFailure);
          throw rollbackFailure;
        }
      },
      restoreCurrent: () => {
        if (!current) return;
        voice.setActiveCall(current.callId);
        attachCall(current);
      },
    });
  }, [attachCall, reportVoiceError, waitingCall?.id]);

  const rejectWaitingCall = useCallback(async () => {
    if (!waitingCall?.id) return;
    await voice.getCall(waitingCall.id)?.hangup();
  }, [waitingCall?.id]);

  const swapCalls = useCallback(async () => {
    if (!heldCall?.id) throw new Error('There is no held call to swap.');
    if (multiCallBusyRef.current) throw new Error('Another call action is still completing.');
    const target = voice.getCall(heldCall.id);
    if (!target) throw new Error('The held call is no longer available.');
    const current = voice.currentActiveCall;
    if (!current || current.currentState !== CallState.ACTIVE) throw new Error('Wait for the active call to connect before swapping.');
    if (target.currentState !== CallState.HELD) throw new Error('The other call is not on hold yet.');
    multiCallBusyRef.current = true;
    try {
      await voice.swapCalls(target.callId);
      voice.setActiveCall(target.callId);
      attachCall(target);
    } finally {
      multiCallBusyRef.current = false;
    }
  }, [attachCall, heldCall?.id]);

  const mergeCalls = useCallback(async () => {
    if (conferenceCallIdsRef.current.size) throw new Error('These calls are already merged.');
    if (multiCallBusyRef.current) throw new Error('Another call action is still completing.');
    const current = voice.currentActiveCall;
    const held = heldCall?.id ? voice.getCall(heldCall.id) : undefined;
    if (!current || !held || current.currentState !== CallState.ACTIVE || held.currentState !== CallState.HELD) {
      throw new Error('Connect the second call before merging.');
    }
    const routeIds = [current.callId, held.callId].map((id) => callRouteIdsRef.current.get(id)).filter((id): id is string => Boolean(id));
    if (routeIds.length !== 2) throw new Error('Both calls must be placed from the Vocivo dialer before they can be merged.');
    multiCallBusyRef.current = true;
    try {
      const result = await api.post<{ conferenceId: string }>('/api/voice/merge', { routeIds });
      conferenceCallIdsRef.current = new Set([current.callId, held.callId]);
      setConference({ id: result.conferenceId, participants: [describeCall(held), describeCall(current)] });
      setHeldCall(null);
    } finally {
      multiCallBusyRef.current = false;
    }
  }, [describeCall, heldCall?.id]);

  const removeConferenceParticipant = useCallback(async (participantId: string) => {
    const currentConference = conference;
    const participant = currentConference?.participants.find((item) => item.id === participantId);
    if (!currentConference || !participant?.routeId) throw new Error('This conference participant is no longer available.');
    if (participant.id === currentConference.participants[0]?.id) throw new Error('The primary caller cannot be removed while the conference is active.');
    if (multiCallBusyRef.current) throw new Error('Another call action is still completing.');
    multiCallBusyRef.current = true;
    try {
      await api.post('/api/voice/merge', {
        action: 'remove_participant',
        conferenceId: currentConference.id,
        routeId: participant.routeId,
      });
      const remaining = currentConference.participants.filter((item) => item.id !== participantId);
      const primary = remaining[0];
      const localHostId = activeCallRef.current?.id;
      if (participant.id && participant.id !== localHostId) {
        callRouteIdsRef.current.delete(participant.id);
        callMetaRef.current.delete(participant.id);
      }
      if (participant.id === localHostId && primary && localHostId) {
        if (primary.routeId) callRouteIdsRef.current.set(localHostId, primary.routeId);
        callMetaRef.current.set(localHostId, { ...primary, id: undefined });
        setActiveCall((current) => {
          if (current?.id !== localHostId) return current;
          const next = { ...current, ...primary, id: localHostId, phase: current.phase, connectedAt: current.connectedAt, onHold: false };
          activeCallRef.current = next;
          return next;
        });
      }
      setConference((current) => current?.id === currentConference.id ? { ...current, participants: remaining } : current);
    } finally {
      multiCallBusyRef.current = false;
    }
  }, [conference]);

  useEffect(() => {
    if (activeCall?.phase !== 'active' || !activeCall.connectedAt) return;
    const update = () => {
      const seconds = Math.max(0, Math.floor((Date.now() - activeCall.connectedAt!) / 1000));
      durationRef.current = seconds;
      setDuration(seconds);
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [activeCall?.connectedAt, activeCall?.phase]);

  const endCall = useCallback(async () => {
    startAttemptRef.current += 1;
    startingCallRef.current = false;
    cancelRoutePolling();
    stopRingback();
    const endingIds = conferenceCallIdsRef.current.size
      ? [...conferenceCallIdsRef.current]
      : [activeCall?.id || callRef.current?.callId].filter((id): id is string => Boolean(id));
    endingIds.forEach((id) => {
      (attachTimersRef.current.get(id) || []).forEach((timer) => clearTimeout(timer));
      attachTimersRef.current.delete(id);
    });
    if (conferenceCallIdsRef.current.size) {
      const mergedIds = [...conferenceCallIdsRef.current];
      try {
        await Promise.all(mergedIds.map((id) => terminateCall(id, callRouteIdsRef.current.get(id))));
      } catch (failure) {
        reportVoiceError('end conference', failure);
        const stillLive = mergedIds.some((id) => {
          const latest = voice.getCall(id);
          return latest && !isTerminalCall(latest.currentState);
        });
        if (stillLive) {
          setError('Conference hangup was not acknowledged. Tap end call to retry.');
          throw failure;
        }
        setNotice('Conference closed on this device. Remote cancellation is pending and will retry.');
      }
      conferenceCallIdsRef.current.clear();
      setConference(null);
      setHeldCall(null);
      setError(null);
      finalizeCall('ended', activeCall?.id);
      activeCallRef.current = null;
      setActiveCall(null);
      return;
    }
    const callId = activeCall?.id || callRef.current?.callId;
    const routeId = activeCall?.routeId || (callId ? callRouteIdsRef.current.get(callId) : undefined);
    const resumeAfterEnd = voice.currentCalls.find((call) => call.callId !== callRef.current?.callId && call.currentState === CallState.HELD);
    if (callId) {
      try {
        await terminateCall(callId, routeId);
      } catch (failure) {
        reportVoiceError('end call', failure);
        const latest = voice.getCall(callId);
        const stillLive = Boolean(latest && !isTerminalCall(latest.currentState));
        if (stillLive) {
          setError('Hangup was not acknowledged. Tap end call to retry.');
          throw failure;
        }
        setNotice('Call closed on this device. Remote cancellation is pending and will retry.');
      }
    }
    setError(null);
    finalizeCall('ended', callId);
    activeCallRef.current = null;
    durationRef.current = 0;
    setActiveCall(null);
    setDuration(0);
    if (resumeAfterEnd) {
      await resumeAfterEnd.resume().catch((failure) => reportVoiceError('resume remaining line after hangup', failure));
      voice.setActiveCall(resumeAfterEnd.callId);
      attachCall(resumeAfterEnd);
      return;
    }
  }, [activeCall?.id, activeCall?.routeId, attachCall, cancelRoutePolling, finalizeCall, reportVoiceError, stopRingback, terminateCall]);

  const answerCall = useCallback(async () => {
    const call = callRef.current;
    if (!call || !call.isIncoming) return;
    if (!isSettingUpCall(call.currentState)) return;
    setError(null);
    await ensureCallMicrophonePermission();
    setActiveCall((current) => current?.id === call.callId ? { ...current, phase: 'connecting' } : current);
    try {
      const routeId = inviteHeader(call, 'X-Vocivo-Route-ID') || callRouteIdsRef.current.get(call.callId);
      if (routeId) {
        api.post('/api/voice/progress', { routeId, event: 'answered' }).catch((failure) => reportVoiceError('report answered route', failure));
      }
      voice.setActiveCall(call.callId);
      await call.answer();
      if (Platform.OS === 'android') await voice.hideIncomingCallUi();
      durationRef.current = 0;
      setDuration(0);
    } catch (answerError) {
      setActiveCall((current) => current?.id === call.callId ? { ...current, phase: 'ringing' } : current);
      setError(answerError instanceof Error ? answerError.message : 'The incoming call could not be answered.');
      throw answerError;
    }
  }, [reportVoiceError]);
  const toggleMute = useCallback(async () => {
    try {
      if (callRef.current) await callRef.current.toggleMute();
      else setActiveCall((current) => current ? { ...current, muted: !current.muted } : current);
    } catch (failure) {
      console.warn('[Vocivo Voice] toggle mute failed', failure);
    }
  }, []);
  const toggleHold = useCallback(async () => {
    try {
      if (callRef.current) callRef.current.currentIsHeld ? await callRef.current.resume() : await callRef.current.hold();
      else setActiveCall((current) => current ? { ...current, onHold: !current.onHold } : current);
    } catch (failure) {
      console.warn('[Vocivo Voice] toggle hold failed', failure);
    }
  }, []);
  const toggleSpeaker = useCallback(async () => {
    try {
      const speaker = await voice.toggleSpeaker();
      setActiveCall((current) => current ? { ...current, speaker } : current);
    } catch (failure) {
      reportVoiceError('toggle speaker', failure);
    }
  }, [reportVoiceError]);
  const sendDtmf = useCallback(async (digit: string) => { if (callRef.current) await callRef.current.dtmf(digit); }, []);

  const value = useMemo(() => ({ connection, activeCall, waitingCall, heldCall, conference, duration, error, notice, isReady: connection === ConnectionState.CONNECTED, pushRegistration, refreshIncomingCalls, startCall, startSecondCall, startInternalCall, transferCall, answerWaitingCall, rejectWaitingCall, swapCalls, mergeCalls, removeConferenceParticipant, endCall, answerCall, toggleMute, toggleHold, toggleSpeaker, sendDtmf }), [activeCall, answerCall, answerWaitingCall, conference, connection, duration, endCall, error, notice, heldCall, mergeCalls, pushRegistration, refreshIncomingCalls, rejectWaitingCall, removeConferenceParticipant, sendDtmf, startCall, startInternalCall, startSecondCall, swapCalls, toggleHold, toggleMute, toggleSpeaker, transferCall, waitingCall]);

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

export function VoiceRoot({ children }: { children: React.ReactNode }) {
  const { loading, isAuthenticated } = useAuth();
  const [selectedEngine, setSelectedEngine] = useState<VoiceEdge | null>(null);

  // The SIP native wake handler is installed by index.js before this UI mounts.
  // Only an authenticated managed selection may start the carrier JS runtime.
  return <>
    <VoiceProvider onEngineSelected={setSelectedEngine}>{children}</VoiceProvider>
    {!loading && isAuthenticated && selectedEngine === 'telnyx' ? <ManagedVoiceRuntime /> : null}
  </>;

}

export function useVoice() {
  const value = useContext(VoiceContext);
  if (!value) throw new Error('useVoice must be used inside VoiceRoot');
  return value;
}
