// 合规命令行的契约（附录 C1 退出码、C2 --json 信封、--help 无副作用）与端到端行为（临时 git 仓库）。
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, j, hasGit, mkRepo, git, rm, runCli, parseEnvelope, worktreeState } from './helpers.mjs';

const CLIS = ['tools/compliance/scan.mjs', 'tools/compliance/rights-inventory.mjs', 'tools/compliance/signed-urls.mjs', 'tools/compliance/aigc.mjs'];

test('每个命令：--help 退出码 0、写到 stdout、不改任何文件', { skip: !hasGit }, () => {
  const before = worktreeState(REPO);
  for (const cli of CLIS) {
    for (const flag of ['--help', '-h']) {
      const r = runCli(cli, [flag]);
      assert.equal(r.code, 0, `${cli} ${flag}：${r.stderr}`);
      assert.match(r.stdout, /用法/, `${cli} 的帮助要写用法`);
      assert.equal(r.stderr, '');
    }
    // --help 混在别的参数里也只打印帮助（scan --write 之类的副作用不会发生）
    assert.equal(runCli(cli, ['--help', '--json', '--write']).code, 0);
  }
  assert.equal(worktreeState(REPO), before, '--help 改动了工作区');
});

test('每个命令：未知参数退出码 2；加 --json 时 stdout 只有一个信封对象', () => {
  for (const cli of CLIS) {
    const r = runCli(cli, ['--no-such-flag']);
    assert.equal(r.code, 2, `${cli}：${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /下一步/, '用法错误要说清下一步');
    const k = runCli(cli, ['--json', '--no-such-flag']);
    assert.equal(k.code, 2);
    const env = parseEnvelope(k.stdout);
    for (const key of ['ok', 'exitCode', 'command', 'error', 'outputs', 'runJson', 'warnings']) assert.ok(key in env, `${cli} 的信封缺 ${key}`);
    assert.equal(env.schemaVersion, 1);
    assert.equal(env.ok, false);
    assert.equal(env.exitCode, 2);
    assert.equal(env.error.code, 'usage.unknown-option', '与 tools/lib/cli.mjs 同一套用法错误码');
    assert.match(env.error.message, /不认识的选项 --no-such-flag/);
  }
});

test('scan：干净仓库退出码 0；植入令牌、本机路径、内网地址、签名链接、.env 后退出码 4，且不泄露原文', { skip: !hasGit }, () => {
  const only = ['--only', 'secrets,local-paths,private-network,signed-urls,sensitive-files,fsl-boundary', '--allowlist', 'none'];
  const clean = mkRepo({ 'src/a.js': 'export const x = 1;\n', 'README.md': '# 示例\n' });
  try {
    const r = runCli('tools/compliance/scan.mjs', ['--root', clean, '--json', ...only]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(parseEnvelope(r.stdout).result.findings.length, 0);
  } finally { rm(clean); }

  const token = j('gh', 'p_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5');
  const dirty = mkRepo({
    'src/a.js': `const t = "${token}";\nconst p = "${j('/Us', 'ers/alice/proj/x')}";\n`,
    'docs/net.md': `工作站：${['192', '168', '3', '7'].join('.')}\n`,
    'cases/source/old/tts.json': `{"url":"${j('https://b.oss.aliyuncs.com/a.mp3?Expires=1762300000&OSS', 'AccessKeyId=', 'abc', '&Signature=xyz')}"}\n`,
    '.env': 'KEY=1\n',
  });
  try {
    const r = runCli('tools/compliance/scan.mjs', ['--root', dirty, '--json', ...only]);
    assert.equal(r.code, 4, r.stdout);
    const env = parseEnvelope(r.stdout);
    assert.equal(env.ok, false);
    assert.equal(env.error.code, 'compliance');
    const byRule = rule => env.result.findings.filter(f => f.rule === rule);
    assert.equal(byRule('comp.secrets').length, 1);
    assert.equal(byRule('comp.local-paths').length, 1);
    assert.equal(byRule('comp.private-network').length, 1);
    assert.equal(byRule('comp.sensitive-files').length, 1);
    const signed = byRule('comp.signed-urls');
    assert.equal(signed.length, 1);
    assert.equal(signed[0].zone, 'archive');
    assert.equal(signed[0].blocking, false, '历史归档区只报告不阻塞');
    assert.ok(!r.stdout.includes(token), 'JSON 输出里不能有令牌原文');
    // 人读报告同样不泄露，且给出下一步
    const h = runCli('tools/compliance/scan.mjs', ['--root', dirty, ...only]);
    assert.equal(h.code, 4);
    assert.ok(!h.stdout.includes(token));
    assert.match(h.stdout, /下一步/);
    // --staged：只看暂存区的新改动
    fs.writeFileSync(path.join(dirty, 'src/b.js'), `const k = "${token}";\n`);
    git(dirty, ['add', '--', 'src/b.js']);
    const st = runCli('tools/compliance/scan.mjs', ['--root', dirty, '--staged', '--json', '--only', 'secrets', '--allowlist', 'none']);
    assert.equal(st.code, 4);
    assert.deepEqual(parseEnvelope(st.stdout).result.findings.map(f => f.file), ['src/b.js']);
  } finally { rm(dirty); }
});

test('scan：不是目录退出码 3，规则名拼错退出码 2', () => {
  assert.equal(runCli('tools/compliance/scan.mjs', ['--root', path.join(REPO, 'no-such-dir')]).code, 3);
  const r = runCli('tools/compliance/scan.mjs', ['--only', 'secretz']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /可选/);
});

test('scan：仓库自己的合规工具、测试与文档不会扫到自己', () => {
  const r = runCli('tools/compliance/scan.mjs', ['--json', '--scope', 'tree', '--allowlist', 'none', '--only', 'secrets,local-paths,private-network,signed-urls,personal-email,fsl-boundary,sensitive-files,aigc']);
  const env = parseEnvelope(r.stdout);
  const own = env.result.findings.filter(f => /^(tools\/compliance\/|tools\/repo-check\/rules\/comp\/|tests\/comp\/|docs\/rights\/|SECURITY\.md|REUSE\.toml|LICENSES\/)/.test(f.file));
  assert.deepEqual(own.map(f => `${f.rule} ${f.file}:${f.line}`), []);
});

test('signed-urls strip：默认只演练；--write 只删查询串、JSON 仍合法、重复执行无副作用；有未提交改动时拒绝', { skip: !hasGit }, () => {
  const url = j('https://b.oss.aliyuncs.com/a.mp3?Expires=1762300000&OSS', 'AccessKeyId=', 'abc', '&Signature=x%2By');
  const body = `{\r\n  "data": {"audio": "${url}"},\r\n  "n": 1\r\n}\r\n`;
  const dir = mkRepo({ 'cases/source/c1/tts.json': body, 'cases/source/c1/keep.txt': 'no urls\n' });
  try {
    const file = path.join(dir, 'cases/source/c1/tts.json');
    const dry = runCli('tools/compliance/signed-urls.mjs', ['strip', '--root', dir, '--json']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), body, '演练不能写文件');
    assert.equal(parseEnvelope(dry.stdout).result.files[0].removed, 1);
    fs.appendFileSync(file, ' ');
    assert.equal(runCli('tools/compliance/signed-urls.mjs', ['strip', '--root', dir, '--write']).code, 2, '目标文件有未提交改动时拒绝');
    git(dir, ['checkout', '--', 'cases/source/c1/tts.json']);
    const patch = path.join(dir, 'patch.json');
    const w = runCli('tools/compliance/signed-urls.mjs', ['strip', '--root', dir, '--write', '--patch-out', patch, '--json']);
    assert.equal(w.code, 0, w.stderr);
    const after = fs.readFileSync(file, 'utf8');
    assert.equal(after, body.replace(url, url.slice(0, url.indexOf('?'))), '只删掉查询串，其余字节（含 CRLF）不变');
    JSON.parse(after);
    const p = JSON.parse(fs.readFileSync(patch, 'utf8'));
    assert.equal(p.files[0].source, 'source/c1/tts.json');
    assert.notEqual(p.files[0].oldSha256, p.files[0].newSha256);
    git(dir, ['add', '--', 'cases/source/c1/tts.json']);
    git(dir, ['commit', '-q', '-m', 'strip']);
    const again = runCli('tools/compliance/signed-urls.mjs', ['strip', '--root', dir, '--write', '--json']);
    assert.equal(parseEnvelope(again.stdout).result.files.length, 0, '重复执行没有可改的');
    const list = runCli('tools/compliance/signed-urls.mjs', ['list', '--root', dir, '--json']);
    assert.equal(parseEnvelope(list.stdout).result.count, 0);
  } finally { rm(dir); }
});

test('signed-urls list：子命令拼错退出码 2，--check 发现清单过期退出码 4', { skip: !hasGit }, () => {
  assert.equal(runCli('tools/compliance/signed-urls.mjs', ['lst']).code, 2);
  const dir = mkRepo({ 'cases/source/c1/t.json': `{"u":"${j('https://b.example.com/a?X-Amz-', 'Signature=abc')}"}\n`, 'docs/list.md': '旧清单\n' });
  try {
    const r = runCli('tools/compliance/signed-urls.mjs', ['list', '--md', '--check', 'docs/list.md', '--root', dir]);
    assert.equal(r.code, 4);
    assert.equal(runCli('tools/compliance/signed-urls.mjs', ['list', '--md', '--out', 'docs/list.md', '--root', dir]).code, 0);
    assert.equal(runCli('tools/compliance/signed-urls.mjs', ['list', '--md', '--check', 'docs/list.md', '--root', dir]).code, 0);
  } finally { rm(dir); }
});

test('rights-inventory：登记册与案例目录一致；--check 与 --write 不能同用', () => {
  const r = runCli('tools/compliance/rights-inventory.mjs', ['--check', '--json']);
  assert.equal(r.code, 0, r.stdout);
  const env = parseEnvelope(r.stdout);
  assert.equal(env.ok, true);
  const ids = env.result.inventory.categories.map(c => c.id);
  assert.ok(ids.includes('R01') && ids.includes('R02') && ids.includes('R03'), '上美影、乐奇、参考图三类必须在册');
  assert.equal(runCli('tools/compliance/rights-inventory.mjs', ['--check', '--write']).code, 2);
  assert.equal(runCli('tools/compliance/rights-inventory.mjs', ['--root', path.join(REPO, 'no-such-dir')]).code, 3);
});

test('scan personal-email：D02 之后用个人邮箱的提交，没推送时阻断，已在远端（公开历史）时只报告', { skip: !hasGit }, () => {
  const personal = j('someone', '@', 'gmail', '.com');   // 拼出来：源码里不出现完整地址
  const repo = mkRepo({ 'a.txt': '1\n' });
  const bare = fs.mkdtempSync(path.join(path.dirname(repo), 'beiming-comp-remote-'));
  try {
    fs.writeFileSync(path.join(repo, 'b.txt'), '2\n');
    git(repo, ['add', '--', 'b.txt']);
    const env = { GIT_AUTHOR_DATE: '2026-11-11T12:00:00+08:00', GIT_COMMITTER_DATE: '2026-11-11T12:00:00+08:00' };
    const r0 = spawnSync('git', ['-C', repo, '-c', `user.email=${personal}`, '-c', 'user.name=x', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'late'], { env: { ...process.env, ...env }, encoding: 'utf8' });
    assert.equal(r0.status, 0, r0.stderr);
    const scan = () => runCli('tools/compliance/scan.mjs', ['--root', repo, '--json', '--only', 'personal-email', '--allowlist', 'none']);
    const before = scan();
    assert.equal(before.code, 4, '没推送的个人邮箱提交是阻断级');
    git(bare, ['init', '-q', '--bare']);
    git(repo, ['remote', 'add', 'origin', bare]);
    git(repo, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    git(repo, ['fetch', '-q', 'origin']);
    const after = scan();
    assert.equal(after.code, 0, `推到远端之后只报告：${after.stdout}`);
    assert.ok(parseEnvelope(after.stdout).result.findings.some(f => f.rule === 'comp.personal-email' && f.blocking === false), '仍然报告（不阻断）');
  } finally { rm(repo); rm(bare); }
});
