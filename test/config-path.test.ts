import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { envFilePath, resolveConfigPath, resolveEnvRelativePath } from '../src/config.ts';

test('relative database paths stay anchored to the deployment env directory after npm package switches', () => {
  const root = path.resolve('/opt/dsh-passwords');
  assert.equal(resolveConfigPath('data/platform.db', root, path.join(root, 'data', 'platform.db')), path.join(root, 'data', 'platform.db'));
  assert.equal(resolveConfigPath('/var/lib/dsh/platform.db', root, path.join(root, 'data', 'platform.db')), '/var/lib/dsh/platform.db');
});

test('an external env path keeps gateway data outside a replaced package directory', (t) => {
  const previous = process.env.DSH_PASSWORDS_ENV_FILE;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_PASSWORDS_ENV_FILE;
    else process.env.DSH_PASSWORDS_ENV_FILE = previous;
  });
  const deploymentEnv = path.resolve('deployment/private/gateway.env');
  process.env.DSH_PASSWORDS_ENV_FILE = '  deployment/private/gateway.env  ';
  const childEnvFile = envFilePath();
  assert.equal(childEnvFile, deploymentEnv);
  assert.equal(path.resolve('/different/package/cwd', childEnvFile), deploymentEnv);
  assert.equal(resolveEnvRelativePath('./data/platform.db', childEnvFile, '/unused/default.db'), path.join(path.dirname(deploymentEnv), 'data/platform.db'));
  process.env.DSH_PASSWORDS_ENV_FILE = childEnvFile;
  assert.equal(envFilePath(), deploymentEnv);
});
