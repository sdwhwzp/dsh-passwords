import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope';

test('does an unscoped listener receive a carrier-dispatched agent/created?', async () => {
  const ctx = new Context();
  const seen: string[] = [];
  ctx.on('agent/created' as never, ((payload: { agent: { id: string } }) => {
    seen.push('root:' + payload.agent.id);
    return undefined;
  }) as never);

  const agent = { id: 'a1' } as never;
  // 1. plain emit, as the existing unit tests do
  ctx.emit('agent/created' as never, { agent } as never);
  console.log('  after plain emit      :', JSON.stringify(seen));

  // 2. serial through a scope carrier, as AgentRegistry.announce does
  seen.length = 0;
  await (ctx as never as { serial: (t: unknown, e: string, p: unknown) => Promise<unknown> })
    .serial(scopeTarget(agent, agent), 'agent/created', { agent });
  console.log('  after carrier serial  :', JSON.stringify(seen));

  // 3. same, but the agent owns a real scope first
  seen.length = 0;
  await ctx.plugin(Object.assign((inner: Context) => { createScope(inner, agent); }, { inject: [] }));
  await (ctx as never as { serial: (t: unknown, e: string, p: unknown) => Promise<unknown> })
    .serial(scopeTarget(agent, agent), 'agent/created', { agent });
  console.log('  with a real scope     :', JSON.stringify(seen));
  assert.ok(true);
});
