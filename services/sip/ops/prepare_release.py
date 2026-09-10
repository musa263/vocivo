#!/usr/bin/env python3
"""Quiesce an idle SIP stack and preserve container-local state before recreation."""
import argparse
import json
from pathlib import Path
import socket
import uuid
import subprocess
import time


def run(*args):
    return subprocess.run(list(map(str, args)), check=True, capture_output=True, text=True).stdout


def media_idle():
    # The deployed edge predates a Kamailio RPC socket. RTPEngine anchors both
    # internal and PBX calls, so require an empty NG session list as well as
    # zero PBX channels. An unknown/malformed answer must stop the release.
    cookie = uuid.uuid4().hex.encode()
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
        client.settimeout(3)
        client.connect(('127.0.0.1', 2223))
        client.send(cookie + b' d7:command4:list5:limiti1ee')
        response = client.recv(65535)
    received, body = response.split(b' ', 1)
    if received != cookie:
        raise RuntimeError('Media control response did not match release check')
    pos = 0
    def decode():
        nonlocal pos
        marker = body[pos:pos+1]
        if marker == b'i':
            end = body.index(b'e', pos); value = int(body[pos+1:end]); pos = end+1; return value
        if marker in (b'l', b'd'):
            pos += 1; values = []
            while body[pos:pos+1] != b'e': values.append(decode())
            pos += 1
            return dict(zip(values[::2], values[1::2])) if marker == b'd' else values
        end = body.index(b':', pos); length = int(body[pos:end]); pos = end+1
        value = body[pos:pos+length]; pos += length; return value
    payload = decode()
    if pos != len(body) or payload.get(b'result') != b'ok' or payload.get(b'calls') != []:
        raise RuntimeError('Media sessions are active or could not be counted; release deferred')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--target', required=True)
    parser.add_argument('--staged', required=True)
    args = parser.parse_args()
    target, staged = Path(args.target).resolve(), Path(args.staged).resolve()
    compose = ['docker', 'compose', '--project-directory', str(target)]
    fs = run(*compose, 'ps', '-q', 'freeswitch').strip()
    kam = run(*compose, 'ps', '-q', 'kamailio').strip()
    if not fs or not kam:
        raise RuntimeError('Both existing SIP services must be running before migration')
    info = json.loads(run('docker', 'inspect', fs))[0]
    project = info['Config']['Labels']['com.docker.compose.project']
    config = json.loads(run('docker', 'compose', '-p', project, '--project-directory', staged, 'config', '--format', 'json'))
    image = config['services']['sip-outbox']['image']
    run('docker', 'pull', image)  # Network failures must happen before stopping service.

    def assert_idle():
        channels = json.loads(run('docker', 'exec', fs, 'fs_cli', '-x', 'show channels as json'))
        if channels.get('row_count') != 0:
            raise RuntimeError('Active FreeSWITCH channels: retry after calls finish')
        media_idle()

    assert_idle()
    stopped = False
    try:
        run(*compose, 'stop', 'kamailio')
        stopped = True
        # An INVITE might have arrived during the idle check. Do not terminate it.
        channels = json.loads(run('docker', 'exec', fs, 'fs_cli', '-x', 'show channels as json'))
        if channels.get('row_count') != 0:
            raise RuntimeError('A call arrived during the release check; release deferred')
        exists = {path: subprocess.run(['docker', 'exec', fs, 'test', '-d', path], capture_output=True).returncode == 0
                  for path in ['/var/log/freeswitch/json_cdr', '/var/lib/vocivo']}
        media_idle()
        run(*compose, 'stop', 'freeswitch')
        backup = target.parent / 'sip-state-backups' / str(time.time_ns())
        backup.mkdir(parents=True, mode=0o700)
        for path, key in [('/var/log/freeswitch/json_cdr', 'freeswitch-cdr'), ('/var/lib/vocivo', 'freeswitch-data')]:
            dest = backup / key
            dest.mkdir(mode=0o700)
            if exists[path]:
                run('docker', 'cp', f'{fs}:{path}/.', dest)
            # Already-persistent paths stay in their original volume. Preserve
            # the private backup anyway; never reintroduce already delivered jobs.
            mounted = next((mount for mount in info['Mounts'] if mount['Destination'] == path), None)
            volume = config['volumes'][key]['name']
            if mounted:
                if mounted.get('Type') != 'volume' or mounted.get('Name') != volume:
                    raise RuntimeError('Existing state mount differs from target volume; manual migration required')
                continue
            run('docker', 'volume', 'create', volume)
            run('docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                '-v', f'{dest}:/source:ro', '-v', f'{volume}:/destination', image, 'python3', '-c',
                'import pathlib, shutil; s=pathlib.Path("/source"); d=pathlib.Path("/destination"); '
                'assert not any(d.iterdir()), "Destination volume is not empty; reconcile before retry"; '
                'shutil.copytree(s,d,dirs_exist_ok=True,symlinks=True)')
        print(f'Idle SIP stack stopped; private state backup: {backup}')
        print('Existing .failed recordings retained; legacy uploads require reconciliation, never deletion.')
    except BaseException:
        if stopped:
            run(*compose, 'start', 'freeswitch', 'kamailio')
        raise


if __name__ == '__main__':
    main()
