// config.ts 纯函数的回归测试：isPublicIp 公网 IPv4 判定。
// 重点覆盖 198.18.0.0/15（RFC 2544 基准测试段）——此前仅拦 198.18.x.x，
// 遗漏同段 198.19.0.0/16，会把它误判为公网并触发 ACME 签发（现已修复）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicIp } from '../src/config.js';

test('isPublicIp：公网地址返回 true', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '104.16.132.229']) {
    assert.equal(isPublicIp(ip), true, `${ip} 应为公网`);
  }
});

test('isPublicIp：RFC 2544 基准测试段 198.18.0.0/15 全部判为非公网', () => {
  // 边界：198.18.0.0 / 198.18.255.255 / 198.19.0.0 / 198.19.255.255
  for (const ip of ['198.18.0.0', '198.18.255.255', '198.19.0.0', '198.19.255.255']) {
    assert.equal(isPublicIp(ip), false, `${ip} 应为非公网（基准测试段）`);
  }
});

test('isPublicIp：私网/回环/链路本地/CGNAT/文档段判为非公网', () => {
  for (const ip of [
    '10.0.0.1',
    '192.168.1.1',
    '172.16.0.1',
    '172.31.255.255',
    '127.0.0.1',
    '169.254.1.1',
    '100.64.0.1',
    '100.127.255.255',
    '0.0.0.0',
    '198.51.100.1',
    '203.0.113.1',
  ]) {
    assert.equal(isPublicIp(ip), false, `${ip} 应为非公网`);
  }
});

test('isPublicIp：非法输入判为非公网', () => {
  for (const ip of ['256.1.1.1', '300.1.1.1', '1.2.3', 'abc', '8.8.8.8.8', '', '1.2.3.4.5']) {
    assert.equal(isPublicIp(ip), false, `${ip} 应为非公网`);
  }
});

test('isPublicIp：前导零归一化后仍按私有段判定', () => {
  assert.equal(isPublicIp('010.0.0.1'), false, '010.0.0.1 应归一化为 10.0.0.1 判非公网');
});
