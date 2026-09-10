import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('prepare_release', Path(__file__).resolve().parents[1] / 'ops/prepare_release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleasePreparation(unittest.TestCase):
    def exercise(self, active=0, copy_failure=False):
        calls = []
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / 'sip'; target.mkdir()
            staged = Path(root) / 'staged'; staged.mkdir()
            def run(*args):
                args = tuple(map(str, args)); calls.append(args)
                if args[-3:] == ('ps', '-q', 'freeswitch'): return 'fs'
                if args[-3:] == ('ps', '-q', 'kamailio'): return 'kam'
                if args[:2] == ('docker', 'inspect'): return json.dumps([{'Config': {'Labels': {'com.docker.compose.project': 'sip'}}, 'Mounts': []}])
                if args[-3:] == ('config', '--format', 'json'):
                    return json.dumps({'services': {'sip-outbox': {'image': 'isolated-fixture'}}, 'volumes': {k: {'name': 'sip_'+k} for k in ['freeswitch-cdr','freeswitch-data']}})
                if args[-1] == 'show channels as json': return json.dumps({'row_count': active})
                if args[-1] == 'dialog:active_dialogs': return 'dialog:active_dialogs = 0'
                if args[:2] == ('docker', 'cp'):
                    if copy_failure: raise RuntimeError('copy failed')
                    Path(args[-1], 'pending').write_text('retained')
                return ''
            with patch.object(release, 'media_idle'), patch.object(release, 'run', side_effect=run), patch.object(release.subprocess, 'run') as exists, patch('sys.argv', ['prepare', '--target', str(target), '--staged', str(staged)]):
                exists.return_value.returncode = 0
                if active or copy_failure:
                    with self.assertRaises(RuntimeError): release.main()
                else:
                    release.main()
                    backup = next((Path(root)/'sip-state-backups').iterdir())
                    self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
                    self.assertEqual((backup/'freeswitch-data/pending').read_text(), 'retained')
        return calls

    def test_active_calls_prevent_stop_or_copy(self):
        calls = self.exercise(active=1)
        self.assertFalse(any('stop' in args or 'cp' in args for args in calls))

    def test_copy_failure_restarts_existing_stack(self):
        calls = self.exercise(copy_failure=True)
        self.assertTrue(any(args[-3:] == ('start', 'freeswitch', 'kamailio') for args in calls))
        self.assertFalse(any(args[:3] == ('docker', 'volume', 'create') for args in calls))

    def test_idle_stack_preserves_private_backup_before_volume_copy(self):
        calls = self.exercise()
        stop = next(i for i,args in enumerate(calls) if args[-2:] == ('stop','freeswitch'))
        copy = next(i for i,args in enumerate(calls) if args[:2] == ('docker','cp'))
        self.assertLess(stop,copy)
        self.assertFalse(any('start' in args for args in calls))
