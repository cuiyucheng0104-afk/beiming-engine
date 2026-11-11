// A 路线的仓库规则、模版契约与命令约定：node --test tests/style/route-a.test.mjs
// 规则在仓库外搭的小仓库上跑（tools/repo-check/core/context.mjs 的 createContext，与 node tools/repo-check.mjs --root 同一套上下文），
// 用反例（未登记的 lookPreset、断开的镜头表、越界的事件、缺字的子集、坏掉的变体表）证明规则会失败；不碰仓库里的作品。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createContext } from '../../tools/repo-check/core/context.mjs';
import { loadRules } from '../../tools/repo-check/core/loader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RULES_DIR = path.join(ROOT, 'tools/repo-check/rules');
const TPL = JSON.parse(fs.readFileSync(path.join(ROOT, 'routes/a-webgl/template/film.json'), 'utf8'));
const { rules } = await loadRules(RULES_DIR);
const A = rules.filter(r => r.domain === 'route-a');
const rule = id => A.find(r => r.id === id);

// 小仓库：画风注册表 + 锁定文件、字体锁定清单 + 许可、给定的作品（每部片放上镜头模块的占位文件）
function miniRepo(films = {}, { template = false } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-route-a-'));
  const copy = rel => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.cpSync(path.join(ROOT, rel), path.join(d, rel), { recursive: true }); };
  for (const rel of ['engine/style', 'fonts/fonts.lock.json', 'fonts/licenses']) copy(rel);
  if (template) copy('routes/a-webgl/template');
  for (const [name, film] of Object.entries(films)) {
    fs.mkdirSync(path.join(d, 'films', name, 'shots'), { recursive: true });
    fs.writeFileSync(path.join(d, 'films', name, 'film.json'), JSON.stringify(film));
    for (const s of film.shots || []) if (s.module) fs.writeFileSync(path.join(d, 'films', name, s.module), '// 测试用');
  }
  return d;
}
const instance = (over = {}) => Object.assign(JSON.parse(JSON.stringify(TPL).replaceAll('{{NAME}}', 'tst').replaceAll('{{TITLE}}', '晨渡')), over);
const errors = async (id, root) => (await rule(id).run(createContext({ root }))).filter(f => f.level === 'error').map(f => f.message);
const cleanup = d => fs.rmSync(d, { recursive: true, force: true });

test('规则文件按治理骨架的加载器加载：7 条 route-a 规则，id 与目录一致', () => {
  assert.deepEqual(A.map(r => r.id).sort(), ['route-a.film-fonts', 'route-a.film-style', 'route-a.film-timeline', 'route-a.fonts-lock', 'route-a.kun-variants', 'route-a.plates', 'route-a.style-registry']);
});

test('当前仓库：已跟踪的内容 route-a 规则没有错误（node tools/repo-check.mjs --only route-a --json）', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/repo-check.mjs'), '--only', 'route-a', '--json'], { encoding: 'utf8' });
  const env = JSON.parse(r.stdout);
  const mine = env.data.findings.filter(f => f.rule.startsWith('route-a.'));
  // 本地在制、还没提交的作品（例如刚 npm run new、还没跑 subset）不让单元测试变红——那是 check:repo 的事；不是 git 检出时 films/ 一律不看
  const g = spawnSync('git', ['-C', ROOT, 'ls-files', '--', 'films'], { encoding: 'utf8' });
  const tracked = new Set(g.status === 0 ? g.stdout.split('\n').map(f => /^films\/([^/]+)\//.exec(f)?.[1]).filter(Boolean) : []);
  const local = f => { const m = /^films\/([^/]+)\//.exec(f.file || ''); return !!m && !tracked.has(m[1]); };
  assert.deepEqual(mine.filter(f => f.level === 'error' && !local(f)), []);
  assert.equal(env.data.rules.filter(x => x.id.startsWith('route-a.')).length, 7);
  assert.ok(mine.some(f => f.rule === 'route-a.film-style' && /beiming-original@v1/.test(f.message)), '模版的画风被核对过');
});

test('未登记的 lookPreset、别的画风的预设、越界的镜头覆盖、没登记的画风都让 film-style 失败', async () => {
  const bad = instance();
  bad.shots = bad.shots.map((s, i) => (i === 0 ? { ...s, lookPreset: 'beiming-original@v1/closeup' } : { ...s, lookOverrides: { paper: { strength: 0.5 } } }));
  const other = instance({ style: { id: 'beiming-original', version: 2 } });
  const d = miniRepo({ bad, other });
  try {
    const e = (await errors('route-a.film-style', d)).join('\n');
    assert.match(e, /closeup/);
    assert.match(e, /超出允许范围/);
    assert.match(e, /beiming-original@v2 没有登记/);
  } finally { cleanup(d); }
});

test('镜头表断开、没覆盖到片尾、事件不在所属镜头里、事件帧不是整数，film-timeline 都报错', async () => {
  const f = instance();
  f.shots = [{ ...f.shots[0], out: f.shots[0].out - 12 }, { ...f.shots[1] }];
  f.events = [...f.events, { id: 'x', frame: 10, shot: 'S2' }, { id: 'y', frame: 3.5, shot: 'S1' }];
  f.output = { ...f.output, frameCount: f.output.frameCount + 32 };
  const d = miniRepo({ f });
  try {
    const e = (await errors('route-a.film-timeline', d)).join('\n');
    assert.match(e, /上一镜到第 \d+ 帧为止/);
    assert.match(e, new RegExp(`frameCount 是 ${f.output.frameCount}`));
    assert.match(e, /事件 x 在第 10 帧，不在镜头 S2/);
    assert.match(e, /事件 y 的 frame 要是整数帧/);
  } finally { cleanup(d); }
});

test('镜像作品（mirror.paths = repo，如 P05 的 films/beiming-10s）：模块按仓库根找、没写 lookPreset 只记提示；照模版做的作品没写仍报错', async () => {
  const mir = { schemaVersion: 2, id: 'mir', title: '北冥', route: 'a', backend: 'three', mirror: { paths: 'repo', frozen: true },
    output: { profile: 'beiming-1040p24', width: 1920, height: 1040, fps: 24, frameCount: 120 },
    shots: [{ id: 'A', in: 0, out: 72, module: 'src/shotA.js' }, { id: 'B', in: 72, out: 120, module: 'src/shotB.js' }],
    events: [{ id: 'touch', frame: 84, shot: 'B' }], style: { id: 'beiming-original', version: 1 } };
  const plain = instance();
  delete plain.shots[0].lookPreset;
  const d = miniRepo({ plain });
  fs.mkdirSync(path.join(d, 'films/mir'));   // miniRepo 把占位模块放在作品目录里；镜像作品的模块在仓库根，这里自己摆
  fs.writeFileSync(path.join(d, 'films/mir/film.json'), JSON.stringify(mir));
  fs.mkdirSync(path.join(d, 'src'));
  fs.writeFileSync(path.join(d, 'src/shotA.js'), '// 测试用');
  const of = async (id, name) => (await rule(id).run(createContext({ root: d }))).filter(f => f.file === `films/${name}/film.json`);
  try {
    let tl = (await of('route-a.film-timeline', 'mir')).filter(f => f.level === 'error').map(f => f.message);
    assert.deepEqual(tl, ['镜头 B 的模块 src/shotB.js 不存在'], 'shotA 在仓库根找到了，shotB 缺了照样报');
    fs.writeFileSync(path.join(d, 'src/shotB.js'), '// 测试用');
    tl = await of('route-a.film-timeline', 'mir');
    assert.deepEqual(tl.filter(f => f.level === 'error'), []);
    const st = await of('route-a.film-style', 'mir');
    assert.deepEqual(st.filter(f => f.level === 'error'), []);
    assert.ok(st.some(f => f.level === 'info' && /2 个镜头没写（镜像作品/.test(f.message)));
    const pe = (await of('route-a.film-style', 'plain')).filter(f => f.level === 'error').map(f => f.message).join('\n');
    assert.match(pe, /镜头 S1 没写 lookPreset（A 模版的页面按它取后期预设/);
  } finally { cleanup(d); }
});

test('作品字体：没生成子集、子集缺字、子集文件被改、source 不在锁定清单里，film-fonts 都报错', async () => {
  const f = instance(), g = instance({ fonts: [{ family: 'BM Title', source: 'no-such-font' }, TPL.fonts[1]] });
  const d = miniRepo({ f, g });
  try {
    let e = (await errors('route-a.film-fonts', d)).join('\n');
    assert.match(e, /还没生成本片的字体子集/);
    assert.match(e, /no-such-font 不在 fonts\/fonts\.lock\.json/);
    const fd = path.join(d, 'films', 'f', 'fonts'), woff = Buffer.from('x'), h = crypto.createHash('sha256').update(woff).digest('hex');
    fs.mkdirSync(fd);
    const sub = TPL.texts.find(t => t.id === 'subtitle').text;
    fs.writeFileSync(path.join(fd, 'fonts.json'), JSON.stringify({ schemaVersion: 1, fonts: [
      { family: 'BM Title', file: 't.woff2', chars: '晨', sha256: h }, { family: 'BM Text', file: 's.woff2', chars: sub, sha256: h }] }));
    fs.writeFileSync(path.join(fd, 't.woff2'), woff);
    fs.writeFileSync(path.join(fd, 's.woff2'), 'changed');
    e = (await errors('route-a.film-fonts', d)).join('\n');
    assert.match(e, /文字 title 缺字 渡/);
    assert.match(e, /s\.woff2 与清单记的 sha256 不一致/);
  } finally { cleanup(d); }
});

test('画风注册表：锁定文件与登记表的认可状态不一致、候选写了认可、基准帧不在，style-registry 都报错', async () => {
  const d = miniRepo();
  try {
    const rf = path.join(d, 'engine/style/registry.json'), reg = JSON.parse(fs.readFileSync(rf, 'utf8'));
    fs.mkdirSync(path.join(d, 'media'));
    for (const b of reg.styles[0].baselineFrames) fs.writeFileSync(path.join(d, b), '基准帧占位');
    assert.deepEqual(await errors('route-a.style-registry', d), [], '原样复制的注册表合格');
    fs.rmSync(path.join(d, 'media', 'shot_1.6.jpg'));
    reg.styles[0].userApproval = 'approved';
    reg.candidates[0].userApproval = 'approved';
    fs.writeFileSync(rf, JSON.stringify(reg));
    const e = (await errors('route-a.style-registry', d)).join('\n');
    assert.match(e, /认可状态不一致/);
    assert.match(e, /候选 tonal-40 写了认可状态/);
    assert.match(e, /基准帧 media\/shot_1\.6\.jpg 不存在/);
  } finally { cleanup(d); }
});

test('字体锁定清单：许可全文被改过、只收 OFL，fonts-lock 都报错', async () => {
  const d = miniRepo();
  try {
    assert.deepEqual(await errors('route-a.fonts-lock', d), []);
    fs.appendFileSync(path.join(d, 'fonts/licenses/OFL-mashanzheng.txt'), '\n多了一行');
    const lf = path.join(d, 'fonts/fonts.lock.json'), lock = JSON.parse(fs.readFileSync(lf, 'utf8'));
    lock.fonts[1].license = 'Apache-2.0';
    fs.writeFileSync(lf, JSON.stringify(lock));
    const e = (await errors('route-a.fonts-lock', d)).join('\n');
    assert.match(e, /许可全文的 sha256 与清单不一致/);
    assert.match(e, /只收 OFL-1\.1/);
  } finally { cleanup(d); }
});

test('鲲变体表：模块不存在、认可状态不认识，kun-variants 报错', async () => {
  const d = miniRepo();
  try {
    const e = (await errors('route-a.kun-variants', d)).join('\n');
    assert.match(e, /src\/kun\.js 不存在/, '小仓库里没有 src/，变体表的模块缺失要报出来');
    const rf = path.join(d, 'engine/style/registry.json'), reg = JSON.parse(fs.readFileSync(rf, 'utf8'));
    reg.variants.kun.items[0].approval = 'ok';
    fs.writeFileSync(rf, JSON.stringify(reg));
    assert.match((await errors('route-a.kun-variants', d)).join('\n'), /认可状态 "ok" 不认识/);
  } finally { cleanup(d); }
});

test('模版 film.json 是 v2 且自洽：画幅 1920×1080 web-1080p24、事件按帧给、gates 三道闸、下一步走统一出片命令', () => {
  assert.equal(TPL.schemaVersion, 2);
  assert.equal(TPL.route, 'a');
  assert.equal(TPL.backend, 'three');
  assert.equal(TPL.title, '{{TITLE}}');
  assert.equal(TPL.output.profile, 'web-1080p24');
  assert.deepEqual([TPL.output.width, TPL.output.height, TPL.output.fps], [1920, 1080, 24]);
  assert.ok(Number.isInteger(TPL.output.frameCount));
  for (const g of ['look', 'animatic', 'final']) assert.equal(TPL.gates[g], 'required');
  for (const e of TPL.events) assert.ok(Number.isInteger(e.frame) && e.audio && e.visual, `事件 ${e.id} 要有整数帧和声画两侧的名字`);
  assert.equal(TPL.aigc.contains, true, '天空底板是 AI 生成，要写明（D11）');
  assert.ok(TPL.style.baseline && TPL.style.lock, 'A 路线写视觉基准与风格锁定文件（P05 的 style-baseline-missing）');
  assert.ok(!('dur' in TPL) && !('size' in TPL) && !('poster' in TPL), 'v1 的 dur / size / poster 不再出现');
  const runs = (TPL.next || []).map(s => s.run.join(' '));
  assert.ok(runs.some(r => r.startsWith('node tools/fonts/subset.mjs')), '下一步先生成本片字体子集');
  assert.ok(runs.some(r => /^npm run film -- build /.test(r)), '出片走统一入口 npm run film -- build');
  assert.ok(!runs.some(r => /build\.sh/.test(r)), '模版不再带 build.sh');
});

test('A 路线命令：--help 都退出 0、写到 stdout 且不写文件；未知参数都退出 2；--json 输出单个信封', () => {
  const cmds = ['tools/fonts/subset.mjs', 'tools/fonts/fetch.mjs', 'tools/lookdev/sweep.mjs', 'tools/plates/check.mjs', 'tools/plates/bleed.mjs'];
  for (const c of cmds) {
    const h = spawnSync(process.execPath, [path.join(ROOT, c), '--help'], { encoding: 'utf8' });
    assert.equal(h.status, 0, `${c} --help`);
    assert.match(h.stdout, /用法/, `${c} --help 输出到 stdout`);
    assert.match(h.stdout, /退出码/);
    const u = spawnSync(process.execPath, [path.join(ROOT, c), '--no-such-flag', '--json'], { encoding: 'utf8' });
    assert.equal(u.status, 2, `${c} --no-such-flag`);
    const env = JSON.parse(u.stdout);
    assert.equal(env.ok, false);
    assert.equal(env.error.code, 'usage.unknown-option');
  }
});
