/**
 * Quoting for the companion's command string.
 *
 * The companion runs one STRING through PowerShell on Windows and bash
 * elsewhere, so the Host builds that string from an argv. The two shells make
 * a single-quoted run literal but escape an embedded quote differently; using
 * one rule for both silently splits an argument, which for `git commit -m` or
 * a path with an apostrophe means the command runs with the wrong operands.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteForPlatform } from '../src/local-workspace-hub.ts';

test('every argument becomes one literal shell word on both platforms', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    assert.equal(quoteForPlatform('status', platform), "'status'");
    assert.equal(quoteForPlatform('--pretty=format:%H%x09%an', platform), "'--pretty=format:%H%x09%an'");
    // Characters the shells would otherwise act on stay inert inside the quotes.
    assert.equal(quoteForPlatform('a b;rm -rf /', platform), "'a b;rm -rf /'");
    assert.equal(quoteForPlatform('$HOME`x', platform), "'$HOME`x'");
  }
});

test('an embedded quote follows the platform rule instead of one shared guess', () => {
  // PowerShell doubles it; a POSIX shell closes the run, splices an escaped
  // quote, and reopens. Swapping these produces a word boundary mid-argument.
  assert.equal(quoteForPlatform("it's", 'win32'), "'it''s'");
  assert.equal(quoteForPlatform("it's", 'linux'), "'it'\\''s'");
});

test('a path with an apostrophe survives as one operand', () => {
  const posix = quoteForPlatform("/repo/Bob's Notes/a.md", 'linux');
  const windows = quoteForPlatform("C:\\repo\\Bob's Notes\\a.md", 'win32');
  // One opening and one closing quote at the ends: the middle never terminates.
  assert.ok(posix.startsWith("'") && posix.endsWith("'"));
  assert.ok(windows.startsWith("'") && windows.endsWith("'"));
  assert.equal(windows, "'C:\\repo\\Bob''s Notes\\a.md'");
});

test('an unknown platform string uses the POSIX rule, not the Windows one', () => {
  // The companion reports process.platform; anything that is not win32 runs
  // under /bin/bash, so the default must be the POSIX escape.
  assert.equal(quoteForPlatform("x'y", 'freebsd'), "'x'\\''y'");
});
