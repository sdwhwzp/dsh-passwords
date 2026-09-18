// 目录选择器删除按钮：纯函数单测（无 DOM 依赖）。
//
// 覆盖：
//   - extractPickerListings：从真实形状的 directoryPicker/list 响应信封里
//     收集目录条目数组（含 parent/child 双列与 hidden 字段）
//   - matchPickerListing：列名序列 → 已抓列表的匹配（精确优先、子序列回退）
//   - pickerText / locales：zh/en 键一致且非空
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPickerListings,
  isPickerEntry,
  matchPickerListing,
  pickerText,
} from '../src/client/picker-delete';
import { zh, en } from '../src/client/locales';

/** 官方 directoryPicker/list 响应信封（server-response → result.value）。
 *  实测形状：value 内含 parent 与 child 两个 entries 数组（双列）。 */
function listEnvelope(entries: Array<Array<Record<string, unknown>>>, extra: Record<string, unknown> = {}): unknown {
  return {
    type: 'server-response',
    rpcId: 'rpc-1',
    result: {
      ok: true,
      value: {
        path: '/root',
        home: '/root',
        truncated: false,
        ...extra,
        ...Object.fromEntries(entries.map((list, i) => [`key${i}`, { entries: list }])),
      },
    },
  };
}

test('extractPickerListings：收集响应内全部目录条目数组（双列）并保留 hidden', () => {
  const parent = [
    { path: '/root/22', name: '22', hidden: false },
    { path: '/root/.cache', name: '.cache', hidden: true },
  ];
  const child = [{ path: '/root/22/sub', name: 'sub', hidden: false }];
  const found = extractPickerListings(listEnvelope([parent, child]));
  assert.equal(found.length, 2);
  assert.deepEqual(found[0], [
    { path: '/root/22', name: '22', hidden: false },
    { path: '/root/.cache', name: '.cache', hidden: true },
  ]);
  assert.deepEqual(found[1], [{ path: '/root/22/sub', name: 'sub', hidden: false }]);
});

test('extractPickerListings：真实信封只采集 entries，不把 crumbs 当目录列表', () => {
  const entries = [{ path: '/root/22', name: '22', hidden: false }];
  const crumbs = [
    { path: '/', name: 'root', hidden: false },
    { path: '/root', name: 'root', hidden: false },
  ];
  const found = extractPickerListings({
    type: 'server-response',
    rpcId: 'rpc-real-envelope',
    result: {
      ok: true,
      value: {
        path: '/root',
        home: '/root',
        crumbs,
        entries,
        truncated: false,
      },
    },
  });
  assert.deepEqual(found, [[{ path: '/root/22', name: '22', hidden: false }]]);
});

test('extractPickerListings：排除 truncated=true 的不完整 entries 列表', () => {
  const found = extractPickerListings({
    result: {
      ok: true,
      value: {
        path: '/root',
        home: '/root',
        crumbs: [],
        entries: [{ path: '/root/partial', name: 'partial', hidden: false }],
        truncated: true,
      },
    },
  });
  assert.deepEqual(found, []);
});

test('extractPickerListings：hidden 缺省为 false；空/畸形信封返回空数组', () => {
  const found = extractPickerListings(listEnvelope([[{ path: '/a', name: 'a' }]]));
  assert.deepEqual(found, [[{ path: '/a', name: 'a', hidden: false }]]);
  assert.deepEqual(extractPickerListings(null), []);
  assert.deepEqual(extractPickerListings({}), []);
  assert.deepEqual(extractPickerListings({ result: { ok: false, error: {} } }), []);
  // 混入非条目对象的数组不算目录列表
  assert.deepEqual(extractPickerListings({ value: { entries: [{ path: '/a', name: 'a' }, 'x'] } }), []);
});

test('isPickerEntry：path/name 必须是非空字符串', () => {
  assert.equal(isPickerEntry({ path: '/a', name: 'a' }), true);
  assert.equal(isPickerEntry({ path: '', name: 'a' }), false);
  assert.equal(isPickerEntry({ path: '/a', name: 1 }), false);
  assert.equal(isPickerEntry(null), false);
  assert.equal(isPickerEntry([1]), false);
});

test('matchPickerListing：精确序列相等优先命中（最新在前）', () => {
  const listings = [
    { names: ['a', 'b', 'c'] }, // 最新
    { names: ['a', 'b'] },
    { names: ['x'] },
  ];
  assert.equal(matchPickerListing(['a', 'b', 'c'], listings), 0);
  assert.equal(matchPickerListing(['a', 'b'], listings), 1);
  assert.equal(matchPickerListing(['x'], listings), 2);
});

test('matchPickerListing：显示被过滤时按有序子序列回退，取最长候选', () => {
  const listings = [
    { names: ['a', 'x'] }, // 短但也是子序列宿主
    { names: ['a', 'b', 'c', 'd'] }, // 最长宿主 → 应命中
  ];
  // 列上只显示了 a、c（b/d 被隐藏开关或前缀过滤掉了）
  assert.equal(matchPickerListing(['a', 'c'], listings), 1);
  // 顺序不匹配（c 在 a 前）不算子序列
  assert.equal(matchPickerListing(['c', 'a'], listings), null);
  // 两个同长度候选都能解释过滤后的列时不能猜路径，避免误删父目录。
  assert.equal(
    matchPickerListing(['a', 'c'], [
      { names: ['a', 'b', 'c', 'd'] },
      { names: ['a', 'x', 'c', 'y'] },
    ]),
    null,
  );
});

test('matchPickerListing：空名序列或无候选/无命中返回 null', () => {
  assert.equal(matchPickerListing([], [{ names: ['a'] }]), null);
  assert.equal(matchPickerListing(['a'], []), null);
  assert.equal(matchPickerListing(['zzz'], [{ names: ['a'] }]), null);
});

test('pickerText/locales：zh 与 en 键完全一致且删除文案非空', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const key of ['pickerDel', 'pickerDelConfirm', 'pickerDelAria', 'pickerDelDone', 'pickerDelFailed'] as const) {
    assert.equal(typeof zh[key], 'string');
    assert.ok((zh[key] as string).length > 0);
    assert.ok((en[key] as string).length > 0);
  }
  for (const value of Object.values(pickerText)) assert.ok(value.length > 0);
});
