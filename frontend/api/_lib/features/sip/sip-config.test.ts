import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Structural regression guard only; deployment still needs Kamailio's parser
// and wire-level tests with an untrusted source and an allowlisted carrier.
test('public SIP extension lookup and push require an allowlisted trunk source', () => {
  const config = readFileSync(new URL('../../../../../services/sip/kamailio/kamailio.cfg', import.meta.url), 'utf8');
  const start = config.indexOf('if ($Rp != 8080 && $si != "127.0.0.1")');
  const end = config.indexOf('# Wake the iPhone, then fork', start);
  assert.ok(start > -1 && end > start);
  const publicIngress = config.slice(start, end);
  assert.match(publicIngress, /route\(TRUNK_SOURCE\);\s*if \(\$var\(from_trunk\) != 1 \|\| \$env\(VOCIVO_SIP_INBOUND\) != "1"\) \{\s*sl_send_reply\("403", "Forbidden"\);\s*exit;\s*\}/);
  const guard = publicIngress.indexOf('route(TRUNK_SOURCE)');
  assert.ok(guard < publicIngress.indexOf('route(DELIVER_EXTENSION)'));
});

test('late REGISTER appends to a bounded transaction, never an eight-second poll', () => {
  const config = readFileSync(new URL('../../../../../services/sip/kamailio/kamailio.cfg', import.meta.url), 'utf8');
  assert.match(config, /ts_append_by_contact\("location", "\$var\(reg_aor\)"\)/);
  const delivery = config.slice(config.indexOf('route[DELIVER_EXTENSION]'), config.indexOf('route[CDR_ENQUEUE]'));
  assert.match(delivery, /t_set_max_lifetime\(45000, 45000\)/);
  assert.match(delivery, /if \(lookup\("location"\)\) \{\s*route\(DELIVER_REGISTERED\);/);
  assert.match(delivery, /t_continue\("\$var\(resume_index\)", "\$var\(resume_label\)", "DELIVER_WAKE"\)/);
  assert.ok(config.indexOf('route(RESUME_WAKE);') < config.indexOf('ts_append_by_contact('));
  const resumed = delivery.slice(delivery.indexOf('route[DELIVER_WAKE]'), delivery.indexOf('route[DELIVER_REGISTERED]'));
  assert.match(resumed, /if \(t_is_canceled\(\)\) exit;/);
  assert.doesNotMatch(resumed, /rtpengine_manage\(/);
  assert.doesNotMatch(config, /WAIT_REGISTER|async_route\("WAKEUP",\s*"8"\)/);
});

test('WebRTC media uses supported RTCP multiplexing flags on offers and answers', () => {
  const config = readFileSync(new URL('../../../../../services/sip/kamailio/kamailio.cfg', import.meta.url), 'utf8');
  assert.doesNotMatch(config, /RTCP-MUX/);
  const webRtcRules = config.split('\n').filter(line => line.includes('ICE=force'));
  assert.equal(webRtcRules.length, 1);
  for (const rule of webRtcRules) assert.match(rule, /rtcp-mux-offer rtcp-mux-require UDP\/TLS\/RTP\/SAVPF/);
});

test('known dialog routing precedes initial INVITE and conferences fail closed', () => {
  const config = readFileSync(new URL('../../../../../services/sip/kamailio/kamailio.cfg', import.meta.url), 'utf8');
  assert.ok(config.indexOf('if (has_totag())') < config.indexOf('route(INVITE)'));
  // Unknown dialogs fail closed; existing calls must be drained at rollout.
  assert.match(config, /if \(!loose_route\(\)\)/);
  assert.match(config, /if \(!is_known_dlg\(\)\)/);
  assert.match(config, /if \(\$rp == "5080"\)/);
  assert.match(config, /sl_send_reply\("403", "Conference admission required"\)/);
  const xml = readFileSync(new URL('../../../../../services/sip/freeswitch/dialplan/public.xml', import.meta.url), 'utf8');
  assert.doesNotMatch(xml, /application="conference"/);
});

test('REGISTER challenges reset per-request state and carry verified stale recovery', () => {
  const config = readFileSync(new URL('../../../../../services/sip/kamailio/kamailio.cfg', import.meta.url), 'utf8');
  const register = config.slice(config.indexOf('route[REGISTER]'), config.indexOf('route[CHALLENGE]'));
  assert.ok(register.indexOf('$var(auth_stale) = 0;') < register.indexOf('route(AUTH)'));
  const auth = config.slice(config.indexOf('route[AUTH]'), config.indexOf('route[UNTRUST_ROUTING]'));
  assert.match(auth, /jansson_get\("stale", "\$var\(res\)", "\$var\(auth_stale\)"\)/);
  const challenge = config.slice(config.indexOf('route[CHALLENGE]'), config.indexOf('route[AUTH]'));
  assert.ok(challenge.indexOf('$var(nonce) = "";') < challenge.indexOf('jansson_get("nonce"'));
  assert.match(challenge, /stale=true/);
});
