import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../shared/api';
import { registerWebPush } from '../../push/webPush';
import { reportWebVoiceError } from '../engine/telemetry';
import { describeCallRejection, isRoutineCallOutcome, sipTargetUri, sipUserFromUri } from '../engine/sipDial';
import { SessionState } from 'sip.js';
import { observeSipSession, terminateSipSession } from '../engine/sipCallLifecycle';
import { monitorSipCall, restartSipMedia } from '../engine/sipCallHealth';
import { attachSipMedia, connectSipUserAgent, inviteSipTarget, sipSessionId } from '../engine/sipSession';
import { credentialRenewalDelayMs } from '../engine/sipCredentialRenewal';
import { browserSipDeviceId, revokeBrowserSipCredential } from '../engine/sipDevice';
import { describeIncoming } from '../engine/callIdentity.js';

export function useSipVoice(token, enabled, identity = {}) {
  const displayNameRef = useRef(identity.name);
  displayNameRef.current = identity.name;
  const sessionRef = useRef(null);
  const incomingRef = useRef(null);
  const sessionTeardownsRef = useRef(new Map());
  const callHealthRef = useRef(new Map());
  const routeIdRef = useRef(null);
  const credentialsRef = useRef(null);
  // Set for as long as a dial is in flight. A second click while the first
  // INVITE was still being placed replaced sessionRef with the second session
  // — leaving the first ringing on the wire with no way to hang it up, and its
  // eventual Terminated cancelling the second call's route reservation.
  const dialingRef = useRef(false);
  const dialEpochRef = useRef(0);
  const [ready, setReady] = useState(false);
  const [statusLabel, setStatusLabel] = useState('Connecting phone…');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [call, setCall] = useState(null);
  const [incomingCall, setIncomingCall] = useState(null);
  useEffect(() => {
    if (!incomingCall) navigator.serviceWorker?.controller?.postMessage({type:'vocivo.close-call-notifications'});
  }, [incomingCall]);
  const [state, setState] = useState(null);
  const [muted, setMuted] = useState(false);
  const [dialedNumber, setDialedNumber] = useState('');
  const [remoteIdentity, setRemoteIdentity] = useState({ name: 'Phone call', number: '', internal: false, photoUrl: '' });
  const [callStarting, setCallStarting] = useState(false);
  const [routePhase, setRoutePhase] = useState(null);
  const [mediaReady, setMediaReady] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [endedCall, setEndedCall] = useState(null);
  // What the Calls list needs when this call ends: direction, who, and when
  // audio was established. Filled in as the call progresses so a call the
  // *other* party ends is recorded too — until now only our own hangup wrote
  // history, in a shape ({ identity }) the list did not read.
  const callMetaRef = useRef(null);
  const recordEndedCall = useCallback((session) => {
    const meta = callMetaRef.current;
    if (!meta || meta.recorded) return;
    meta.recorded = true;
    callMetaRef.current = null;
    setEndedCall({
      id: sipSessionId(session) || meta.id,
      number: meta.number,
      name: meta.identity?.name,
      internal: meta.identity?.internal,
      address: meta.identity?.address,
      answered: Boolean(meta.connectedAt),
      direction: meta.direction,
      duration: meta.connectedAt ? Math.max(0, Math.round((Date.now() - meta.connectedAt) / 1000)) : 0,
    });
  }, []);
  const [notificationPermission, setNotificationPermission] = useState(() => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  // Bumped when the SIP password needs replacing, which tears the phone down
  // and brings it back with a new one. Without it the password expired under a
  // running phone: the next re-registration was refused and calls stopped
  // arriving, with "Ready for calls" still on screen.
  const [credentialEpoch, setCredentialEpoch] = useState(0);
  const credentialRetryAttemptRef = useRef(0);
  const ringbackRef = useRef(null);

  useEffect(() => {
    if (!incomingCall || incomingCall.state === SessionState.Established || incomingCall.state === SessionState.Terminated) return undefined;
    // A phone ringing sounds different from a phone being rung: this is the
    // ringtone, not the ringback. Louder, plus a vibration and a browser
    // notification so the call is noticed with the tab in the background.
    const tone = new Audio('/audio/ringtone.wav');
    tone.loop = true;
    tone.volume = 0.8;
    let stopped = false;
    navigator.vibrate?.([450, 250, 450, 650]);
    let notification = null;
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const peer = describeIncoming(incomingCall);
      notification = new Notification(peer.name, { body: peer.number, icon: '/vocivo-icon-192.png', tag: `vocivo-incoming-${sipSessionId(incomingCall) || 'call'}`, requireInteraction: true });
      notification.onclick = () => { window.focus(); notification.close(); };
    }
    const stop = () => { stopped = true; tone.pause(); tone.currentTime = 0; notification?.close?.(); navigator.vibrate?.(0); };
    const onState = (next) => {
      if (next === SessionState.Established || next === SessionState.Terminated) stop();
    };
    incomingCall.stateChange.addListener(onState);
    tone.play().then(() => { if (stopped) tone.pause(); }).catch((failure) => reportWebVoiceError('play incoming SIP ringtone', failure));
    return () => { stop(); incomingCall.stateChange.removeListener(onState); };
  }, [incomingCall]);

  const stopRingback = useCallback(() => {
    const tone = ringbackRef.current;
    ringbackRef.current = null;
    if (tone) {
      tone.pause();
      tone.currentTime = 0;
    }
  }, []);

  const startRingback = useCallback(() => {
    if (ringbackRef.current) return;
    const tone = new Audio('/audio/ringback.wav');
    tone.loop = true;
    tone.volume = 0.55;
    ringbackRef.current = tone;
    tone.play().catch((failure) => reportWebVoiceError('play outbound ringback', failure));
  }, []);

  const hangupSession = useCallback((session) => {
    stopRingback();
    return terminateSipSession(session).catch((failure) => {
      reportWebVoiceError('SIP hangup', failure);
      setError('Call signaling could not finish. Check your connection.');
    });
  }, [stopRingback]);

  const watchSession = useCallback((session, incoming) => {
    sessionTeardownsRef.current.get(session)?.();
    const mediaCleanup = attachSipMedia(session, 'remoteMedia', (failure) => {
      reportWebVoiceError('play remote SIP audio', failure);
      setAudioBlocked(true);
      setError('Browser audio is blocked. Allow audio playback to hear the call.');
    });
    const stateCleanup = observeSipSession(session, (next) => {
      if (next === SessionState.Terminated) {
        sessionTeardownsRef.current.get(session)?.();
        sessionTeardownsRef.current.delete(session);
      }
      if (sessionRef.current !== session && incomingRef.current !== session) return;
      if (next === SessionState.Establishing && !incoming) {
        setState('requesting');
      }
      if (next === SessionState.Established) {
        stopRingback();
        if (callMetaRef.current && !callMetaRef.current.connectedAt) callMetaRef.current.connectedAt = Date.now();
        setState('active');
        setRoutePhase('connected');
        setMediaReady(true);
      }
      if (next === SessionState.Terminated) {
        stopRingback();
        recordEndedCall(session);
        const routeId = routeIdRef.current;
        if (routeId) api('/api/voice/cancel', { method: 'POST', body: { routeId } }).catch((failure) => reportWebVoiceError('cancel terminated SIP route', failure));
        setCall(null);
        setIncomingCall(null);
        setState(null);
        setRoutePhase('ended');
        setMediaReady(false);
        sessionRef.current = null;
        incomingRef.current = null;
        routeIdRef.current = null;
        sessionTeardownsRef.current.get(session)?.();
        sessionTeardownsRef.current.delete(session);
      }
    });
    const health = monitorSipCall(session, {
      isConnected: () => credentialsRef.current?.userAgent?.isConnected?.() !== false,
      restart: () => restartSipMedia(session),
      onError: (failure) => reportWebVoiceError('SIP media recovery', failure),
      onFailure: (message) => {
        if (sessionRef.current !== session && incomingRef.current !== session) return;
        const routeId = routeIdRef.current;
        // Local teardown first. A dead socket cannot acknowledge a BYE.
        recordEndedCall(session);
        dialEpochRef.current += 1;
        sessionRef.current = null;
        incomingRef.current = null;
        routeIdRef.current = null;
        dialingRef.current = false;
        stopRingback();
        sessionTeardownsRef.current.get(session)?.();
        sessionTeardownsRef.current.delete(session);
        setCall(null); setIncomingCall(null); setState(null); setRoutePhase('ended');
        setMediaReady(false); setAudioBlocked(false); setCallStarting(false); setMuted(false);
        setError(message);
        const pc = session.sessionDescriptionHandler?.peerConnection;
        pc?.getSenders?.().forEach(({ track }) => track?.stop());
        pc?.getReceivers?.().forEach(({ track }) => track?.stop());
        pc?.close();
        terminateSipSession(session).catch((failure) => reportWebVoiceError('SIP failed connection cleanup', failure));
        if (routeId) api('/api/voice/cancel', { method: 'POST', body: { routeId } }).catch((failure) => reportWebVoiceError('cancel disconnected SIP route', failure));
      },
    });
    callHealthRef.current.set(session, health);
    const dispose = () => { health.stop(); callHealthRef.current.delete(session); mediaCleanup(); stateCleanup(); };
    sessionTeardownsRef.current.set(session, dispose);
    if (session.state === SessionState.Terminated) {
      dispose();
      sessionTeardownsRef.current.delete(session);
    }
  }, [recordEndedCall, stopRingback]);

  const disconnect = useCallback(async () => {
    dialEpochRef.current += 1;
    hangupSession(sessionRef.current);
    hangupSession(incomingRef.current);
    sessionTeardownsRef.current.forEach((dispose) => dispose());
    sessionTeardownsRef.current.clear();
    const connection = credentialsRef.current;
    const revoke = revokeBrowserSipCredential(api, connection).catch((failure) => reportWebVoiceError('SIP device revocation', failure));
    credentialsRef.current = null;
    sessionRef.current = null;
    incomingRef.current = null;
    routeIdRef.current = null;
    setReady(false);
    setCall(null);
    setIncomingCall(null);
    setState(null);
    setRoutePhase(null);
    setMediaReady(false);
    setAudioBlocked(false);
    setMuted(false);
    setCallStarting(false);
    dialingRef.current = false;
    if (connection?.stop) {
      try { await connection.stop(); } catch (failure) { reportWebVoiceError('SIP stop', failure); }
    } else {
      try { await connection?.registerer?.unregister(); } catch (failure) { reportWebVoiceError('SIP unregister', failure); }
      try { await connection?.userAgent?.stop(); } catch (failure) { reportWebVoiceError('SIP stop', failure); }
    }
    await revoke;
  }, [hangupSession]);

  useEffect(() => {
    if (!enabled || !token) return undefined;
    let cancelled = false;
    setReady(false);
    setStatusLabel('Connecting phone…');
    let renewal;
    let credentialRejected = false;
    let connectionPending = true;
    let recoveryTimer;
    let credentialExpiresAt;
    const renew = () => {
      renewal = undefined;
      if (cancelled) return;
      const delay = credentialRenewalDelayMs({
        onCall: Boolean(sessionRef.current || incomingRef.current || dialingRef.current),
        connectionPending,
      });
      if (delay !== null) {
        renewal = setTimeout(renew, delay);
        return;
      }
      connectionPending = true;
      setCredentialEpoch((epoch) => epoch + 1);
    };
    const scheduleRenewal = (delay) => {
      clearTimeout(renewal);
      renewal = setTimeout(renew, delay);
    };
    browserSipDeviceId().then(deviceId => api('/api/voice/sip-credentials', { method: 'POST', body: { client: 'web', deviceId } })).then(async (credentials) => {
      if (cancelled) { await revokeBrowserSipCredential(api, credentials); return; }
      if (!credentials.wsUri) throw new Error('VOCIVO_SIP_WSS_URI is not configured.');
      // Replaced at four fifths of its life, with a one-second floor;
      // short grants must not be cached for five minutes. Getting a new
      // password means building the phone again, so a call in progress is
      // waited out rather than cut off.
      const lifetime = Number(credentials.expires_in) * 1000;
      const renewIn = Math.min(Math.max(1000, (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 60 * 60 * 1000) * 0.8), 2 ** 31 - 1);
      credentialExpiresAt = Date.now() + renewIn;
      scheduleRenewal(renewIn);
      const connection = await connectSipUserAgent({
        username: credentials.username,
        password: credentials.password,
        domain: credentials.domain,
        wsUri: credentials.wsUri,
        // Profile enrichment must not tear down registration or an active call.
        // The latest name is picked up at the next actual credential/identity restart.
        displayName: displayNameRef.current,
        iceServers: credentials.ice_servers,
        onTransport: (connected) => {
          if (!cancelled) callHealthRef.current.forEach((health) => health.transport(connected));
        },
        // The phone's real state, not the state at sign-in: a dropped socket
        // used to leave "Ready for calls" on screen while calls rang nobody.
        onRegistration: (registration, reason) => {
          if (cancelled) return;
          if (registration === 'Registered') {
            credentialRetryAttemptRef.current = 0;
            if (credentialRejected) {
              credentialRejected = false;
              scheduleRenewal(Math.max(1000, credentialExpiresAt - Date.now()));
            }
            setReady(true);
            setError('');
            setStatusLabel('Ready for calls');
          } else if (registration === 'Reconnecting') {
            setReady(false);
            setStatusLabel('Reconnecting…');
          } else {
            setReady(false);
            if (reason) reportWebVoiceError('SIP registration', new Error(reason));
            // Only final rejections reach this callback, not digest challenges.
            // Replace the expiry timer; its presence must not suppress recovery.
            if (/^40[13]\b/.test(String(reason || '')) && !credentialRejected) {
              credentialRejected = true;
              const attempt = Math.min(credentialRetryAttemptRef.current++, 7);
              scheduleRenewal(Math.min(300_000, 3000 * 2 ** attempt));
            }
            if (credentialRejected) {
              setStatusLabel('Calling unavailable');
              setError('Phone registration was rejected. Retrying securely. Contact your company administrator if this continues.');
            } else {
              setStatusLabel('Reconnecting…');
              setError('The phone could not register. Retrying the connection.');
            }
          }
        },
        onInvite: (invitation) => {
          if (cancelled || incomingRef.current || sessionRef.current || dialingRef.current) {
            invitation.reject({ statusCode: 486 }).catch((failure) => reportWebVoiceError('reject busy SIP call', failure));
            return;
          }
          incomingRef.current = invitation;
          const peer = describeIncoming(invitation);
          callMetaRef.current = { id: sipSessionId(invitation), number: peer.number, identity: peer, direction: 'incoming', connectedAt: null, recorded: false };
          setIncomingCall(invitation);
          setRemoteIdentity(peer);
          watchSession(invitation, true);
        },
      });
      if (cancelled) {
        await connection.stop();
        await revokeBrowserSipCredential(api, credentials);
        return;
      }
      credentialsRef.current = { ...connection, deviceId: credentials.deviceId, credentialId: credentials.credentialId };
      connectionPending = false;
    }).catch((failure) => {
      if (cancelled) return;
      connectionPending = false;
      setReady(false);
      setError(failure instanceof Error ? failure.message : 'The SIP phone could not register.');
      setStatusLabel('Calling unavailable');
      // A network that was not there when the tab opened left the phone dead
      // until the page was reloaded. Try again, slowly.
      scheduleRenewal(30_000);
    });
    // A tab that comes back into view or a network that comes back gets the
    // phone registered again at once rather than on the back-off timer.
    const refresh = (event) => {
      if (cancelled || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
      const busy = sessionRef.current || incomingRef.current || dialingRef.current;
      if (!busy && !credentialRejected && !connectionPending
          && (event?.type === 'online' || Date.now() >= credentialExpiresAt || !credentialsRef.current)) {
        clearTimeout(recoveryTimer);
        recoveryTimer = setTimeout(() => {
          if (cancelled || connectionPending) return;
          clearTimeout(renewal);
          renew();
        }, 300);
      } else {
        credentialsRef.current?.refresh?.().catch((failure) => reportWebVoiceError('SIP refresh', failure));
      }
    };
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      cancelled = true;
      if (renewal) clearTimeout(renewal);
      clearTimeout(recoveryTimer);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
      disconnect();
    };
  }, [credentialEpoch, disconnect, enabled, token, watchSession]);

  useEffect(() => {
    if (!enabled || !token || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    registerWebPush().catch((failure) => reportWebVoiceError('register browser push subscription', failure));
  }, [enabled, token]);

  const beginOutgoing = useCallback((identity, dialed) => {
    setError('');
    setNotice('');
    setAudioBlocked(false);
    setRemoteIdentity(identity);
    setDialedNumber(dialed || identity.number);
    setRoutePhase('requesting');
    setState('requesting');
    setMediaReady(false);
    // True until the INVITE is on the wire. It was only ever set to false, so
    // nothing that waits on it — a disabled dial button, a spinner — ever saw
    // a call being placed.
    setCallStarting(true);
    // A previous call may have ended muted; the new call's track starts live.
    setMuted(false);
    setCall({ id: `pending-${Date.now()}`, pending: true });
  }, []);

  const place = useCallback(async (destination, options) => {
    const userAgent = credentialsRef.current?.userAgent;
    if (!userAgent) throw new Error('The SIP phone is not registered yet.');
    if (!userAgent.isConnected()) {
      // The socket dropped while the tab was idle; get it back before dialling.
      await credentialsRef.current?.refresh?.();
      if (!userAgent.isConnected()) throw new Error('The SIP phone is reconnecting. Please try again in a moment.');
    }
    if (options.epoch !== dialEpochRef.current) return;
    const domain = credentialsRef.current?.userAgent?.configuration?.uri?.host || '';
    const target = sipTargetUri(destination, domain);
    const session = await inviteSipTarget(userAgent, target, options.headers || [], {
      onProgress: (statusCode) => {
        if (options.epoch !== dialEpochRef.current || statusCode !== 180) return;
        if ([SessionState.Established, SessionState.Terminating, SessionState.Terminated].includes(sessionRef.current?.state)) return;
        setRoutePhase('ringing');
        startRingback();
      },
      onReject: (statusCode, reasonPhrase) => {
        if (options.epoch !== dialEpochRef.current) return;
        reportWebVoiceError('SIP INVITE rejected', new Error(`${statusCode} ${reasonPhrase}`));
        const message = describeCallRejection(statusCode, reasonPhrase, options.identity?.name);
        if (isRoutineCallOutcome(statusCode)) {
          setError('');
          setNotice(message);
        } else {
          setError(message);
        }
      },
      onError: (failure) => {
        if (options.epoch !== dialEpochRef.current) return;
        reportWebVoiceError('SIP INVITE', failure);
        setError(failure instanceof Error && failure.message ? failure.message : 'The call could not be started.');
      },
    });
    if (options.epoch !== dialEpochRef.current) {
      await hangupSession(session);
      return;
    }
    sessionRef.current = session;
    callMetaRef.current = { id: sipSessionId(session), number: options.dialedNumber || destination, identity: options.identity, direction: 'outgoing', connectedAt: null, recorded: false };
    setCall(session);
    setDialedNumber(options.dialedNumber || destination);
    setRemoteIdentity(options.identity);
    setState('requesting');
    setRoutePhase((phase) => phase === 'ringing' ? phase : 'requesting');
    setMediaReady(false);
    setCallStarting(false);
    watchSession(session, false);
    return session;
  }, [hangupSession, startRingback, watchSession]);

  const cancelRoute = useCallback((routeId) => {
    if (!routeId) return Promise.resolve();
    return api('/api/voice/cancel', { method: 'POST', body: { routeId } })
      .catch((failure) => reportWebVoiceError('cancel SIP route', failure));
  }, []);

  const startCall = useCallback(async (destinationNumber, callerNumber) => {
    if (dialingRef.current || sessionRef.current || incomingRef.current) return;
    dialingRef.current = true;
    const epoch = ++dialEpochRef.current;
    const identity = { name: 'Outbound call', number: destinationNumber, internal: false, photoUrl: '' };
    beginOutgoing(identity, destinationNumber);
    const routeId = `vc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    routeIdRef.current = routeId;
    try {
      const reservation = await api('/api/voice/route', { method: 'POST', body: { routeId, destination: destinationNumber, callerId: callerNumber, flow: 'outbound' } });
      if (epoch !== dialEpochRef.current) { await cancelRoute(routeId); return; }
      await place(destinationNumber, {
        epoch,
        dialedNumber: destinationNumber,
        identity,
        headers: [
          `X-Vocivo-Flow: outbound`,
          `X-Vocivo-Route-ID: ${routeId}`,
          `X-Vocivo-Route-Token: ${reservation.routeToken}`,
          ...(reservation.callerId ? [`X-Vocivo-Caller-ID: ${reservation.callerId}`] : []),
        ],
      });
    } catch (callError) {
      await cancelRoute(routeId);
      if (epoch !== dialEpochRef.current) return;
      stopRingback();
      setCallStarting(false);
      setCall(null);
      setRoutePhase(null);
      setError(callError.message || 'The call could not be started.');
      routeIdRef.current = null;
      throw callError;
    } finally {
      if (epoch === dialEpochRef.current) dialingRef.current = false;
    }
  }, [beginOutgoing, cancelRoute, place, stopRingback]);

  const startInternalCall = useCallback(async (sipUsername, extension, displayName) => {
    if (dialingRef.current || sessionRef.current || incomingRef.current) return;
    dialingRef.current = true;
    const epoch = ++dialEpochRef.current;
    const identity = { name: displayName || `Extension ${extension}`, number: `Extension ${extension}`, internal: true, photoUrl: '' };
    beginOutgoing(identity, extension);
    const routeId = `vc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    routeIdRef.current = routeId;
    try {
      const reservation = await api('/api/voice/route', {
        method: 'POST',
        body: {
          routeId,
          destination: sipUsername ? `sip:${sipUsername}@sip.telnyx.com` : '',
          targetExtension: extension,
          flow: 'internal',
        },
      });
      if (epoch !== dialEpochRef.current) { await cancelRoute(routeId); return; }
      const targetUser = sipUserFromUri(reservation.destination) || String(sipUsername || '').trim();
      if (!targetUser) throw new Error('The extension route did not return a SIP destination.');
      await place(targetUser, {
        epoch,
        dialedNumber: extension,
        identity: { name: reservation.destinationName || displayName || `Extension ${extension}`, number: `Extension ${extension}`, internal: true, photoUrl: '' },
        headers: [
          `X-Vocivo-Flow: internal`,
          `X-Vocivo-Route-ID: ${routeId}`,
          `X-Vocivo-Route-Token: ${reservation.routeToken}`,
        ],
      });
    } catch (callError) {
      await cancelRoute(routeId);
      if (epoch !== dialEpochRef.current) return;
      stopRingback();
      setCallStarting(false);
      setCall(null);
      setRoutePhase(null);
      setError(callError.message || 'The extension call could not be started.');
      routeIdRef.current = null;
      throw callError;
    } finally {
      if (epoch === dialEpochRef.current) dialingRef.current = false;
    }
  }, [beginOutgoing, cancelRoute, place, stopRingback]);

  const answer = useCallback(async () => {
    const incoming = incomingRef.current;
    if (!incoming) return;
    try {
      await incoming.accept({ sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } } });
    } catch (failure) {
      // Most often the microphone: permission refused, or no device. The
      // caller hears busy; the person here sees why nothing happened.
      reportWebVoiceError('SIP answer', failure);
      setError(failure instanceof Error && /permission|denied|NotAllowed|NotFound/i.test(`${failure.name} ${failure.message}`)
        ? 'The call could not be answered because the microphone is not available. Allow microphone access for this site and try again.'
        : (failure instanceof Error && failure.message) || 'The call could not be answered.');
      if (incomingRef.current === incoming) {
        incoming.reject({ statusCode: 486 }).catch(() => undefined);
        incomingRef.current = null;
        setIncomingCall(null);
      }
      return;
    }
    if (incomingRef.current !== incoming || incoming.state !== SessionState.Established) return;
    sessionRef.current = incoming;
    incomingRef.current = null;
    setCall(incoming);
    setIncomingCall(null);
    setState('active');
    setRoutePhase('connected');
    setMediaReady(true);
    // The answered call's track is live whatever the last call ended as.
    setMuted(false);
  }, []);

  const decline = useCallback(() => {
    hangupSession(incomingRef.current);
    incomingRef.current = null;
    setIncomingCall(null);
  }, [hangupSession]);

  const hangup = useCallback(() => {
    dialEpochRef.current += 1;
    stopRingback();
    cancelRoute(routeIdRef.current);
    hangupSession(sessionRef.current);
    hangupSession(incomingRef.current);
    sessionTeardownsRef.current.forEach((dispose) => dispose());
    sessionTeardownsRef.current.clear();
    recordEndedCall(sessionRef.current || incomingRef.current);
    sessionRef.current = null;
    incomingRef.current = null;
    routeIdRef.current = null;
    setCall(null);
    setIncomingCall(null);
    setState(null);
    setRoutePhase('ended');
    setMediaReady(false);
    setCallStarting(false);
    setMuted(false);
    dialingRef.current = false;
  }, [cancelRoute, hangupSession, recordEndedCall, stopRingback]);

  const toggleMute = useCallback(() => {
    const pc = sessionRef.current?.sessionDescriptionHandler?.peerConnection;
    pc?.getSenders().forEach((sender) => {
      if (sender.track?.kind === 'audio') sender.track.enabled = muted;
    });
    setMuted((value) => !value);
  }, [muted]);

  const unsupported = useCallback(async () => {
    throw new Error('This call control is not available for this connection.');
  }, []);

  const resumeAudio = useCallback(async () => {
    const element = document.getElementById('remoteMedia');
    if (!element?.srcObject) return;
    try {
      await element.play();
      setAudioBlocked(false);
      setError('');
    } catch (failure) {
      setAudioBlocked(true);
      reportWebVoiceError('resume remote SIP audio', failure);
      setError('Browser audio is blocked. Allow audio playback to hear the call.');
    }
  }, []);

  return {
    ready,
    statusLabel,
    error,
    notice,
    call,
    incomingCall,
    heldCall: null,
    conference: null,
    remoteIdentity,
    state: routePhase === 'connected' ? 'active' : routePhase || state,
    muted,
    dialedNumber,
    endedCall,
    callStarting,
    canMerge: false,
    canHold: false,
    canAddCaller: false,
    canTransfer: false,
    connected: mediaReady,
    incoming: Boolean(incomingCall),
    active: Boolean(call) && !incomingCall,
    notificationPermission,
    enableBrowserAlerts: async () => {
      if (typeof Notification === 'undefined') return 'unsupported';
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
      if (permission === 'granted') await registerWebPush();
      return permission;
    },
    audioBlocked,
    resumeAudio,
    startCall,
    startInternalCall,
    startSecondCall: unsupported,
    startSecondInternalCall: unsupported,
    swapCalls: unsupported,
    mergeCalls: unsupported,
    removeConferenceParticipant: unsupported,
    transferCall: unsupported,
    sendDtmf: (digit) => {
      // Keyed digits travel in the media (RFC 2833), which is what the switch
      // and the voice menus listen for; SIP INFO reached the proxy and nothing
      // behind it, so "press 1 for sales" from the web phone did nothing.
      const pc = sessionRef.current?.sessionDescriptionHandler?.peerConnection;
      const sender = pc?.getSenders?.().find((item) => item.track?.kind === 'audio');
      if (sender?.dtmf && typeof sender.dtmf.insertDTMF === 'function') {
        sender.dtmf.insertDTMF(String(digit), 200, 80);
        return;
      }
      sessionRef.current?.info?.({ contentType: 'application/dtmf-relay', body: `Signal=${digit}\r\nDuration=250` });
    },
    answer,
    decline,
    hangup,
    toggleMute,
    toggleHold: unsupported,
    disconnect,
    // The last call's failure is not the next screen's: switching between
    // external and extension dialling used to carry "Use a complete
    // international destination" over onto the extension keypad.
    clearError: () => { setError(''); setNotice(''); },
  };
}
