// A16 Part 2：内容寻址镜头缓存与容差接缝检查接入 beiming/api 出片链路端到端测试。
// 前半用记数的假帧源直接跑 renderPlan、layerL2（要 FFmpeg，不要 Blender 和浏览器）：帧源被调了几次是精确的数。
// 后半起真 HTTP 服务，用真 Blender 和无头浏览器把双镜头片反复交付（缺工具时跳过），帧源调用次数读账本行的 sourceRenders。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after, before } from 'node:test';
import { verifyDeliveryBundle } from '../comp/index.mjs';
import { computeFrameCacheKey } from '../jobs/cache.mjs';
import { openShotCache } from '../jobs/index.mjs';
import { findBlender } from '../sources/blender/host.mjs';
import { readExr, writeExr } from '../verify/exr/exr.mjs';
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
/** 坏掉的编号层：实体只占画面左边四分之一，和元数据里铺满画面的 bbox2d 的交并比是 0.25 */
const smearedIds = (w, h) => Buffer.from(new Uint32Array(w * h).map((_, i) => (i % w < w / 4 ? 1 : 0)).buffer);
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
  format: 'lock/1.0', machine: { class: 'workstation', driver: '580.88' }, assets: { 'asset:kit@1': `sha256:${HEX('a')}` },
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
 * 颜色只由镜头条目、风格 tokens 和局部帧号决定。照 want 交层（color、objectId、depth、normal，别的报 contract.unsupported-output），
 * wants 记每次 render 要的输出；extras 是 true 时另交场景参考通路的 frame.exr（通道照页面宿主：color.R/G/B/A、要了的辅助层每个分量、要了编号层另有 objectId2x.coverage）和 objectId2x（占位字节）。
 * 元数据登记一个铺满画面的实体、编号层全是它的编号（包围盒 IoU 是 1）；badId(镜头, 局部帧号) 为真的帧只污染编号层（见 smearedIds），颜色和元数据不变。
 * drift 不是 0 时每调一次 render 颜色都多漂一点（镜头不是时刻的纯函数，纯函数门必不过）；onRender 在每次 render 开头调一下（测试拿它在半路取消作业）。
 */
const NATIVE_AUX = { objectId: ['id'], depth: ['Z'], normal: ['X', 'Y', 'Z'] };
/** 原生 EXR 去掉 drop 里的通道重写一遍：文件本身完好、画幅不变，只是通道比页面宿主该写的少 */
const rechannel = (bytes, drop) => {
  const { width, height, channels } = readExr(bytes);
  return writeExr({ width, height, channels: Object.fromEntries(Object.entries(channels).filter(([name]) => !drop.includes(name))) });
};
/** 把文件头通道表里一个通道的像素类型改掉（0 整数、2 浮点，都是每样本 4 字节，文件照样解得开）：写入器不肯给已知通道写错类型，只能改字节 */
const retyped = (bytes, name, type) => {
  const out = Buffer.from(bytes);
  out.writeInt32LE(type, out.indexOf(`${name}\0`) + name.length + 1);
  return out;
};

function fakePool(knobs = {}) {
  const pool = { calls: {}, wants: [], bias: 0, drift: 0, onRender: null, gpu: 'fake-gpu', extras: false, badId: null, ...knobs };
  pool.get = async (source) => ({
    async open(input, env) {
      const { shot } = input, [w, h] = input.output.size;
      const count = (pool.calls[shot.id] ??= { open: 0, render: 0 });
      count.open++;
      const base = (parseInt(sha256(JSON.stringify([shot.cards, input.tokens])).slice(0, 4), 16) / 65535) * 0.4;
      let n = 0;
      return {
        async render(f, _opts, want = ['color', 'objectId', 'meta']) {
          count.render++;
          pool.wants.push(want);
          pool.onRender?.();
          const color = new Float32Array(w * h * 4).map((_, i) => (i % 4 === 3 ? 1 : base + 0.002 * f + pool.bias + pool.drift * count.render));
          const colorBytes = Buffer.from(color.buffer);
          const made = {
            color: () => ['f32', 4, colorBytes],
            objectId: () => ['u32', 1, pool.badId?.(shot.id, f) ? smearedIds(w, h) : Buffer.from(new Uint32Array(w * h).fill(1).buffer)],
            depth: () => ['f32', 1, Buffer.from(new Float32Array(w * h).map((_, i) => 2 + f + i / 1000).buffer)],
            normal: () => ['f32', 3, Buffer.from(new Float32Array(w * h * 3).map((_, i) => (i % 3 === 2 ? 1 : 0)).buffer)],
          };
          const sub = `r${String(n++).padStart(3, '0')}-f${String(f).padStart(4, '0')}`;
          mkdirSync(join(env.workspace, sub), { recursive: true });
          const layers = {}, channels = {};
          for (const name of want.filter((x) => x !== 'meta')) {
            if (!made[name]) throw Object.assign(new Error(`这个帧源交不出：${name}`), { code: 'contract.unsupported-output' });
            const [type, comps, bytes] = made[name]();
            writeFileSync(join(env.workspace, sub, `${name}.${type}`), bytes);
            layers[name] = { file: `${sub}/${name}.${type}`, shape: [h, w, comps] };
            const data = new (type === 'u32' ? Uint32Array : Float32Array)(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
            if (name !== 'color') NATIVE_AUX[name].forEach((c, at) => { channels[`${name}.${c}`] = data.filter((_, i) => i % comps === at); });
          }
          const extra = {};
          if (pool.extras) {
            const plane = (at) => color.filter((_, i) => i % 4 === at);
            if (channels['objectId.id']) channels['objectId2x.coverage'] = new Float32Array(w * h).fill(1);
            writeFileSync(join(env.workspace, sub, 'frame.exr'), writeExr({ width: w, height: h, channels: { 'color.R': plane(0), 'color.G': plane(1), 'color.B': plane(2), 'color.A': plane(3), ...channels } }));
            writeFileSync(join(env.workspace, sub, 'objectId2x.u32'), Buffer.from(new Uint32Array(4 * w * h).fill(f + 1).buffer));
            Object.assign(extra, { exr: { file: `${sub}/frame.exr` }, objectId2x: { file: `${sub}/objectId2x.u32` } });
          }
          const frame = shot.in + f;
          const meta = {
            format: 'meta/0.1', film: input.film, shot: shot.id, frame, shotFrame: f, size: [w, h], entities: [{ id: 1, name: 'body', bbox2d: [0, 0, w, h] }],
            events: (input.events?.events ?? []).filter((e) => e.frame === frame).map((e) => ({ id: e.id, frame: e.frame })),
            source: { id: source, renderer: source, tier: env.tier, backend: 'fake', gpu: pool.gpu },
            timing: { stateMs: 1, renderMs: 2, readbackMs: 1 }, hash: { color: `sha256:${sha256(colorBytes)}` },
          };
          return { meta, layers, ...extra };
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
  assert.match(a.runtimeEnv.driver, /"driver":"580\.88"/, '锁里声明的出片机器（lock.machine）在第 5 项里');
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
    ['⑤ 锁里的显卡驱动 machine.driver', null, (l) => { l.machine.driver = '580.95'; }, 'final', ['s01', 's02']],
    ['⑤ 锁里的机器类别 machine.class', null, (l) => { l.machine.class = 'render-node'; }, 'final', ['s01', 's02']],
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

test('缺了请求层的条目不当命中：没带编号层的、要了 depth 却只存了编号层的都重渲', { skip: noFfmpeg }, async () => {
  for (const [layers, kept] of [[undefined, []], [['color', 'depth'], ['objectId.u32']]]) {
    const { run, cache } = arena();
    const film = patched(filmOf(), (f) => { if (layers) f.delivery = { master: 'h264-web', layers }; }), shot = film.shots[1];
    await run(film, { plan: [{ shot, frames: [12] }] });
    const [file] = frameFiles(cache, 's02');
    const raw = readFileSync(file), header = JSON.parse(raw.subarray(0, raw.indexOf(0x0a)).toString('utf8'));
    const { determinism, tier, samples, size, subs, layers: wanted, ...five } = pipeline.buildShotCacheInputs({ film, lock: lockOf(), shot, filmDir: root, tier: 'final', device: { backend: 'fake', gpu: 'fake-gpu' } });
    assert.deepEqual(wanted, layers ? ['color', 'depth', 'objectId'] : ['color', 'objectId'], '终渲档的层集合：颜色、编号，加上 delivery.layers 点名的');
    const entry = computeFrameCacheKey({ ...five, renderSpec: { tier, samples, size, frame: 0, subs, layers: wanted } });
    assert.equal(entry.key, header.key, '测试算的键就是出片链路写下的键');
    const hit = cache.get(entry);
    assert.deepEqual(Object.keys(hit.layers).sort(), wanted.filter((n) => n !== 'color').map((n) => `${n}.${n === 'objectId' ? 'u32' : 'f32'}`));
    cache.put(entry, { colorBytes: hit.colorBytes, layers: kept.length ? Object.fromEntries(kept.map((k) => [k, hit.layers[k]])) : undefined, meta: header.meta, runId: header.runId });
    assert.deepEqual((await run(film, { plan: [{ shot, frames: [12] }] })).pool.calls, { s02: { open: 1, render: 1 } });
  }
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

/* ---------------- 请求的通道（delivery.layers）与 L2 结论的复用 ---------------- */

const withLayers = (film, layers) => patched(film, (f) => { f.delivery = { master: 'h264-web', layers }; });
/** EXR 文件头里的通道名（FFmpeg 写的和 verify/exr 写的都读得了）：chlist 是一串「名字\0 + 16 字节」，以空名字结束 */
function channelsOf(file) {
  const raw = readFileSync(file), tag = Buffer.from('channels\0chlist\0');
  let at = raw.indexOf(tag) + tag.length + 4;
  const names = [];
  for (let end; (end = raw.indexOf(0, at)) > at; at = end + 17) names.push(raw.subarray(at, end).toString());
  return names.sort();
}

test('delivery.layers 进键也进缓存体：换通道集合必重渲，层文件与 EXR 里真有请求的通道，热缓存逐字节相同', { skip: noFfmpeg }, async () => {
  const { run } = arena();
  const film = filmOf();
  const plain = await run(film);
  assert.deepEqual(channelsOf(plain.records[0].exr), ['A', 'B', 'G', 'R'], '没点名通道时 EXR 只有颜色');
  const decoded = readExr(readFileSync(plain.records[0].exr));
  assert.deepEqual(Object.keys(decoded.channels).sort(), ['A', 'B', 'G', 'R'], '只有颜色的 EXR 也过 verify/exr 的读取器');
  assert.equal(decoded.channels.R[0], readFileSync(plain.records[0].color).readFloatLE(0));

  const named = await run(withLayers(film, ['color', 'objectId']));
  assert.deepEqual(named.pool.calls, {}, '点名的两层本来就存着：命中');
  assert.deepEqual(channelsOf(named.records[0].exr), ['A', 'B', 'G', 'R', 'objectId.id']);

  for (const [name, components] of [['depth', ['Z']], ['normal', ['X', 'Y', 'Z']]]) {
    const asked = withLayers(film, ['color', name]);
    const cold = await run(asked);
    assert.deepEqual(cold.pool.calls, { s01: { open: 1, render: 12 }, s02: { open: 1, render: 12 } }, `改要 ${name}：两个镜头都没有带这一层的条目`);
    assert.ok(cold.pool.wants.every((w) => w.includes(name) && w.includes('objectId') && w.includes('color')));
    const hot = await run(asked);
    assert.deepEqual(hot.pool.calls, {}, '同一组通道再渲：全部命中');
    for (const [i, rec] of hot.records.entries()) {
      const was = cold.records[i], layer = (r) => readFileSync(join(dirname(r.color), `${name}.f32`));
      assert.equal(rec.cached, true);
      assert.equal(layer(was).length, SIZE[0] * SIZE[1] * 4 * components.length);
      assert.deepEqual(layer(rec), layer(was), `帧 ${rec.frame} 的 ${name} 层从缓存还原，逐字节相同`);
      assert.deepEqual(readFileSync(rec.objectId), readFileSync(was.objectId));
      assert.deepEqual(readFileSync(rec.exr), readFileSync(was.exr), '冷热两次的 EXR 逐字节相同');
      const exr = readExr(readFileSync(rec.exr));
      assert.deepEqual(channelsOf(rec.exr), ['A', 'B', 'G', 'R', ...components.map((c) => `${name}.${c}`)]);
      const bytes = layer(rec), plane = Array.from({ length: SIZE[0] * SIZE[1] }, (_, at) => bytes.readFloatLE(at * components.length * 4));
      assert.deepEqual(Array.from(exr.channels[`${name}.${components[0]}`]), plane, 'EXR 里的通道就是层文件里的数');
    }
  }

  const draft = await run(withLayers(film, ['color', 'depth']), { tier: 'draft', plan: [{ shot: film.shots[1], frames: [12] }] });
  assert.deepEqual(draft.pool.wants, [['color', 'objectId', 'meta']], 'delivery.layers 是终渲要落盘的通道，草稿档不要');
  await assert.rejects(run(withLayers(film, ['color', 'motion'])), { code: 'contract.unsupported-output' }, '帧源交不出的通道报错，不出缺层的帧');
});

test('场景参考通路的 frame.exr 与 objectId2x 随帧进缓存，命中时原样还原', { skip: noFfmpeg }, async () => {
  const { run } = arena();
  const film = filmOf();
  const cold = await run(film, { pool: fakePool({ extras: true }) });
  const hot = await run(film, { pool: fakePool({ extras: true }) });
  assert.deepEqual(hot.pool.calls, {});
  for (const [i, rec] of hot.records.entries()) {
    for (const name of ['frame.exr', 'objectId2x.u32', 'objectId.u32']) {
      assert.deepEqual(readFileSync(join(dirname(rec.color), name)), readFileSync(join(dirname(cold.records[i].color), name)), `帧 ${rec.frame} 的 ${name}`);
    }
  }
});

test('交付的 L2 纯函数门：这一版镜头过了门、这一轮又全部命中时照记录用，不起帧源；单独核验、有真渲帧、记录坏了都照常真跑', { skip: noFfmpeg }, async () => {
  const { run, cache, dir, filmDir } = arena();
  const film = filmOf(), edited = patched(film, (f) => { f.shots[1].cards[0].params.text = 'NEW'; });
  let n = 0;
  async function gate(of, res, extra = {}) {
    const pool = fakePool();
    const l2 = await pipeline.layerL2({ film: of, lock: lockOf(), filmDir, shots: of.shots, records: res.records, pool, scratch: join(dir, `l2-${++n}`), ...extra });
    return { gates: l2.gates, calls: Object.fromEntries(Object.entries(pool.calls).map(([id, c]) => [id, c.render])) };
  }
  const first = await run(film);
  assert.deepEqual(Object.fromEntries(Object.entries(first.versions).map(([id, v]) => [id, v.hit])), { s01: false, s02: false });
  const a = await gate(film, first, { cache, versions: first.versions });
  assert.deepEqual(a.calls, { s01: 6, s02: 6 }, '头一次交付：每个镜头两帧、三种次序');
  assert.ok(a.gates.every((g) => g.ok && !g.cached));

  const second = await run(edited);
  const b = await gate(edited, second, { cache, versions: second.versions });
  assert.deepEqual(b.calls, { s02: 6 }, '只改 s02：s01 这一版过了门、这一轮全部命中，帧源一次都没调');
  assert.deepEqual(b.gates[0], { ...a.gates[0], cached: true });
  assert.equal(b.gates[1].cached, undefined);

  const third = await run(edited);
  const c = await gate(edited, third, { cache, versions: third.versions });
  assert.deepEqual(c.calls, {}, '原样再交付：全片不调帧源');
  assert.deepEqual(c.gates.map((g) => [g.shot, g.ok, g.cached]), [['s01', true, true], ['s02', true, true]]);

  assert.deepEqual((await gate(edited, third)).calls, { s01: 6, s02: 6 }, '单独核验不给 versions：照常真跑');

  rmSync(frameFiles(cache, 's01').find((file) => readFileSync(file).length > 1000));
  const patchedUp = await run(edited);
  assert.deepEqual([patchedUp.of('s01').renderedFrames, patchedUp.versions.s01.hit], [1, false]);
  assert.deepEqual((await gate(edited, patchedUp, { cache, versions: patchedUp.versions })).calls, { s01: 6 }, '这一轮补渲过帧的镜头重新过门');

  for (const record of frameFiles(cache, 's02').filter((file) => readFileSync(file).length < 1000)) { // 改前、改后两版各一条记录
    const raw = readFileSync(record);
    raw[raw.length - 2] ^= 0xff;
    writeFileSync(record, raw);
  }
  const again = await run(edited);
  assert.deepEqual((await gate(edited, again, { cache, versions: again.versions })).calls, { s02: 6 }, '记录坏了当没有，真跑后重新记下');
  assert.deepEqual((await gate(edited, again, { cache, versions: again.versions })).calls, {});
});

/**
 * 一个两个镜头都过了 L2、缓存里有过门记录的场地。gate(res, pool, extra) 不给 extra 是交付的接法，给 {}（或 { tier }）是单独核验的接法（有 cache 没有 versions）；
 * 交回 { ok, bbox, gates: { 镜头: true / false / 'cached' }, calls: { 镜头: 帧源 render 次数 } }。
 */
async function stagedArena(film) {
  const a = arena();
  let n = 0;
  a.gate = async (res, pool = fakePool(), extra = { versions: res.versions }) => {
    const l2 = await pipeline.layerL2({ film, lock: lockOf(), filmDir: a.filmDir, shots: film.shots, records: res.records, pool, scratch: join(a.dir, `l2-${++n}`), cache: a.cache, ...extra });
    return { ok: l2.ok, bbox: l2.bbox, gates: Object.fromEntries(l2.gates.map((g) => [g.shot, g.cached ? 'cached' : g.ok])), calls: Object.fromEntries(Object.entries(pool.calls).map(([id, c]) => [id, c.render])) };
  };
  assert.deepEqual((await a.gate(await a.run(film))).gates, { s01: true, s02: true });
  assert.deepEqual((await a.gate(await a.run(film))).gates, { s01: 'cached', s02: 'cached' });
  return a;
}
const dropFrame = (cache, shot) => rmSync(frameFiles(cache, shot).find((file) => readFileSync(file).length > 1000));

test('L2 没过当场作废这一版镜头的过门记录和帧：保留故障再交付照样真跑、照样不过；门跑到一半断了、帧换过了、单独核验没过都不留能复用的旧记录', { skip: noFfmpeg }, async () => {
  const film = filmOf(), flaky = () => fakePool({ drift: 0.01 }), staged = () => stagedArena(film);

  { // 复审的复现：补渲 1 帧后门没过，保留故障原样再交付
    const { run, gate, cache } = await staged();
    dropFrame(cache, 's02');
    const patchedUp = await run(film);
    assert.equal(patchedUp.of('s02').renderedFrames, 1);
    const failed = await gate(patchedUp, flaky());
    assert.deepEqual([failed.gates, failed.calls], [{ s01: 'cached', s02: false }, { s02: 6 }]);
    assert.equal(cache.getShotVerification(patchedUp.versions.s02.entry), undefined, '更早那条过门的记录当场撤销');
    const retry = await run(film);
    assert.deepEqual(retry.pool.calls, { s02: { open: 1, render: 12 } }, '没过门的这一版帧整版作废：再交付时重渲，s01 照常命中');
    const again = await gate(retry, flaky());
    assert.deepEqual([again.gates, again.calls], [{ s01: 'cached', s02: false }, { s02: 6 }], '保留故障再交付：照样真跑、照样不过');
    const fixed = await gate(await run(film));
    assert.deepEqual([fixed.gates, fixed.calls], [{ s01: 'cached', s02: true }, { s02: 6 }], '故障排除后真跑过门，重新记下');
    assert.deepEqual((await gate(await run(film))).gates, { s01: 'cached', s02: 'cached' });
  }
  { // 门跑到一半作业被取消：不算没过（帧留着），但旧记录在开跑前已经盖成未过
    const { run, gate, cache } = await staged();
    dropFrame(cache, 's02');
    const stop = new AbortController();
    let seen = 0;
    const res = await run(film);
    await assert.rejects(gate(res, fakePool({ onRender() { if (++seen === 3) stop.abort(new Error('作业取消')); } }), { versions: res.versions, signal: stop.signal }), /作业取消/);
    const next = await run(film);
    assert.deepEqual(next.pool.calls, {}, '取消不是门的结论：这一版的帧不作废');
    const after = await gate(next);
    assert.deepEqual([after.gates, after.calls], [{ s01: 'cached', s02: true }, { s02: 6 }], '全部命中也真跑：没有留下能复用的旧记录');
  }
  { // 过门之后帧被换过：一次终渲作业补了一帧（不过门），容差档补出来的帧和原来不逐位相同
    const { run, gate, cache } = await staged();
    dropFrame(cache, 's01');
    assert.equal((await run(film, { pool: fakePool({ bias: 1e-4 }) })).of('s01').renderedFrames, 1);
    const res = await run(film);
    assert.deepEqual(res.pool.calls, {});
    const swapped = await gate(res);
    assert.deepEqual([swapped.gates, swapped.calls], [{ s01: true, s02: 'cached' }, { s01: 6 }], '记录认这一版全部帧的颜色摘要：帧换过就真跑');
  }
  { // 单独核验没过：这一版的终渲帧和记录一起作废
    const { run, gate } = await staged();
    const solo = await gate(await run(film), flaky(), {});
    assert.deepEqual([solo.gates, solo.calls], [{ s01: false, s02: false }, { s01: 6, s02: 6 }]);
    assert.deepEqual((await run(film)).pool.calls, { s01: { open: 1, render: 12 }, s02: { open: 1, render: 12 } });
  }
  { // 单独核验过了：照旧每次真跑，不读也不改记录
    const { run, gate } = await staged();
    assert.deepEqual((await gate(await run(film), fakePool(), {})).calls, { s01: 6, s02: 6 });
    assert.deepEqual((await gate(await run(film))).gates, { s01: 'cached', s02: 'cached' });
  }
});

test('L2 包围盒没过同样当场作废：纯函数门过了也不留过门记录，坏帧不留在缓存里；帧源恢复后原样再交付，重渲、过门', { skip: noFfmpeg }, async () => {
  const film = filmOf(), [w, h] = SIZE;
  const frameCount = (cache, shot, tier) => frameFiles(cache, shot, tier).filter((file) => readFileSync(file).length > 1000).length;
  // 三审的复现：过了门之后 s02 补渲 1 帧，这一帧只有编号层是坏的（纯函数门只看颜色，照过）。交付和单独核验两种接法都要当场作废
  for (const [name, extra] of [['交付', undefined], ['单独核验', {}]]) {
    const { run, gate, cache } = await stagedArena(film);
    dropFrame(cache, 's02');
    const patchedUp = await run(film, { pool: fakePool({ badId: (shot) => shot === 's02' }) });
    assert.deepEqual(patchedUp.pool.calls, { s02: { open: 1, render: 1 } });
    const failed = await gate(patchedUp, fakePool(), extra);
    assert.deepEqual([failed.ok, failed.bbox.ok, failed.bbox.minIou, failed.gates.s02, failed.calls.s02], [false, false, 0.25, true, 6], `${name}：纯函数门过了，包围盒没过`);
    assert.equal(cache.getShotVerification(patchedUp.versions.s02.entry), undefined, `${name}：这一版的过门记录撤销`);
    assert.deepEqual([frameCount(cache, 's02'), frameCount(cache, 's01')], [0, 12], `${name}：s02 这一版的帧作废，没出问题的 s01 不动`);
    const retry = await run(film);
    assert.deepEqual(retry.pool.calls, { s02: { open: 1, render: 12 } }, `${name}：帧源恢复后原样再交付，s02 整镜重渲`);
    const fixed = await gate(retry);
    assert.deepEqual([fixed.ok, fixed.gates, fixed.calls], [true, { s01: 'cached', s02: true }, { s02: 6 }], `${name}：重渲的帧真跑过门，重新记下`);
    const hot = await run(film);
    assert.deepEqual([hot.pool.calls, (await gate(hot)).gates], [{}, { s01: 'cached', s02: 'cached' }]);
  }
  { // 坏帧已经在缓存里、这一版又有过门的记录（全部命中，门照记录用、不起帧源）：一样作废，不会每次都还原同一张坏帧
    const { run, gate, cache } = await stagedArena(film);
    const { entry } = (await run(film)).versions.s02, whole = cache.get(entry);
    cache.put(entry, { colorBytes: whole.colorBytes, layers: { ...whole.layers, 'objectId.u32': smearedIds(w, h) }, meta: whole.meta, seam: whole.seam, runId: whole.runId });
    const hot = await run(film);
    assert.deepEqual(hot.pool.calls, {});
    const failed = await gate(hot);
    assert.deepEqual([failed.ok, failed.bbox.ok, failed.gates, failed.calls], [false, false, { s01: 'cached', s02: 'cached' }, {}]);
    assert.equal(cache.getShotVerification(entry), undefined);
    const retry = await run(film);
    assert.deepEqual(retry.pool.calls, { s02: { open: 1, render: 12 } });
    assert.deepEqual((await gate(retry)).ok, true);
  }
  { // 单独核验拿草稿档的抽样帧：坏帧在草稿档的缓存里，草稿档这一版也要作废，不然再渲草稿又还原出同一张坏帧
    const { run, gate, cache } = await stagedArena(film);
    const plan = [{ shot: film.shots[1], frames: [12, 17, 23] }], draft = (pool) => run(film, { tier: 'draft', plan, pool });
    const bad = await draft(fakePool({ badId: (_, f) => f === 5 }));
    assert.deepEqual([bad.pool.calls.s02.render, (await draft()).pool.calls], [3, {}]);
    const solo = await gate(bad, fakePool(), { tier: 'draft' });
    assert.deepEqual([solo.ok, solo.bbox.ok, solo.gates], [false, false, { s01: true, s02: true }]);
    assert.deepEqual([frameCount(cache, 's02', 'draft'), frameCount(cache, 's02'), frameCount(cache, 's01')], [0, 0, 12]);
    const again = await draft();
    assert.deepEqual(again.pool.calls, { s02: { open: 1, render: 3 } });
    assert.equal((await gate(again, fakePool(), { tier: 'draft' })).bbox.ok, true);
  }
});

test('页面帧源场景参考镜头的命中要带解得开的原生 frame.exr 和尺寸对的 objectId2x：缺了、截断了、尺寸不对、少了请求的通道或通道类型不对都当没命中，重渲补齐', { skip: noFfmpeg }, async () => {
  const { run, cache } = arena();
  const film = patched(withLayers(filmOf(), ['color', 'normal', 'depth']), (f) => { f.shots[1].colorRef = 'scene'; }), shot = film.shots[1];
  const round = () => run(film, { plan: [{ shot, frames: [12, 13, 14, 15] }], pool: fakePool({ extras: true }) });
  const cold = await round();
  assert.deepEqual((await round()).pool.calls, {});
  const { determinism, tier, samples, size, subs, layers, ...five } = pipeline.buildShotCacheInputs({ film, lock: lockOf(), shot, filmDir: root, tier: 'final', device: { backend: 'fake', gpu: 'fake-gpu' } });
  const entry = computeFrameCacheKey({ ...five, renderSpec: { tier, samples, size, frame: 3, subs, layers } });
  const whole = cache.get(entry);
  assert.deepEqual(Object.keys(whole.layers).sort(), ['depth.f32', 'frame.exr', 'normal.f32', 'objectId.u32', 'objectId2x.u32']);
  assert.deepEqual(Object.keys(readExr(whole.layers['frame.exr']).channels).sort(), ['color.A', 'color.B', 'color.G', 'color.R', 'depth.Z', 'normal.X', 'normal.Y', 'normal.Z', 'objectId.id', 'objectId2x.coverage']);
  // 条目经缓存的写入口重存：文件头和每一层的校验和都对，只是少了一层、层的大小不对，或者原生 EXR 本身解不开、不是这一帧的画幅和颜色通道
  const [w, h] = SIZE, exrOf = (width, height, names) => writeExr({ width, height, channels: Object.fromEntries(names.map((name) => [name, new Float32Array(width * height)])) });
  const nativeColor = ['color.R', 'color.G', 'color.B', 'color.A'];
  const cases = [
    ['缺 frame.exr', ({ 'frame.exr': _, ...rest }) => rest],
    ['frame.exr 截断成前 16 字节', (all) => ({ ...all, 'frame.exr': all['frame.exr'].subarray(0, 16) })],
    ['frame.exr 少了最后一行扫描线', (all) => ({ ...all, 'frame.exr': all['frame.exr'].subarray(0, all['frame.exr'].length - 8) })],
    ['frame.exr 不是这一帧的画幅', (all) => ({ ...all, 'frame.exr': exrOf(w / 2, h, nativeColor) })],
    ['frame.exr 没有颜色通道', (all) => ({ ...all, 'frame.exr': exrOf(w, h, ['depth.Z']) })],
    // 四审的复现：文件解得开、颜色齐全、独立的 normal.f32 也在，只是原生 EXR 里少了请求的通道的一个分量
    ...['color.A', 'normal.Z', 'normal.X', 'depth.Z', 'objectId.id', 'objectId2x.coverage'].map((channel) => [`frame.exr 少了 ${channel}`, (all) => ({ ...all, 'frame.exr': rechannel(all['frame.exr'], [channel]) })]),
    ['frame.exr 的 normal.Z 是整数通道', (all) => ({ ...all, 'frame.exr': retyped(all['frame.exr'], 'normal.Z', 0) })],
    ['frame.exr 的 objectId.id 是浮点通道', (all) => ({ ...all, 'frame.exr': retyped(all['frame.exr'], 'objectId.id', 2) })],
    ['缺 objectId2x.u32', ({ 'objectId2x.u32': _, ...rest }) => rest],
    ['objectId2x.u32 不是 2 倍画幅', (all) => ({ ...all, 'objectId2x.u32': all['objectId2x.u32'].subarray(4) })],
  ];
  for (const [name, broken] of cases) {
    cache.put(entry, { colorBytes: whole.colorBytes, layers: broken(whole.layers), meta: whole.meta, seam: whole.seam, runId: whole.runId });
    const healed = await round();
    assert.deepEqual(healed.pool.calls, { s02: { open: 1, render: 1 } }, `${name}：这一帧当没命中`);
    assert.deepEqual(healed.records.map((r) => Boolean(r.cached)), [true, true, true, false]);
    for (const [i, rec] of healed.records.entries()) {
      for (const file of ['frame.exr', 'objectId2x.u32']) assert.deepEqual(readFileSync(join(dirname(rec.color), file)), readFileSync(join(dirname(cold.records[i].color), file)), `${name}：帧 ${rec.frame} 的 ${file}`);
      const exr = readExr(readFileSync(join(dirname(rec.color), 'frame.exr')));
      assert.deepEqual([exr.width, exr.height, ...[...nativeColor, 'normal.X', 'normal.Y', 'normal.Z', 'depth.Z', 'objectId2x.coverage'].map((c) => exr.channels[c] instanceof Float32Array && exr.channels[c].length), exr.channels['objectId.id'] instanceof Uint32Array && exr.channels['objectId.id'].length],
        [w, h, ...Array(10).fill(w * h)], `${name}：帧 ${rec.frame} 的 frame.exr 解得开，通道齐全`);
    }
    assert.deepEqual((await round()).pool.calls, {}, '补齐的条目写回了缓存');
  }
});

/* ---------------- 真 HTTP 服务：双镜头片反复交付 ---------------- */

function mediaSkip() {
  if (noFfmpeg) return noFfmpeg;
  const blender = findBlender();
  if (!blender || spawnSync(blender, ['--version'], { stdio: 'ignore', timeout: 20000 }).status !== 0) return '缺少可执行的 Blender';
  const probe = "import {chromium} from 'playwright-core'; const b=await chromium.launch({headless:true,executablePath:process.env.BEIMING_CHROME || undefined,args:['--mute-audio']}); await b.close()";
  if (spawnSync(process.execPath, ['--input-type=module', '-e', probe], { stdio: 'ignore', timeout: 30000 }).status !== 0) return '无头浏览器不可执行';
  return false;
}

test('HTTP：只改 s02 再交付时 s01 的帧源调用是 0（含 L2），原样再交付全片是 0；换 delivery.layers 必重渲、请求的通道真在帧目录和 EXR 里', { skip: mediaSkip(), timeout: 900000 }, async (t) => {
  const dataDir = join(root, 'server');
  const account = issueAccountToken(dataDir);
  const api = await startServer({ dataDir, port: 0, reviewer: null });
  t.after(() => api.close());
  const raw = async (method, path, token, body) => {
    const res = await fetch(api.url + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { http: res.status, body: await res.json() };
  };
  const call = async (...args) => (await raw(...args)).body;
  const made = (await call('POST', '/v1/films', account, { template: 'turntable', output: { size: [320, 180], fps: '24/1', frames: 24 } })).data;
  const base = `/v1/films/${made.film}`, filmDir = join(dataDir, 'films', made.film);
  /** 跑一个作业到结束，交回完整的结论信封（硬门过没过都交回），http 是作业结论那次响应的状态码 */
  async function finish(kind, body = {}) {
    let { http, body: env } = await raw('POST', `${base}/${kind}`, made.token, { ...body, wait: 30 });
    while (['queued', 'running'].includes(env.data.status)) ({ http, body: env } = await raw('GET', `/v1/jobs/${env.data.job}?wait=30`, made.token));
    const full = env.outputs?.find((o) => o.kind === 'response');
    return { ...(full ? await call('GET', full.url, made.token) : env), status: env.data.status, http };
  }
  async function job(kind, body = {}) {
    const env = await finish(kind, body);
    assert.equal(env.status, 'succeeded', JSON.stringify(env));
    return env;
  }
  const ledgerOf = (jobId) => readFileSync(join(dataDir, 'meta', `${made.film}.ledger.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.job === jobId && r.step.startsWith('job.'));
  const layersOf = (jobId, shot) => readdirSync(join(filmDir, 'deliver', jobId, 'frames', shot, 'layers'));
  const colorOf = (jobId, shot, name) => readFileSync(join(filmDir, 'deliver', jobId, 'frames', shot, 'layers', name, 'color.f32'));

  const first = await job('deliver');
  assert.deepEqual([first.data.deliveredFrames, first.data.renderedFrames, first.data.cachedFrames], [24, 24, 0]);
  const row1 = ledgerOf(first.data.job);
  assert.deepEqual([row1.frames, row1.renderedFrames, row1.cachedFrames], [24, 24, 0]);
  // sourceRenders 在帧源池里数：这个作业里每个镜头的 session.render 被调了几次，终渲的帧和 L2 的探针（两帧 × 三种次序）都算
  assert.deepEqual(row1.sourceRenders, { s01: 18, s02: 18 });

  const rev = (await call('GET', `${base}/film`, made.token)).data.rev;
  const put = await call('PUT', `${base}/film`, made.token, { format: 'patch/0.1', rev, ops: [{ op: 'set', path: 'shots/s02/cards/title/params/text', value: 'NEW' }] });
  assert.equal(put.ok, true, JSON.stringify(put));
  const second = await job('deliver');
  assert.deepEqual([second.data.deliveredFrames, second.data.renderedFrames, second.data.cachedFrames], [24, 12, 12]);
  assert.deepEqual(second.data.shots, [{ shot: 's01', renderedFrames: 0, cachedFrames: 12 }, { shot: 's02', renderedFrames: 12, cachedFrames: 0 }]);
  const row2 = ledgerOf(second.data.job);
  assert.deepEqual([row2.frames, row2.renderedFrames, row2.cachedFrames], [12, 12, 12], '账本的渲帧数减半');
  assert.deepEqual(row2.sourceRenders, { s02: 18 }, 's01 的 session.render 总次数是 0：终渲全部命中，L2 照这一版镜头过门的记录用');
  assert.deepEqual(second.data.layers.L2.gates.map((g) => [g.shot, g.ok, g.cached ?? false]), [['s01', true, true], ['s02', true, false]]);
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

  // 原样再交付：终渲和 L2 都不调帧源，六件套照出
  const fourth = await job('deliver');
  assert.deepEqual([fourth.data.deliveredFrames, fourth.data.renderedFrames, fourth.data.cachedFrames], [24, 0, 24]);
  const row4 = ledgerOf(fourth.data.job);
  assert.deepEqual([row4.frames, row4.renderedFrames, row4.cachedFrames, row4.gpuSeconds, row4.sourceRenders], [0, 0, 24, 0, {}]);
  assert.deepEqual([fourth.data.layers.L2.ok, fourth.data.layers.L3.ok, fourth.data.layers.L2.gates.every((g) => g.cached)], [true, true, true]);
  assert.equal(Object.keys(verifyDeliveryBundle(join(filmDir, 'deliver', fourth.data.job, 'bundle')).files).length, 6);

  // delivery.layers：请求的通道进键、进缓存体、进 EXR。s01 是场景参考的 Blender 镜头，s02 是显示参考的页面镜头
  const shotDir = (jobId, shot) => join(filmDir, 'deliver', jobId, 'frames', shot);
  const layerFiles = (jobId, shot, name) => layersOf(jobId, shot).sort().map((sub) => join(shotDir(jobId, shot), 'layers', sub, name)).filter((p) => existsSync(p));
  const exrFiles = (jobId, shot) => Array.from({ length: 12 }, (_, i) => join(shotDir(jobId, shot), 'exr', `l${String(i).padStart(4, '0')}.exr`));
  async function change(path, value) {
    const at = (await call('GET', `${base}/film`, made.token)).data.rev;
    const res = await call('PUT', `${base}/film`, made.token, { format: 'patch/0.1', rev: at, ops: [{ op: 'set', path, value }] });
    assert.equal(res.ok, true, JSON.stringify(res));
    return job('deliver');
  }
  const ask = (layers) => change('delivery/layers', layers);
  const named = await ask(['color', 'objectId']);
  assert.deepEqual([named.data.renderedFrames, named.data.cachedFrames], [0, 24], '点名的两层本来就存着');
  for (const shot of ['s01', 's02']) assert.deepEqual(channelsOf(exrFiles(named.data.job, shot)[0]), ['A', 'B', 'G', 'R', 'objectId.id']);
  for (const [name, components] of [['depth', ['Z']], ['normal', ['X', 'Y', 'Z']]]) {
    const cold = await ask(['color', name]);
    assert.deepEqual([cold.data.renderedFrames, cold.data.cachedFrames], [24, 0], `改要 ${name}：全片真渲`);
    assert.deepEqual(ledgerOf(cold.data.job).sourceRenders, { s01: 18, s02: 18 });
    const hot = await job('deliver');
    assert.deepEqual([hot.data.deliveredFrames, hot.data.renderedFrames, hot.data.cachedFrames], [24, 0, 24]);
    assert.deepEqual(ledgerOf(hot.data.job).sourceRenders, {});
    for (const shot of ['s01', 's02']) {
      const was = layerFiles(cold.data.job, shot, `${name}.f32`), now = layerFiles(hot.data.job, shot, `${name}.f32`);
      assert.deepEqual([was.length, now.length], [12, 12], `${shot} 的 12 帧都有 ${name} 层`);
      for (const [i, file] of now.entries()) assert.deepEqual(readFileSync(file), readFileSync(was[i]), `${shot} 第 ${i} 帧的 ${name} 层从缓存还原，逐字节相同`);
      for (const [i, file] of exrFiles(hot.data.job, shot).entries()) {
        assert.deepEqual(channelsOf(file), ['A', 'B', 'G', 'R', ...components.map((c) => `${name}.${c}`)]);
        assert.deepEqual(readFileSync(file), readFileSync(exrFiles(cold.data.job, shot)[i]), `${shot} 第 ${i} 帧的 EXR 冷热两次逐字节相同`);
      }
    }
    assert.equal(Object.keys(verifyDeliveryBundle(join(filmDir, 'deliver', hot.data.job, 'bundle')).files).length, 6);
    assert.deepEqual([hot.data.layers.L2.ok, hot.data.layers.L3.ok], [true, true]);
  }

  // 页面帧源的场景参考通路：帧源另交的 frame.exr（和有的话 objectId2x.u32）随帧进缓存，热缓存原样还原
  const sceneCold = await change('shots/s02/colorRef', 'scene');
  assert.deepEqual(sceneCold.data.shots, [{ shot: 's01', renderedFrames: 0, cachedFrames: 12 }, { shot: 's02', renderedFrames: 12, cachedFrames: 0 }], 'colorRef 在镜头条目里：只有 s02 换键');
  const sceneHot = await job('deliver');
  assert.deepEqual([sceneHot.data.renderedFrames, ledgerOf(sceneHot.data.job).sourceRenders], [0, {}]);
  for (const name of ['frame.exr', 'objectId2x.u32', 'normal.f32']) {
    const was = layerFiles(sceneCold.data.job, 's02', name), now = layerFiles(sceneHot.data.job, 's02', name);
    assert.equal(now.length, was.length);
    if (name !== 'objectId2x.u32') assert.equal(was.length, 12, `场景参考的 s02 每帧都有 ${name}`);
    for (const [i, file] of now.entries()) assert.deepEqual(readFileSync(file), readFileSync(was[i]), `s02 第 ${i} 帧的 ${name} 冷热两次逐字节相同`);
  }

  // 场景参考帧的缓存条目少了原生 EXR（文件头和各层校验和都对）：当没命中，那一帧重渲，帧目录里 12 帧的 frame.exr 一份不缺
  const cacheRoot = join(filmDir, 'deliver', '.shot-cache'), sceneCache = openShotCache(cacheRoot);
  const [sceneVersion, ...olderVersions] = readdirSync(join(cacheRoot, 'final', 'shot-s02'));
  assert.deepEqual(olderVersions, [], '终稿每个镜头只留最近用过的一版：改之前那几版 s02 交付后清掉了');
  const headers = frameFiles(sceneCache, 's02').map((file) => { const raw = readFileSync(file); return JSON.parse(raw.subarray(0, raw.indexOf(0x0a)).toString('utf8')); });
  const victim = { key: headers.find((h) => h.meta.frame === 15).key, shotKey: `sha256:${sceneVersion}`, shotId: 's02', tier: 'final' };
  const { layers: { 'frame.exr': nativeExr, ...kept }, ...whole } = sceneCache.get(victim);
  assert.ok(nativeExr.length > 0);
  sceneCache.put(victim, { colorBytes: whole.colorBytes, layers: kept, meta: whole.meta, seam: whole.seam, runId: whole.runId });
  const healed = await job('deliver');
  assert.deepEqual(healed.data.shots, [{ shot: 's01', renderedFrames: 0, cachedFrames: 12 }, { shot: 's02', renderedFrames: 1, cachedFrames: 11 }]);
  assert.deepEqual(ledgerOf(healed.data.job).sourceRenders, { s02: 7 }, '补渲 1 帧，这一轮有真渲帧的 s02 重新过门（6 次）');
  assert.equal(layerFiles(healed.data.job, 's02', 'frame.exr').length, 12);
  assert.deepEqual([healed.data.layers.L2.ok, (await job('deliver')).data.renderedFrames], [true, 0]);

  // 三审的复现：原生 EXR 只剩前 16 字节，经缓存的写入口重存（外层校验和是对的）。命中时要真解一遍：解不开就只重渲这一帧，交出的 12 帧 frame.exr 都解得开
  const stored = (entry) => { const { layers, ...rest } = sceneCache.get(entry); return { layers, rest: { colorBytes: rest.colorBytes, meta: rest.meta, seam: rest.seam, runId: rest.runId } }; };
  const sound = stored(victim);
  sceneCache.put(victim, { ...sound.rest, layers: { ...sound.layers, 'frame.exr': sound.layers['frame.exr'].subarray(0, 16) } });
  assert.throws(() => readExr(sceneCache.get(victim).layers['frame.exr']), /EXR/);
  const decoded = await job('deliver');
  assert.deepEqual(decoded.data.shots, [{ shot: 's01', renderedFrames: 0, cachedFrames: 12 }, { shot: 's02', renderedFrames: 1, cachedFrames: 11 }], '截断的原生 EXR 不当命中');
  assert.deepEqual([ledgerOf(decoded.data.job).sourceRenders, decoded.data.layers.L2.ok], [{ s02: 7 }, true], '输出调用 1 次，加这一轮有真渲帧的 s02 重新过门 6 次');
  const natives = layerFiles(decoded.data.job, 's02', 'frame.exr');
  assert.equal(natives.length, 12);
  for (const file of natives) {
    const exr = readExr(readFileSync(file));
    assert.deepEqual([exr.width, exr.height, ...['color.R', 'color.G', 'color.B'].map((c) => exr.channels[c] instanceof Float32Array && exr.channels[c].length)], [320, 180, 57600, 57600, 57600], file);
  }
  assert.deepEqual(readFileSync(natives.find((file) => file.includes('r000-f0003'))), sound.layers['frame.exr'], '重渲出的原生 EXR 和截断之前的逐字节相同');
  assert.deepEqual(sceneCache.get(victim).layers['frame.exr'], sound.layers['frame.exr'], '好的原生 EXR 写回了缓存');

  // 锁里声明的显卡驱动进第 5 项：拿这部真片子的锁复算，只改 machine.driver，环境摘要、帧键、镜头键都变
  const realFilm = JSON.parse(readFileSync(join(filmDir, 'film.json'), 'utf8')), realLock = JSON.parse(readFileSync(join(filmDir, 'film.lock'), 'utf8'));
  const keysOf = (lock) => {
    const { determinism, tier, samples, size, subs, layers, ...five } = pipeline.buildShotCacheInputs({ film: realFilm, lock, shot: realFilm.shots[1], filmDir, tier: 'final', device: JSON.parse(readFileSync(join(cacheRoot, 'devices.json'), 'utf8')).three });
    return computeFrameCacheKey({ ...five, renderSpec: { tier, samples, size, frame: 3, subs, layers } });
  };
  const [was, bumped] = [realLock, { ...realLock, machine: { ...realLock.machine, driver: `${realLock.machine.driver}-next` } }].map(keysOf);
  assert.deepEqual([was.key, was.shotKey], [victim.key, victim.shotKey], '复算的键就是服务写进缓存的键');
  assert.ok(bumped.components.runtimeEnv !== was.components.runtimeEnv && bumped.key !== was.key && bumped.shotKey !== was.shotKey);

  // 四审的复现：场景参考的 s02 要 color、normal、depth，一帧的原生 EXR 只少 normal.Z（颜色、别的通道、独立的 normal.f32 都在），经缓存的写入口重存。
  // 命中时要照页面宿主的写出契约核通道：只重渲这一帧，交付目录和缓存里的原生 EXR 都补回 normal.Z
  const fullCold = await ask(['color', 'normal', 'depth']);
  assert.deepEqual(fullCold.data.shots, [{ shot: 's01', renderedFrames: 12, cachedFrames: 0 }, { shot: 's02', renderedFrames: 12, cachedFrames: 0 }]);
  const [fullVersion, ...staleFull] = readdirSync(join(cacheRoot, 'final', 'shot-s02'));
  assert.deepEqual(staleFull, []);
  const holed = { key: frameFiles(sceneCache, 's02').map((file) => { const raw = readFileSync(file); return JSON.parse(raw.subarray(0, raw.indexOf(0x0a)).toString('utf8')); }).find((h) => h.meta?.frame === 15).key,
    shotKey: `sha256:${fullVersion}`, shotId: 's02', tier: 'final' };
  const full = stored(holed), fullChannels = Object.keys(readExr(full.layers['frame.exr']).channels).sort();
  assert.deepEqual(fullChannels, ['color.A', 'color.B', 'color.G', 'color.R', 'depth.Z', 'normal.X', 'normal.Y', 'normal.Z', 'objectId.id', 'objectId2x.coverage']);
  sceneCache.put(holed, { ...full.rest, layers: { ...full.layers, 'frame.exr': rechannel(full.layers['frame.exr'], ['normal.Z']) } });
  assert.deepEqual([Object.keys(readExr(sceneCache.get(holed).layers['frame.exr']).channels).sort(), sceneCache.get(holed).layers['normal.f32'].length], [fullChannels.filter((c) => c !== 'normal.Z'), 320 * 180 * 12]);
  const refilled = await job('deliver');
  assert.deepEqual(refilled.data.shots, [{ shot: 's01', renderedFrames: 0, cachedFrames: 12 }, { shot: 's02', renderedFrames: 1, cachedFrames: 11 }], '原生 EXR 少了请求的 normal.Z 不当命中');
  assert.deepEqual([ledgerOf(refilled.data.job).sourceRenders, refilled.data.layers.L2.ok], [{ s02: 7 }, true], '输出调用 1 次，加这一轮有真渲帧的 s02 重新过门 6 次');
  const refilledNatives = layerFiles(refilled.data.job, 's02', 'frame.exr');
  assert.equal(refilledNatives.length, 12);
  for (const bytes of [...refilledNatives.map((file) => readFileSync(file)), sceneCache.get(holed).layers['frame.exr']]) {
    const z = readExr(bytes, { requiredChannels: ['normal.Z'] }).channels['normal.Z'];
    assert.deepEqual([z instanceof Float32Array, z.length], [true, 57600]);
  }
  assert.deepEqual(sceneCache.get(holed).layers['frame.exr'], full.layers['frame.exr'], '带全通道的原生 EXR 写回了缓存，和动手之前的逐字节相同');

  // 三审的复现：L2 的包围盒没过（纯函数门过了、或者照记录用）时，这一版镜头的过门记录和帧当场作废，帧源没毛病就能原样再交付过去。
  // s02 改回显示参考（这部片子 s02 是场景参考时 L3 的 cut_at 本来就判不过，看不出整个交付过没过）
  const plain = await change('shots/s02/colorRef', 'display');
  assert.deepEqual([plain.ok, plain.http, plain.data.shots[1]], [true, 200, { shot: 's02', renderedFrames: 12, cachedFrames: 0 }]);
  const [plainVersion, ...stale] = readdirSync(join(cacheRoot, 'final', 'shot-s02'));
  assert.deepEqual(stale, []);
  const target = { key: frameFiles(sceneCache, 's02').map((file) => { const bytes = readFileSync(file); return JSON.parse(bytes.subarray(0, bytes.indexOf(0x0a)).toString('utf8')); }).find((h) => h.meta?.frame === 15).key,
    shotKey: `sha256:${plainVersion}`, shotId: 's02', tier: 'final' };
  // 往 s02 一帧的编号层两个对角各点一个最小实体的编号：颜色、元数据、键都不变，这个实体反算出的包围盒撑满画面
  const smear = () => {
    const { layers, rest } = stored(target), ids = new Uint32Array(layers['objectId.u32'].buffer.slice(layers['objectId.u32'].byteOffset, layers['objectId.u32'].byteOffset + layers['objectId.u32'].length));
    const boxArea = (e) => (e.bbox2d[2] - e.bbox2d[0]) * (e.bbox2d[3] - e.bbox2d[1]);
    ids[0] = ids[ids.length - 1] = rest.meta.entities.toSorted((p, q) => boxArea(p) - boxArea(q))[0].id;
    sceneCache.put(target, { ...rest, layers: { ...layers, 'objectId.u32': Buffer.from(ids.buffer) } });
  };
  const s02Frames = () => frameFiles(sceneCache, 's02').filter((file) => readFileSync(file).length > 4096).length;
  for (const kind of ['deliver', 'verify']) {
    assert.deepEqual([sceneCache.getShotVerification(target).l2.ok, s02Frames()], [true, 12], '坏帧进缓存之前这一版过过门');
    smear();
    // 单独核验读的是帧索引：先终渲一遍（全部命中，不调帧源），坏帧从缓存还原进终渲档的索引
    if (kind === 'verify') assert.equal((await job('render', { tier: 'final' })).data.renderedFrames, 0);
    const failed = await finish(kind, kind === 'verify' ? { tier: 'final' } : {});
    assert.deepEqual([failed.ok, failed.http, failed.error.code, failed.data.layers.L2.ok, failed.data.layers.L2.bbox.ok, failed.data.layers.L3.ok], [false, 422, 'contract.bad-value', false, false, true], JSON.stringify(failed).slice(0, 600));
    assert.ok(failed.data.layers.L2.bbox.minIou < 0.95 && failed.data.layers.L2.gates.find((g) => g.shot === 's02').ok, `${kind}：纯函数门是过的，没过的是包围盒`);
    if (kind === 'deliver') assert.deepEqual([failed.data.renderedFrames, ledgerOf(failed.data.job).sourceRenders], [0, {}], '全部命中、门照记录用：这次交付一次帧源都没调，照样查出坏帧');
    assert.deepEqual([sceneCache.getShotVerification(target), s02Frames()], [undefined, 0], `${kind}：s02 这一版的过门记录和缓存帧当场作废`);
    const recovered = await finish('deliver');
    assert.deepEqual([recovered.ok, recovered.http, recovered.data.shots], [true, 200, [{ shot: 's01', renderedFrames: 0, cachedFrames: 12 }, { shot: 's02', renderedFrames: 12, cachedFrames: 0 }]], `${kind}：原样再交付，s02 整镜重渲，交付通过`);
    assert.deepEqual([recovered.data.layers.L2.ok, recovered.data.layers.L2.bbox.ok, ledgerOf(recovered.data.job).sourceRenders], [true, true, { s02: 18 }]);
  }
  assert.deepEqual([(await finish('deliver')).data.renderedFrames, sceneCache.getShotVerification(target).l2.ok], [0, true]);

  // 缓存在 deliver/ 下，不进修订快照
  for (const snap of readdirSync(join(filmDir, 'snapshots'))) {
    assert.ok(!readdirSync(join(filmDir, 'snapshots', snap), { recursive: true }).some((p) => String(p).includes('.shot-cache')));
  }
  t.diagnostic(`交付 1 渲 ${row1.frames} 帧 ${row1.gpuSeconds} 显卡秒；交付 2 渲 ${row2.frames} 帧 ${row2.gpuSeconds} 显卡秒（含 s02 的 L2 探针）；原样再交付 ${row4.frames} 帧 ${row4.gpuSeconds} 显卡秒`);
});
