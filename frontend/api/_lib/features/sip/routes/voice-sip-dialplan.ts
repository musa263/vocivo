import type { VercelRequest, VercelResponse } from '@vercel/node';
import { methodNotAllowed, publicError, requiredEnv } from '../../../shared/http.js';
import { readBusinessVoiceConfig } from '../../numbers/number-config.js';
import { listExtensions } from '../../organizations/pbx.js';
import { pbxForOrganization, readPbxConfig } from '../../organizations/pbx-config-store.js';
import { isLocalOrigination, parseXmlCurlRequest, renderSipDialplan, xmlCurlNotFound } from '../sip-dialplan.js';
import { sipEdgeAuthorized } from '../sip-edge-auth.js';
import { normalizeE164 } from '../../organizations/tenancy.js';
import { sipInboundEnabled } from '../../calling/voice-provider.js';
import { carrierTrunks } from '../../numbers/carrier-trunk-store.js';
import { carrierReadiness, resolveInboundNumber, resolveCarrierOutbound } from '../../numbers/carrier-runtime.js';
import { outboundUnavailable, renderSipOutbound } from '../sip-outbound-dialplan.js';
import { agentStore } from '../../operations/agent-store.js';

/**
 * mod_xml_curl dialplan binding for the self-hosted SIP edge.
 *
 * FreeSWITCH POSTs the call's channel variables here at every routing step
 * (initial INVITE and each `transfer`). A "not found" document hands the call
 * back to the static dialplan on the droplet, which is also what happens while
 * VOCIVO_SIP_INBOUND is off, so enabling this route changes nothing until the
 * operator flips that flag on both sides.
 */

function sendXml(res: VercelResponse, xml: string) {
  res.setHeader('Content-Type', 'text/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(xml);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!sipEdgeAuthorized(req)) return res.status(401).json({ error: 'SIP edge authentication failed.' });
  try {
    const request = parseXmlCurlRequest(req.body);
    if (request.section !== 'dialplan') return sendXml(res, xmlCurlNotFound());
    const config = await readPbxConfig();
    if (request.vocivoFlowHeader === 'outbound') {
      try { return sendXml(res, await renderSipOutbound(request, config)); }
      catch { return sendXml(res, outboundUnavailable()); }
    }
    if (!sipInboundEnabled() || isLocalOrigination(request)) return sendXml(res, xmlCurlNotFound());
    let organizationId: string;
    let did: string;
    if (request.stage) {
      organizationId = request.organizationId;
      did = normalizeE164(request.did);
      if (!organizationId || !config.organizations.some((item) => item.id === organizationId)) return sendXml(res, xmlCurlNotFound());
    } else {
      did = resolveInboundNumber(config, request.destinationNumber, request.carrierSourceIp || '');
      const assignment = config.numberAssignments[did];
      if (!assignment?.organizationId || assignment.disabled) return sendXml(res, xmlCurlNotFound());
      organizationId = assignment.organizationId;
    }
    const organization = config.organizations.find((item) => item.id === organizationId);
    if (!organization || organization.status !== 'active') return sendXml(res, xmlCurlNotFound());
    const assignment = config.numberAssignments[did];
    if (!assignment || assignment.disabled || assignment.organizationId !== organizationId) return sendXml(res, xmlCurlNotFound());
    let trunkGateway = 'telnyx';
    let carrierCapacity: { gateway: string; limit: number } | undefined;
    if (assignment.source === 'carrier') {
      const trunk = (await carrierTrunks.list(organizationId)).find(item => item.id === assignment.carrierTrunkId);
      if (!trunk || trunk.revision !== assignment.carrierTrunkRevision || trunk.inboundEnabled !== true || !assignment.destinationType
        || !carrierReadiness(trunk).deployment) return sendXml(res, xmlCurlNotFound());
      if (!trunk.channelLimit) return sendXml(res, xmlCurlNotFound());
      carrierCapacity = { gateway: carrierReadiness(trunk).deployment!.gateway, limit: trunk.channelLimit };
      // Outbound forwarding must never fall back to the platform carrier.
      try { trunkGateway = (await resolveCarrierOutbound(config, organizationId, did))!.gateway; }
      catch { trunkGateway = 'byoc_unavailable'; }
    }

    const [business, extensions] = await Promise.all([
      readBusinessVoiceConfig(organizationId),
      listExtensions(organizationId),
    ]);
    const queueMembers = new Set(pbxForOrganization(config, organizationId).callHandling.queues.flatMap(q => q.members));
    const agents = queueMembers.size ? await agentStore.read(organizationId, extensions.filter(e => queueMembers.has(e.id)).map(e => e.id)) : [];
    const xml = renderSipDialplan({
      request,
      organizationId,
      did,
      pbx: pbxForOrganization(config, organizationId),
      business,
      extensions,
      queueBreakExtensionIds: agents.filter(a => a.state === 'on_break').map(a => a.extensionId),
      apiUrl: requiredEnv('VITE_APP_URL'),
      secret: requiredEnv('SIP_EDGE_SECRET'),
      promptFormat: process.env.TTS_SERVICE_URL?.trim() ? 'wav' : 'mp3',
      recordingsDir: process.env.VOCIVO_SIP_RECORDINGS_DIR?.trim() || '/var/lib/vocivo/recordings',
      trunkGateway,
      carrierCapacity,
      now: new Date(),
    });
    return sendXml(res, xml);
  } catch (error) {
    // A non-200 makes mod_xml_curl fall through to the static dialplan, which
    // still answers with the "inbound stays on Call Control" hold behaviour.
    return res.status(500).json({ error: publicError(error) });
  }
}
