import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TelnyxRTC } from '@telnyx/webrtc';
import { api } from '../../../shared/api';
import { registerWebPush } from '../../push/webPush';
import { describeRemote, getCallId, callHeader } from '../engine/callIdentity';
import { remoteInboundAudioStarted, waitForWebCallMedia } from '../engine/webCallMedia';
import { reportWebVoiceError, telnyxErrorMessage } from '../engine/telemetry';

import { createWebRouteCancellation } from '../engine/webRouteCancellation';
import { disposeTelnyxCall, voiceRetryDelay, TELNYX_ROUTE_SETUP_MS, TELNYX_ROUTE_POLL_MS } from '../engine/telnyxRecovery';

const TERMINAL_STATES = new Set(['hangup', 'destroy', 'purge']);

export function useTelnyxVoice(token, enabled, identity = {}) {
  const clientRef = useRef(null);
  const clientListenerCleanupRef = useRef(null);
  const iceServersRef = useRef(undefined);
  const tokenRefreshRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const socketRetryRef = useRef(0);
  const callRef = useRef(null);
  const endedIdRef = useRef(null);
  const routeIdRef = useRef(null);
  const routePollRef = useRef(0);
  const callIdentityRef = useRef(new Map());
  const locallyEndedCallIdsRef = useRef(new Set());
  const connectedAtByCallIdRef = useRef(new Map());
  const incomingToneRef = useRef(null);
  const incomingNotificationRef = useRef(null);
  const incomingCallRef = useRef(null);
  const heldCallRef = useRef(null);
  const conferenceRef = useRef(null);
  const callActionBusyRef = useRef(false);
  const callSetupGenerationRef = useRef(0);
  const [ready, setReady] = useState(false);
  const [statusLabel, setStatusLabel] = useState('Connecting...');
  const [error, setError] = useState('');
  const [call, setCall] = useState(null);
  const [incomingCall, setIncomingCall] = useState(null);
  const [heldCall, setHeldCall] = useState(null);
  const [conference, setConference] = useState(null);
  const [state, setState] = useState(null);
  const [muted, setMuted] = useState(false);
  const [dialedNumber, setDialedNumber] = useState('');
  const [endedCall, setEndedCall] = useState(null);
  const [routePhase, setRoutePhase] = useState(null);
  const routePhaseRef = useRef(null);
  const [notificationPermission, setNotificationPermission] = useState(() => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const [remoteIdentity, setRemoteIdentity] = useState({ name: 'Phone call', number: '', internal: false, photoUrl: '' });
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [loginGeneration, setLoginGeneration] = useState(0);
  const [callStarting, setCallStarting] = useState(false);
  const [mediaReady, setMediaReady] = useState(false);
  const dialedNumberRef = useRef('');
  const ownerRef = useRef(null);
  ownerRef.current = enabled ? token : null;
  const cancellations = useMemo(() => createWebRouteCancellation({
    owner: token || 'signed-out', currentOwner: () => ownerRef.current,
    storage: { getItem: key => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value) },
    send: routeId => api('/api/voice/cancel', { method: 'POST', body: { routeId } }),
  }), [token]);
  const cancelWebRoute = useCallback((routeId) => {
    try {
      return cancellations.cancel(routeId).catch(failure => {
        reportWebVoiceError('queue call cancellation', failure);
        if (ownerRef.current === token) setError('Call cancellation is pending. Reconnect to finish ending the call.');
      });
    } catch (failure) {
      reportWebVoiceError('persist call cancellation', failure);
      setError(failure.message);
      return Promise.resolve();
    }
  }, [cancellations, token]);
  useEffect(() => {
    if (!enabled || !token) return;
    const flush = () => cancellations.flush().catch(failure => reportWebVoiceError('retry queued call cancellations', failure));
    void flush();
    const timer = setInterval(flush, 5_000);
    window.addEventListener('online', flush);
    window.addEventListener('focus', flush);
    return () => { clearInterval(timer); window.removeEventListener('online', flush); window.removeEventListener('focus', flush); };
  }, [cancellations, enabled, token]);

  useEffect(() => { routePhaseRef.current = routePhase; }, [routePhase]);
  useEffect(() => { dialedNumberRef.current = dialedNumber; }, [dialedNumber]);

  const resumeAudio = useCallback(async () => {
    const media = document.getElementById('remoteMedia');
    if (!media?.play) return;
    try {
      await media.play();
      setAudioBlocked(false);
    } catch (playbackError) {
      setAudioBlocked(true);
      throw playbackError;
    }
  }, []);

  const ringbackRef = useRef(null);
  const ringbackWatchRef = useRef(0);
  const stopRingback = useCallback(() => {
    ringbackWatchRef.current += 1;
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

  const confirmWebMedia = useCallback(async (call, callId) => {
    if (!callId) return;
    stopRingback();
    const ready = call ? await waitForWebCallMedia(call, 8_000) : false;
    if (getCallId(callRef.current) !== callId) return;
    stopRingback();
    if (!connectedAtByCallIdRef.current.has(callId)) connectedAtByCallIdRef.current.set(callId, Date.now());
    if (ready) setMediaReady(true);
  }, [stopRingback]);
  const stopIncomingRingtone = useCallback(() => {
    const tone = incomingToneRef.current;
    incomingToneRef.current = null;
    if (tone) {
      tone.pause();
      tone.currentTime = 0;
    }
    incomingNotificationRef.current?.close?.();
    incomingNotificationRef.current = null;
    navigator.vibrate?.(0);
  }, []);
  const startIncomingRingtone = useCallback((incoming) => {
    if (!incomingToneRef.current) {
      // A phone ringing sounds different from a phone being rung: on the
      // ringback asset an incoming call was indistinguishable from a call this
      // phone was placing.
      const tone = new Audio('/audio/ringtone.wav');
      tone.loop = true;
      tone.volume = 0.72;
      incomingToneRef.current = tone;
      tone.play().catch((failure) => reportWebVoiceError('play incoming ringtone', failure));
    }
    navigator.vibrate?.([450, 250, 450, 650]);
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && !incomingNotificationRef.current) {
      const identity = describeRemote(incoming);
      const notification = new Notification(identity.name || 'Incoming Vocivo call', {
        body: identity.number || 'Open Vocivo to answer',
        icon: '/vocivo-icon-192.png',
        tag: `vocivo-incoming-${incoming.id || incoming.callId || 'call'}`,
        requireInteraction: true,
      });
      notification.onclick = () => { window.focus(); notification.close(); };
      incomingNotificationRef.current = notification;
    }
  }, []);
  const enableBrowserAlerts = useCallback(async () => {
    const probe = new Audio('/audio/ringback.wav');
    probe.volume = 0.01;
    await probe.play().catch((failure) => reportWebVoiceError('unlock browser audio', failure));
    probe.pause();
    probe.currentTime = 0;
    if (typeof Notification === 'undefined') {
      setNotificationPermission('unsupported');
      return 'unsupported';
    }
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    if (permission === 'granted') await registerWebPush();
    return permission;
  }, []);

  useEffect(() => {
    if (!enabled || !token || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    registerWebPush().catch((failure) => reportWebVoiceError('register browser push subscription', failure));
  }, [enabled, token]);

  const disconnect = useCallback(() => {
    callSetupGenerationRef.current += 1;
    callActionBusyRef.current = false;
    if (tokenRefreshRef.current) {
      clearTimeout(tokenRefreshRef.current);
      tokenRefreshRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const routeId = routeIdRef.current;
    const extraRoutes = [heldCallRef.current?.routeId, ...(conferenceRef.current?.participants || []).map((item) => item.routeId)].filter(Boolean);
    [...new Set([routeId, ...extraRoutes].filter(Boolean))].forEach((id) => cancelWebRoute(id));
    for (const active of new Set([callRef.current, incomingCallRef.current, heldCallRef.current?.call].filter(Boolean))) {
      disposeTelnyxCall(active, reportWebVoiceError);
    }
    clientListenerCleanupRef.current?.();
    clientListenerCleanupRef.current = null;
    try { clientRef.current?.disconnect?.(); } catch (failure) { reportWebVoiceError('disconnect Telnyx client', failure); }
    clientRef.current = null;
    iceServersRef.current = undefined;
    callRef.current = null;
    incomingCallRef.current = null;
    heldCallRef.current = null;
    conferenceRef.current = null;
    routeIdRef.current = null;
    routePollRef.current += 1;
    stopRingback();
    stopIncomingRingtone();
    setReady(false);
    setCall(null);
    setIncomingCall(null);
    setHeldCall(null);
    setConference(null);
    setState(null);
    setRoutePhase(null);
    setMediaReady(false);
    setCallStarting(false);
  }, [cancelWebRoute, stopIncomingRingtone, stopRingback]);

  useEffect(() => {
    if (!enabled || !token) return undefined;
    let cancelled = false;
    setStatusLabel('Connecting...');
    setError('');
    api('/api/telnyx/token', { method: 'POST', body: {} }).then(({ token: loginToken, expires_in: expiresIn = 3600, ice_servers: iceServers = [] }) => {
      if (cancelled) return;
      if (!loginToken) throw new Error('The calling service did not return a session token.');
      const refreshWhenIdle = () => {
        if (cancelled) return;
        if (callRef.current || incomingCallRef.current || heldCallRef.current) {
          tokenRefreshRef.current = setTimeout(refreshWhenIdle, 60_000);
          return;
        }
        setLoginGeneration((generation) => generation + 1);
      };
      const lifetimeSeconds = Number.isFinite(Number(expiresIn)) ? Number(expiresIn) : 3600;
      tokenRefreshRef.current = setTimeout(refreshWhenIdle, Math.max(250, (lifetimeSeconds - 120) * 1000, lifetimeSeconds * 500));
      iceServersRef.current = Array.isArray(iceServers) && iceServers.length ? iceServers : undefined;
      clientListenerCleanupRef.current?.();
      clientListenerCleanupRef.current = null;
      const client = new TelnyxRTC({
        login_token: loginToken,
        iceServers: iceServersRef.current,
        trickleIce: true,
        keepConnectionAliveOnSocketClose: false,
      });
      clientRef.current = client;
      client.remoteElement = 'remoteMedia';
      const listeners = [];
      const on = (event, listener) => {
        client.on(event, listener);
        listeners.push([event, listener]);
      };
      clientListenerCleanupRef.current = () => {
        listeners.splice(0).forEach(([event, listener]) => {
          try { client.off(event, listener); } catch (failure) { reportWebVoiceError(`remove ${event} listener`, failure); }
        });
      };
      on('telnyx.ready', () => {
        if (cancelled) return;
        socketRetryRef.current = 0;
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        setError('');
        setReady(true);
        setStatusLabel('Ready for calls');
      });
      on('telnyx.error', (event) => {
        if (cancelled) return;
        const message = telnyxErrorMessage(event);
        console.error('Vocivo Telnyx client error', {
          code: event?.code || event?.error?.code || event?.payload?.code,
          message,
          fatal: event?.fatal ?? event?.error?.fatal,
        });
        setError(message);
        setStatusLabel('Connection problem');
      });
      on('telnyx.socket.close', () => {
        if (cancelled) return;
        callSetupGenerationRef.current += 1;
        const routeIds = [
          routeIdRef.current,
          heldCallRef.current?.routeId,
          ...(conferenceRef.current?.participants || []).map((participant) => participant.routeId),
        ].filter(Boolean);
        [...new Set(routeIds)].forEach((routeId) => {
          cancelWebRoute(routeId);
        });
        for (const dropped of new Set([callRef.current, incomingCallRef.current, heldCallRef.current?.call].filter(Boolean))) {
          const id = getCallId(dropped);
          if (id) locallyEndedCallIdsRef.current.add(id);
          disposeTelnyxCall(dropped, reportWebVoiceError);
        }
        const droppedCall = callRef.current;
        const droppedCallId = getCallId(droppedCall);
        const heldDropped = heldCallRef.current;
        const writeDroppedHistory = (callId, call, identityOverride) => {
          if (!callId || endedIdRef.current === callId) return;
          endedIdRef.current = callId;
          const identity = identityOverride || callIdentityRef.current.get(callId) || describeRemote(call);
          const direction = String(call?.direction || '').toLowerCase() === 'inbound' ? 'incoming' : 'outgoing';
          const connectedAt = connectedAtByCallIdRef.current.get(callId);
          setEndedCall({
            id: callId,
            number: identity?.number || 'Unknown',
            name: identity?.name,
            internal: identity?.internal,
            address: identity?.address,
            answered: Boolean(connectedAt),
            direction,
            duration: connectedAt ? Math.max(0, Math.floor((Date.now() - connectedAt) / 1000)) : 0,
          });
        };
        if (heldDropped?.id && heldDropped.id !== droppedCallId) {
          writeDroppedHistory(heldDropped.id, heldDropped.call, heldDropped.identity);
          if (droppedCallId) window.setTimeout(() => writeDroppedHistory(droppedCallId, droppedCall), 0);
        } else {
          writeDroppedHistory(droppedCallId, droppedCall);
        }
        connectedAtByCallIdRef.current.clear();
        routePollRef.current += 1;
        routeIdRef.current = null;
        callRef.current = null;
        incomingCallRef.current = null;
        heldCallRef.current = null;
        conferenceRef.current = null;
        stopRingback();
        stopIncomingRingtone();
        setCall(null);
        setIncomingCall(null);
        setHeldCall(null);
        setConference(null);
        setState(null);
        setMuted(false);
        setMediaReady(false);
        setRoutePhase(null);
        setRemoteIdentity({ name: 'Phone call', number: '', internal: false, photoUrl: '' });
        setAudioBlocked(false);
        setReady(false);
        setStatusLabel('Reconnecting...');
        if (socketRetryRef.current < 5) {
          socketRetryRef.current += 1;
          if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            if (!cancelled) setLoginGeneration((generation) => generation + 1);
          }, Math.min(30_000, 10_000 * socketRetryRef.current));
        } else {
          setStatusLabel('Connection lost');
        }
      });
      on('telnyx.notification', (notification) => {
        if (cancelled || notification?.type !== 'callUpdate' || !notification.call) return;
        const updatedCall = notification.call;
        const nextState = String(updatedCall.state || '').toLowerCase();
        const direction = String(updatedCall.direction || updatedCall.options?.direction || '').toLowerCase();
        const callId = updatedCall.id || updatedCall.callId;
        if (callId && locallyEndedCallIdsRef.current.has(callId) && !TERMINAL_STATES.has(nextState)) {
          try { updatedCall.hangup?.(); } catch (failure) { reportWebVoiceError('enforce locally ended call', failure); }
          return;
        }
        const activeId = getCallId(callRef.current);
        const heldId = heldCallRef.current?.id;
        if (callId && heldId === callId && activeId !== callId) {
          if (TERMINAL_STATES.has(nextState)) {
            const connectedAt = connectedAtByCallIdRef.current.get(callId);
            const duration = connectedAt ? Math.max(0, Math.floor((Date.now() - connectedAt) / 1000)) : 0;
            connectedAtByCallIdRef.current.delete(callId);
            const localIdentity = callIdentityRef.current.get(callId) || heldCallRef.current?.identity || describeRemote(updatedCall);
            if (endedIdRef.current !== callId) {
              endedIdRef.current = callId;
              setEndedCall({
                id: callId,
                number: localIdentity?.number || 'Unknown',
                name: localIdentity?.name,
                internal: localIdentity?.internal,
                address: localIdentity?.address,
                answered: Boolean(connectedAt),
                direction: String(updatedCall.direction || '').toLowerCase() === 'inbound' ? 'incoming' : 'outgoing',
                duration,
              });
            }
            heldCallRef.current = null;
            setHeldCall(null);
          } else {
            const nextHeld = { ...heldCallRef.current, call: updatedCall, state: nextState };
            heldCallRef.current = nextHeld;
            setHeldCall(nextHeld);
          }
          return;
        }
        if (direction === 'inbound' && ['new', 'ringing', 'early', 'requesting'].includes(nextState) && activeId && activeId !== callId) {
          incomingCallRef.current = updatedCall;
          setIncomingCall(updatedCall);
          startIncomingRingtone(updatedCall);
          return;
        }
        if (callId && activeId && activeId !== callId && TERMINAL_STATES.has(nextState)) {
          if (getCallId(incomingCallRef.current) === callId) {
            incomingCallRef.current = null;
            setIncomingCall(null);
            stopIncomingRingtone();
          }
          callIdentityRef.current.delete(callId);
          return;
        }
        if (activeId && activeId !== callId && !TERMINAL_STATES.has(nextState)) return;
        callRef.current = updatedCall;
        setCall(updatedCall);
        setRemoteIdentity(callIdentityRef.current.get(callId) || describeRemote(updatedCall, dialedNumberRef.current));
        setState(nextState);
        if (direction === 'inbound' && ['new', 'ringing', 'early', 'requesting'].includes(nextState)) {
          incomingCallRef.current = updatedCall;
          setIncomingCall(updatedCall);
          startIncomingRingtone(updatedCall);
        }
        if (['active', 'held'].includes(nextState)) {
          incomingCallRef.current = null;
          setIncomingCall(null);
          stopIncomingRingtone();
          stopRingback();
          setRoutePhase('connected');
          routePhaseRef.current = 'connected';
          void confirmWebMedia(updatedCall, callId);
          resumeAudio().catch((failure) => reportWebVoiceError('resume connected-call audio', failure));
        } else if (direction !== 'inbound' && ['early', 'ringing'].includes(nextState)) {
          void remoteInboundAudioStarted(updatedCall, 8_000).then((started) => {
            if (!started || getCallId(callRef.current) !== callId) return;
            stopRingback();
          }).catch((failure) => reportWebVoiceError('stop ringback on early media', failure));
        }
        if (TERMINAL_STATES.has(nextState)) {
          // Keep the tombstone until this client is retired; a late ACTIVE must not resurrect a canceled call.
          routePollRef.current += 1;
          routeIdRef.current = null;
          setRoutePhase(null);
          stopRingback();
          stopIncomingRingtone();
          const endedCallId = callId || `${Date.now()}`;
          const connectedAt = connectedAtByCallIdRef.current.get(endedCallId);
          const duration = connectedAt ? Math.max(0, Math.floor((Date.now() - connectedAt) / 1000)) : 0;
          connectedAtByCallIdRef.current.delete(endedCallId);
          if (endedIdRef.current !== endedCallId) {
            endedIdRef.current = endedCallId;
            const localIdentity = callIdentityRef.current.get(endedCallId);
            const number = localIdentity?.number || (direction === 'inbound'
              ? updatedCall.options?.remoteCallerNumber || updatedCall.options?.callerNumber
              : updatedCall.options?.destinationNumber || updatedCall.options?.remoteCallerNumber);
            const identity = localIdentity || describeRemote(updatedCall);
            setEndedCall({ id: endedCallId, number: number || identity.number, name: identity.name, internal: identity.internal, address: identity.address,
              answered: Boolean(connectedAt), direction: direction === 'inbound' ? 'incoming' : 'outgoing', duration });
          }
          callRef.current = null;
          incomingCallRef.current = null;
          callIdentityRef.current.delete(endedCallId);
          setCall(null);
          setIncomingCall(null);
          setState(null);
          setMuted(false);
          setMediaReady(false);
          setRemoteIdentity({ name: 'Phone call', number: '', internal: false, photoUrl: '' });
          const held = heldCallRef.current;
          if (held && !conferenceRef.current) {
            heldCallRef.current = null;
            setHeldCall(null);
            Promise.resolve(held.call?.unhold?.()).then(() => {
              callRef.current = held.call;
              routeIdRef.current = held.routeId || null;
              setCall(held.call);
              setState('active');
              setRoutePhase('connected');
              setMediaReady(true);
              setRemoteIdentity(held.identity);
            }).catch((failure) => reportWebVoiceError('resume held call after peer ended', failure));
          } else if (conferenceRef.current) {
            conferenceRef.current = null;
            setConference(null);
          }
        }
      });
      client.connect();
    }).catch((connectionError) => {
      if (cancelled) return;
      setError(connectionError.message);
      setReady(false);
      setStatusLabel('Reconnecting...');
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (!cancelled) setLoginGeneration(generation => generation + 1);
      }, voiceRetryDelay(socketRetryRef.current++));
    });
    const online = () => {
      if (!cancelled && !callRef.current && !incomingCallRef.current && !heldCallRef.current) {
        setLoginGeneration(generation => generation + 1);
      }
    };
    window.addEventListener('online', online);
    return () => { cancelled = true; window.removeEventListener('online', online); disconnect(); };
  }, [cancelWebRoute, confirmWebMedia, disconnect, enabled, loginGeneration, resumeAudio, startIncomingRingtone, stopIncomingRingtone, stopRingback, token]);

  const followRoute = useCallback(async (routeId) => {
    const generation = ++routePollRef.current;
    let lastRouteError = null;
    routeIdRef.current = routeId;
    if (routePhaseRef.current !== 'connected') setRoutePhase('ringing');
    const deadline = Date.now() + TELNYX_ROUTE_SETUP_MS;
    for (let attempt = 0; Date.now() < deadline && routePollRef.current === generation; attempt += 1) {
      try {
        const liveState = String(callRef.current?.state || '').toLowerCase();
        if (['active', 'held'].includes(liveState) || routePhaseRef.current === 'connected') {
          setRoutePhase('connected');
          routePhaseRef.current = 'connected';
          stopRingback();
          resumeAudio().catch((failure) => reportWebVoiceError('resume bridged-call audio', failure));
          void confirmWebMedia(callRef.current, getCallId(callRef.current));
          return;
        }
        const result = await api(`/api/voice/status?routeId=${encodeURIComponent(routeId)}`);
        if (routePollRef.current !== generation) return;
        if (result.phase === 'connected') {
          setRoutePhase('connected');
          routePhaseRef.current = 'connected';
          stopRingback();
          resumeAudio().catch((failure) => reportWebVoiceError('resume bridged-call audio', failure));
          void confirmWebMedia(callRef.current, getCallId(callRef.current));
          return;
        }
        if (['failed', 'ended'].includes(result.phase)) {
          setRoutePhase(result.phase);
          stopRingback();
          if (result.phase === 'failed' && result.failureCause) setError(`Call failed: ${String(result.failureCause).replaceAll('_', ' ')}.`);
          const liveState = String(callRef.current?.state || '').toLowerCase();
          if (!['active', 'held'].includes(liveState)) {
            try { callRef.current?.hangup?.(); } catch (failure) { reportWebVoiceError('hang up failed route', failure); }
          }
          return;
        }
      } catch (routeError) {
        lastRouteError = routeError;
        if (attempt === 9 || attempt === 39) reportWebVoiceError('poll extension route status', routeError);
      }
      await new Promise((resolve) => setTimeout(resolve, TELNYX_ROUTE_POLL_MS));
    }
    if (routePollRef.current === generation) {
      stopRingback();
      setError(lastRouteError ? 'Call status could not be confirmed. The live call remains available.' : 'Call setup is taking longer than expected.');
    }
  }, [confirmWebMedia, resumeAudio, stopRingback]);

  const startCall = useCallback(async (destinationNumber, callerNumber) => {
    if (callActionBusyRef.current) throw new Error('A call is already being started.');
    callActionBusyRef.current = true;
    setCallStarting(true);
    setError('');
    setDialedNumber(destinationNumber);
    setRemoteIdentity({ name: 'Outbound call', number: destinationNumber, internal: false, photoUrl: '' });
    setRoutePhase('requesting');
    const routeId = `vc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}_${Math.random().toString(36).slice(2, 10)}`;
    const setupGeneration = ++callSetupGenerationRef.current;
    routeIdRef.current = routeId;
    startRingback();
    try {
      const reservation = await api('/api/voice/route', { method: 'POST', body: { routeId, destination: destinationNumber, callerId: callerNumber, flow: 'outbound' } });
      if (callSetupGenerationRef.current !== setupGeneration) {
        cancelWebRoute(routeId);
        return;
      }
      const newCall = clientRef.current?.newCall({
        destinationNumber,
        callerNumber: reservation.callerId,
        callerName: identity.name || 'Vocivo',
        customHeaders: [
          { name: 'X-Vocivo-Flow', value: 'outbound' },
          { name: 'X-Vocivo-Destination', value: destinationNumber },
          { name: 'X-Vocivo-Route-ID', value: routeId },
          { name: 'X-Vocivo-Route-Token', value: reservation.routeToken },
          ...(reservation.callerId ? [{ name: 'X-Vocivo-Caller-ID', value: reservation.callerId }] : []),
        ],
        remoteElement: 'remoteMedia',
        ...(iceServersRef.current ? { iceServers: iceServersRef.current } : {}),
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        trickleIce: true,
      });
      if (!newCall) throw new Error('The web phone is not ready yet.');
      if (callSetupGenerationRef.current !== setupGeneration) {
        try { newCall.hangup?.(); } catch (failure) { reportWebVoiceError('hang up superseded outbound call', failure); }
        cancelWebRoute(routeId);
        return;
      }
      callRef.current = newCall;
      incomingCallRef.current = null;
      callIdentityRef.current.set(newCall.id || newCall.callId, { name: 'Outbound call', number: destinationNumber, internal: false });
      setCall(newCall);
      setRemoteIdentity({ name: 'Outbound call', number: destinationNumber, internal: false, photoUrl: '' });
      setState(String(newCall.state || 'requesting').toLowerCase());
      void remoteInboundAudioStarted(newCall, 20_000).then((started) => {
        if (!started || getCallId(callRef.current) !== getCallId(newCall)) return;
        stopRingback();
      }).catch((failure) => reportWebVoiceError('stop ringback when remote audio starts', failure));
      followRoute(routeId);
    } catch (callError) {
      stopRingback();
      if (routeIdRef.current === routeId) routeIdRef.current = null;
      setRoutePhase(null);
      cancelWebRoute(routeId);
      setError(callError.message || 'The call could not be started. Check microphone permission.');
      throw callError;
    } finally {
      callActionBusyRef.current = false;
      setCallStarting(false);
    }
  }, [cancelWebRoute, followRoute, identity.name, startRingback, stopRingback]);

  const startInternalCall = useCallback(async (sipUsername, extension, displayName) => {
    if (callActionBusyRef.current) throw new Error('A call is already being started.');
    callActionBusyRef.current = true;
    setCallStarting(true);
    const requestedDestination = sipUsername ? `sip:${sipUsername}@sip.telnyx.com` : '';
    setDialedNumber(extension);
    setError('');
    setRemoteIdentity({ name: displayName || `Extension ${extension}`, number: `Extension ${extension}`, internal: true, photoUrl: '' });
    setRoutePhase('requesting');
    const routeId = `vc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}_${Math.random().toString(36).slice(2, 10)}`;
    const setupGeneration = ++callSetupGenerationRef.current;
    routeIdRef.current = routeId;
    startRingback();
    try {
      const reservation = await api('/api/voice/route', { method: 'POST', body: { routeId, destination: requestedDestination, targetExtension: extension, flow: 'internal' } });
      if (callSetupGenerationRef.current !== setupGeneration) {
        cancelWebRoute(routeId);
        return;
      }
      const destination = reservation.destination;
      const resolvedName = reservation.destinationName || displayName || `Extension ${extension}`;
      const resolvedExtension = reservation.destinationExtension || extension;
      if (!destination) throw new Error('The extension route did not return a destination.');
      const newCall = clientRef.current?.newCall({
        destinationNumber: destination,
        callerName: reservation.callerName || identity.name || 'Vocivo',
        callerNumber: reservation.callerExtension || identity.extension,
        customHeaders: [
          { name: 'X-Vocivo-Flow', value: 'internal' },
          { name: 'X-Vocivo-Destination', value: destination },
          { name: 'X-Vocivo-Route-ID', value: routeId },
          { name: 'X-Vocivo-Route-Token', value: reservation.routeToken },
          { name: 'X-Vocivo-Destination-Name', value: resolvedName },
          { name: 'X-Vocivo-Destination-Extension', value: resolvedExtension },
        ],
        remoteElement: 'remoteMedia',
        ...(iceServersRef.current ? { iceServers: iceServersRef.current } : {}),
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        trickleIce: true,
      });
      if (!newCall) throw new Error('The web phone is not ready yet.');
      if (callSetupGenerationRef.current !== setupGeneration) {
        try { newCall.hangup?.(); } catch (failure) { reportWebVoiceError('hang up superseded internal call', failure); }
        cancelWebRoute(routeId);
        return;
      }
      callRef.current = newCall;
      incomingCallRef.current = null;
      callIdentityRef.current.set(newCall.id || newCall.callId, { name: resolvedName, number: `Extension ${resolvedExtension}`, internal: true });
      setCall(newCall);
      setRemoteIdentity({ name: resolvedName, number: `Extension ${resolvedExtension}`, internal: true, photoUrl: '' });
      setState(String(newCall.state || 'requesting').toLowerCase());
      void remoteInboundAudioStarted(newCall, 20_000).then((started) => {
        if (!started || getCallId(callRef.current) !== getCallId(newCall)) return;
        stopRingback();
      }).catch((failure) => reportWebVoiceError('stop ringback when remote audio starts', failure));
      followRoute(routeId);
    } catch (callError) {
      stopRingback();
      if (routeIdRef.current === routeId) routeIdRef.current = null;
      setRoutePhase(null);
      cancelWebRoute(routeId);
      setError(callError.message || 'The extension call could not be started.');
      throw callError;
    } finally {
      callActionBusyRef.current = false;
      setCallStarting(false);
    }
  }, [cancelWebRoute, followRoute, identity.extension, identity.name, startRingback, stopRingback]);

  const answer = useCallback(async () => {
    try {
      stopIncomingRingtone();
      const incoming = incomingCallRef.current || incomingCall;
      const current = callRef.current;
      if (!incoming) return;
      if (current && getCallId(current) !== getCallId(incoming) && ['active', 'held'].includes(String(current.state || '').toLowerCase())) {
        const snapshot = { id: getCallId(current), call: current, identity: remoteIdentity, routeId: routeIdRef.current, state: 'held' };
        heldCallRef.current = snapshot;
        setHeldCall(snapshot);
        await current.hold?.();
      }
      await incoming.answer?.({ remoteElement: 'remoteMedia', ...(iceServersRef.current ? { iceServers: iceServersRef.current } : {}), audio: true });
      callRef.current = incoming;
      incomingCallRef.current = null;
      routeIdRef.current = null;
      setCall(incoming);
      setState('answering');
      setRoutePhase(null);
      setRemoteIdentity(callIdentityRef.current.get(getCallId(incoming)) || describeRemote(incoming));
      await resumeAudio().catch((failure) => reportWebVoiceError('resume answered-call audio', failure));
      setIncomingCall(null);
    } catch (answerError) { setError(answerError.message || 'The call could not be answered.'); }
  }, [incomingCall, remoteIdentity, resumeAudio, stopIncomingRingtone]);
  const decline = useCallback(() => {
    stopIncomingRingtone();
    const incoming = incomingCallRef.current || incomingCall;
    const routeId = callHeader(incoming, 'X-Vocivo-Route-ID');
    if (routeId) cancelWebRoute(routeId);
    incoming?.hangup?.();
    incomingCallRef.current = null;
    setIncomingCall(null);
    if (getCallId(callRef.current) === getCallId(incoming)) {
      callRef.current = null;
      setCall(null);
      setState(null);
    }
  }, [cancelWebRoute, incomingCall, stopIncomingRingtone]);
  const hangup = useCallback(() => {
    callSetupGenerationRef.current += 1;
    callActionBusyRef.current = false;
    setCallStarting(false);
    const routeId = routeIdRef.current;
    const current = callRef.current;
    const held = heldCallRef.current;
    const extraRoutes = [held?.routeId, ...(conferenceRef.current?.participants || []).map((item) => item.routeId)].filter(Boolean);
    const callId = current?.id || current?.callId;
    if (callId) locallyEndedCallIdsRef.current.add(callId);
    routePollRef.current += 1;
    routeIdRef.current = null;
    stopRingback();
    stopIncomingRingtone();
    [...new Set([routeId, ...extraRoutes].filter(Boolean))].forEach((id) => cancelWebRoute(id));
    try { current?.hangup?.(); } catch (failure) { reportWebVoiceError('hang up active browser call', failure); }
    try { held?.call?.hangup?.(); } catch (failure) { reportWebVoiceError('hang up held browser call', failure); }
    callRef.current = null;
    incomingCallRef.current = null;
    heldCallRef.current = null;
    conferenceRef.current = null;
    setCall(null);
    setIncomingCall(null);
    setHeldCall(null);
    setConference(null);
    setState(null);
    setMuted(false);
    setMediaReady(false);
    setRoutePhase('ended');
  }, [cancelWebRoute, stopIncomingRingtone, stopRingback]);
  const toggleMute = useCallback(() => {
    if (!callRef.current) return;
    if (muted) callRef.current.unmuteAudio?.(); else callRef.current.muteAudio?.();
    setMuted((value) => !value);
  }, [muted]);
  const toggleHold = useCallback(() => {
    if (!callRef.current) return;
    if (state === 'held') callRef.current.unhold?.(); else callRef.current.hold?.();
  }, [state]);

  const startSecondCall = useCallback(async (destinationNumber, callerNumber) => {
    const current = callRef.current;
    if (!current || !['active'].includes(String(current.state || '').toLowerCase()) || heldCallRef.current || conferenceRef.current) throw new Error('Connect the first call before adding another caller.');
    const snapshot = { id: getCallId(current), call: current, identity: remoteIdentity, routeId: routeIdRef.current, state: 'held' };
    heldCallRef.current = snapshot;
    setHeldCall(snapshot);
    await current.hold?.();
    try {
      await startCall(destinationNumber, callerNumber);
    } catch (secondCallError) {
      heldCallRef.current = null;
      setHeldCall(null);
      await current.unhold?.();
      callRef.current = current;
      routeIdRef.current = snapshot.routeId;
      setCall(current);
      setState('active');
      setRoutePhase('connected');
      setRemoteIdentity(snapshot.identity);
      throw secondCallError;
    }
  }, [remoteIdentity, startCall]);

  const startSecondInternalCall = useCallback(async (sipUsername, extension, displayName) => {
    const current = callRef.current;
    if (!current || String(current.state || '').toLowerCase() !== 'active' || heldCallRef.current || conferenceRef.current) throw new Error('Connect the first call before adding another caller.');
    const snapshot = { id: getCallId(current), call: current, identity: remoteIdentity, routeId: routeIdRef.current, state: 'held' };
    heldCallRef.current = snapshot;
    setHeldCall(snapshot);
    await current.hold?.();
    try {
      await startInternalCall(sipUsername, extension, displayName);
    } catch (secondCallError) {
      heldCallRef.current = null;
      setHeldCall(null);
      await current.unhold?.();
      callRef.current = current;
      routeIdRef.current = snapshot.routeId;
      setCall(current);
      setState('active');
      setRoutePhase('connected');
      setRemoteIdentity(snapshot.identity);
      throw secondCallError;
    }
  }, [remoteIdentity, startInternalCall]);

  const swapCalls = useCallback(async () => {
    if (callActionBusyRef.current) throw new Error('Another call action is still completing.');
    const current = callRef.current;
    const held = heldCallRef.current;
    if (!current || !held || conferenceRef.current) throw new Error('There is no held call to swap.');
    callActionBusyRef.current = true;
    const currentSnapshot = { id: getCallId(current), call: current, identity: remoteIdentity, routeId: routeIdRef.current, state: 'held' };
    try {
      await current.hold?.();
      await held.call?.unhold?.();
      heldCallRef.current = currentSnapshot;
      setHeldCall(currentSnapshot);
      callRef.current = held.call;
      routeIdRef.current = held.routeId || null;
      setCall(held.call);
      setState('active');
      setRoutePhase('connected');
      setRemoteIdentity(held.identity);
    } finally {
      callActionBusyRef.current = false;
    }
  }, [remoteIdentity]);

  const mergeCalls = useCallback(async () => {
    if (callActionBusyRef.current) throw new Error('Another call action is still completing.');
    const active = callRef.current;
    const held = heldCallRef.current;
    if (!active || !held || !routeIdRef.current || !held.routeId) throw new Error('Two connected Vocivo calls are required before merging.');
    callActionBusyRef.current = true;
    try {
      const result = await api('/api/voice/merge', { method: 'POST', body: { routeIds: [routeIdRef.current, held.routeId] } });
      const merged = {
        id: result.conferenceId,
        participants: [
          { id: held.id, routeId: held.routeId, ...held.identity },
          { id: getCallId(active), routeId: routeIdRef.current, ...remoteIdentity },
        ],
      };
      conferenceRef.current = merged;
      setConference(merged);
      heldCallRef.current = null;
      setHeldCall(null);
    } finally {
      callActionBusyRef.current = false;
    }
  }, [remoteIdentity]);

  const removeConferenceParticipant = useCallback(async (participantId) => {
    const current = conferenceRef.current;
    const participant = current?.participants.find((item) => item.id === participantId);
    if (!current || !participant?.routeId || current.participants[0]?.id === participantId) throw new Error('Only an added participant can be removed.');
    await api('/api/voice/merge', { method: 'POST', body: { action: 'remove_participant', conferenceId: current.id, routeId: participant.routeId } });
    const next = { ...current, participants: current.participants.filter((item) => item.id !== participantId) };
    if (participantId === getCallId(callRef.current) && next.participants[0]) {
      routeIdRef.current = next.participants[0].routeId || null;
      setRemoteIdentity(next.participants[0]);
    }
    conferenceRef.current = next;
    setConference(next);
  }, []);

  const transferCall = useCallback(async (targetExtensionId) => {
    await api('/api/voice/transfer', { method: 'POST', body: { targetExtensionId } });
  }, []);

  const sendDtmf = useCallback((digit) => callRef.current?.dtmf?.(digit), []);

  return {
    ready, statusLabel, error, call, incomingCall, heldCall, conference, remoteIdentity, state: state === 'held' ? 'held' : (routePhase === 'connected' ? 'active' : routePhase || state), muted, dialedNumber, endedCall, callStarting,
    canMerge: Boolean(heldCall && !conference && heldCall.routeId && routeIdRef.current),
    connected: mediaReady || state === 'held' || state === 'active' || routePhase === 'connected',
    incoming: String(call?.direction || '').toLowerCase() === 'inbound',
    active: (routePhase ? ['requesting', 'ringing', 'connected'].includes(routePhase) : ['requesting', 'trying', 'ringing', 'answering', 'early', 'active', 'held', 'recovering'].includes(state)) && !incomingCall,
    notificationPermission, enableBrowserAlerts, audioBlocked, resumeAudio,
    startCall, startInternalCall, startSecondCall, startSecondInternalCall, swapCalls, mergeCalls, removeConferenceParticipant, transferCall, sendDtmf, answer, decline, hangup, toggleMute, toggleHold, disconnect,
  };
}
