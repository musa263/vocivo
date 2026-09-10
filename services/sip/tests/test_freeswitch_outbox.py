import base64
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from urllib.parse import urlencode, parse_qs, urlsplit

FS = Path(__file__).resolve().parents[1] / 'freeswitch'
spec = importlib.util.spec_from_file_location('outbox', FS / 'outbox.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class DeliveryTests(unittest.TestCase):
    def test_hook_survives_worker_restart_and_only_deletes_after_acceptance(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = {**os.environ, 'VOCIVO_SIP_OUTBOX_DIR': str(root)}
            args = ['/bin/sh', str(FS / 'sip-hangup.sh'), 'fixture-route-123456', 'fixture-channel', '23']
            subprocess.run(args, env=env, check=True)
            subprocess.run(args, env=env, check=True)
            job = next((root / 'hangups').glob('*.json'))
            self.assertEqual(json.loads(job.read_text())['durationSeconds'], 23)
            self.assertEqual(len(list((root / 'hangups').glob('*.json'))), 1)
            calls = []
            def fail(*args):
                calls.append(args)
                raise OSError('fixture timeout')
            now = time.time() + 10
            module.Outbox('https://example.invalid', 'fixture', root, root/'cdr', root/'audio', fail).tick(now)
            self.assertTrue(job.exists())
            # A fresh worker has no in-memory knowledge of the previous attempt.
            worker = module.Outbox('https://example.invalid', 'fixture', root, root/'cdr', root/'audio', lambda *args: calls.append(args))
            worker.tick(now + 60)
            worker.tick(now + 120)
            self.assertFalse(job.exists())
            self.assertEqual(len(calls), 2)

    def test_cdr_and_voicemail_replay_retains_tenant_signed_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            audio = root/'recording.wav'
            audio.write_bytes(b'RIFF' + bytes(100))
            cdr = root/'fixture.cdr.json'
            cdr.write_text('{"variables":{"uuid":"fixture"}}')
            fields = {'org':'tenant-a', 'call':'call-a', 'from':'fixture', 'name':'Test', 'exp':'100'}
            secret = 'fixture-secret'
            payload = '\n'.join(['voicemail', *fields.values()])
            fields['sig'] = base64.urlsafe_b64encode(hmac.new((secret+':sip-dialplan').encode(), payload.encode(), hashlib.sha256).digest()).decode().rstrip('=')
            original = 'https://example.invalid/api/voice/sip-voicemail?' + urlencode(fields)
            subprocess.run(['/bin/sh', str(FS/'voicemail-hangup.sh'), original, str(audio)], env={**os.environ, 'VOCIVO_SIP_RECORDINGS_DIR':str(root)}, check=True)
            calls = []
            now = time.time() + 10
            worker = module.Outbox('https://example.invalid', secret, root/'spool', root, root, lambda *args: calls.append(args))
            worker.tick(now)
            self.assertEqual(len(calls), 2)
            self.assertFalse(cdr.exists())
            self.assertFalse(audio.exists())
            query = parse_qs(urlsplit(next(c[0] for c in calls if c[3]=='PUT')).query)
            self.assertEqual(query['org'], ['tenant-a'])
            self.assertEqual(query['call'], ['call-a'])
            self.assertGreater(int(query['exp'][0]), now)
            for invalid in [original.replace('example.invalid', 'other.invalid'), original.replace('tenant-a', 'tenant-b'), original+'&org=tenant-b']:
                with self.assertRaises(ValueError): module.upload_url(invalid, 'https://example.invalid', secret, now)

    def test_hook_rejects_shell_json_and_path_injection(self):
        with tempfile.TemporaryDirectory() as tmp:
            for route in ['../escape', 'fixture"injection', 'a'*81]:
                result = subprocess.run(['/bin/sh', str(FS/'sip-hangup.sh'), route, 'fixture', '1'], env={**os.environ,'VOCIVO_SIP_OUTBOX_DIR':tmp})
                self.assertNotEqual(result.returncode, 0)
            self.assertEqual(list(Path(tmp).iterdir()), [])

if __name__ == '__main__': unittest.main()
