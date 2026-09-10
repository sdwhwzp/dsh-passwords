/** Searchable, paginated account directory. Editors mount only for the selected account. */
import { createElement as h, useState, type ReactNode, type SyntheticEvent } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { BudgetStatus, PermOverview, UserInfo } from './card';

export type AccountAction = 'permissions' | 'password' | 'rename';

interface Props extends PropsLocale<'dshpw'> {
  users: UserInfo[];
  overview: PermOverview | null;
  budgets: Record<number, BudgetStatus>;
  me: string;
  busy: boolean;
  refresh(): void;
  create(): void;
  edit(user: UserInfo, action: AccountAction): void;
  remove(user: UserInfo): void;
}

/** Render at most one page of accounts while retaining search and filter state after edits. */
export function AccountsTable({ t, users, overview, budgets, me, busy, refresh, create, edit, remove }: Props) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [role, setRole] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState('name');
  const permissions = new Map(overview?.users.map((u) => [u.id, u.permissions]));
  const filtered = users.filter((u) => {
    const banned = permissions.get(u.id)?.banned;
    return (u.username.toLowerCase().includes(query.trim().toLowerCase()) || String(u.id) === query.trim())
      && (role === 'all' || u.role === role)
      && (status === 'all' || (status === 'banned' ? banned === true : u.role === 'admin' || banned === false));
  }).sort((a, b) => {
    if (sort === 'recent') return (b.last_login_at ?? '').localeCompare(a.last_login_at ?? '') || b.id - a.id;
    if (sort === 'created') return b.id - a.id;
    return a.username.localeCompare(b.username, undefined, { numeric: true }) || a.id - b.id;
  });
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages);
  const rows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const select = (label: string, value: string, options: Array<[string, string]>, change: (value: string) => void) => h('label', { className: 'dshpw-filter' },
    h('span', null, label), h('select', { className: 'dshpw-input', value, onChange: (e: { target: { value: string } }) => { change(e.target.value); setPage(1); } },
      ...options.map(([id, title]) => h('option', { key: id, value: id }, title))));
  const money = (value: number) => `¥${(value / 1_000_000).toFixed(2)}`;
  return h('section', { className: 'dshpw-directory', 'aria-label': t('accountsTitle') },
    h('div', { className: 'dshpw-directory-heading' },
      h('div', null, h('h1', null, t('accountsTitle')), h('p', null, t('accountsDescription'))),
      h('div', { className: 'dshpw-directory-actions' },
        h('button', { className: 'dshpw-btn ghost', disabled: busy, onClick: refresh }, t('accountsRefresh')),
        h('button', { className: 'dshpw-btn', disabled: busy, onClick: create }, t('addSubTitle')))),
    h('div', { className: 'dshpw-directory-toolbar' },
      h('label', { className: 'dshpw-filter dshpw-search' }, h('span', null, t('accountsSearch')),
        h('input', { type: 'search', className: 'dshpw-input', value: query, placeholder: t('accountsSearchHint'), onChange: (e: { target: { value: string } }) => { setQuery(e.target.value); setPage(1); } })),
      select(t('accountsRole'), role, [['all', t('accountsAllRoles')], ['admin', t('owner')], ['user', t('subuser')]], setRole),
      select(t('accountsStatus'), status, [['all', t('accountsAllStatuses')], ['active', t('accountsActive')], ['banned', t('accountsBanned')]], setStatus),
      select(t('accountsSort'), sort, [['name', t('accountsName')], ['recent', t('accountsLastLogin')], ['created', t('accountsNewest')]], setSort)),
    h('div', { className: 'dshpw-table-scroll', tabIndex: 0, role: 'region', 'aria-label': t('accountsTitle') },
      h('table', { className: 'dshpw-account-table' },
        h('thead', null, h('tr', null, ...(['accountsName', 'accountsRole', 'accountsStatus', 'accountsBudget', 'accountsUsage', 'accountsLastLogin', 'accountsActions'] as const).map((key) => h('th', { key, scope: 'col' }, t(key))))),
        h('tbody', null, ...rows.map((u) => {
          const p = permissions.get(u.id);
          const budget = budgets[u.id];
          const action = (kind: AccountAction, label: string) => h('button', { className: 'dshpw-btn ghost sm', disabled: busy || (kind === 'permissions' && p === undefined), onClick: () => edit(u, kind), 'aria-label': `${label} · ${u.username}` }, label);
          return h('tr', { key: u.id, 'data-account-id': u.id },
            h('th', { scope: 'row' }, h('strong', null, u.username), h('small', null, `ID ${u.id}`, u.username === me ? ` · ${t('selfTag')}` : '')),
            h('td', null, h('span', { className: 'dshpw-chip' }, u.role === 'admin' ? t('owner') : t('subuser'))),
            h('td', null, h('span', { className: `dshpw-chip${p?.banned ? ' danger' : ''}` }, u.role === 'admin' || p ? (p?.banned ? t('accountsBanned') : t('accountsActive')) : '—')),
            h('td', { className: 'dshpw-money' }, u.role === 'admin' ? '—' : p?.monthlyBudgetMicros === null ? t('accountsUnlimited') : p ? money(p.monthlyBudgetMicros) : '—'),
            h('td', { className: 'dshpw-money' }, budget ? money(budget.usedMicros) : '—'),
            h('td', { className: 'dshpw-date' }, u.last_login_at ? new Date(u.last_login_at).toLocaleString(undefined, { hour12: false }) : t('neverLoggedIn')),
            h('td', null, h('div', { className: 'dshpw-row-actions' },
              u.role === 'user' ? action('permissions', t('accountsEdit')) : null,
              action('password', t('chgPw')), action('rename', t('chgName')),
              u.username !== me ? h('button', { className: 'dshpw-btn danger sm', disabled: busy, onClick: () => remove(u), 'aria-label': `${t('remove')} · ${u.username}` }, t('remove')) : null)));
        })))),
    rows.length === 0 ? h('p', { className: 'dshpw-empty', role: 'status' }, t('accountsNoResults')) : null,
    h('div', { className: 'dshpw-pagination' },
      h('span', { role: 'status' }, t('accountsCount', { count: filtered.length, total: users.length })),
      select(t('accountsPageSize'), String(pageSize), [25, 50, 100].map((n) => [String(n), String(n)]), (value) => setPageSize(Number(value))),
      h('button', { className: 'dshpw-btn ghost sm', disabled: currentPage === 1, onClick: () => setPage(currentPage - 1) }, t('accountsPrevious')),
      h('span', null, t('accountsPage', { page: currentPage, pages })),
      h('button', { className: 'dshpw-btn ghost sm', disabled: currentPage === pages, onClick: () => setPage(currentPage + 1) }, t('accountsNext'))));
}

/** Native modal provides focus containment, Escape handling and focus restoration. */
export function AccountDialog({ title, closeLabel, close, children }: { title: string; closeLabel: string; close(): void; children: ReactNode }) {
  return h('dialog', { className: 'dshpw-account-dialog', ref: (node: HTMLDialogElement | null) => { if (node && !node.open) node.showModal(); }, onCancel: (event: SyntheticEvent) => { event.preventDefault(); close(); }, 'aria-label': title },
    h('header', null, h('h2', null, title), h('button', { className: 'dshpw-btn ghost sm', onClick: close, 'aria-label': closeLabel }, closeLabel)), children);
}
