// C 路线 · 86 式风格索引（tools/c-styles.mjs）的测试：生成物是最新的、86 式齐全、每式有来源与许可、命令行约定、find 排序。
// 运行：node --test "tests/c-style/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = path.join(ROOT, 'tools/c-styles.mjs');
const run = (...args) => spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8' });
const json = r => JSON.parse(r.stdout.trim());
const styles = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'routes/c-style/styles.json'), 'utf8'));

test('STYLES.md 与 styles.json 是最新的（--check 退出码 0，--json 信封带两个输出的 sha256）', () => {
  const r = run('--check', '--json');
  assert.equal(r.status, 0, r.stderr);
  const env = json(r);
  assert.equal(env.ok, true);
  assert.equal(env.exitCode, 0);
  assert.equal(env.error, null);
  assert.deepEqual(env.outputs.map(o => o.path).sort(), ['routes/c-style/STYLES.md', 'routes/c-style/styles.json']);
  for (const o of env.outputs) assert.match(o.sha256, /^[0-9a-f]{64}$/);
});

test('86 式：Lemo 66 + SY 20，id 不重复，每式有来源@提交、MIT、契约、渲染器', () => {
  const d = styles();
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'cases/vendor/lock.json'), 'utf8'));
  const commit = Object.fromEntries(lock.repositories.map(r => [r.name, r.commit.slice(0, 7)]));
  assert.equal(d.styles.length, 86);
  assert.equal(d.styles.filter(s => s.library === 'lemo').length, 66);
  assert.equal(d.styles.filter(s => s.library === 'sy').length, 20);
  assert.equal(new Set(d.styles.map(s => s.id)).size, 86);
  for (const s of d.styles) {
    assert.equal(s.license, 'MIT', s.id);
    assert.equal(s.source, s.library === 'lemo' ? `lemo-opuscar@${commit['lemo-opuscar']}` : `sy-style-100@${commit['sy-style-100']}`, s.id);
    assert.ok(['render(t)', '__seek(t)'].includes(s.contract), s.id);
    assert.ok(['engine-render', 'lemo-core', 'sy-render'].includes(s.renderer), s.id);
    assert.ok(fs.existsSync(path.join(ROOT, s.method.style)), `${s.id} 的 STYLE 链接不存在`);
  }
});

test('Lemo 每式都对应我们做过的一部；自包含 22 部走 engine/render，依赖 /core/ 的 44 部走 Lemo core', () => {
  const lemo = styles().styles.filter(s => s.library === 'lemo');
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'cases/catalog.json'), 'utf8'));
  const ids = new Set(catalog.cases.map(c => c.id));
  for (const s of lemo) {
    assert.ok(s.case && ids.has(s.case.id), `${s.id} 没有对应的本机案例`);
    assert.equal(s.renderer, s.selfContained ? 'engine-render' : 'lemo-core', s.id);
    assert.equal(s.maturity, 'made', s.id);
  }
  assert.equal(lemo.filter(s => s.selfContained).length, 22);
  assert.equal(lemo.filter(s => !s.selfContained).length, 44);
  // 案例目录没有认可记录：不能写成已认可
  assert.ok(lemo.every(s => s.case.acceptance === null));
});

test('SY 20 种：__seek 契约、SY render.js、只有方法（没有本仓库成片）', () => {
  for (const s of styles().styles.filter(x => x.library === 'sy')) {
    assert.equal(s.contract, '__seek(t)');
    assert.equal(s.renderer, 'sy-render');
    assert.equal(s.maturity, 'method');
    assert.equal(s.case, null);
  }
});

test('STYLES.md 每行都带来源@提交与许可', () => {
  const rows = fs.readFileSync(path.join(ROOT, 'routes/c-style/STYLES.md'), 'utf8').split('\n').filter(l => /^\| `(lemo|sy)\//.test(l));
  assert.equal(rows.length, 86);
  for (const l of rows) assert.match(l, /(lemo-opuscar@[0-9a-f]{7}|sy-style-100@[0-9a-f]{7}) · MIT \|/);
});

test('--help 打印用法、退出码 0、不写任何文件', () => {
  const f = path.join(ROOT, 'routes/c-style/STYLES.md'), before = fs.statSync(f).mtimeMs;
  const r = run('--help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /用法/);
  assert.equal(fs.statSync(f).mtimeMs, before);
});

test('用法错误退出码 2：不认识的选项、find 的坏取值、多余参数', () => {
  assert.equal(run('--no-such-flag').status, 2);
  assert.equal(run('find', 'ink', '--tech', 'bogus').status, 2);
  assert.equal(run('find', 'ink', '--top', '0').status, 2);
  assert.equal(run('extra').status, 2);
  const r = run('--no-such-flag', '--json');
  const env = json(r);
  assert.equal(env.ok, false);
  assert.equal(env.exitCode, 2);
  assert.equal(env.error.code, 'usage');
});

test('find：按题材排序，水墨排第一；--tech、--made 过滤；--json 结果在 result 里', () => {
  const r = run('find', 'ink', 'wash', 'poetry', '--json');
  assert.equal(r.status, 0, r.stderr);
  const res = json(r).result;
  assert.equal(res[0].id, 'lemo/ink-wash');
  assert.ok(res[0].matched.includes('poetry'));
  const c2d = json(run('find', 'explainer', '--tech', 'canvas2d', '--made', '--json')).result;
  assert.ok(c2d.length > 0);
  for (const x of c2d) { assert.ok(x.surfaces.includes('Canvas2D')); assert.ok(x.case); }
  const seek = json(run('find', '--contract', 'seek', '--top', '30', '--json')).result;
  assert.equal(seek.length, 20);
  assert.ok(seek.every(x => x.contract === '__seek(t)'));
});
