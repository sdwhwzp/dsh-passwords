// 漏洞报告修复回归测试：SSRF 私网地址判定 / 上传危险扩展名 / 消息净化
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateHost, isDangerousUploadName, sanitizeText } from '../src/permissions.js';

// ── isPrivateHost（dsh-ssh SSRF 封堵） ────────────────────────────

test('SSRF：私网/回环/链路本地地址全部拦截', () => {
  for (const h of [
    '127.0.0.1',
    '127.0.0.2',
    'localhost',
    'LOCALHOST',
    'localhost.localdomain',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '169.254.0.1',
    '100.64.0.1',
    '198.18.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '[::1]',
    '[fd00::1]',
    // 变体：八进制/十六进制/简写段（F-28 真·inet_aton 解析）
    '0177.0.0.1', // 八进制 0177 → 127.0.0.1（之前 Number('0177')=177 漏拦）
    '0x7f.0.0.1', // → 127.0.0.1
    '127.1', // → 127.0.0.1
    '127.0.1', // → 127.0.0.1
    '10.1', // → 10.0.0.1
    '2130706433', // 单段 32 位整数 → 127.0.0.1（之前 >255 被放行）
    '0177.0.0.1:22', // 带端口的八进制变体
    // 带端口
    '127.0.0.1:22',
    '10.0.0.5:2222',
  ]) {
    assert.equal(isPrivateHost(h), true, `${h} 应判定为私网/回环`);
  }
});

test('SSRF：八进制/非法变体按 inet_aton 正确判定', () => {
  // 010 八进制 = 8，8.0.0.1 是公网 → 放行（旧实现对它误判为 10.0.0.1=私网）
  assert.equal(isPrivateHost('010.0.0.1'), false, '010 八进制=8 → 公网 8.0.0.1 应放行');
  assert.equal(isPrivateHost('08.0.0.1'), false, '0 开头含 8/9 非法字面量 → 非 IP 字面量路径');
  // 简写 2 段大值：127.65534 → 127.0.255.254（私网）
  assert.equal(isPrivateHost('127.65534'), true, '127.65534 → 127.0.255.254 私网');
  // 单段非私网大整数 → 公网 2130706432 = 127.0.0.0? 否，是 8.0.0.0
  // 2130706433 = 0x7F000001 = 127.0.0.1；134744072 = 0x08080808 = 8.8.8.8
  assert.equal(isPrivateHost('134744072'), false, '134744072 → 8.8.8.8 公网放行');
});

test('SSRF：公网地址放行', () => {
  for (const h of ['8.8.8.8', '1.1.1.1', '193.134.209.238', 'example.com', 'github.com', 'ssh.example.com:22', '127.0.0.1.nip.io']) {
    assert.equal(isPrivateHost(h), false, `${h} 应放行（域名在网关层做 DNS 判定）`);
  }
});

// ── isDangerousUploadName（上传类型白名单） ───────────────────────

test('上传：高危 Web 可解释扩展名拦截', () => {
  for (const n of [
    'shell.php',
    'a.phtml',
    'x.php5',
    'y.phar',
    'z.jsp',
    'w.jspx',
    'v.asp',
    'u.aspx',
    't.asa',
    's.cer',
    'r.cfm',
    'q.shtml',
    'p.cgi',
    'o.hta',
    'evil.svg',
    'a.php.bak',
    '../../etc/passwd',
    '..%2f..%2fetc',
  ]) {
    assert.equal(isDangerousUploadName(n), true, `${n} 应拦截`);
  }
});

test('上传：安全扩展名放行', () => {
  for (const n of ['readme.md', 'data.json', 'photo.png', 'script.py', 'run.sh', 'doc.txt', 'archive.tar.gz']) {
    assert.equal(isDangerousUploadName(n), false, `${n} 应放行`);
  }
});

// ── sanitizeText（消息内容净化） ──────────────────────────────────

test('消息净化：剥离 HTML/CSS 结构载荷', () => {
  const evil = '<style>body{background:red}</style><img src=x onerror=alert(1)><label for=admin>click</label>';
  const out = sanitizeText(evil);
  assert.ok(!out.includes('<style'), 'style 块被移除');
  assert.ok(!out.includes('<img'), 'img 标签被移除');
  assert.ok(!out.includes('onerror'), '事件属性被移除');
  assert.ok(!out.includes('<label'), 'label 标签被移除');
  assert.ok(out.includes('click'), '标签内可见文本保留');
});

test('消息净化：保留普通文本与换行', () => {
  const plain = 'hello world\nsecond line';
  assert.equal(sanitizeText(plain), plain);
});

test('消息净化：剥离无标签的 CSS 函数载荷', () => {
  const css = 'background: url(https://evil.com/x.png)';
  const out = sanitizeText(css);
  assert.ok(!out.includes('url('), 'url() 被剥离');
});

test('消息净化：script 块整体移除（含隐藏指令文本）', () => {
  const payload = '正常内容<script>console.log("agent 指令")</script>尾部';
  const out = sanitizeText(payload);
  assert.ok(!out.includes('agent 指令'), 'script 内文本不残留');
  assert.ok(out.includes('正常内容'), '其余文本保留');
});

test('消息净化：保留数学比较符（不被误当标签剥离）', () => {
  assert.equal(sanitizeText('2 < 3'), '2 < 3');
  assert.equal(sanitizeText('if x < 10 and y > 5'), 'if x < 10 and y > 5');
  assert.equal(sanitizeText('a<b'), 'a<b');
});

test('消息净化：剥离 HTML 注释（含隐藏文本）', () => {
  const out = sanitizeText('可见内容<!--隐藏指令-->尾部');
  assert.ok(!out.includes('隐藏指令'), '注释内容被移除');
  assert.ok(out.includes('可见内容') && out.includes('尾部'), '注释外文本保留');
});
