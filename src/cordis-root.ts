import type { Context } from '@deepseek-ai/cordis';

export function cordisRoot(context: Context): Context {
  const root = Reflect.get(context, Symbol.for('cordis.root')) ?? Reflect.get(context, 'root');
  if (root == null) throw new Error('Cordis root context is unavailable');
  return root;
}
