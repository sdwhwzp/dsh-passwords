/** Installer downloads within the existing main panel. */
import { createElement as h, useEffect, useState } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

interface Catalog { version: string; commit: string; files: { file: string; platform: string; bytes: number; sha256: string }[] }

export function DesktopDownloadsLauncher({ t, wide, onOpen }: PropsLocale<'dshpw'> & { wide: boolean; onOpen(): void }) {
  return h('button', { type: 'button', onClick: onOpen, className: `dshpw-sidebar-workspace-action${wide ? '' : ' compact'}`, title: t('desktopTitle'), 'aria-label': t('desktopTitle') },
    h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true }, h('path', { d: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5' })),
    wide ? h('span', null, t('desktopTitle')) : null);
}

export function DesktopDownloadsPanel({ t, onBack }: PropsLocale<'dshpw'> & { onBack(): void }) {
  const [catalog, setCatalog] = useState<Catalog>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/gateway/desktop/manifest.json', { signal: controller.signal, credentials: 'same-origin' })
      .then(async response => { if (!response.ok) throw new Error('Download catalog unavailable'); return await response.json() as Catalog; })
      .then(value => { if (!controller.signal.aborted) setCatalog(value); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, []);
  return h('main', { style: { height: '100%', minHeight: 0, overflow: 'auto', padding: '24px', boxSizing: 'border-box' } },
    h('div', { style: { maxWidth: 760, margin: '0 auto' } },
      h('button', { type: 'button', className: 'dshpw-btn', onClick: onBack }, t('desktopBack')),
      h('h1', null, t('desktopTitle')),
      h('p', null, t('desktopDescription')),
      !catalog ? h('p', { role: failed ? 'alert' : 'status' }, t(failed ? 'desktopUnavailable' : 'desktopLoading')) :
        h('div', null, h('p', null, `${catalog.version} · ${catalog.commit.slice(0, 7)}`),
          ...catalog.files.map(entry => h('section', { key: entry.file, style: { padding: 24, margin: '16px 0', border: '1px solid #d7dce5', borderRadius: 16 } },
            h('a', { href: `/gateway/desktop/files/${encodeURIComponent(entry.file)}`, download: entry.file, style: { fontWeight: 600 } }, `${entry.platform === 'windows-x64' ? 'Windows x64' : 'Mac Apple Silicon'} · ${entry.file.split('.').pop()?.toUpperCase()}`),
            h('span', { style: { marginLeft: 16 } }, `${(entry.bytes / 1048576).toFixed(1)} MB`),
            h('small', { style: { display: 'block', marginTop: 12, overflowWrap: 'anywhere' } }, `SHA-256: ${entry.sha256}`)))),
      h('p', null, t('desktopUnsigned'))));
}
