import { resolveCarrierOutbound } from '../numbers/carrier-runtime.js';
import { type PbxConfig } from '../organizations/pbx-config-store.js';
import { verifyVoiceRouteToken } from '../calling/voice-route-token.js';
import { authorizeSipCall } from './sip-call-authorization.js';
import { type XmlCurlRequest } from './sip-dialplan.js';

const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const action = (app: string, value: string) => `<action application="${app}" data="${xml(value)}"/>`;
// Both the session executor and mod_dptools set expand variables. Preserve
// the reference through both passes so the hangup hook sees final timestamps.
const atHangup = (name: 'uuid' | 'billsec') => '\\'.repeat(3) + '${' + name + '}';
// FreeSWITCH's line-oriented preprocessor skips the XML declaration line.
// Keep it separate from the document or a valid one-line XML becomes empty.
const document = (actions: string[]) => `<?xml version="1.0" encoding="UTF-8"?>\n<document type="freeswitch/xml"><section name="dialplan"><context name="public"><extension name="vocivo-authorized-outbound"><condition>${actions.join('\n')}</condition></extension></context></section></document>\n`;
export const outboundUnavailable = () => document([action('respond', '503 Call route unavailable'), action('hangup', 'CALL_REJECTED')]);

/** Recheck current ownership at the bridge boundary, including previously issued grants. */
export async function renderSipOutbound(request: XmlCurlRequest, config: PbxConfig, resolve = resolveCarrierOutbound) {
  const token = request.routeToken || '';
  const grant = verifyVoiceRouteToken(token);
  const admitted = authorizeSipCall({ routeToken: token, requestUser: request.destinationNumber });
  if (!grant || !admitted || admitted.flow !== 'outbound' || request.vocivoFlowHeader !== 'outbound'
    || admitted.callerId !== request.vocivoCallerIdHeader
    || !config.organizations.some(item => item.id === admitted.organizationId && item.status === 'active')) return outboundUnavailable();
  const route = await resolve(config, admitted.organizationId, admitted.callerId);
  if ((grant.carrierGateway || '') !== (route?.gateway || '') || (grant.carrierTrunkId || '') !== (route?.trunkId || '')
    || (grant.carrierRevision || 0) !== (route?.revision || 0)) return outboundUnavailable();
  const gateway = route?.gateway || 'telnyx';
  // Each value is independently set: commas in the codec list cannot split the dial string.
  return document([
    action('set', 'hangup_after_bridge=true'),
    action('set', `vocivo_org=${admitted.organizationId.replace(/[^A-Za-z0-9_-]/g, '')}`),
    action('set', `effective_caller_id_number=${admitted.callerId}`),
    action('set', 'effective_caller_id_name=Vocivo'),
    action('set', 'sip_cid_type=pid'),
    // Set the carrier leg explicitly. Setting only the originating channel
    // leaves a browser's Opus-only negotiation on the new gateway channel.
    action('export', 'nolocal:absolute_codec_string=PCMU,PCMA,OPUS'),
    action('set', 'call_timeout=45'),
    action('set', 'session_in_hangup_hook=true'),
    action('set', `api_hangup_hook=system /bin/sh /opt/vocivo-fs/sip-hangup.sh ${admitted.routeId} ${atHangup('uuid')} ${atHangup('billsec')}`),
    ...(route ? [action('limit', `hash vocivo-carrier ${gateway} ${route.channelLimit} !NORMAL_CIRCUIT_CONGESTION`)] : []),
    action('bridge', `sofia/gateway/${gateway}/+${request.destinationNumber.replace(/^\+/, '')}`),
  ]);
}
