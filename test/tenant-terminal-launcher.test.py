"""Validate the privileged launcher's argv before exercising it on a Linux candidate."""
import importlib.util
import pathlib
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('launcher', pathlib.Path(__file__).parents[1] / 'scripts/tenant-terminal-launcher.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name).resolve()
        self.cwd = self.root / 'u2/project'
        self.cwd.mkdir(parents=True)
        self.home = self.root / 'home'
        self.home.mkdir()

    def invoke(self, extra):
        with patch.object(launcher, 'ROOT', self.root), \
             patch.object(launcher.os, 'geteuid', return_value=0), \
             patch.object(launcher.pwd, 'getpwnam', return_value=types.SimpleNamespace(pw_uid=1002, pw_gid=1002)), \
             patch.object(launcher.grp, 'getgrnam', return_value=types.SimpleNamespace(gr_gid=2002)), \
             patch.object(launcher, 'sandbox_home', return_value=self.home), \
             patch.object(launcher.sys, 'argv', ['launcher', '2', str(self.cwd), *extra]), \
             patch.object(launcher.os, 'execve') as execute:
            launcher.main()
            return execute.call_args.args

    def test_command_mode_has_private_processes_and_only_the_project_and_home_are_writable(self):
        _, args, env = self.invoke(['owner', '--command'])
        self.assertEqual(args[-4:], ['/bin/bash', '--noprofile', '--norc', '-s'])
        self.assertIn('--unshare-pid', args)
        self.assertIn('--die-with-parent', args)
        self.assertIn('--clearenv', args)
        self.assertIn('--no-new-privs', args)
        self.assertIn('--bounding-set=-all', args)
        binds = [(args[i], args[i + 1], args[i + 2]) for i in range(len(args)) if args[i] in ('--bind', '--ro-bind')]
        self.assertIn(('--ro-bind', str(self.root / 'u2'), '/workspace'), binds)
        self.assertEqual([row for row in binds if row[0] == '--bind'], [
            ('--bind', str(self.cwd), '/workspace/project'), ('--bind', str(self.home), '/home/dsh')])
        self.assertEqual(env, {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})

    def test_interactive_terminal_keeps_its_existing_invocation(self):
        _, args, _ = self.invoke([])
        self.assertEqual(args[-1], '-i')
        self.assertIn(str(self.root / 'u2'), args)

    def test_unknown_mode_and_symlink_escape_are_rejected(self):
        with self.assertRaises(ValueError):
            self.invoke(['owner', '--root-shell'])
        outside = self.root / 'u3'
        outside.mkdir()
        self.cwd.rmdir()
        self.cwd.symlink_to(outside)
        with self.assertRaises(ValueError):
            self.invoke(['owner', '--command'])


if __name__ == '__main__':
    unittest.main()
