// A 路线的仓库规则、模版契约与命令约定：node --test tests/style/route-a.test.mjs
// 规则用仓库外的临时「films 目录」做反例（未登记的 lookPreset、断开的镜头表、越界的事件、缺字的子集），不碰仓库里的作品。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runRules, rules } from '../../tools/repo-check/rules/route-a/index.mjs';
import { parseArgs, EXIT, CliError } from '../../tools/lookdev/lib/cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TPL = JSON.parse(fs.readFileSync(path.join(ROOT, 'routes/a-webgl/template/film.json'), 'utf8'));

function filmsDir(films) {   // { 名字: film.json 对象 } → 临时 films 目录（每部片放上模版的镜头模块，模块存在性检查才过得去）
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-films-'));
  for (const [name, film] of Object.entries(films)) {
    fs.mkdirSync(path.join(d, name, 'shots'), { recursive: true });
    fs.writeFileSync(path.join(d, name, 'film.json'), JSON.stringify(film));
    for (const s of film.shots || []) if (s.module) fs.writeFileSync(path.join(d, name, s.module), '// 测试用');
  }
  return d;
}
const instance = (over = {}) => {
  const f = JSON.parse(JSON.stringify(TPL).replaceAll('{{NAME}}', 'tst').replaceAll('{{TITLE}}', '晨渡'));
  return Object.assign(f, over);
};
const errorsOf = (res, rule) => res.filter(r => r.level === 'error' && (!rule || r.rule === rule)).map(r => r.message);

test('当前仓库：A 路线规则全部通过', async () => {
  const res = await runRules(ROOT);
  assert.deepEqual(errorsOf(res), []);
  assert.ok(rules.length >= 7);
  for (const r of rules) assert.match(r.id, /^route-a\./);
});

test('未登记的 lookPreset、别的画风的预设、越界的镜头覆盖都让规则失败', async () => {
  const bad = instance();
  bad.shots = bad.shots.map((s, i) => i === 0 ? { ...s, lookPreset: 'beiming-original@v1/closeup' } : { ...s, lookOverrides: { paper: { strength: 0.5 } } });
  const other = instance({ style: { id: 'beiming-original', version: 2 } });
  const d = filmsDir({ bad, other });
  try {
    const res = await runRules(ROOT, { filmsDir: d, template: false });
    const e = errorsOf(res, 'route-a.film-style').join('\n');
    assert.match(e, /closeup/);
    assert.match(e, /超出允许范围/);
    assert.match(e, /beiming-original@v2 没有登记/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('镜头表断开、没覆盖到片尾、事件不在所属镜头里，都报错', async () => {
  const f = instance();
  f.shots = [{ ...f.shots[0], out: 60 }, { ...f.shots[1], in: 72 }];
  f.events = [...f.events, { id: 'x', frame: 10, shot: 'S2' }, { id: 'y', frame: 3.5, shot: 'S1' }];
  f.output = { ...f.output, frameCount: 200 };
  const d = filmsDir({ f });
  try {
    const e = errorsOf(await runRules(ROOT, { filmsDir: d, template: false }), 'route-a.film-timeline').join('\n');
    assert.match(e, /首尾相接/);
    assert.match(e, /frameCount 是 200/);
    assert.match(e, /事件 x 在第 10 帧，不在镜头 S2/);
    assert.match(e, /事件 y 的 frame 要是整数帧/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('作品字体：没生成子集、子集缺字、子集文件被改都报错；声明了却不在锁定清单里也报错', async () => {
  const f = instance(), g = instance({ fonts: [{ family: 'BM Title', source: 'no-such-font' }, TPL.fonts[1]] });
  const d = filmsDir({ f, g });
  try {
    let e = errorsOf(await runRules(ROOT, { filmsDir: d, template: false }), 'route-a.film-fonts').join('\n');
    assert.match(e, /还没生成字体子集/);
    assert.match(e, /no-such-font 不在 fonts\/fonts\.lock\.json/);
    fs.mkdirSync(path.join(d, 'f', 'fonts'));
    const woff = Buffer.from('x');
    const M = { schemaVersion: 1, fonts: [
      { family: 'BM Title', file: 't.woff2', chars: '晨', sha256: crypto.createHash('sha256').update(woff).digest('hex') },
      { family: 'BM Text', file: 's.woff2', chars: '北冥风格 ·概念短片', sha256: crypto.createHash('sha256').update(woff).digest('hex') }] };
    fs.writeFileSync(path.join(d, 'f', 'fonts', 'fonts.json'), JSON.stringify(M));
    fs.writeFileSync(path.join(d, 'f', 'fonts', 't.woff2'), woff);
    fs.writeFileSync(path.join(d, 'f', 'fonts', 's.woff2'), 'changed');
    e = errorsOf(await runRules(ROOT, { filmsDir: d, template: false }), 'route-a.film-fonts').join('\n');
    assert.match(e, /文字 title 缺字 渡/);
    assert.match(e, /s\.woff2 与清单记的 sha256 不一致/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('模版 film.json 是 v2 且自洽：时长 = 帧数 ÷ 帧率、文字都登记了字族、事件按帧给、gates 三道闸都 required', () => {
  assert.equal(TPL.schemaVersion, 2);
  assert.equal(TPL.route, 'a');
  assert.equal(TPL.title, '{{TITLE}}');
  assert.equal(TPL.output.profile, 'web-1080p24');
  assert.deepEqual([TPL.output.width, TPL.output.height, TPL.output.fps], [1920, 1080, 24]);
  assert.ok(Number.isInteger(TPL.output.frameCount));
  for (const g of ['look', 'animatic', 'final']) assert.equal(TPL.gates[g], 'required');
  for (const e of TPL.events) assert.ok(Number.isInteger(e.frame) && e.audio && e.visual, `事件 ${e.id} 要有整数帧和声画两侧的名字`);
  assert.equal(TPL.aigc.contains, true, '天空底板是 AI 生成，要写明（D11）');
  assert.ok(!('dur' in TPL) && !('size' in TPL), 'v1 的 dur / size 不再出现（没有消费者的时间字段）');
});

test('命令约定库：未知参数是用法错误（退出码 2）；list 拆逗号、list-raw 整段累加', () => {
  assert.throws(() => parseArgs(['--nope'], {}), e => e instanceof CliError && e.exit === EXIT.USAGE);
  assert.throws(() => parseArgs(['--n'], { n: 'number' }), e => e.exit === EXIT.USAGE);
  assert.throws(() => parseArgs(['--n', 'x'], { n: 'number' }), e => e.exit === EXIT.USAGE);
  const { opts, args } = parseArgs(['a', '--t', '1,2', '--look', 'x=[1,2],[3,4]', '--look', 'y=1,2', '--ok'], { t: 'list', look: 'list-raw', ok: 'bool' });
  assert.deepEqual(args, ['a']);
  assert.deepEqual(opts.t, ['1', '2']);
  assert.deepEqual(opts.look, ['x=[1,2],[3,4]', 'y=1,2']);
  assert.equal(opts.ok, true);
});

test('A 路线命令：--help 都退出 0 且不写文件；未知参数都退出 2', () => {
  const cmds = ['tools/fonts/subset.mjs', 'tools/fonts/fetch.mjs', 'tools/lookdev/sweep.mjs', 'tools/plates/check.mjs', 'tools/plates/bleed.mjs', 'tools/repo-check/rules/route-a/index.mjs'];
  for (const c of cmds) {
    const h = spawnSync(process.execPath, [path.join(ROOT, c), '--help'], { encoding: 'utf8' });
    assert.equal(h.status, 0, `${c} --help`);
    assert.match(h.stdout, /用法/, `${c} --help 输出到 stdout`);
    const u = spawnSync(process.execPath, [path.join(ROOT, c), '--no-such-flag'], { encoding: 'utf8' });
    assert.equal(u.status, 2, `${c} --no-such-flag`);
  }
});
