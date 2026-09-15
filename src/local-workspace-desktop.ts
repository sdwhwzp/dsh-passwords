/**
 * Screen observation and input injection on the computer running the companion.
 *
 * These operations are gated by the separate `desktopControl` grant rather than
 * `shellEnabled`: a capture exposes every visible window, and injected input
 * reaches whichever window currently holds focus.
 *
 * The model works entirely in the returned screenshot's pixels. Every capture is
 * reduced to fit {@link DESKTOP_IMAGE_MAX_WIDTH} by {@link DESKTOP_IMAGE_MAX_HEIGHT},
 * and input coordinates are scaled back onto the display using the same
 * reduction, recomputed per call from the display's current size. Nothing is
 * remembered between calls, so a display that changes resolution between a
 * capture and a click is measured again rather than replayed from stale state.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionError } from './local-workspace-error.js';

/** Longest side kept in a returned capture, in image pixels. */
export const DESKTOP_IMAGE_MAX_WIDTH = 1280;
/** Tallest side kept in a returned capture, in image pixels. */
export const DESKTOP_IMAGE_MAX_HEIGHT = 800;

const SCREENSHOT_TIMEOUT_MS = 30_000;
const INPUT_TIMEOUT_MS = 30_000;
const MAX_SCREENSHOT_BASE64_BYTES = 2_000_000;
const MAX_HELPER_OUTPUT_BYTES = 4_000_000;
const MAX_TYPE_CHARS = 8_000;
const MAX_WAIT_MS = 5_000;
const MAX_SCROLL_AMOUNT = 30;

/** One display measured in the operating system's logical coordinate space. */
export interface DisplayGeometry {
  /** Zero-based index within the machine's display list. */
  index: number;
  /** Number of displays the machine reports. */
  count: number;
  /** Left edge in the global logical coordinate space. */
  x: number;
  /** Top edge in the global logical coordinate space. */
  y: number;
  width: number;
  height: number;
}

/** A capture reduced for a model request, with the mapping back to the display. */
export interface DesktopScreenshot {
  mediaType: 'image/png';
  /** Base64 PNG of the reduced capture. */
  data: string;
  /** Decoded byte count of `data`. */
  bytes: number;
  /** Reduced image width; model coordinates are measured in this space. */
  width: number;
  height: number;
  /** The display's logical width, which `width` was reduced from. */
  screenWidth: number;
  screenHeight: number;
  /** `screenWidth / width`; the companion applies it to incoming coordinates. */
  scale: number;
  display: number;
  displays: number;
}

/** The outcome of one input action, reported in the capture's pixel space. */
export interface DesktopInputResult {
  action: DesktopInputAction;
  /** Pointer position after the action, in reduced-image pixels. */
  cursor: { x: number; y: number };
  width: number;
  height: number;
  screenWidth: number;
  screenHeight: number;
  scale: number;
  display: number;
  displays: number;
}

/** Actions the companion accepts; names follow the widely trained computer-use vocabulary. */
export const DESKTOP_INPUT_ACTIONS = [
  'mouse_move',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'left_click_drag',
  'scroll',
  'key',
  'type',
  'cursor_position',
  'wait',
] as const;

export type DesktopInputAction = typeof DESKTOP_INPUT_ACTIONS[number];

/** One validated input action in the reduced image's coordinate space. */
export interface DesktopInputRequest {
  action: DesktopInputAction;
  coordinate?: readonly [number, number];
  startCoordinate?: readonly [number, number];
  text?: string;
  scrollDirection?: 'up' | 'down' | 'left' | 'right';
  scrollAmount?: number;
  durationMs?: number;
  display?: number;
}

/**
 * Reduce a display's logical size to the capture size used for model requests.
 * @param width - display width in logical units.
 * @param height - display height in logical units.
 * @returns the reduced image size; a display already within the cap is unchanged.
 */
export function reducedImageSize(width: number, height: number): { width: number; height: number } {
  const ratio = Math.min(1, DESKTOP_IMAGE_MAX_WIDTH / width, DESKTOP_IMAGE_MAX_HEIGHT / height);
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/**
 * Map a point measured on a reduced capture onto the global logical desktop.
 * @param point - coordinate in reduced-image pixels.
 * @param display - the display the capture came from.
 * @returns the rounded global logical coordinate the input APIs address.
 */
export function imagePointToDisplay(
  point: readonly [number, number],
  display: DisplayGeometry,
): { x: number; y: number } {
  const image = reducedImageSize(display.width, display.height);
  return {
    x: Math.round(display.x + point[0] * (display.width / image.width)),
    y: Math.round(display.y + point[1] * (display.height / image.height)),
  };
}

/**
 * Map a global logical desktop point back onto a reduced capture.
 * @param point - global logical coordinate reported by the operating system.
 * @param display - the display the capture came from.
 * @returns the rounded image coordinate, clamped to the capture.
 */
export function displayPointToImage(
  point: { x: number; y: number },
  display: DisplayGeometry,
): { x: number; y: number } {
  const image = reducedImageSize(display.width, display.height);
  const clamp = (value: number, limit: number) => Math.min(Math.max(value, 0), limit - 1);
  return {
    x: clamp(Math.round((point.x - display.x) * (image.width / display.width)), image.width),
    y: clamp(Math.round((point.y - display.y) * (image.height / display.height)), image.height),
  };
}

/**
 * Read a PNG's pixel size from its IHDR header.
 * @param bytes - the complete PNG file.
 * @returns the declared width and height.
 * @throws CompanionError when the bytes are not a PNG.
 */
export function pngDimensions(bytes: Buffer): { width: number; height: number } {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) {
    throw new CompanionError('截屏工具没有返回 PNG 图像', 'DESKTOP_CAPTURE_FAILED');
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * Run one short-lived helper process and return its standard output.
 * @param executable - helper to run.
 * @param argv - helper arguments.
 * @param options - optional standard input, deadline, cancellation and output cap.
 * @returns the decoded standard output.
 * @throws CompanionError when the helper is missing, cancelled, times out, or exits nonzero.
 */
async function runHelper(
  executable: string,
  argv: readonly string[],
  options: { stdin?: string; timeoutMs: number; signal: AbortSignal; code: string },
): Promise<string> {
  if (options.signal.aborted) throw new CompanionError('桌面操作已取消', 'ABORTED');
  // Every stream is piped so the tuple stays constant and Node's typings keep
  // the three streams non-null; a helper that reads nothing sees an immediate EOF.
  const child = spawn(executable, [...argv], {
    stdio: ['pipe', 'pipe', 'pipe'] as const,
    windowsHide: true,
  });
  const chunks: Buffer[] = [];
  let outBytes = 0;
  let overflowed = false;
  child.stdout.on('data', (chunk: Buffer) => {
    outBytes += chunk.length;
    if (outBytes > MAX_HELPER_OUTPUT_BYTES) {
      overflowed = true;
      child.kill('SIGKILL');
      return;
    }
    chunks.push(chunk);
  });
  const errors: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => {
    if (errors.length < 64) errors.push(chunk);
  });
  child.stdin.end(options.stdin ?? '');

  let timedOut = false;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    child.kill('SIGKILL');
  };
  options.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, options.timeoutMs);
  try {
    const exit = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
      child.once('error', (error: Error) => resolve({ code: null, error }));
      child.once('close', (code) => resolve({ code }));
    });
    if (aborted) throw new CompanionError('桌面操作已取消', 'ABORTED');
    if (timedOut) throw new CompanionError('桌面操作超时', 'TIMEOUT');
    if (overflowed) throw new CompanionError('桌面工具返回的数据过大', options.code);
    if (exit.error !== undefined) {
      const missing = (exit.error as NodeJS.ErrnoException).code === 'ENOENT';
      throw new CompanionError(
        missing ? `本机缺少桌面控制所需的 ${executable}` : `无法运行 ${executable}: ${exit.error.message}`,
        missing ? 'DESKTOP_HELPER_MISSING' : options.code,
      );
    }
    if (exit.code !== 0) {
      const detail = Buffer.concat(errors).toString('utf8').trim().slice(0, 600);
      throw new CompanionError(detail === '' ? `${executable} 执行失败` : detail, options.code);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', onAbort);
  }
}

/** Envelope every platform helper prints on success or handled failure. */
interface HelperEnvelope {
  ok?: boolean;
  code?: string;
  error?: string;
  value?: unknown;
}

/**
 * Decode one helper envelope.
 * @param text - the helper's standard output.
 * @param code - failure code used when the helper printed something unusable.
 * @returns the envelope's `value`.
 * @throws CompanionError carrying the helper's own code when it reported failure.
 */
function helperValue(text: string, code: string): Record<string, unknown> {
  let envelope: HelperEnvelope;
  try {
    envelope = JSON.parse(text.trim()) as HelperEnvelope;
  } catch {
    throw new CompanionError('桌面工具返回了无法解析的结果', code);
  }
  if (envelope.ok !== true) {
    throw new CompanionError(envelope.error ?? '桌面操作失败', envelope.code ?? code);
  }
  const value = envelope.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CompanionError('桌面工具返回了无法解析的结果', code);
  }
  return value as Record<string, unknown>;
}

/**
 * Read one required finite number from a helper result.
 * @param value - the helper result object.
 * @param name - field to read.
 * @param code - failure code used when the field is missing or not finite.
 * @returns the field value.
 */
function helperNumber(value: Record<string, unknown>, name: string, code: string): number {
  const found = value[name];
  if (typeof found !== 'number' || !Number.isFinite(found)) {
    throw new CompanionError(`桌面工具未返回 ${name}`, code);
  }
  return found;
}

/**
 * Windows screen capture and input injection, driven the same way as the Word
 * automation helper: one `-EncodedCommand` PowerShell run per operation that
 * reads a JSON request from standard input and prints one JSON envelope.
 *
 * `SetProcessDPIAware` runs before anything is measured, so display bounds and
 * pointer positions are the physical pixels the input APIs address rather than
 * the values Windows reports to a scaled process. `Get-Reduced` mirrors
 * {@link reducedImageSize}; `[Math]::Floor(x + 0.5)` is used because
 * `[Math]::Round` breaks ties to even and JavaScript does not.
 */
const WINDOWS_DESKTOP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-Success($Value) {
  [Console]::Out.Write((@{ ok = $true; value = $Value } | ConvertTo-Json -Depth 8 -Compress))
  exit 0
}

function Write-Failure([string]$Code, [string]$Message) {
  [Console]::Out.Write((@{ ok = $false; code = $Code; error = $Message } | ConvertTo-Json -Depth 4 -Compress))
  exit 0
}

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class DshDesktop {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] private static extern short VkKeyScan(char ch);

  [StructLayout(LayoutKind.Sequential)]
  private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  private struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  private struct INPUT { public uint type; public INPUTUNION u; }

  private const uint INPUT_MOUSE = 0;
  private const uint INPUT_KEYBOARD = 1;
  private const uint KEYEVENTF_KEYUP = 0x0002;
  private const uint KEYEVENTF_UNICODE = 0x0004;

  private static void Send(INPUT input) {
    INPUT[] batch = new INPUT[] { input };
    if (SendInput(1, batch, Marshal.SizeOf(typeof(INPUT))) == 0) {
      throw new InvalidOperationException("Windows 拒绝了输入注入，前台窗口可能以管理员身份运行");
    }
  }

  public static void Mouse(uint flags, int data) {
    INPUT input = new INPUT();
    input.type = INPUT_MOUSE;
    input.u.mi.dwFlags = flags;
    input.u.mi.mouseData = (uint)data;
    Send(input);
  }

  public static void Key(ushort vk, bool down) {
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.u.ki.wVk = vk;
    input.u.ki.dwFlags = down ? 0u : KEYEVENTF_KEYUP;
    Send(input);
  }

  public static void TypeText(string text) {
    foreach (char ch in text) {
      if (ch == '\r') { continue; }
      if (ch == '\n') { Key(0x0D, true); Key(0x0D, false); continue; }
      INPUT down = new INPUT();
      down.type = INPUT_KEYBOARD;
      down.u.ki.wScan = ch;
      down.u.ki.dwFlags = KEYEVENTF_UNICODE;
      Send(down);
      INPUT up = down;
      up.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
      Send(up);
    }
  }

  public static ushort KeyCodeFor(char ch) {
    short scan = VkKeyScan(ch);
    if (scan == -1) { throw new InvalidOperationException("当前键盘布局无法输入字符 " + ch); }
    return (ushort)(scan & 0xFF);
  }
}
"@

[void][DshDesktop]::SetProcessDPIAware()

$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$screens = [System.Windows.Forms.Screen]::AllScreens
$index = 0
if ($request.display -ne $null) { $index = [int]$request.display }
if ($index -lt 0 -or $index -ge $screens.Length) {
  Write-Failure 'DESKTOP_DISPLAY_NOT_FOUND' ('显示器序号超出范围，本机共有 ' + $screens.Length + ' 个显示器')
}
$bounds = $screens[$index].Bounds

function Get-Reduced([int]$w, [int]$h, [int]$maxW, [int]$maxH) {
  $ratio = [Math]::Min(1.0, [Math]::Min($maxW / [double]$w, $maxH / [double]$h))
  $iw = [Math]::Max(1, [int][Math]::Floor($w * $ratio + 0.5))
  $ih = [Math]::Max(1, [int][Math]::Floor($h * $ratio + 0.5))
  return @($iw, $ih)
}

$size = Get-Reduced $bounds.Width $bounds.Height ([int]$request.maxWidth) ([int]$request.maxHeight)

if ($request.kind -eq 'screenshot') {
  try {
    $shot = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($shot)
    $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
    $graphics.Dispose()
    $target = New-Object System.Drawing.Bitmap($size[0], $size[1])
    $scaler = [System.Drawing.Graphics]::FromImage($target)
    $scaler.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $scaler.DrawImage($shot, 0, 0, $size[0], $size[1])
    $scaler.Dispose()
    $stream = New-Object System.IO.MemoryStream
    $target.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $encoded = [Convert]::ToBase64String($stream.ToArray())
    $stream.Dispose(); $target.Dispose(); $shot.Dispose()
  } catch {
    Write-Failure 'DESKTOP_CAPTURE_FAILED' $_.Exception.Message
  }
  Write-Success @{
    data = $encoded; width = $size[0]; height = $size[1]
    screenWidth = $bounds.Width; screenHeight = $bounds.Height
    displayX = $bounds.X; displayY = $bounds.Y; displays = $screens.Length
  }
}

$VirtualKeys = @{
  'ctrl' = 0x11; 'control' = 0x11; 'alt' = 0x12; 'option' = 0x12; 'shift' = 0x10
  'win' = 0x5B; 'cmd' = 0x5B; 'command' = 0x5B; 'super' = 0x5B; 'meta' = 0x5B
  'enter' = 0x0D; 'return' = 0x0D; 'tab' = 0x09; 'esc' = 0x1B; 'escape' = 0x1B
  'space' = 0x20; 'backspace' = 0x08; 'delete' = 0x2E; 'insert' = 0x2D
  'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27
  'home' = 0x24; 'end' = 0x23; 'pageup' = 0x21; 'pagedown' = 0x22
  'capslock' = 0x14; 'printscreen' = 0x2C
}

function Resolve-Key([string]$name) {
  $key = $name.ToLowerInvariant()
  if ($VirtualKeys.ContainsKey($key)) { return [ushort]$VirtualKeys[$key] }
  if ($key -match '^f([1-9]|1[0-2])$') { return [ushort](0x70 + [int]$Matches[1] - 1) }
  if ($name.Length -eq 1) { return [DshDesktop]::KeyCodeFor($name[0]) }
  throw [InvalidOperationException]::new('无法识别的按键名 ' + $name)
}

function ConvertTo-Screen([double]$ix, [double]$iy) {
  $x = [int][Math]::Floor($bounds.X + $ix * ($bounds.Width / [double]$size[0]) + 0.5)
  $y = [int][Math]::Floor($bounds.Y + $iy * ($bounds.Height / [double]$size[1]) + 0.5)
  return @($x, $y)
}

function Move-Pointer {
  if ($request.x -ne $null -and $request.y -ne $null) {
    $point = ConvertTo-Screen ([double]$request.x) ([double]$request.y)
    [void][DshDesktop]::SetCursorPos($point[0], $point[1])
    Start-Sleep -Milliseconds 16
  }
}

try {
  switch ([string]$request.action) {
    'mouse_move' { Move-Pointer }
    'left_click' { Move-Pointer; [DshDesktop]::Mouse(0x0002, 0); [DshDesktop]::Mouse(0x0004, 0) }
    'right_click' { Move-Pointer; [DshDesktop]::Mouse(0x0008, 0); [DshDesktop]::Mouse(0x0010, 0) }
    'middle_click' { Move-Pointer; [DshDesktop]::Mouse(0x0020, 0); [DshDesktop]::Mouse(0x0040, 0) }
    'double_click' {
      Move-Pointer
      [DshDesktop]::Mouse(0x0002, 0); [DshDesktop]::Mouse(0x0004, 0)
      Start-Sleep -Milliseconds 60
      [DshDesktop]::Mouse(0x0002, 0); [DshDesktop]::Mouse(0x0004, 0)
    }
    'left_click_drag' {
      if ($request.startX -ne $null -and $request.startY -ne $null) {
        $from = ConvertTo-Screen ([double]$request.startX) ([double]$request.startY)
        [void][DshDesktop]::SetCursorPos($from[0], $from[1])
        Start-Sleep -Milliseconds 40
      }
      [DshDesktop]::Mouse(0x0002, 0)
      Start-Sleep -Milliseconds 40
      $to = ConvertTo-Screen ([double]$request.x) ([double]$request.y)
      [void][DshDesktop]::SetCursorPos($to[0], $to[1])
      Start-Sleep -Milliseconds 40
      [DshDesktop]::Mouse(0x0004, 0)
    }
    'scroll' {
      Move-Pointer
      $direction = [string]$request.scrollDirection
      for ($i = 0; $i -lt [int]$request.scrollAmount; $i++) {
        if ($direction -eq 'up') { [DshDesktop]::Mouse(0x0800, 120) }
        elseif ($direction -eq 'down') { [DshDesktop]::Mouse(0x0800, -120) }
        elseif ($direction -eq 'right') { [DshDesktop]::Mouse(0x1000, 120) }
        else { [DshDesktop]::Mouse(0x1000, -120) }
        Start-Sleep -Milliseconds 12
      }
    }
    'key' {
      $codes = @()
      foreach ($part in ([string]$request.text).Split('+')) { $codes += (Resolve-Key $part.Trim()) }
      foreach ($code in $codes) { [DshDesktop]::Key($code, $true); Start-Sleep -Milliseconds 10 }
      for ($i = $codes.Length - 1; $i -ge 0; $i--) { [DshDesktop]::Key($codes[$i], $false); Start-Sleep -Milliseconds 10 }
    }
    'type' { [DshDesktop]::TypeText([string]$request.text) }
    'cursor_position' { }
    'wait' { Start-Sleep -Milliseconds ([int]$request.durationMs) }
    default { Write-Failure 'DESKTOP_INPUT_FAILED' ('不支持的桌面动作 ' + [string]$request.action) }
  }
} catch {
  Write-Failure 'DESKTOP_INPUT_FAILED' $_.Exception.Message
}

$cursor = [System.Windows.Forms.Cursor]::Position
Write-Success @{
  cursorX = $cursor.X; cursorY = $cursor.Y
  screenWidth = $bounds.Width; screenHeight = $bounds.Height
  displayX = $bounds.X; displayY = $bounds.Y; displays = $screens.Length
}
`

/**
 * macOS screen geometry and input injection, run through `osascript -l JavaScript`.
 *
 * Geometry comes from `CGDisplayBounds` rather than `NSScreen`, because Quartz
 * event coordinates and Cocoa frames disagree on the origin corner: only the
 * Quartz values address the same points `CGEventPost` delivers to.
 *
 * `CGEventPost` is silently discarded when the process is not trusted for
 * Accessibility, so `AXIsProcessTrusted` is reported with every result and the
 * caller refuses the action instead of returning a success that did nothing.
 * `reduce` mirrors {@link reducedImageSize}.
 */
const MACOS_DESKTOP_SCRIPT = String.raw`
ObjC.import('CoreGraphics');
ObjC.import('ApplicationServices');
ObjC.import('Foundation');

var KEY_CODES = {
  'return': 36, 'enter': 36, 'tab': 48, 'space': 49, 'backspace': 51, 'delete': 117,
  'escape': 53, 'esc': 53, 'home': 115, 'end': 119, 'pageup': 116, 'pagedown': 121,
  'left': 123, 'right': 124, 'down': 125, 'up': 126, 'capslock': 57,
  'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118, 'f5': 96, 'f6': 97,
  'f7': 98, 'f8': 100, 'f9': 101, 'f10': 109, 'f11': 103, 'f12': 111,
  'a': 0, 'b': 11, 'c': 8, 'd': 2, 'e': 14, 'f': 3, 'g': 5, 'h': 4, 'i': 34,
  'j': 38, 'k': 40, 'l': 37, 'm': 46, 'n': 45, 'o': 31, 'p': 35, 'q': 12, 'r': 15,
  's': 1, 't': 17, 'u': 32, 'v': 9, 'w': 13, 'x': 7, 'y': 16, 'z': 6,
  '0': 29, '1': 18, '2': 19, '3': 20, '4': 21, '5': 23, '6': 22, '7': 26, '8': 28, '9': 25,
  '-': 27, '=': 24, '[': 33, ']': 30, '\\': 42, ';': 41, "'": 39, ',': 43, '.': 47, '/': 44, 'grave': 50
};

var MODIFIER_FLAGS = {
  'cmd': 0x100000, 'command': 0x100000, 'meta': 0x100000, 'super': 0x100000, 'win': 0x100000,
  'shift': 0x20000, 'alt': 0x80000, 'option': 0x80000,
  'ctrl': 0x40000, 'control': 0x40000
};

function displayList() {
  var ids = Ref();
  var count = Ref();
  $.CGGetActiveDisplayList(16, ids, count);
  var list = [];
  for (var i = 0; i < count[0]; i++) {
    var bounds = $.CGDisplayBounds(ids[i]);
    list.push({
      id: ids[i],
      x: bounds.origin.x, y: bounds.origin.y,
      width: bounds.size.width, height: bounds.size.height
    });
  }
  return list;
}

function reduce(width, height, maxWidth, maxHeight) {
  var ratio = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio))
  };
}

function cursorPoint() {
  var location = $.CGEventGetLocation($.CGEventCreate($()));
  return { x: location.x, y: location.y };
}

function moveTo(point) {
  $.CGEventPost(0, $.CGEventCreateMouseEvent($(), 5, $.CGPointMake(point.x, point.y), 0));
}

function clickAt(point, button, clicks) {
  var downType = button === 1 ? 3 : button === 2 ? 25 : 1;
  var upType = button === 1 ? 4 : button === 2 ? 26 : 2;
  for (var index = 1; index <= clicks; index++) {
    var down = $.CGEventCreateMouseEvent($(), downType, $.CGPointMake(point.x, point.y), button);
    $.CGEventSetIntegerValueField(down, 1, index);
    $.CGEventPost(0, down);
    var up = $.CGEventCreateMouseEvent($(), upType, $.CGPointMake(point.x, point.y), button);
    $.CGEventSetIntegerValueField(up, 1, index);
    $.CGEventPost(0, up);
    if (index < clicks) { delay(0.06); }
  }
}

function typeText(text) {
  var chunkSize = 20;
  for (var offset = 0; offset < text.length; offset += chunkSize) {
    var chunk = text.slice(offset, offset + chunkSize);
    var units = [];
    for (var i = 0; i < chunk.length; i++) { units.push(chunk.charCodeAt(i)); }
    var down = $.CGEventCreateKeyboardEvent($(), 0, true);
    $.CGEventKeyboardSetUnicodeString(down, units.length, $(units));
    $.CGEventPost(0, down);
    var up = $.CGEventCreateKeyboardEvent($(), 0, false);
    $.CGEventKeyboardSetUnicodeString(up, units.length, $(units));
    $.CGEventPost(0, up);
    delay(0.01);
  }
}

function pressCombination(combination) {
  var flags = 0;
  var target = null;
  var parts = combination.split('+');
  for (var i = 0; i < parts.length; i++) {
    var name = parts[i].trim().toLowerCase();
    if (name === '') { continue; }
    if (MODIFIER_FLAGS[name] !== undefined) { flags |= MODIFIER_FLAGS[name]; continue; }
    var code = KEY_CODES[name];
    if (code === undefined) { throw new Error('无法识别的按键名 ' + parts[i].trim()); }
    target = code;
  }
  if (target === null) { throw new Error('按键组合缺少主键: ' + combination); }
  var down = $.CGEventCreateKeyboardEvent($(), target, true);
  $.CGEventSetFlags(down, flags);
  $.CGEventPost(0, down);
  delay(0.02);
  var up = $.CGEventCreateKeyboardEvent($(), target, false);
  $.CGEventSetFlags(up, flags);
  $.CGEventPost(0, up);
}

function run(argv) {
  var request;
  try {
    request = JSON.parse(argv[0]);
  } catch (error) {
    return JSON.stringify({ ok: false, code: 'DESKTOP_INPUT_FAILED', error: '桌面请求不是有效 JSON' });
  }
  var displays = displayList();
  if (request.kind === 'displays') {
    return JSON.stringify({ ok: true, value: { displays: displays, trusted: $.AXIsProcessTrusted() } });
  }
  var index = request.display === undefined || request.display === null ? 0 : request.display;
  if (index < 0 || index >= displays.length) {
    return JSON.stringify({
      ok: false, code: 'DESKTOP_DISPLAY_NOT_FOUND',
      error: '显示器序号超出范围，本机共有 ' + displays.length + ' 个显示器'
    });
  }
  var display = displays[index];
  if (!$.AXIsProcessTrusted()) {
    return JSON.stringify({
      ok: false, code: 'DESKTOP_PERMISSION_REQUIRED',
      error: 'macOS 未授予「辅助功能」权限，鼠标键盘操作会被系统静默丢弃。请在「系统设置 → 隐私与安全性 → 辅助功能」中勾选本应用。'
    });
  }
  var image = reduce(display.width, display.height, request.maxWidth, request.maxHeight);
  var toScreen = function (ix, iy) {
    return {
      x: Math.round(display.x + ix * (display.width / image.width)),
      y: Math.round(display.y + iy * (display.height / image.height))
    };
  };
  var hasPoint = request.x !== undefined && request.x !== null && request.y !== undefined && request.y !== null;
  var target = hasPoint ? toScreen(request.x, request.y) : cursorPoint();
  try {
    switch (request.action) {
      case 'mouse_move': if (hasPoint) { moveTo(target); } break;
      case 'left_click': if (hasPoint) { moveTo(target); delay(0.02); } clickAt(target, 0, 1); break;
      case 'right_click': if (hasPoint) { moveTo(target); delay(0.02); } clickAt(target, 1, 1); break;
      case 'middle_click': if (hasPoint) { moveTo(target); delay(0.02); } clickAt(target, 2, 1); break;
      case 'double_click': if (hasPoint) { moveTo(target); delay(0.02); } clickAt(target, 0, 2); break;
      case 'left_click_drag': {
        var from = request.startX === undefined || request.startX === null
          ? cursorPoint() : toScreen(request.startX, request.startY);
        moveTo(from);
        delay(0.04);
        $.CGEventPost(0, $.CGEventCreateMouseEvent($(), 1, $.CGPointMake(from.x, from.y), 0));
        delay(0.04);
        $.CGEventPost(0, $.CGEventCreateMouseEvent($(), 6, $.CGPointMake(target.x, target.y), 0));
        delay(0.04);
        $.CGEventPost(0, $.CGEventCreateMouseEvent($(), 2, $.CGPointMake(target.x, target.y), 0));
        break;
      }
      case 'scroll': {
        if (hasPoint) { moveTo(target); delay(0.02); }
        var vertical = request.scrollDirection === 'up' ? 1 : request.scrollDirection === 'down' ? -1 : 0;
        var horizontal = request.scrollDirection === 'right' ? 1 : request.scrollDirection === 'left' ? -1 : 0;
        for (var tick = 0; tick < request.scrollAmount; tick++) {
          $.CGEventPost(0, $.CGEventCreateScrollWheelEvent2($(), 1, 2, vertical, horizontal, 0));
          delay(0.012);
        }
        break;
      }
      case 'key': pressCombination(String(request.text)); break;
      case 'type': typeText(String(request.text)); break;
      case 'cursor_position': break;
      case 'wait': delay(request.durationMs / 1000); break;
      default:
        return JSON.stringify({
          ok: false, code: 'DESKTOP_INPUT_FAILED', error: '不支持的桌面动作 ' + request.action
        });
    }
  } catch (error) {
    return JSON.stringify({ ok: false, code: 'DESKTOP_INPUT_FAILED', error: String(error.message || error) });
  }
  // CGEventPost returns before the window server has delivered the event, so
  // reading the pointer immediately reports its position before the action.
  delay(0.05);
  var cursor = cursorPoint();
  return JSON.stringify({
    ok: true,
    value: {
      cursorX: cursor.x, cursorY: cursor.y,
      screenWidth: display.width, screenHeight: display.height,
      displayX: display.x, displayY: display.y, displays: displays.length
    }
  });
}
`

/** Executable used for the Windows helper; the test override mirrors the Office automation path. */
function powershellExecutable(): string {
  return process.env.DSH_LOCAL_WORKSPACE_TEST_WINDOWS === '1'
    ? process.env.DSH_LOCAL_WORKSPACE_TEST_POWERSHELL ?? 'powershell.exe'
    : 'powershell.exe';
}

/**
 * Run the Windows helper once.
 * @param request - the helper request object.
 * @param timeoutMs - deadline for the PowerShell run.
 * @param signal - cancellation for the run.
 * @param code - failure code used when the helper output is unusable.
 * @returns the helper's result object.
 */
async function runWindowsHelper(
  request: Record<string, unknown>,
  timeoutMs: number,
  signal: AbortSignal,
  code: string,
): Promise<Record<string, unknown>> {
  const encoded = Buffer.from(WINDOWS_DESKTOP_SCRIPT, 'utf16le').toString('base64');
  const text = await runHelper(
    powershellExecutable(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { stdin: JSON.stringify(request), timeoutMs, signal, code },
  );
  return helperValue(text, code);
}

/**
 * Run the macOS helper once.
 * @param request - the helper request object.
 * @param timeoutMs - deadline for the osascript run.
 * @param signal - cancellation for the run.
 * @param code - failure code used when the helper output is unusable.
 * @returns the helper's result object.
 */
async function runMacosHelper(
  request: Record<string, unknown>,
  timeoutMs: number,
  signal: AbortSignal,
  code: string,
): Promise<Record<string, unknown>> {
  const text = await runHelper(
    'osascript',
    ['-l', 'JavaScript', '-e', MACOS_DESKTOP_SCRIPT, JSON.stringify(request)],
    { timeoutMs, signal, code },
  );
  return helperValue(text, code);
}

/**
 * Build a display record from a helper result.
 * @param value - helper result carrying the display's logical geometry.
 * @param index - the requested display index.
 * @param code - failure code used when a field is missing.
 * @returns the display the operation addressed.
 */
function geometryFromHelper(value: Record<string, unknown>, index: number, code: string): DisplayGeometry {
  return {
    index,
    count: helperNumber(value, 'displays', code),
    x: helperNumber(value, 'displayX', code),
    y: helperNumber(value, 'displayY', code),
    width: helperNumber(value, 'screenWidth', code),
    height: helperNumber(value, 'screenHeight', code),
  };
}

/**
 * Measure the macOS displays and select the requested one.
 * @param display - zero-based display index.
 * @param signal - cancellation for the helper run.
 * @param code - failure code used when the helper output is unusable.
 * @returns the selected display's logical geometry.
 */
async function macosDisplay(display: number, signal: AbortSignal, code: string): Promise<DisplayGeometry> {
  const value = await runMacosHelper({ kind: 'displays' }, SCREENSHOT_TIMEOUT_MS, signal, code);
  const list = value.displays;
  if (!Array.isArray(list) || list.length === 0) {
    throw new CompanionError('本机没有报告任何可用显示器', code);
  }
  if (display >= list.length) {
    throw new CompanionError(`显示器序号超出范围，本机共有 ${String(list.length)} 个显示器`, 'DESKTOP_DISPLAY_NOT_FOUND');
  }
  const entry = list[display] as Record<string, unknown>;
  return {
    index: display,
    count: list.length,
    x: helperNumber(entry, 'x', code),
    y: helperNumber(entry, 'y', code),
    width: helperNumber(entry, 'width', code),
    height: helperNumber(entry, 'height', code),
  };
}

/**
 * Capture and reduce one macOS display.
 *
 * `screencapture` writes the display's backing pixels, which are twice the
 * logical size on a Retina display, so the image is measured from its own PNG
 * header and resized with `sips` to the size derived from the logical geometry.
 * @param display - the display to capture.
 * @param signal - cancellation for the helper runs.
 * @returns the reduced PNG bytes.
 */
async function macosCapture(display: DisplayGeometry, signal: AbortSignal): Promise<Buffer> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-desktop-'));
  const file = path.join(directory, 'screen.png');
  try {
    await runHelper(
      'screencapture',
      ['-x', '-t', 'png', '-D', String(display.index + 1), file],
      { timeoutMs: SCREENSHOT_TIMEOUT_MS, signal, code: 'DESKTOP_CAPTURE_FAILED' },
    );
    const captured = await readFile(file);
    const size = pngDimensions(captured);
    const target = reducedImageSize(display.width, display.height);
    if (size.width === target.width && size.height === target.height) return captured;
    const reduced = path.join(directory, 'reduced.png');
    await runHelper(
      'sips',
      ['-z', String(target.height), String(target.width), file, '--out', reduced],
      { timeoutMs: SCREENSHOT_TIMEOUT_MS, signal, code: 'DESKTOP_CAPTURE_FAILED' },
    );
    return await readFile(reduced);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Capture programs tried on Linux, in the order they are attempted. */
const LINUX_CAPTURE_COMMANDS: readonly { executable: string; argv: (file: string) => string[] }[] = [
  { executable: 'import', argv: (file) => ['-window', 'root', file] },
  { executable: 'gnome-screenshot', argv: (file) => ['-f', file] },
  { executable: 'grim', argv: (file) => [file] },
  { executable: 'spectacle', argv: (file) => ['-b', '-n', '-o', file] },
];

/** X keysym names for the canonical key names the input action accepts. */
const LINUX_KEYSYMS: Readonly<Record<string, string>> = {
  enter: 'Return', return: 'Return', tab: 'Tab', space: 'space', escape: 'Escape', esc: 'Escape',
  backspace: 'BackSpace', delete: 'Delete', insert: 'Insert', capslock: 'Caps_Lock',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next', grave: 'grave',
  ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift',
  cmd: 'super', command: 'super', win: 'super', super: 'super', meta: 'super',
};

/**
 * Translate one key combination into the `xdotool key` spelling.
 * @param combination - canonical key names joined by `+`.
 * @returns the combination in X keysym names.
 * @throws CompanionError when a part names no known key.
 */
export function linuxKeyCombination(combination: string): string {
  return combination.split('+').map((part) => {
    const name = part.trim();
    const lower = name.toLowerCase();
    if (LINUX_KEYSYMS[lower] !== undefined) return LINUX_KEYSYMS[lower];
    if (/^f([1-9]|1[0-2])$/.test(lower)) return lower.toUpperCase();
    if (name.length === 1) return name;
    throw new CompanionError(`无法识别的按键名 ${name}`, 'DESKTOP_INPUT_FAILED');
  }).join('+');
}

/**
 * Measure the Linux desktop through xdotool.
 * @param display - zero-based display index; only the single X screen is addressable.
 * @param signal - cancellation for the helper run.
 * @returns the desktop's geometry.
 */
async function linuxDisplay(display: number, signal: AbortSignal): Promise<DisplayGeometry> {
  if (display !== 0) {
    throw new CompanionError('Linux 的本机助手只支持默认显示器', 'DESKTOP_DISPLAY_NOT_FOUND');
  }
  const text = await runHelper('xdotool', ['getdisplaygeometry'], {
    timeoutMs: INPUT_TIMEOUT_MS, signal, code: 'DESKTOP_INPUT_FAILED',
  });
  const parts = text.trim().split(/\s+/);
  const width = Number(parts[0]);
  const height = Number(parts[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new CompanionError('xdotool 未能报告桌面尺寸', 'DESKTOP_INPUT_FAILED');
  }
  return { index: 0, count: 1, x: 0, y: 0, width, height };
}

/**
 * Read the Linux pointer position through xdotool.
 * @param signal - cancellation for the helper run.
 * @returns the pointer position in global coordinates.
 */
async function linuxCursor(signal: AbortSignal): Promise<{ x: number; y: number }> {
  const text = await runHelper('xdotool', ['getmouselocation', '--shell'], {
    timeoutMs: INPUT_TIMEOUT_MS, signal, code: 'DESKTOP_INPUT_FAILED',
  });
  const x = /^X=(-?\d+)$/m.exec(text)?.[1];
  const y = /^Y=(-?\d+)$/m.exec(text)?.[1];
  if (x === undefined || y === undefined) {
    throw new CompanionError('xdotool 未能报告指针位置', 'DESKTOP_INPUT_FAILED');
  }
  return { x: Number(x), y: Number(y) };
}

/**
 * Capture and reduce the Linux desktop.
 * @param target - the reduced size the capture is resized to.
 * @param signal - cancellation for the helper runs.
 * @returns the reduced PNG bytes.
 */
async function linuxCapture(target: { width: number; height: number }, signal: AbortSignal): Promise<Buffer> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-desktop-'));
  const file = path.join(directory, 'screen.png');
  try {
    let captured: Buffer | undefined;
    const attempts: string[] = [];
    for (const command of LINUX_CAPTURE_COMMANDS) {
      try {
        await runHelper(command.executable, command.argv(file), {
          timeoutMs: SCREENSHOT_TIMEOUT_MS, signal, code: 'DESKTOP_CAPTURE_FAILED',
        });
        captured = await readFile(file);
        break;
      } catch (error) {
        if (error instanceof CompanionError && (error.code === 'ABORTED' || error.code === 'TIMEOUT')) throw error;
        attempts.push(`${command.executable}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (captured === undefined) {
      throw new CompanionError(
        `本机没有可用的截屏程序（已尝试 ${LINUX_CAPTURE_COMMANDS.map((item) => item.executable).join('、')}）。`
        + `请安装 ImageMagick 或 gnome-screenshot。\n${attempts.join('\n')}`,
        'DESKTOP_HELPER_MISSING',
      );
    }
    const size = pngDimensions(captured);
    if (size.width === target.width && size.height === target.height) return captured;
    const reduced = path.join(directory, 'reduced.png');
    for (const resizer of ['magick', 'convert']) {
      try {
        await runHelper(resizer, [file, '-resize', `${String(target.width)}x${String(target.height)}!`, reduced], {
          timeoutMs: SCREENSHOT_TIMEOUT_MS, signal, code: 'DESKTOP_CAPTURE_FAILED',
        });
        return await readFile(reduced);
      } catch (error) {
        if (error instanceof CompanionError && (error.code === 'ABORTED' || error.code === 'TIMEOUT')) throw error;
      }
    }
    // An unreduced capture is still usable while it fits the frame the host accepts.
    if (captured.length <= MAX_SCREENSHOT_BASE64_BYTES) return captured;
    throw new CompanionError('本机缺少 ImageMagick，无法把截屏缩小到可传输的尺寸', 'DESKTOP_HELPER_MISSING');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** xdotool click button numbers for the scroll directions. */
const LINUX_SCROLL_BUTTONS: Readonly<Record<'up' | 'down' | 'left' | 'right', string>> = {
  up: '4', down: '5', left: '6', right: '7',
};

/**
 * Build the single xdotool invocation that performs one action.
 * @param request - the validated action.
 * @param point - the action's target in global desktop coordinates, when it has one.
 * @param start - the drag origin in global desktop coordinates, when one was given.
 * @returns the xdotool arguments, or null when the action needs no xdotool run.
 */
export function linuxInputArgv(
  request: DesktopInputRequest,
  point: { x: number; y: number } | null,
  start: { x: number; y: number } | null,
): string[] | null {
  const move = point === null ? [] : ['mousemove', String(point.x), String(point.y)];
  switch (request.action) {
    case 'mouse_move':
      return point === null ? null : move;
    case 'left_click':
      return [...move, 'click', '1'];
    case 'right_click':
      return [...move, 'click', '3'];
    case 'middle_click':
      return [...move, 'click', '2'];
    case 'double_click':
      return [...move, 'click', '--repeat', '2', '--delay', '60', '1'];
    case 'left_click_drag': {
      if (point === null) return null;
      const from = start === null ? [] : ['mousemove', String(start.x), String(start.y)];
      return [...from, 'mousedown', '1', 'mousemove', String(point.x), String(point.y), 'mouseup', '1'];
    }
    case 'scroll':
      return [
        ...move, 'click', '--repeat', String(request.scrollAmount ?? 1), '--delay', '12',
        LINUX_SCROLL_BUTTONS[request.scrollDirection ?? 'down'],
      ];
    case 'key':
      return ['key', '--clearmodifiers', linuxKeyCombination(request.text ?? '')];
    case 'type':
      return ['type', '--clearmodifiers', '--delay', '12', '--', request.text ?? ''];
    case 'cursor_position':
    case 'wait':
      return null;
  }
}

/**
 * Perform one action on Linux and report the resulting pointer position.
 * @param request - the validated action.
 * @param display - the measured desktop.
 * @param signal - cancellation for the helper runs.
 * @returns the pointer position in global desktop coordinates.
 */
async function linuxInput(
  request: DesktopInputRequest,
  display: DisplayGeometry,
  signal: AbortSignal,
): Promise<{ x: number; y: number }> {
  const point = request.coordinate === undefined ? null : imagePointToDisplay(request.coordinate, display);
  const start = request.startCoordinate === undefined ? null : imagePointToDisplay(request.startCoordinate, display);
  const argv = linuxInputArgv(request, point, start);
  if (argv !== null) {
    await runHelper('xdotool', argv, { timeoutMs: INPUT_TIMEOUT_MS, signal, code: 'DESKTOP_INPUT_FAILED' });
  }
  if (request.action === 'wait') {
    await new Promise<void>((resolve) => setTimeout(resolve, request.durationMs ?? 0));
  }
  return await linuxCursor(signal);
}

/**
 * Validate the arguments of one screenshot request.
 * @param args - the raw operation arguments.
 * @returns the display index to capture.
 * @throws CompanionError when `display` is not a small non-negative integer.
 */
export function parseScreenshotArgs(args: Record<string, unknown>): { display: number } {
  return { display: parseDisplay(args.display) };
}

/**
 * Validate the arguments of one input request.
 * @param args - the raw operation arguments.
 * @returns the action in the reduced capture's coordinate space.
 * @throws CompanionError when the action or one of its arguments is unusable.
 */
export function parseDesktopInputArgs(args: Record<string, unknown>): DesktopInputRequest {
  const action = args.action;
  if (typeof action !== 'string' || !(DESKTOP_INPUT_ACTIONS as readonly string[]).includes(action)) {
    throw new CompanionError(
      `action 必须是 ${DESKTOP_INPUT_ACTIONS.join('、')} 之一`,
      'INVALID_ARGUMENT',
    );
  }
  const request: DesktopInputRequest = { action: action as DesktopInputAction, display: parseDisplay(args.display) };
  if (args.coordinate !== undefined) request.coordinate = parseCoordinate(args.coordinate, 'coordinate');
  if (args.startCoordinate !== undefined) {
    request.startCoordinate = parseCoordinate(args.startCoordinate, 'startCoordinate');
  }
  switch (request.action) {
    case 'mouse_move':
    case 'left_click_drag':
      if (request.coordinate === undefined) {
        throw new CompanionError(`${request.action} 需要 coordinate`, 'INVALID_ARGUMENT');
      }
      break;
    case 'key':
    case 'type': {
      const text = args.text;
      if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TYPE_CHARS) {
        throw new CompanionError(`${request.action} 的 text 必须是 1-${String(MAX_TYPE_CHARS)} 个字符`, 'INVALID_ARGUMENT');
      }
      request.text = text;
      break;
    }
    case 'scroll': {
      const direction = args.scrollDirection;
      if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') {
        throw new CompanionError('scrollDirection 必须是 up、down、left 或 right', 'INVALID_ARGUMENT');
      }
      request.scrollDirection = direction;
      request.scrollAmount = parseBoundedInteger(args.scrollAmount ?? 3, 'scrollAmount', 1, MAX_SCROLL_AMOUNT);
      break;
    }
    case 'wait':
      request.durationMs = parseBoundedInteger(args.durationMs ?? 500, 'durationMs', 1, MAX_WAIT_MS);
      break;
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'cursor_position':
      break;
  }
  return request;
}

function parseDisplay(value: unknown): number {
  if (value === undefined) return 0;
  return parseBoundedInteger(value, 'display', 0, 15);
}

function parseBoundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new CompanionError(`${name} 必须是 ${String(minimum)}-${String(maximum)} 之间的整数`, 'INVALID_ARGUMENT');
  }
  return value;
}

function parseCoordinate(value: unknown, name: string): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new CompanionError(`${name} 必须是 [x, y] 两个数字`, 'INVALID_ARGUMENT');
  }
  const [x, y] = value as unknown[];
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    throw new CompanionError(`${name} 必须是两个非负数字`, 'INVALID_ARGUMENT');
  }
  return [Math.round(x), Math.round(y)];
}

/**
 * Assemble one screenshot result from the reduced PNG and its display.
 * @param bytes - the reduced PNG.
 * @param display - the display the capture came from.
 * @returns the model-facing screenshot record.
 * @throws CompanionError when the encoded image exceeds what one wire frame carries.
 */
function screenshotResult(bytes: Buffer, display: DisplayGeometry): DesktopScreenshot {
  const data = bytes.toString('base64');
  if (data.length > MAX_SCREENSHOT_BASE64_BYTES) {
    throw new CompanionError('截屏结果过大，无法通过本机助手通道传输', 'DESKTOP_CAPTURE_FAILED');
  }
  const size = pngDimensions(bytes);
  return {
    mediaType: 'image/png',
    data,
    bytes: bytes.length,
    width: size.width,
    height: size.height,
    screenWidth: display.width,
    screenHeight: display.height,
    scale: display.width / size.width,
    display: display.index,
    displays: display.count,
  };
}

/** The grant a connection must hold before any desktop operation runs. */
export interface DesktopControlGrant {
  /** Whether this connection may capture the screen and drive the input devices. */
  readonly desktopControl: boolean;
}

/**
 * Refuse a desktop operation on a connection that was not granted desktop control.
 *
 * The check lives with the capability rather than at each dispatch site, so a
 * new consumer — the desktop application runs the same two operations from its
 * own worker — cannot reach a screen or an input device by forgetting it.
 * @param grant - the connection's resolved grants.
 * @throws CompanionError when desktop control is absent.
 */
export function assertDesktopControl(grant: DesktopControlGrant): void {
  if (grant.desktopControl) return;
  throw new CompanionError(
    '本机助手未启用桌面控制；重新配对时添加 --allow-desktop，或在桌面端为该目录打开「允许控制桌面」',
    'DESKTOP_CONTROL_DISABLED',
  );
}

/**
 * Capture one display of the computer running the companion.
 * @param grant - the connection's resolved grants; desktop control must be present.
 * @param args - the raw operation arguments; `display` selects a monitor.
 * @param signal - cancellation for the helper runs.
 * @returns the reduced capture and the mapping back onto the display.
 * @throws CompanionError when the grant, the platform, its helpers, or its permissions refuse the capture.
 */
export async function captureDesktopScreen(
  grant: DesktopControlGrant,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<DesktopScreenshot> {
  assertDesktopControl(grant);
  const { display } = parseScreenshotArgs(args);
  if (process.platform === 'win32') {
    const value = await runWindowsHelper(
      { kind: 'screenshot', display, maxWidth: DESKTOP_IMAGE_MAX_WIDTH, maxHeight: DESKTOP_IMAGE_MAX_HEIGHT },
      SCREENSHOT_TIMEOUT_MS,
      signal,
      'DESKTOP_CAPTURE_FAILED',
    );
    const data = value.data;
    if (typeof data !== 'string' || data === '') {
      throw new CompanionError('截屏工具没有返回图像数据', 'DESKTOP_CAPTURE_FAILED');
    }
    return screenshotResult(Buffer.from(data, 'base64'), geometryFromHelper(value, display, 'DESKTOP_CAPTURE_FAILED'));
  }
  if (process.platform === 'darwin') {
    const geometry = await macosDisplay(display, signal, 'DESKTOP_CAPTURE_FAILED');
    try {
      return screenshotResult(await macosCapture(geometry, signal), geometry);
    } catch (error) {
      // `screencapture` exits nonzero with this message when the process holds
      // no Screen Recording grant; every other failure keeps its own report.
      if (error instanceof CompanionError && error.message.includes('could not create image from display')) {
        throw new CompanionError(
          'macOS 未授予「屏幕录制」权限。请在「系统设置 → 隐私与安全性 → 屏幕录制」中勾选本应用后重新连接。',
          'DESKTOP_PERMISSION_REQUIRED',
        );
      }
      throw error;
    }
  }
  if (process.platform === 'linux') {
    const geometry = await linuxDisplay(display, signal);
    return screenshotResult(await linuxCapture(reducedImageSize(geometry.width, geometry.height), signal), geometry);
  }
  throw new CompanionError(`本机助手不支持在 ${process.platform} 上操作桌面`, 'DESKTOP_UNSUPPORTED_PLATFORM');
}

/**
 * Perform one mouse or keyboard action on the computer running the companion.
 * @param grant - the connection's resolved grants; desktop control must be present.
 * @param args - the raw operation arguments, with coordinates in the capture's pixels.
 * @param signal - cancellation for the helper runs.
 * @returns the pointer position after the action, in the capture's pixels.
 * @throws CompanionError when the grant, the platform, its helpers, or its permissions refuse the action.
 */
export async function sendDesktopInput(
  grant: DesktopControlGrant,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<DesktopInputResult> {
  assertDesktopControl(grant);
  const request = parseDesktopInputArgs(args);
  const display = request.display ?? 0;
  if (process.platform === 'win32') {
    const value = await runWindowsHelper({
      kind: 'input',
      display,
      maxWidth: DESKTOP_IMAGE_MAX_WIDTH,
      maxHeight: DESKTOP_IMAGE_MAX_HEIGHT,
      action: request.action,
      ...request.coordinate === undefined ? {} : { x: request.coordinate[0], y: request.coordinate[1] },
      ...request.startCoordinate === undefined
        ? {}
        : { startX: request.startCoordinate[0], startY: request.startCoordinate[1] },
      ...request.text === undefined ? {} : { text: request.text },
      ...request.scrollDirection === undefined ? {} : { scrollDirection: request.scrollDirection },
      ...request.scrollAmount === undefined ? {} : { scrollAmount: request.scrollAmount },
      ...request.durationMs === undefined ? {} : { durationMs: request.durationMs },
    }, INPUT_TIMEOUT_MS, signal, 'DESKTOP_INPUT_FAILED');
    const geometry = geometryFromHelper(value, display, 'DESKTOP_INPUT_FAILED');
    return inputResult(request, geometry, {
      x: helperNumber(value, 'cursorX', 'DESKTOP_INPUT_FAILED'),
      y: helperNumber(value, 'cursorY', 'DESKTOP_INPUT_FAILED'),
    });
  }
  if (process.platform === 'darwin') {
    const value = await runMacosHelper({
      kind: 'input',
      display,
      maxWidth: DESKTOP_IMAGE_MAX_WIDTH,
      maxHeight: DESKTOP_IMAGE_MAX_HEIGHT,
      action: request.action,
      ...request.coordinate === undefined ? {} : { x: request.coordinate[0], y: request.coordinate[1] },
      ...request.startCoordinate === undefined
        ? {}
        : { startX: request.startCoordinate[0], startY: request.startCoordinate[1] },
      ...request.text === undefined ? {} : { text: request.text },
      ...request.scrollDirection === undefined ? {} : { scrollDirection: request.scrollDirection },
      ...request.scrollAmount === undefined ? {} : { scrollAmount: request.scrollAmount },
      ...request.durationMs === undefined ? {} : { durationMs: request.durationMs },
    }, INPUT_TIMEOUT_MS + (request.durationMs ?? 0), signal, 'DESKTOP_INPUT_FAILED');
    const geometry = geometryFromHelper(value, display, 'DESKTOP_INPUT_FAILED');
    return inputResult(request, geometry, {
      x: helperNumber(value, 'cursorX', 'DESKTOP_INPUT_FAILED'),
      y: helperNumber(value, 'cursorY', 'DESKTOP_INPUT_FAILED'),
    });
  }
  if (process.platform === 'linux') {
    const geometry = await linuxDisplay(display, signal);
    return inputResult(request, geometry, await linuxInput(request, geometry, signal));
  }
  throw new CompanionError(`本机助手不支持在 ${process.platform} 上操作桌面`, 'DESKTOP_UNSUPPORTED_PLATFORM');
}

/**
 * Report one finished action in the capture's coordinate space.
 * @param request - the action that ran.
 * @param display - the display it addressed.
 * @param cursor - the pointer position in global desktop coordinates.
 * @returns the model-facing action result.
 */
function inputResult(
  request: DesktopInputRequest,
  display: DisplayGeometry,
  cursor: { x: number; y: number },
): DesktopInputResult {
  const image = reducedImageSize(display.width, display.height);
  return {
    action: request.action,
    cursor: displayPointToImage(cursor, display),
    width: image.width,
    height: image.height,
    screenWidth: display.width,
    screenHeight: display.height,
    scale: display.width / image.width,
    display: display.index,
    displays: display.count,
  };
}
