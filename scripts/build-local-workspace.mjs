import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'dist', 'local-workspace-standalone.cjs');
// Optional deployment-specific address offered when the setup wizard's server prompt is left empty.
const defaultServer = process.env.DSH_LOCAL_WORKSPACE_DEFAULT_SERVER?.trim() ?? '';

await mkdir(path.dirname(outfile), { recursive: true });
await mkdir(path.join(root, 'release'), { recursive: true });
await build({
  entryPoints: [path.join(root, 'src', 'local-workspace-cli.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node22'],
  minify: true,
  sourcemap: false,
  define: defaultServer === ''
    ? {}
    : { __DSH_LOCAL_WORKSPACE_DEFAULT_SERVER__: JSON.stringify(defaultServer) },
  logLevel: 'info',
});

console.log(`本机助手独立 bundle 已生成：${outfile}`);
