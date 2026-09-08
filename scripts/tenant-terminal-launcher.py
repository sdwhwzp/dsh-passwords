#!/usr/bin/python3 -I
"""Root-owned sudo entry point: one tenant mount, private PID namespace, filtered network."""
import grp
import os
import pathlib
import pwd
import re
import sys

ROOT = pathlib.Path('/home/tzwl3/dsh-user-workspaces')
ACCOUNT = 'tzwl3'
# Sandboxes share the host network namespace so git can reach its remotes; the
# nftables table dsh_sandbox filters by this group, so the group must exist and
# must be the process group of every sandboxed shell.
SANDBOX_GROUP = 'dsh-sandbox'
# Resolver, CA bundle and account lookups the network needs; /etc is otherwise empty.
NETWORK_FILES = ['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group']


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
    sandbox = grp.getgrnam(SANDBOX_GROUP)
    network = []
    for path in NETWORK_FILES:
        if pathlib.Path(path).exists():
            network += ['--ro-bind', path, path]
    args = ['/usr/bin/bwrap', '--unshare-ipc', '--unshare-pid', '--unshare-uts', '--unshare-cgroup-try', '--die-with-parent', '--clearenv',
            '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin',
            '--symlink', 'usr/sbin', '/sbin', '--symlink', 'usr/lib', '/lib',
            '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev',
            '--perms', '1777', '--tmpfs', '/tmp', '--dir', '/etc',
            '--ro-bind', '/etc/ssl', '/etc/ssl', *network,
            '--bind', str(tenant), '/workspace', '--chdir', str(pathlib.Path('/workspace') / relative),
            '--setenv', 'HOME', '/workspace', '--setenv', 'PATH', '/usr/bin:/bin',
            '--setenv', 'TERM', 'xterm-256color', '--setenv', 'LANG', 'C.UTF-8',
            '--setenv', 'TMPDIR', '/tmp', '--setenv', 'PS1', r'sandbox:\w\$ ',
            '--', '/usr/bin/setpriv', '--reuid', str(account.pw_uid), '--regid', str(sandbox.gr_gid), '--clear-groups', '--no-new-privs', '--bounding-set=-all', '/bin/bash', '--noprofile', '--norc', '-i']
    os.execve(args[0], args, {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError):
        sys.stderr.write('workspace terminal: access denied or sandbox unavailable\n')
        sys.exit(1)
