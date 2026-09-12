import type { VercelRequest, VercelResponse } from '@vercel/node';
import { methodNotAllowed, publicError, requiredEnv } from '../../../shared/http.js';
import { readBusinessVoiceConfig } from '../../numbers/number-config.js';
import { findExtension, getExtension, listExtensions, listExtensionSipUsernames } from '../../organizations/pbx.js';
import { telnyx, TelnyxApiError } from '../../../shared/telnyx.js';
import { callAction, decodeVoiceState, dialCall, dialCallLegs, encodeVoiceState } from '../voice-control.js';
import { clearActiveCallRouteIfMatches, saveActiveCallRoute } from '../call-route-store.js';
import { pbxForOrganization, readPbxConfig } from '../../organizations/pbx-config-store.js';
import { storeVoicemail, storeVoicemailAudio } from '../voicemail-store.js';
import { claimOutboundCallWinner, clearOutboundCallPair, liveOutboundDestinationId, readOutboundCallPairByClient, readOutboundCallPairByDestination, readOutboundCallPairByRoute, saveOutboundCallPair, updateOutboundCallPair } from '../outbound-call-store.js';
import { terminateOutboundLegs, terminateOutboundPair, hangupConferenceParticipant, hangupCallControlIds } from '../outbound-cancel.js';
import { isInboundCallAnswered, isInboundCallInitiated, isParkedClientCall, ivrMenuSelection, voiceRouteHangupOutcome } from '../voice-routing.js';
import { answerParkedCallerThenBridge, bridgeOutboundCalls, prepareParkedCallerMedia } from '../outbound-bridge.js';
import { outboundUsesNativeBridgeOnAnswer } from '../outbound-native-bridge.js';
import { carrierFallbackVoice, renderVocivoPrompt } from '../../ai/voice-catalog.js';
import { readVoiceRoute, updateVoiceRoute } from '../voice-route-store.js';
import { verifyVoiceRouteToken } from '../voice-route-token.js';
import { normalizeE164, organizationForNumber } from '../../organizations/tenancy.js';
import { verifyTelnyxWebhook } from '../../../shared/telnyx-webhook-auth.js';
import { quarantineSecurityEvent } from '../../../shared/security-quarantine.js';
import { storeCallEvent } from '../call-event-store.js';
import { claimQueueCallStatus, clearQueueCall, readQueueCall, saveQueueCall } from '../queue-call-store.js';
import { agentStore } from '../../operations/agent-store.js';
import { clearConferenceCall, isConferenceEnded, markConferenceEnded, readConferenceCall, saveConferenceCall } from '../conference-call-store.js';
import { forwardingTargetForCause, userNoAnswerSeconds, userVoicemailEnabled } from '../../organizations/user-call-routing.js';
import { officeHoursDecision, userAvailableBySchedule } from '../../organizations/office-hours.js';
import { accessForOrganization } from '../../organizations/saas-access.js';
import { activeOrganizationExtensionTargets, extensionSipUri, organizationExtensionSipUri } from '../internal-sip.js';
import { sendIncomingCallWebPush } from '../../push/web-push-dispatcher.js';
import { claimReplayKey, releaseReplayKey } from '../../../shared/object-store.js';
import { activeAiTransferTargets, aiAssistantInstructions, aiAssistantTools, inboundAiCommandId, inboundAiRoutingKey } from '../../ai/ai-transfer.js';
import { createAiTransferToken } from '../../ai/ai-transfer-token.js';
import type { VoiceEvent } from '../webhook/contracts.js';
import { handleParkedClientInitiated } from '../webhook/parked-client-handler.js';
import { background, callerDisplay, customHeader, enterpriseRingbackUrl, logWebhookFailure } from '../webhook/support.js';

const e164 = /^\+[1-9]\d{6,14}$/;

class PendingCarrierTerminationError extends Error {}

async function requireHangup(ids: string[], command: string) {
  if (!await hangupCallControlIds(ids, command)) throw new PendingCarrierTerminationError('Carrier hangup is pending; retry this webhook.');
}

async function speakPrompt(callControlId: string, input: { payload: string; voice: string; [key: string]: unknown }) {
  const audioUrl = await renderVocivoPrompt(input.payload, input.voice);
  const { payload, voice, payload_type: _payloadType, ...shared } = input;
  return audioUrl
    ? callAction(callControlId, 'playback_start', { ...shared, audio_url: audioUrl, audio_type: 'wav', cache_audio: true })
    : callAction(callControlId, 'speak', { ...shared, payload, voice: carrierFallbackVoice(voice), payload_type: 'text' });
}

async function gatherPrompt(callControlId: string, input: { payload: string; invalid_payload: string; voice: string; [key: string]: unknown }) {
  const [audioUrl, invalidAudioUrl] = await Promise.all([renderVocivoPrompt(input.payload, input.voice), renderVocivoPrompt(input.invalid_payload, input.voice)]);
  const { payload, invalid_payload, voice, payload_type: _payloadType, ...shared } = input;
  return audioUrl
    ? callAction(callControlId, 'gather_using_audio', { ...shared, audio_url: audioUrl, ...(invalidAudioUrl ? { invalid_audio_url: invalidAudioUrl } : {}) })
    : callAction(callControlId, 'gather_using_speak', { ...shared, payload, invalid_payload, voice: carrierFallbackVoice(voice), payload_type: 'text' });
}

type AgentRouteOptions = {
  announceWaiting?: boolean;
  voicemailEnabled?: boolean;
  inboundNumber?: string;
  targetExtensionIds?: string[];
  forwardBusy?: string;
  forwardNoAnswer?: string;
  forwardUnavailable?: string;
  forwardingDepth?: number;
  forwardedFrom?: string[];
  dialFrom?: string;
};

async function routeToAgent(callControlId: string, department: string, waitingMessage: string, voice: string, eventId: string, destination: string | string[], targetExtensionId?: string, timeoutSeconds = 45, callerNumber?: string, callerName?: string, organizationId?: string, options: AgentRouteOptions = {}) {
  try {
  if (options.announceWaiting !== false) {
    await speakPrompt(callControlId, { payload: waitingMessage, voice, command_id: `${eventId}-wait` });
  } else {
    await callAction(callControlId, 'playback_start', { audio_url: enterpriseRingbackUrl(), loop: 'infinity', command_id: `${eventId}-ringback` })
      .catch((error) => logWebhookFailure('start agent ringback', error));
  }
  const businessName = organizationId
    ? (await readBusinessVoiceConfig(organizationId)).companyName
    : 'Vocivo';
  const webPushTargets = [...new Set([targetExtensionId, ...(options.targetExtensionIds || [])].filter((value): value is string => Boolean(value)))];
  if (organizationId && webPushTargets.length) {
    background('incoming web push', sendIncomingCallWebPush({
      organizationId,
      extensionIds: webPushTargets,
      callerName: callerName || undefined,
      callId: callControlId,
    }));
  }
  const remoteIdentity = callerName || callerNumber;
  const dialFrom = [options.dialFrom, options.inboundNumber, callerNumber].find((value) => value && e164.test(value));
  if (!dialFrom) throw new Error('No explicit inbound caller identity is available for the agent leg.');
  await dialCall({
    to: destination,
    state: {
      flow: 'agent', department, parentCallControlId: callControlId, targetExtensionId,
      targetExtensionIds: options.targetExtensionIds, callerNumber, callerName, organizationId,
      inboundNumber: options.inboundNumber, voicemailEnabled: options.voicemailEnabled !== false,
      forwardBusy: options.forwardBusy, forwardNoAnswer: options.forwardNoAnswer,
      forwardUnavailable: options.forwardUnavailable, forwardingDepth: options.forwardingDepth,
      forwardedFrom: options.forwardedFrom,
    },
    from: dialFrom,
    fromDisplayName: callerDisplay(remoteIdentity ? `${businessName} - ${remoteIdentity}` : `${businessName} call`),
    commandId: `${eventId}-agent`,
    timeoutSeconds,
  });
  } catch (error) {
    logWebhookFailure('route caller to agent', error);
    await failCallerAfterRoutingError(callControlId, eventId, organizationId, callerNumber, callerName, options.voicemailEnabled);
  }
}

async function routeToAvailableAgent(input: {
  callControlId: string;
  department: string;
  eventId: string;
  organizationId: string;
  inboundNumber: string;
  callerNumber?: string;
  callerName?: string;
  preferMain?: boolean;
}) {
  const config = await readBusinessVoiceConfig(input.organizationId);
  const target = await resolveOrganizationDestination(input.organizationId, input.inboundNumber, input.department, input.preferMain);
  const pbx = await readPbxConfig();
  const mainTargets = !target && input.preferMain
    ? activeOrganizationExtensionTargets(pbx, input.organizationId, await listExtensions(input.organizationId))
    : [];
  const destinations = target?.sipUsername
    ? [organizationExtensionSipUri(pbx, input.organizationId, target.sipUsername)]
    : mainTargets.map((item) => item.destination);
  const destination = destinations.length === 1 ? destinations[0] : destinations;
  if (destinations.length) {
    if (target) {
      await routeToExtension({ ...input, extension: target, announceWaiting: !input.preferMain });
    } else {
      await routeToAgent(input.callControlId, input.department, config.waitingMessage, config.voice, input.eventId, destination, undefined, config.voicemailDelaySeconds, input.callerNumber, input.callerName, input.organizationId, {
        announceWaiting: !input.preferMain,
        voicemailEnabled: config.voicemailEnabled,
        inboundNumber: input.inboundNumber,
        targetExtensionIds: mainTargets.map((item) => item.extensionId),
      });
    }
    return;
  }
  const flow = config.voicemailEnabled ? 'voicemail_prompt' : 'unavailable_prompt';
  await speakPrompt(input.callControlId, {
    payload: config.voicemailEnabled ? config.voicemailGreeting : 'No one is available to take your call right now. Please try again later.',
    voice: config.voice,
    client_state: encodeVoiceState({ flow, callerNumber: input.callerNumber, callerName: input.callerName, organizationId: input.organizationId }),
    command_id: `${input.eventId}-unavailable`,
  });
}

async function resolveOrganizationDestination(organizationId: string, inboundNumber: string, department?: string, preferMain = false) {
  const pbx = await readPbxConfig();
  const assignment = pbx.numberAssignments[normalizeE164(inboundNumber)];
  if (assignment?.organizationId === organizationId && assignment.destinationType === 'main') return null;
  if (assignment?.organizationId === organizationId && assignment.destinationType === 'extension' && assignment.destinationId) {
    const extension = await getExtension(assignment.destinationId, organizationId).catch(() => null);
    if (extension?.status === 'active' && extension.organizationId === organizationId) return extension;
  }
  if (preferMain) return null;
  const extensions = (await listExtensions(organizationId)).filter((item) => item.status === 'active' && item.sipUsername);
  const departmental = department ? extensions.find((item) => item.department.toLowerCase() === department.toLowerCase()) : null;
  return departmental || extensions[0] || null;
}

async function routeUnavailable(callControlId: string, organizationId: string, eventId: string, callerNumber?: string, callerName?: string, voicemailOverride?: boolean) {
  const config = await readBusinessVoiceConfig(organizationId);
  const voicemailEnabled = config.voicemailEnabled && voicemailOverride !== false;
  const flow = voicemailEnabled ? 'voicemail_prompt' : 'unavailable_prompt';
  await speakPrompt(callControlId, {
    payload: voicemailEnabled ? config.voicemailGreeting : 'No one is available to take your call right now. Please try again later.',
    voice: config.voice,
    client_state: encodeVoiceState({ flow, callerNumber, callerName, organizationId }),
    command_id: `${eventId}-unavailable`,
  });
}

async function failCallerAfterRoutingError(callControlId: string, eventId: string, organizationId?: string, callerNumber?: string, callerName?: string, voicemailEnabled?: boolean) {
  try {
    if (!organizationId) throw new Error('No tenant is available for the routing failure prompt.');
    await routeUnavailable(callControlId, organizationId, eventId, callerNumber, callerName, voicemailEnabled);
  } catch (fallbackError) {
    logWebhookFailure('route caller after routing failure', fallbackError);
    await requireHangup([callControlId], `${eventId}-routing-failed`);
  }
}

async function routeToExtension(input: {
  callControlId: string;
  eventId: string;
  organizationId: string;
  inboundNumber: string;
  extension: Awaited<ReturnType<typeof getExtension>>;
  department?: string;
  callerNumber?: string;
  callerName?: string;
  announceWaiting?: boolean;
  forwardingDepth?: number;
  forwardedFrom?: string[];
}) {
  const [config, basePbx, extensions] = await Promise.all([
    readBusinessVoiceConfig(input.organizationId),
    readPbxConfig(),
    listExtensions(input.organizationId),
  ]);
  const pbx = pbxForOrganization(basePbx, input.organizationId);
  const profile = pbx.userProfiles[input.extension.id];
  const voicemailEnabled = userVoicemailEnabled(profile, config.voicemailEnabled);
  if (!userAvailableBySchedule(profile, pbx.officeHours)) {
    await routeUnavailable(input.callControlId, input.organizationId, input.eventId, input.callerNumber, input.callerName, voicemailEnabled);
    return;
  }

  const primarySipUsers = await listExtensionSipUsernames(input.extension.id);
  const destinations = (primarySipUsers.length ? primarySipUsers : [input.extension.sipUsername]).map(extensionSipUri);
  const targetExtensionIds = [input.extension.id];
  let dialFrom: string | undefined;
  const simultaneous = profile?.simultaneousRing?.trim() || '';
  const simultaneousExtension = extensions.find((item) => item.extension === simultaneous && item.id !== input.extension.id && item.status === 'active' && item.sipUsername);
  if (simultaneousExtension) {
    const simultaneousSipUsers = await listExtensionSipUsernames(simultaneousExtension.id);
    destinations.push(...(simultaneousSipUsers.length ? simultaneousSipUsers : [simultaneousExtension.sipUsername]).map(extensionSipUri));
    targetExtensionIds.push(simultaneousExtension.id);
  } else {
    const simultaneousNumber = normalizeE164(simultaneous);
    if (e164.test(simultaneousNumber)) {
      const inboundIdentity = normalizeE164(input.inboundNumber);
      if (e164.test(inboundIdentity)) {
        destinations.push(simultaneousNumber);
        dialFrom = inboundIdentity;
      } else {
        console.warn('Vocivo skipped an external simultaneous-ring leg without an assigned inbound caller identity.');
      }
    }
  }

  await routeToAgent(
    input.callControlId,
    input.department || `${input.extension.name}, extension ${input.extension.extension}`,
    config.waitingMessage,
    config.voice,
    input.eventId,
    destinations.length === 1 ? destinations[0] : destinations,
    input.extension.id,
    userNoAnswerSeconds(profile, config.voicemailDelaySeconds),
    input.callerNumber,
    input.callerName,
    input.organizationId,
    {
      announceWaiting: input.announceWaiting,
      voicemailEnabled,
      inboundNumber: input.inboundNumber,
      targetExtensionIds,
      forwardBusy: profile?.forwardBusy,
      forwardNoAnswer: profile?.forwardNoAnswer,
      forwardUnavailable: profile?.forwardUnavailable,
      forwardingDepth: input.forwardingDepth || 0,
      forwardedFrom: input.forwardedFrom,
      dialFrom,
    },
  );
}

async function routeAfterAgentFailure(state: NonNullable<ReturnType<typeof decodeVoiceState>>, cause: string, eventId: string) {
  const organizationId = state.organizationId;
  if (!organizationId) throw new Error('Inbound call state has no tenant organization.');
  const target = forwardingTargetForCause(state, cause);
  const visited = [...(state.forwardedFrom || []), ...(state.targetExtensionId ? [state.targetExtensionId] : [])].slice(-5);
  const voicemailTarget = !target || ['voicemail', 'main voicemail'].includes(target.toLowerCase());
  if (voicemailTarget || (state.forwardingDepth || 0) >= 2) {
    await routeUnavailable(state.parentCallControlId || '', organizationId, eventId, state.callerNumber, state.callerName, state.voicemailEnabled);
    return;
  }

  const extension = await findExtension(target.replace(/\D/g, ''), organizationId);
  if (extension && extension.id !== state.targetExtensionId && !visited.includes(extension.id)) {
    await routeToExtension({
      callControlId: state.parentCallControlId || '', eventId, organizationId,
      inboundNumber: state.inboundNumber || '', extension,
      callerNumber: state.callerNumber, callerName: state.callerName,
      announceWaiting: false, forwardingDepth: (state.forwardingDepth || 0) + 1,
      forwardedFrom: visited,
    });
    return;
  }

  const destination = normalizeE164(target);
  if (e164.test(destination)) {
    const config = await readBusinessVoiceConfig(organizationId);
    const from = normalizeE164(state.inboundNumber || '');
    if (!e164.test(from)) {
      await routeUnavailable(state.parentCallControlId || '', organizationId, eventId, state.callerNumber, state.callerName, state.voicemailEnabled);
      return;
    }
    await routeToAgent(state.parentCallControlId || '', 'Forwarded call', config.waitingMessage, config.voice, eventId, destination, undefined, 45, state.callerNumber, state.callerName, organizationId, {
      announceWaiting: false, voicemailEnabled: state.voicemailEnabled, inboundNumber: state.inboundNumber,
      forwardingDepth: (state.forwardingDepth || 0) + 1, forwardedFrom: visited, dialFrom: from,
    });
    return;
  }
  await routeUnavailable(state.parentCallControlId || '', organizationId, eventId, state.callerNumber, state.callerName, state.voicemailEnabled);
}

async function endConferenceRoom(room: string | undefined, eventId: string) {
  if (!room) return;
  await markConferenceEnded(room);
  const conference = await readConferenceCall(room);
  await Promise.all((conference?.guestCallControlIds || []).map((id) => requireHangup([id], `${eventId}-end-guest-${id.slice(-8)}`)));
  if (conference?.conferenceId) {
    await telnyx(`/conferences/${encodeURIComponent(conference.conferenceId)}`, { method: 'DELETE' }).catch(error => {
      if (!(error instanceof TelnyxApiError && error.status === 404)) throw error;
    });
  }
  await clearConferenceCall(room);
}

function cleanQueuePart(value: string) { return value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'route'; }

async function routeToCallGroup(input: {
  callControlId: string;
  eventId: string;
  organizationId: string;
  handlingId: string;
  kind: 'ring_group' | 'queue';
  inboundNumber?: string;
  callerNumber?: string;
  callerName?: string;
}) {
  const [basePbx, extensions] = await Promise.all([
    readPbxConfig(),
    listExtensions(input.organizationId),
  ]);
  const pbx = pbxForOrganization(basePbx, input.organizationId);
  const collection = input.kind === 'ring_group' ? pbx.callHandling.ringGroups : pbx.callHandling.queues;
  const group = collection.find((item) => item.id === input.handlingId);
  const breaks = input.kind === 'queue' ? (await agentStore.read(input.organizationId, extensions.map(e => e.id))).filter(a => a.state === 'on_break').map(a => a.extensionId) : [];
  const members = group ? extensions.filter((extension) => group.members.includes(extension.id) && extension.status === 'active' && extension.sipUsername && !breaks.includes(extension.id)) : [];
  if (!group || !members.length) {
    await routeCallGroupFallback(input);
    return;
  }
  const queueName = `vocivo-${input.kind === 'queue' ? 'q' : 'rg'}-${cleanQueuePart(group.id)}-${Date.now().toString(36)}`;
  const maxWaitSeconds = input.kind === 'queue'
    ? Math.min(900, Math.max(15, ('maxWait' in group ? group.maxWait : 180) || 180))
    : Math.min(120, Math.max(10, ('timeout' in group ? group.timeout : 25) || 25));
  await saveQueueCall({
    queueName,
    parentCallControlId: input.callControlId,
    organizationId: input.organizationId,
    handlingId: group.id,
    kind: input.kind,
    status: 'waiting',
    agentCallControlIds: [],
    updatedAt: new Date().toISOString(),
  });
  try {
    await callAction(input.callControlId, 'enqueue', {
      queue_name: queueName,
      max_wait_time_secs: maxWaitSeconds,
      max_size: 100,
      client_state: encodeVoiceState({
        flow: 'queue_wait', queueName, handlingId: group.id, organizationId: input.organizationId,
        targetExtensionIds: members.map((member) => member.id), inboundNumber: input.inboundNumber, callerNumber: input.callerNumber, callerName: input.callerName,
      }),
      command_id: `${input.eventId}-enqueue`,
    });
  } catch (enqueueError) {
    logWebhookFailure('enqueue caller', enqueueError);
    await clearQueueCall(queueName).catch((error) => logWebhookFailure('clear failed queue call', error));
    await failCallerAfterRoutingError(input.callControlId, input.eventId, input.organizationId, input.callerNumber, input.callerName);
    return;
  }
  // Dialing begins from call.enqueued so the waiting leg is ready before an agent answers.
}

async function routeCallGroupFallback(input: {
  callControlId: string;
  eventId: string;
  organizationId: string;
  handlingId: string;
  kind: 'ring_group' | 'queue';
  inboundNumber?: string;
  callerNumber?: string;
  callerName?: string;
}) {
  const pbx = pbxForOrganization(await readPbxConfig(), input.organizationId);
  const item = input.kind === 'ring_group'
    ? pbx.callHandling.ringGroups.find((entry) => entry.id === input.handlingId)
    : pbx.callHandling.queues.find((entry) => entry.id === input.handlingId);
  if (item?.fallback === 'Main line') {
    const config = await readBusinessVoiceConfig(input.organizationId);
    await routeToAvailableAgent({
      callControlId: input.callControlId, eventId: input.eventId,
      department: config.companyName, organizationId: input.organizationId,
      inboundNumber: input.inboundNumber || '', callerNumber: input.callerNumber,
      callerName: input.callerName, preferMain: true,
    });
    return;
  }
  await routeUnavailable(input.callControlId, input.organizationId, input.eventId, input.callerNumber, input.callerName);
}

function configuredTargetLabel(target: string, pbx: Awaited<ReturnType<typeof readPbxConfig>>, extensions: Awaited<ReturnType<typeof listExtensions>>) {
  const [type, id] = target.includes(':') ? target.split(':', 2) : ['extension', target];
  if (type === 'extension') return extensions.find((item) => item.id === id)?.name || 'an extension';
  const collection = type === 'ring_group' ? pbx.callHandling.ringGroups : type === 'queue' ? pbx.callHandling.queues : [];
  return collection.find((item) => item.id === id)?.name || 'a team';
}

async function routeToConfiguredIvr(input: { callControlId: string; eventId: string; organizationId: string; handlingId: string; inboundNumber?: string; callerNumber?: string; callerName?: string }) {
  const [basePbx, config, extensions] = await Promise.all([readPbxConfig(), readBusinessVoiceConfig(input.organizationId), listExtensions(input.organizationId)]);
  const pbx = pbxForOrganization(basePbx, input.organizationId);
  const ivr = pbx.callHandling.ivrs.find((item) => item.id === input.handlingId);
  const entries = Object.entries(ivr?.options || {}).filter(([digit, target]) => /^\d$/.test(digit) && Boolean(target)).slice(0, 10);
  if (!ivr || !entries.length) {
    await routeUnavailable(input.callControlId, input.organizationId, input.eventId, input.callerNumber, input.callerName);
    return;
  }
  const options = entries.map(([digit, target]) => `For ${configuredTargetLabel(target, pbx, extensions)}, press ${digit}.`).join(' ');
  await gatherPrompt(input.callControlId, {
    payload: `${ivr.greeting} ${options}`,
    invalid_payload: `That selection was not recognized. Please press one of these options: ${entries.map(([digit]) => digit).join(', ')}.`,
    voice: config.voice,
    minimum_digits: 1,
    maximum_digits: 1,
    valid_digits: entries.map(([digit]) => digit).join(''),
    maximum_tries: 2,
    timeout_millis: 10000,
    client_state: encodeVoiceState({ flow: 'configured_ivr', handlingId: ivr.id, organizationId: input.organizationId, inboundNumber: input.inboundNumber, callerNumber: input.callerNumber, callerName: input.callerName }),
    command_id: `${input.eventId}-configured-ivr`,
  });
}

async function routeToConfiguredTarget(input: { callControlId: string; eventId: string; organizationId: string; target: string; inboundNumber?: string; callerNumber?: string; callerName?: string }) {
  const [type, id] = input.target.includes(':') ? input.target.split(':', 2) : ['extension', input.target];
  if (type === 'ring_group' || type === 'queue') {
    await routeToCallGroup({ ...input, inboundNumber: input.inboundNumber, handlingId: id, kind: type });
    return;
  }
  const extension = type === 'extension' ? await getExtension(id, input.organizationId).catch(() => null) : null;
  if (extension?.status === 'active' && extension.organizationId === input.organizationId) {
    await routeToExtension({ ...input, inboundNumber: input.inboundNumber || '', extension, announceWaiting: false });
    return;
  }
  await routeUnavailable(input.callControlId, input.organizationId, input.eventId, input.callerNumber, input.callerName);
}

async function extensionForAgentState(state: NonNullable<ReturnType<typeof decodeVoiceState>>, destination?: string) {
  if (!state.targetExtensionIds?.length || !state.organizationId) return state.targetExtensionId || '';
  const sipUsername = String(destination || '').match(/^sip:([^@]+)@/i)?.[1];
  if (!sipUsername) return state.targetExtensionId || '';
  const target = (await listExtensions(state.organizationId)).find((item) => state.targetExtensionIds?.includes(item.id) && item.sipUsername === sipUsername);
  return target?.id || state.targetExtensionId || '';
}

const webhookDependencies = { verifyTelnyxWebhook, background, storeCallEvent, readQueueCall, clearQueueCall, requireHangup, readVoiceRoute, readOutboundCallPairByClient,
  readOutboundCallPairByDestination, readOutboundCallPairByRoute, updateVoiceRoute,
  saveOutboundCallPair, terminateOutboundPair, hangupConferenceParticipant, terminateOutboundLegs,
  claimOutboundCallWinner, prepareParkedCallerMedia, answerParkedCallerThenBridge };

export function createVoiceWebhookHandler(dependencies: Partial<typeof webhookDependencies> = {}) {
  const deps = { ...webhookDependencies, ...dependencies };
  const { verifyTelnyxWebhook, background, storeCallEvent, readQueueCall, clearQueueCall, requireHangup, readVoiceRoute, readOutboundCallPairByClient,
    readOutboundCallPairByDestination, readOutboundCallPairByRoute, updateVoiceRoute,
    saveOutboundCallPair, claimOutboundCallWinner, prepareParkedCallerMedia, answerParkedCallerThenBridge } = deps;
  const terminateOutboundPair: typeof deps.terminateOutboundPair = async (...args) => {
    const result = await deps.terminateOutboundPair(...args);
    if (!result.complete) throw new PendingCarrierTerminationError('Carrier termination is pending; retry this webhook.');
    return result;
  };
  const hangupConferenceParticipant: typeof deps.hangupConferenceParticipant = async (...args) => {
    const complete = await deps.hangupConferenceParticipant(...args);
    if (!complete) throw new PendingCarrierTerminationError('Conference termination is pending; retry this webhook.');
    return complete;
  };
  const terminateOutboundLegs: typeof deps.terminateOutboundLegs = async (...args) => {
    const pair = await deps.terminateOutboundLegs(...args).catch(() => { throw new PendingCarrierTerminationError('Fork termination could not be confirmed; retry this webhook.'); });
    if (!args[1].every(id => pair.termination?.[id]?.status === 'terminated')) {
      throw new PendingCarrierTerminationError('Fork termination is pending; retry this webhook.');
    }
    return pair;
  };
  return async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!await verifyTelnyxWebhook(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const event = (req.body ?? {}) as VoiceEvent;
    const data = event.data;
    const payload = data?.payload;
    const eventType = data?.event_type || '';
    const eventId = data?.id || `event-${Date.now()}`;
    const callControlId = payload?.call_control_id;
    const state = decodeVoiceState(payload?.client_state);
    if (!callControlId) return res.status(200).json({ received: true });
    const parkedFlow = customHeader(payload, 'X-Vocivo-Flow');
    const eventRoute = verifyVoiceRouteToken(customHeader(payload, 'X-Vocivo-Route-Token'));
    background('call event', (async () => {
      const eventOrganizationId = state?.organizationId || eventRoute?.organizationId || await organizationForNumber(payload?.direction === 'incoming' ? payload?.to || '' : payload?.from || '');
      if (!eventOrganizationId) {
        await quarantineSecurityEvent({ source: 'telnyx-voice', reason: 'unresolved_number_ownership', eventId, details: { eventType, callControlId, direction: payload?.direction || '', from: payload?.from || '', to: payload?.to || '' } });
        return;
      }
      await storeCallEvent({
        id: eventId,
        name: eventType || 'unknown',
        type: 'webhook',
        event_timestamp: data?.occurred_at || new Date().toISOString(),
        call_session_id: payload?.call_session_id,
        call_leg_id: payload?.call_leg_id,
        call_control_id: callControlId,
        direction: payload?.direction,
        from: payload?.from,
        to: payload?.to,
        hangup_cause: payload?.hangup_cause,
        organizationId: eventOrganizationId,
        flow: state?.flow || parkedFlow,
        routeId: state?.routeId || eventRoute?.routeId,
        sourceExtensionId: state?.sourceExtensionId || eventRoute?.sourceExtensionId,
        sourceExtension: state?.sourceExtension || eventRoute?.callerExtension,
        sourceName: state?.sourceName || eventRoute?.callerName,
        destinationExtensionId: state?.destinationExtensionId || eventRoute?.destinationExtensionId,
        destinationExtension: state?.destinationExtension || eventRoute?.destinationExtension,
        destinationName: state?.destinationName || eventRoute?.destinationName,
      });
    })());

    const routeInput = {
      connectionId: payload?.connection_id,
      callControlApplicationId: requiredEnv('TELNYX_CALL_CONTROL_APP_ID'),
      hasManagedState: Boolean(state),
    };
    const outboundPair = eventType === 'call.answered' && !state ? await readOutboundCallPairByDestination(callControlId) : null;
    const endedOutboundPair = eventType === 'call.hangup' && !state ? await readOutboundCallPairByDestination(callControlId) : null;
    const isInboundInitiated = isInboundCallInitiated({ ...routeInput, direction: payload?.direction });
    const isInboundAnswered = eventType === 'call.answered'
      && (state?.flow === 'inbound_root' || isInboundCallAnswered({ ...routeInput, hasOutboundPair: Boolean(outboundPair) }));
    const isParkedVocivoClient = isParkedClientCall({
      connectionId: payload?.connection_id,
      credentialConnectionId: requiredEnv('TELNYX_CONNECTION_ID'),
      direction: payload?.direction,
      flow: parkedFlow,
      flowDestination: payload?.flow_destination,
      state: payload?.state,
    });

    if (eventType === 'call.initiated' && state?.flow === 'outbound_destination' && state.parentCallControlId) {
      const [existingRoute, existingPair] = await Promise.all([
        state.routeId ? readVoiceRoute(state.routeId) : null,
        state.routeId ? readOutboundCallPairByRoute(state.routeId) : readOutboundCallPairByClient(state.parentCallControlId),
      ]);
      const terminal = [existingRoute?.phase, existingPair?.phase].some(phase => phase === 'ended' || phase === 'failed');
      const connected = existingRoute?.phase === 'connected' || existingPair?.phase === 'connected';
      if (terminal || connected) {
        // Telnyx may deliver initiated after answered/bridged. Preserve the winner.
        if (!terminal && existingPair?.selectedDestinationCallControlId === callControlId) return res.status(200).json({ received: true });
        await requireHangup([callControlId], `${eventId}-late-fork`);
        return res.status(200).json({ received: true });
      }
      const forkDestinationCallControlIds = [...new Set([
        ...(existingPair?.forkDestinationCallControlIds || []),
        existingPair?.destinationCallControlId,
        callControlId,
      ].filter((id): id is string => Boolean(id)))];
      const pair = {
        clientCallControlId: state.parentCallControlId,
        destinationCallControlId: existingPair?.destinationCallControlId || callControlId,
        forkDestinationCallControlIds,
        routeId: state.routeId,
        destination: payload?.to || existingPair?.destination || '',
        status: 'direct' as const,
        phase: 'ringing' as const,
        bridgeOnAnswer: existingPair?.bridgeOnAnswer === true || state.bridgeOnAnswer === true,
        updatedAt: new Date().toISOString(),
      };
      await saveOutboundCallPair(pair);
      if (state.routeId) await updateVoiceRoute(state.routeId, { phase: 'ringing' });
      return res.status(200).json({ received: true });
    }

    if (eventType === 'call.initiated' && state?.flow === 'agent' && state.parentCallControlId) {
      const existingPair = await readOutboundCallPairByClient(state.parentCallControlId);
      if (existingPair && ['connected', 'ended', 'failed'].includes(existingPair.phase || 'ringing')) {
        if (existingPair.phase === 'connected' && existingPair.selectedDestinationCallControlId === callControlId) return res.status(200).json({ received: true });
        await terminateOutboundLegs(existingPair, [callControlId], `${eventId}-late-agent`);
        return res.status(200).json({ received: true });
      }
      await saveOutboundCallPair({
        clientCallControlId: state.parentCallControlId,
        destinationCallControlId: existingPair?.destinationCallControlId || callControlId,
        forkDestinationCallControlIds: [...new Set([
          ...(existingPair?.forkDestinationCallControlIds || []),
          existingPair?.destinationCallControlId,
          callControlId,
        ].filter((id): id is string => Boolean(id)))],
        destination: payload?.to || existingPair?.destination || '',
        status: 'direct',
        phase: 'ringing',
        bridgeOnAnswer: false,
        updatedAt: new Date().toISOString(),
      });
      return res.status(200).json({ received: true });
    }

    if (eventType === 'call.initiated' && isParkedVocivoClient) {
      await handleParkedClientInitiated({ callControlId, eventId, parkedFlow, payload });
      return res.status(200).json({ received: true });
    }

    if (eventType === 'call.answered' && (state?.flow === 'outbound_destination' || outboundPair)) {
      const parentCallControlId = state?.flow === 'outbound_destination' ? state.parentCallControlId : outboundPair?.clientCallControlId;
      if (parentCallControlId) {
        const connectedRouteId = outboundPair?.routeId || (state?.flow === 'outbound_destination' ? state.routeId : undefined);
        const now = new Date().toISOString();
        const storedPair = outboundPair
          || await readOutboundCallPairByDestination(callControlId)
          || (connectedRouteId ? await readOutboundCallPairByRoute(connectedRouteId) : null);
        const nativeBridge = outboundUsesNativeBridgeOnAnswer(storedPair, state);
        const candidatePair = storedPair || {
          clientCallControlId: parentCallControlId,
          destinationCallControlId: callControlId,
          forkDestinationCallControlIds: [callControlId],
          routeId: connectedRouteId,
          destination: payload?.to || '',
          status: 'direct' as const,
          phase: 'ringing' as const,
          bridgeOnAnswer: nativeBridge,
          updatedAt: now,
        };
        let cleanupPair = candidatePair;
        try {
          if (parentCallControlId) {
            await prepareParkedCallerMedia(parentCallControlId, `${eventId}-early-media`);
          }
          const claim = await claimOutboundCallWinner(candidatePair, callControlId);
          cleanupPair = claim.pair;
          if (!claim.won) {
            await terminateOutboundLegs(claim.pair, [callControlId], `${eventId}-losing-fork`);
            return res.status(200).json({ received: true });
          }
          const existingRoute = connectedRouteId ? await readVoiceRoute(connectedRouteId) : null;
          if (existingRoute && ['ended', 'failed'].includes(existingRoute.phase)) {
            await terminateOutboundPair(claim.pair, `${eventId}-terminal`);
            return res.status(200).json({ received: true });
          }
          if (outboundUsesNativeBridgeOnAnswer(claim.pair, state)) {
            await prepareParkedCallerMedia(parentCallControlId, eventId);
          } else {
            await answerParkedCallerThenBridge(parentCallControlId, callControlId, eventId);
          }
          const connectedAt = new Date().toISOString();
          await saveOutboundCallPair({
            ...claim.pair,
            selectedDestinationCallControlId: callControlId,
            destinationCallControlId: callControlId,
            phase: 'connected',
            connectedAt,
            updatedAt: connectedAt,
          });
          if (connectedRouteId) await updateVoiceRoute(connectedRouteId, { phase: 'connected', connectedAt });
          if (claim.loserIds.length) await terminateOutboundLegs(claim.pair, claim.loserIds, `${eventId}-cancel-fork`);
        } catch (error) {
          if (error instanceof PendingCarrierTerminationError) throw error;
          console.error('Vocivo outbound bridge failed', { eventId, routeId: connectedRouteId, error: publicError(error) });
          if (connectedRouteId) await updateVoiceRoute(connectedRouteId, { phase: 'failed', failureCause: 'bridge_failed' })
            .catch((routeError) => console.error('Vocivo could not record failed route', publicError(routeError)));
          await terminateOutboundPair(cleanupPair, `${eventId}-bridge-failed`);
        }
        return res.status(200).json({ received: true });
      }
    }

    if (eventType === 'call.bridged') {
      if (state?.flow === 'agent' && state.parentCallControlId) {
        const pair = await readOutboundCallPairByDestination(callControlId)
          || await readOutboundCallPairByClient(state.parentCallControlId);
        if (pair) {
          const claim = await claimOutboundCallWinner(pair, callControlId);
          if (!claim.won) {
            await terminateOutboundLegs(claim.pair, [callControlId], `${eventId}-late-agent`);
            return res.status(200).json({ received: true });
          }
          const connectedAt = new Date().toISOString();
          await saveOutboundCallPair({
            ...claim.pair,
            selectedDestinationCallControlId: callControlId,
            destinationCallControlId: callControlId,
            phase: 'connected',
            connectedAt,
            updatedAt: connectedAt,
          });
          await callAction(state.parentCallControlId, 'playback_stop', {
            stop: 'all',
            command_id: `${eventId}-stop-bridged-waiting`,
          }).catch((error) => logWebhookFailure('stop bridged waiting playback', error));
          const targetExtensionId = await extensionForAgentState(state, payload?.to);
          if (targetExtensionId) {
            await saveActiveCallRoute({
              extensionId: targetExtensionId,
              parentCallControlId: state.parentCallControlId,
              agentCallControlId: callControlId,
              updatedAt: connectedAt,
            });
          }
        }
        return res.status(200).json({ received: true });
      }
      if (state?.flow === 'outbound_destination' && state.routeId) {
        const connectedAt = new Date().toISOString();
        const pair = await readOutboundCallPairByDestination(callControlId)
          || await readOutboundCallPairByRoute(state.routeId);
        if (pair && pair.phase !== 'connected') {
          await saveOutboundCallPair({
            ...pair,
            selectedDestinationCallControlId: pair.selectedDestinationCallControlId || callControlId,
            phase: 'connected',
            connectedAt,
            updatedAt: connectedAt,
          });
        }
        await updateVoiceRoute(state.routeId, { phase: 'connected', connectedAt });
        return res.status(200).json({ received: true });
      }
      const pair = await readOutboundCallPairByClient(callControlId)
        || await readOutboundCallPairByDestination(callControlId);
      if (pair?.status === 'direct' && pair.phase !== 'connected') {
        const connectedAt = new Date().toISOString();
        await saveOutboundCallPair({ ...pair, phase: 'connected', connectedAt, updatedAt: connectedAt });
        if (pair.bridgeOnAnswer) {
          await callAction(pair.clientCallControlId, 'playback_stop', {
            stop: 'all',
            command_id: `${eventId}-stop-bridged-ringback`,
          }).catch((error) => logWebhookFailure('stop bridge-on-answer ringback', error));
        }
        if (pair.routeId) await updateVoiceRoute(pair.routeId, { phase: 'connected', connectedAt });
      }
      return res.status(200).json({ received: true });
    }

    if (eventType === 'call.hangup' && (state?.flow === 'outbound_destination' || endedOutboundPair)) {
      if (state?.flow === 'outbound_destination') {
        const pair = await readOutboundCallPairByDestination(callControlId)
          || (state.routeId ? await readOutboundCallPairByRoute(state.routeId) : null);
        if (pair?.phase === 'connected' && pair.selectedDestinationCallControlId !== callControlId) {
          return res.status(200).json({ received: true });
        }
        const otherForks = (pair?.forkDestinationCallControlIds || [])
          .filter((id) => id !== callControlId);
        if (pair?.phase === 'ringing' && pair.clientCallControlId && !otherForks.length) {
          await callAction(pair.clientCallControlId, 'playback_stop', { stop: 'all', command_id: `${eventId}-stop-rejected-ringback` }).catch((error) => logWebhookFailure('stop rejected-call ringback', error));
          await requireHangup([pair.clientCallControlId], `${eventId}-end-rejected-client`);
        }
        if (pair?.phase === 'ringing' && otherForks.length) {
          await saveOutboundCallPair({
            ...pair,
            destinationCallControlId: otherForks[0],
            forkDestinationCallControlIds: otherForks,
            updatedAt: new Date().toISOString(),
          });
          return res.status(200).json({ received: true });
        }
        const outcome = voiceRouteHangupOutcome({ hangupCause: payload?.hangup_cause, telnyxError: payload?.telnyx_error });
        if (state.routeId) await updateVoiceRoute(state.routeId, outcome);
        if (pair && (pair.status === 'conference' || pair.status === 'merging')) {
          await hangupConferenceParticipant(pair, callControlId, `${eventId}-destination-hangup`);
        } else if (pair) {
          await terminateOutboundPair(pair, `${eventId}-destination-hangup`);
        } else if (state.parentCallControlId) {
          await callAction(state.parentCallControlId, 'playback_stop', { stop: 'all', command_id: `${eventId}-stop-ringback` }).catch((error) => logWebhookFailure('stop failed-call ringback', error));
          await requireHangup([state.parentCallControlId], `${eventId}-end-client`);
        }
        return res.status(200).json({ received: true });
      }
      const pair = endedOutboundPair || await readOutboundCallPairByDestination(callControlId);
      if (pair?.status === 'direct') {
        const outcome = voiceRouteHangupOutcome({ hangupCause: payload?.hangup_cause, telnyxError: payload?.telnyx_error });
        const endedPair = await saveOutboundCallPair({ ...pair, ...outcome, updatedAt: new Date().toISOString() });
        if (pair.routeId) await updateVoiceRoute(pair.routeId, outcome);
        await terminateOutboundPair(endedPair, `${eventId}-destination-hangup`);
      } else if (!pair && state?.routeId) {
        const outcome = voiceRouteHangupOutcome({ hangupCause: payload?.hangup_cause, telnyxError: payload?.telnyx_error });
        await updateVoiceRoute(state.routeId, outcome);
        if (state.parentCallControlId) {
          await callAction(state.parentCallControlId, 'playback_stop', { stop: 'all', command_id: `${eventId}-stop-ringback` }).catch((error) => logWebhookFailure('stop canceled-call ringback', error));
          await requireHangup([state.parentCallControlId], `${eventId}-end-client`);
        }
      }
      return res.status(200).json({ received: true });
    }

    if (eventType === 'call.hangup' && payload?.connection_id === requiredEnv('TELNYX_CONNECTION_ID')) {
      const routeId = state?.routeId || eventRoute?.routeId;
      const pair = await readOutboundCallPairByClient(callControlId)
        || (routeId ? await readOutboundCallPairByRoute(routeId) : null);
      const outcome = voiceRouteHangupOutcome({ hangupCause: payload?.hangup_cause, telnyxError: payload?.telnyx_error });
      if (!pair && routeId) await updateVoiceRoute(routeId, outcome);
      if (!pair) {
        if (state?.flow === 'conference_host') await endConferenceRoom(state.room, eventId);
        return res.status(200).json({ received: true });
      }
      if (pair.status === 'direct') {
        if (pair.routeId) await updateVoiceRoute(pair.routeId, outcome);
        await terminateOutboundPair(pair, `${eventId}-client-hangup`);
      } else if (pair.status === 'conference' && pair.conferenceRole === 'host') {
        await hangupConferenceParticipant(pair, callControlId, `${eventId}-client-hangup`);
      }
      return res.status(200).json({ received: true });
    }

    if (eventType === 'call.hangup' && state?.flow === 'conference_host') {
      await endConferenceRoom(state.room, eventId);
      return res.status(200).json({ received: true });
    }

    if (eventType === 'call.hangup') {
      const parentPair = await readOutboundCallPairByClient(callControlId);
      if (parentPair && parentPair.status !== 'conference') {
        const outcome = voiceRouteHangupOutcome({ hangupCause: payload?.hangup_cause, telnyxError: payload?.telnyx_error });
        if (parentPair.routeId) await updateVoiceRoute(parentPair.routeId, outcome);
        await terminateOutboundPair(parentPair, `${eventId}-parent-hangup`);
        return res.status(200).json({ received: true });
      }
    }

    if (eventType === 'call.answered' && state?.flow === 'agent' && state.parentCallControlId) {
      const targetExtensionId = await extensionForAgentState(state, payload?.to);
      if (state.flow === 'agent') {
        const storedPair = await readOutboundCallPairByDestination(callControlId)
          || await readOutboundCallPairByClient(state.parentCallControlId);
        const pair = storedPair || {
          clientCallControlId: state.parentCallControlId,
          destinationCallControlId: callControlId,
          forkDestinationCallControlIds: [callControlId],
          destination: payload?.to || '',
          status: 'direct' as const,
          phase: 'ringing' as const,
          bridgeOnAnswer: false,
          updatedAt: new Date().toISOString(),
        };
        const claim = await claimOutboundCallWinner(pair, callControlId);
        if (!claim.won) {
          await terminateOutboundLegs(claim.pair, [callControlId], `${eventId}-losing-agent`);
          return res.status(200).json({ received: true });
        }
        try {
          await bridgeOutboundCalls(state.parentCallControlId, callControlId, eventId);
        } catch (bridgeError) {
          console.error('Vocivo agent bridge failed', { eventId, error: publicError(bridgeError) });
          await terminateOutboundPair(claim.pair, `${eventId}-agent-bridge-failed`);
          throw bridgeError;
        }
        const connectedAt = new Date().toISOString();
        await saveOutboundCallPair({
          ...claim.pair,
          selectedDestinationCallControlId: callControlId,
          destinationCallControlId: callControlId,
          phase: 'connected',
          connectedAt,
          updatedAt: connectedAt,
        });
        if (claim.loserIds.length) await terminateOutboundLegs(claim.pair, claim.loserIds, `${eventId}-cancel-agent`);
      }
      await callAction(state.parentCallControlId, 'playback_stop', { stop: 'all', command_id: `${eventId}-stop-waiting` }).catch((error) => logWebhookFailure('stop waiting playback', error));
      if (targetExtensionId) {
        await saveActiveCallRoute({ extensionId: targetExtensionId, parentCallControlId: state.parentCallControlId, agentCallControlId: callControlId, updatedAt: new Date().toISOString() });
      }
    }
    if (eventType === 'call.hangup' && (state?.flow === 'agent' || state?.flow === 'queue_agent')) {
      const targetExtensionId = await extensionForAgentState(state, payload?.to);
      if (state.flow === 'agent' && state.parentCallControlId) {
        const pair = await readOutboundCallPairByDestination(callControlId)
          || await readOutboundCallPairByClient(state.parentCallControlId);
        if (pair?.phase === 'connected' && pair.selectedDestinationCallControlId !== callControlId) {
          return res.status(200).json({ received: true });
        }
        const otherForks = [...new Set([
          pair?.destinationCallControlId,
          ...(pair?.forkDestinationCallControlIds || []),
        ].filter((id): id is string => Boolean(id) && id !== callControlId))];
        if (pair?.phase === 'ringing' && otherForks.length) {
          await updateOutboundCallPair(pair, (current) => ({
            ...current,
            destinationCallControlId: otherForks[0],
            forkDestinationCallControlIds: otherForks,
            updatedAt: new Date().toISOString(),
          }));
          return res.status(200).json({ received: true });
        }
        if (targetExtensionId) await clearActiveCallRouteIfMatches(targetExtensionId, callControlId);
        const cause = (payload?.hangup_cause || '').toLowerCase();
        if (!pair) return res.status(200).json({ received: true });
        if (pair.phase === 'connected') {
          await terminateOutboundPair(pair, `${eventId}-end-caller`);
        } else {
          await callAction(state.parentCallControlId, 'playback_stop', { stop: 'all', command_id: `${eventId}-stop-waiting` }).catch((error) => logWebhookFailure('stop rejected waiting playback', error));
          await routeAfterAgentFailure(state, cause, eventId);
          await clearOutboundCallPair(pair);
        }
      } else if (state.flow === 'queue_agent' && state.parentCallControlId) {
        if (targetExtensionId) await clearActiveCallRouteIfMatches(targetExtensionId, callControlId);
        const queue = state.queueName ? await readQueueCall(state.queueName) : null;
        if (queue && (queue.status === 'connected' || queue.status === 'connecting')) {
          await Promise.all((queue.agentCallControlIds || []).filter((id) => id !== callControlId).map((id) => requireHangup([id], `${eventId}-end-queue-agent-${id.slice(-8)}`)));
          await requireHangup([state.parentCallControlId], `${eventId}-end-queued-caller`);
          await clearQueueCall(state.queueName || queue.queueName);
        }
      } else if (targetExtensionId) {
        await clearActiveCallRouteIfMatches(targetExtensionId, callControlId);
      }
    }

    if (eventType === 'call.enqueued' && state?.flow === 'queue_wait' && state.queueName && state.organizationId && state.targetExtensionIds?.length) {
      const queue = await readQueueCall(state.queueName);
      if (!queue || queue.status !== 'waiting') return res.status(200).json({ received: true });
      const queueDialKey = `queue-dial:${state.queueName}`;
      if (!await claimReplayKey(queueDialKey, new Date(Date.now() + 4 * 60 * 60 * 1000))) {
        return res.status(200).json({ received: true, ignored: 'duplicate_queue_dial' });
      }
      try {
      const organizationId = state.organizationId;
      const pbx = await readPbxConfig();
      const [config, extensions] = await Promise.all([readBusinessVoiceConfig(organizationId), listExtensions(organizationId)]);
      const breaks = queue.kind === 'queue' ? (await agentStore.read(organizationId, extensions.map(e => e.id))).filter(a => a.state === 'on_break').map(a => a.extensionId) : [];
      const members = extensions.filter((extension) => state.targetExtensionIds?.includes(extension.id) && extension.status === 'active' && extension.sipUsername && !breaks.includes(extension.id));
      if (!members.length) {
        await clearQueueCall(state.queueName);
        await callAction(callControlId, 'leave_queue', { command_id: `${eventId}-empty-queue` }).catch((error) => logWebhookFailure('leave empty queue', error));
        await routeUnavailable(callControlId, organizationId, eventId, state.callerNumber, state.callerName);
        return res.status(200).json({ received: true });
      }
      await saveQueueCall({ ...queue, status: 'dialing', updatedAt: new Date().toISOString() });
      await speakPrompt(callControlId, { payload: config.waitingMessage, voice: config.voice, command_id: `${eventId}-queue-waiting` }).catch((error) => logWebhookFailure('speak queue waiting prompt', error));
      const queueFrom = [state.inboundNumber, state.callerNumber].find((value) => value && e164.test(value));
      if (!queueFrom) throw new Error('No explicit inbound caller identity is available for the queue leg.');
      const agentCall = await dialCall({
        to: members.map((member) => organizationExtensionSipUri(pbx, organizationId, member.sipUsername)),
        from: queueFrom,
        fromDisplayName: queue.kind === 'queue' ? 'Queued business call' : 'Business group call',
        state: { flow: 'queue_agent', queueName: state.queueName, handlingId: state.handlingId, parentCallControlId: callControlId, organizationId, targetExtensionIds: members.map((member) => member.id), callerNumber: state.callerNumber, callerName: state.callerName },
        timeoutSeconds: queue.kind === 'queue' ? 45 : Math.min(120, Math.max(10, pbxForOrganization(pbx, organizationId).callHandling.ringGroups.find((item) => item.id === queue.handlingId)?.timeout || 25)),
        commandId: `${eventId}-queue-agents`,
      });
      const agentCallControlIds = dialCallLegs(agentCall)
        .map((leg) => leg.call_control_id)
        .filter((id): id is string => Boolean(id));
      await claimQueueCallStatus(state.queueName, ['dialing'], 'dialing', { agentCallControlIds }).catch((error) => logWebhookFailure('record queue agent legs', error));
      } catch (queueDialError) {
        await releaseReplayKey(queueDialKey).catch((releaseError) => logWebhookFailure('release failed queue dial claim', releaseError));
        throw queueDialError;
      }
      return res.status(200).json({ received: true });
    }

    if (eventType === 'call.answered' && state?.flow === 'queue_agent' && state.queueName && state.parentCallControlId) {
      const claim = await claimQueueCallStatus(state.queueName, ['waiting', 'dialing'], 'connecting', { bridgedAgentCallControlId: callControlId });
      if (!claim.claimed) {
        if (claim.queue?.bridgedAgentCallControlId === callControlId) return res.status(200).json({ received: true, ignored: 'duplicate_queue_bridge' });
        await requireHangup([callControlId], `${eventId}-duplicate-agent`);
        return res.status(200).json({ received: true });
      }
      try {
        await callAction(callControlId, 'bridge', { queue: state.queueName, command_id: `${eventId}-bridge-queue` });
      } catch (bridgeError) {
        await claimQueueCallStatus(state.queueName, ['connecting'], 'dialing', { bridgedAgentCallControlId: undefined }).catch((error) => logWebhookFailure('restore queue after failed bridge', error));
        await requireHangup([callControlId], `${eventId}-queue-bridge-failed`);
        throw bridgeError;
      }
      await claimQueueCallStatus(state.queueName, ['connecting'], 'connected').catch((error) => logWebhookFailure('record connected queue bridge', error));
      await callAction(state.parentCallControlId, 'playback_stop', { stop: 'all', command_id: `${eventId}-stop-waiting` }).catch((error) => logWebhookFailure('stop waiting playback', error));
      const targetExtensionId = await extensionForAgentState(state, payload?.to);
      if (targetExtensionId) {
        await saveActiveCallRoute({ extensionId: targetExtensionId, parentCallControlId: state.parentCallControlId, agentCallControlId: callControlId, updatedAt: new Date().toISOString() });
      }
      return res.status(200).json({ received: true });
    }

    if (eventType === 'call.dequeued' && state?.flow === 'queue_wait' && state.queueName && state.organizationId) {
      const queue = await readQueueCall(state.queueName);
      if (!queue) return res.status(200).json({ received: true });
      const connected = queue.status === 'connected' || queue.status === 'connecting';
      const losers = (queue.agentCallControlIds || []).filter(id => !connected || id !== queue.bridgedAgentCallControlId);
      await requireHangup(losers, `${eventId}-dequeued-agent`);
      if (connected) return res.status(200).json({ received: true });
      await routeCallGroupFallback({ callControlId, eventId, organizationId: state.organizationId, handlingId: state.handlingId || '', kind: queue.kind || 'queue', inboundNumber: state.inboundNumber, callerNumber: state.callerNumber, callerName: state.callerName });
      await clearQueueCall(state.queueName);
      return res.status(200).json({ received: true });
    }

    if (eventType === 'call.hangup' && state?.flow === 'queue_wait' && state.queueName) {
      const queue = await readQueueCall(state.queueName);
      await requireHangup(queue?.agentCallControlIds || [], `${eventId}-end-agent`);
      await clearQueueCall(state.queueName);
      return res.status(200).json({ received: true });
    }

    if (['call.speak.ended', 'call.playback.ended'].includes(eventType) && state?.flow === 'voicemail_prompt') {
      await callAction(callControlId, 'record_start', {
        format: 'mp3',
        channels: 'single',
        recording_track: 'inbound',
        play_beep: true,
        max_length: 120,
        timeout_secs: 6,
        trim: 'trim-silence',
        client_state: encodeVoiceState({ flow: 'voicemail_recording', callerNumber: state.callerNumber, callerName: state.callerName, organizationId: state.organizationId }),
        command_id: `${eventId}-voicemail-record`,
      });
      return res.status(200).json({ received: true });
    }

    if (['call.speak.ended', 'call.playback.ended'].includes(eventType) && state?.flow === 'unavailable_prompt') {
      await requireHangup([callControlId], `${eventId}-unavailable-finish`);
      return res.status(200).json({ received: true });
    }

    if (eventType === 'call.recording.saved' && state?.flow === 'voicemail_recording' && state.organizationId) {
      const recordingId = payload?.recording_id || data?.id || eventId;
      const sourceUrl = payload?.recording_urls?.mp3 || payload?.public_recording_urls?.mp3;
      if (sourceUrl) {
        const recordingPath = await storeVoicemailAudio(recordingId, sourceUrl);
        const started = payload?.recording_started_at ? new Date(payload.recording_started_at).getTime() : 0;
        const ended = payload?.recording_ended_at ? new Date(payload.recording_ended_at).getTime() : 0;
        await storeVoicemail({
          id: recordingId,
          recordingId,
          callerNumber: state.callerNumber || payload?.from || 'Unknown caller',
          callerName: state.callerName,
          recordingPath,
          durationSeconds: started && ended ? Math.max(0, Math.round((ended - started) / 1000)) : undefined,
          createdAt: payload?.recording_ended_at || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          organizationId: state.organizationId,
        });
      }
      await requireHangup([callControlId], `${eventId}-voicemail-finish`);
      return res.status(200).json({ received: true });
    }

    if (eventType === 'call.initiated' && isInboundInitiated) {
      const inboundOrganizationId = await organizationForNumber(payload?.to || '');
      try {
        const access = await accessForOrganization(inboundOrganizationId);
        if (!access.features.phoneNumbers) throw new Error('Feature not enabled');
      } catch (error) {
        logWebhookFailure('verify tenant inbound entitlement', error);
        await requireHangup([callControlId], `${eventId}-service-unavailable`);
        return res.status(200).json({ received: true });
      }
      await callAction(callControlId, 'answer', {
        client_state: encodeVoiceState({ flow: 'inbound_root', organizationId: inboundOrganizationId, inboundNumber: payload?.to, callerNumber: payload?.from, callerName: payload?.caller_id_name }),
        command_id: `${eventId}-answer`,
      }).catch((error) => logWebhookFailure('answer inbound call', error));
      return res.status(200).json({ received: true });
    }

    if (eventType === 'call.answered' && state?.flow === 'conference_host') {
      let conferenceId: string | undefined;
      try {
        const conferenceResponse = await telnyx('/conferences', {
          method: 'POST',
          body: JSON.stringify({ call_control_id: callControlId, name: state.room, beep_enabled: 'on_enter', max_participants: 6, comfort_noise: true, command_id: `${eventId}-conference` }),
        });
        const conferencePayload = await conferenceResponse.json() as { data?: { id?: string } };
        conferenceId = conferencePayload.data?.id;
      } catch (conferenceError) {
        logWebhookFailure('create conference', conferenceError);
      }
      if (!conferenceId) {
        await requireHangup([callControlId], `${eventId}-conference-create-failed`);
        return res.status(200).json({ received: true });
      }
      if (!state.callerId) throw new Error('The conference has no authorized caller identity.');
      const conferenceCallerId = state.callerId;
      if (state.room) {
        await saveConferenceCall({
          room: state.room,
          hostCallControlId: callControlId,
          conferenceId,
          guestCallControlIds: [],
          updatedAt: new Date().toISOString(),
        });
      }
      const participants = state.conferenceParticipants ?? (state.participants ?? []).map((destination) => ({ destination, displayName: destination, internal: false }));
      const guestResults = await Promise.allSettled(participants.map((participant, index) => dialCall({
        to: participant.destination,
        from: conferenceCallerId,
        state: { flow: 'conference_guest', room: state.room, conferenceId, callerId: conferenceCallerId, organizationId: state.organizationId },
        fromDisplayName: participant.internal && state.sourceName
          ? callerDisplay(`${state.sourceName}${state.sourceExtension ? ` - Ext ${state.sourceExtension}` : ''}`)
          : 'Vocivo Conference',
        customHeaders: participant.internal ? [
          { name: 'X-Vocivo-Call-Type', value: 'internal' },
          ...(state.sourceName ? [{ name: 'X-Vocivo-Caller-Name', value: state.sourceName }] : []),
          ...(state.sourceExtension ? [{ name: 'X-Vocivo-Caller-Extension', value: state.sourceExtension }] : []),
          ...(state.organizationId ? [{ name: 'X-Vocivo-Organization-ID', value: state.organizationId }] : []),
        ] : undefined,
        commandId: `${eventId}-guest-${index}`,
      })));
      const guestCallControlIds = guestResults.flatMap((result) => {
        if (result.status !== 'fulfilled') {
          logWebhookFailure('dial conference guest', result.reason);
          return [];
        }
        return dialCallLegs(result.value).map((leg) => leg.call_control_id).filter((id): id is string => Boolean(id));
      });
      if (state.room) {
        if (await isConferenceEnded(state.room)) {
          await Promise.all(guestCallControlIds.map((id) => requireHangup([id], `${eventId}-end-orphan-guest-${id.slice(-8)}`)));
        } else {
          await saveConferenceCall({
            room: state.room,
            hostCallControlId: callControlId,
            conferenceId,
            guestCallControlIds,
            updatedAt: new Date().toISOString(),
          });
          if (await isConferenceEnded(state.room)) {
            await Promise.all(guestCallControlIds.map((id) => requireHangup([id], `${eventId}-end-orphan-guest-${id.slice(-8)}`)));
          }
        }
      }
      return res.status(200).json({ received: true });
    }

    if (eventType === 'call.answered' && state?.flow === 'conference_guest' && state.conferenceId) {
      try {
        await telnyx(`/conferences/${encodeURIComponent(state.conferenceId)}/actions/join`, {
          method: 'POST',
          body: JSON.stringify({ call_control_id: callControlId, beep_enabled: 'on_enter', command_id: `${eventId}-join` }),
        });
      } catch (joinError) {
        logWebhookFailure('join conference guest', joinError);
        await requireHangup([callControlId], `${eventId}-end-failed-guest`);
      }
      return res.status(200).json({ received: true });
    }

    if (isInboundAnswered) {
      const organizationId = state?.organizationId || await organizationForNumber(payload?.to || '');
      if (!organizationId) {
        await quarantineSecurityEvent({
          source: 'telnyx-voice',
          reason: 'unresolved_inbound_answer_tenant',
          eventId,
          details: { callControlId, from: payload?.from || '', to: payload?.to || '' },
        });
        return res.status(200).json({ received: true, quarantined: true });
      }
      const routingKey = inboundAiRoutingKey(callControlId);
      const claimed = await claimReplayKey(routingKey, new Date(Date.now() + 4 * 60 * 60 * 1000));
      if (!claimed) return res.status(200).json({ received: true, ignored: 'duplicate_inbound_answer' });
      try {
      const inboundNumber = state?.inboundNumber || payload?.to || '';
      const callerNumber = state?.callerNumber || payload?.from;
      const callerName = state?.callerName || payload?.caller_id_name;
      const pbx = await readPbxConfig();
      const organizationPbx = pbxForOrganization(pbx, organizationId);
      const assignment = pbx.numberAssignments[normalizeE164(inboundNumber)];
      if (assignment?.organizationId === organizationId && assignment.destinationType === 'extension' && assignment.destinationId) {
        await routeToConfiguredTarget({ callControlId, eventId, organizationId, target: `extension:${assignment.destinationId}`, inboundNumber, callerNumber, callerName });
        return res.status(200).json({ received: true });
      }
      if (!officeHoursDecision(organizationPbx.officeHours).open) {
        await routeUnavailable(callControlId, organizationId, eventId, callerNumber, callerName);
        return res.status(200).json({ received: true });
      }
      if (assignment?.organizationId === organizationId && (assignment.destinationType === 'ring_group' || assignment.destinationType === 'queue') && assignment.destinationId) {
        await routeToCallGroup({ callControlId, eventId, organizationId, handlingId: assignment.destinationId, kind: assignment.destinationType, inboundNumber, callerNumber, callerName });
        return res.status(200).json({ received: true });
      }
      if (assignment?.organizationId === organizationId && assignment.destinationType === 'ivr' && assignment.destinationId) {
        await routeToConfiguredIvr({ callControlId, eventId, organizationId, handlingId: assignment.destinationId, inboundNumber, callerNumber, callerName });
        return res.status(200).json({ received: true });
      }
      if (organizationPbx.ai.enabled && organizationPbx.ai.assistantId) {
        try {
          const extensions = await listExtensions(organizationId);
          const targets = activeAiTransferTargets(pbx, organizationId, extensions);
          const transferToken = createAiTransferToken({
            callControlId,
            organizationId,
            inboundNumber,
            callerNumber,
            callerName,
            assistantId: organizationPbx.ai.assistantId,
          });
          const transferUrl = `${requiredEnv('VITE_APP_URL').replace(/\/+$/, '')}/api/voice/ai-transfer?token=${encodeURIComponent(transferToken)}`;
          await callAction(callControlId, 'ai_assistant_start', {
            assistant: {
              id: organizationPbx.ai.assistantId,
              instructions: aiAssistantInstructions(organizationPbx.ai, targets),
              tools: aiAssistantTools(organizationPbx.ai.transferEnabled, targets, transferUrl),
            },
            command_id: inboundAiCommandId(callControlId),
          });
          return res.status(200).json({ received: true });
        } catch (aiError) {
          console.error('Vocivo AI receptionist could not start; using configured voice fallback', publicError(aiError));
        }
      }
      const config = await readBusinessVoiceConfig(organizationId);
      if (!config.enabled) {
        await routeToAvailableAgent({ callControlId, department: config.companyName, eventId, organizationId, inboundNumber, callerNumber, callerName, preferMain: true });
      } else {
        const hasExtensions = (await listExtensions(organizationId)).length > 0;
        const options = config.departments.map((department, index) => `For ${department}, press ${index + 1}.`).join(' ');
        const validDigits = `${config.departments.map((_, index) => String(index + 1)).join('')}${hasExtensions ? '9' : ''}`;
        const prompt = `${config.greeting} ${options}${hasExtensions ? ' If you know your party extension, press 9.' : ''}`;
        await gatherPrompt(callControlId, {
          payload: prompt,
          invalid_payload: `That selection was not recognized. Please press one of these options: ${validDigits.split('').join(', ')}.`,
          voice: config.voice,
          minimum_digits: 1,
          maximum_digits: 1,
          valid_digits: validDigits,
          maximum_tries: 2,
          timeout_millis: 10000,
          client_state: encodeVoiceState({ flow: 'ivr', callerNumber, callerName, organizationId, inboundNumber }),
          command_id: `${eventId}-ivr`,
        });
      }
      } catch (routingError) {
        await releaseReplayKey(routingKey).catch((releaseError) => logWebhookFailure('release failed inbound routing claim', releaseError));
        throw routingError;
      }
    }

    if (eventType === 'call.gather.ended' && state?.flow === 'ivr' && state.organizationId) {
      const gatherKey = `gather-ended:${eventId}`;
      if (!await claimReplayKey(gatherKey, new Date(Date.now() + 4 * 60 * 60 * 1000))) {
        return res.status(200).json({ received: true, ignored: 'duplicate_gather' });
      }
      try {
      const config = await readBusinessVoiceConfig(state.organizationId);
      const hasExtensions = (await listExtensions(state.organizationId)).length > 0;
      const rawDigit = String(payload?.digits || payload?.result || '').trim();
      if (rawDigit === '9' && hasExtensions) {
        await gatherPrompt(callControlId, {
          payload: 'Please enter the extension number now.',
          invalid_payload: 'That extension was not recognized.',
          voice: config.voice,
          minimum_digits: 2,
          maximum_digits: 5,
          timeout_millis: 8000,
          client_state: encodeVoiceState({ flow: 'extension', callerNumber: state.callerNumber, callerName: state.callerName, organizationId: state.organizationId, inboundNumber: state.inboundNumber }),
          command_id: `${eventId}-extension`,
        });
        return res.status(200).json({ received: true });
      }
      const digit = ivrMenuSelection(payload || {}, config.departments.length);
      if (digit == null) {
        await routeUnavailable(callControlId, state.organizationId, eventId, state.callerNumber, state.callerName);
        return res.status(200).json({ received: true });
      }
      const department = config.departments[digit - 1];
      if (!department) {
        await routeUnavailable(callControlId, state.organizationId, eventId, state.callerNumber, state.callerName);
        return res.status(200).json({ received: true });
      }
      await routeToAvailableAgent({ callControlId, department, eventId, organizationId: state.organizationId, inboundNumber: state.inboundNumber || '', callerNumber: state.callerNumber, callerName: state.callerName });
      } catch (gatherError) {
        await releaseReplayKey(gatherKey).catch((releaseError) => logWebhookFailure('release failed gather claim', releaseError));
        throw gatherError;
      }
      return res.status(200).json({ received: true });
    }

    if (eventType === 'call.gather.ended' && state?.flow === 'extension' && state.organizationId) {
      const gatherKey = `gather-ended:${eventId}`;
      if (!await claimReplayKey(gatherKey, new Date(Date.now() + 4 * 60 * 60 * 1000))) {
        return res.status(200).json({ received: true, ignored: 'duplicate_gather' });
      }
      try {
      const config = await readBusinessVoiceConfig(state.organizationId);
      const extensionNumber = String(payload?.digits || payload?.result || '').replace(/\D/g, '');
      const extension = await findExtension(extensionNumber, state.organizationId);
      if (extension) {
        await routeToExtension({ callControlId, eventId, organizationId: state.organizationId, inboundNumber: state.inboundNumber || '', extension, callerNumber: state.callerNumber, callerName: state.callerName });
      } else {
        await speakPrompt(callControlId, { payload: 'That extension is not available. We will connect you to the main line.', voice: config.voice, command_id: `${eventId}-extension-missing` });
        await routeToAvailableAgent({ callControlId, department: config.companyName, eventId, organizationId: state.organizationId, inboundNumber: state.inboundNumber || '', callerNumber: state.callerNumber, callerName: state.callerName });
      }
      } catch (gatherError) {
        await releaseReplayKey(gatherKey).catch((releaseError) => logWebhookFailure('release failed gather claim', releaseError));
        throw gatherError;
      }
      return res.status(200).json({ received: true });
    }

    if (eventType === 'call.gather.ended' && state?.flow === 'configured_ivr' && state.handlingId && state.organizationId) {
      const gatherKey = `gather-ended:${eventId}`;
      if (!await claimReplayKey(gatherKey, new Date(Date.now() + 4 * 60 * 60 * 1000))) {
        return res.status(200).json({ received: true, ignored: 'duplicate_gather' });
      }
      try {
      const pbx = pbxForOrganization(await readPbxConfig(), state.organizationId);
      const ivr = pbx.callHandling.ivrs.find((item) => item.id === state.handlingId);
      const digit = String(payload?.digits || payload?.result || '').replace(/\D/g, '').slice(0, 1);
      const target = ivr?.options[digit];
      if (target) {
        await routeToConfiguredTarget({ callControlId, eventId, organizationId: state.organizationId, target, inboundNumber: state.inboundNumber, callerNumber: state.callerNumber, callerName: state.callerName });
      } else {
        await routeUnavailable(callControlId, state.organizationId, eventId, state.callerNumber, state.callerName);
      }
      } catch (gatherError) {
        await releaseReplayKey(gatherKey).catch((releaseError) => logWebhookFailure('release failed gather claim', releaseError));
        throw gatherError;
      }
      return res.status(200).json({ received: true });
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    if (error instanceof TelnyxApiError && error.code === '90018') {
      return res.status(200).json({ received: true, ignored: 'call_ended' });
    }
    console.error('Vocivo voice webhook failed', error);
    return res.status(500).json({ error: publicError(error) });
  }
  };
}

export default createVoiceWebhookHandler();
