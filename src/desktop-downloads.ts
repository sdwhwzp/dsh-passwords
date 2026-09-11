/** Serve only operator-published desktop installers from an immutable release directory. */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Express, Request } from 'express';
import { t, type Lang } from './i18n.js';

interface Download { file: string; platform: 'windows-x64' | 'mac-arm64'; bytes: number; sha256: string }
interface Catalog { version: string; commit: string; files: Download[] }

/** Register the public installer catalog and allowlisted downloads; an empty directory disables distribution. */
export function registerDesktopDownloads(app: Express, directory: string | undefined, langOf: (req: Request) => Lang): void {
  if (!directory) return;
  const root = realpathSync(directory);
  const value: unknown = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  if (typeof value !== 'object' || value === null) throw new Error('Invalid desktop installer manifest');
  const catalog = value as Catalog;
  if (typeof catalog.version !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(catalog.version)
    || typeof catalog.commit !== 'string' || !/^[a-f0-9]{40}$/.test(catalog.commit) || !Array.isArray(catalog.files) || catalog.files.length === 0) {
    throw new Error('Invalid desktop installer release');
  }
  const files = new Map<string, Download>();
  for (const entry of catalog.files) {
    if (!entry || typeof entry.file !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(exe|dmg|zip)$/.test(entry.file)
      || !['windows-x64', 'mac-arm64'].includes(entry.platform)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || !/^[a-f0-9]{64}$/.test(entry.sha256) || files.has(entry.file)) {
      throw new Error('Invalid desktop installer entry');
    }
    const location = path.join(root, entry.file);
    const stat = statSync(location);
    if (realpathSync(location) !== location || !stat.isFile() || stat.size !== entry.bytes) throw new Error('Desktop installer file mismatch');
    files.set(entry.file, entry);
  }
  app.get('/gateway/desktop/manifest.json', (_req, res) => { res.json(catalog); });
  app.get('/gateway/desktop/files/:file', (req, res) => {
    const entry = files.get(req.params.file!);
    if (!entry) { res.sendStatus(404); return; }
    res.setHeader('Cache-Control', 'private, no-cache');
    res.download(path.join(root, entry.file), entry.file);
  });
  app.get('/gateway/desktop', (req, res) => {
    const lang = langOf(req);
    const rows = catalog.files.map(entry => `<li><a download href="/gateway/desktop/files/${entry.file}">${entry.platform === 'windows-x64' ? 'Windows x64' : 'Mac Apple Silicon'} · ${path.extname(entry.file).slice(1).toUpperCase()}</a><span>${(entry.bytes / 1048576).toFixed(1)} MB</span><small>SHA-256: ${entry.sha256}</small></li>`).join('');
    res.type('html').send(`<!doctype html><html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t(lang, 'desktop.title')}</title><style>body{font:16px/1.6 system-ui;background:#f7f8fa;color:#20242c;margin:0}main{max-width:760px;margin:64px auto;padding:24px}h1{font-size:28px}a{color:#3568dc}ul{list-style:none;padding:0}li{padding:24px;background:white;border:1px solid #e2e5eb;border-radius:16px;margin:16px 0}li a{font-weight:600}span{float:right;color:#626b78}small{display:block;overflow-wrap:anywhere;color:#69717d;margin-top:12px}p{color:#626b78}</style></head><body><main><a href="/">${t(lang, 'desktop.back')}</a><h1>${t(lang, 'desktop.title')}</h1><p>${t(lang, 'desktop.description')}</p><p>${catalog.version} · ${catalog.commit.slice(0, 7)}</p><ul>${rows}</ul><p>${t(lang, 'desktop.unsigned')}</p></main></body></html>`);
  });
}
