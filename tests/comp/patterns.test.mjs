// 合规扫描的内容规则：每条规则至少一个命中样例与一个不该命中的样例。样例在运行时拼接，见 helpers.mjs。
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_RULES, checkFileName, signedUrlInfo, isPersonalEmail, isUnlinkedNoreply, redact } from '../../tools/compliance/lib/patterns.mjs';
import { j } from './helpers.mjs';

const rule = id => CONTENT_RULES.find(r => r.id === id);
const hits = (id, text, rel = 'tools/x.mjs', now = Date.parse('2026-11-10T00:00:00Z')) => rule(id).scan(text, rel, { now });

test('密钥：认出常见令牌格式，输出里不带原文', () => {
  const gh = j('gh', 'p_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5');
  const aws = j('AK', 'IA', 'QWERTYUIOPASDFGH');
  const ali = j('LT', 'AI', '5tAbCdEfGhIjKlMn');
  const sk = j('s', 'k-', 'proj-', 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr');
  const pk = j('-----BEGIN ', 'OPENSSH ', 'PRIVATE KEY-----');
  for (const s of [gh, aws, ali, sk, pk]) {
    const h = hits('comp.secrets', `const t = "${s}";`);
    assert.equal(h.length, 1, `没认出：${s.slice(0, 6)}`);
    assert.equal(h[0].level, 'error');
    assert.ok(!h[0].message.includes(s), '提示里不能带完整令牌');
  }
});

test('密钥：占位符、示例值与过于规整的串不报', () => {
  assert.equal(hits('comp.secrets', 'api_key = "your-api-key-here-xxxxxxxxxxxx"').length, 0);
  assert.equal(hits('comp.secrets', j('s', 'k-', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa')).length, 0);
  assert.equal(hits('comp.secrets', 'password: "${PASSWORD_FROM_ENV_VARIABLE}"').length, 0);
});

test('密钥：可疑的赋值只给提示', () => {
  const h = hits('comp.secrets', j('client_secret = "', 'Zx9Qw8Er7Ty6Ui5Op4As3Df2', '"'));
  assert.equal(h.length, 1);
  assert.equal(h[0].level, 'warn');
});

test('敏感文件名：.env、私钥、证书包阻断，示例文件放行', () => {
  for (const f of ['.env', 'conf/.env.local', 'keys/server.pem', 'id_ed25519', 'a/b/cert.p12', '.git-credentials']) assert.equal(checkFileName(f).length, 1, f);
  for (const f of ['.env.example', 'docs/key.md', 'id_ed25519.pub', 'tools/keyframes.js']) assert.equal(checkFileName(f).length, 0, f);
});

test('本机路径：用户目录、会话临时目录、盘符路径都认出', () => {
  const samples = [
    j('/Us', 'ers/alice/work/x.js'),
    j('/ho', 'me/bob/repo/'),
    j('/private/tmp/', 'claude-501/abc'),
    j('~/', 'Desktop/北冥'),
    j('D', ':\\', '北冥\\tools'),
    j('C', ':/', 'Users/carol'),
    j('/mnt/', 'd/repo'),
  ];
  for (const s of samples) assert.ok(hits('comp.local-paths', `x = "${s}"`).length >= 1, `没认出：${s}`);
});

test('本机路径：占位符、系统目录、正则与时间写法不报', () => {
  const samples = [j('/Us', 'ers/<you>/repo/'), j('/Us', 'ers/<用户名>/repo/'), j('/Us', 'ers/<名>/'), j('/Us', 'ers/shared/x/'), j('C', ':\\', 'Windows\\System32'), j('C', ':\\', 'Program Files\\x'), '/\\s+:\\d/', '12:30/45', j('https', '://example.com/a')];
  for (const s of samples) assert.equal(hits('comp.local-paths', `x = "${s}"`).length, 0, `误报：${s}`);
});

test('内网地址：私网主机地址报，标准网段名与公网地址不报', () => {
  const host = ['192', '168', '7', '42'].join('.');
  const cgnat = ['100', '68', '1', '9'].join('.');
  assert.equal(hits('comp.private-network', `host=${host}`).length, 1);
  assert.equal(hits('comp.private-network', `ts=${cgnat}`).length, 1);
  assert.ok(!hits('comp.private-network', `host=${host}`)[0].message.includes(host), '提示里不带完整地址');
  const ranges = [['10', '0', '0', '0/8'], ['172', '16', '0', '0/12'], ['192', '168', '0', '0/16']].map(p => p.join('.')).join('、');
  assert.equal(hits('comp.private-network', `私网段：${ranges}`).length, 0);
  assert.equal(hits('comp.private-network', ['8', '8', '8', '8'].join('.')).length, 0);
  // 非标准的子网照报
  assert.equal(hits('comp.private-network', ['10', '20', '20', '0/24'].join('.')).length, 1);
});

test('内网地址：Tailscale 主机名、局域网主机名与 SSH 目标', () => {
  assert.equal(hits('comp.private-network', j('rtx', '.tail1234', '.ts.net')).length, 1);
  assert.equal(hits('comp.private-network', j('http:', '//rog', '.local', ':8188/studio')).length, 1);
  assert.equal(hits('comp.private-network', '见 .claude/settings.local.json 与 .env.local').length, 0);
  const ssh = hits('comp.private-network', j('ssh ', 'ROG', '@', 'rtx-box'));
  assert.equal(ssh.length, 1);
  assert.equal(ssh[0].level, 'warn');
});

test('签名链接：认出查询串里的签名参数与有效期，不输出签名值', () => {
  const url = j('https://bucket.oss-cn-x.aliyuncs.com/a.mp3?Expires=1762300000&OSS', 'AccessKeyId=', 'LTAI', 'xxxxxxxxxxxxxx', '&Signature=abc%2Bdef');
  const info = signedUrlInfo(url);
  assert.ok(info);
  assert.deepEqual(info.params.sort(), ['OSSAccessKeyId', 'Signature']);
  assert.equal(info.host, 'bucket.oss-cn-x.aliyuncs.com');
  const h = hits('comp.signed-urls', `"url": "${url}"`);
  assert.equal(h.length, 1);
  assert.match(h[0].message, /已于 2025-11-0\d 过期/);
  assert.ok(!h[0].message.includes('abc%2Bdef'));
  assert.equal(signedUrlInfo('https://example.com/a.mp3?v=2&size=10'), null);
});

test('个人邮箱：公共邮箱报，noreply 与署名文件不报', () => {
  const personal = j('someone', '@', 'gmail.com');
  assert.ok(isPersonalEmail(personal));
  assert.equal(hits('comp.personal-email', `作者：${personal}`).length, 1);
  assert.equal(hits('comp.personal-email', `作者：${personal}`, 'fonts/OFL.txt').length, 0);
  assert.ok(!isPersonalEmail(j('1+x', '@users.noreply.github.com')));
  assert.ok(!isPersonalEmail(j('dev', '@', 'example.com')));
});

test('noreply 地址要带数字 ID', () => {
  assert.ok(isUnlinkedNoreply(j('someone-afk', '@users.noreply.github.com')));
  assert.ok(!isUnlinkedNoreply(j('231205984+someone-afk', '@users.noreply.github.com')));
  assert.ok(!isUnlinkedNoreply(j('a', '@', 'example.com')));
});

test('FSL 边界：代码里出现上游许可或版权行阻断，文档只对条款原文给提示', () => {
  const title = j('Functional ', 'Source License');
  const holder = j('Copy', 'right 2026 Shane', ' Murphy');
  assert.equal(hits('comp.fsl-boundary', `// ${title}`, 'engine/native/x.ts')[0].level, 'error');
  assert.equal(hits('comp.fsl-boundary', `// ${holder}`, 'engine/native/x.ts')[0].level, 'error');
  assert.equal(hits('comp.fsl-boundary', `讲解 ${title} 的边界`, 'docs/x.md').length, 0);
  const clause = j('A Competing', ' Use means making the Software available');
  assert.equal(hits('comp.fsl-boundary', clause, 'docs/x.md')[0].level, 'warn');
  // 单独标了 FSL 许可头的派生文件不报
  const hdr = j('// SPDX-', 'License-Identifier: LicenseRef-', 'FSL-1.1-', 'ALv2\n');
  assert.equal(hits('comp.fsl-boundary', hdr + `// ${holder}`, 'engine/native/x.ts').length, 0);
  // Rust / WESL / Cargo 清单出现在仓库主体
  assert.equal(hits('comp.fsl-boundary', 'fn main() {}', 'engine/native/lib.rs').length, 1);
  assert.equal(hits('comp.fsl-boundary', '[package]', 'tools/x/Cargo.toml').length, 1);
});

test('遮蔽：只留前 4 个字符', () => {
  assert.equal(redact('abcdefghij'), 'abcd…(10 字符，已遮蔽)');
  assert.equal(redact('abc'), '***');
});
