// 金标准与确定性命令的契约与集成测试：node --test tests/golden/cli.test.mjs
// 契约部分不开浏览器；集成部分用 tests/golden/fixtures 下的 2D 夹具页（几秒），没装无头浏览器时自动跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const GOLDEN = path.join(ROOT, 'tools/baseline/golden.mjs');
const DET = path.join(ROOT, 'tools/baseline/determinism.mjs');
const run = (script, args, env = {}) => {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 300000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const envelope = s => {
  const lines = s.trim().split('\n');
  assert.equal(lines.length, 1, `--json 时 stdout 只能有一行 JSON，实际：${s.slice(0, 300)}`);
  const j = JSON.parse(lines[0]);
  for (const k of ['ok', 'exitCode', 'command', 'error', 'outputs', 'runJson', 'warnings']) assert.ok(k in j, `信封缺 ${k}`);
  return j;
};
function snapshot(dir) {
  if (!fs.existsSync(dir)) return '';
  const out = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(`${p}:${fs.statSync(p).mtimeMs}`); } };
  walk(dir);
  return out.sort().join('\n');
}
const tracked = ['tests/golden/manifests', 'tests/golden/approvals.jsonl'];
const trackedState = () => tracked.map(p => snapshot(path.join(ROOT, p)) || (fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p), 'utf8') : '')).join('|');

test('--help 输出到 stdout、exit 0、不留任何文件', () => {
  const outState = () => ['out/golden', 'out/determinism'].map(d => snapshot(path.join(ROOT, d))).join('|');
  const before = outState() + trackedState();
  for (const [s, args] of [[GOLDEN, ['--help']], [GOLDEN, ['compare', '--help']], [DET, ['--help']], [DET, ['.', '--help']]]) {
    const r = run(s, args);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /用法/);
  }
  assert.equal(outState() + trackedState(), before);
});

test('未知参数与错用的子命令参数 → exit 2，--json 信封可解析', () => {
  for (const [s, args] of [[GOLDEN, ['capture', '--no-such-flag', '--json']], [GOLDEN, ['capture', '--by', 'x', '--set', 'fixtures', '--json']],
    [GOLDEN, ['nope', '--json']], [DET, ['--no-such-flag', '--json']], [DET, ['--json']], [DET, ['.', '--template', 'a', '--json']]]) {
    const r = run(s, args);
    assert.equal(r.code, 2, `${args.join(' ')}：${r.err}`);
    const j = envelope(r.out);
    assert.equal(j.ok, false); assert.equal(j.exitCode, 2); assert.equal(j.error.code, 'usage');
  }
});

test('update 没有审批记录、或不在被登记的提交上 → 拒绝且不写清单', () => {
  const before = trackedState();
  const r1 = run(GOLDEN, ['update', '--set', 'fixtures', '--json']);
  assert.equal(r1.code, 2); assert.match(envelope(r1.out).error.message, /--by/);
  const r2 = run(GOLDEN, ['update', '--set', 'fixtures', '--by', '测试', '--reason', '测试', '--commit', 'HEAD~1', '--json']);
  assert.ok([2, 4].includes(r2.code), r2.err);   // HEAD~1 不存在时是 2，存在时因不是 HEAD 是 4
  assert.equal(trackedState(), before);
});

test('list --json 列出集合', () => {
  const r = run(GOLDEN, ['list', '--json']);
  assert.equal(r.code, 0, r.err);
  const j = envelope(r.out);
  assert.ok(j.result.sets.some(s => s.name === 'beiming-core'));
});

test('静态扫描：仓库默认范围没有未登记的不确定 API', () => {
  const r = run(DET, ['--scan-only', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(envelope(r.out).result.scan.errors.length, 0);
});

// ── 集成（要无头浏览器）──
let browserOk = false;
try {
  const { chromium } = await import('playwright-core');
  browserOk = fs.existsSync(chromium.executablePath()) || !!process.env.BEIMING_CHROME;
} catch { browserOk = false; }
const gpuEnv = process.env.BEIMING_TEST_GPU || (process.platform === 'darwin' ? 'any' : 'software-ok');

test('确定性：纯函数夹具通过（exit 0），有累计状态的反例夹具判不通过（exit 4）', { skip: !browserOk && '没装无头浏览器' }, () => {
  const tmp = fs.mkdtempSync(path.join(ROOT, 'out', '.det-test-'));
  try {
    const ok = run(DET, ['tests/golden/fixtures/pure', '--size', '320x180', '--gpu', gpuEnv, '--no-scan', '--out', path.join(tmp, 'pure'), '--json']);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(envelope(ok.out).ok, true);
    const bad = run(DET, ['tests/golden/fixtures/stateful', '--size', '320x180', '--frames', '5,30', '--gpu', gpuEnv, '--no-scan', '--out', path.join(tmp, 'stateful'), '--json']);
    assert.equal(bad.code, 4, bad.err);
    const j = envelope(bad.out);
    assert.equal(j.error.code, 'nondeterministic');
    const rep = JSON.parse(fs.readFileSync(path.join(ROOT, j.runJson), 'utf8'));
    assert.ok(rep.rows.every(r => r.status === 'differs'));
    assert.ok(rep.rows.some(r => r.diff && fs.existsSync(path.join(tmp, 'stateful', r.diff))), '应输出差异热图');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('金标准：同一页面自比逐像素一致；页面被改动（方块平移 3 像素）→ exit 4 并出差异热图与接触印', { skip: !browserOk && '没装无头浏览器' }, () => {
  const tmp = fs.mkdtempSync(path.join(ROOT, 'out', '.golden-test-'));
  try {
    // 被改动的页面放在仓库内的临时目录，页面名不变，所以帧编号与参照一一对应
    const shifted = path.join(tmp, 'pure-shifted');
    fs.mkdirSync(shifted);
    fs.writeFileSync(path.join(shifted, 'index.html'), fs.readFileSync(path.join(ROOT, 'tests/golden/fixtures/pure/index.html'), 'utf8').replace("get('shift') || 0", "get('shift') || 3"));
    const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/baseline/sets.json'), 'utf8'));
    const mk = (name, dir) => {
      const s = { schema: base.schema, pages: { 'fixture:pure': { dir, fps: 24 } }, sets: { fixtures: { tolerance: base.sets.fixtures.tolerance, shots: [{ page: 'fixture:pure', size: [320, 180], times: { frames: [0, 12, 24, 47] } }] } } };
      const f = path.join(tmp, name); fs.writeFileSync(f, JSON.stringify(s)); return f;
    };
    const refSets = mk('ref.json', 'tests/golden/fixtures/pure'), badSets = mk('bad.json', path.relative(ROOT, shifted).split(path.sep).join('/'));
    const cap = run(GOLDEN, ['capture', '--set', 'fixtures', '--sets', refSets, '--gpu', gpuEnv, '--out', path.join(tmp, 'ref'), '--json']);
    assert.equal(cap.code, 0, cap.err);
    const same = run(GOLDEN, ['compare', '--set', 'fixtures', '--sets', refSets, '--ref-dir', path.join(tmp, 'ref'), '--strict', '--gpu', gpuEnv, '--out', path.join(tmp, 'cmp-same'), '--json']);
    assert.equal(same.code, 0, same.err);
    const sj = envelope(same.out);
    assert.equal(sj.result[0].summary.identical, 4);
    const diff = run(GOLDEN, ['compare', '--set', 'fixtures', '--sets', badSets, '--ref-dir', path.join(tmp, 'ref'), '--gpu', gpuEnv, '--out', path.join(tmp, 'cmp-bad'), '--json']);
    assert.equal(diff.code, 4, diff.err);
    const dj = envelope(diff.out);
    assert.equal(dj.error.code, 'golden-mismatch');
    assert.equal(dj.result[0].summary.differs, 4);
    assert.ok(dj.outputs.some(o => o.kind === 'contact-sheet'), '应输出接触印');
    const rep = JSON.parse(fs.readFileSync(path.join(ROOT, dj.runJson), 'utf8'));
    assert.ok(rep.frames.every(f => f.diff && fs.existsSync(path.join(tmp, 'cmp-bad', 'fixtures', f.diff))));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
