import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { publicCardLeakCodes } from '../../tools/compliance/lib/card-private.mjs';

const labUrl = 'lab:' + '//synthetic-test/0';
const syntheticHash = 'a'.repeat(64);
const parityReport = `sha256:${syntheticHash}`;

test('暂存区门禁拦截三类合成泄漏，公开报告哈希和相邻实现文件仍可提交', (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'card-private-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cardDir = join(dir, 'beiming', 'cards', 'synthetic', 'probe');
  fs.mkdirSync(cardDir, { recursive: true });
  const target = join(cardDir, 'card.json');
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: dir }).status, 0);
  git('init', '-q');
  const script = fileURLToPath(new URL('../../tools/compliance/scan.mjs', import.meta.url));
  const scan = () => spawnSync(process.execPath, [script, '--root', dir, '--staged', '--only', 'card-private', '--json'], { encoding: 'utf8' });
  for (const value of ['实验室' + '/synthetic/sample.txt', syntheticHash, labUrl]) {
    fs.writeFileSync(target, JSON.stringify({ title: value }));
    git('add', '--', 'beiming/cards/synthetic/probe/card.json');
    fs.writeFileSync(target, '{}'); // 工作区已清理，门禁仍须读取索引。
    const result = scan();
    assert.equal(result.status, 4);
    assert.equal(result.stdout.includes(value), false);
    assert.equal(JSON.parse(result.stdout).result.findings[0].rule, 'comp.card-private');
  }
  fs.writeFileSync(target, JSON.stringify({ status: [{ parityReport }] }));
  fs.writeFileSync(join(cardDir, 'selftest.test.mjs'), JSON.stringify(labUrl));
  git('add', '--', 'beiming/cards/synthetic/probe');
  assert.equal(scan().status, 0);
});

test('规则保留重复键、转义字段和原文数字，报告摘要例外只限状态数组成员', () => {
  const privateText = '{"provenance":{"studi' + '\\u0065' + 'd":"synthetic/sample.txt:3"}}';
  assert.deepEqual(publicCardLeakCodes(privateText), ['private-overlay-field']);
  assert.deepEqual(publicCardLeakCodes(`{"n":${'1'.repeat(64)},"n":0}`), ['bare-sha256']);
  assert.deepEqual(publicCardLeakCodes(JSON.stringify({ status: [{ parityReport }] })), []);
  assert.deepEqual(publicCardLeakCodes(JSON.stringify({ status: { 0: { parityReport } } })), ['bare-sha256']);
  assert.deepEqual(publicCardLeakCodes(JSON.stringify({ priors: [{ source: 'synthetic/sample.txt:3' }] })), ['private-overlay-field']);
  assert.deepEqual(publicCardLeakCodes('{"'), ['invalid-json']);
});
