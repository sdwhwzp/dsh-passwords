import { build } from 'esbuild';
await build({ entryPoints: ['integrations/task-board/entry.ts'], outfile: 'dist/task-board-engine.js', bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'eof' });
import { copyFile } from 'node:fs/promises';
await copyFile('src/task-board-engine.d.ts', 'dist/task-board-engine.d.ts');
