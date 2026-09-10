import { authorizeOutboundCall } from '../billing/outbound-policy.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BusinessVoiceConfig } from '../numbers/number-config.js';
import { officeHoursDecision, userAvailableBySchedule } from '../organizations/office-hours.js';
import type { ExtensionUser } from '../organizations/pbx.js';
import type { PbxConfig } from '../organizations/pbx-config-store.js';
import { normalizeE164 } from '../organizations/tenancy.js';
import { forwardingTargetForCause, userNoAnswerSeconds, userVoicemailEnabled } from '../organizations/user-call-routing.js';

/**
 * Renders the FreeSWITCH dialplan for inbound DIDs on the self-hosted SIP edge.
 *
 * FreeSWITCH asks the Vocivo API for a dialplan through mod_xml_curl at every
 * routing step, so the decision tree below mirrors the Telnyx Call Control
 * flow in routes/voice-webhook.ts while the API stays the single control plane:
 * every stage is stateless, carried between steps as `vocivo_*` channel
 * variables, and FreeSWITCH is only the executor.
 */

export type XmlCurlRequest = {
  section: string;
  context: string;
  destinationNumber: string;
  callerNumber: string;
  callerName: string;
  uuid: string;
  networkAddr: string;
  switchAddr: string;
  vocivoCallerIdHeader: string;
  /** `X-Vocivo-Flow`, which Kamailio sets to `inbound` on a call the carrier delivered. */
  vocivoFlowHeader: string;
  routeToken?: string;
  carrierSourceIp?: string;
  stage: string;
  organizationId: string;
  did: string;
  arg: string;
  digit: string;
  disposition: string;
  depth: number;
  visited: string[];
  attempt: number;
  waitingAnnounced: boolean;
  callerFrom: string;
  fromReceptionist: boolean;
  callerDisplay: string;
};

type Field = Record<string, unknown>;

function field(body: Field, ...names: string[]) {
  for (const name of names) {
    const value = body[name];
    if (typeof value === 'string' && value.length) return value;
  }
  return '';
}

export function parseXmlCurlRequest(body: unknown): XmlCurlRequest {
  const source: Field = body && typeof body === 'object' ? body as Field : {};
  const depth = Number.parseInt(field(source, 'variable_vocivo_depth'), 10);
  const attempt = Number.parseInt(field(source, 'variable_vocivo_attempt'), 10);
  return {
    section: field(source, 'section').toLowerCase(),
    context: field(source, 'Caller-Context', 'Hunt-Context', 'context').toLowerCase(),
    destinationNumber: field(source, 'Caller-Destination-Number', 'Hunt-Destination-Number', 'destination_number'),
    callerNumber: field(source, 'Caller-Caller-ID-Number', 'Hunt-Caller-ID-Number'),
    callerName: field(source, 'Caller-Caller-ID-Name', 'Hunt-Caller-ID-Name'),
    uuid: field(source, 'Caller-Unique-ID', 'Hunt-Unique-ID', 'Unique-ID'),
    networkAddr: field(source, 'Caller-Network-Addr', 'Hunt-Network-Addr'),
    switchAddr: field(source, 'FreeSWITCH-IPv4'),
    vocivoCallerIdHeader: field(source, 'variable_sip_h_X-Vocivo-Caller-ID'),
    vocivoFlowHeader: field(source, 'variable_sip_h_X-Vocivo-Flow').toLowerCase(),
    routeToken: field(source, 'variable_sip_h_X-Vocivo-Route-Token'),
    carrierSourceIp: field(source, 'variable_sip_h_X-Vocivo-Carrier-Source'),
    stage: field(source, 'variable_vocivo_stage').toLowerCase(),
    organizationId: field(source, 'variable_vocivo_org'),
    did: field(source, 'variable_vocivo_did'),
    arg: field(source, 'variable_vocivo_arg'),
    digit: field(source, 'variable_vocivo_digit').replace(/\D/g, '').slice(0, 5),
    disposition: field(source, 'variable_originate_disposition').toUpperCase(),
    depth: Number.isFinite(depth) ? Math.max(0, depth) : 0,
    visited: field(source, 'variable_vocivo_visited').split(/[:,]/).map((item) => item.trim()).filter(Boolean).slice(-5),
    attempt: Number.isFinite(attempt) ? Math.max(0, attempt) : 0,
    waitingAnnounced: field(source, 'variable_vocivo_waiting') === '1',
    callerFrom: field(source, 'variable_vocivo_from'),
    // Set by the receptionist before it transfers, so a person who does not
    // answer hands the caller back to it rather than to a recording.
    fromReceptionist: field(source, 'variable_vocivo_from_receptionist') === '1',
    callerDisplay: field(source, 'variable_vocivo_name'),
  };
}

/**
 * Calls hairpinned from our own Kamailio (outbound origination, conferences,
 * internal calls) never get an inbound plan.
 *
 * Every call reaches FreeSWITCH from Kamailio on loopback — the carrier's too,
 * because the edge only accepts a DID on public 5060 and forwards it inside —
 * so the address alone cannot tell them apart. Kamailio tags what it accepted
 * from the carrier with `X-Vocivo-Flow: inbound`, and that tag decides.
 */
export function isLocalOrigination(request: XmlCurlRequest) {
  if (request.vocivoFlowHeader === 'inbound') return false;
  if (request.vocivoFlowHeader || request.vocivoCallerIdHeader) return true;
  const addr = request.networkAddr;
  return Boolean(addr) && (addr === '127.0.0.1' || addr === '::1' || (Boolean(request.switchAddr) && addr === request.switchAddr));
}

export type SipDialplanInput = {
  request: XmlCurlRequest;
  organizationId: string;
  did: string;
  /** Organization-scoped config (pbxForOrganization). */
  pbx: PbxConfig;
  business: BusinessVoiceConfig;
  extensions: ExtensionUser[];
  apiUrl: string;
  secret: string;
  promptFormat: 'wav' | 'mp3';
  recordingsDir: string;
  trunkGateway: string;
  carrierCapacity?: { gateway: string; limit: number };
  /**
   * host:port of Vocivo's own receptionist, which FreeSWITCH reaches over the
   * Event Socket. Loopback on the SIP edge, because the receptionist runs on
   * the same droplet and nothing outside it should be able to answer calls.
   */
  receptionist?: string;
  now: Date;
};

const e164 = /^\+[1-9]\d{6,14}$/;
const kamailioLoopback = '127.0.0.1:5060';
const defaultReceptionist = '127.0.0.1:8084';
const queueAttemptSeconds = 45;
const maxForwardingDepth = 2;
const voicemailMaxSeconds = 120;

/**
 * One argument of a command the media host will run through /bin/sh.
 *
 * Single quotes make everything inside literal to the shell, and a single
 * quote is the one character that could end them — so it is removed rather
 * than escaped. Neither of the two values this is used for can contain one
 * (the upload URL is percent-encoded, the recording path is configuration),
 * which makes this a guard against a future caller rather than a repair.
 */
export function shellArgument(value: string) {
  return `'${value.replace(/'/g, '').replace(/[\r\n]/g, '')}'`;
}

export function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Values placed into `set` must never carry FreeSWITCH expansion syntax or delimiters. */
export function channelSafe(value: string, max = 120) {
  return value.replace(/[^A-Za-z0-9 +._@:/'-]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function signature(secret: string, ...parts: string[]) {
  return createHmac('sha256', `${secret}:sip-dialplan`).update(parts.join('\n')).digest('base64url');
}

function signaturesMatch(expected: string, supplied: string) {
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/**
 * A prompt as both ends will see it.
 *
 * The URL carried the text as written and signed the same, and the endpoint
 * verified the signature against a trimmed copy — so a greeting saved with a
 * trailing space, or an empty one (which leaves the menu sentence starting
 * with a space), produced a URL whose signature could never match. The caller
 * heard nothing at all, because a 403 is not audio. Both ends normalise the
 * same way now, which is also how the receptionist splits a sentence, so the
 * pre-rendered copy is the one the call plays.
 */
export function normalizedPromptText(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

export function promptSignature(secret: string, text: string, voice: string, format: string) {
  return signature(secret, 'prompt', format, voice, normalizedPromptText(text));
}

export function promptUrl(input: Pick<SipDialplanInput, 'apiUrl' | 'secret' | 'promptFormat'>, rawText: string, voice: string) {
  const text = normalizedPromptText(rawText);
  const sig = promptSignature(input.secret, text, voice, input.promptFormat);
  // mod_http_cache names its cached copy after the last dot in the whole URL,
  // query string included, and then opens the file by that "extension". A
  // period in the prompt text or in a voice id such as Vocivo.Kokoro.AmAdam
  // gave it an extension no file module handles, and every prompt failed to
  // open. Percent-encoding the dots keeps the extension at the path's .wav.
  const query = new URLSearchParams({ text, voice, sig }).toString().replace(/\./g, '%2E');
  return `${input.apiUrl.replace(/\/+$/, '')}/api/voice/sip-prompt/${sig.slice(0, 24)}.${input.promptFormat}?${query}`;
}

export function verifyPromptSignature(secret: string, text: string, voice: string, format: string, supplied: string) {
  return signaturesMatch(promptSignature(secret, text, voice, format), supplied);
}

export function voicemailUploadSignature(secret: string, organizationId: string, uuid: string, callerNumber: string, callerName: string, expires: string) {
  return signature(secret, 'voicemail', organizationId, uuid, callerNumber, callerName, expires);
}

export function voicemailUploadUrl(input: Pick<SipDialplanInput, 'apiUrl' | 'secret' | 'now'>, organizationId: string, uuid: string, callerNumber: string, callerName: string) {
  const expires = String(Math.floor(input.now.getTime() / 1000) + 60 * 60);
  const sig = voicemailUploadSignature(input.secret, organizationId, uuid, callerNumber, callerName, expires);
  const query = new URLSearchParams({ org: organizationId, call: uuid, from: callerNumber, name: callerName, exp: expires, sig });
  return `${input.apiUrl.replace(/\/+$/, '')}/api/voice/sip-voicemail?${query.toString()}`;
}

export function verifyVoicemailUpload(secret: string, params: { org: string; call: string; from: string; name: string; exp: string; sig: string }, now = new Date()) {
  const expires = Number(params.exp);
  if (!Number.isFinite(expires) || expires * 1000 < now.getTime()) return false;
  return signaturesMatch(voicemailUploadSignature(secret, params.org, params.call, params.from, params.name, params.exp), params.sig);
}

export function xmlCurlNotFound() {
  return '<document type="freeswitch/xml"><section name="result"><result status="not found"/></section></document>';
}

/* ------------------------------------------------------------------ */
/* Action builders                                                      */
/* ------------------------------------------------------------------ */

type Action = string;

function action(application: string, data?: string): Action {
  return data === undefined
    ? `<action application="${application}"/>`
    : `<action application="${application}" data="${escapeXml(data)}"/>`;
}

function set(name: string, value: string): Action {
  return action('set', `${name}=${value}`);
}

function stageVars(next: string, vars: Record<string, string | number | undefined>) {
  const actions = [set('vocivo_stage', next)];
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) continue;
    actions.push(set(`vocivo_${name}`, channelSafe(String(value), 160)));
  }
  return actions;
}

function transferToStage(next: string, vars: Record<string, string | number | undefined> = {}) {
  return [...stageVars(next, vars), action('transfer', '${vocivo_did} XML public')];
}

function playback(input: SipDialplanInput, text: string) {
  return action('playback', `http_cache://${promptUrl(input, text, input.business.voice)}`);
}

function dialplanDocument(stage: string, actions: Action[]) {
  return [
    '<document type="freeswitch/xml">',
    '  <section name="dialplan" description="Vocivo inbound">',
    '    <context name="public">',
    `      <extension name="vocivo-inbound-${escapeXml(stage)}">`,
    '        <condition field="destination_number" expression=".*">',
    ...actions.map((item) => `          ${item}`),
    '        </condition>',
    '      </extension>',
    '    </context>',
    '  </section>',
    '</document>',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Routing helpers                                                      */
/* ------------------------------------------------------------------ */

function activeExtensions(input: SipDialplanInput) {
  return input.extensions.filter((item) => item.organizationId === input.organizationId && item.status === 'active' && item.sipUsername);
}

function contact(extension: ExtensionUser) {
  return `sofia/external/${extension.sipUsername}@${kamailioLoopback}`;
}

function trunkLeg(input: SipDialplanInput, destination: string, extension: ExtensionUser | undefined) {
  if (!extension || extension.organizationId !== input.organizationId || extension.status !== 'active'
    || !e164.test(destination) || !e164.test(input.did) || input.trunkGateway === 'byoc_unavailable') return '';
  try {
    authorizeOutboundCall(input.pbx, {
      extension: extension.extension,
      department: extension.department,
      internationalAllowed: input.pbx.userProfiles[extension.id]?.permissions?.international !== false,
    }, destination, input.did);
  } catch {
    // A denied forwarding leg follows the existing voicemail/receptionist
    // fallback; it cannot bypass policy or prevent the local extension ringing.
    return '';
  }
  const callerId = e164.test(input.did) ? input.did : '';
  const variables = callerId
    ? `{origination_caller_id_number=${callerId},origination_caller_id_name=Vocivo,sip_cid_type=pid${input.trunkGateway === 'telnyx' ? `,nolocal:sip_h_P-Asserted-Identity=<sip:${callerId}@sip.telnyx.com>` : ''}}`
    : '';
  return `${variables}sofia/gateway/${input.trunkGateway}/${destination}`;
}

function callerVars(input: SipDialplanInput) {
  const number = channelSafe(input.request.callerFrom || input.request.callerNumber, 32);
  const name = channelSafe(input.request.callerDisplay || input.request.callerName, 80);
  return { number, name };
}

/**
 * What a caller hears while a person is being found: soft music, the way a
 * front desk puts you on hold, rather than a ringing tone. The file ships with
 * the edge (services/sip/freeswitch/sounds) and FreeSWITCH loops it for as
 * long as the wait lasts.
 */
export const holdMusic = '/opt/vocivo-fs/sounds/hold-music.wav';

function bridgeActions(input: SipDialplanInput, legs: string[], timeoutSeconds: number, options: { announceWaiting: boolean; ringback?: boolean }) {
  const actions: Action[] = [];
  if (options.announceWaiting && !input.request.waitingAnnounced) {
    actions.push(playback(input, input.business.waitingMessage), set('vocivo_waiting', '1'));
  }
  actions.push(
    set('hangup_after_bridge', 'true'),
    set('continue_on_fail', 'true'),
    set('ignore_early_media', 'true'),
    set('call_timeout', String(Math.min(900, Math.max(1, Math.round(timeoutSeconds))))),
    set('hold_music', holdMusic),
    set('ringback', holdMusic),
    set('transfer_ringback', holdMusic),
    action('bridge', legs.join(':_:')),
  );
  return actions;
}

/**
 * The receptionist put the caller through and nobody picked up. Rather than
 * "no one is available, please try again later" and a hangup, the call goes
 * back to the receptionist, which says so and offers to take a message —
 * the caller already has its attention and should not lose it to a recording.
 */
function backToReceptionistActions(input: SipDialplanInput): Action[] {
  const address = input.receptionist || defaultReceptionist;
  return [
    set('vocivo_transfer_failed', '1'),
    set('vocivo_stage', 'entry'),
    action('socket', `${address} async full`),
    ...unavailableActions(input, true, { fromReceptionist: false }),
  ];
}

function unavailableActions(input: SipDialplanInput, voicemailEnabled: boolean, options: { fromReceptionist?: boolean } = {}) {
  const business = input.business;
  const fromReceptionist = options.fromReceptionist ?? (input.request.fromReceptionist && Boolean(input.pbx.ai?.enabled));
  if (fromReceptionist) return backToReceptionistActions(input);
  const useVoicemail = business.voicemailEnabled && voicemailEnabled;
  if (!useVoicemail) {
    return [
      playback(input, fixedPrompts.nobodyAvailable),
      action('hangup', 'NORMAL_CLEARING'),
    ];
  }
  const caller = callerVars(input);
  const recording = `${input.recordingsDir.replace(/\/+$/, '')}/\${uuid}.wav`;
  // The upload URL is signed over the call id, so it must be the concrete value
  // xml_curl posted (FreeSWITCH cannot expand ${uuid} inside a percent-encoded URL).
  const callId = channelSafe(input.request.uuid, 64) || 'unknown-call';
  const upload = voicemailUploadUrl(input, input.organizationId, callId, caller.number, caller.name);
  return [
    playback(input, business.voicemailGreeting),
    set('record_sample_rate', '8000'),
    set('RECORD_STEREO', 'false'),
    set('playback_terminators', 'none'),
    // A caller who has finished speaking hangs up, and a hung-up channel runs
    // no more dialplan: an upload written as the next action after `record`
    // never ran, and every message left on this edge was recorded to a
    // container's disk and lost with it. A hangup hook is the one thing that
    // does run, and it runs on the other ending too — the recorder stopping by
    // itself is followed by the `hangup` below.
    set('session_in_hangup_hook', 'true'),
    set('api_hangup_hook', `system /bin/sh /opt/vocivo-fs/voicemail-hangup.sh ${shellArgument(upload)} ${shellArgument(recording)}`),
    action('playback', 'tone_stream://%(500,0,800)'),
    action('record', `${recording} ${voicemailMaxSeconds} 30 5`),
    action('hangup', 'NORMAL_CLEARING'),
  ];
}

function ringExtensionActions(input: SipDialplanInput, extension: ExtensionUser, options: { announceWaiting: boolean; depth: number; visited: string[] }) {
  const pbx = input.pbx;
  const profile = pbx.userProfiles[extension.id];
  const voicemailEnabled = userVoicemailEnabled(profile, input.business.voicemailEnabled);
  if (!userAvailableBySchedule(profile, pbx.officeHours, input.now)) {
    return unavailableActions(input, voicemailEnabled);
  }
  const legs = [contact(extension)];
  const simultaneous = profile?.simultaneousRing?.trim() || '';
  const simultaneousExtension = activeExtensions(input).find((item) => item.extension === simultaneous && item.id !== extension.id);
  if (simultaneousExtension) {
    legs.push(contact(simultaneousExtension));
  } else if (simultaneous) {
    const simultaneousNumber = normalizeE164(simultaneous);
    const leg = trunkLeg(input, simultaneousNumber, extension);
    if (leg) legs.push(leg);
  }
  return [
    ...bridgeActions(input, legs, userNoAnswerSeconds(profile, input.business.voicemailDelaySeconds), { announceWaiting: options.announceWaiting }),
    ...transferToStage('after-ring', {
      arg: extension.id,
      depth: options.depth,
      // ':' survives channelSafe and cannot appear in an extension id (see validateCallHandling).
      visited: [...new Set([...options.visited, extension.id])].slice(-5).join(':'),
    }),
  ];
}

function mainLineActions(input: SipDialplanInput) {
  const targets = activeExtensions(input);
  const organization = input.pbx.organizations.find((item) => item.id === input.organizationId && item.status === 'active');
  if (!targets.length || !organization || organization.accountType !== 'business') {
    return unavailableActions(input, true);
  }
  return [
    ...bridgeActions(input, targets.map(contact), input.business.voicemailDelaySeconds, { announceWaiting: false }),
    ...transferToStage('unavailable', { arg: 'business' }),
  ];
}

function departmentDestination(input: SipDialplanInput, department: string) {
  const extensions = activeExtensions(input);
  const departmental = extensions.find((item) => item.department.toLowerCase() === department.toLowerCase());
  return departmental || extensions[0] || null;
}

type GroupKind = 'ring_group' | 'queue';

function groupFor(input: SipDialplanInput, kind: GroupKind, id: string) {
  const collection = kind === 'ring_group' ? input.pbx.callHandling.ringGroups : input.pbx.callHandling.queues;
  return collection.find((item) => item.id === id) || null;
}

function groupFallbackActions(input: SipDialplanInput, kind: GroupKind, id: string) {
  const group = groupFor(input, kind, id);
  if (group?.fallback === 'Main line') return mainLineActions(input);
  return unavailableActions(input, true);
}

function groupActions(input: SipDialplanInput, kind: GroupKind, id: string, attempt: number) {
  const group = groupFor(input, kind, id);
  const members = group ? activeExtensions(input).filter((item) => group.members.includes(item.id)) : [];
  if (!group || !members.length) return groupFallbackActions(input, kind, id);
  if (kind === 'ring_group') {
    const timeout = Math.min(120, Math.max(10, 'timeout' in group ? group.timeout || 25 : 25));
    return [
      ...bridgeActions(input, members.map(contact), timeout, { announceWaiting: false }),
      ...transferToStage('after-group', { arg: `${kind}:${id}` }),
    ];
  }
  const maxWait = Math.min(900, Math.max(15, 'maxWait' in group ? group.maxWait || 180 : 180));
  const attempts = Math.max(1, Math.ceil(maxWait / queueAttemptSeconds));
  const remaining = maxWait - attempt * queueAttemptSeconds;
  if (remaining <= 0) return transferToStage('after-group', { arg: `${kind}:${id}` });
  const nextAttempt = attempt + 1;
  const actions: Action[] = [];
  if (attempt === 0) actions.push(playback(input, input.business.waitingMessage), set('vocivo_waiting', '1'));
  actions.push(...bridgeActions(input, members.map(contact), Math.min(queueAttemptSeconds, remaining), { announceWaiting: false }));
  if (nextAttempt < attempts) {
    actions.push(playback(input, input.business.waitingMessage), ...transferToStage('queue', { arg: `${kind}:${id}`, attempt: nextAttempt }));
  } else {
    actions.push(...transferToStage('after-group', { arg: `${kind}:${id}` }));
  }
  return actions;
}

const fixedPrompts = {
  nobodyAvailable: 'No one is available to take your call right now. Please try again later.',
  extensionPrompt: 'Please enter the extension number now.',
  extensionInvalid: 'That extension was not recognized.',
  extensionUnavailable: 'That extension is not available. We will connect you to the main line.',
};

function menuPrompt(input: SipDialplanInput) {
  const business = input.business;
  const hasExtensions = activeExtensions(input).length > 0;
  const options = business.departments.map((department, index) => `For ${department}, press ${index + 1}.`).join(' ');
  const validDigits = `${business.departments.map((_, index) => String(index + 1)).join('')}${hasExtensions ? '9' : ''}`;
  return {
    prompt: `${business.greeting} ${options}${hasExtensions ? ' If you know your party extension, press 9. Or stay on the line and we will connect you.' : ''}`,
    invalid: `That selection was not recognized. Please press one of these options: ${validDigits.split('').join(', ')}.`,
    validDigits,
    hasExtensions,
  };
}

function configuredIvrPrompt(input: SipDialplanInput, ivr: PbxConfig['callHandling']['ivrs'][number]) {
  const entries = Object.entries(ivr.options || {}).filter(([digit, target]) => /^\d$/.test(digit) && Boolean(target)).slice(0, 10);
  const label = (target: string) => {
    const [type, id] = target.includes(':') ? target.split(':', 2) : ['extension', target];
    if (type === 'extension') return input.extensions.find((item) => item.id === id)?.name || 'an extension';
    const collection = type === 'ring_group' ? input.pbx.callHandling.ringGroups : type === 'queue' ? input.pbx.callHandling.queues : [];
    return collection.find((item) => item.id === id)?.name || 'a team';
  };
  const digits = entries.map(([digit]) => digit).join('');
  return {
    entries,
    digits,
    prompt: `${ivr.greeting} ${entries.map(([digit, target]) => `For ${label(target)}, press ${digit}.`).join(' ')}`,
    invalid: `That selection was not recognized. Please press one of these options: ${digits.split('').join(', ')}.`,
  };
}

/**
 * Every sentence this dialplan can play for a tenant, in the tenant's voice.
 *
 * The API hands this list to the voice engine when a tenant saves a greeting,
 * menu or voice, so each prompt is rendered before the first caller asks for
 * it: a cold render took eight to twenty seconds on the edge, longer than the
 * carrier's timeout and longer than most callers wait in silence.
 */
export function dialplanPromptTexts(input: Pick<SipDialplanInput, 'pbx' | 'business' | 'extensions' | 'organizationId'>): { texts: string[]; voice: string } {
  const full = input as SipDialplanInput;
  const texts = new Set<string>();
  const add = (text: string) => { const normalized = normalizedPromptText(text); if (normalized) texts.add(normalized); };
  const menu = menuPrompt(full);
  add(menu.prompt);
  add(menu.invalid);
  add(input.business.waitingMessage);
  add(input.business.voicemailGreeting);
  for (const text of Object.values(fixedPrompts)) add(text);
  for (const ivr of input.pbx.callHandling.ivrs) {
    const configured = configuredIvrPrompt(full, ivr);
    if (!configured.entries.length) continue;
    add(configured.prompt);
    add(configured.invalid);
  }
  return { texts: [...texts], voice: input.business.voice };
}

function gatherActions(input: SipDialplanInput, options: { prompt: string; invalid: string; minDigits: number; maxDigits: number; regex: string; timeoutMs: number; next: string; vars?: Record<string, string> }) {
  const promptFile = `http_cache://${promptUrl(input, options.prompt, input.business.voice)}`;
  const invalidFile = `http_cache://${promptUrl(input, options.invalid, input.business.voice)}`;
  return [
    set('vocivo_digit', ''),
    action('play_and_get_digits', `${options.minDigits} ${options.maxDigits} 2 ${options.timeoutMs} # ${promptFile} ${invalidFile} vocivo_digit ${options.regex} 3000`),
    ...transferToStage(options.next, options.vars || {}),
  ];
}

function configuredTargetActions(input: SipDialplanInput, target: string, depth: number, visited: string[]) {
  const [type, id] = target.includes(':') ? target.split(':', 2) : ['extension', target];
  if (type === 'ring_group' || type === 'queue') return groupActions(input, type, id, 0);
  const extension = type === 'extension' ? activeExtensions(input).find((item) => item.id === id) : undefined;
  if (extension) return ringExtensionActions(input, extension, { announceWaiting: false, depth, visited });
  return unavailableActions(input, true);
}

function configuredIvrActions(input: SipDialplanInput, ivrId: string) {
  const ivr = input.pbx.callHandling.ivrs.find((item) => item.id === ivrId);
  if (!ivr) return unavailableActions(input, true);
  const configured = configuredIvrPrompt(input, ivr);
  if (!configured.entries.length) return unavailableActions(input, true);
  return gatherActions(input, {
    prompt: configured.prompt,
    invalid: configured.invalid,
    minDigits: 1,
    maxDigits: 1,
    regex: `^[${configured.digits}]$`,
    timeoutMs: 10000,
    next: 'cfg-ivr-select',
    vars: { arg: ivr.id },
  });
}

/**
 * A caller who pressed nothing is connected rather than sent away.
 *
 * `play_and_get_digits` gives up after two tries, and it gives up at once
 * when a prompt could not be played at all. Either way the caller is still
 * there and has heard the company name — so ring the staff, and only when
 * nobody can be rung fall back to voicemail or the closing message.
 */
function noInputActions(input: SipDialplanInput) {
  if (activeExtensions(input).length) return mainLineActions(input);
  return unavailableActions(input, true);
}

function fsCauseToVocivo(disposition: string) {
  switch (disposition) {
    case 'USER_BUSY': return 'user_busy';
    case 'NO_ANSWER':
    case 'NO_USER_RESPONSE':
    case 'ALLOTTED_TIMEOUT': return 'timeout';
    case 'CALL_REJECTED': return 'call_rejected';
    default: return disposition.toLowerCase() || 'unavailable';
  }
}

/* ------------------------------------------------------------------ */
/* Stages                                                               */
/* ------------------------------------------------------------------ */

function entryActions(input: SipDialplanInput) {
  const pbx = input.pbx;
  const assignment = pbx.numberAssignments[input.did];
  if (!assignment || assignment.disabled || assignment.organizationId !== input.organizationId
    || assignment.source === 'carrier' && !assignment.destinationType) return [action('respond', '480 Number unavailable'), action('hangup', 'NO_ROUTE_DESTINATION')];
  const caller = callerVars(input);
  const prelude = [
    ...(input.carrierCapacity ? [action('limit', `hash vocivo-carrier ${input.carrierCapacity.gateway} ${input.carrierCapacity.limit} !NORMAL_CIRCUIT_CONGESTION`)] : []),
    action('answer'),
    // The carrier's media takes a moment to arrive after the answer; a prompt
    // that starts before it does loses its first word or two.
    action('sleep', '400'),
    set('vocivo_org', channelSafe(input.organizationId, 80)),
    set('vocivo_did', channelSafe(input.did, 24)),
    set('vocivo_from', caller.number),
    set('vocivo_name', caller.name),
    set('vocivo_depth', '0'),
    set('vocivo_visited', ''),
  ];
  const owned = assignment?.organizationId === input.organizationId;
  if (owned && assignment?.destinationType === 'extension' && assignment.destinationId) {
    return [...prelude, ...configuredTargetActions(input, `extension:${assignment.destinationId}`, 0, [])];
  }
  // The receptionist answers at any hour: after closing it tells callers so
  // and takes a message, which is the point of having one. It used to sit
  // behind the office-hours check, so a call at ten past five got the
  // closed message and a hangup — "rings once and disconnects".
  if (input.pbx.ai?.enabled && !(owned && assignment?.destinationId && ['ring_group', 'queue', 'ivr'].includes(assignment.destinationType || ''))) {
    return [...prelude, ...receptionistActions(input)];
  }
  if (!officeHoursDecision(pbx.officeHours, input.now).open) {
    return [...prelude, ...unavailableActions(input, true)];
  }
  if (owned && (assignment?.destinationType === 'ring_group' || assignment?.destinationType === 'queue') && assignment.destinationId) {
    return [...prelude, ...groupActions(input, assignment.destinationType, assignment.destinationId, 0)];
  }
  if (owned && assignment?.destinationType === 'ivr' && assignment.destinationId) {
    return [...prelude, ...configuredIvrActions(input, assignment.destinationId)];
  }
  if (!input.business.enabled) return [...prelude, ...mainLineActions(input)];
  return [...prelude, ...menuFallbackActions(input)];
}

/**
 * Hands the call to Vocivo's own receptionist.
 *
 * `socket ... async full` connects FreeSWITCH to the receptionist service over
 * the Event Socket; that service answers, listens, thinks and speaks using
 * Vocivo's own speech recognition and voice, and transfers back into this same
 * dialplan when the caller asks for a person.
 *
 * The actions after it run only when the receptionist could not be reached, so
 * an unreachable service degrades to the voice menu rather than to silence.
 */
function receptionistActions(input: SipDialplanInput): Action[] {
  const address = input.receptionist || defaultReceptionist;
  const open = officeHoursDecision(input.pbx.officeHours, input.now).open;
  return [
    set('vocivo_did', channelSafe(input.did)),
    set('vocivo_org', channelSafe(input.organizationId)),
    action('socket', `${address} async full`),
    action('log', `WARNING Vocivo receptionist did not answer; falling back to the ${open ? 'voice menu' : 'closed message'}`),
    ...(open ? menuFallbackActions(input) : unavailableActions(input, true)),
  ];
}

function menuFallbackActions(input: SipDialplanInput): Action[] {
  const menu = menuPrompt(input);
  return gatherActions(input, {
    prompt: menu.prompt,
    invalid: menu.invalid,
    minDigits: 1,
    maxDigits: 1,
    regex: `^[${menu.validDigits}]$`,
    timeoutMs: 10000,
    next: 'ivr-select',
  });
}

function ivrSelectActions(input: SipDialplanInput) {
  const menu = menuPrompt(input);
  const digit = input.request.digit;
  if (!digit) return noInputActions(input);
  if (digit === '9' && menu.hasExtensions) {
    return gatherActions(input, {
      prompt: fixedPrompts.extensionPrompt,
      invalid: fixedPrompts.extensionInvalid,
      minDigits: 2,
      maxDigits: 5,
      regex: '^\\d{2,5}$',
      timeoutMs: 8000,
      next: 'ext-select',
    });
  }
  const index = /^[1-9]$/.test(digit) ? Number(digit) : 0;
  const department = index >= 1 ? input.business.departments[index - 1] : undefined;
  if (!department) return unavailableActions(input, true);
  const destination = departmentDestination(input, department);
  if (!destination) return unavailableActions(input, true);
  return ringExtensionActions(input, destination, { announceWaiting: true, depth: 0, visited: [] });
}

function extensionSelectActions(input: SipDialplanInput) {
  if (!input.request.digit) return noInputActions(input);
  const extension = activeExtensions(input).find((item) => item.extension === input.request.digit);
  if (extension) return ringExtensionActions(input, extension, { announceWaiting: true, depth: 0, visited: [] });
  const fallback = departmentDestination(input, input.business.companyName);
  const notice = playback(input, fixedPrompts.extensionUnavailable);
  if (!fallback) return [notice, ...unavailableActions(input, true)];
  return [notice, ...ringExtensionActions(input, fallback, { announceWaiting: true, depth: 0, visited: [] })];
}

function configuredIvrSelectActions(input: SipDialplanInput) {
  if (!input.request.digit) return noInputActions(input);
  const ivr = input.pbx.callHandling.ivrs.find((item) => item.id === input.request.arg);
  const target = ivr?.options[input.request.digit.slice(0, 1)];
  if (!target) return unavailableActions(input, true);
  return configuredTargetActions(input, target, 0, []);
}

function afterRingActions(input: SipDialplanInput) {
  const request = input.request;
  const extension = activeExtensions(input).find((item) => item.id === request.arg);
  const profile = extension ? input.pbx.userProfiles[extension.id] : undefined;
  const voicemailEnabled = userVoicemailEnabled(profile, input.business.voicemailEnabled);
  const target = forwardingTargetForCause(profile, fsCauseToVocivo(request.disposition));
  const voicemailTarget = !target || ['voicemail', 'main voicemail'].includes(target.toLowerCase());
  if (voicemailTarget || request.depth >= maxForwardingDepth) return unavailableActions(input, voicemailEnabled);
  const visited = [...new Set([...request.visited, ...(extension ? [extension.id] : [])])].slice(-5);
  const forwardExtension = activeExtensions(input).find((item) => item.extension === target.replace(/\D/g, '') && item.id !== extension?.id && !visited.includes(item.id));
  if (forwardExtension) return ringExtensionActions(input, forwardExtension, { announceWaiting: false, depth: request.depth + 1, visited });
  const destination = normalizeE164(target);
  const leg = trunkLeg(input, destination, extension);
  if (leg) {
    return [
      ...bridgeActions(input, [leg], 45, { announceWaiting: false }),
      ...transferToStage('unavailable', { arg: voicemailEnabled ? 'user' : 'none' }),
    ];
  }
  return unavailableActions(input, voicemailEnabled);
}

function afterGroupActions(input: SipDialplanInput) {
  const [kind, id] = input.request.arg.split(':', 2);
  if ((kind === 'ring_group' || kind === 'queue') && id) return groupFallbackActions(input, kind, id);
  return unavailableActions(input, true);
}

function queueActions(input: SipDialplanInput) {
  const [kind, id] = input.request.arg.split(':', 2);
  if (kind !== 'queue' || !id) return unavailableActions(input, true);
  return groupActions(input, 'queue', id, input.request.attempt);
}

export function renderSipDialplan(input: SipDialplanInput) {
  const stage = input.request.stage || 'entry';
  switch (stage) {
    case 'entry': return dialplanDocument('entry', entryActions(input));
    case 'ivr-select': return dialplanDocument('ivr-select', ivrSelectActions(input));
    case 'ext-select': return dialplanDocument('ext-select', extensionSelectActions(input));
    case 'cfg-ivr-select': return dialplanDocument('cfg-ivr-select', configuredIvrSelectActions(input));
    case 'after-ring': return dialplanDocument('after-ring', afterRingActions(input));
    case 'after-group': return dialplanDocument('after-group', afterGroupActions(input));
    case 'queue': return dialplanDocument('queue', queueActions(input));
    case 'unavailable': return dialplanDocument('unavailable', unavailableActions(input, input.request.arg !== 'none'));
    default: return dialplanDocument('unavailable', unavailableActions(input, true));
  }
}
