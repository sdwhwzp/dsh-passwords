"""Service lifetime, ownership and unit serialization without privileged host mutations."""
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('services', pathlib.Path(__file__).parents[1] / 'scripts/tenant-service-launcher.py')
services = importlib.util.module_from_spec(spec)
spec.loader.exec_module(services)


class ServicesTest(unittest.TestCase):
    def test_project_ownership_lifetime_ports_and_restart(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            state, units = root / 'state', root / 'units'
            state.mkdir(); units.mkdir()
            config = {'stateDir': str(state), 'unitDir': str(units), 'portsFile': str(root / 'ports.nft'),
                      'launcher': '/usr/local/libexec/dsh-tenant-terminal', 'firewallUnit': 'dsh-sandbox-nft.service',
                      'restartSeconds': 5, 'reservedPorts': [3080, 3081, 3082], 'maxPerUser': 1}
            calls = []

            def invoke(args, **kwargs):
                calls.append((args, kwargs))
                return 'ActiveState=active\nSubState=running\nMainPID=42\nNRestarts=0\n' if 'show' in args else ''

            with patch.object(services, 'trusted', side_effect=lambda path: path), patch.object(services, 'invoke', side_effect=invoke), patch.object(services.socket, 'socket'), patch.object(services.socket, 'create_connection'):
                request = {'action': 'start', 'name': 'web', 'command': 'exec node app.js', 'port': 7111, 'expose': True}
                cwd = '/managed/u2/projects/space "quote" %n'
                result = services.manage(config, '2', cwd, 'owner', request)
                self.assertTrue(result['enabled'])
                self.assertIn('7111', (root / 'ports.nft').read_text())
                script = state / 'u2/web/command.sh'
                self.assertEqual(script.read_text(), 'exec node app.js\n')
                unit = (units / 'dsh-dev-u2-web.service').read_text()
                self.assertIn('Restart=always', unit)
                self.assertIn('WantedBy=multi-user.target', unit)
                self.assertIn('space \\"quote\\" %%n', unit)
                self.assertNotIn('exec node app.js', unit)
                before = len(calls)
                result = services.manage(config, '2', cwd, 'owner', dict(request, command='other command'))
                self.assertTrue(result['unchanged'])
                self.assertEqual(script.read_text(), 'exec node app.js\n')
                self.assertEqual(len(calls), before + 1)
                self.assertEqual(services.manage(config, '3', cwd, 'other', {'action': 'list'})['services'], [])
                with self.assertRaisesRegex(ValueError, 'another project'):
                    services.manage(config, '2', '/managed/u2/other', 'owner', {'action': 'stop', 'name': 'web'})
                with self.assertRaisesRegex(ValueError, 'not found'):
                    services.manage(config, '3', cwd, 'other', {'action': 'stop', 'name': 'web'})
                with self.assertRaisesRegex(ValueError, 'reserved'):
                    services.manage(config, '3', '/managed/u3/project', 'other', request)
                with self.assertRaisesRegex(ValueError, 'limit'):
                    services.manage(config, '2', cwd, 'owner', dict(request, name='two', port=7112))
                result = services.manage(config, '2', cwd, 'owner', {'action': 'stop', 'name': 'web'})
                self.assertFalse(result['enabled'])
                self.assertNotIn('7111', (root / 'ports.nft').read_text())
                self.assertTrue(any(args[:3] == ['/usr/bin/systemctl', 'disable', '--now'] for args, _ in calls))
                for bad in [dict(request, name='../escape'), dict(request, port=3081), dict(request, port=True), dict(request, expose='true')]:
                    with self.assertRaises(ValueError):
                        services.manage(config, '2', cwd, 'owner', bad)
                self.assertFalse(json.loads((state / 'u2/web/record.json').read_text())['enabled'])


if __name__ == '__main__':
    unittest.main()
