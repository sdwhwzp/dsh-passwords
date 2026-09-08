#!/usr/bin/python3 -I
"""Root-owned sudo entry point: one tenant mount, private PID/network namespaces."""
import os
import pathlib
import pwd
import re
import sys

ROOT = pathlib.Path('/home/tzwl3/dsh-user-workspaces')
ACCOUNT = 'tzwl3'


def main():
    if os.geteuid() != 0 or len(sys.argv) != 3 or not re.fullmatch(r'[1-9][0-9]{0,15}', sys.argv[1]):
        raise ValueError('invalid terminal invocation')
    tenant = ROOT / ('u' + sys.argv[1])
    if ROOT.resolve(strict=True) != ROOT or tenant.resolve(strict=True) != tenant:
        raise ValueError('tenant root must not be a symlink')
    cwd = pathlib.Path(sys.argv[2]).resolve(strict=True)
    relative = cwd.relative_to(tenant)
    if not cwd.is_dir():
        raise ValueError('workspace directory required')
    account = pwd.getpwnam(ACCOUNT)
    args = ['/usr/bin/bwrap', '--unshare-ipc', '--unshare-pid', '--unshare-net', '--unshare-uts', '--unshare-cgroup-try', '--die-with-parent', '--clearenv',
            '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin',
            '--symlink', 'usr/sbin', '/sbin', '--symlink', 'usr/lib', '/lib',
            '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev',
            '--perms', '1777', '--tmpfs', '/tmp', '--dir', '/etc',
            '--bind', str(tenant), '/workspace', '--chdir', str(pathlib.Path('/workspace') / relative),
            '--setenv', 'HOME', '/workspace', '--setenv', 'PATH', '/usr/bin:/bin',
            '--setenv', 'TERM', 'xterm-256color', '--setenv', 'LANG', 'C.UTF-8',
            '--setenv', 'TMPDIR', '/tmp', '--setenv', 'PS1', r'sandbox:\w\$ ',
            '--', '/usr/bin/setpriv', '--reuid', str(account.pw_uid), '--regid', str(account.pw_gid), '--clear-groups', '--no-new-privs', '--bounding-set=-all', '/bin/bash', '--noprofile', '--norc', '-i']
    os.execve(args[0], args, {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError):
        sys.stderr.write('workspace terminal: access denied or sandbox unavailable\n')
        sys.exit(1)
