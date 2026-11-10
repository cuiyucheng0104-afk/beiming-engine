// C 模版（routes/c-style/template）的测试：film.json 是唯一时间源、打点必须落整帧、事件表与打点同源、模版只依赖根环境。
// 不开浏览器：只在 node 里导入 timeline.js（它不碰 DOM）。要真出片的端到端检查设 C_STYLE_E2E=1（需要 Chrome headless shell、
// FFmpeg 和带 numpy / scipy / numba / soundfile 的 BEIMING_PY），会在 films/ 下建一个临时作品、出片核对后删掉。
// 运行：node --test "tests/c-style/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TPL = path.join(ROOT, 'routes/c-style/template');
const tplJson = () => JSON.parse(fs.readFileSync(path.join(TPL, 'film.json'), 'utf8'));

// 在临时目录里搭一个 <tmp>/films/x/ + <tmp>/engine（链接到仓库的 engine/），按 films/<名字>/ 的深度导入模版
function instantiate(edit = j => j) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'c-template-test-'));
  fs.symlinkSync(path.join(ROOT, 'engine'), path.join(d, 'engine'), process.platform === 'win32' ? 'junction' : 'dir');
  const film = path.join(d, 'films', 'x');
  fs.mkdirSync(film, { recursive: true });
  for (const f of fs.readdirSync(TPL)) {
    const src = path.join(TPL, f);
    if (!fs.statSync(src).isFile()) continue;
    fs.writeFileSync(path.join(film, f), fs.readFileSync(src, 'utf8').replaceAll('{{NAME}}', 'x').replaceAll('{{TITLE}}', '北冥'));
  }
  const j = edit(JSON.parse(fs.readFileSync(path.join(film, 'film.json'), 'utf8')));
  fs.writeFileSync(path.join(film, 'film.json'), JSON.stringify(j, null, 2));
  return { dir: d, film, load: () => import(pathToFileURL(path.join(film, 'timeline.js')).href), done: () => fs.rmSync(d, { recursive: true, force: true }) };
}
const stubScene = { chars: 2, pan: () => 0 };

test('模版 film.json：路线 c、片名占位、偶数画幅、帧率与片长成整数帧，带节拍与打点', () => {
  const j = tplJson();
  assert.equal(j.route, 'c');
  assert.equal(j.title, '{{TITLE}}');
  assert.ok([j.output.width, j.output.height].every(v => Number.isInteger(v) && v % 2 === 0));
  assert.ok(Number.isInteger(j.output.fps) && Number.isInteger(j.output.frameCount));
  assert.ok(Array.isArray(j.tempo) && j.tempo.length >= 1);
  for (const k of ['touch', 's1', 's2', 's3', 'title', 'seal']) assert.ok(j.cues[k], `缺打点 ${k}`);
});

test('timeline.js 从 film.json 推导：打点整帧、动作窗口在片内且结果落在打点上、事件表的打点与 T 一致', async () => {
  const t = instantiate();
  try {
    const m = await t.load();
    assert.equal(m.FPS, 24); assert.equal(m.DUR, 8); assert.equal(m.FRAMES, 192);
    for (const [k, f] of Object.entries(m.F)) { assert.ok(Number.isInteger(f), k); assert.equal(f, Math.round(m.T[k] * m.FPS)); }
    for (const [k, a] of Object.entries(m.ACT)) {
      assert.ok(Number.isInteger(a.f0) && Number.isInteger(a.f1) && a.f0 <= a.f1 && a.f1 <= m.FRAMES, k);
    }
    for (const k of ['s1', 's2', 's3', 'title', 'seal']) assert.equal(m.ACT[k].f1, m.F[k], `${k} 的结果帧应落在打点上`);
    const ev = m.buildEvents(stubScene);
    const cues = ev.filter(e => e.cue);
    assert.deepEqual(cues.map(e => e.cue).sort(), ['s1', 's2', 's3', 'seal', 'title', 'touch']);
    for (const e of cues) assert.equal(e.t, m.T[e.cue]);
    assert.equal(m.TIMELINE.fps, 24);
    assert.deepEqual(m.TIMELINE.t, m.T);
  } finally { t.done(); }
});

test('只改 film.json 的速度，打点、动作窗口、事件表一起变（单一时间源）', async () => {
  const a = instantiate(), b = instantiate(j => ({ ...j, tempo: [{ ...j.tempo[0], bpm: 120 }] }));
  try {
    const x = await a.load(), y = await b.load();
    assert.equal(x.T.title, +(8 * 60 / 90).toFixed(6));     // 第 3 小节第 1 拍 = 第 8 拍
    assert.equal(y.T.title, 4);                             // 120 BPM：8 × 0.5 秒
    assert.ok(y.ACT.title.f0 < x.ACT.title.f0);
    assert.equal(y.buildEvents(stubScene).find(e => e.cue === 'title').t, 4);
  } finally { a.done(); b.done(); }
});

test('打点不在整帧时直接报错，并按当前帧率列出每拍整帧的速度', async () => {
  const t = instantiate(j => ({ ...j, tempo: [{ ...j.tempo[0], bpm: 100 }] }));   // 24 fps 下一拍 14.4 帧
  try {
    await assert.rejects(t.load(), e => /不是整帧/.test(e.message) && /90 BPM 每拍 16 帧/.test(e.message) && /film\.json/.test(e.message));
  } finally { t.done(); }
});

test('缺本模版要用的打点时说清缺哪个', async () => {
  const t = instantiate(j => { const c = { ...j.cues }; delete c.seal; return { ...j, cues: c }; });
  try { await assert.rejects(t.load(), /cues 缺少 "seal"/); } finally { t.done(); }
});

test('film.json 第 2 版写法（output.fps、output.frameCount）也认', async () => {
  const t = instantiate(j => { const { fps, dur, ...rest } = j; return { ...rest, output: { fps: 30, frameCount: 240, width: 1080, height: 1920 } }; });
  try {
    const m = await t.load();
    assert.equal(m.FPS, 30); assert.equal(m.DUR, 8); assert.equal(m.FRAMES, 240);
    assert.equal(m.F.s1, 40);                               // 90 BPM、30 fps：一拍 20 帧，第 1 小节第 3 拍 = 第 40 帧
  } finally { t.done(); }
});

test('模版只依赖仓库根的环境，渲染路径不读墙钟、不用无种子随机', () => {
  for (const f of fs.readdirSync(TPL).filter(x => /\.(js|py|html)$/.test(x))) {
    const src = fs.readFileSync(path.join(TPL, f), 'utf8').replace(/^\s*(\/\/|#).*$/gm, '');
    assert.doesNotMatch(src, /\$\{?LIB\b|\.venv\/bin\/python/, `${f} 引用了 $LIB 或 .venv`);
    assert.doesNotMatch(src, /['"`(]\/core\//, `${f} 用了 /core/ 绝对路径`);
    assert.doesNotMatch(src, /Math\.random\s*\(|Date\.now\s*\(|performance\.now\s*\(/, `${f} 用了无种子随机或墙钟`);
  }
  assert.match(fs.readFileSync(path.join(TPL, 'main.js'), 'utf8'), /window\.FPS\s*=/);
});

test('模版 film.json 是 v2：backend canvas、web-1080p24、aigc、credits 带字体 OFL 与方法 MIT 署名、三道闸、不写 poster', () => {
  const j = tplJson();
  assert.equal(j.schemaVersion, 2);
  assert.equal(j.id, '{{NAME}}');
  assert.equal(j.backend, 'canvas');
  assert.deepEqual(j.output, { profile: 'web-1080p24', width: 1920, height: 1080, fps: 24, frameCount: 192 });
  assert.equal(Math.round(j.dur * j.fps), j.output.frameCount);
  assert.deepEqual(j.size, [j.output.width, j.output.height]);
  assert.equal(typeof j.aigc.contains, 'boolean');
  assert.ok(j.credits.some(c => c.license === 'OFL-1.1' && /fonts\.json$/.test(c.source)));
  assert.ok(j.credits.some(c => c.license === 'MIT' && /lemo-opuscar\/styles\/ink-wash\/STYLE\.md@bebbbe1/.test(c.source)));
  assert.deepEqual(j.gates, { look: 'required', animatic: 'required', final: 'required' });
  assert.ok(!('poster' in j) && Number.isInteger(j.posterFrame) && j.posterFrame < j.output.frameCount);
});

test('片名字体：film.js 的 FONTS 指向 C 路线的分片清单，分片覆盖 GB 2312 全部 6763 个简体汉字', async () => {
  const src = fs.readFileSync(path.join(TPL, 'film.js'), 'utf8');
  const m = /manifest:\s*'\.\.\/\.\.\/(routes\/c-style\/fonts\/fonts\.json)'/.exec(src);
  assert.ok(m, 'FONTS 要登记 ../../routes/c-style/fonts/fonts.json');
  const { verifyFonts, unpackCodepoints } = await import(pathToFileURL(path.join(ROOT, 'routes/c-style/fonts/fetch.mjs')).href);
  assert.deepEqual(verifyFonts(ROOT), []);
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, m[1]), 'utf8'));
  const have = new Set(man.chunks.flatMap(c => unpackCodepoints(c.codepoints)));
  const gb = new TextDecoder('gb2312');
  let n = 0, lack = [];
  for (let hi = 0xB0; hi <= 0xF7; hi++) for (let lo = 0xA1; lo <= 0xFE; lo++) {
    const ch = gb.decode(new Uint8Array([hi, lo]));
    if (ch.length !== 1 || ch === '�' || !/\p{Script=Han}/u.test(ch)) continue;
    n++; if (!have.has(ch.codePointAt(0))) lack.push(ch);
  }
  assert.ok(n >= 6763, `GB 2312 汉字应有 6763 个，解出 ${n}`);
  assert.deepEqual(lack, [], `缺 ${lack.length} 个：${lack.slice(0, 20).join('')}`);
  for (const ch of '墨线试映夜跑滨江鲲鹏北冥晨渡归航') assert.ok(have.has(ch.codePointAt(0)), ch);
});

// 端到端：真出片 + 机器 QA。QA-T-C-001 的回归——片名「墨线」不在旧子集里（texts.glyphs 不过），竖屏题名越出 9:16 安全区
const E2E = process.env.C_STYLE_E2E === '1' ? false : '设 C_STYLE_E2E=1 才跑（要浏览器、FFmpeg 与带音频依赖的 BEIMING_PY）';
test('端到端：new-film c「墨线」→ build.mjs 出片 → QA report 机器检查通过（含缺字、静帧、声画）', { skip: E2E }, () => {
  const name = `c-e2e-${process.pid}`, dir = path.join(ROOT, 'films', name);
  try {
    const n = spawnSync(process.execPath, ['tools/new-film.mjs', 'c', name, '--title', '墨线'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(n.status, 0, n.stderr);
    const b = spawnSync(process.execPath, ['engine/render/build.mjs', `films/${name}`], { cwd: ROOT, encoding: 'utf8', timeout: 600000 });
    assert.equal(b.status, 0, b.stderr + b.stdout);
    assert.match(b.stdout, /CUECHECK OK/);
    assert.match(b.stdout, /画面 1920×1080 {2}192 帧（应为 192） {2}音轨 48000 Hz × 2/);
    assert.doesNotMatch(b.stderr + b.stdout, /字体缺字|页面错误/);
    const q = spawnSync(process.execPath, ['tools/qa/cli.mjs', 'report', `films/${name}/out/${name}.mp4`, '--film', `films/${name}`, '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 600000 });
    const env = JSON.parse(q.stdout);
    const bad = (env.result?.checks || env.data?.checks || []).filter(c => c.status === 'fail').map(c => `${c.id}：${c.value}`);
    assert.equal(q.status, 0, bad.join('\n') || q.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('端到端：竖屏（vertical-1080x1920-30）新建后，QA 的文字检查全部通过（安全区、停留时长、缺字）', { skip: E2E }, () => {
  const name = `c-e2e-v-${process.pid}`, dir = path.join(ROOT, 'films', name);
  try {
    const n = spawnSync(process.execPath, ['tools/new-film.mjs', 'c', name, '--title', '北冥有鱼其名为鲲', '--profile', 'vertical-1080x1920-30'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(n.status, 0, n.stderr);
    const q = spawnSync(process.execPath, ['tools/qa/cli.mjs', 'texts', '--film', `films/${name}`, '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 600000 });
    const env = JSON.parse(q.stdout);
    const bad = (env.result?.checks || env.data?.checks || []).filter(c => c.status === 'fail').map(c => `${c.id}：${c.value}`);
    assert.equal(q.status, 0, bad.join('\n') || q.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
