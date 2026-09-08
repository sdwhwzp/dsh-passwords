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
# Per-account home, shared with the editor sandbox and addressed by account id
# rather than tenant directory name so both reach the same one. Kept out of the
# workspace: a version manager's downloads belong beside neither the code nor
# the account's git history.
HOME_ROOT = pathlib.Path('/var/lib/dsh-sandbox-home')
# Resolver, CA bundle and account lookups the network needs; /etc is otherwise empty.
NETWORK_FILES = ['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group']


def git_identity(owner, extra):
    """Name for the seeded git identity.

    The caller's account name when it passes one, otherwise the account id the
    home is keyed by. Both launchers derive it the same way, so the terminal and
    the editor never seed one account with two different identities.
    """
    if extra and re.fullmatch(r'[A-Za-z0-9._-]{1,64}', extra[0]):
        return extra[0]
    return 'u' + owner


def seed_git_identity(home, account, identity):
    """Write this account's git identity once.

    git refuses to record a commit without one and the sandbox home starts
    empty. O_EXCL creates the file only when it is absent, so a user who edits
    their name, email or any other setting keeps it across every later launch.
    """
    try:
        descriptor = os.open(home / '.gitconfig', os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        return
    try:
        os.fchown(descriptor, account.pw_uid, account.pw_gid)
        os.write(descriptor, (
            '# Seeded by DSH for this account. Edit freely; DSH will not rewrite it.\n'
            '[user]\n\tname = ' + identity + '\n\temail = ' + identity + '@dsh.local\n'
        ).encode())
    finally:
        os.close(descriptor)


def sandbox_home(owner, account, identity):
    """Create this account's sandbox home under a root-owned parent and return it."""
    if HOME_ROOT.exists():
        if HOME_ROOT.resolve(strict=True) != HOME_ROOT:
            raise ValueError('noncanonical home root')
        info = HOME_ROOT.stat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('untrusted home root')
    else:
        HOME_ROOT.mkdir(mode=0o711)
        os.chown(HOME_ROOT, 0, 0)
    home = HOME_ROOT / ('u' + owner)
    if not home.exists():
        home.mkdir(mode=0o700)
        os.chown(home, account.pw_uid, account.pw_gid)
    if home.resolve(strict=True) != home:
        raise ValueError('noncanonical account home')
    # `~/workspace` keeps the habit of reaching the workspace from the home.
    link = home / 'workspace'
    if not link.exists(follow_symlinks=False):
        link.symlink_to('/workspace')
    seed_git_identity(home, account, identity)
    return home


def main():
    if os.geteuid() != 0 or not 3 <= len(sys.argv) <= 4 or not re.fullmatch(r'[1-9][0-9]{0,15}', sys.argv[1]):
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
    home = sandbox_home(sys.argv[1], account, git_identity(sys.argv[1], sys.argv[3:]))
    network = []
    for path in NETWORK_FILES:
        if pathlib.Path(path).exists():
            network += ['--ro-bind', path, path]
    args = ['/usr/bin/bwrap', '--unshare-ipc', '--unshare-pid', '--unshare-uts', '--unshare-cgroup-try', '--die-with-parent', '--clearenv',
            '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin',
            '--symlink', 'usr/sbin', '/sbin', '--symlink', 'usr/lib', '/lib',
            '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev',
            '--perms', '1777', '--tmpfs', '/tmp', '--dir', '/etc',
            # bwrap creates a missing bind parent as 0700 root, which the
            # dropped uid cannot traverse; the home mount needs it walkable.
            '--perms', '0755', '--dir', '/home',
            '--ro-bind', '/etc/ssl', '/etc/ssl', *network,
            '--bind', str(tenant), '/workspace', '--bind', str(home), '/home/dsh',
            '--chdir', str(pathlib.Path('/workspace') / relative),
            '--setenv', 'HOME', '/home/dsh', '--setenv', 'PATH', '/usr/bin:/bin',
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
