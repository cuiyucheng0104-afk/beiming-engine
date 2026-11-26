import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { compareRuns } from '../../tools/remote/lib/compare.mjs';

const CLI = fileURLToPath(new URL('../../tools/remote/cli.mjs', import.meta.url));
const SHA = 'a'.repeat(40);
const LOGICAL = 'delivery/master.mp4';
const digest = value => createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'beiming-compare-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  function run(label, data, { customRoot = false } = {}) {
    const runId = `20261127-120000-aaaaaaa-${label === 'left' ? '1111' : '2222'}`;
    const recordPath = join(base, `${label}.json`);
    const root = customRoot ? join(base, `${label}-artifacts`) : join(base, runId);
    const file = join(root, LOGICAL);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
    const artifact = { path: LOGICAL, sha256: digest(data), size: Buffer.byteLength(data) };
    const record = {
      schemaVersion: 1, runId, sha: SHA, command: ['node', 'job.mjs', 'private argumento'], exitCode: 0,
      error: null, machine: { hostname: `${label}.private`, platform: label === 'left' ? 'darwin' : 'linux', arch: 'x64' },
      machineProfile: `private-${label}`, transport: 'ssh', files: [artifact],
      fetched: [{ ...artifact, kind: 'remote-output', path: file.replaceAll('\\', '/') }], fetchProblems: [],
      envelope: { ok: true, exitCode: 0, outputs: [{ path: LOGICAL, kind: 'master' }] },
    };
    function save() { writeFileSync(recordPath, JSON.stringify(record)); }
    save();
    return { record, recordPath, root, file, save };
  }
  return { run };
}

const code = value => error => error.code === value;

test('两份成功运行同提交同作业，复算后严格通过，CLI 不回显私有字段', t => {
  const f = fixture(t);
  const left = f.run('left', 'abc'), right = f.run('right', 'abc', { customRoot: true });
  const result = spawnSync(process.execPath, [CLI, 'compare', left.recordPath, right.recordPath, '--right-root', right.root, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const j = JSON.parse(result.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.comparison.byteIdentical, true);
  assert.deepEqual(j.comparison.artifacts.map(a => [a.path, a.kind]), [[LOGICAL, 'master']]);
  assert.doesNotMatch(result.stdout, /private|beiming-compare/);
});

test('清单模式要显式开启并列出真实内容差异，严格模式返回不一致', t => {
  const f = fixture(t);
  const left = f.run('left', 'abc'), right = f.run('right', 'different length');
  const strict = compareRuns(left.recordPath, right.recordPath);
  assert.equal(strict.ok, false);
  const inventory = compareRuns(left.recordPath, right.recordPath, { mode: 'inventory' });
  assert.equal(inventory.ok, true);
  assert.equal(inventory.byteIdentical, false);
  assert.deepEqual(inventory.contentDifferences, [LOGICAL]);
  assert.notEqual(inventory.artifacts[0].left.sha256, inventory.artifacts[0].right.sha256);
  const result = spawnSync(process.execPath, [CLI, 'compare', left.recordPath, right.recordPath, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 4);
  assert.deepEqual(JSON.parse(result.stdout).comparison.contentDifferences, [LOGICAL]);
});

test('拒绝提交、argv 或主机身份不同于成对验收要求', t => {
  const f = fixture(t);
  const left = f.run('left', 'abc'), right = f.run('right', 'abc');
  const originalId = right.record.runId;
  for (const [field, wrong, expected] of [
    ['sha', 'b'.repeat(40), 'remote.different-commit'],
    ['command', ['node', 'other.mjs'], 'remote.different-command'],
    ['machine', { ...right.record.machine, hostname: 'LEFT.PRIVATE.' }, 'remote.same-host'],
  ]) {
    const previous = right.record[field];
    right.record[field] = wrong;
    if (field === 'sha') right.record.runId = originalId.replace('aaaaaaa', 'bbbbbbb');
    right.save();
    assert.throws(() => compareRuns(left.recordPath, right.recordPath, { rightRoot: right.root }), code(expected));
    right.record[field] = previous;
    right.record.runId = originalId;
    right.save();
  }
});

test('拒绝失败、空清单、缺取回项和磁盘内容改变', t => {
  const f = fixture(t);
  const left = f.run('left', 'abc'), right = f.run('right', 'abc');
  for (const [field, wrong] of [['exitCode', 1], ['files', []], ['fetched', []], ['fetchProblems', ['failed']]]) {
    const previous = right.record[field];
    right.record[field] = wrong;
    right.save();
    assert.throws(() => compareRuns(left.recordPath, right.recordPath), code('remote.invalid-run'));
    right.record[field] = previous;
    right.save();
  }
  writeFileSync(right.file, 'abd');
  assert.throws(() => compareRuns(left.recordPath, right.recordPath), code('remote.artifact-integrity'));
  rmSync(right.file);
  assert.throws(() => compareRuns(left.recordPath, right.recordPath), code('remote.artifact-integrity'));
});

test('可读的两份清单也可缺件或类不符，清单模式仍失败', t => {
  const f = fixture(t);
  const left = f.run('left', 'abc'), right = f.run('right', 'abc');
  right.record.envelope.outputs[0].kind = 'web';
  right.save();
  const kinds = compareRuns(left.recordPath, right.recordPath, { mode: 'inventory' });
  assert.equal(kinds.ok, false);
  assert.deepEqual(kinds.kindDifferences, [LOGICAL]);
  const extra = 'report.json';
  const report = join(right.root, extra);
  writeFileSync(report, '{}');
  right.record.envelope.outputs[0].kind = 'master';
  right.record.files.push({ path: extra, size: 2, sha256: digest('{}') });
  right.record.fetched.push({ path: report.replaceAll('\\', '/'), size: 2, sha256: digest('{}'), kind: 'remote-output' });
  right.save();
  const missing = compareRuns(left.recordPath, right.recordPath, { mode: 'inventory' });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.onlyRight, [extra]);
});

test('拒绝重复路径、大小写冲突、越界与绝对路径和重复输出', t => {
  const f = fixture(t);
  const left = f.run('left', 'abc'), right = f.run('right', 'abc');
  const raw = readFileSync(right.recordPath);
  for (const transform of [
    r => r.files.push(r.files[0]),
    r => r.files.push({ ...r.files[0], path: LOGICAL.toUpperCase() }),
    r => { r.files[0].path = '../outside'; },
    r => { r.files[0].path = 'delivery/../outside'; },
    r => { r.files[0].path = ['C:', 'outside'].join('/'); },
    r => { r.files[0].path = '/outside'; },
    r => { r.files[0].path = 'delivery\\outside'; },
    r => { r.fetched[0].path = 'delivery/../delivery/master.mp4'; },
    r => r.envelope.outputs.push(r.envelope.outputs[0]),
    r => { r.envelope.outputs[0].path = 'bad.mp4'; },
    r => { r.envelope.outputs[0].sha256 = digest('tamper'); },
  ]) {
    const invalid = JSON.parse(raw);
    transform(invalid);
    writeFileSync(right.recordPath, JSON.stringify(invalid));
    assert.throws(() => compareRuns(left.recordPath, right.recordPath), code('remote.invalid-run'));
  }
});

test('拒绝符号链接产物', { skip: process.platform === 'win32' && 'Windows 创建文件符号链接需要特权' }, t => {
  const f = fixture(t);
  const left = f.run('left', 'abc'), right = f.run('right', 'abc');
  rmSync(right.file);
  symlinkSync(left.file, right.file);
  assert.throws(() => compareRuns(left.recordPath, right.recordPath), code('remote.artifact-integrity'));
});
