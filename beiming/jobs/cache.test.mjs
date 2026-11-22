// A16 单测（Red -> Green）：六项内容寻址镜头缓存、双镜头只改一镜另一镜 0 重渲、六项键逐一失效与容差档接缝检查
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as jobs from './index.mjs';

function makeBaseSpec(overrides = {}) {
  return {
    shot: { id: 's01', in: 0, out: 4, source: 'three', mode: 'cards-data', seed: 101, params: { gain: 1.0 } },
    loadedFiles: [{ path: 'shots/s01.js', sha256: 'a'.repeat(64) }],
    tracksHash: 'sha256:' + 'b'.repeat(64),
    cards: [{ id: 'camera.spline', version: '1.0.0', sha256: 'c'.repeat(64) }],
    runtimeEnv: {
      source: 'three',
      runtimeVersion: '0.187.0',
      browserBuild: '153.0.8010.12',
      gpuBackend: 'metal',
      driver: 'apple-m5-pro',
    },
    renderSpec: { tier: 'final', samples: 1, size: [8, 8], frame: 0, subs: [0] },
    ...overrides,
  };
}

test('A16-1 六项内容寻址键：键序无关稳定，且六项中任意一项变化均生成不同哈希', () => {
  assert.equal(typeof jobs.computeFrameCacheKey, 'function', 'jobs 应导出 computeFrameCacheKey');

  const k0 = jobs.computeFrameCacheKey(makeBaseSpec()).key;
  const kReordered = jobs.computeFrameCacheKey(
    makeBaseSpec({ shot: { params: { gain: 1.0 }, seed: 101, mode: 'cards-data', source: 'three', out: 4, in: 0, id: 's01' } }),
  ).key;
  assert.equal(k0, kReordered, '对象键序重排不应改变缓存键');

  const mutations = [
    makeBaseSpec({ shot: { id: 's01', in: 0, out: 4, source: 'three', mode: 'cards-data', seed: 101, params: { gain: 1.1 } } }),
    makeBaseSpec({ loadedFiles: [{ path: 'shots/s01.js', sha256: 'd'.repeat(64) }] }),
    makeBaseSpec({ tracksHash: 'sha256:' + 'e'.repeat(64) }),
    makeBaseSpec({ cards: [{ id: 'camera.spline', version: '1.0.1', sha256: 'c'.repeat(64) }] }),
    makeBaseSpec({
      runtimeEnv: {
        source: 'three',
        runtimeVersion: '0.187.0',
        browserBuild: '153.0.8010.12',
        gpuBackend: 'vulkan',
        driver: 'apple-m5-pro',
      },
    }),
    makeBaseSpec({ renderSpec: { tier: 'final', samples: 1, size: [8, 8], frame: 0, subs: [0, 0.5] } }),
  ];

  for (const [idx, m] of mutations.entries()) {
    const km = jobs.computeFrameCacheKey(m).key;
    assert.notEqual(km, k0, `第 ${idx + 1} 项输入变化必须使缓存键失效`);
  }
});

test('A16-2 双镜头出片缓存：只改 s02 时，s01 的实际渲染帧数严格为 0', async () => {
  assert.equal(typeof jobs.openShotCache, 'function');
  assert.equal(typeof jobs.renderShotsWithCache, 'function');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-a16-'));
  try {
    const cache = jobs.openShotCache(path.join(tmp, 'cache'));
    const calls = { s01: 0, s02: 0 };

    const buildShots = (s02ColorVal) => [
      {
        shot: { id: 's01', in: 0, out: 3, source: 'three', mode: 'cards-data', seed: 1, params: { v: 0.2 } },
        determinism: 'hash-same-machine',
        loadedFiles: [{ path: 'shots/s01.js', sha256: '1'.repeat(64) }],
        tracksHash: 'sha256:' + '2'.repeat(64),
        cards: [],
        runtimeEnv: { source: 'three', runtimeVersion: '0.187.0', browserBuild: '153', gpuBackend: 'metal', driver: 'm5' },
        tier: 'final',
        samples: 1,
        size: [4, 4],
        subs: [0],
      },
      {
        shot: { id: 's02', in: 3, out: 6, source: 'three', mode: 'cards-data', seed: 2, params: { v: s02ColorVal } },
        determinism: 'hash-same-machine',
        loadedFiles: [{ path: 'shots/s02.js', sha256: '3'.repeat(64) }],
        tracksHash: 'sha256:' + '4'.repeat(64),
        cards: [],
        runtimeEnv: { source: 'three', runtimeVersion: '0.187.0', browserBuild: '153', gpuBackend: 'metal', driver: 'm5' },
        tier: 'final',
        samples: 1,
        size: [4, 4],
        subs: [0],
      },
    ];

    const renderFrame = async ({ shot, frame, size }) => {
      calls[shot.id] += 1;
      const color = new Float32Array(size[0] * size[1] * 4).fill(shot.params.v + frame * 0.01);
      return {
        colorBytes: Buffer.from(color.buffer),
        colorFloats: color,
        meta: { shot: shot.id, shotFrame: frame, val: shot.params.v },
      };
    };

    const run1 = await jobs.renderShotsWithCache({ shots: buildShots(0.5), cache, renderFrame });
    assert.equal(run1.shots.find((s) => s.shotId === 's01').renderedFrames, 3);
    assert.equal(run1.shots.find((s) => s.shotId === 's02').renderedFrames, 3);

    calls.s01 = 0;
    calls.s02 = 0;
    // 第二次只改 s02 的参数 (0.5 -> 0.8)，s01 未动
    const run2 = await jobs.renderShotsWithCache({ shots: buildShots(0.8), cache, renderFrame });
    assert.equal(calls.s01, 0, '未改动的 s01 不应触发任何帧渲染调用');
    assert.equal(run2.shots.find((s) => s.shotId === 's01').renderedFrames, 0);
    assert.equal(run2.shots.find((s) => s.shotId === 's01').cachedFrames, 3);
    assert.equal(run2.shots.find((s) => s.shotId === 's02').renderedFrames, 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('A16-3 容差档接缝检查：复用旧帧与新渲帧交界处出现亮度尖峰时判不过', () => {
  assert.equal(typeof jobs.checkCacheSeams, 'function');

  const mkFrame = (val, fromCache) => ({
    fromCache,
    colorFloats: new Float32Array(16 * 4).fill(val),
    width: 4,
    height: 4,
  });

  // 平滑过渡：0.20, 0.21(cache), 0.22(fresh), 0.23(fresh) -> 无尖峰
  const smooth = [mkFrame(0.2, true), mkFrame(0.21, true), mkFrame(0.22, false), mkFrame(0.23, false)];
  assert.equal(jobs.checkCacheSeams(smooth, { determinism: 'tolerance' }).ok, true);

  // 交界尖峰：0.20(cache), 0.21(cache), 0.65(fresh!), 0.66(fresh) -> 第 2 帧交界突跳 0.44 远超邻域 0.01
  const spiked = [mkFrame(0.2, true), mkFrame(0.21, true), mkFrame(0.65, false), mkFrame(0.66, false)];
  const res = jobs.checkCacheSeams(spiked, { determinism: 'tolerance' });
  assert.equal(res.ok, false);
  assert.ok(res.spikes.some((s) => s.frame === 2));
});

// ---- 以下为 A16 扩展用例 ----
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const api = new URL('./index.mjs', import.meta.url).href;
const ENV = { source: 'blender', runtimeVersion: '5.2.3', browserBuild: 'none', gpuBackend: 'optix', driver: '581.15' };
const frameFiles = dir => fs.readdirSync(dir, { recursive: true }).filter((name) => name.endsWith('.frame')).map((name) => path.join(dir, name));

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-a16-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('A16-4 六项缺一或类型不对立即抛错，不退化成撞键', () => {
  const broken = [
    ['缺 tracksHash', (s) => { delete s.tracksHash; }],
    ['缺 cards', (s) => { delete s.cards; }],
    ['缺 loadedFiles', (s) => { delete s.loadedFiles; }],
    ['驱动签名缺失', (s) => { delete s.runtimeEnv.driver; }],
    ['驱动签名为空串', (s) => { s.runtimeEnv.driver = ''; }],
    ['shot 不是纯对象', (s) => { s.shot = new Map(); }],
    ['参数里有 NaN', (s) => { s.shot.params.gain = Number.NaN; }],
    ['参数里有 undefined', (s) => { s.shot.params.gain = undefined; }],
    ['文件哈希不是 sha256', (s) => { s.loadedFiles[0].sha256 = 'abc'; }],
    ['文件路径逃出工作区', (s) => { s.loadedFiles[0].path = '../s01.js'; }],
    ['同一路径列两次', (s) => { s.loadedFiles.push({ ...s.loadedFiles[0] }); }],
    ['卡版本不是三段', (s) => { s.cards[0].version = '1.0'; }],
    ['未知档位', (s) => { s.renderSpec.tier = 'preview'; }],
    ['帧号越出镜头', (s) => { s.renderSpec.frame = 4; }],
    ['尺寸不是正整数', (s) => { s.renderSpec.size = [8, 0]; }],
    ['sub 采样集为空', (s) => { s.renderSpec.subs = []; }],
    ['写错的键名', (s) => { s.trackHash = 'none'; }],
  ];
  for (const [name, mutate] of broken) {
    const spec = structuredClone(makeBaseSpec());
    mutate(spec);
    assert.throws(() => jobs.computeFrameCacheKey(spec), /./, name);
  }
  const loop = { id: 's01', in: 0, out: 4 };
  loop.self = loop;
  assert.throws(() => jobs.computeFrameCacheKey(makeBaseSpec({ shot: loop })), /./, '循环引用');
  assert.throws(() => jobs.canonicalJson({ a: Number.POSITIVE_INFINITY }));
  assert.equal(jobs.canonicalJson({ b: [2, { d: null, c: 'x' }], a: 1 }), '{"a":1,"b":[2,{"c":"x","d":null}]}');
});

test('A16-5 只认本镜头：整体平移、列表顺序与无轨道都不误伤；镜头变长、局部事件变化才失效', () => {
  const base = makeBaseSpec();
  const k0 = jobs.computeFrameCacheKey(base);
  assert.match(k0.key, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(k0.components), ['shot', 'loadedFiles', 'tracks', 'cards', 'runtimeEnv', 'renderSpec']);

  // 前一个镜头改长，本镜头 in / out 一起平移、帧数不变：照样命中
  const shifted = jobs.computeFrameCacheKey(makeBaseSpec({ shot: { ...base.shot, in: 12, out: 16 } }));
  assert.equal(shifted.key, k0.key);
  // 本镜头自己变长：失效
  assert.notEqual(jobs.computeFrameCacheKey(makeBaseSpec({ shot: { ...base.shot, out: 5 } })).key, k0.key);

  const two = {
    loadedFiles: [{ path: 'shots/s01.js', sha256: 'a'.repeat(64) }, { path: 'assets/a.glb', sha256: '9'.repeat(64) }],
    cards: [{ id: 'camera.spline', version: '1.0.0', sha256: 'c'.repeat(64) }, { id: 'time.events', version: '1.2.0', sha256: '7'.repeat(64) }],
    renderSpec: { tier: 'final', samples: 1, size: [8, 8], frame: 0, subs: [0, 0.5] },
  };
  const flipped = { loadedFiles: [...two.loadedFiles].reverse(), cards: [...two.cards].reverse(), renderSpec: { ...two.renderSpec, subs: [0.5, 0] } };
  assert.equal(jobs.computeFrameCacheKey(makeBaseSpec(flipped)).key, jobs.computeFrameCacheKey(makeBaseSpec(two)).key);

  // 无轨道、无卡要显式写出来，并且和有轨道的键不同
  const bare = jobs.computeFrameCacheKey(makeBaseSpec({ tracksHash: 'none', cards: [] }));
  assert.notEqual(bare.key, k0.key);

  // 逐帧、逐档位各有各的键；同一版镜头的各帧共用一个 shotKey
  const f1 = jobs.computeFrameCacheKey(makeBaseSpec({ renderSpec: { ...base.renderSpec, frame: 1 } }));
  assert.notEqual(f1.key, k0.key);
  assert.equal(f1.shotKey, k0.shotKey);
  const draft = jobs.computeFrameCacheKey(makeBaseSpec({ renderSpec: { ...base.renderSpec, tier: 'draft' } }));
  assert.notEqual(draft.key, k0.key);
  assert.notEqual(draft.shotKey, k0.shotKey);

  // 换成镜头局部帧号的事件属于第 1 项
  const withEvents = jobs.computeFrameCacheKey(makeBaseSpec({ events: { lock: 2 } }));
  assert.notEqual(withEvents.key, k0.key);
  assert.equal(withEvents.components.loadedFiles, k0.components.loadedFiles);
  assert.notEqual(jobs.computeFrameCacheKey(makeBaseSpec({ events: { lock: 3 } })).key, withEvents.key);
});

test('A16-6 读回校验：颜色层被改、被截断或文件头损坏都算未命中并清掉，绝不交出坏帧', async (t) => {
  const dir = tmpDir(t);
  const cache = jobs.openShotCache(dir);
  const entry = jobs.computeFrameCacheKey(makeBaseSpec());
  const colorBytes = Buffer.from([1, 2, 3, 4, 10, 0, 255]); // 含换行字节
  const put = () => cache.put(entry, { colorBytes, meta: { shot: 's01', timing: { renderMs: 9 } } });

  assert.equal(cache.get(entry), undefined);
  put();
  const hit = cache.get(entry);
  assert.deepEqual([...hit.colorBytes], [...colorBytes]);
  assert.deepEqual(hit.meta, { shot: 's01' }, '瞬时 timing 不进缓存');
  const [file] = frameFiles(dir);

  const damage = [
    () => { const raw = fs.readFileSync(file); raw[raw.length - 1] ^= 0xff; fs.writeFileSync(file, raw); },
    () => fs.truncateSync(file, fs.statSync(file).size - 2),
    () => fs.writeFileSync(file, 'not a frame'),
    () => fs.writeFileSync(file, ''),
  ];
  for (const hurt of damage) {
    put();
    hurt();
    assert.equal(cache.get(entry), undefined);
    assert.equal(fs.existsSync(file), false, '坏条目要清掉');
  }

  // 别的键的合法条目被挪到这个键的位置，也不认
  const other = jobs.computeFrameCacheKey(makeBaseSpec({ renderSpec: { tier: 'final', samples: 1, size: [8, 8], frame: 1, subs: [0] } }));
  cache.put(other, { colorBytes, meta: {} });
  fs.renameSync(frameFiles(dir)[0], file);
  assert.equal(cache.get(entry), undefined);

  assert.throws(() => cache.get({ ...entry, shotId: '../../x' }));
  assert.throws(() => cache.put(entry, { colorBytes: Buffer.alloc(0), meta: {} }));
  assert.throws(() => cache.put(entry, { colorBytes: 'abc', meta: {} }));

  // 坏帧只重渲它自己
  let calls = 0;
  const shots = [{ shot: makeBaseSpec().shot, determinism: 'hash-same-machine', loadedFiles: [], tracksHash: 'none', cards: [], runtimeEnv: ENV, tier: 'final', samples: 1, size: [2, 2], subs: [0] }];
  const renderFrame = async ({ frame }) => { calls += 1; return { colorBytes: Buffer.from([frame + 1]), meta: {} }; };
  await jobs.renderShotsWithCache({ shots, cache, renderFrame });
  const victim = frameFiles(dir).find((name) => fs.readFileSync(name).at(-1) === 3);
  fs.appendFileSync(victim, 'x');
  calls = 0;
  const again = await jobs.renderShotsWithCache({ shots, cache, renderFrame });
  assert.equal(calls, 1);
  assert.deepEqual([again.shots[0].renderedFrames, again.shots[0].cachedFrames], [1, 3]);
  assert.deepEqual(again.shots[0].frames.map((f) => f.fromCache), [true, true, false, true]);
  assert.deepEqual([...cache.get(again.shots[0].frames[2].entry).colorBytes], [3]);
});

function toleranceShots() {
  return [{ shot: { id: 's01', in: 0, out: 4, source: 'blender', mode: 'cards-data', seed: 1 }, determinism: 'tolerance',
    loadedFiles: [], tracksHash: 'none', cards: [], runtimeEnv: ENV, tier: 'final', samples: 16, size: [4, 4], subs: [0] }];
}

// base 模拟容差档帧源两次运行之间不进键的漂移；failAt 模拟上一轮渲到一半中断
function drifting(base, { failAt, floats = true } = {}) {
  const renderFrame = async ({ frame, size }) => {
    if (frame === failAt) throw new Error('渲染中断');
    renderFrame.calls += 1;
    const color = new Float32Array(size[0] * size[1] * 4).fill(base + frame * 0.01);
    return { colorBytes: Buffer.from(color.buffer), ...(floats && { colorFloats: color }), meta: { base, timing: { renderMs: 5 } } };
  };
  renderFrame.calls = 0;
  return renderFrame;
}

test('A16-7 容差档混用旧帧与新帧：接缝尖峰被拦下，默认把旧帧重渲成整镜同一轮', async (t) => {
  const cache = jobs.openShotCache(tmpDir(t));
  const shots = toleranceShots();
  await assert.rejects(jobs.renderShotsWithCache({ shots, cache, renderFrame: drifting(0.2, { failAt: 2 }) }), /渲染中断/);

  const second = drifting(0.65);
  const run = await jobs.renderShotsWithCache({ shots, cache, renderFrame: second });
  const [s01] = run.shots;
  assert.equal(second.calls, 6, '先补两帧，失效四帧后整镜重渲，六次调用都计费');
  assert.deepEqual([s01.totalFrames, s01.renderedFrames, s01.cachedFrames], [4, 6, 0]);
  assert.equal(s01.seamCheck.ok, true);
  assert.equal(s01.seamCheck.rerendered, true);
  assert.deepEqual(s01.seamCheck.spikes.map((s) => s.frame), [2]);
  assert.equal(run.ok, true);
  assert.deepEqual([run.totalFrames, run.totalRenderedFrames, run.totalCachedFrames], [4, 6, 0]);

  // 旧帧已被替换：第三轮整镜命中，读回的是第二轮的帧
  const third = drifting(0.9);
  const rerun = await jobs.renderShotsWithCache({ shots, cache, renderFrame: third });
  assert.equal(third.calls, 0);
  assert.deepEqual([rerun.shots[0].renderedFrames, rerun.shots[0].cachedFrames], [0, 4]);
  assert.equal(rerun.shots[0].seamCheck.checked, false, '整镜命中没有交界，不用查');
  assert.deepEqual(rerun.shots[0].frames.map((f) => cache.get(f.entry).meta.base), [0.65, 0.65, 0.65, 0.65]);
});

test('A16-7b 关掉自动重渲时只报不过；没有漂移不误报；缺接缝特征按不过处理', async (t) => {
  const strict = jobs.openShotCache(tmpDir(t));
  await assert.rejects(jobs.renderShotsWithCache({ shots: toleranceShots(), cache: strict, renderFrame: drifting(0.2, { failAt: 2 }) }));
  const flagged = await jobs.renderShotsWithCache({ shots: toleranceShots(), cache: strict, renderFrame: drifting(0.65), rerenderOnSeamSpike: false });
  assert.equal(flagged.ok, false);
  assert.equal(flagged.shots[0].seamCheck.ok, false);
  assert.deepEqual(flagged.shots[0].seamCheck.spikes.map((s) => s.frame), [2]);
  assert.deepEqual([flagged.shots[0].renderedFrames, flagged.shots[0].cachedFrames], [2, 2]);

  const calm = jobs.openShotCache(tmpDir(t));
  await assert.rejects(jobs.renderShotsWithCache({ shots: toleranceShots(), cache: calm, renderFrame: drifting(0.2, { failAt: 2 }) }));
  const smooth = await jobs.renderShotsWithCache({ shots: toleranceShots(), cache: calm, renderFrame: drifting(0.2) });
  assert.deepEqual(smooth.shots[0].seamCheck, { ok: true, checked: true, spikes: [] });
  assert.deepEqual([smooth.shots[0].renderedFrames, smooth.shots[0].cachedFrames], [2, 2]);

  // 哈希档同样的混用不查接缝
  const hashed = jobs.openShotCache(tmpDir(t));
  const hashShots = () => toleranceShots().map((s) => ({ ...s, determinism: 'hash-same-machine' }));
  await assert.rejects(jobs.renderShotsWithCache({ shots: hashShots(), cache: hashed, renderFrame: drifting(0.2, { failAt: 2 }) }));
  const exact = await jobs.renderShotsWithCache({ shots: hashShots(), cache: hashed, renderFrame: drifting(0.65) });
  assert.deepEqual(exact.shots[0].seamCheck, { ok: true, checked: false, spikes: [] });
  assert.equal(exact.shots[0].renderedFrames, 2);

  const blind = jobs.openShotCache(tmpDir(t));
  await assert.rejects(jobs.renderShotsWithCache({ shots: toleranceShots(), cache: blind, renderFrame: drifting(0.2, { failAt: 2, floats: false }) }));
  const noFloats = drifting(0.2, { floats: false });
  const unknown = await jobs.renderShotsWithCache({ shots: toleranceShots(), cache: blind, renderFrame: noFloats });
  assert.equal(noFloats.calls, 6);
  assert.equal(unknown.shots[0].seamCheck.rerendered, true);
  assert.deepEqual([unknown.shots[0].renderedFrames, unknown.shots[0].cachedFrames], [6, 0]);

  assert.throws(() => jobs.checkCacheSeams([], { determinism: 'exact' }), /./, '未知确定性档位不能静默放行');
  const nan = [0.2, 0.21, Number.NaN, 0.23].map((v, i) => ({ fromCache: i < 2, colorFloats: new Float32Array(4).fill(v) }));
  assert.equal(jobs.checkCacheSeams(nan, { determinism: 'tolerance' }).ok, false, '算不出帧差按尖峰处理');
  const bytes = [50, 52, 160, 162].map((v, i) => ({ fromCache: i < 2, colorFloats: new Uint8Array(16).fill(v) }));
  assert.deepEqual(jobs.checkCacheSeams(bytes, { determinism: 'tolerance' }).spikes.map((s) => s.frame), [2]);
});

test('A16-8 保留策略：草稿可清，终稿每镜只留最近用过的一版，过期的删', (t) => {
  const dir = tmpDir(t);
  const cache = jobs.openShotCache(dir);
  const keyOf = (gain, frame, tier = 'final') => jobs.computeFrameCacheKey(makeBaseSpec({
    shot: { ...makeBaseSpec().shot, params: { gain } }, renderSpec: { tier, samples: 1, size: [8, 8], frame, subs: [0] } }));
  const colorBytes = Buffer.from([7]);
  const hour = 60 * 60 * 1000;
  const now = Date.now();
  const age = (entries, ms) => { // 把刚写的条目改成 ms 之前写的
    for (const entry of entries) cache.put(entry, { colorBytes, meta: {} });
    const stamp = new Date(now - ms);
    for (const file of frameFiles(dir)) if (now - fs.statSync(file).mtimeMs < hour / 2) fs.utimesSync(file, stamp, stamp);
  };
  const v1 = [keyOf(1, 0), keyOf(1, 1)];
  const v2 = [keyOf(2, 0), keyOf(2, 1)];
  age(v1, 3 * hour);
  age(v2, 2 * hour);
  age([keyOf(1, 0, 'draft')], hour);
  assert.ok(cache.get(v1[0]), '命中会把这一版记成最近用过');

  assert.deepEqual(cache.prune({ clearDraft: true, now }), { removed: 3 });
  assert.ok(cache.get(v1[0]) && cache.get(v1[1]));
  assert.equal(cache.get(v2[0]), undefined);
  assert.equal(cache.get(keyOf(1, 0, 'draft')), undefined);

  assert.deepEqual(cache.prune({ now: now + 8 * 24 * hour }), { removed: 2 });
  assert.deepEqual(frameFiles(dir), []);
});

test('A16-9 四个进程同时写同一个键：读回完好，不留半截文件', async (t) => {
  const dir = tmpDir(t);
  const spec = JSON.stringify(makeBaseSpec());
  const script = `import { computeFrameCacheKey, openShotCache } from ${JSON.stringify(api)};
    const cache = openShotCache(${JSON.stringify(dir)});
    const entry = computeFrameCacheKey(${spec});
    for (let i = 0; i < 40; i += 1) {
      cache.put(entry, { colorBytes: Buffer.alloc(256 * 1024, 7), meta: { writer: process.pid } });
      if (cache.get(entry)?.colorBytes.length !== 256 * 1024) process.exit(3);
    }`;
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' }));
  for (const [code] of await Promise.all(children.map((child) => once(child, 'exit')))) assert.equal(code, 0);
  const hit = jobs.openShotCache(dir).get(jobs.computeFrameCacheKey(makeBaseSpec()));
  assert.ok(hit.colorBytes.equals(Buffer.alloc(256 * 1024, 7)));
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('.')), [], '不留暂存目录');
});

test('A16-10 接进作业队列：缓存放在工作区里不进快照，第二轮账本只记改过的镜头', async (t) => {
  const workspace = jobs.openWorkspace(tmpDir(t));
  const writeFilm = (v) => fs.writeFileSync(workspace.resolve('film.json'), JSON.stringify({ format: 'film/3.0', id: 'demo', shots: [
    { id: 's01', in: 0, out: 3, source: 'three', mode: 'cards-data', seed: 1, params: { v: 0.2 } },
    { id: 's02', in: 3, out: 6, source: 'three', mode: 'cards-data', seed: 2, params: { v } },
  ] }));
  const rendered = [];
  const final = async ({ inputPath, signal }) => {
    const film = JSON.parse(fs.readFileSync(inputPath('film.json'), 'utf8'));
    const run = await jobs.renderShotsWithCache({ cache: jobs.openShotCache(workspace.resolve('cache')), signal,
      shots: film.shots.map((shot) => ({ shot, determinism: 'hash-same-machine', loadedFiles: [], tracksHash: 'none', cards: [],
        runtimeEnv: { ...ENV, source: 'three' }, tier: 'final', samples: 1, size: [2, 2], subs: [0] })),
      renderFrame: async ({ shot, frame }) => { rendered.push(`${shot.id}:${frame}`); return { colorBytes: Buffer.from([frame + 1]), meta: {} }; } });
    return { cost: { renderedFrames: run.totalRenderedFrames, deliveredFrames: run.totalFrames } };
  };
  const queue = jobs.loadQueue(workspace.root, { handlers: { final } });

  writeFilm(0.5);
  workspace.commitRevision(0);
  await queue.runJob(queue.enqueue({ kind: 'final', rev: 0 }).id);
  writeFilm(0.8);
  const ref = workspace.commitRevision(1);
  rendered.length = 0;
  await queue.runJob(queue.enqueue({ kind: 'final', rev: 1 }).id);

  assert.deepEqual(rendered, ['s02:0', 's02:1', 's02:2']);
  assert.deepEqual(queue.readLedger().map((row) => [row.status, row.renderedFrames, row.deliveredFrames]), [['succeeded', 6, 6], ['succeeded', 3, 6]]);
  assert.ok(frameFiles(workspace.resolve('cache')).length >= 9);
  assert.deepEqual(workspace.openSnapshot(ref).manifest.files.map((file) => file.path), ['film.json'], '缓存不算作品输入');
});

// ---- 以下为第一轮评审（G_REV-R1）的回归用例 ----
import { createHash } from 'node:crypto';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const entryOf = ({ shot, determinism, tier, samples, size, subs, ...keyed }, frame) =>
  jobs.computeFrameCacheKey({ shot, ...keyed, renderSpec: { tier, samples, size, frame, subs } });
const basesOf = (cache, run) => run.shots[0].frames.map((f) => cache.get(f.entry).meta.base);

test('A16-11 六项键逐字段保护：每个进键字段单点变化都换键（M17、M26、M27、M36），片级输入有槽位，-0 与 0 不混同', () => {
  const changes = {
    '卡 id': (s) => { s.cards[0].id = 'camera.orbit'; },
    '卡实现哈希': (s) => { s.cards[0].sha256 = 'd'.repeat(64); },
    '文件路径': (s) => { s.loadedFiles[0].path = 'shots/s01b.js'; },
    '帧源': (s) => { s.runtimeEnv.source = 'blender'; },
    '运行时版本': (s) => { s.runtimeEnv.runtimeVersion = '0.188.0'; },
    '浏览器构建': (s) => { s.runtimeEnv.browserBuild = '154.0.1.1'; },
    '驱动签名': (s) => { s.runtimeEnv.driver = 'apple-m5-max'; },
    '采样数': (s) => { s.renderSpec.samples = 2; },
    '宽': (s) => { s.renderSpec.size = [16, 8]; },
    '高': (s) => { s.renderSpec.size = [8, 16]; },
    '片级种子': (s) => { s.film = { seed: 7 }; },
    '片级帧率': (s) => { s.film = { seed: 7, fps: '30/1' }; },
    '参数 -0': (s) => { s.shot.params.gain = -0; },
    '参数 +0': (s) => { s.shot.params.gain = 0; },
  };
  const keys = new Map([['基准', jobs.computeFrameCacheKey(makeBaseSpec()).key]]);
  for (const [name, change] of Object.entries(changes)) {
    const spec = structuredClone(makeBaseSpec());
    change(spec);
    const { key } = jobs.computeFrameCacheKey(spec);
    for (const [other, seen] of keys) assert.notEqual(key, seen, `${name} 与 ${other} 撞键`);
    keys.set(name, key);
  }
  assert.equal(jobs.canonicalJson([-0, 0]), '[-0,0]');
  assert.ok(Object.is(JSON.parse(jobs.canonicalJson(-0)), -0), '规范化 JSON 读回还是 -0');
  // 片级输入归在第 1 项里，不多出第七项
  const withFilm = jobs.computeFrameCacheKey(makeBaseSpec({ film: { seed: 7 } }));
  assert.deepEqual(Object.keys(withFilm.components), ['shot', 'loadedFiles', 'tracks', 'cards', 'runtimeEnv', 'renderSpec']);
  assert.notEqual(withFilm.components.shot, jobs.computeFrameCacheKey(makeBaseSpec()).components.shot);
});

test('A16-12 S1 关掉自动重渲：报不过之后原样重试，混轮帧不被洗白', async (t) => {
  const cache = jobs.openShotCache(tmpDir(t));
  const shots = toleranceShots();
  await assert.rejects(jobs.renderShotsWithCache({ shots, cache, renderFrame: drifting(0.2, { failAt: 2 }) }));
  const second = await jobs.renderShotsWithCache({ shots, cache, renderFrame: drifting(0.65), rerenderOnSeamSpike: false });
  assert.equal(second.ok, false);

  const retry = drifting(0.9);
  const third = await jobs.renderShotsWithCache({ shots, cache, renderFrame: retry, rerenderOnSeamSpike: false });
  assert.equal(retry.calls, 0, '四帧都在缓存里');
  assert.equal(third.ok, false, '两轮的帧还混在一起，整镜命中也要查');
  assert.equal(third.shots[0].seamCheck.checked, true);
  assert.deepEqual(third.shots[0].seamCheck.spikes.map((s) => s.frame), [2]);

  const heal = drifting(0.9);
  const fourth = await jobs.renderShotsWithCache({ shots, cache, renderFrame: heal });
  assert.equal(heal.calls, 4);
  assert.equal(fourth.ok, true);
  assert.deepEqual(basesOf(cache, fourth), [0.9, 0.9, 0.9, 0.9]);
});

test('A16-13 S2 自动重渲到一半崩溃：旧帧先失效，重试后不交付混轮帧', async (t) => {
  const cache = jobs.openShotCache(tmpDir(t));
  const shots = toleranceShots();
  await assert.rejects(jobs.renderShotsWithCache({ shots, cache, renderFrame: drifting(0.2, { failAt: 2 }) }));
  // 第二轮补渲后两帧、检出尖峰、重渲第 0 帧成功，重渲第 1 帧时被强杀
  await assert.rejects(jobs.renderShotsWithCache({ shots, cache, renderFrame: drifting(0.65, { failAt: 1 }) }), /渲染中断/);
  for (const frame of [1, 2, 3]) {
    assert.equal(cache.get(entryOf(shots[0], frame)), undefined, `重渲中断时，第 ${frame} 帧必须已失效`);
  }

  const retry = drifting(0.9);
  const third = await jobs.renderShotsWithCache({ shots, cache, renderFrame: retry });
  assert.equal(third.ok, true);
  assert.equal(third.shots[0].seamCheck.checked, true);
  assert.deepEqual(basesOf(cache, third), [0.9, 0.9, 0.9, 0.9]);
  assert.equal(new Set(third.shots[0].frames.map((f) => f.runId)).size, 1, '整镜出自同一轮');
});

test('A16-14 S3 连续两次中断后补渲：两轮旧帧之间的跳变也算交界', async (t) => {
  const cache = jobs.openShotCache(tmpDir(t));
  const shots = toleranceShots();
  await assert.rejects(jobs.renderShotsWithCache({ shots, cache, renderFrame: drifting(0.2, { failAt: 2 }) }));
  await assert.rejects(jobs.renderShotsWithCache({ shots, cache, renderFrame: drifting(0.65, { failAt: 3 }) }));

  const strict = await jobs.renderShotsWithCache({ shots, cache, renderFrame: drifting(0.65), rerenderOnSeamSpike: false });
  assert.equal(strict.ok, false);
  assert.deepEqual(strict.shots[0].seamCheck.spikes.map((s) => s.frame), [2]);
  assert.deepEqual([strict.shots[0].renderedFrames, strict.shots[0].cachedFrames], [1, 3]);

  const heal = drifting(0.65);
  const healed = await jobs.renderShotsWithCache({ shots, cache, renderFrame: heal });
  assert.equal(heal.calls, 4, '四帧分属三轮，全部换成这一轮');
  assert.equal(healed.shots[0].seamCheck.rerendered, true);
  assert.deepEqual(basesOf(cache, healed), [0.65, 0.65, 0.65, 0.65]);
});

test('A16-15 文件头校验和：meta、seam、runId 被改都算坏条目，删掉后只重渲这一帧，不卡死重试', async (t) => {
  const dir = tmpDir(t);
  const cache = jobs.openShotCache(dir);
  const entry = jobs.computeFrameCacheKey(makeBaseSpec());
  const colorBytes = Buffer.from([1, 2, 3]);
  const tamper = (file, change) => {
    const raw = fs.readFileSync(file);
    const split = raw.indexOf(0x0a);
    const header = JSON.parse(raw.subarray(0, split).toString('utf8'));
    change(header);
    fs.writeFileSync(file, Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), raw.subarray(split + 1)]));
  };
  const changes = [
    (h) => { h.meta = { frame: 7, val: 0.9 }; },
    (h) => { h.seam = [0.1, 0.9]; },
    (h) => { h.seam = 'abc'; },
    (h) => { h.runId = 'forged'; },
    (h) => { delete h.headerSha256; },
  ];
  for (const change of changes) {
    const written = cache.put(entry, { colorBytes, meta: { val: 0.2 }, seam: [0.2, 0.2], runId: 'run-1' });
    assert.equal(written.colorSha256, sha256(colorBytes));
    assert.deepEqual(cache.get(entry).seam, [0.2, 0.2]);
    assert.equal(cache.get(entry).runId, 'run-1');
    const [file] = frameFiles(dir);
    tamper(file, change);
    assert.equal(cache.get(entry), undefined);
    assert.equal(fs.existsSync(file), false, '坏条目要清掉');
  }
  assert.throws(() => cache.put(entry, { colorBytes, seam: 'abc' }));
  assert.throws(() => cache.put(entry, { colorBytes, seam: [Number.NaN] }));
  assert.throws(() => cache.put(entry, { colorBytes, runId: '' }));

  // 容差档镜头里一帧的 seam 被改成字符串：这一帧按未命中重渲，作业不抛 TypeError
  const shots = toleranceShots();
  const store = jobs.openShotCache(tmpDir(t));
  await jobs.renderShotsWithCache({ shots, cache: store, renderFrame: drifting(0.2) });
  tamper(frameFiles(store.root).find((file) => path.basename(file) === `${entryOf(shots[0], 2).key.slice(7)}.frame`), (h) => { h.seam = 'abc'; });
  const again = drifting(0.2);
  const rerun = await jobs.renderShotsWithCache({ shots, cache: store, renderFrame: again });
  assert.equal(again.calls, 1);
  assert.deepEqual(rerun.shots[0].frames.map((f) => f.fromCache), [true, true, false, true]);
  assert.equal(rerun.ok, true);
});

test('A16-16 返回的帧记录带本轮验过的 colorSha256；命中帧的 frame、film、timing 按这一轮刷新', async (t) => {
  const cache = jobs.openShotCache(tmpDir(t));
  const shotsAt = (start) => [{ shot: { id: 's01', in: start, out: start + 3, source: 'three', seed: 1 }, determinism: 'hash-same-machine',
    loadedFiles: [], tracksHash: 'none', cards: [], runtimeEnv: ENV, tier: 'final', samples: 1, size: [2, 2], subs: [0] }];
  const renderFrame = async ({ shot, frame }) => ({ colorBytes: Buffer.from([frame + 1]),
    meta: { film: 'film-a', shot: shot.id, frame: shot.in + frame, shotFrame: frame, timing: { stateMs: 1, renderMs: 5, readbackMs: 2 } } });

  const first = await jobs.renderShotsWithCache({ shots: shotsAt(0), cache, renderFrame, filmId: 'film-a' });
  assert.deepEqual(first.shots[0].frames.map((f) => f.colorSha256), [1, 2, 3].map((v) => sha256(Buffer.from([v]))));
  assert.deepEqual(first.shots[0].frames[2].meta, { film: 'film-a', shot: 's01', frame: 2, shotFrame: 2, timing: { stateMs: 1, renderMs: 5, readbackMs: 2 } });

  // 前面的镜头改长，这个镜头整体后移 10 帧，又是另一部片子在用：照样命中，但元数据不能还是上一轮的
  const second = await jobs.renderShotsWithCache({ shots: shotsAt(10), cache, renderFrame, filmId: 'film-b' });
  assert.equal(second.totalRenderedFrames, 0);
  const idle = { stateMs: 0, renderMs: 0, readbackMs: 0 };
  assert.deepEqual(second.shots[0].frames.map((f) => f.meta), [0, 1, 2].map((f) => ({ film: 'film-b', shot: 's01', frame: 10 + f, shotFrame: f, timing: idle })));
  assert.deepEqual(second.shots[0].frames.map((f) => f.colorSha256), first.shots[0].frames.map((f) => f.colorSha256));
  assert.equal(new Set([...first.shots[0].frames, ...second.shots[0].frames].map((f) => f.runId)).size, 1, '命中的帧保留原来那一轮的 runId');

  // 并发的另一个作业把同一个键写成了别的内容：按返回的 colorSha256 比得出来
  const [frame] = second.shots[0].frames;
  cache.put(frame.entry, { colorBytes: Buffer.from([99]), meta: {} });
  assert.notEqual(cache.get(frame.entry).colorSha256, frame.colorSha256);
});

test('A16-17 缓存目录本身是符号链接不认；缓存里的符号链接拆掉不跟（M30）；占位的坏目录按未命中清掉', { skip: process.platform === 'win32' }, (t) => {
  const outside = tmpDir(t);
  const link = path.join(tmpDir(t), 'cache');
  fs.symlinkSync(outside, link, 'dir');
  assert.throws(() => jobs.openShotCache(link), /符号链接/);

  const dir = tmpDir(t);
  const cache = jobs.openShotCache(dir);
  const entry = jobs.computeFrameCacheKey(makeBaseSpec());
  fs.symlinkSync(outside, path.join(dir, 'final'), 'dir');
  cache.put(entry, { colorBytes: Buffer.from([1]), meta: {} });
  assert.deepEqual(fs.readdirSync(outside), [], '不跟着符号链接写到缓存外');
  assert.equal(fs.lstatSync(path.join(dir, 'final')).isSymbolicLink(), false);
  assert.deepEqual([...cache.get(entry).colorBytes], [1]);

  const [file] = frameFiles(dir);
  fs.rmSync(file);
  fs.symlinkSync(path.join(outside, 'planted.frame'), file);
  assert.equal(cache.get(entry), undefined);
  fs.mkdirSync(path.join(file, 'junk'), { recursive: true });
  assert.equal(cache.get(entry), undefined);
  cache.put(entry, { colorBytes: Buffer.from([2]), meta: {} });
  assert.deepEqual([...cache.get(entry).colorBytes], [2]);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('A16-18 prune 不动刚建的在途暂存目录，只清放久了的', (t) => {
  const dir = tmpDir(t);
  const cache = jobs.openShotCache(dir);
  const [fresh, old] = ['.write-fresh', '.write-old'].map((name) => path.join(dir, name));
  fs.mkdirSync(fresh);
  fs.mkdirSync(old);
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(old, hourAgo, hourAgo);
  cache.prune({ maxAgeMs: 0, now: Date.now() + 1000 });
  assert.equal(fs.existsSync(fresh), true, '别的进程正在写的暂存目录不能删');
  assert.equal(fs.existsSync(old), false);
});

test('A16-19 接缝判定的口径：基准不含交界帧差（M24），字节帧按 1/255 归一（M35），按 runId 分轮', async (t) => {
  const mk = (val, fromCache) => ({ fromCache, colorFloats: new Float32Array(16).fill(val) });
  // 只有一个非交界帧差 0.01：把交界帧差 0.44 也算进基准，阈值会被抬到 0.675 而放行
  const three = jobs.checkCacheSeams([mk(0.2, true), mk(0.64, false), mk(0.65, false)], { determinism: 'tolerance' });
  assert.deepEqual(three.spikes.map((s) => s.frame), [1]);
  assert.ok(Math.abs(three.spikes[0].baseline - 0.01) < 1e-6);

  const bytes = (values) => values.map((v, i) => ({ fromCache: i < 2, colorFloats: new Uint8Array(16).fill(v) }));
  const spiked = jobs.checkCacheSeams(bytes([50, 52, 160, 162]), { determinism: 'tolerance' });
  assert.ok(Math.abs(spiked.spikes[0].diff - 108 / 255) < 1e-9);
  // 交界只差 2 个码值（2/255 < 0.015）：不归一就会被当成尖峰
  assert.deepEqual(jobs.checkCacheSeams(bytes([50, 50, 52, 52]), { determinism: 'tolerance' }), { ok: true, checked: true, spikes: [] });

  // 带 runId 的帧按轮次判交界：都是命中（fromCache 全为 true）也查得出
  const runs = ['r1', 'r1', 'r2', 'r2'].map((runId, i) => ({ runId, fromCache: true, colorFloats: new Float32Array(16).fill(i < 2 ? 0.2 : 0.65) }));
  assert.deepEqual(jobs.checkCacheSeams(runs, { determinism: 'tolerance' }).spikes.map((s) => s.frame), [2]);
  assert.throws(() => jobs.checkCacheSeams([{ colorFloats: new Float32Array(4) }], { determinism: 'tolerance' }), /runId|fromCache/);

  // 出片编排里字节帧的接缝特征同样归一
  const cache = jobs.openShotCache(tmpDir(t));
  const byteFrames = (base, failAt) => async ({ frame, size }) => {
    if (frame === failAt) throw new Error('渲染中断');
    const color = new Uint8Array(size[0] * size[1] * 4).fill(base);
    return { colorBytes: Buffer.from(color), colorFloats: color, meta: {} };
  };
  await assert.rejects(jobs.renderShotsWithCache({ shots: toleranceShots(), cache, renderFrame: byteFrames(50, 2) }));
  const run = await jobs.renderShotsWithCache({ shots: toleranceShots(), cache, renderFrame: byteFrames(52) });
  assert.deepEqual(run.shots[0].seamCheck, { ok: true, checked: true, spikes: [] });
  assert.deepEqual([run.shots[0].renderedFrames, run.shots[0].cachedFrames], [2, 2]);
});

test('A16-20 镜头 id 重复直接拒绝（M33）；取消信号在每帧渲染前生效（M29）', async (t) => {
  const cache = jobs.openShotCache(tmpDir(t));
  await assert.rejects(jobs.renderShotsWithCache({ shots: [...toleranceShots(), ...toleranceShots()], cache, renderFrame: drifting(0.2) }), /重复/);

  const before = drifting(0.2);
  await assert.rejects(jobs.renderShotsWithCache({ shots: toleranceShots(), cache, renderFrame: before, signal: AbortSignal.abort(new Error('作业已取消')) }), /作业已取消/);
  assert.equal(before.calls, 0);

  const controller = new AbortController();
  const inner = drifting(0.2);
  const renderFrame = async (request) => {
    if (request.frame === 1) controller.abort(new Error('看门狗取消'));
    return inner(request);
  };
  await assert.rejects(jobs.renderShotsWithCache({ shots: toleranceShots(), cache, renderFrame, signal: controller.signal }), /看门狗取消/);
  assert.equal(inner.calls, 2, '第 1 帧渲完后取消，第 2 帧不再开始');
});

test('A16-21 工作区中未加载文件改变，缓存仍然全命中；已加载文件改变则重渲', async (t) => {
  const dir = tmpDir(t);
  const loaded = path.join(dir, 'scene.json');
  const unused = path.join(dir, 'unused.json');
  fs.writeFileSync(loaded, '1');
  fs.writeFileSync(unused, '1');
  const cache = jobs.openShotCache(path.join(dir, 'cache'));
  const run = () => jobs.renderShotsWithCache({ cache,
    shots: toleranceShots().map(s => ({ ...s, loadedFiles: [{ path: 'scene.json', sha256: sha256(fs.readFileSync(loaded)) }] })),
    renderFrame: drifting(Number(fs.readFileSync(loaded, 'utf8'))) });
  assert.equal((await run()).totalRenderedFrames, 4);
  fs.writeFileSync(unused, '2');
  assert.equal((await run()).totalRenderedFrames, 0);
  fs.writeFileSync(loaded, '2');
  assert.equal((await run()).totalRenderedFrames, 4);
});

test('A16-22 接缝采样包含非有限值时，混轮帧不能靠填零通过', async (t) => {
  const cache = jobs.openShotCache(tmpDir(t));
  const shots = toleranceShots();
  async function renderFrame({ frame }) {
    if (frame === 2) throw Error('渲染中断');
    return { colorBytes: Buffer.from([1]), colorFloats: new Float32Array([NaN]) };
  }
  await assert.rejects(jobs.renderShotsWithCache({ shots, cache, renderFrame }), /渲染中断/);
  const run = await jobs.renderShotsWithCache({ shots, cache, rerenderOnSeamSpike: false,
    renderFrame: () => ({ colorBytes: Buffer.from([2]), colorFloats: new Float32Array([0]) }) });
  assert.equal(run.ok, false);
});

test('A16-23 sub 集合换序后暖命中与独立冷渲的字节摘要必须相同', async (t) => {
  const cache = jobs.openShotCache(tmpDir(t));
  const run = (cache, subs) => jobs.renderShotsWithCache({ cache, shots: toleranceShots().map(s => ({ ...s, subs })),
    renderFrame: ({ subs }) => ({ colorBytes: Buffer.from(subs.map(x => 100 * x)) }) });
  await run(cache, [0, 0.5]);
  const warm = await run(cache, [0.5, 0]);
  const cold = await run(jobs.openShotCache(tmpDir(t)), [0.5, 0]);
  assert.equal(warm.totalRenderedFrames, 0);
  assert.equal(warm.shots[0].frames[0].colorSha256, cold.shots[0].frames[0].colorSha256);
});

test('A16-24 清理旧版本时中断，重开缓存不能看见部分旧帧', async (t) => {
  const dir = tmpDir(t);
  const cache = jobs.openShotCache(dir);
  const shots = toleranceShots();
  await assert.rejects(jobs.renderShotsWithCache({ shots, cache, renderFrame: drifting(0.2, { failAt: 2 }) }));
  assert.equal((await jobs.renderShotsWithCache({ shots, cache, renderFrame: drifting(0.65), rerenderOnSeamSpike: false })).ok, false);
  const remove = fs.rmSync;
  const cleanup = t.mock.method(fs, 'rmSync', (...args) => { remove(...args); throw Error('清理中断'); });
  try {
    await assert.rejects(jobs.renderShotsWithCache({ shots, cache, renderFrame: drifting(0.65) }), /清理中断/);
  } finally {
    cleanup.mock.restore();
  }
  const retry = await jobs.renderShotsWithCache({ shots, cache: jobs.openShotCache(dir), renderFrame: drifting(0.65) });
  assert.equal(retry.totalCachedFrames, 0);
  assert.equal(retry.totalRenderedFrames, 4);
});

test('A16-25 两个终稿版本最近使用时间相同也只留一版', (t) => {
  const dir = tmpDir(t);
  const cache = jobs.openShotCache(dir);
  const now = Date.now();
  for (const seed of [1, 2]) {
    const spec = makeBaseSpec();
    spec.shot.seed = seed;
    cache.put(jobs.computeFrameCacheKey(spec), { colorBytes: Buffer.from([seed]) });
  }
  for (const file of frameFiles(dir)) fs.utimesSync(file, new Date(now), new Date(now));
  assert.equal(cache.prune({ now }).removed, 1);
  assert.equal(frameFiles(dir).length, 1);
});

test('A16-26 写帧与整镜失效重叠时重新建目录并原子发布', (t) => {
  const cache = jobs.openShotCache(tmpDir(t));
  const entry = jobs.computeFrameCacheKey(makeBaseSpec());
  const rename = fs.renameSync;
  let retire = true;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (retire && target.endsWith('.frame')) {
      retire = false;
      cache.invalidateShot(entry);
    }
    return rename(source, target);
  });
  cache.put(entry, { colorBytes: Buffer.from([8]) });
  assert.deepEqual([...cache.get(entry).colorBytes], [8]);
});

test('A16-27 Windows NTFS 并发覆盖/读取同一 .frame 偶发 EPERM/EACCES/EBUSY 共享冲突时有限重试成功，永久权限错误仍抛出', (t) => {
  const cache = jobs.openShotCache(tmpDir(t));
  const entry = jobs.computeFrameCacheKey(makeBaseSpec());
  cache.put(entry, { colorBytes: Buffer.from([1, 2, 3]) });

  const realRename = fs.renameSync;
  let renameFails = 3;
  const renameMock = t.mock.method(fs, 'renameSync', (source, target) => {
    if (renameFails > 0 && target.endsWith('.frame')) {
      renameFails -= 1;
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM', syscall: 'rename' });
    }
    return realRename(source, target);
  });
  cache.put(entry, { colorBytes: Buffer.from([4, 5, 6]) });
  renameMock.mock.restore();

  const realRead = fs.readFileSync;
  let readFails = 2;
  const readMock = t.mock.method(fs, 'readFileSync', (file, ...rest) => {
    if (readFails > 0 && typeof file === 'string' && file.endsWith('.frame')) {
      readFails -= 1;
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY', syscall: 'open' });
    }
    return realRead(file, ...rest);
  });
  assert.deepEqual([...cache.get(entry).colorBytes], [4, 5, 6]);
  readMock.mock.restore();

  const permFail = t.mock.method(fs, 'renameSync', (source, target) => {
    if (target.endsWith('.frame')) {
      throw Object.assign(new Error('EPERM: permanent lock'), { code: 'EPERM', syscall: 'rename' });
    }
    return realRename(source, target);
  });
  try {
    assert.throws(() => cache.put(entry, { colorBytes: Buffer.from([9]) }), { code: 'EPERM' });
    // 父目录不可写是永久错误：原错误当场抛出，一次都不重试
    const before = permFail.mock.callCount();
    t.mock.method(fs, 'accessSync', () => { throw Object.assign(new Error('EACCES: access'), { code: 'EACCES' }); });
    assert.throws(() => cache.put(entry, { colorBytes: Buffer.from([9]) }), { code: 'EPERM', message: /permanent lock/ });
    assert.equal(permFail.mock.callCount() - before, 1);
  } finally {
    t.mock.restoreAll();
  }
  assert.deepEqual([...cache.get(entry).colorBytes], [4, 5, 6], '失败的覆盖不动旧帧');
  assert.deepEqual(fs.readdirSync(cache.root).filter((name) => name.startsWith('.')), [], '不留暂存目录');
});

test('A16-28 G_REV-R3 清理重试不误删等待期间发布的新帧，坏帧与空目录清理及 invalidateShot 在 EACCES/EBUSY 下可恢复且有真实退避', async (t) => {
  const cache = jobs.openShotCache(tmpDir(t));
  const dir = cache.root; // 用缓存自己解析后的根，注入点才能按完整路径对上
  const entry = jobs.computeFrameCacheKey(makeBaseSpec());
  const now = Date.now();
  const age = () => { for (const file of frameFiles(dir)) fs.utimesSync(file, new Date(now - 7200_000), new Date(now - 7200_000)); };
  const waits = t.mock.method(Atomics, 'wait'); // 只旁听，等待照常发生
  // 让 fs[method] 对命中的路径依次抛 codes 里的共享冲突；during 模拟退避期间别的进程做的事
  let injected = 0;
  const conflict = (method, hit, codes, during) => {
    const real = fs[method];
    const left = [...codes];
    return t.mock.method(fs, method, (target, ...rest) => {
      if (left.length && hit(String(target))) {
        const code = left.shift();
        injected += 1;
        during?.();
        throw Object.assign(new Error(`${code}: sharing violation`), { code });
      }
      return real(target, ...rest);
    });
  };
  const isFrame = (target) => target.endsWith('.frame');

  // 1) prune 删过期帧首次遇 EBUSY，退避期间另一进程在同一键发布了新帧：重试不得删掉新帧
  cache.put(entry, { colorBytes: Buffer.from([1]) });
  age();
  let mock = conflict('unlinkSync', isFrame, ['EBUSY'], () => cache.put(entry, { colorBytes: Buffer.from([99]) }));
  assert.equal(cache.prune({ maxAgeMs: 3600_000, now }).removed, 0, '已被新发布覆盖的条目不计删除');
  mock.mock.restore();
  assert.deepEqual([...cache.get(entry).colorBytes], [99], '等待期间新发布的帧必须保留');

  // 2) 没被替换的过期帧：删除连遇 2 次 EACCES、回收空版本目录遇 1 次 EBUSY，都当轮成功
  age();
  const versionDir = path.dirname(frameFiles(dir)[0]);
  mock = conflict('unlinkSync', isFrame, ['EACCES', 'EACCES']);
  const rmdir = conflict('rmdirSync', (target) => target === versionDir, ['EBUSY']);
  assert.equal(cache.prune({ maxAgeMs: 3600_000, now }).removed, 1);
  mock.mock.restore();
  rmdir.mock.restore();
  assert.equal(fs.existsSync(versionDir), false, '空版本目录要回收');

  // 3) 坏帧清理遇 1 次 EACCES 仍当轮清掉并只补渲这一帧
  let calls = 0;
  const shots = [{ shot: makeBaseSpec().shot, determinism: 'hash-same-machine', loadedFiles: [], tracksHash: 'none', cards: [], runtimeEnv: ENV, tier: 'final', samples: 1, size: [2, 2], subs: [0] }];
  const renderFrame = async ({ frame }) => { calls += 1; return { colorBytes: Buffer.from([frame + 1]), meta: {} }; };
  const first = await jobs.renderShotsWithCache({ shots, cache, renderFrame });
  const victim = frameFiles(dir).find((name) => fs.readFileSync(name).at(-1) === 3);
  fs.appendFileSync(victim, 'x');
  calls = 0;
  mock = conflict('unlinkSync', isFrame, ['EACCES']);
  const again = await jobs.renderShotsWithCache({ shots, cache, renderFrame });
  mock.mock.restore();
  assert.deepEqual([calls, again.totalRenderedFrames, again.totalCachedFrames], [1, 1, 3]);
  //    坏帧删除遇 EBUSY，退避期间被新的有效帧覆盖：新帧不被误删
  const bad = first.shots[0].frames[2].entry;
  fs.appendFileSync(victim, 'x');
  mock = conflict('unlinkSync', isFrame, ['EBUSY'], () => cache.put(bad, { colorBytes: Buffer.from([77]) }));
  assert.equal(cache.get(bad), undefined, '读到的是坏帧，本次算未命中');
  mock.mock.restore();
  assert.deepEqual([...cache.get(bad).colorBytes], [77], '等待期间发布的有效帧必须保留');

  // 4) invalidateShot 的改名连遇 2 次 EACCES 仍让旧版本失效
  mock = conflict('renameSync', (target) => target === path.dirname(victim), ['EACCES', 'EACCES']);
  cache.invalidateShot(bad);
  mock.mock.restore();
  assert.equal(cache.get(bad), undefined);
  assert.deepEqual(frameFiles(dir), []);

  // 5) 每次冲突之后都真的退避等待过，不是空转重试
  assert.equal(injected, 8);
  assert.ok(waits.mock.callCount() >= injected, `退避次数 ${waits.mock.callCount()} 少于冲突次数 ${injected}`);
  assert.ok(waits.mock.calls.every((call) => call.arguments[3] >= 2), '每次退避至少等 2 ms');
});

test('A16-29 G_REV-R4 最终身份检查之后至 unlink 之前的窗口内同键发布受文件锁互斥保护，且 get 初始 lstatSync 遇 EBUSY 可重试', async (t) => {
  const dir = tmpDir(t);
  const cache = jobs.openShotCache(dir);
  const entry = jobs.computeFrameCacheKey(makeBaseSpec());
  const now = Date.now();
  cache.put(entry, { colorBytes: Buffer.from([1]) });
  for (const file of frameFiles(dir)) fs.utimesSync(file, new Date(now - 7200_000), new Date(now - 7200_000));

  // 1) get 初始 bigint lstatSync 单独遇一次 EBUSY：自动退避重试成功，不直接崩
  const realLstat = fs.lstatSync;
  let lstatBusy = true;
  const lstatOnce = t.mock.method(fs, 'lstatSync', (target, opts) => {
    if (lstatBusy && opts?.bigint && typeof target === 'string' && target.endsWith('.frame')) {
      lstatBusy = false;
      throw Object.assign(new Error('EBUSY: lstat'), { code: 'EBUSY', syscall: 'lstat' });
    }
    return realLstat(target, opts);
  });
  assert.deepEqual([...cache.get(entry).colorBytes], [1]);
  lstatOnce.mock.restore();
  for (const file of frameFiles(dir)) fs.utimesSync(file, new Date(now - 7200_000), new Date(now - 7200_000));

  // 2) prune 首次 unlink 遇 EBUSY，第 2 次重试已完成最终身份检查返回旧快照之后、调 unlinkSync 之前发布新帧：新帧不得丢失
  //    发布改名与删除的那一刻跨进程文件锁必须在场：身份检查到 unlink 的窗口由它对别的进程互斥
  const realUnlink = fs.unlinkSync;
  const realRename = fs.renameSync;
  const lockHeld = [];
  const sawLock = (target) => { if (String(target).endsWith('.frame')) lockHeld.push(fs.existsSync(path.join(cache.root, '.cache.lock'))); };
  const renameSpy = t.mock.method(fs, 'renameSync', (source, target) => { sawLock(target); return realRename(source, target); });
  let step = 0;
  const unlinkMock = t.mock.method(fs, 'unlinkSync', (target) => {
    sawLock(target);
    if (typeof target === 'string' && target.endsWith('.frame') && step === 0) {
      step = 1;
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY', syscall: 'unlink' });
    }
    return realUnlink(target);
  });
  const afterStamp = t.mock.method(fs, 'lstatSync', (target, opts) => {
    const res = realLstat(target, opts);
    if (step === 1 && opts?.bigint && typeof target === 'string' && target.endsWith('.frame')) {
      step = 2;
      cache.put(entry, { colorBytes: Buffer.from([77]) });
    }
    return res;
  });
  const pruned = cache.prune({ maxAgeMs: 3600_000, now });
  unlinkMock.mock.restore();
  afterStamp.mock.restore();
  assert.equal(pruned.removed, 0, '最终身份检查后被新帧替换的条目不得计入 removed');
  assert.deepEqual([...cache.get(entry).colorBytes], [77], '最终身份检查后发布的新帧必须保留');

  // 3) 跨进程实测：写子进程反复「发布旧帧并做旧 → 发布新帧 [77] → 读回」，父进程同时连续 prune 与 get。
  //    只有做旧的帧可以被清掉；新帧一旦被误删，子进程读不回就以 3 退出。
  const keeper = jobs.computeFrameCacheKey(makeBaseSpec({ renderSpec: { ...makeBaseSpec().renderSpec, frame: 1 } }));
  cache.put(keeper, { colorBytes: Buffer.from([5]) }); // 同版本留一帧新的，版本目录不会被回收，子进程不必处理目录消失
  renameSpy.mock.restore();
  assert.deepEqual(lockHeld, [true, true, true], '首次 unlink、重入发布与独立发布都要在 .cache.lock 之内');
  const stop = path.join(tmpDir(t), 'stop');
  const script = `import fs from 'node:fs';
    import { computeFrameCacheKey, openShotCache } from ${JSON.stringify(api)};
    const cache = openShotCache(${JSON.stringify(dir)});
    const entry = computeFrameCacheKey(${JSON.stringify(makeBaseSpec())});
    const file = ${JSON.stringify(frameFiles(dir).find((name) => name.endsWith(`${entry.key.slice(7)}.frame`)))};
    const old = new Date(Date.now() - 7200_000);
    do {
      cache.put(entry, { colorBytes: Buffer.from([1]) });
      fs.utimesSync(file, old, old);
      cache.put(entry, { colorBytes: Buffer.from([77]) });
      if (cache.get(entry)?.colorBytes[0] !== 77) process.exit(3);
    } while (!fs.existsSync(${JSON.stringify(stop)}));`;
  const writer = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' });
  const exited = once(writer, 'exit');
  let removed = 0;
  let alive = true;
  writer.once('exit', () => { alive = false; });
  for (const deadline = Date.now() + 20_000; alive && removed < 20 && Date.now() < deadline;) {
    removed += cache.prune({ maxAgeMs: 3600_000 }).removed;
    cache.get(entry);
    await new Promise((resolve) => setImmediate(resolve));
  }
  fs.writeFileSync(stop, '');
  assert.equal((await exited)[0], 0, '写子进程刚发布的新帧被并发清理误删，或子进程出错');
  assert.ok(removed >= 20, `并发期间只清掉 ${removed} 个做旧帧，没有真正压到竞争窗口`);
  assert.deepEqual([...cache.get(entry).colorBytes], [77]);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('.')), [], '不留锁文件与暂存目录');
});

test('A16-30 G_REV-R5 只读目录有效帧遇 EBUSY/EPERM/EACCES 首次 stamp 冲突可退避读回，且任何无法持锁场景严禁无锁发布或删除', { skip: process.platform === 'win32' }, (t) => {
  const dir = tmpDir(t);
  const cache = jobs.openShotCache(dir);
  const entry = jobs.computeFrameCacheKey(makeBaseSpec());
  cache.put(entry, { colorBytes: Buffer.from([77]) });
  const [file] = frameFiles(dir);
  const versionDir = path.dirname(file);
  const shotDir = path.dirname(versionDir);
  const tierDir = path.dirname(shotDir);

  // 1) 真正只读目录（0555 根与子目录，0444 帧）叠加首次 bigint lstatSync 的 EBUSY / EPERM / EACCES 共享冲突：全部退避重试并在当次 get 读回 [77]
  fs.chmodSync(file, 0o444);
  for (const d of [versionDir, shotDir, tierDir, cache.root]) fs.chmodSync(d, 0o555);
  try {
    const realLstat = fs.lstatSync;
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      let onceBusy = true;
      const m = t.mock.method(fs, 'lstatSync', (target, opts) => {
        if (onceBusy && opts?.bigint && typeof target === 'string' && target.endsWith('.frame')) {
          onceBusy = false;
          throw Object.assign(new Error(`${code}: transient lstat sharing`), { code, syscall: 'lstat' });
        }
        return realLstat(target, opts);
      });
      assert.deepEqual([...cache.get(entry).colorBytes], [77], `只读目录下 ${code} 首次冲突应恢复`);
      m.mock.restore();
    }
  } finally {
    for (const d of [cache.root, tierDir, shotDir, versionDir]) fs.chmodSync(d, 0o755);
    fs.chmodSync(file, 0o644);
  }

  // 2) 锁根只读（0555）而叶目录可写（0755），且已有活进程锁：prune 与坏帧 get 严禁绕过锁进入 unlinkSync
  const now = Date.now();
  fs.utimesSync(file, new Date(now - 7200_000), new Date(now - 7200_000));
  fs.writeFileSync(path.join(cache.root, '.cache.lock'), `${process.pid}\n`);
  fs.chmodSync(cache.root, 0o555);
  let unlinkCalls = 0;
  const realUnlink = fs.unlinkSync;
  const unlinkSpy = t.mock.method(fs, 'unlinkSync', (target) => {
    if (String(target).endsWith('.frame')) unlinkCalls += 1;
    return realUnlink(target);
  });
  try {
    assert.throws(() => cache.prune({ maxAgeMs: 0, now, lockTimeoutMs: 30 }));
    assert.equal(unlinkCalls, 0, '未取得 .cache.lock 时绝不允许调用 unlinkSync');
    fs.appendFileSync(file, 'corrupt');
    assert.equal(cache.get(entry), undefined, '只读根下坏帧机会性清理拿不到锁应安全跳过并返回未命中');
    assert.equal(unlinkCalls, 0, '坏帧机会性清理未持锁时不得调用 unlinkSync');
  } finally {
    unlinkSpy.mock.restore();
    fs.chmodSync(cache.root, 0o755);
    fs.rmSync(path.join(cache.root, '.cache.lock'), { force: true });
  }
});

test('A16-31 G_REV-R6 held 仅在真实取得锁后置位、只读首次普通 lstat 冲突可恢复且坏帧遇 ENOSPC 返回未命中', { skip: process.platform === 'win32' }, (t) => {
  const dir = tmpDir(t);
  const cache = jobs.openShotCache(dir);
  const entry = jobs.computeFrameCacheKey(makeBaseSpec());
  cache.put(entry, { colorBytes: Buffer.from([77]) });
  const [file] = frameFiles(dir);
  const dirs = [path.dirname(file), path.dirname(path.dirname(file)), path.dirname(path.dirname(path.dirname(file))), cache.root];

  // 1) 只读目录下，帧路径的第一次 lstatSync（含不带 bigint 的路径检查）遇 EBUSY/EPERM/EACCES 都能退避并在本次 get 返回 [77]（绝不假未命中）
  fs.chmodSync(file, 0o444);
  for (const d of dirs) fs.chmodSync(d, 0o555);
  try {
    const realLstat = fs.lstatSync;
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      let onceBusy = true;
      const m = t.mock.method(fs, 'lstatSync', (target, opts) => {
        if (onceBusy && typeof target === 'string' && target.endsWith('.frame')) {
          onceBusy = false;
          throw Object.assign(new Error(`${code}: early frame lstat`), { code, syscall: 'lstat' });
        }
        return realLstat(target, opts);
      });
      assert.deepEqual([...cache.get(entry).colorBytes], [77], `只读目录下早期 lstat ${code} 必须重试恢复，不能变 undefined`);
      m.mock.restore();
    }
  } finally {
    for (const d of [...dirs].reverse()) fs.chmodSync(d, 0o755);
    fs.chmodSync(file, 0o644);
  }

  // 2) 等锁期间 state.held 必须仍为 false（未取得 .cache.lock 时重入绝不能直接放行修改！）
  fs.writeFileSync(path.join(cache.root, '.cache.lock'), `${process.pid}\n`);
  const realWait = Atomics.wait;
  let reentered = false;
  let reenterErr;
  const waitHook = t.mock.method(Atomics, 'wait', (...args) => {
    if (!reentered) {
      reentered = true;
      try {
        // 重入用带短超时的 prune：put 没有超时参数，等满默认 10 秒才报错
        cache.prune({ maxAgeMs: 0, now: Date.now() + 999999, lockTimeoutMs: 25 });
      } catch (err) {
        reenterErr = err;
      }
    }
    return realWait(...args);
  });
  try {
    assert.throws(() => cache.prune({ maxAgeMs: 0, now: Date.now() + 999999, lockTimeoutMs: 25 }), { code: 'ETIMEDOUT' });
    assert.equal(reenterErr?.code, 'ETIMEDOUT', '等锁期间重入的调用绝不能把 held 误判为已持锁而无锁删除');
    assert.deepEqual([...cache.get(entry).colorBytes], [77]);
  } finally {
    waitHook.mock.restore();
    fs.rmSync(path.join(cache.root, '.cache.lock'), { force: true });
  }

  // 3) 坏帧机会性清理在创建锁暂存目录遇 ENOSPC 时保留坏帧并返回 undefined
  fs.appendFileSync(file, 'corrupt');
  const realMkdtemp = fs.mkdtempSync;
  const noSpace = t.mock.method(fs, 'mkdtempSync', (...args) => {
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  });
  try {
    assert.equal(cache.get(entry), undefined);
    assert.equal(fs.existsSync(file), true);
  } finally {
    noSpace.mock.restore();
  }
});

test('A16-32 G_REV-R6 大小写不敏感的卷上同一缓存根的不同写法共用持锁状态，临界区里重入不自己等自己', (t) => {
  const cache = jobs.openShotCache(path.join(tmpDir(t), 'cache'));
  const aliasDir = path.join(path.dirname(cache.root), 'CACHE');
  if (!fs.existsSync(aliasDir)) return t.skip('大小写敏感的卷上没有别名写法');
  const alias = jobs.openShotCache(aliasDir);
  const old = jobs.computeFrameCacheKey(makeBaseSpec({ shot: { ...makeBaseSpec().shot, id: 's02' } }));
  const fresh = jobs.computeFrameCacheKey(makeBaseSpec());
  cache.put(old, { colorBytes: Buffer.from([1]) });

  // cache 句柄发布改名的那一刻正持着 .cache.lock：别名句柄此时清理，必须认出是同一个根直接执行，而不是去等自己进程的锁
  const realRename = fs.renameSync;
  let inner;
  const hook = t.mock.method(fs, 'renameSync', (source, target) => {
    if (!inner && String(target).endsWith('.frame')) {
      try {
        inner = alias.prune({ maxAgeMs: 0, now: Date.now() + 1000, lockTimeoutMs: 25 });
      } catch (error) {
        inner = error;
      }
    }
    return realRename(source, target);
  });
  cache.put(fresh, { colorBytes: Buffer.from([2]) });
  hook.mock.restore();
  assert.deepEqual(inner, { removed: 1 });
  assert.equal(alias.get(old), undefined);
  assert.deepEqual([...alias.get(fresh).colorBytes], [2]);
});
