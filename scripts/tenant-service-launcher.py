#!/usr/bin/python3 -I
"""Root-owned service manager; commands run only through the tenant sandbox launcher."""
import fcntl
import json
import os
import pathlib
import re
import socket
import subprocess
import sys

CONFIG = pathlib.Path('/etc/dsh-tenant-services.json')


def trusted(path):
    """Require canonical root-owned deployment files, outside tenant mounts."""
    info = path.stat()
    if path.resolve(strict=True) != path or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError('untrusted service deployment path')
    return path


def invoke(args, *, text=None):
    result = subprocess.run(args, input=text, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=20, check=False,
                            env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
    if result.returncode:
        raise ValueError(result.stderr.strip()[-4000:] or 'service operation failed')
    return result.stdout


def atomic(path, content, mode=0o600):
    temporary = path.with_name(path.name + '.tmp')
    descriptor = os.open(temporary, os.O_CREAT | os.O_TRUNC | os.O_WRONLY | os.O_NOFOLLOW, mode)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, 'w', closefd=False) as stream:
            stream.write(content)
            stream.flush()
            os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)


def unit_name(owner, name):
    return 'dsh-dev-u' + owner + '-' + name + '.service'


def quote(value):
    # systemd expands percent specifiers even in quoted command arguments.
    return json.dumps(str(value).replace('%', '%%'), ensure_ascii=False)


def unit_text(config, owner, cwd, username, name, script):
    return '\n'.join([
        '[Unit]', 'Description=DSH account ' + owner + ' development service ' + name,
        'After=network-online.target ' + config['firewallUnit'],
        'Wants=network-online.target', 'Requires=' + config['firewallUnit'],
        'StartLimitIntervalSec=0', '', '[Service]', 'Type=simple',
        'ExecStart=' + ' '.join(quote(value) for value in [config['launcher'], owner, cwd, username, '--command']),
        'StandardInput=file:' + str(script), 'Restart=always',
        'RestartSec=' + str(config['restartSeconds']), 'KillMode=control-group',
        'TimeoutStopSec=10', '', '[Install]', 'WantedBy=multi-user.target', '',
    ])


def records(state):
    return [(path, json.loads(path.read_text())) for path in sorted(state.glob('u*/*/record.json'))]


def publish_ports(config, state):
    ports = sorted({record['port'] for _, record in records(state) if record['enabled'] and record['expose']})
    elements = ', '.join(map(str, ports))
    nft = 'set service_ports { type inet_service;'
    if ports:
        nft += ' elements = { ' + elements + ' };'
    nft += ' }\n'
    # The persistent include recreates the same set before services start at boot.
    atomic(pathlib.Path(config['portsFile']), nft, 0o644)
    transaction = 'flush set inet dsh_sandbox service_ports\n'
    if ports:
        transaction += 'add element inet dsh_sandbox service_ports { ' + elements + ' }\n'
    invoke(['/usr/sbin/nft', '-f', '-'], text=transaction)


def describe(record):
    unit = unit_name(record['owner'], record['name'])
    values = invoke(['/usr/bin/systemctl', 'show', unit, '--property=ActiveState,SubState,MainPID,NRestarts']).splitlines()
    status = dict(line.split('=', 1) for line in values if '=' in line)
    listening = False
    if status.get('ActiveState') == 'active':
        try:
            with socket.create_connection(('127.0.0.1', record['port']), timeout=1):
                listening = True
        except OSError:
            pass  # Starting and failed applications need not have a listener.
    return {key: record[key] for key in ['name', 'port', 'expose', 'enabled']} | {
        'state': status.get('ActiveState', 'unknown'), 'substate': status.get('SubState', 'unknown'),
        'pid': int(status.get('MainPID', '0')), 'restarts': int(status.get('NRestarts', '0')),
        'listening': listening, 'unit': unit,
    }


def manage(config, owner, cwd, username, request):
    """Serialize lifecycle/port changes; a project can only address its own named services."""
    action = request.get('action')
    if action not in ['list', 'start', 'status', 'logs', 'stop']:
        raise ValueError('invalid service action')
    state = trusted(pathlib.Path(config['stateDir']))
    with (state / 'manager.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        all_records = records(state)
        if action == 'list':
            return {'services': [describe(record) for _, record in all_records if record['owner'] == owner and record['cwd'] == cwd]}
        name = request.get('name')
        if not isinstance(name, str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,47}', name):
            raise ValueError('invalid service name')
        directory = state / ('u' + owner) / name
        record_path = directory / 'record.json'
        record = json.loads(record_path.read_text()) if record_path.exists() else None
        if record is not None and (record['cwd'] != cwd or record['owner'] != owner):
            raise ValueError('service belongs to another project')
        unit = unit_name(owner, name)
        unit_path = trusted(pathlib.Path(config['unitDir'])) / unit
        if action == 'start':
            if record is None and unit_path.exists():
                raise ValueError('unmanaged service unit already exists')
            if record is not None and record['enabled']:
                return describe(record) | {'unchanged': True}
            command, port, expose = request.get('command'), request.get('port'), request.get('expose', False)
            if not isinstance(command, str) or not command.strip() or len(command.encode()) > 32768 or '\0' in command:
                raise ValueError('invalid foreground command')
            if type(port) is not int or not 1024 <= port <= 65535 or port in config['reservedPorts'] or type(expose) is not bool:
                raise ValueError('invalid or reserved service port')
            enabled = [item for _, item in all_records if item['enabled']]
            if any(item['port'] == port for item in enabled):
                raise ValueError('port is already reserved by a managed service')
            if sum(item['owner'] == owner for item in enabled) >= config['maxPerUser']:
                raise ValueError('account service limit reached')
            with socket.socket() as probe:
                try:
                    probe.bind(('0.0.0.0', port))
                except OSError as error:
                    raise ValueError('port is already in use') from error
            directory.mkdir(parents=True, mode=0o700, exist_ok=True)
            script = directory / 'command.sh'
            atomic(script, command.rstrip() + '\n')
            record = {'owner': owner, 'cwd': cwd, 'name': name, 'port': port, 'expose': expose, 'enabled': True}
            atomic(record_path, json.dumps(record) + '\n')
            atomic(unit_path, unit_text(config, owner, cwd, username, name, script), 0o644)
            invoke(['/usr/bin/systemctl', 'daemon-reload'])
            publish_ports(config, state)
            invoke(['/usr/bin/systemctl', 'enable', '--now', unit])
        elif record is None:
            raise ValueError('service not found in this project')
        elif action == 'stop':
            invoke(['/usr/bin/systemctl', 'disable', '--now', unit])
            record['enabled'] = False
            atomic(record_path, json.dumps(record) + '\n')
            publish_ports(config, state)
        elif action == 'logs':
            log = invoke(['/usr/bin/journalctl', '--unit', unit, '--lines=80', '--no-pager', '--output=cat'])
            return describe(record) | {'logs': log[-65536:]}
        return describe(record)


def main():
    if os.geteuid() != 0 or len(sys.argv) != 4 or not re.fullmatch(r'[1-9][0-9]{0,15}', sys.argv[1]):
        raise ValueError('invalid service invocation')
    owner, requested, username = sys.argv[1:]
    if not re.fullmatch(r'[A-Za-z0-9._-]{1,64}', username):
        username = 'u' + owner
    config = json.loads(trusted(CONFIG).read_text())
    trusted(pathlib.Path(config['launcher']))
    root = pathlib.Path(config['workspaceRoot'])
    tenant = root / ('u' + owner)
    cwd = pathlib.Path(requested).resolve(strict=True)
    if root.resolve(strict=True) != root or tenant.resolve(strict=True) != tenant or not cwd.is_dir():
        raise ValueError('invalid workspace')
    cwd.relative_to(tenant)
    if any(ord(character) < 32 for character in str(cwd)):
        raise ValueError('invalid workspace path')
    body = sys.stdin.buffer.read(65537)
    if len(body) > 65536:
        raise ValueError('service request too large')
    request = json.loads(body)
    if not isinstance(request, dict):
        raise ValueError('invalid service request')
    print(json.dumps(manage(config, owner, str(cwd), username, request), ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.TimeoutExpired) as error:
        sys.stderr.write('development service: ' + str(error) + '\n')
        sys.exit(1)
