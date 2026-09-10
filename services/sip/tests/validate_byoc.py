#!/usr/bin/env python3
"""Generated production BYOC dialplans with isolated carrier/RTP peers."""
import os
from pathlib import Path
import subprocess
import tempfile
import uuid
from temporary_carrier_pbx import IMAGE

ROOT = Path(__file__).resolve().parents[3]
IMAGE = os.environ.get('VOCIVO_TEST_FS_IMAGE', IMAGE)


def run(*args, check=True, **kwargs):
    return subprocess.run(args, check=check, timeout=120, **kwargs)


def main():
    name = 'vocivo-byoc-validation-' + uuid.uuid4().hex[:8]
    with tempfile.TemporaryDirectory(prefix='vocivo-byoc-') as directory:
        root = Path(directory)
        conf, state = root / 'conf', root / 'state'
        for child in ('log', 'db', 'run'):
            (state / child).mkdir(parents=True)
        run('node', '--import', 'tsx', 'scripts/render-byoc-test.mjs', str(conf), cwd=ROOT / 'frontend')
        started = False
        try:
            run('docker', 'run', '-d', '--name', name, '--network', 'none', '--memory', '512m', '--pids-limit', '128',
                '-v', f'{conf}:/conf:ro', '-v', f'{state}:/state', '-v', f'{state}/outbox:/var/lib/vocivo/outbox',
                '-v', f'{ROOT / "services/sip/freeswitch"}:/opt/vocivo-fs:ro', '--entrypoint', '/usr/bin/freeswitch', IMAGE,
                '-nf', '-nonat', '-np', '-conf', '/conf', '-log', '/state/log', '-db', '/state/db',
                '-run', '/state/run', '-mod', '/usr/lib/freeswitch/mod', stdout=subprocess.DEVNULL)
            started = True
            run('docker', 'run', '--rm', '--network', 'container:' + name, '-v', f'{conf}:/fixtures:ro',
                '-v', f'{state}/outbox:/spool:ro',
                '-v', f'{ROOT / "services/sip/tests/byoc_wire.py"}:/test.py:ro', 'python:3.12-alpine', 'python', '/test.py')
        except subprocess.CalledProcessError:
            if started:
                run('docker', 'logs', '--tail', '50', name, check=False)
            raise
        finally:
            if started:
                if os.environ.get('VOCIVO_TEST_EVIDENCE_DIR'):
                    evidence = Path(os.environ['VOCIVO_TEST_EVIDENCE_DIR'])
                    evidence.mkdir(parents=True, exist_ok=True)
                    logs = subprocess.run(['docker', 'logs', name], capture_output=True, text=True, timeout=30)
                    (evidence / 'freeswitch.log').write_text(logs.stdout + logs.stderr)
                # Linux containers create the private outbox as root/0700.
                # Return only this isolated fixture tree to the runner before
                # TemporaryDirectory removes it; never relax production modes.
                run('docker', 'exec', name, 'chown', '-Rh', f'{os.getuid()}:{os.getgid()}', '/state', check=False, stdout=subprocess.DEVNULL)
                run('docker', 'rm', '-f', name, check=False, stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
