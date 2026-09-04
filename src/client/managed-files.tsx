/** Browser file transfer panel for the signed-in subuser's host-managed directory. */

import { createElement as h, useEffect, useRef, useState } from 'react';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';

interface ManagedFileEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  bytes: number | null;
  modifiedAt: string;
}

interface ManagedFileListing {
  path: string;
  parent: string | null;
  entries: ManagedFileEntry[];
  truncated: boolean;
}

interface Props {
  t: TranslateNS<'dshpw'>;
  busy: boolean;
  setBusy(value: boolean): void;
  setError(value: string): void;
  setNotice(value: string): void;
}

async function responseJson<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `HTTP ${String(response.status)}`);
  return value;
}

/** Build the authenticated relative-path download URL for one managed file. */
export function managedFileDownloadUrl(relativePath: string): string {
  return `/gateway/api/managed-files/download?path=${encodeURIComponent(relativePath)}`;
}

/** Format a file size for the compact file list. */
export function formatManagedFileBytes(bytes: number): string {
  if (bytes < 1_024) return `${String(bytes)} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MiB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GiB`;
}

export function ManagedFilesPanel(props: Props) {
  const { t, busy, setBusy, setError, setNotice } = props;
  const [listing, setListing] = useState<ManagedFileListing | null>(null);
  const [loading, setLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const load = (relativePath: string, clearError = true) => {
    setLoading(true);
    void fetch(`/gateway/api/managed-files?path=${encodeURIComponent(relativePath)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then((response) => responseJson<ManagedFileListing>(response))
      .then((value) => {
        setListing(value);
        if (clearError) setError('');
      })
      .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load('');
  }, []);

  const upload = (files: readonly File[], preserveRelativePaths: boolean) => {
    if (files.length === 0) return;
    const current = listing?.path ?? '';
    setBusy(true);
    setError('');
    setNotice('');
    let completed = 0;
    void (async () => {
      for (const file of files) {
        const relativePath = preserveRelativePaths && file.webkitRelativePath !== ''
          ? file.webkitRelativePath
          : file.name;
        const response = await fetch(
          `/gateway/api/managed-files/upload?path=${encodeURIComponent(current)}&relativePath=${encodeURIComponent(relativePath)}`,
          {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'content-type': file.type || 'application/octet-stream' },
            body: file,
          },
        );
        await responseJson<{ file: { name: string } }>(response);
        completed++;
      }
    })()
      .then(() => {
        setNotice(files.length === 1
          ? t('managedFilesUploaded', { name: files[0].name })
          : t('managedFilesUploadedMany', { count: completed }));
        load(current);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setError(completed === 0
          ? message
          : t('managedFilesUploadPartial', { count: completed, error: message }));
        load(current, false);
      })
      .finally(() => {
        setBusy(false);
        if (inputRef.current !== null) inputRef.current.value = '';
        if (folderInputRef.current !== null) folderInputRef.current.value = '';
      });
  };

  const remove = (entry: ManagedFileEntry) => {
    const confirmation = entry.kind === 'directory'
      ? t('managedFilesDeleteConfirmDirectory', { name: entry.name })
      : t('managedFilesDeleteConfirmFile', { name: entry.name });
    if (!window.confirm(confirmation)) return;
    const current = listing?.path ?? '';
    setBusy(true);
    setError('');
    setNotice('');
    void fetch(`/gateway/api/managed-files?path=${encodeURIComponent(entry.path)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    })
      .then((response) => responseJson<{ deleted: { path: string } }>(response))
      .then(() => {
        setNotice(t('managedFilesDeleted', { name: entry.name }));
        load(current);
      })
      .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  const currentPath = listing?.path === '' || listing === null ? '/' : `/${listing.path}`;
  return h(
    'div',
    { className: 'dshpw-section dshpw-managed-files' },
    h(
      'div',
      { className: 'dshpw-section-head' },
      h('span', { className: 'dshpw-label' }, t('managedFilesTitle')),
      h('code', { className: 'dshpw-managed-files-path', title: currentPath }, currentPath),
    ),
    h('div', { className: 'dshpw-hint' }, t('managedFilesHint')),
    h(
      'div',
      { className: 'dshpw-managed-files-toolbar' },
      h('button', {
        type: 'button',
        className: 'dshpw-btn',
        disabled: busy || loading || listing?.parent === null || listing === null,
        onClick: () => load(listing?.parent ?? ''),
      }, t('managedFilesBack')),
      h('button', {
        type: 'button',
        className: 'dshpw-btn',
        disabled: busy || loading,
        onClick: () => load(listing?.path ?? ''),
      }, t('managedFilesRefresh')),
      h(
        'label',
        { className: `dshpw-btn dshpw-managed-files-upload${busy ? ' disabled' : ''}` },
        t('managedFilesUpload'),
        h('input', {
          ref: inputRef,
          type: 'file',
          disabled: busy || loading,
          onChange: (event: { target: { files: FileList | null } }) => {
            const file = event.target.files?.[0];
            if (file !== undefined) upload([file], false);
          },
        }),
      ),
      h(
        'label',
        { className: `dshpw-btn dshpw-managed-files-upload${busy ? ' disabled' : ''}` },
        t('managedFilesUploadFolder'),
        h('input', {
          ref: folderInputRef,
          type: 'file',
          multiple: true,
          webkitdirectory: '',
          disabled: busy || loading,
          onChange: (event: { target: { files: FileList | null } }) => {
            upload(Array.from(event.target.files ?? []), true);
          },
        }),
      ),
    ),
    loading && listing === null
      ? h('div', { className: 'dshpw-hint' }, t('managedFilesLoading'))
      : listing !== null && listing.entries.length > 0
        ? h(
            'div',
            { className: 'dshpw-managed-files-list' },
            ...listing.entries.map((entry) => h(
              'div',
              { className: 'dshpw-managed-files-row', key: entry.path },
              entry.kind === 'directory'
                ? h('button', {
                    type: 'button',
                    className: 'dshpw-managed-files-name',
                    disabled: busy,
                    onClick: () => load(entry.path),
                    title: entry.name,
                  }, `📁 ${entry.name}`)
                : h('span', { className: 'dshpw-managed-files-name', title: entry.name }, `📄 ${entry.name}`),
              h('span', { className: 'dshpw-hint' }, entry.bytes === null ? '' : formatManagedFileBytes(entry.bytes)),
              h(
                'div',
                { className: 'dshpw-managed-files-actions' },
                entry.kind === 'file' && h('a', {
                  className: 'dshpw-btn dshpw-download-btn',
                  href: managedFileDownloadUrl(entry.path),
                  download: entry.name,
                }, t('managedFilesDownload')),
                h('button', {
                  type: 'button',
                  className: 'dshpw-btn danger',
                  disabled: busy,
                  onClick: () => remove(entry),
                }, t('managedFilesDelete')),
              ),
            )),
          )
        : h('div', { className: 'dshpw-hint' }, t('managedFilesEmpty')),
    listing?.truncated && h('div', { className: 'dshpw-hint' }, t('managedFilesTruncated')),
  );
}
