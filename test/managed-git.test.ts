import assert from 'node:assert/strict';
import test from 'node:test';

import {
  managedGitBranch,
  managedGitCloneArgs,
  managedGitDirectoryName,
  managedGitEnv,
  managedGitPullArgs,
  parseManagedGitUrl,
  parseManagedGitCredentials,
  redactManagedGitOutput,
} from '../src/managed-git.js';

test('only http and https repository URLs are accepted', () => {
  for (const raw of [
    'ext::sh -c whoami',
    'file:///etc/passwd',
    'ssh://git@example.test/team/repo.git',
    'git://example.test/team/repo.git',
    '/srv/repo.git',
    'example.test/team/repo.git',
    'https://example.test/repo.git\nhttps://evil.test/repo.git',
    'https:// example.test/repo.git',
    'https://',
    '',
  ]) {
    assert.equal(parseManagedGitUrl(raw), null, `${JSON.stringify(raw)} 必须被拒绝`);
  }
  assert.equal(parseManagedGitUrl('https://example.test/team/repo.git')?.url, 'https://example.test/team/repo.git');
  assert.equal(parseManagedGitUrl(' http://example.test/repo ')?.url, 'http://example.test/repo');
});

test('credentials in a repository URL never reach the display form', () => {
  const parsed = parseManagedGitUrl('https://someone:secret-token@example.test/team/repo.git');
  assert.ok(parsed);
  assert.equal(parsed.url, 'https://example.test/team/repo.git');
  assert.equal(parsed.credentials?.password, 'secret-token');
  assert.doesNotMatch(parsed.display, /secret-token/);
  assert.doesNotMatch(redactManagedGitOutput(`fatal: ${parsed.url} not found`, parsed), /secret-token/);
  assert.doesNotMatch(
    redactManagedGitOutput('remote: https://someone:secret-token@example.test/x', parsed),
    /secret-token/,
  );
});

test('the clone directory comes from the URL or from a single safe segment', () => {
  const url = parseManagedGitUrl('https://example.test/team/repo.git');
  assert.ok(url);
  assert.equal(managedGitDirectoryName(url, ''), 'repo');
  assert.equal(managedGitDirectoryName(url, 'target'), 'target');
  for (const requested of ['..', '../escape', 'nested/deeper', '/absolute', '-flag', 'a'.repeat(101)]) {
    assert.equal(managedGitDirectoryName(url, requested), null, `${requested} 必须被拒绝`);
  }
  const root = parseManagedGitUrl('https://example.test/');
  assert.ok(root);
  assert.equal(managedGitDirectoryName(root, ''), null);
});

test('every git run is hardened against foreign transports and host credentials', () => {
  const url = parseManagedGitUrl('https://example.test/team/repo.git');
  assert.ok(url);
  const args = managedGitCloneArgs(url, 'repo');
  assert.deepEqual(args.slice(-3), ['--', url.url, 'repo']);
  for (const setting of ['protocol.allow=never', 'credential.helper=', 'core.symlinks=false']) {
    assert.ok(args.includes(setting), `克隆参数必须包含 ${setting}`);
  }
  assert.ok(managedGitPullArgs().includes('--ff-only'));

  const env = managedGitEnv(
    { PATH: '/usr/bin', HOME: '/root', GIT_CONFIG_GLOBAL: '/root/.gitconfig', GIT_SSH_COMMAND: 'ssh -i /root/key' },
    '/managed/u1',
  );
  assert.equal(env.HOME, '/managed/u1');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.notEqual(env.GIT_CONFIG_GLOBAL, '/root/.gitconfig');
  assert.equal(env.GIT_SSH_COMMAND, undefined);
  assert.equal(env.PATH, '/usr/bin');
});

test('the checked-out branch is read from HEAD, and a detached HEAD reports none', () => {
  assert.equal(managedGitBranch('ref: refs/heads/main\n'), 'main');
  assert.equal(managedGitBranch('ref: refs/heads/feature/login\n'), 'feature/login');
  assert.equal(managedGitBranch('9fceb02d0ae598e95dc970b74767f19372d61af8\n'), null);
  assert.equal(managedGitBranch(''), null);
});


test('credentials are optional as a pair and reject malformed wire values', () => {
  assert.equal(parseManagedGitCredentials(undefined, undefined), undefined);
  assert.equal(parseManagedGitCredentials('', ''), undefined);
  assert.deepEqual(parseManagedGitCredentials('user', ' secret '), { username: 'user', password: ' secret ' });
  for (const [username, password] of [['user', ''], ['', 'secret'], ['u:ser', 'secret'], ['u\nser', 'secret'], ['user', 'x\r\nAuthorization: x'], ['u', 'x'.repeat(4097)], [null, 'x'], ['u', {}]]) {
    assert.equal(parseManagedGitCredentials(username, password), null);
  }
  assert.equal(parseManagedGitUrl('https://u:%ZZ@example.test/repo'), null);
  assert.equal(parseManagedGitUrl('https://example.test/repo?token=secret'), null);
});

test('separate credentials stay out of argv and are redacted from output', () => {
  const url = parseManagedGitUrl('https://example.test/repo.git')!;
  const credentials = { username: 'user', password: 'synthetic:@ token' };
  const encoded = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
  const env = managedGitEnv({ PATH: '/usr/bin', GIT_CONFIG_COUNT: '1', GIT_CONFIG_VALUE_0: 'host-secret' }, '/managed/u1', { url, credentials });
  assert.equal(env.GIT_CONFIG_KEY_1, 'http.https://example.test/repo.git.extraHeader');
  assert.equal(env.GIT_CONFIG_VALUE_1, `Authorization: Basic ${encoded}`);
  assert.equal(env.GIT_CONFIG_VALUE_2, 'false');
  assert.doesNotMatch(JSON.stringify(managedGitCloneArgs(url, 'repo')), /synthetic|Authorization/);
  assert.equal(managedGitEnv({}, '/managed/u2').GIT_CONFIG_COUNT, undefined);
  for (const secret of [credentials.password, encodeURIComponent(credentials.password), encoded]) {
    assert.equal(redactManagedGitOutput(`remote: ${secret}`, url, credentials), 'remote: ***');
  }
});
