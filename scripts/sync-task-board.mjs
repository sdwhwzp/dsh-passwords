import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [repository, revision, archive] = process.argv.slice(2);
if (!repository || !revision || !archive) {
  throw new Error('Usage: node scripts/sync-task-board.mjs <web-checkout> <commit> <task-board.tgz>');
}
const root = fileURLToPath(new URL('../integrations/task-board/', import.meta.url));
const git = (...args) => execFileSync('git', ['-C', path.resolve(repository), ...args], { maxBuffer: 16 * 1024 * 1024 });
const commit = git('rev-parse', '--verify', `${revision}^{commit}`).toString().trim();
const prefix = 'packages/dsh-task-board/';
const manifest = JSON.parse(git('show', `${commit}:${prefix}package.json`).toString());
const packedManifest = JSON.parse(execFileSync('tar', ['-xOf', path.resolve(archive), 'package/package.json']).toString());
if (manifest.name !== packedManifest.name || manifest.version !== packedManifest.version) {
  throw new Error('The source and packed task-board versions differ');
}
const previous = JSON.parse(await readFile(path.join(root, 'source.json'), 'utf8'));
const pending = ['index.ts', ...Object.keys(previous.files)];
const sources = new Map();
const blobs = {};
while (pending.length) {
  const filename = pending.pop();
  if (sources.has(filename)) continue;
  if (filename.startsWith('../') || path.posix.isAbsolute(filename)) throw new Error(`Source escapes task-board: ${filename}`);
  const ref = `${commit}:${prefix}src/${filename}`;
  const bytes = git('show', ref);
  sources.set(filename, bytes);
  blobs[filename] = git('rev-parse', ref).toString().trim();
  for (const match of bytes.toString().matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)) {
    const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(filename), match[1]));
    if (!dependency.endsWith('.ts')) throw new Error(`Unsupported local import: ${filename} -> ${dependency}`);
    pending.push(dependency);
  }
}
const client = execFileSync('tar', ['-xOf', path.resolve(archive), 'package/lib/client.js'], { maxBuffer: 32 * 1024 * 1024 });
const shellPath = path.join(root, 'client-shell/package.json');
const shell = JSON.parse(await readFile(shellPath, 'utf8'));
shell.version = manifest.version;
shell.dsh.client = manifest.dsh.client;
for (const [filename, bytes] of sources) {
  const destination = path.join(root, 'upstream', filename);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}
await writeFile(shellPath, JSON.stringify(shell, null, 2) + '\n');
await writeFile(path.join(root, previous.client.path), client);
await writeFile(path.join(root, 'source.json'), JSON.stringify({
  ...previous,
  commit,
  version: manifest.version,
  files: Object.fromEntries(Object.entries(blobs).sort(([left], [right]) => left.localeCompare(right))),
  client: { ...previous.client, sha256: createHash('sha256').update(client).digest('hex') },
}, null, 2) + '\n');
console.log(`Synchronized ${sources.size} task-board sources and client ${manifest.version} from ${commit}`);
