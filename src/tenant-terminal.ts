/** Authenticated sidebar terminals confined by the deployment's root-owned launcher. */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import * as pty from 'node-pty';
import WebSocket, { WebSocketServer } from 'ws';
import type { PlatformConfig } from './config.js';
import type { Database } from './db.js';
import { DshPasswordsPrincipalAccessProvider } from './principal-access.js';
import { verifyPrincipalHeaders } from './principal.js';

/** Resolve a canonical directory below a canonical tenant root, rejecting sibling prefixes. */
export async function tenantDirectory(root: string, userId: string, cwd: string): Promise<string> {
  if (!/^[1-9][0-9]*$/.test(userId)) throw new Error('invalid tenant');
  const tenant = path.join(root, `u${userId}`);
  const [canonicalTenant, canonical] = await Promise.all([realpath(tenant), realpath(cwd)]);
  if (canonicalTenant !== tenant) throw new Error('invalid tenant root');
  const relative = path.relative(canonicalTenant, canonical);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('workspace access denied');
  return canonical;
}

interface Terminal {
  owner: string;
  cwd: string;
  process: pty.IPty;
  transcript: string;
  clients: Set<WebSocket>;
  timer?: ReturnType<typeof setTimeout>;
}

/** Register the private gateway target; every attach checks the durable session owner. */
export function registerTenantTerminal(ctx: Context, db: Database, config: PlatformConfig): void {
  const settings = config.tenantTerminal;
  if (!settings?.launcher) return;
  if (!path.isAbsolute(settings.launcher) || process.platform !== 'linux') throw new Error('tenant terminal requires a Linux launcher');
  const access = new DshPasswordsPrincipalAccessProvider(ctx, db);
  const terminals = new Map<string, Terminal>();
  const server = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const stop = (key: string): void => {
    const terminal = terminals.get(key);
    if (!terminal) return;
    terminals.delete(key);
    clearTimeout(terminal.timer);
    for (const client of terminal.clients) client.close(1000);
    terminal.process.kill();
  };
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/api/dsh-passwords/tenant-terminal',
    handler: (raw, socket, head) => {
      const req = raw as unknown as IncomingMessage;
      void (async () => {
        const principal = verifyPrincipalHeaders(req.headers, config.internalSecret);
        if (!principal || principal.role !== 'user') throw new Error('authenticated tenant required');
        const url = new URL(req.url ?? '/', 'http://localhost');
        const sessionId = url.searchParams.get('sessionId') as SessionId | null;
        const tab = url.searchParams.get('tab');
        if (!sessionId || !tab || tab.length > 160 || url.searchParams.has('uuid')) throw new Error('invalid terminal target');
        const allowed = await access.resolve(principal, { sessionIds: [sessionId] });
        if (!allowed.readableSessionIds.has(sessionId)) throw new Error('session access denied');
        const query = ctx.root.get('sessionQuery') as unknown as {
          listSessions(): Promise<Array<{ header: { id: string; cwd?: string } }>>;
        };
        const record = (await query.listSessions()).find(item => item.header.id === sessionId);
        if (!record?.header.cwd) throw new Error('session directory unavailable');
        const cwd = await tenantDirectory(config.managedWorkspaceRoot, principal.id, record.header.cwd);
        const hint = url.searchParams.get('cwd');
        if (hint !== null && await tenantDirectory(config.managedWorkspaceRoot, principal.id, hint) !== cwd) throw new Error('session directory mismatch');
        const key = JSON.stringify([principal.id, sessionId, tab]);
        let terminal = terminals.get(key);
        if (terminal && terminal.cwd !== cwd) { stop(key); terminal = undefined; }
        if (!terminal && [...terminals.values()].filter(item => item.owner === principal.id).length >= settings.maxPerUser) throw new Error('terminal limit reached');
        if (socket.destroyed) return;
        server.handleUpgrade(req, socket as unknown as Duplex, head as Buffer, ws => {
          if (!terminal) {
            const process = pty.spawn('/usr/bin/sudo', ['-n', '--', settings.launcher, principal.id, cwd], {
              name: 'xterm-256color', cols: 80, rows: 24, cwd: '/',
              env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'C.UTF-8' },
            });
            terminal = { owner: principal.id, cwd, process, transcript: '', clients: new Set() };
            terminals.set(key, terminal);
            const active = terminal;
            process.onData(data => {
              active.transcript = (active.transcript + data).slice(-1024 * 1024);
              for (const client of active.clients) {
                if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 4 * 1024 * 1024) client.send(data);
                else client.terminate();
              }
            });
            process.onExit(() => {
              if (terminals.get(key) === active) terminals.delete(key);
              clearTimeout(active.timer);
              for (const client of active.clients) client.close(1000);
            });
          }
          const active = terminal;
          clearTimeout(active.timer);
          active.clients.add(ws);
          if (active.transcript) ws.send(active.transcript);
          ws.on('error', () => ws.terminate());
          ws.on('message', data => {
            const text = data.toString('utf8');
            let control: { type?: string; cols?: number; rows?: number } | undefined;
            try { control = JSON.parse(text); } catch { /* Non-JSON frames are shell input. */ }
            if (control?.type === 'close') { stop(key); return; }
            if (control?.type === 'park') return;
            if (control?.type === 'resize') {
              if (Number.isInteger(control.cols) && Number.isInteger(control.rows) && control.cols! >= 2 && control.cols! <= 500 && control.rows! >= 2 && control.rows! <= 300) active.process.resize(control.cols!, control.rows!);
              return;
            }
            active.process.write(text);
          });
          ws.on('close', () => {
            active.clients.delete(ws);
            if (active.clients.size === 0 && terminals.get(key) === active) {
              active.timer = setTimeout(() => stop(key), settings.reconnectGraceMs);
              active.timer.unref();
            }
          });
        });
      })().catch(() => {
        if (!socket.destroyed) socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      });
    },
  }), 'dsh-passwords: tenant terminal');
  ctx.effect(() => () => { for (const key of terminals.keys()) stop(key); server.close(); }, 'dsh-passwords: terminal cleanup');
}
