// C 路线 · 历史复刻运行时（tools/c-runtime.mjs）的测试：命令行约定、隔离运行时不碰 vendor 与家目录、build.sh 改写、SY 适配页。
// 运行：node --test "tests/c-style/*.test.mjs"
// 真建一次运行时（约 1 秒、复制约 110 MB 到临时目录）需要一个装了 numpy、scipy、soundfile 的 Python：
//   用环境变量 PYTHON 或 BEIMING_PY 指定；没有就跳过那一项（其余照跑）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rewriteBuild, syAdapter, samplerNeeds, parse, Fail } from '../../tools/c-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = path.join(ROOT, 'tools/c-runtime.mjs');
const run = (args, env = {}) => spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'c-runtime-test-'));
const envOf = r => JSON.parse(r.stdout.trim().split('\n').pop());

test('--help：退出码 0、打印用法、不建运行时目录', () => {
  const d = tmp(), out = path.join(d, 'rt');
  const r = run(['setup', '--out', out, '--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /用法/);
  assert.equal(fs.existsSync(out), false);
  fs.rmSync(d, { recursive: true, force: true });
});

test('用法错误退出码 2，--json 信封 error.code = usage', () => {
  assert.equal(run(['bogus']).status, 2);
  assert.equal(run(['setup', '--nope']).status, 2);
  assert.equal(run(['--out', 'x', 'setup']).status, 2);
  assert.equal(run(['build']).status, 2);
  assert.equal(run(['build', '/no/such/dir']).status, 2);
  assert.equal(run(['sy', '99']).status, 2);
  assert.equal(run(['build', 'a', 'b']).status, 2);
  const e = envOf(run(['setup', '--timeout', '3', '--json']));
  assert.equal(e.ok, false); assert.equal(e.exitCode, 2); assert.equal(e.error.code, 'usage');
});

test('运行时目录不许放在 cases/ 下、家目录或 ~/lemo-opuscar', () => {
  assert.equal(run(['setup', '--dry-run', '--out', path.join(ROOT, 'cases', 'x')]).status, 2);
  assert.equal(run(['setup', '--dry-run', '--out', os.homedir()]).status, 2);
  assert.equal(run(['setup', '--dry-run', '--out', path.join(os.homedir(), 'lemo-opuscar')]).status, 2);
});

test('status：运行时不存在时退出码 3，--json 信封可解析', () => {
  const d = tmp();
  const r = run(['status', '--out', path.join(d, 'none'), '--json']);
  assert.equal(r.status, 3);
  const e = envOf(r);
  assert.equal(e.error.code, 'environment');
  assert.match(e.error.hint, /setup/);
  fs.rmSync(d, { recursive: true, force: true });
});

const PY = process.env.PYTHON || process.env.BEIMING_PY;
const pyOk = PY && spawnSync(PY, ['-c', 'import numpy, scipy, soundfile'], { stdio: 'ignore' }).status === 0;

test('setup 真建一次：只复制锁里的文件、链接根 node_modules、写转发小脚本；不碰 vendor 与家目录', { skip: pyOk ? false : '没有设 PYTHON / BEIMING_PY（要带 numpy、scipy、soundfile）' }, () => {
  const d = tmp(), out = path.join(d, 'rt'), home = path.join(d, 'home');
  fs.mkdirSync(home);
  const vendorBefore = spawnSync('git', ['status', '--porcelain', '--', 'cases/vendor'], { cwd: ROOT, encoding: 'utf8' }).stdout;
  const r = run(['setup', '--out', out, '--python', PY, '--json'], { HOME: home, USERPROFILE: home });
  assert.equal(r.status, 0, r.stderr);
  const e = envOf(r);
  assert.equal(e.ok, true);
  const rt = JSON.parse(fs.readFileSync(path.join(out, 'runtime.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'cases/vendor/lock.json'), 'utf8')).repositories.find(x => x.name === 'lemo-opuscar');
  assert.equal(rt.commit, lock.commit);
  assert.equal(rt.files, lock.files.length);
  for (const f of lock.files.slice(0, 50)) assert.equal(fs.statSync(path.join(out, f.path)).size, f.size, f.path);
  assert.ok(fs.existsSync(path.join(out, 'node_modules', 'playwright-core', 'package.json')), 'node_modules 链接没有指到仓库根');
  assert.match(fs.readFileSync(path.join(out, '.venv', 'bin', 'python'), 'utf8'), /^#!\/bin\/sh\n# c-runtime/);
  assert.deepEqual(fs.readdirSync(home), [], '家目录里不该多出任何东西');
  assert.equal(spawnSync('git', ['status', '--porcelain', '--', 'cases/vendor'], { cwd: ROOT, encoding: 'utf8' }).stdout, vendorBefore);
  // 再跑一次：清单一致就跳过复制，仍然成功（幂等）
  const again = run(['setup', '--out', out, '--python', PY]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stderr, /跳过复制/);
  assert.equal(run(['status', '--out', out]).status, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('rewriteBuild：LIB= 指到运行时、$LIB/.venv/bin/python 换成 $C_RUNTIME_PY，给单条命令设 LIB 的写法不动', () => {
  const src = [
    '#!/bin/sh', 'set -e', 'LIB=/old/lemo   # 注释', 'HERE=$(cd "$(dirname "$0")" && pwd)', 'PY="$LIB/.venv/bin/python"',
    '"$LIB/.venv/bin/python" "$HERE/mix.py"', 'LIB=${LIB_OVERRIDE:-$LIB}; export LIB', 'LIB="$LIB" .venv/bin/python "$P/mix.py"', '',
  ].join('\n');
  const { text, notes } = rewriteBuild(src, '/rt/lemo');
  assert.match(text, /^LIB='\/rt\/lemo' {3}# c-runtime：原为 \/old\/lemo$/m);
  assert.match(text, /^PY="\$C_RUNTIME_PY"$/m);
  assert.match(text, /^"\$C_RUNTIME_PY" "\$HERE\/mix\.py"$/m);
  assert.match(text, /^LIB=\$\{LIB_OVERRIDE:-\$LIB\}; export LIB$/m);
  assert.match(text, /^LIB="\$LIB" \.venv\/bin\/python/m);
  assert.equal(notes.length, 2);
});

test('rewriteBuild：没有 LIB= 或还有没替换的还原标记时以退出码 4 停下', () => {
  assert.throws(() => rewriteBuild('echo hi\n', '/rt'), e => e instanceof Fail && e.exitCode === 4);
  assert.throws(() => rewriteBuild('LIB=/x\nscp a @@ROG_HOST@@:b\n', '/rt'), e => e instanceof Fail && e.exitCode === 4 && /ROG_HOST/.test(e.message));
});

test('build：源码模式还原、缺还原记录、没有运行时都在运行前停下', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'build.sh'), 'LIB=/x\n');
  assert.equal(run(['build', d]).status, 4);                       // 缺 ARCHIVE-RESTORED.json
  fs.writeFileSync(path.join(d, 'ARCHIVE-RESTORED.json'), JSON.stringify({ case: 'style-02-watercolor', sourceOnly: true }));
  const r = run(['build', d, '--json']);
  assert.equal(r.status, 4);
  assert.match(envOf(r).error.hint, /--download/);
  fs.writeFileSync(path.join(d, 'ARCHIVE-RESTORED.json'), JSON.stringify({ case: 'style-02-watercolor', sourceOnly: false }));
  assert.equal(run(['build', d, '--out', path.join(d, 'no-runtime')]).status, 3);
  fs.rmSync(d, { recursive: true, force: true });
});

test('samplerNeeds：按 sampler.py 的乐器表与作品声音脚本里引用的乐器名，算出要哪些采样库', () => {
  const d = tmp(), rt = path.join(d, 'rt'), film = path.join(d, 'film');
  fs.mkdirSync(path.join(rt, 'core', 'audio'), { recursive: true });
  fs.mkdirSync(path.join(film, 'music'), { recursive: true });
  fs.writeFileSync(path.join(rt, 'core', 'audio', 'sampler.py'), [
    "ROOT = os.path.join(x, 'instruments')", "V, C, F = 'vsco2ce/', 'vcsl/', 'freepats/'", "VI, VM = C + 'Idio/', C + 'Mem/'", 'REG = {',
    "    'violins':   dict(src=V + 'Strings/x', kind='sus'),", "    'sus_cymbal': dict(src=VI + 'Cymbal', kind='hit'),",
    "    'accordion': dict(src=(F + 'Accordion', 'x'), kind='sus'),", "    'harp':      dict(src=V + 'Harp', kind='dec'),", '}', ''].join('\n'));
  fs.writeFileSync(path.join(film, 'music', 'score.py'), "S.hit('sus_cymbal', 1)\nev = [('violins', 60)]\n");
  assert.deepEqual(samplerNeeds(film, rt), { instruments: ['sus_cymbal', 'violins'], libs: ['vcsl', 'vsco2ce'] });
  fs.rmSync(d, { recursive: true, force: true });
});

test('syAdapter：<base> 指回只读快照、强制 ?render=1、__seek 挂成 render(t) 并在第 0 秒画好后置 READY', () => {
  const html = '<!doctype html><html><head><meta charset="utf-8"><script src="../../lib/core.js"></script></head><body><canvas></canvas></body></html>';
  const out = syAdapter(html, '18-ink');
  const i = out.indexOf('<base href="/cases/vendor/sy-style-100/styles/18-ink/">');
  assert.ok(i > out.indexOf('<head>') && i < out.indexOf('../../lib/core.js'), '<base> 要在第一个相对地址之前');
  assert.ok(out.indexOf('render=1') < out.indexOf('../../lib/core.js'), '?render=1 要在 SY 的 core.js 读 location 之前补上');
  assert.ok(out.indexOf('window.READY=true') > out.indexOf('<canvas>') && out.indexOf('window.READY=true') < out.indexOf('</body>'));
  assert.match(out, /window\.render=function\(t\)\{return window\.__seek\(t\)\}/);
});

test('parse：assets 收集包名，build / sy 只收一个目标', () => {
  assert.deepEqual(parse(['assets', 'instruments-vcsl', 'voice']).packs, ['instruments-vcsl', 'voice']);
  assert.equal(parse(['build', 'out/x', '--timeout', '0']).timeout, 0);
  assert.deepEqual(parse(['sy', '18', '--still', '0.5,2']).still, ['0.5', '2']);
  assert.throws(() => parse(['sy', '18', '--still', 'a']), e => e.exitCode === 2);
});
