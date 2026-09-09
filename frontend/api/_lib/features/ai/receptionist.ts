import type { ExtensionUser } from '../organizations/pbx.js';
import { isRecommendedVoice, vocivoVoices, voiceDefinition, voiceGradeRank } from './voice-catalog.js';
import type { PbxConfig } from '../organizations/pbx-config-store.js';
import { normalizeE164 } from '../organizations/tenancy.js';
import { officeHoursDecision } from '../organizations/office-hours.js';
import { seedTenantKnowledge } from './company-knowledge/seed-tenant-knowledge.js';

/**
 * The control plane for Vocivo's own AI receptionist.
 *
 * The receptionist itself runs on the SIP edge — FreeSWITCH for the call,
 * faster-whisper for what the caller said, Kokoro for what it says back. This
 * module answers the only two questions that service asks of the API: which
 * receptionist answers for the number that was dialled, and here is what
 * happened on the call.
 *
 * Nothing here talks to a carrier. The equivalent Telnyx path sent the
 * assistant's definition, the caller's audio and the transcript to Telnyx, and
 * billed per minute of it.
 */

export type ReceptionistTarget = { extension: string; label: string };

export type ReceptionistProfile = {
  enabled: boolean;
  organizationId: string;
  name: string;
  greeting: string;
  instructions: string;
  voice: string;
  language: string;
  transferEnabled: boolean;
  fallbackExtension: string;
  targets: ReceptionistTarget[];
  /** Whether the business is open right now: closed, the receptionist takes messages rather than transferring. */
  officeOpen: boolean;
  officeHoursText: string;
  timezone: string;
};

export type ReceptionistOutcome =
  | 'completed'
  | 'transferred'
  | 'message_taken'
  | 'caller_hung_up'
  | 'caller_went_quiet'
  | 'no_speech'
  | 'turn_limit'
  | 'error';

export type ReceptionistConversation = {
  callId: string;
  number: string;
  caller: string;
  outcome: ReceptionistOutcome;
  transferredTo: string;
  seconds: number;
  transcript: string;
  note: string;
};

const outcomes: ReceptionistOutcome[] = [
  'completed', 'transferred', 'message_taken', 'caller_hung_up', 'caller_went_quiet', 'no_speech', 'turn_limit', 'error',
];

/**
 * Kokoro's voices, keyed by the name stored on the tenant's assistant.
 *
 * Existing tenants carry carrier voice names such as `Telnyx.Bayan.Amanda`,
 * chosen before there was anywhere else for them to come from. Rather than
 * migrate every record, those names map onto the nearest self-hosted voice —
 * so switching the edge over does not silently mute a receptionist.
 */
const voiceAliases: Record<string, string> = {
  'Telnyx.KokoroTTS.af': 'af_heart',
  'Telnyx.Bayan.Amanda': 'af_heart',
  'Telnyx.Bayan.Bella': 'af_bella',
  'Telnyx.Bayan.Adam': 'am_adam',
  'Telnyx.Bayan.Michael': 'am_michael',
};

const kokoroVoiceIds = new Set(vocivoVoices.map((voice) => voice.sourceVoice));

/**
 * What the receptionist says besides the greeting and the model's answers.
 * Mirrors CANNED and FILLERS in services/receptionist/app/speech.py, so the
 * API can have them rendered in the tenant's voice the moment the receptionist
 * is saved, rather than the first caller waiting for each of them.
 */
export const receptionistPhrases = [
  "Sorry, I didn't catch that. Are you still there?",
  "Let me put you through to someone who can help.",
  "I'll let the team know you called. Bye for now.",
  "Sorry about that — no one's picking up right now. I can take a message and have someone call you back, or is there anything else I can help with?",
  "Take your time. I'm here if you need anything else.",
  "I'll let you go now. Thanks for calling — goodbye.",
  "Mm-hm, one moment.",
  "Right, let me check.",
  "Okay, one second.",
  "Let me see.",
];

/**
 * The Kokoro voice id the speech engine wants, from whatever the tenant's
 * record holds: a catalog id (`Vocivo.Kokoro.AmAdam`), the engine's own id,
 * the carrier's copy of a Kokoro voice, or one of the old carrier voices.
 * Anything else falls back to the default voice rather than to silence.
 */
export function receptionistVoice(stored: string): string {
  const trimmed = (stored || '').trim();
  let source = '';
  if (kokoroVoiceIds.has(trimmed)) source = trimmed;
  else {
    const catalog = voiceDefinition(trimmed);
    if (catalog) source = catalog.sourceVoice;
    else {
      const carrierCopy = /^Telnyx\.KokoroTTS\.([a-z]{2}_[a-z]+)$/.exec(trimmed);
      source = carrierCopy && kokoroVoiceIds.has(carrierCopy[1]) ? carrierCopy[1] : voiceAliases[trimmed] || 'af_heart';
    }
  }
  return spokenVoice(source);
}

/**
 * The voice that actually answers. A voice the engine's own authors grade
 * below B- is recognisably a machine on a phone line — the first receptionist
 * went live on Adam, graded F+, and callers said so. Those are answered by
 * the best-graded voice in the same language instead; the admin's choice is
 * kept in the config and honoured again the day the engine improves it.
 */
export function spokenVoice(sourceVoice: string): string {
  const chosen = vocivoVoices.find((voice) => voice.sourceVoice === sourceVoice);
  if (!chosen || isRecommendedVoice(chosen.quality)) return sourceVoice;
  const better = vocivoVoices
    .filter((voice) => voice.language === chosen.language && isRecommendedVoice(voice.quality))
    .sort((a, b) => voiceGradeRank(a.quality) - voiceGradeRank(b.quality))[0];
  return better ? better.sourceVoice : sourceVoice;
}

/**
 * Who the receptionist may put a caller through to.
 *
 * Only active extensions with a SIP username: an extension nobody can answer
 * is worse than no transfer at all, because the caller has already been told
 * they are being put through.
 */
export function transferTargets(extensions: ExtensionUser[]): ReceptionistTarget[] {
  return extensions
    .filter((entry) => entry.status === 'active' && entry.sipUsername?.trim() && /^\d{2,5}$/.test(String(entry.extension)))
    .map((entry) => ({
      extension: String(entry.extension),
      label: (entry.name || '').trim() || entry.email || String(entry.extension),
    }));
}

export type ProfileInput = {
  number: string;
  config: PbxConfig;
  /** Organization-scoped view, as `pbxForOrganization` returns it. */
  tenantFor: (organizationId: string) => PbxConfig;
  extensionsFor: (organizationId: string) => Promise<ExtensionUser[]>;
  /** One-time migration of a shipped company brief into the tenant's own settings. Omitted in tests. */
  seedKnowledge?: (organizationId: string) => Promise<string>;
  now?: Date;
};

/**
 * Resolves the dialled number to a receptionist, or to nothing.
 *
 * Returning null is a normal answer and the edge releases the call: a number
 * with no receptionist should never have been routed here, and answering it
 * with some other tenant's assistant would be worse than a busy tone.
 */
export async function receptionistFor(input: ProfileInput): Promise<ReceptionistProfile | null> {
  const did = normalizeE164(input.number);
  const assignment = input.config.numberAssignments[did];
  if (!assignment?.organizationId) return null;

  const tenant = input.tenantFor(assignment.organizationId);
  const ai = tenant.ai;
  if (!ai?.enabled) return null;

  const extensions = await input.extensionsFor(assignment.organizationId);
  // A brief that used to be compiled into the platform moves into this tenant's
  // own knowledge box the first time their receptionist answers, so their
  // administrator can edit it. Anything already typed there wins, and once the
  // move has happened an empty box stays empty.
  const knowledge = ai.knowledge?.trim() || (input.seedKnowledge ? await input.seedKnowledge(assignment.organizationId) : '');
  // Nobody is at their desk after hours: the receptionist answers, but it
  // takes messages instead of putting callers through to an empty office.
  const officeOpen = officeHoursDecision(tenant.officeHours, input.now || new Date()).open;
  const targets = ai.transferEnabled && officeOpen ? transferTargets(extensions) : [];
  const fallback = ai.fallbackExtension && targets.some((target) => target.extension === ai.fallbackExtension)
    ? ai.fallbackExtension
    : '';

  return {
    enabled: true,
    organizationId: assignment.organizationId,
    name: ai.name,
    greeting: ai.greeting,
    // The knowledge base is part of the brief, not a separate retrieval step:
    // a receptionist's worth of company facts fits in a prompt.
    instructions: [ai.instructions, knowledge].filter((part) => part && part.trim()).join('\n\n'),
    voice: receptionistVoice(ai.voice),
    language: ai.language || 'en',
    transferEnabled: Boolean(ai.transferEnabled) && targets.length > 0,
    fallbackExtension: fallback,
    targets,
    officeOpen,
    // The one question every receptionist gets: when are you open. Spoken
    // form, so the model reads it out as-is instead of guessing.
    officeHoursText: describeOfficeHours(tenant.officeHours),
    timezone: tenant.officeHours.timezone,
  };
}

const spokenDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function spokenClock(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return value;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const suffix = hours >= 12 ? 'pm' : 'am';
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return minutes ? `${twelve}:${match[2]} ${suffix}` : `${twelve} ${suffix}`;
}

/** "Monday to Friday, 9 am to 5 pm; Saturday, 10 am to 2 pm. Closed Sunday." */
export function describeOfficeHours(hours: PbxConfig['officeHours']) {
  const runs: Array<{ days: string[]; span: string }> = [];
  const closed: string[] = [];
  for (const day of spokenDays) {
    const entry = hours.weekdays[day];
    if (!entry?.enabled) { closed.push(day); continue; }
    const allDay = entry.start === '00:00' && ['23:59', '24:00'].includes(entry.end);
    const span = allDay ? 'all day' : `${spokenClock(entry.start)} to ${spokenClock(entry.end)}`;
    const last = runs[runs.length - 1];
    if (last && last.span === span && spokenDays.indexOf(last.days[last.days.length - 1]) === spokenDays.indexOf(day) - 1) last.days.push(day);
    else runs.push({ days: [day], span });
  }
  if (!runs.length) return 'Closed every day.';
  const parts = runs.map((run) => `${run.days.length > 2 ? `${run.days[0]} to ${run.days[run.days.length - 1]}` : run.days.join(' and ')}, ${run.span}`);
  const closedText = closed.length ? ` Closed ${closed.length > 2 && spokenDays.indexOf(closed[closed.length - 1]) - spokenDays.indexOf(closed[0]) === closed.length - 1 ? `${closed[0]} to ${closed[closed.length - 1]}` : closed.join(' and ')}.` : '';
  return `${parts.join('; ')}.${closedText}`;
}

/** Validates what the edge reports about a finished call before it is stored. */
export function parseConversation(body: unknown): ReceptionistConversation | null {
  const source = body && typeof body === 'object' ? body as Record<string, unknown> : null;
  if (!source) return null;
  const callId = typeof source.callId === 'string' ? source.callId.trim() : '';
  if (!callId) return null;
  const outcome = typeof source.outcome === 'string' && (outcomes as string[]).includes(source.outcome)
    ? source.outcome as ReceptionistOutcome
    : 'error';
  const seconds = Number(source.seconds);
  return {
    callId: callId.slice(0, 128),
    number: typeof source.number === 'string' ? normalizeE164(source.number) : '',
    caller: typeof source.caller === 'string' ? source.caller.slice(0, 64) : '',
    outcome,
    transferredTo: typeof source.transferredTo === 'string' ? source.transferredTo.slice(0, 16) : '',
    seconds: Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 10) / 10 : 0,
    // A transcript is a record of a real conversation, so it is bounded rather
    // than trusted: the edge is ours, but the caller's words are not.
    transcript: typeof source.transcript === 'string' ? source.transcript.slice(0, 20_000) : '',
    note: typeof source.note === 'string' ? source.note.slice(0, 2_000) : '',
  };
}
