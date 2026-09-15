import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DESKTOP_IMAGE_MAX_HEIGHT,
  DESKTOP_IMAGE_MAX_WIDTH,
  assertDesktopControl,
  captureDesktopScreen,
  displayPointToImage,
  imagePointToDisplay,
  linuxInputArgv,
  linuxKeyCombination,
  parseDesktopInputArgs,
  parseScreenshotArgs,
  pngDimensions,
  reducedImageSize,
  sendDesktopInput,
  type DisplayGeometry,
} from '../src/local-workspace-desktop.js';

const laptop: DisplayGeometry = { index: 0, count: 2, x: 0, y: 0, width: 1440, height: 900 };
const secondary: DisplayGeometry = { index: 1, count: 2, x: 1440, y: -120, width: 3840, height: 2160 };

test('capture reduction keeps the aspect ratio inside both caps', () => {
  assert.deepEqual(reducedImageSize(1440, 900), { width: 1280, height: 800 });
  assert.deepEqual(reducedImageSize(1920, 1080), { width: 1280, height: 720 });
  assert.deepEqual(reducedImageSize(3840, 2160), { width: 1280, height: 720 });
  // A display taller than it is wide is bounded by the height cap, not the width cap.
  assert.deepEqual(reducedImageSize(1080, 1920), { width: 450, height: 800 });
  // A display already inside both caps is returned untouched rather than upscaled.
  assert.deepEqual(reducedImageSize(1024, 768), { width: 1024, height: 768 });
  for (const [width, height] of [[1440, 900], [1920, 1080], [3840, 2160], [1080, 1920], [800, 600]]) {
    const reduced = reducedImageSize(width!, height!);
    assert.ok(reduced.width <= DESKTOP_IMAGE_MAX_WIDTH && reduced.height <= DESKTOP_IMAGE_MAX_HEIGHT);
  }
});

test('screenshot coordinates map onto the display a capture came from', () => {
  assert.deepEqual(imagePointToDisplay([0, 0], laptop), { x: 0, y: 0 });
  assert.deepEqual(imagePointToDisplay([640, 400], laptop), { x: 720, y: 450 });
  assert.deepEqual(imagePointToDisplay([1279, 799], laptop), { x: 1439, y: 899 });
  // A secondary display is addressed in the global space, so its origin is added.
  assert.deepEqual(imagePointToDisplay([0, 0], secondary), { x: 1440, y: -120 });
  assert.deepEqual(imagePointToDisplay([640, 360], secondary), { x: 3360, y: 960 });
});

test('pointer positions come back in the capture the model measured', () => {
  assert.deepEqual(displayPointToImage({ x: 720, y: 450 }, laptop), { x: 640, y: 400 });
  assert.deepEqual(displayPointToImage({ x: 3360, y: 960 }, secondary), { x: 640, y: 360 });
  // A pointer parked outside the captured display is reported at its edge
  // instead of as a coordinate the model could not have measured.
  assert.deepEqual(displayPointToImage({ x: -50, y: -50 }, laptop), { x: 0, y: 0 });
  assert.deepEqual(displayPointToImage({ x: 9000, y: 9000 }, laptop), { x: 1279, y: 799 });
});

test('a capture is measured from its own PNG header', () => {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(1280, 16);
  png.writeUInt32BE(800, 20);
  assert.deepEqual(pngDimensions(png), { width: 1280, height: 800 });
  assert.throws(() => pngDimensions(Buffer.from('not an image')), /PNG/);
  assert.throws(() => pngDimensions(png.subarray(0, 20)), /PNG/);
});

test('input arguments are validated before anything reaches the desktop', () => {
  assert.deepEqual(parseScreenshotArgs({}), { display: 0 });
  assert.deepEqual(parseScreenshotArgs({ display: 1 }), { display: 1 });
  assert.throws(() => parseScreenshotArgs({ display: -1 }), /display/);
  assert.throws(() => parseScreenshotArgs({ display: 1.5 }), /display/);

  assert.deepEqual(parseDesktopInputArgs({ action: 'left_click' }), { action: 'left_click', display: 0 });
  assert.deepEqual(
    parseDesktopInputArgs({ action: 'mouse_move', coordinate: [10, 20] }),
    { action: 'mouse_move', display: 0, coordinate: [10, 20] },
  );
  assert.deepEqual(
    parseDesktopInputArgs({ action: 'scroll' , scrollDirection: 'down' }),
    { action: 'scroll', display: 0, scrollDirection: 'down', scrollAmount: 3 },
  );
  assert.deepEqual(
    parseDesktopInputArgs({ action: 'wait' }),
    { action: 'wait', display: 0, durationMs: 500 },
  );

  assert.throws(() => parseDesktopInputArgs({ action: 'reboot' }), /action/);
  assert.throws(() => parseDesktopInputArgs({ action: 'mouse_move' }), /需要 coordinate/);
  assert.throws(() => parseDesktopInputArgs({ action: 'left_click_drag' }), /需要 coordinate/);
  assert.throws(() => parseDesktopInputArgs({ action: 'type' }), /text/);
  assert.throws(() => parseDesktopInputArgs({ action: 'key', text: '' }), /text/);
  assert.throws(() => parseDesktopInputArgs({ action: 'scroll' }), /scrollDirection/);
  assert.throws(() => parseDesktopInputArgs({ action: 'scroll', scrollDirection: 'down', scrollAmount: 99 }), /scrollAmount/);
  assert.throws(() => parseDesktopInputArgs({ action: 'wait', durationMs: 60_000 }), /durationMs/);
  assert.throws(() => parseDesktopInputArgs({ action: 'left_click', coordinate: [1] }), /coordinate/);
  assert.throws(() => parseDesktopInputArgs({ action: 'left_click', coordinate: [-1, 5] }), /coordinate/);
});

test('Linux actions become one xdotool invocation each', () => {
  const at = { x: 720, y: 450 };
  const from = { x: 100, y: 100 };
  const argv = (args: Record<string, unknown>, point = at, start: { x: number; y: number } | null = null) =>
    linuxInputArgv(parseDesktopInputArgs(args), point, start);

  assert.deepEqual(argv({ action: 'mouse_move', coordinate: [640, 400] }), ['mousemove', '720', '450']);
  assert.deepEqual(argv({ action: 'left_click' }), ['mousemove', '720', '450', 'click', '1']);
  assert.deepEqual(argv({ action: 'right_click' }), ['mousemove', '720', '450', 'click', '3']);
  assert.deepEqual(argv({ action: 'middle_click' }), ['mousemove', '720', '450', 'click', '2']);
  assert.deepEqual(
    argv({ action: 'double_click' }),
    ['mousemove', '720', '450', 'click', '--repeat', '2', '--delay', '60', '1'],
  );
  assert.deepEqual(
    argv({ action: 'left_click_drag', coordinate: [640, 400] }, at, from),
    ['mousemove', '100', '100', 'mousedown', '1', 'mousemove', '720', '450', 'mouseup', '1'],
  );
  assert.deepEqual(
    argv({ action: 'scroll', scrollDirection: 'up', scrollAmount: 5 }),
    ['mousemove', '720', '450', 'click', '--repeat', '5', '--delay', '12', '4'],
  );
  assert.deepEqual(argv({ action: 'key', text: 'ctrl+c' }), ['key', '--clearmodifiers', 'ctrl+c']);
  assert.deepEqual(argv({ action: 'type', text: '你好' }), ['type', '--clearmodifiers', '--delay', '12', '--', '你好']);
  // A click with no coordinate acts where the pointer already is.
  assert.deepEqual(argv({ action: 'left_click' }, null as unknown as { x: number; y: number }), ['click', '1']);
  assert.equal(argv({ action: 'cursor_position' }), null);
  assert.equal(argv({ action: 'wait' }), null);
});

test('key names translate to X keysyms and reject unknown keys', () => {
  assert.equal(linuxKeyCombination('ctrl+c'), 'ctrl+c');
  assert.equal(linuxKeyCombination('cmd+shift+z'), 'super+shift+z');
  assert.equal(linuxKeyCombination('Return'), 'Return');
  assert.equal(linuxKeyCombination('pageup'), 'Prior');
  assert.equal(linuxKeyCombination('alt+F4'), 'alt+F4');
  assert.throws(() => linuxKeyCombination('ctrl+nosuchkey'), /无法识别的按键名/);
});

test('desktop operations are refused without their own grant', async () => {
  // Shell being on is deliberately not enough: the two grants are separate.
  const shellOnly = { shellEnabled: true, desktopControl: false };
  const isRefusal = (error: Error & { code?: string }) => error.code === 'DESKTOP_CONTROL_DISABLED';
  const signal = new AbortController().signal;

  assert.throws(() => assertDesktopControl(shellOnly), isRefusal);
  assert.doesNotThrow(() => assertDesktopControl({ desktopControl: true }));

  // The refusal precedes argument validation and any helper process, so an
  // ungranted connection cannot learn anything about the screen either.
  await assert.rejects(() => captureDesktopScreen(shellOnly, { display: 99 }, signal), isRefusal);
  await assert.rejects(() => sendDesktopInput(shellOnly, { action: 'nonsense' }, signal), isRefusal);
});
