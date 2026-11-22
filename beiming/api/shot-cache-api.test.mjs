// A16 Part 2：内容寻址镜头缓存与容差接缝检查接入 beiming/api 出片链路端到端测试。
// 前半用记数的假帧源直接跑 renderPlan（要 FFmpeg，不要 Blender 和浏览器）：帧源被调了几次是精确的数。
// 后半起真 HTTP 服务，用真 Blender 和无头浏览器把双镜头片交付两次（缺工具时跳过）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { verifyDeliveryBundle } from '../comp/index.mjs';
import { openShotCache } from '../jobs/index.mjs';
import { findBlender } from '../sources/blender/host.mjs';
import { issueAccountToken, startServer } from './index.mjs';
import * as pipeline from './pipeline.mjs';
import { analyticAgxCube, hasFfmpeg } from './runtime.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const HEX = (c) => c.repeat(64);
const noFfmpeg = !hasFfmpeg() && '缺少可执行的 FFmpeg';
let root, lutPath;
const tempVariable = process.platform === 'win32' ? 'TEMP' : 'TMPDIR';
const previousTemp = process.env[tempVariable];

before(() => {
  root = mkdtempSync(join(tmpdir(), 'beiming-shot-cache-'));
  process.env[tempVariable] = root;
  lutPath = join(root, 'agx.cube');
  writeFileSync(lutPath, analyticAgxCube());
});
after(() => {
  if (previousTemp === undefined) delete process.env[tempVariable];
  else process.env[tempVariable] = previousTemp;
  rmSync(root, { recursive: true, force: true });
});

/* ---------------- 假帧源与夹具 ---------------- */

const SIZE = [16, 8];
/** 双镜头片：s01 是容差档的 blender 镜头，s02 是同机逐位可复现的 three 镜头；split 是切点 */
function filmOf(split = 12, frames = 24) {
  return {
    format: 'film/3.0', id: 'f_cache', output: { size: SIZE, fps: '24/1', frames },
    shots: [
      { id: 's01', in: 0, out: split, source: 'blender', host: 'cycles', mode: 'cards-data', colorRef: 'scene', seed: 1001, assets: { kit: 'asset:kit@1' },
        cards: [{ as: 'cycles', use: 'blender.cycles@1', params: {} }], tiers: { draft: { samples: 16 }, final: { samples: 32 } } },
      { id: 's02', in: split, out: frames, source: 'three', host: 'page', mode: 'cards-data', colorRef: 'display', seed: 1002,
        cards: [{ as: 'title', use: 'overlay.title@1', params: { text: 'RTX', enter: 0 } }] },
    ],
    transitions: [{ id: 'cut-a', at: split, type: 'cut' }],
    events: [{ id: 'title', frame: `cut(${split})`, shot: 's02', audio: 'hit.low', sync: 'onset' }],
    style: { view: { scene: 'agx-mhc', display: 'srgb' }, tokens: { ink: '#111318', paper: '#EAE6DF' } },
  };
}
const lockOf = () => ({
  format: 'lock/1.0', assets: { 'asset:kit@1': `sha256:${HEX('a')}` },
  cards: {
    'blender.cycles': { impl: ['source:blender'], sha256: HEX('b'), version: '1.0.0' },
    'overlay.title': { impl: ['source:three'], sha256: HEX('c'), version: '1.0.0' },
    'time.events': { impl: ['data'], sha256: HEX('d'), version: '1.0.0' },
    'comp.display': { impl: ['comp'], sha256: HEX('e'), version: '1.0.0' },
  },
  seeds: { s01: 1001, s02: 1002 }, shots: { s01: { shutterSamples: 1 }, s02: { shutterSamples: 1 } },
  sources: { blender: { host: 'cycles', image: `sha256:${HEX('1')}`, version: '5.2.0' }, three: { host: 'page', image: `sha256:${HEX('2')}`, version: '0.187.0' } },
});

/**
 * 记数的假帧源池。calls[镜头] = { open, render }；bias 加在每个像素上（模拟容差档两轮之间的亮度漂移），gpu 是它报的显卡。
 * 颜色只由镜头条目、风格 tokens 和局部帧号决定。
 */
function fakePool(knobs = {}) {
  const pool = { calls: {}, bias: 0, gpu: 'fake-gpu', ...knobs };
  pool.get = async (source) => ({
    async open(input, env) {
      const { shot } = input, [w, h] = input.output.size;
      const count = (pool.calls[shot.id] ??= { open: 0, render: 0 });
      count.open++;
      const base = (parseInt(sha256(JSON.stringify([shot.cards, input.tokens])).slice(0, 4), 16) / 65535) * 0.4;
      let n = 0;
      return {
        async render(f) {
          count.render++;
          const color = new Float32Array(w * h * 4).map((_, i) => (i % 4 === 3 ? 1 : base + 0.002 * f + pool.bias));
          const colorBytes = Buffer.from(color.buffer), idBytes = Buffer.from(new Uint32Array(w * h).fill(1).buffer);
          const sub = `r${String(n++).padStart(3, '0')}-f${String(f).padStart(4, '0')}`;
          mkdirSync(join(env.workspace, sub), { recursive: true });
          writeFileSync(join(env.workspace, sub, 'color.f32'), colorBytes);
          writeFileSync(join(env.workspace, sub, 'objectId.u32'), idBytes);
          const frame = shot.in + f;
          const meta = {
            format: 'meta/0.1', film: input.film, shot: shot.id, frame, shotFrame: f, size: [w, h], entities: [],
            events: (input.events?.events ?? []).filter((e) => e.frame === frame).map((e) => ({ id: e.id, frame: e.frame })),
            source: { id: source, renderer: source, tier: env.tier, backend: 'fake', gpu: pool.gpu },
            timing: { stateMs: 1, renderMs: 2, readbackMs: 1 }, hash: { color: `sha256:${sha256(colorBytes)}` },
          };
          return { meta, layers: { color: { file: `${sub}/color.f32`, shape: [h, w, 4] }, objectId: { file: `${sub}/objectId.u32` } } };
        },
        async close() {},
      };
    },
  });
  return pool;
}

let seq = 0;
/** 一个独立的场地：缓存目录、片子目录，和「照这部片渲一轮」的入口 run(film, { lock, tier, pool, plan, cache }) */
function arena() {
  const dir = join(root, `arena-${++seq}`), filmDir = join(dir, 'film');
  mkdirSync(filmDir, { recursive: true });
  const cache = openShotCache(join(dir, 'deliver', '.shot-cache'));
  let n = 0;
  async function run(film, { lock = lockOf(), tier = 'final', pool = fakePool(), plan, ...rest } = {}) {
    const wanted = plan ?? film.shots.map((shot) => ({ shot, frames: Array.from({ length: shot.out - shot.in }, (_, i) => shot.in + i) }));
    const res = await pipeline.renderPlan({ film, lock, filmDir, tier, plan: wanted, outDir: join(dir, `job-${++n}`), pool, lutPath, cache, ...rest });
    return { ...res, pool, of: (id) => res.shots.find((s) => s.shot === id) };
  }
  return { dir, filmDir, cache, run };
}
const patched = (film, fn) => { const next = structuredClone(film); fn(next); return next; };
const frameFiles = (cache, shot, tier = 'final') => readdirSync(join(cache.root, tier, `shot-${shot}`), { recursive: true })
  .filter((p) => String(p).endsWith('.frame')).map((p) => join(cache.root, tier, `shot-${shot}`, String(p))).sort();

/* ---------------- 假帧源：帧源调用次数是精确的 ---------------- */

test('buildShotCacheInputs 交出六项：别的镜头的条目、事件、卡不进本镜头的键', () => {
  const film = filmOf(), lock = lockOf();
  const [a, b] = film.shots.map((shot) => pipeline.buildShotCacheInputs({ film, lock, shot, filmDir: root, tier: 'final' }));
  assert.deepEqual(a.events, [], 's02 的片名事件不进 s01');
  assert.deepEqual(b.events.map((e) => [e.kind, e.frame, e.id]), [['cut', 12, 'cut.12'], ['named', 12, 'title']], '落在 s02 里的事件');
  assert.deepEqual([a.film.at, b.film.at], [0, 12], '镜头的起始帧进键');
  assert.deepEqual(a.cards.map((c) => c.id).sort(), ['blender.cycles', 'time.events'], '本镜头的卡加数据层的卡，没有 s02 的卡和合成的卡');
  assert.deepEqual(b.cards.map((c) => c.id).sort(), ['overlay.title', 'time.events']);
  assert.deepEqual(a.loadedFiles, [{ path: 'asset:kit@1', sha256: HEX('a') }]);
  assert.deepEqual([a.determinism, a.samples, b.determinism, b.samples], ['tolerance', 32, 'hash-same-machine', 1]);
  assert.deepEqual([a.tracksHash, a.size, a.subs, a.tier], ['none', SIZE, [0], 'final']);
  assert.equal(Object.keys(a.runtimeEnv).length, 5);
  assert.match(a.runtimeEnv.gpuBackend, /unprobed$/);
  assert.match(pipeline.buildShotCacheInputs({ film, lock, shot: film.shots[0], filmDir: root, tier: 'final', device: { backend: 'METAL', gpu: 'm5' } }).runtimeEnv.driver, /m5$/);
});

test('只改 s02：s01 不起帧源会话、渲帧数为 0，命中的层逐字节相同', { skip: noFfmpeg }, async () => {
  const { run, dir } = arena();
  const film = filmOf();
  const first = await run(film);
  assert.deepEqual([first.renderedFrames, first.cachedFrames], [24, 0]);
  assert.deepEqual(first.pool.calls, { s01: { open: 1, render: 12 }, s02: { open: 1, render: 12 } });

  let gpuFrames = 0;
  const second = await run(patched(film, (f) => { f.shots[1].cards[0].params.text = 'NEW'; }), { onFrame() { gpuFrames++; } });
  assert.deepEqual(second.pool.calls, { s02: { open: 1, render: 12 } }, 's01 全部命中：帧源的 open 和 render 一次都没调');
  assert.deepEqual([second.renderedFrames, second.cachedFrames, gpuFrames], [12, 12, 12]);
  assert.deepEqual(second.shots, [{ shot: 's01', renderedFrames: 0, cachedFrames: 12 }, { shot: 's02', renderedFrames: 12, cachedFrames: 0 }]);
  assert.equal(second.records.length, 24);
  for (const [i, rec] of second.records.entries()) {
    const old = first.records[i];
    assert.ok(existsSync(rec.exr) && existsSync(rec.png), `帧 ${rec.frame} 的 EXR 与预览都在`);
    if (rec.shot !== 's01') continue;
    assert.equal(rec.cached, true);
    assert.deepEqual(readFileSync(rec.color), readFileSync(old.color));
    assert.deepEqual(readFileSync(rec.objectId), readFileSync(old.objectId));
    assert.deepEqual(readFileSync(rec.exr), readFileSync(old.exr));
    assert.equal(rec.meta.hash.color, `sha256:${sha256(readFileSync(rec.color))}`);
    assert.deepEqual(rec.meta.timing, { stateMs: 0, renderMs: 0, readbackMs: 0 });
    assert.deepEqual({ ...rec.meta, timing: old.meta.timing }, old.meta);
    assert.deepEqual(JSON.parse(readFileSync(rec.metaPath, 'utf8')), rec.meta);
  }
  assert.ok(!existsSync(join(dir, 'job-2', 's01', 'layers', 'r000-f0000')), '帧源没有给 s01 写过层');

  assert.deepEqual((await run(film)).pool.calls, {}, '改回去：改之前那一版 s02 还在缓存里（交付后的清理才只留最近用过的一版）');
});

test('不传 cache 时每帧都渲，和接缓存之前一样', { skip: noFfmpeg }, async () => {
  const { run } = arena();
  const film = filmOf();
  for (let round = 0; round < 2; round++) {
    const res = await run(film, { cache: undefined });
    assert.deepEqual([res.renderedFrames, res.cachedFrames, res.pool.calls.s01.render, res.pool.calls.s02.render], [24, 0, 12, 12]);
    assert.ok(res.records.every((r) => !r.cached));
  }
});

test('六项键逐项单点变化：该重渲的镜头整镜重渲，无关的镜头照常命中', { skip: noFfmpeg }, async (t) => {
  const film = filmOf();
  // [名字, 改片子, 改锁, 档位, 重渲的镜头]
  const cases = [
    ['① 本镜头参数', (f) => { f.shots[1].cards[0].params.enter = 2; }, null, 'final', ['s02']],
    ['① 本镜头事件', (f) => { f.events[0].frame = 'cut(12) + 2'; }, null, 'final', ['s02']],
    ['① 风格 tokens.paper', (f) => { f.style.tokens.paper = '#FFFFFF'; }, null, 'final', ['s01', 's02']],
    ['① 帧率', (f) => { f.output.fps = '30/1'; }, null, 'final', ['s01', 's02']],
    ['① 锁里的镜头种子', null, (l) => { l.seeds.s02 = 7; }, 'final', ['s02']],
    ['② 资产摘要', null, (l) => { l.assets['asset:kit@1'] = `sha256:${HEX('f')}`; }, 'final', ['s01']],
    ['③ tracks', (f) => { f.shots[0].tracks = { cam: { keys: [{ f: 0, v: 1 }] } }; }, null, 'final', ['s01']],
    ['④ 锁里卡的实现哈希', null, (l) => { l.cards['overlay.title'].sha256 = HEX('9'); }, 'final', ['s02']],
    ['④ 锁里卡的版本', null, (l) => { l.cards['blender.cycles'].version = '1.0.1'; }, 'final', ['s01']],
    ['④ 数据层的卡', null, (l) => { l.cards['time.events'].sha256 = HEX('8'); }, 'final', ['s01', 's02']],
    ['⑤ 运行时版本', null, (l) => { l.sources.three.version = '0.188.0'; }, 'final', ['s02']],
    ['⑤ 运行时镜像', null, (l) => { l.sources.blender.image = `sha256:${HEX('3')}`; }, 'final', ['s01']],
    ['⑥ 档位', null, null, 'draft', ['s01', 's02']],
    ['⑥ 采样数', (f) => { f.shots[0].tiers.final.samples = 64; }, null, 'final', ['s01']],
    ['⑥ 画幅', (f) => { f.output.size = [8, 8]; }, null, 'final', ['s01', 's02']],
    ['⑥ 快门子帧 subs', (f) => { f.shots[1].shutter = { angleDeg: 180 }; }, (l) => { l.shots.s02.shutterSamples = 4; }, 'final', ['s02']],
    ['不进键：合成的卡、别的镜头的种子', null, (l) => { l.cards['comp.display'].sha256 = HEX('7'); l.rev = 9; }, 'final', []],
  ];
  for (const [name, editFilm, editLock, tier, rerendered] of cases) {
    await t.test(name, async () => {
      const { run } = arena();
      await run(film);
      const lock = lockOf();
      editLock?.(lock);
      const res = await run(editFilm ? patched(film, editFilm) : film, { lock, tier });
      for (const id of ['s01', 's02']) {
        const want = rerendered.includes(id) ? { open: 1, render: 12 } : undefined;
        assert.deepEqual(res.pool.calls[id], want, `${id} ${want ? '应整镜重渲' : '应全部命中、不起会话'}`);
      }
      assert.deepEqual([res.renderedFrames, res.cachedFrames], [rerendered.length * 12, 24 - rerendered.length * 12]);
    });
  }
});

// 镜头代码和卡拿得到 ctx.shot.in（镜头契约 S10），time 类型的卡参数写整数是全片帧号（这里的 enter: 0）：
// 镜头整体后移之后同一个局部帧号的画面可以不一样，旧位置的帧不能当命中交出去。
test('前序镜头改长、本镜头整体后移：起始帧在键里，后移的镜头重渲；只改长后一个镜头时前一个镜头照常命中', { skip: noFfmpeg }, async () => {
  const { run } = arena();
  await run(filmOf(12, 24));
  const shifted = await run(filmOf(14, 26));
  assert.deepEqual(shifted.pool.calls, { s01: { open: 1, render: 14 }, s02: { open: 1, render: 12 } });
  assert.deepEqual(shifted.records.filter((r) => r.shot === 's02').map((r) => [r.meta.frame, r.meta.shotFrame]), Array.from({ length: 12 }, (_, i) => [14 + i, i]));
  assert.deepEqual((await run(filmOf(12, 24))).pool.calls, {}, '挪回原位：原位置那一版还在');

  const longer = await run(filmOf(12, 30));
  assert.deepEqual(longer.pool.calls, { s02: { open: 1, render: 18 } }, 's02 变长要重渲，s01 的位置和内容都没变');
  assert.deepEqual(longer.of('s01'), { shot: 's01', renderedFrames: 0, cachedFrames: 12 });
});

test('② 入口文件：改别的镜头的入口不影响本镜头，改自己的入口或共用源码才重渲', { skip: noFfmpeg }, async () => {
  const { run, filmDir } = arena();
  mkdirSync(join(filmDir, 'shots'));
  const write = (name, text) => writeFileSync(join(filmDir, 'shots', name), text);
  write('s01.py', 'a = 1\n');
  write('other.py', 'b = 1\n');
  const film = patched(filmOf(), (f) => {
    f.shots[0].mode = 'build-script'; f.shots[0].entry = 'shots/s01.py';
    f.shots.push({ ...structuredClone(f.shots[0]), id: 's03', in: 24, out: 36, entry: 'shots/other.py' });
    f.output.frames = 36;
  });
  await run(film);
  write('other.py', 'b = 2\n');
  assert.deepEqual((await run(film)).pool.calls, { s03: { open: 1, render: 12 } }, '只改 s03 的入口：s01、s02 命中');
  write('s01.py', 'a = 2\n');
  assert.deepEqual((await run(film)).pool.calls, { s01: { open: 1, render: 12 } });
  write('common.py', 'c = 1\n');
  assert.deepEqual((await run(film)).pool.calls, { s01: { open: 1, render: 12 }, s03: { open: 1, render: 12 } }, '共用源码两个带入口的镜头都可能引用');
});

test('缓存文件头、颜色层、编号层损坏：只丢坏帧重渲，交出的层与重新渲的逐字节相同', { skip: noFfmpeg }, async () => {
  const { run, cache } = arena();
  const film = filmOf();
  const first = await run(film);
  const files = frameFiles(cache, 's02');
  assert.equal(files.length, 12);
  const corrupt = (file, at) => { const raw = readFileSync(file); raw[at(raw)] ^= 0xff; writeFileSync(file, raw); };
  corrupt(files[0], () => 5); // 文件头
  corrupt(files[1], (raw) => raw.indexOf(0x0a) + 9); // 颜色层
  corrupt(files[2], (raw) => raw.length - 3); // 编号层（接在文件尾部）
  const second = await run(film);
  assert.deepEqual(second.pool.calls, { s02: { open: 1, render: 3 } }, '三个坏帧各重渲一次，其余命中');
  assert.deepEqual(second.of('s02'), { shot: 's02', renderedFrames: 3, cachedFrames: 9 });
  for (const [i, rec] of second.records.entries()) {
    assert.deepEqual(readFileSync(rec.color), readFileSync(first.records[i].color));
    assert.deepEqual(readFileSync(rec.objectId), readFileSync(first.records[i].objectId));
  }
  assert.deepEqual((await run(film)).pool.calls, {}, '重渲的帧写回了缓存');
});

test('没带编号层的旧条目不当命中', { skip: noFfmpeg }, async () => {
  const { run, cache } = arena();
  const film = filmOf(), shot = film.shots[1];
  await run(film, { plan: [{ shot, frames: [12] }] });
  const [file] = frameFiles(cache, 's02');
  const raw = readFileSync(file), header = JSON.parse(raw.subarray(0, raw.indexOf(0x0a)).toString('utf8'));
  const { determinism, tier, samples, size, subs, ...five } = pipeline.buildShotCacheInputs({ film, lock: lockOf(), shot, filmDir: root, tier: 'final', device: { backend: 'fake', gpu: 'fake-gpu' } });
  const { computeFrameCacheKey } = await import('../jobs/cache.mjs');
  const entry = computeFrameCacheKey({ ...five, renderSpec: { tier, samples, size, frame: 0, subs } });
  assert.equal(entry.key, header.key, '测试算的键就是出片链路写下的键');
  cache.put(entry, { colorBytes: cache.get(entry).colorBytes, meta: header.meta, runId: header.runId });
  assert.deepEqual((await run(film, { plan: [{ shot, frames: [12] }] })).pool.calls, { s02: { open: 1, render: 1 } });
});

test('容差档混用旧帧与新帧出现亮度尖峰：整镜失效，旧帧在同一轮重渲', { skip: noFfmpeg }, async () => {
  const { run, cache } = arena();
  const film = filmOf();
  await run(film);
  const drop = (shot) => frameFiles(cache, shot).slice(0, 5).forEach((file) => rmSync(file));
  drop('s01');
  drop('s02');
  // 这一轮帧源整体亮了 0.5：补渲的 5 帧和留下的 7 帧旧帧之间是台阶
  const second = await run(film, { pool: fakePool({ bias: 0.5 }) });
  assert.deepEqual(second.pool.calls.s01, { open: 1, render: 12 }, '容差档的 s01：检出尖峰后 7 帧旧帧也在同一个会话里重渲');
  assert.deepEqual(second.of('s01'), { shot: 's01', renderedFrames: 12, cachedFrames: 0, seam: 'rerendered' });
  assert.deepEqual(second.pool.calls.s02, { open: 1, render: 5 }, '同机逐位可复现的 s02 不查接缝，只补缺的帧');
  const luma = (rec) => readFileSync(rec.color).readFloatLE(0);
  const s01 = second.records.filter((r) => r.shot === 's01').map(luma);
  for (let i = 1; i < s01.length; i++) assert.ok(Math.abs(s01[i] - s01[i - 1] - 0.002) < 1e-4, `s01 第 ${i} 帧与前一帧之间没有台阶`);
  assert.ok(second.records.filter((r) => r.shot === 's01').every((r) => !r.cached));

  const third = await run(film, { pool: fakePool({ bias: 0.5 }) });
  assert.deepEqual(third.pool.calls, {}, '失效后重渲的整镜进了缓存，旧一轮的帧没有留下');
  assert.deepEqual(third.records.filter((r) => r.shot === 's01').map(luma), s01);
  assert.equal(third.of('s01').seam, undefined);
});

test('容差档补渲的帧与旧帧接得上时不重渲；抽样帧不查接缝', { skip: noFfmpeg }, async () => {
  const { run, cache } = arena();
  const film = filmOf(), shot = film.shots[0];
  await run(film);
  frameFiles(cache, 's01').slice(0, 4).forEach((file) => rmSync(file));
  const smooth = await run(film);
  assert.deepEqual(smooth.pool.calls, { s01: { open: 1, render: 4 } });
  assert.deepEqual(smooth.of('s01'), { shot: 's01', renderedFrames: 4, cachedFrames: 8, seam: 'ok' });

  const samples = { plan: [{ shot, frames: [0, 5, 11] }], tier: 'draft' };
  await run(film, samples);
  rmSync(frameFiles(cache, 's01', 'draft')[0]);
  const sampled = await run(film, { ...samples, pool: fakePool({ bias: 0.5 }) });
  assert.deepEqual(sampled.of('s01'), { shot: 's01', renderedFrames: 1, cachedFrames: 2 });
});

test('⑤ 显卡后端与显卡：帧源真渲的帧报的环境和记录不一样时，旧环境的命中作废、整镜照新环境重渲', { skip: noFfmpeg }, async () => {
  const { run, cache } = arena();
  const film = filmOf(), shot = film.shots[1], plan = [{ shot, frames: [12, 13, 14, 15] }];
  const first = await run(film, { plan });
  assert.deepEqual(first.pool.calls.s02, { open: 1, render: 4 }, '头一次没有环境记录：第一帧渲完才知道，不多渲');
  assert.deepEqual(JSON.parse(readFileSync(join(cache.root, 'devices.json'), 'utf8')), { three: { backend: 'fake', gpu: 'fake-gpu' } });
  assert.deepEqual((await run(film, { plan })).pool.calls, {}, '照记录算键：全部命中，不用起帧源问环境');

  rmSync(frameFiles(cache, 's02')[0]);
  const swapped = await run(film, { plan, pool: fakePool({ gpu: 'other-gpu' }) });
  assert.deepEqual(swapped.pool.calls.s02, { open: 1, render: 4 }, '换了显卡：补渲的那一帧报了新显卡，另外 3 帧旧显卡的命中不能混用');
  assert.ok(swapped.records.every((r) => r.meta.source.gpu === 'other-gpu' && !r.cached));
  assert.deepEqual((await run(film, { plan, pool: fakePool({ gpu: 'other-gpu' }) })).pool.calls, {});
});

test('镜头条目算不出键时不走缓存，帧源照常出帧', { skip: noFfmpeg }, async () => {
  const { run } = arena();
  const film = patched(filmOf(), (f) => { f.shots[1].cards[0].use = 'not-a-card-ref'; });
  for (let round = 0; round < 2; round++) {
    const res = await run(film);
    assert.deepEqual(res.pool.calls.s02, { open: 1, render: 12 });
  }
});

/* ---------------- 真 HTTP 服务：双镜头片交付两次 ---------------- */

function mediaSkip() {
  if (noFfmpeg) return noFfmpeg;
  const blender = findBlender();
  if (!blender || spawnSync(blender, ['--version'], { stdio: 'ignore', timeout: 20000 }).status !== 0) return '缺少可执行的 Blender';
  const probe = "import {chromium} from 'playwright-core'; const b=await chromium.launch({headless:true,executablePath:process.env.BEIMING_CHROME || undefined,args:['--mute-audio']}); await b.close()";
  if (spawnSync(process.execPath, ['--input-type=module', '-e', probe], { stdio: 'ignore', timeout: 30000 }).status !== 0) return '无头浏览器不可执行';
  return false;
}

test('HTTP：双镜头片第二次交付只改 s02，s01 渲帧数为 0，账本只计真渲帧，六件套完整', { skip: mediaSkip(), timeout: 600000 }, async (t) => {
  const dataDir = join(root, 'server');
  const account = issueAccountToken(dataDir);
  const api = await startServer({ dataDir, port: 0, reviewer: null });
  t.after(() => api.close());
  const call = async (method, path, token, body) => (await fetch(api.url + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })).json();
  const made = (await call('POST', '/v1/films', account, { template: 'turntable', output: { size: [320, 180], fps: '24/1', frames: 24 } })).data;
  const base = `/v1/films/${made.film}`, filmDir = join(dataDir, 'films', made.film);
  async function job(kind, body = {}) {
    let env = await call('POST', `${base}/${kind}`, made.token, { ...body, wait: 30 });
    while (['queued', 'running'].includes(env.data.status)) env = await call('GET', `/v1/jobs/${env.data.job}?wait=30`, made.token);
    assert.equal(env.data.status, 'succeeded', JSON.stringify(env));
    const full = env.outputs?.find((o) => o.kind === 'response');
    return full ? call('GET', full.url, made.token) : env;
  }
  const ledgerOf = (jobId) => readFileSync(join(dataDir, 'meta', `${made.film}.ledger.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.job === jobId && r.step.startsWith('job.'));
  const layersOf = (jobId, shot) => readdirSync(join(filmDir, 'deliver', jobId, 'frames', shot, 'layers'));
  const colorOf = (jobId, shot, name) => readFileSync(join(filmDir, 'deliver', jobId, 'frames', shot, 'layers', name, 'color.f32'));

  const first = await job('deliver');
  assert.deepEqual([first.data.deliveredFrames, first.data.renderedFrames, first.data.cachedFrames], [24, 24, 0]);
  const row1 = ledgerOf(first.data.job);
  assert.deepEqual([row1.frames, row1.renderedFrames, row1.cachedFrames], [24, 24, 0]);

  const rev = (await call('GET', `${base}/film`, made.token)).data.rev;
  const put = await call('PUT', `${base}/film`, made.token, { format: 'patch/0.1', rev, ops: [{ op: 'set', path: 'shots/s02/cards/title/params/text', value: 'NEW' }] });
  assert.equal(put.ok, true, JSON.stringify(put));
  const second = await job('deliver');
  assert.deepEqual([second.data.deliveredFrames, second.data.renderedFrames, second.data.cachedFrames], [24, 12, 12]);
  assert.deepEqual(second.data.shots, [{ shot: 's01', renderedFrames: 0, cachedFrames: 12 }, { shot: 's02', renderedFrames: 12, cachedFrames: 0 }]);
  const row2 = ledgerOf(second.data.job);
  assert.deepEqual([row2.frames, row2.renderedFrames, row2.cachedFrames], [12, 12, 12], '账本的渲帧数减半');
  // 终渲那一步没有为 s01 调帧源：它的层目录里只有缓存还原出来的，逐字节等于第一次交付时帧源写的
  const restored = layersOf(second.data.job, 's01');
  assert.deepEqual(restored, Array.from({ length: 12 }, (_, i) => `cache-f${String(i).padStart(4, '0')}`));
  for (const [i, name] of layersOf(first.data.job, 's01').sort().entries()) assert.deepEqual(colorOf(second.data.job, 's01', restored[i]), colorOf(first.data.job, 's01', name));
  assert.ok(layersOf(second.data.job, 's02').every((name) => /^r\d{3}-f\d{4}$/.test(name)));
  const s01meta = JSON.parse(readFileSync(join(filmDir, 'deliver', second.data.job, 'frames/s01/f0003.meta.json'), 'utf8'));
  assert.deepEqual(s01meta.timing, { stateMs: 0, renderMs: 0, readbackMs: 0 });
  assert.equal(s01meta.source.renderer, 'blender');

  const bundle = verifyDeliveryBundle(join(filmDir, 'deliver', second.data.job, 'bundle'));
  assert.deepEqual(Object.keys(bundle.files).sort(), ['contact.png', 'film.lock', 'master.mp4', 'report.json', 'run.json', 'web.mp4']);
  assert.deepEqual([second.data.layers.L2.ok, second.data.layers.L3.ok, second.data.layers.L2.bbox.frames], [true, true, 24], '两个镜头的帧都进了核验和成片');
  const spec = await call('POST', `${base}/observe/metrics`, made.token, { metrics: ['deliverSpec'] });
  assert.equal(spec.data.items[0].value.frames, 24);

  // 什么都没改再终渲：两个镜头都不起帧源，显卡秒是 0
  const third = await job('render', { tier: 'final' });
  assert.deepEqual([third.data.actualCount, third.data.renderedFrames, third.data.cachedFrames], [24, 0, 24]);
  const row3 = ledgerOf(third.data.job);
  assert.deepEqual([row3.frames, row3.renderedFrames, row3.cachedFrames, row3.gpuSeconds], [0, 0, 24, 0]);

  // 缓存在 deliver/ 下，不进修订快照；终稿每个镜头只留最近用过的一版
  for (const snap of readdirSync(join(filmDir, 'snapshots'))) {
    assert.ok(!readdirSync(join(filmDir, 'snapshots', snap), { recursive: true }).some((p) => String(p).includes('.shot-cache')));
  }
  const cacheRoot = join(filmDir, 'deliver', '.shot-cache');
  assert.equal(readdirSync(join(cacheRoot, 'final', 'shot-s02')).length, 1, '改之前那一版 s02 在第二次交付后清掉了');
  t.diagnostic(`交付 1 渲 ${row1.frames} 帧 ${row1.gpuSeconds} 显卡秒；交付 2 渲 ${row2.frames} 帧 ${row2.gpuSeconds} 显卡秒（含 L2 纯函数门的探针）；重渲 ${row3.frames} 帧`);
});
