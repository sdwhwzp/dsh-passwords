/** Browser file transfer panel for the signed-in subuser's host-managed directory. */

import { createElement as h, useEffect, useRef, useState, type DragEvent } from 'react';
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
  /** Repository state of the listed directory; older servers omit it. */
  git?: { repository: boolean; branch: string | null };
}

/** One entry held for a pending move or copy, pasted into a later directory. */
interface ManagedClipboard {
  path: string;
  name: string;
  kind: 'directory' | 'file';
  mode: 'move' | 'copy';
}

interface Props {
  t: TranslateNS<'dshpw'>;
  busy: boolean;
  setBusy(value: boolean): void;
  setError(value: string): void;
  setNotice(value: string): void;
}

async function responseJson<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => ({})) as T & { error?: string; output?: string };
  if (!response.ok) {
    const error = new Error(value.error ?? `HTTP ${String(response.status)}`) as Error & { output?: string };
    if (typeof value.output === 'string') error.output = value.output;
    throw error;
  }
  return value;
}

/** POST one JSON body to a managed-folder endpoint. */
async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return responseJson<T>(response);
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
  const [folderName, setFolderName] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<ManagedClipboard | null>(null);
  const [cloneForm, setCloneForm] = useState<{ url: string; directory: string } | null>(null);
  const [gitOutput, setGitOutput] = useState('');
  const dragged = useRef<ManagedFileEntry | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
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

  const currentDirectory = listing?.path ?? '';

  /** Run one managed-folder mutation and refresh the current directory. */
  const run = (action: () => Promise<string>, keepOutput = false) => {
    setBusy(true);
    setError('');
    setNotice('');
    if (!keepOutput) setGitOutput('');
    void action()
      .then((message) => {
        setNotice(message);
        load(currentDirectory);
      })
      .catch((error: unknown) => {
        setError(error instanceof Error ? error.message : String(error));
        const output = error instanceof Error ? (error as Error & { output?: string }).output : undefined;
        setGitOutput(typeof output === 'string' ? output : '');
      })
      .finally(() => setBusy(false));
  };

  const upload = (files: readonly File[], preserveRelativePaths: boolean) => {
    if (files.length === 0) return;
    const current = currentDirectory;
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
    const current = currentDirectory;
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
        if (clipboard?.path === entry.path) setClipboard(null);
        load(current);
      })
      .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  const createDirectory = () => {
    const name = (folderName ?? '').trim();
    if (name === '') return;
    run(async () => {
      await postJson<{ directory: { name: string } }>(
        '/gateway/api/managed-files/directory',
        { path: currentDirectory, name },
      );
      setFolderName(null);
      return t('managedFilesCreated', { name });
    });
  };

  const paste = () => {
    if (clipboard === null) return;
    const pending = clipboard;
    run(async () => {
      await postJson<{ entry: { name: string } }>(
        `/gateway/api/managed-files/${pending.mode}`,
        { from: pending.path, toDirectory: currentDirectory },
      );
      setClipboard(null);
      return pending.mode === 'move'
        ? t('managedFilesMoved', { name: pending.name })
        : t('managedFilesCopied', { name: pending.name });
    });
  };

  const canDrop = (directory: string) => {
    const source = dragged.current;
    return !busy && !loading && source !== null && directory !== currentDirectory && directory !== source.path
      && !(source.kind === 'directory' && directory.startsWith(source.path + '/'));
  };

  const dropProps = (directory: string) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!canDrop(directory)) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(directory);
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.preventDefault(); event.stopPropagation(); setDropTarget(null);
      const source = dragged.current;
      if (!canDrop(directory) || source === null || event.dataTransfer.getData('application/x-dsh-managed-file') !== source.path) return;
      dragged.current = null;
      run(async () => {
        await postJson('/gateway/api/managed-files/move', { from: source.path, toDirectory: directory });
        if (clipboard?.path === source.path) setClipboard(null);
        return t('managedFilesMoved', { name: source.name });
      });
    },
  });

  const cloneRepository = () => {
    const form = cloneForm;
    if (form === null || form.url.trim() === '') return;
    run(async () => {
      const result = await postJson<{ directory: { name: string }; output?: string }>(
        '/gateway/api/managed-files/git/clone',
        { path: currentDirectory, url: form.url.trim(), directory: form.directory.trim() },
      );
      setGitOutput(result.output ?? '');
      setCloneForm(null);
      return t('managedFilesGitCloned', { name: result.directory.name });
    }, true);
  };

  const pullRepository = () => {
    run(async () => {
      const result = await postJson<{ output?: string }>(
        '/gateway/api/managed-files/git/pull',
        { path: currentDirectory },
      );
      setGitOutput(result.output ?? '');
      return t('managedFilesGitPulled');
    }, true);
  };

  const currentPath = listing?.path === '' || listing === null ? '/' : `/${listing.path}`;
  const repository = listing?.git?.repository === true;
  const branch = listing?.git?.branch ?? null;
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
    h('div', { className: 'dshpw-hint' }, t('managedFilesDragHint')),
    h(
      'div',
      { className: 'dshpw-managed-files-toolbar' },
      h('button', {
        type: 'button',
        className: `dshpw-btn${dropTarget !== null && dropTarget === listing?.parent ? ' dshpw-drop-target' : ''}`,
        ...(listing?.parent !== null && listing?.parent !== undefined ? dropProps(listing.parent) : {}),
        disabled: busy || loading || listing?.parent === null || listing === null,
        onClick: () => load(listing?.parent ?? ''),
      }, t('managedFilesBack')),
      h('button', {
        type: 'button',
        className: 'dshpw-btn',
        disabled: busy || loading,
        onClick: () => load(currentDirectory),
      }, t('managedFilesRefresh')),
      h('button', {
        type: 'button',
        className: 'dshpw-btn ghost',
        disabled: busy || loading,
        onClick: () => setFolderName(folderName === null ? '' : null),
      }, t('managedFilesNewFolder')),
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
    folderName === null
      ? null
      : h(
          'div',
          { className: 'dshpw-managed-files-form' },
          h('input', {
            className: 'dshpw-input',
            autoFocus: true,
            'aria-label': t('managedFilesNewFolder'),
            placeholder: t('managedFilesNewFolderName'),
            value: folderName,
            disabled: busy,
            onChange: (event: { target: { value: string } }) => setFolderName(event.target.value),
          }),
          h('button', {
            type: 'button',
            className: 'dshpw-btn',
            disabled: busy || folderName.trim() === '',
            onClick: createDirectory,
          }, t('managedFilesCreate')),
          h('button', {
            type: 'button',
            className: 'dshpw-btn ghost',
            disabled: busy,
            onClick: () => setFolderName(null),
          }, t('managedFilesCancel')),
        ),
    h(
      'div',
      { className: 'dshpw-managed-files-git' },
      h(
        'div',
        { className: 'dshpw-managed-files-git-head' },
        h('span', { className: 'dshpw-label' }, t('managedFilesGit')),
        repository
          ? h('span', { className: 'dshpw-chip' }, branch === null ? t('managedFilesGitRepo') : t('managedFilesGitBranch', { branch }))
          : null,
        h(
          'span',
          { className: 'dshpw-managed-files-git-actions' },
          repository
            ? h('button', {
                type: 'button',
                className: 'dshpw-btn',
                disabled: busy || loading,
                onClick: pullRepository,
              }, t('managedFilesGitPull'))
            : null,
          h('button', {
            type: 'button',
            className: 'dshpw-btn ghost',
            disabled: busy || loading,
            onClick: () => setCloneForm(cloneForm === null ? { url: '', directory: '' } : null),
          }, t('managedFilesGitClone')),
        ),
      ),
      cloneForm === null
        ? h('span', { className: 'dshpw-hint' }, t('managedFilesGitHint'))
        : h(
            'div',
            { className: 'dshpw-managed-files-form' },
            h('input', {
              className: 'dshpw-input',
              autoFocus: true,
              'aria-label': t('managedFilesGitUrl'),
              placeholder: t('managedFilesGitUrl'),
              value: cloneForm.url,
              disabled: busy,
              onChange: (event: { target: { value: string } }) =>
                setCloneForm({ ...cloneForm, url: event.target.value }),
            }),
            h('input', {
              className: 'dshpw-input dshpw-managed-files-git-folder',
              'aria-label': t('managedFilesGitFolder'),
              placeholder: t('managedFilesGitFolder'),
              value: cloneForm.directory,
              disabled: busy,
              onChange: (event: { target: { value: string } }) =>
                setCloneForm({ ...cloneForm, directory: event.target.value }),
            }),
            h('button', {
              type: 'button',
              className: 'dshpw-btn',
              disabled: busy || cloneForm.url.trim() === '',
              onClick: cloneRepository,
            }, busy ? t('managedFilesGitCloning') : t('managedFilesGitStart')),
            h('button', {
              type: 'button',
              className: 'dshpw-btn ghost',
              disabled: busy,
              onClick: () => setCloneForm(null),
            }, t('managedFilesCancel')),
          ),
    ),
    clipboard === null
      ? null
      : h(
          'div',
          { className: 'dshpw-managed-files-clipboard' },
          h(
            'span',
            { className: 'dshpw-hint dshpw-action-copy' },
            clipboard.mode === 'move'
              ? t('managedFilesClipboardMove', { name: clipboard.name })
              : t('managedFilesClipboardCopy', { name: clipboard.name }),
          ),
          h('button', {
            type: 'button',
            className: 'dshpw-btn',
            disabled: busy || loading,
            onClick: paste,
          }, t('managedFilesPaste')),
          h('button', {
            type: 'button',
            className: 'dshpw-btn ghost',
            disabled: busy,
            onClick: () => setClipboard(null),
          }, t('managedFilesCancel')),
        ),
    loading && listing === null
      ? h('div', { className: 'dshpw-hint' }, t('managedFilesLoading'))
      : listing !== null && listing.entries.length > 0
        ? h(
            'div',
            { className: 'dshpw-managed-files-list' },
            ...listing.entries.map((entry) => h(
              'div',
              { className: `dshpw-managed-files-row${dropTarget === entry.path ? ' dshpw-drop-target' : ''}`, key: entry.path,
                'data-managed-path': entry.path,
                draggable: !busy && !loading,
                onDragStart: (event: DragEvent<HTMLDivElement>) => {
                  if (busy || loading) { event.preventDefault(); return; }
                  dragged.current = entry; setDropTarget(null);
                  event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-dsh-managed-file', entry.path);
                },
                onDragEnd: () => { dragged.current = null; setDropTarget(null); },
                ...(entry.kind === 'directory' ? dropProps(entry.path) : {}),
              },
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
                  className: 'dshpw-btn sm dshpw-download-btn',
                  href: managedFileDownloadUrl(entry.path),
                  download: entry.name,
                }, t('managedFilesDownload')),
                h('button', {
                  type: 'button',
                  className: 'dshpw-btn ghost sm',
                  disabled: busy,
                  onClick: () => setClipboard({ path: entry.path, name: entry.name, kind: entry.kind, mode: 'move' }),
                }, t('managedFilesMove')),
                h('button', {
                  type: 'button',
                  className: 'dshpw-btn ghost sm',
                  disabled: busy,
                  onClick: () => setClipboard({ path: entry.path, name: entry.name, kind: entry.kind, mode: 'copy' }),
                }, t('managedFilesCopy')),
                h('button', {
                  type: 'button',
                  className: 'dshpw-btn danger sm',
                  disabled: busy,
                  onClick: () => remove(entry),
                }, t('managedFilesDelete')),
              ),
            )),
          )
        : h('div', { className: 'dshpw-hint' }, t('managedFilesEmpty')),
    gitOutput === '' ? null : h('pre', { className: 'dshpw-managed-files-output' }, gitOutput),
    listing?.truncated && h('div', { className: 'dshpw-hint' }, t('managedFilesTruncated')),
  );
}
