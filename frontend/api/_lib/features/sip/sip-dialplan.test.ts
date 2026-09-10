import assert from 'node:assert/strict';
import test from 'node:test';
import type { BusinessVoiceConfig } from '../numbers/number-config.js';
import type { ExtensionUser } from '../organizations/pbx.js';
import { defaultPbxConfig, type PbxConfig } from '../organizations/pbx-config-store.js';
import {
  channelSafe,
  dialplanPromptTexts,
  isLocalOrigination,
  normalizedPromptText,
  parseXmlCurlRequest,
  promptSignature,
  promptUrl,
  renderSipDialplan,
  verifyPromptSignature,
  verifyVoicemailUpload,
  xmlCurlNotFound,
  type SipDialplanInput,
  type XmlCurlRequest,
} from './sip-dialplan.js';

const did = '+15551230000';
const now = new Date('2026-09-02T10:00:00Z'); // a Wednesday
const secret = 'edge-secret-for-tests';

function extension(overrides: Partial<ExtensionUser> & Pick<ExtensionUser, 'id' | 'extension' | 'name' | 'sipUsername'>): ExtensionUser {
  return { email: '', mobile: '', organizationId: 'acme', department: 'General', role: 'user', status: 'active', ...overrides };
}

const alice = extension({ id: 'e1', extension: '2001', name: 'Alice', department: 'Sales', sipUsername: 'alice' });
const bob = extension({ id: 'e2', extension: '2002', name: 'Bob', department: 'Support', sipUsername: 'bob' });
const gone = extension({ id: 'e3', extension: '2003', name: 'Gone', department: 'Sales', sipUsername: 'gone', status: 'expired' });
const stranger = extension({ id: 'e4', extension: '3001', name: 'Other Org', department: 'Sales', sipUsername: 'other', organizationId: 'globex' });

function business(overrides: Partial<BusinessVoiceConfig> = {}): BusinessVoiceConfig {
  return {
    enabled: true,
    voicemailEnabled: true,
    voicemailDelaySeconds: 25,
    voicemailGreeting: 'Leave a message after the tone.',
    companyName: 'Acme',
    greeting: 'Welcome to Acme.',
    waitingMessage: 'Please hold while we connect you.',
    departments: ['Sales', 'Support'],
    voice: 'Telnyx.KokoroTTS.af_heart',
    backgroundImageUrl: '',
    ...overrides,
  };
}

function pbx(overrides: Partial<PbxConfig> = {}): PbxConfig {
  const base = defaultPbxConfig();
  return {
    ...base,
    activeOrganizationId: 'acme',
    organizations: [{ id: 'acme', name: 'Acme', slug: 'acme', extensionStart: 2000, extensionEnd: 2099, accountType: 'business', ownerDisplayName: 'Acme', ownerEmail: '', internalCallingEnabled: true, status: 'active' }],
    numberAssignments: { [did]: { organizationId: 'acme', destinationType: 'main' } },
    officeHours: { ...base.officeHours, timezone: 'UTC' },
    callHandling: {
      ringGroups: [{ id: 'rg1', name: 'Sales team', extension: '2100', strategy: 'Ring all', members: ['e1', 'e2', 'e3'], timeout: 30, fallback: 'Main voicemail' }],
      queues: [{ id: 'q1', name: 'Support queue', extension: '2200', strategy: 'Ring all available', members: ['e2'], maxWait: 100, fallback: 'Main line' }],
      ivrs: [{ id: 'ivr1', name: 'Front desk', extension: '2300', greeting: 'Thanks for calling Acme.', options: { '1': 'extension:e1', '2': 'ring_group:rg1' } }],
    },
    ...overrides,
  };
}

function request(overrides: Partial<XmlCurlRequest> = {}): XmlCurlRequest {
  return {
    section: 'dialplan', context: 'public', destinationNumber: did, callerNumber: '+15559876543', callerName: 'Jane Caller',
    uuid: 'call-uuid-1', networkAddr: '192.0.2.10', switchAddr: '203.0.113.5', vocivoCallerIdHeader: '', vocivoFlowHeader: '',
    stage: '', organizationId: '', did: '', arg: '', digit: '', disposition: '', depth: 0, visited: [], attempt: 0,
    waitingAnnounced: false, callerFrom: '', callerDisplay: '', fromReceptionist: false,
    ...overrides,
  };
}

function input(overrides: Partial<SipDialplanInput> = {}): SipDialplanInput {
  return {
    request: request(), organizationId: 'acme', did, pbx: pbx(), business: business(), extensions: [alice, bob, gone, stranger],
    apiUrl: 'https://vocivo.app', secret, promptFormat: 'mp3', recordingsDir: '/var/lib/vocivo/recordings', trunkGateway: 'telnyx', now,
    ...overrides,
  };
}

function actions(xml: string) {
  return [...xml.matchAll(/<action application="([^"]+)"(?: data="([^"]*)")?\/>/g)].map((match) => ({ app: match[1], data: (match[2] || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'") }));
}

test('removed and unassigned carrier numbers never answer or start the receptionist', () => {
  for (const assignment of [undefined, { organizationId: 'acme', disabled: true, destinationType: 'main' as const },
    { organizationId: 'acme', source: 'carrier' as const }, { organizationId: 'globex', destinationType: 'main' as const }]) {
    const config = pbx();
    config.ai.enabled = true;
    if (assignment) config.numberAssignments[did] = assignment; else delete config.numberAssignments[did];
    const xml = renderSipDialplan(input({ pbx: config }));
    assert.doesNotMatch(xml, /application="(?:answer|socket|bridge)"/);
    assert.match(xml, /480 Number unavailable/);
  }
});

test('queue retries spend only the configured ringing budget and stop at exhaustion', () => {
  for (const maxWait of [15, 46, 100, 181]) {
    const config = pbx();
    config.callHandling.queues[0].maxWait = maxWait;
    const attempts = Math.ceil(maxWait / 45);
    let total = 0;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const list = actions(renderSipDialplan(input({ pbx: config, request: request({ stage: 'queue', arg: 'queue:q1', attempt }) })));
      total += Number(list.find((item) => item.data.startsWith('call_timeout='))!.data.split('=')[1]);
    }
    assert.equal(total, maxWait, `queue budget ${maxWait}`);
    const exhausted = actions(renderSipDialplan(input({ pbx: config, request: request({ stage: 'queue', arg: 'queue:q1', attempt: attempts }) })));
    assert.ok(exhausted.some((item) => item.data === 'vocivo_stage=after-group'));
    assert.ok(!exhausted.some((item) => item.app === 'bridge'));
  }
});

/** The `text` query parameter of the first prompt URL inside an action's data. */
function promptText(data: string) {
  const match = data.match(/http_cache:\/\/(https?:\/\/\S+)/);
  return match ? new URL(match[1]).searchParams.get('text') || '' : '';
}

function stageTransfer(xml: string) {
  const list = actions(xml);
  const stage = list.find((item) => item.app === 'set' && item.data.startsWith('vocivo_stage='));
  const transfer = list.find((item) => item.app === 'transfer');
  return { stage: stage?.data.slice('vocivo_stage='.length), transfer: transfer?.data };
}

function assertWellFormed(xml: string) {
  assert.ok(xml.startsWith('<document type="freeswitch/xml">'), 'document root');
  assert.ok(xml.trimEnd().endsWith('</document>'), 'document closed');
  const opens = (xml.match(/<(document|section|context|extension|condition)\b[^>]*[^/]>/g) || []).length;
  const closes = (xml.match(/<\/(document|section|context|extension|condition)>/g) || []).length;
  assert.equal(opens, closes, 'balanced container tags');
  assert.doesNotMatch(xml, /&(?!amp;|lt;|gt;|quot;|apos;)/, 'no unescaped ampersands');
  assert.doesNotMatch(xml, /data="[^"]*"[^"]*"[^"]*"\/>/, 'no stray quotes inside data attributes');
}

test('parses xml_curl form fields and vocivo channel variables', () => {
  const parsed = parseXmlCurlRequest({
    section: 'Dialplan', 'Caller-Context': 'public', 'Caller-Destination-Number': did, 'Caller-Caller-ID-Number': '+15559876543',
    'Caller-Caller-ID-Name': 'Jane', 'Caller-Unique-ID': 'abc', 'Caller-Network-Addr': '192.0.2.10', 'FreeSWITCH-IPv4': '203.0.113.5',
    variable_vocivo_stage: 'IVR-Select', variable_vocivo_org: 'acme', variable_vocivo_did: did, variable_vocivo_digit: '1#',
    variable_vocivo_depth: '2', variable_vocivo_visited: 'e1:e2', variable_vocivo_attempt: '3', variable_vocivo_waiting: '1',
    variable_originate_disposition: 'no_answer',
  });
  assert.equal(parsed.section, 'dialplan');
  assert.equal(parsed.stage, 'ivr-select');
  assert.equal(parsed.digit, '1');
  assert.equal(parsed.depth, 2);
  assert.deepEqual(parsed.visited, ['e1', 'e2']);
  assert.equal(parsed.attempt, 3);
  assert.equal(parsed.waitingAnnounced, true);
  assert.equal(parsed.disposition, 'NO_ANSWER');
  assert.equal(parsed.uuid, 'abc');
});

test('recognises hairpinned outbound origination so the static dialplan keeps handling it', () => {
  assert.equal(isLocalOrigination(request({ vocivoCallerIdHeader: '+15550001111' })), true);
  assert.equal(isLocalOrigination(request({ networkAddr: '127.0.0.1' })), true);
  assert.equal(isLocalOrigination(request({ networkAddr: '203.0.113.5', switchAddr: '203.0.113.5' })), true);
  assert.equal(isLocalOrigination(request({ networkAddr: '192.0.2.10' })), false);
  assert.equal(isLocalOrigination(request({ networkAddr: '127.0.0.1', vocivoFlowHeader: 'outbound' })), true);
  assert.equal(isLocalOrigination(request({ networkAddr: '127.0.0.1', vocivoFlowHeader: 'conference' })), true);
  assert.match(xmlCurlNotFound(), /result status="not found"/);
});

test('a call Kamailio tagged as inbound is not local, even though it arrives from loopback', () => {
  // Every call reaches FreeSWITCH from Kamailio on 127.0.0.1, the carrier's
  // included; the tag is what separates a DID from a hairpinned origination.
  assert.equal(isLocalOrigination(request({ networkAddr: '127.0.0.1', vocivoFlowHeader: 'inbound' })), false);
  const parsed = parseXmlCurlRequest({ section: 'dialplan', 'Caller-Network-Addr': '127.0.0.1', 'variable_sip_h_X-Vocivo-Flow': 'Inbound' });
  assert.equal(parsed.vocivoFlowHeader, 'inbound');
  assert.equal(isLocalOrigination(parsed), false);
});

test('channel-safe values cannot smuggle FreeSWITCH expansions or delimiters', () => {
  assert.equal(channelSafe('Jane ${hangup} , <x>'), 'Jane hangup x');
  assert.equal(channelSafe('a'.repeat(200), 10).length, 10);
});

test('entry on a main-line DID answers, records the call context, and plays the department menu', () => {
  const xml = renderSipDialplan(input());
  assertWellFormed(xml);
  const list = actions(xml);
  assert.equal(list[0].app, 'answer');
  assert.ok(list.some((item) => item.data === 'vocivo_org=acme'));
  assert.ok(list.some((item) => item.data === `vocivo_did=${did}`));
  assert.ok(list.some((item) => item.data === 'vocivo_from=+15559876543'));
  const gather = list.find((item) => item.app === 'play_and_get_digits');
  assert.ok(gather, 'menu gathers a digit');
  assert.match(gather!.data, /^1 1 2 10000 # http_cache:\/\/https:\/\/vocivo\.app\/api\/voice\/sip-prompt\/[A-Za-z0-9_-]+\.mp3\?/);
  assert.match(gather!.data, / vocivo_digit \^\[129\]\$ 3000$/, 'two departments plus 9 for extensions');
  assert.equal(promptText(gather!.data), 'Welcome to Acme. For Sales, press 1. For Support, press 2. If you know your party extension, press 9. Or stay on the line and we will connect you.');
  assert.deepEqual(stageTransfer(xml), { stage: 'ivr-select', transfer: '${vocivo_did} XML public' });
});

test('prompt URLs are signed and verifiable, and carry the format in the path for http_cache', () => {
  const url = promptUrl({ apiUrl: 'https://vocivo.app/', secret, promptFormat: 'wav' }, 'Hello there.', 'voice-a');
  const parsed = new URL(url);
  assert.match(parsed.pathname, /^\/api\/voice\/sip-prompt\/[A-Za-z0-9_-]{24}\.wav$/);
  assert.equal(parsed.searchParams.get('text'), 'Hello there.');
  assert.equal(verifyPromptSignature(secret, 'Hello there.', 'voice-a', 'wav', parsed.searchParams.get('sig') || ''), true);
  assert.equal(verifyPromptSignature(secret, 'Hello there!', 'voice-a', 'wav', parsed.searchParams.get('sig') || ''), false);
  assert.equal(verifyPromptSignature('other', 'Hello there.', 'voice-a', 'wav', parsed.searchParams.get('sig') || ''), false);
});

test('a prompt URL has no dot after the path, because mod_http_cache takes its file extension from the last one', () => {
  // The first live call: the voice id Vocivo.Kokoro.AmAdam gave the cached
  // copy the extension "AmAdam&sig=…", no file module could open it, and every
  // prompt was silent.
  const url = promptUrl({ apiUrl: 'https://vocivo.app', secret, promptFormat: 'wav' }, 'Welcome to Global Heritage. For Sales, press 1.', 'Vocivo.Kokoro.AmAdam');
  const [path, query] = url.split('?');
  assert.match(path, /\.wav$/);
  assert.equal(query.includes('.'), false);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('voice'), 'Vocivo.Kokoro.AmAdam');
  assert.equal(parsed.searchParams.get('text'), 'Welcome to Global Heritage. For Sales, press 1.');
  assert.equal(verifyPromptSignature(secret, 'Welcome to Global Heritage. For Sales, press 1.', 'Vocivo.Kokoro.AmAdam', 'wav', parsed.searchParams.get('sig') || ''), true);
});

test('outside office hours the caller goes straight to a signed voicemail upload', () => {
  const closed = pbx();
  closed.officeHours.weekdays.Wednesday = { enabled: false, start: '09:00', end: '17:00' };
  const xml = renderSipDialplan(input({ pbx: closed }));
  assertWellFormed(xml);
  const list = actions(xml);
  assert.ok(!list.some((item) => item.app === 'bridge'), 'nobody is rung');
  assert.equal(promptText(list.find((item) => item.app === 'playback')!.data), 'Leave a message after the tone.');
  const record = list.find((item) => item.app === 'record');
  assert.equal(record?.data, '/var/lib/vocivo/recordings/${uuid}.wav 120 30 5');
  // The upload runs from the hangup hook, not as the next action: the caller
  // hangs up when the message is finished, and nothing after `record` would
  // ever run.
  assert.ok(list.some((item) => item.app === 'set' && item.data === 'session_in_hangup_hook=true'));
  const hook = list.find((item) => item.app === 'set' && item.data.startsWith('api_hangup_hook='));
  assert.ok(hook, 'the recording is uploaded from a hangup hook');
  const quoted = hook!.data.match(/^api_hangup_hook=system \/bin\/sh \/opt\/vocivo-fs\/voicemail-hangup\.sh '([^']*)' '([^']*)'$/);
  assert.ok(quoted, `the hook quotes both of its arguments: ${hook!.data}`);
  const [, url, file] = quoted!;
  assert.equal(file, '/var/lib/vocivo/recordings/${uuid}.wav');
  const params = new URL(url).searchParams;
  assert.equal(params.get('org'), 'acme');
  assert.equal(params.get('call'), 'call-uuid-1');
  assert.equal(params.get('from'), '+15559876543');
  assert.equal(verifyVoicemailUpload(secret, { org: 'acme', call: 'call-uuid-1', from: '+15559876543', name: 'Jane Caller', exp: params.get('exp') || '', sig: params.get('sig') || '' }, now), true);
  assert.equal(verifyVoicemailUpload(secret, { org: 'globex', call: 'call-uuid-1', from: '+15559876543', name: 'Jane Caller', exp: params.get('exp') || '', sig: params.get('sig') || '' }, now), false);
  assert.equal(verifyVoicemailUpload(secret, { org: 'acme', call: 'call-uuid-1', from: '+15559876543', name: 'Jane Caller', exp: params.get('exp') || '', sig: params.get('sig') || '' }, new Date(now.getTime() + 2 * 60 * 60 * 1000)), false, 'expired upload links are rejected');
  assert.equal(list.at(-1)?.app, 'hangup');
});

test('a greeting with stray whitespace still signs, because both ends normalise the same way', () => {
  // A blank IVR greeting leaves the menu sentence starting with a space, and a
  // greeting typed with a trailing one leaves it ending with a space. The
  // endpoint verified against a trimmed copy, so the signature never matched
  // and the caller heard a 403 — which is to say, nothing.
  const spaced = '  Welcome to Acme.\n\n  Press one for sales.  ';
  const tidy = 'Welcome to Acme. Press one for sales.';
  assert.equal(normalizedPromptText(spaced), tidy);
  assert.equal(promptSignature(secret, spaced, 'Vocivo.Kokoro.Heart', 'wav'), promptSignature(secret, tidy, 'Vocivo.Kokoro.Heart', 'wav'));
  const url = new URL(promptUrl({ apiUrl: 'https://vocivo.app', secret, promptFormat: 'wav' }, spaced, 'Vocivo.Kokoro.Heart').replace(/%2E/g, '.'));
  assert.equal(url.searchParams.get('text'), tidy, 'the URL carries what was signed');
  assert.equal(verifyPromptSignature(secret, url.searchParams.get('text') || '', 'Vocivo.Kokoro.Heart', 'wav', url.searchParams.get('sig') || ''), true);
});

test('with company voicemail disabled the closed prompt just hangs up', () => {
  const closed = pbx();
  closed.officeHours.weekdays.Wednesday = { enabled: false, start: '09:00', end: '17:00' };
  const xml = renderSipDialplan(input({ pbx: closed, business: business({ voicemailEnabled: false }) }));
  const list = actions(xml);
  assert.ok(!list.some((item) => item.app === 'record'));
  assert.match(promptText(list.find((item) => item.app === 'playback')!.data), /^No one is available to take your call/);
  assert.equal(list.at(-1)?.app, 'hangup');
});

test('a DID assigned to an extension rings that extension directly with ringback, no menu', () => {
  const direct = pbx({ numberAssignments: { [did]: { organizationId: 'acme', destinationType: 'extension', destinationId: 'e1' } } });
  const xml = renderSipDialplan(input({ pbx: direct }));
  assertWellFormed(xml);
  const list = actions(xml);
  const bridge = list.find((item) => item.app === 'bridge');
  assert.equal(bridge?.data, 'sofia/external/alice@127.0.0.1:5060');
  assert.ok(list.some((item) => item.data === 'call_timeout=25'), 'company voicemail delay is the default no-answer timeout');
  assert.ok(list.some((item) => item.data === 'continue_on_fail=true'));
  assert.ok(!list.some((item) => item.app === 'playback'), 'direct dials use ringback, not the waiting message');
  assert.deepEqual(stageTransfer(xml).stage, 'after-ring');
  assert.ok(list.some((item) => item.data === 'vocivo_arg=e1'));
  assert.ok(list.some((item) => item.data === 'vocivo_visited=e1'));
});

test('an extension DID skips the company hours check but still honours the user schedule', () => {
  const alwaysOn = { outboundCallerId: '', did: '', twoFactorEnabled: false, noAnswerSeconds: 20, forwardBusy: '', forwardNoAnswer: '', forwardUnavailable: '', simultaneousRing: '', voicemailEnabled: true, voicemailEmail: false, voicemailTranscription: false, schedule: 'Always available', permissions: { international: false, transfer: false, video: false, recording: false, reports: false } };
  const closed = pbx({ numberAssignments: { [did]: { organizationId: 'acme', destinationType: 'extension', destinationId: 'e1' } }, userProfiles: { e1: alwaysOn } });
  closed.officeHours.weekdays.Wednesday = { enabled: false, start: '09:00', end: '17:00' };
  const rung = actions(renderSipDialplan(input({ pbx: closed })));
  assert.equal(rung.find((item) => item.app === 'bridge')?.data, 'sofia/external/alice@127.0.0.1:5060', 'always-available users ring after hours');
  const defaultSchedule = pbx({ numberAssignments: { [did]: { organizationId: 'acme', destinationType: 'extension', destinationId: 'e1' } } });
  defaultSchedule.officeHours.weekdays.Wednesday = { enabled: false, start: '09:00', end: '17:00' };
  const voicemail = actions(renderSipDialplan(input({ pbx: defaultSchedule })));
  assert.ok(!voicemail.some((item) => item.app === 'bridge'), 'users on office hours are not rung after hours');
  assert.ok(voicemail.some((item) => item.app === 'record'));
});

test('an extension whose schedule follows office hours goes to voicemail when closed', () => {
  const closed = pbx({
    numberAssignments: { [did]: { organizationId: 'acme', destinationType: 'extension', destinationId: 'e1' } },
    userProfiles: { e1: { outboundCallerId: '', did: '', twoFactorEnabled: false, noAnswerSeconds: 20, forwardBusy: '', forwardNoAnswer: '', forwardUnavailable: '', simultaneousRing: '', voicemailEnabled: true, voicemailEmail: false, voicemailTranscription: false, schedule: 'Use office hours', permissions: { international: false, transfer: false, video: false, recording: false, reports: false } } },
  });
  closed.officeHours.weekdays.Wednesday = { enabled: false, start: '09:00', end: '17:00' };
  const list = actions(renderSipDialplan(input({ pbx: closed })));
  assert.ok(!list.some((item) => item.app === 'bridge'));
  assert.ok(list.some((item) => item.app === 'record'));
});

test('simultaneous ring adds the second extension, or a trunk leg carrying the DID as caller id', () => {
  const profile = { outboundCallerId: '', did: '', twoFactorEnabled: false, noAnswerSeconds: 40, forwardBusy: '', forwardNoAnswer: '', forwardUnavailable: '', simultaneousRing: '2002', voicemailEnabled: true, voicemailEmail: false, voicemailTranscription: false, schedule: 'Always available', permissions: { international: false, transfer: false, video: false, recording: false, reports: false } };
  const withExtension = pbx({ numberAssignments: { [did]: { organizationId: 'acme', destinationType: 'extension', destinationId: 'e1' } }, userProfiles: { e1: profile } });
  let list = actions(renderSipDialplan(input({ pbx: withExtension })));
  assert.equal(list.find((item) => item.app === 'bridge')?.data, 'sofia/external/alice@127.0.0.1:5060:_:sofia/external/bob@127.0.0.1:5060');
  assert.ok(list.some((item) => item.data === 'call_timeout=40'), 'user no-answer seconds win');

  const withMobile = pbx({ numberAssignments: { [did]: { organizationId: 'acme', destinationType: 'extension', destinationId: 'e1' } }, userProfiles: { e1: { ...profile, permissions: { ...profile.permissions, international: true }, simultaneousRing: '+15550009999' } } });
  list = actions(renderSipDialplan(input({ pbx: withMobile })));
  const bridge = list.find((item) => item.app === 'bridge')!.data;
  assert.match(bridge, /^sofia\/external\/alice@127\.0\.0\.1:5060:_:\{origination_caller_id_number=\+15551230000,/);
  assert.match(bridge, /sofia\/gateway\/telnyx\/\+15550009999$/);
});

test('a DID assigned to a ring group rings every active member at once with the group timeout', () => {
  const xml = renderSipDialplan(input({ pbx: pbx({ numberAssignments: { [did]: { organizationId: 'acme', destinationType: 'ring_group', destinationId: 'rg1' } } }) }));
  assertWellFormed(xml);
  const list = actions(xml);
  assert.equal(list.find((item) => item.app === 'bridge')?.data, 'sofia/external/alice@127.0.0.1:5060:_:sofia/external/bob@127.0.0.1:5060', 'expired member is skipped');
  assert.ok(list.some((item) => item.data === 'call_timeout=30'));
  assert.deepEqual(stageTransfer(xml).stage, 'after-group');
  assert.ok(list.some((item) => item.data === 'vocivo_arg=ring_group:rg1'));
});

test('a queue announces the wait, rings in 45-second attempts, and gives up at maxWait', () => {
  const queued = pbx({ numberAssignments: { [did]: { organizationId: 'acme', destinationType: 'queue', destinationId: 'q1' } } });
  const first = actions(renderSipDialplan(input({ pbx: queued })));
  assert.equal(promptText(first.find((item) => item.app === 'playback')?.data || ''), 'Please hold while we connect you.');
  assert.ok(first.some((item) => item.data === 'call_timeout=45'));
  assert.ok(first.some((item) => item.data === 'vocivo_stage=queue'));
  assert.ok(first.some((item) => item.data === 'vocivo_attempt=1'));

  // maxWait 100s => 3 attempts (0,1,2); attempt 2 is the last and falls back.
  const last = actions(renderSipDialplan(input({ pbx: queued, request: request({ stage: 'queue', arg: 'queue:q1', attempt: 2, waitingAnnounced: true }) })));
  assert.ok(last.some((item) => item.app === 'bridge'));
  assert.ok(last.some((item) => item.data === 'vocivo_stage=after-group'));
  assert.ok(!last.some((item) => item.data === 'vocivo_stage=queue'));
});

test('group fallback honours "Main line" versus "Main voicemail"', () => {
  const ringGroup = actions(renderSipDialplan(input({ request: request({ stage: 'after-group', arg: 'ring_group:rg1' }) })));
  assert.ok(ringGroup.some((item) => item.app === 'record'), 'ring group falls back to voicemail');
  const queue = actions(renderSipDialplan(input({ request: request({ stage: 'after-group', arg: 'queue:q1' }) })));
  assert.equal(queue.find((item) => item.app === 'bridge')?.data, 'sofia/external/alice@127.0.0.1:5060:_:sofia/external/bob@127.0.0.1:5060', 'queue falls back to ringing the main line');
});

test('a DID assigned to a configured voice menu reads the labelled options', () => {
  const xml = renderSipDialplan(input({ pbx: pbx({ numberAssignments: { [did]: { organizationId: 'acme', destinationType: 'ivr', destinationId: 'ivr1' } } }) }));
  assertWellFormed(xml);
  const gather = actions(xml).find((item) => item.app === 'play_and_get_digits')!;
  assert.equal(promptText(gather.data), 'Thanks for calling Acme. For Alice, press 1. For Sales team, press 2.');
  assert.match(gather.data, / vocivo_digit \^\[12\]\$ 3000$/);
  assert.deepEqual(stageTransfer(xml).stage, 'cfg-ivr-select');
  assert.ok(actions(xml).some((item) => item.data === 'vocivo_arg=ivr1'));
});

test('configured menu selections route to the extension or team behind the digit', () => {
  const toAlice = actions(renderSipDialplan(input({ request: request({ stage: 'cfg-ivr-select', arg: 'ivr1', digit: '1' }) })));
  assert.equal(toAlice.find((item) => item.app === 'bridge')?.data, 'sofia/external/alice@127.0.0.1:5060');
  const toTeam = actions(renderSipDialplan(input({ request: request({ stage: 'cfg-ivr-select', arg: 'ivr1', digit: '2' }) })));
  assert.match(toTeam.find((item) => item.app === 'bridge')?.data || '', /alice.*:_:.*bob/);
  const invalid = actions(renderSipDialplan(input({ request: request({ stage: 'cfg-ivr-select', arg: 'ivr1', digit: '7' }) })));
  assert.ok(invalid.some((item) => item.app === 'record'), 'unknown digit goes to voicemail');
});

test('department menu selections reach the departmental extension after the waiting message', () => {
  const xml = renderSipDialplan(input({ request: request({ stage: 'ivr-select', digit: '1' }) }));
  const list = actions(xml);
  const playbackIndex = list.findIndex((item) => item.app === 'playback');
  const bridgeIndex = list.findIndex((item) => item.app === 'bridge');
  assert.ok(playbackIndex >= 0 && playbackIndex < bridgeIndex, 'waiting message precedes the bridge');
  assert.ok(list.some((item) => item.data === 'vocivo_waiting=1'));
  assert.equal(list[bridgeIndex].data, 'sofia/external/alice@127.0.0.1:5060', 'Sales maps to Alice');
  const support = actions(renderSipDialplan(input({ request: request({ stage: 'ivr-select', digit: '2' }) })));
  assert.equal(support.find((item) => item.app === 'bridge')?.data, 'sofia/external/bob@127.0.0.1:5060');
});

test('pressing 9 collects an extension number; bad digits fall to voicemail', () => {
  const collect = actions(renderSipDialplan(input({ request: request({ stage: 'ivr-select', digit: '9' }) })));
  const gather = collect.find((item) => item.app === 'play_and_get_digits')!;
  assert.match(gather.data, /^2 5 2 8000 # /);
  assert.match(gather.data, / vocivo_digit \^\\d\{2,5\}\$ 3000$/);
  assert.ok(collect.some((item) => item.data === 'vocivo_stage=ext-select'));
  const outOfRange = actions(renderSipDialplan(input({ request: request({ stage: 'ivr-select', digit: '5' }) })));
  assert.ok(outOfRange.some((item) => item.app === 'record'));
});

test('a caller who presses nothing is connected to the main line, not sent away', () => {
  // play_and_get_digits gives up after two tries — and at once when a prompt
  // could not be played. The caller is still there, so the staff ring.
  for (const stage of ['ivr-select', 'ext-select', 'cfg-ivr-select']) {
    const list = actions(renderSipDialplan(input({ request: request({ stage, digit: '', arg: 'ivr-1' }) })));
    const bridge = list.find((item) => item.app === 'bridge');
    assert.ok(bridge, `${stage} without a digit rings the staff`);
    assert.match(bridge!.data, /^sofia\/external\/alice@127\.0\.0\.1:5060/, `${stage} rings the company's active extensions`);
    assert.ok(!list.some((item) => item.app === 'record'), `${stage} without a digit does not go straight to voicemail`);
  }
  // With nobody to ring, voicemail is still the answer.
  const nobody = actions(renderSipDialplan(input({ request: request({ stage: 'ivr-select', digit: '' }), extensions: [] })));
  assert.ok(nobody.some((item) => item.app === 'record') || nobody.some((item) => item.app === 'hangup'));
});

test('the prompt inventory lists every sentence the dialplan can play, once, in the business voice', () => {
  const base = input();
  const inventory = dialplanPromptTexts({ pbx: base.pbx, business: base.business, extensions: base.extensions, organizationId: base.organizationId });
  assert.equal(inventory.voice, base.business.voice);
  assert.ok(inventory.texts.includes('Welcome to Acme. For Sales, press 1. For Support, press 2. If you know your party extension, press 9. Or stay on the line and we will connect you.'));
  assert.ok(inventory.texts.includes('That selection was not recognized. Please press one of these options: 1, 2, 9.'));
  assert.ok(inventory.texts.some((text) => text.startsWith('Thanks for calling Acme. For ')), 'configured voice menus are included');
  assert.ok(inventory.texts.includes(base.business.waitingMessage));
  assert.ok(inventory.texts.includes(base.business.voicemailGreeting));
  assert.ok(inventory.texts.includes('Please enter the extension number now.'));
  assert.ok(inventory.texts.includes('No one is available to take your call right now. Please try again later.'));
  assert.equal(new Set(inventory.texts).size, inventory.texts.length, 'no duplicates');
  assert.ok(inventory.texts.every((text) => text.trim() === text && text.length > 0));
});

test('a dialled extension rings; an unknown one is announced and sent to the main line', () => {
  const known = actions(renderSipDialplan(input({ request: request({ stage: 'ext-select', digit: '2002' }) })));
  assert.equal(known.find((item) => item.app === 'bridge')?.data, 'sofia/external/bob@127.0.0.1:5060');
  const unknown = actions(renderSipDialplan(input({ request: request({ stage: 'ext-select', digit: '2999' }) })));
  assert.match(promptText(unknown[0].data), /^That extension is not available/);
  assert.equal(unknown.find((item) => item.app === 'bridge')?.data, 'sofia/external/alice@127.0.0.1:5060', 'first active extension answers for the main line');
  const foreign = actions(renderSipDialplan(input({ request: request({ stage: 'ext-select', digit: '3001' }) })));
  assert.notEqual(foreign.find((item) => item.app === 'bridge')?.data, 'sofia/external/other@127.0.0.1:5060', 'another tenant\'s extension is never reachable');
});

test('after an unanswered ring the user profile decides: forward, trunk, or voicemail', () => {
  const profile = { outboundCallerId: '', did: '', twoFactorEnabled: false, noAnswerSeconds: 20, forwardBusy: 'Voicemail', forwardNoAnswer: '2002', forwardUnavailable: '+15550007777', simultaneousRing: '', voicemailEnabled: true, voicemailEmail: false, voicemailTranscription: false, schedule: 'Always available', permissions: { international: false, transfer: false, video: false, recording: false, reports: false } };
  const config = pbx({ userProfiles: { e1: profile } });

  const noAnswer = renderSipDialplan(input({ pbx: config, request: request({ stage: 'after-ring', arg: 'e1', disposition: 'NO_ANSWER', depth: 0, visited: ['e1'] }) }));
  const forwarded = actions(noAnswer);
  assert.equal(forwarded.find((item) => item.app === 'bridge')?.data, 'sofia/external/bob@127.0.0.1:5060');
  assert.ok(forwarded.some((item) => item.data === 'vocivo_depth=1'));
  assert.ok(forwarded.some((item) => item.data === 'vocivo_visited=e1:e2'));

  const busy = actions(renderSipDialplan(input({ pbx: config, request: request({ stage: 'after-ring', arg: 'e1', disposition: 'USER_BUSY' }) })));
  assert.ok(busy.some((item) => item.app === 'record'), 'busy → voicemail');

  profile.permissions.international = true;
  const unavailable = actions(renderSipDialplan(input({ pbx: config, request: request({ stage: 'after-ring', arg: 'e1', disposition: 'NORMAL_TEMPORARY_FAILURE' }) })));
  const trunk = unavailable.find((item) => item.app === 'bridge')?.data || '';
  assert.match(trunk, /^\{origination_caller_id_number=\+15551230000,.*\}sofia\/gateway\/telnyx\/\+15550007777$/);
  assert.ok(unavailable.some((item) => item.data === 'vocivo_stage=unavailable'));

  const tooDeep = actions(renderSipDialplan(input({ pbx: config, request: request({ stage: 'after-ring', arg: 'e1', disposition: 'NO_ANSWER', depth: 2 }) })));
  assert.ok(tooDeep.some((item) => item.app === 'record'), 'forwarding depth is capped');

  const loop = actions(renderSipDialplan(input({ pbx: config, request: request({ stage: 'after-ring', arg: 'e1', disposition: 'NO_ANSWER', depth: 1, visited: ['e2', 'e1'] }) })));
  assert.ok(!loop.some((item) => item.app === 'bridge'), 'a visited extension is not rung again');
});

test('a user who disabled voicemail gets the unavailable message instead of a recording', () => {
  const config = pbx({ userProfiles: { e1: { outboundCallerId: '', did: '', twoFactorEnabled: false, noAnswerSeconds: 20, forwardBusy: '', forwardNoAnswer: '', forwardUnavailable: '', simultaneousRing: '', voicemailEnabled: false, voicemailEmail: false, voicemailTranscription: false, schedule: 'Always available', permissions: { international: false, transfer: false, video: false, recording: false, reports: false } } } });
  const list = actions(renderSipDialplan(input({ pbx: config, request: request({ stage: 'after-ring', arg: 'e1', disposition: 'NO_ANSWER' }) })));
  assert.ok(!list.some((item) => item.app === 'record'));
  assert.match(promptText(list[0].data), /^No one is available/);
});

test('when the voice menu is disabled the main line rings everyone and falls to voicemail', () => {
  const xml = renderSipDialplan(input({ business: business({ enabled: false }) }));
  assertWellFormed(xml);
  const list = actions(xml);
  assert.equal(list.find((item) => item.app === 'bridge')?.data, 'sofia/external/alice@127.0.0.1:5060:_:sofia/external/bob@127.0.0.1:5060');
  assert.ok(!list.some((item) => item.app === 'play_and_get_digits'));
  assert.deepEqual(stageTransfer(xml).stage, 'unavailable');
  const after = actions(renderSipDialplan(input({ request: request({ stage: 'unavailable', arg: 'business' }) })));
  assert.ok(after.some((item) => item.app === 'record'));
  const none = actions(renderSipDialplan(input({ request: request({ stage: 'unavailable', arg: 'none' }) })));
  assert.ok(!none.some((item) => item.app === 'record'));
});

test('every stage renders a well-formed document', () => {
  const stages: Array<Partial<XmlCurlRequest>> = [
    {}, { stage: 'ivr-select', digit: '1' }, { stage: 'ivr-select', digit: '9' }, { stage: 'ext-select', digit: '2001' },
    { stage: 'cfg-ivr-select', arg: 'ivr1', digit: '2' }, { stage: 'after-ring', arg: 'e1', disposition: 'NO_ANSWER' },
    { stage: 'after-group', arg: 'queue:q1' }, { stage: 'queue', arg: 'queue:q1', attempt: 1 }, { stage: 'unavailable' }, { stage: 'nonsense' },
  ];
  for (const overrides of stages) assertWellFormed(renderSipDialplan(input({ request: request(overrides) })));
});

test('an enabled receptionist answers at any hour, and its fallback follows the hours', () => {
  const withAi = pbx();
  withAi.ai = { ...withAi.ai, enabled: true };
  const open = actions(renderSipDialplan(input({ pbx: withAi })));
  assert.equal(open[0].app, 'answer');
  const socket = open.find((item) => item.app === 'socket');
  assert.ok(socket, 'the call is handed to the receptionist over the Event Socket');
  assert.equal(socket!.data, '127.0.0.1:8084 async full');
  assert.ok(open.some((item) => item.app === 'play_and_get_digits'), 'if the receptionist is down during the day the menu takes over');

  const closed = pbx();
  closed.ai = { ...closed.ai, enabled: true };
  closed.officeHours.weekdays.Wednesday = { enabled: false, start: '09:00', end: '17:00' };
  const afterHours = actions(renderSipDialplan(input({ pbx: closed })));
  assert.ok(afterHours.some((item) => item.app === 'socket'), 'after hours the receptionist still answers — it takes messages');
  assert.ok(!afterHours.some((item) => item.app === 'play_and_get_digits'), 'but a down receptionist falls to the closed message, not a menu nobody staffs');
  assert.ok(afterHours.some((item) => item.app === 'record' || item.app === 'hangup'));

  // A number pointed at a specific extension is a direct line and stays one.
  const direct = pbx({ numberAssignments: { [did]: { organizationId: 'acme', destinationType: 'extension', destinationId: 'e1' } } });
  direct.ai = { ...direct.ai, enabled: true };
  const rung = actions(renderSipDialplan(input({ pbx: direct })));
  assert.ok(!rung.some((item) => item.app === 'socket'));
  assert.equal(rung.find((item) => item.app === 'bridge')?.data, 'sofia/external/alice@127.0.0.1:5060');
});

test('a caller waiting for a person hears hold music, and a failed transfer from the receptionist goes back to it', () => {
  const ringing = renderSipDialplan(input({ request: request({ stage: 'ext-select', digit: '2001' }) }));
  assert.match(ringing, /hold_music=\/opt\/vocivo-fs\/sounds\/hold-music\.wav/);
  assert.match(ringing, /ringback=\/opt\/vocivo-fs\/sounds\/hold-music\.wav/);
  assert.doesNotMatch(ringing, /us-ring/);
  const withAi = pbx();
  withAi.ai = { ...withAi.ai, enabled: true };
  const back = renderSipDialplan(input({ pbx: withAi, request: request({ stage: 'after-ring', arg: 'e1', disposition: 'NO_ANSWER', fromReceptionist: true }) }));
  assert.match(back, /vocivo_transfer_failed=1/);
  assert.match(back, /application="socket"/);
  // Without the receptionist flag the old path stands.
  const plain = renderSipDialplan(input({ pbx: withAi, request: request({ stage: 'after-ring', arg: 'e1', disposition: 'NO_ANSWER' }) }));
  assert.doesNotMatch(plain, /vocivo_transfer_failed/);
});

test('external simultaneous ring and forwarding enforce the same outbound policy as app calls', () => {
  for (const stage of ['', 'after-ring']) {
    const config = pbx();
    config.numberAssignments[did].destinationType = 'extension';
    config.numberAssignments[did].destinationId = alice.id;
    config.userProfiles[alice.id] = { simultaneousRing: '+442079460018', forwardNoAnswer: '+442079460018', permissions: { international: false } } as never;
    const args = { pbx: config, trunkGateway: 'byoc_fixture', request: request({ stage, arg: alice.id, disposition: 'NO_ANSWER' }) };
    assert.doesNotMatch(renderSipDialplan(input(args)), /sofia\/gateway\//);
    config.userProfiles[alice.id].permissions.international = true;
    assert.match(renderSipDialplan(input(args)), /sofia\/gateway\/byoc_fixture\/\+442079460018/);
    config.outboundRules = [];
    assert.doesNotMatch(renderSipDialplan(input(args)), /sofia\/gateway\//);
  }
});
