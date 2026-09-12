import type { VercelRequest, VercelResponse } from '@vercel/node';
import cancel from './_lib/features/calling/routes/voice-cancel.js';
import progress from './_lib/features/calling/routes/voice-progress.js';
import conferences from './_lib/features/calling/routes/voice-conferences.js';
import config from './_lib/features/calling/routes/voice-config.js';
import devices from './_lib/features/push/routes/voice-devices.js';
import directory from './_lib/features/organizations/routes/voice-directory.js';
import history from './_lib/features/calling/routes/voice-history.js';
import merge from './_lib/features/calling/routes/voice-merge.js';
import route from './_lib/features/calling/routes/voice-route.js';
import settings from './_lib/features/organizations/routes/voice-settings.js';
import status from './_lib/features/calling/routes/voice-status.js';
import transfer from './_lib/features/calling/routes/voice-transfer.js';
import video from './_lib/features/video/routes/voice-video.js';
import voicemails from './_lib/features/calling/routes/voice-voicemails.js';
import webhook from './_lib/features/calling/routes/voice-webhook.js';
import webPush from './_lib/features/push/routes/voice-web-push.js';
import aiTransfer from './_lib/features/ai/routes/voice-ai-transfer.js';
import sipAuth from './_lib/features/sip/routes/voice-sip-auth.js';
import sipCredentials from './_lib/features/sip/routes/voice-sip-credentials.js';
import receptionist from './_lib/features/ai/routes/voice-receptionist.js';
import sipInbound from './_lib/features/sip/routes/voice-sip-inbound.js';
import sipWakeup from './_lib/features/sip/routes/voice-sip-wakeup.js';
import sipNonce from './_lib/features/sip/routes/voice-sip-nonce.js';
import sipDialplan from './_lib/features/sip/routes/voice-sip-dialplan.js';
import sipCdr from './_lib/features/sip/routes/voice-sip-cdr.js';
import sipPrompt from './_lib/features/sip/routes/voice-sip-prompt.js';
import sipVoicemail from './_lib/features/sip/routes/voice-sip-voicemail.js';
import sipHangup from './_lib/features/sip/routes/voice-sip-hangup.js';
import preferences from './_lib/features/calling/routes/voice-preferences.js';
import presence from './_lib/features/calling/routes/voice-presence.js';
import meetings from './_lib/features/meetings/routes/voice-meetings.js';
import telemetry from './_lib/features/operations/routes/voice-telemetry.js';

type VoiceHandler = (req: VercelRequest, res: VercelResponse) => unknown;

const routes: Readonly<Record<string, VoiceHandler>> = Object.freeze({
  cancel,
  progress,
  conferences,
  config,
  devices,
  directory,
  history,
  merge,
  route,
  settings,
  status,
  transfer,
  video,
  voicemails,
  webhook,
  'ai-transfer': aiTransfer,
  'web-push': webPush,
  'sip-auth': sipAuth,
  'sip-credentials': sipCredentials,
  receptionist,
  'sip-inbound': sipInbound,
  'sip-wakeup': sipWakeup,
  'sip-nonce': sipNonce,
  'sip-dialplan': sipDialplan,
  'sip-cdr': sipCdr,
  'sip-prompt': sipPrompt,
  'sip-voicemail': sipVoicemail,
  'sip-hangup': sipHangup,
  preferences,
  presence,
  meetings,
  telemetry,
});

export default function handler(req: VercelRequest, res: VercelResponse) {
  const resource = Array.isArray(req.query.resource)
    ? req.query.resource[0]
    : req.query.resource;
  // Own keys only: `routes['toString']` resolves Object.prototype.toString,
  // a function that writes no response, and the invocation ran to its
  // 30-second ceiling for anyone who asked.
  const voiceHandler = resource && Object.prototype.hasOwnProperty.call(routes, resource) ? routes[resource as keyof typeof routes] : undefined;

  if (!voiceHandler) {
    return res.status(404).json({ error: 'Voice resource not found' });
  }

  return voiceHandler(req, res);
}
