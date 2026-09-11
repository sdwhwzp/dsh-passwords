/** Inventory with explicit, account-scoped stop confirmation. */
import { createElement as h, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

interface Service { accountId: string; accountName: string; name: string; workspace: string; port: number; state: string; substate: string; enabled: boolean; listening: boolean; expose: boolean; restarts: number }
interface Inventory { me: { id: string; role: 'admin' | 'user'; username: string }; services: Service[] }

/** Render only the authenticated inventory returned by the gateway. */
export function ServicesPage({ t, onBack }: PropsLocale<'dshpw'> & { onBack?: () => void }) {
  const [data, setData] = useState<Inventory>();
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Service>();
  const [success, setSuccess] = useState('');
  const mounted = useRef(false);
  const refreshing = useRef(false);
  const stopping = useRef(false);
  const generation = useRef(0);
  const load = async () => {
    if (refreshing.current || stopping.current) return;
    refreshing.current = true;
    const requestGeneration = generation.current;
    try { const next = await api<Inventory>('/gateway/api/services'); if (mounted.current && requestGeneration === generation.current) { setData(next); setError(''); } }
    catch (failure) { if (mounted.current && requestGeneration === generation.current) setError((failure as { code?: string }).code === 'NOT_AUTHENTICATED' ? t('servicesLogin') : t('servicesLoadError')); }
    finally { refreshing.current = false; }
  };
  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 10000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, []);
  const stop = async () => {
    if (!selected || stopping.current) return;
    generation.current++;
    stopping.current = true; setBusy(true); setError(''); setSuccess('');
    try {
      const result = await api<{ service: Partial<Service> }>('/gateway/api/services/stop', { accountId: selected.accountId, name: selected.name });
      if (mounted.current) {
        setData(previous => previous && ({ ...previous, services: previous.services.map(service => service.accountId === selected.accountId && service.name === selected.name ? { ...service, ...result.service } : service) }));
        setSuccess(t('servicesStoppedMessage', { name: selected.name })); setSelected(undefined);
      }
      stopping.current = false;
      if (mounted.current) await load();
    } catch { if (mounted.current) setError(t('servicesStopError')); }
    finally { stopping.current = false; if (mounted.current) setBusy(false); }
  };
  const status = (service: Service) => service.state === 'active' ? 'running' : !service.enabled && service.state === 'inactive' ? 'stopped' : 'pending';
  const services = data?.services.filter(service => (filter === 'all' || status(service) === filter)
    && [service.accountName, service.accountId, service.name, service.workspace, String(service.port)].join(' ').toLowerCase().includes(search.toLowerCase())) ?? [];
  const labels = { running: t('servicesRunning'), stopped: t('servicesStopped'), pending: t('servicesPending') };
  return h('main', { className: 'services-page' },
    h('nav', null, onBack ? h('button', { type: 'button', onClick: onBack }, `← ${t('accountsBack')}`) : h('a', { href: '/' }, `← ${t('accountsBack')}`),
      onBack ? null : h('span', null, h('a', { href: '?lang=zh', lang: 'zh-CN' }, '中文'), ' / ', h('a', { href: '?lang=en', lang: 'en' }, 'English'))),
    h('header', null, h('div', null, h('h1', null, t('servicesTitle')), h('p', null, data?.me.role === 'admin' ? t('servicesAdminHint') : t('servicesUserHint'))),
      h('button', { type: 'button', disabled: busy, onClick: () => void load() }, t('accountsRefresh'))),
    h('p', { className: 'services-note' }, t('servicesLifetime')),
    error ? h('div', { role: 'alert', className: 'services-error' }, error) : null,
    success ? h('div', { role: 'status', className: 'services-success' }, success) : null,
    h('div', { className: 'services-filters' },
      h('input', { type: 'search', value: search, placeholder: t('servicesSearch'), 'aria-label': t('servicesSearch'), onChange: (event: React.ChangeEvent<HTMLInputElement>) => setSearch(event.target.value) }),
      h('select', { value: filter, 'aria-label': t('accountsStatus'), onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setFilter(event.target.value) },
        h('option', { value: 'all' }, t('accountsAllStatuses')), ...Object.entries(labels).map(([key, label]) => h('option', { key, value: key }, label))),
      h('span', null, t('servicesCount', { count: services.length }))),
    !data ? h('p', { role: 'status' }, error ? t('servicesRetry') : t('servicesLoading')) : services.length === 0 ? h('div', { className: 'services-empty' }, t('servicesEmpty')) :
      h('div', { className: 'services-table-scroll' }, h('table', null,
        h('thead', null, h('tr', null, [...(data.me.role === 'admin' ? [t('accountsName')] : []), t('servicesName'), t('servicesWorkspace'), t('servicesPort'), t('accountsStatus'), t('servicesRestarts'), t('accountsActions')].map(text => h('th', { key: text, scope: 'col' }, text)))),
        h('tbody', null, services.map(service => h('tr', { key: `${service.accountId}/${service.name}` },
          data.me.role === 'admin' ? h('td', null, service.accountName, h('small', null, `#${service.accountId}`)) : null,
          h('td', null, h('strong', null, service.name)), h('td', { className: 'services-workspace', title: service.workspace }, service.workspace),
          h('td', null, String(service.port), h('small', null, service.expose ? t('servicesExternal') : t('servicesLocal'))),
          h('td', null, h('span', { className: `services-badge ${status(service)}` }, labels[status(service)]),
            h('small', null, service.listening ? t('servicesListening') : t('servicesNoListener'))),
          h('td', null, String(service.restarts)), h('td', null, h('button', { type: 'button', className: 'services-stop', disabled: busy || status(service) === 'stopped', onClick: () => { setSelected(service); setSuccess(''); } }, t('servicesStop')))))))),
    selected ? h('div', { className: 'services-modal-backdrop' }, h('section', { className: 'services-modal', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'services-confirm-title', onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape' && !busy) setSelected(undefined);
      if (event.key === 'Tab') {
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    } },
      h('h2', { id: 'services-confirm-title' }, t('servicesConfirmTitle')), h('p', null, t('servicesConfirm', { name: selected.name, account: selected.accountName, port: selected.port })),
      h('p', { className: 'services-note' }, t('servicesStopHint')),
      h('div', { className: 'services-modal-actions' }, h('button', { type: 'button', autoFocus: true, disabled: busy, onClick: () => setSelected(undefined) }, t('servicesCancel')),
        h('button', { type: 'button', className: 'services-stop', disabled: busy, onClick: () => void stop() }, busy ? t('servicesStopping') : t('servicesConfirmStop'))))) : null,
  );
}
