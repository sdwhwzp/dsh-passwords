import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { cordisRoot } from '../src/cordis-root.js';

test('symbol-keyed roots do not request an undeclared root service', () => {
  const owner = new Context();
  const child = new Proxy(owner, {
    get(target, key, receiver) {
      if (key === Symbol.for('cordis.root')) return owner;
      if (key === 'root') throw new Error('undeclared service');
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(cordisRoot(child), owner);
});

test('legacy scopes use their own root', () => {
  const owner = new Context();
  const child = new Proxy(owner, {
    get(target, key, receiver) {
      if (key === Symbol.for('cordis.root')) return undefined;
      if (key === 'root') return owner;
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(cordisRoot(child), owner);
});
