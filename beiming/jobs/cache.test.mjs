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

// 建锁与原子写的暂存目录是 mkdirSync 建的 .write-<UUID>：只让它失败，别的建目录照常
function failStagingMkdir(t, error) {
  const real = fs.mkdirSync;
  return t.mock.method(fs, 'mkdirSync', (dir, ...rest) => {
    if (path.basename(String(dir)).startsWith('.write-')) throw error;
    return real(dir, ...rest);
  });
}

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
  const noSpace = failStagingMkdir(t, Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
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

test('A16-33 G_REV-R7 缓存根目录轮换重建后新旧句柄按当前物理根共享锁状态不自死锁，坏帧清理遇 UNKNOWN/EROFS 返回 undefined，且根 lstat 冲突可退避', (t) => {
  const base = tmpDir(t);
  const rootPath = path.join(base, 'cache');
  const oldHandle = jobs.openShotCache(rootPath);
  const entry1 = jobs.computeFrameCacheKey(makeBaseSpec());
  const entry2 = jobs.computeFrameCacheKey(makeBaseSpec({ shot: { ...makeBaseSpec().shot, id: 's02' } }));
  oldHandle.put(entry1, { colorBytes: Buffer.from([1]) });

  // 1) 将原根改名并在原路径重建新根：旧句柄与新打开句柄在发布临界区同步重入 prune 时按当前物理根共享状态，绝不 ETIMEDOUT
  fs.renameSync(rootPath, path.join(base, 'cache-retired'));
  fs.mkdirSync(rootPath);
  const newHandle = jobs.openShotCache(rootPath);
  newHandle.put(entry2, { colorBytes: Buffer.from([77]) });
  const realRename = fs.renameSync;
  let inner;
  const hook = t.mock.method(fs, 'renameSync', (source, target) => {
    if (!inner && String(target).endsWith('.frame')) {
      inner = newHandle.prune({ maxAgeMs: 0, now: Date.now() + 5000, lockTimeoutMs: 30 });
    }
    return realRename(source, target);
  });
  oldHandle.put(entry1, { colorBytes: Buffer.from([93]) });
  hook.mock.restore();
  assert.deepEqual(inner, { removed: 1 });
  assert.deepEqual([...newHandle.get(entry1).colorBytes], [93]);

  // 2) 坏帧机会性清理遇 Windows libuv UNKNOWN (errno=-4094) 或 EROFS/EMFILE 时保留坏帧并返回 undefined
  const [file] = frameFiles(rootPath);
  fs.appendFileSync(file, 'corrupt');
  for (const code of ['UNKNOWN', 'EROFS', 'EMFILE']) {
    const m = failStagingMkdir(t, Object.assign(new Error(`${code}: fs error`), { code, errno: code === 'UNKNOWN' ? -4094 : -1, syscall: 'mkdir' }));
    assert.equal(newHandle.get(entry1), undefined, `坏帧清理遇 ${code} 必须返回 undefined`);
    assert.equal(fs.existsSync(file), true);
    m.mock.restore();
  }

  // 3) get 中 checkRoot 普通 lstatSync 遇一次 EBUSY 时纳入退避重试，不直接抛错
  newHandle.put(entry1, { colorBytes: Buffer.from([55]) });
  const realLstat = fs.lstatSync;
  let rootBusy = true;
  const rootLstat = t.mock.method(fs, 'lstatSync', (target, opts) => {
    if (rootBusy && !opts?.bigint && String(target) === newHandle.root) {
      rootBusy = false;
      throw Object.assign(new Error('EBUSY: root lstat'), { code: 'EBUSY', syscall: 'lstat' });
    }
    return realLstat(target, opts);
  });
  assert.deepEqual([...newHandle.get(entry1).colorBytes], [55]);
  rootLstat.mock.restore();

  // 4) 退避前的可读性探测（accessSync）自己撞上一次 EBUSY 也是瞬态冲突：接着退避，不把原错误当永久错误抛出
  const busy = syscall => Object.assign(new Error(`EBUSY: ${syscall}`), { code: 'EBUSY', syscall });
  const realRead = fs.readFileSync;
  const realAccess = fs.accessSync;
  let readBusy = true;
  let probeBusy = true;
  t.mock.method(fs, 'readFileSync', (target, opts) => {
    if (readBusy && String(target).endsWith('.frame')) {
      readBusy = false;
      throw busy('open');
    }
    return realRead(target, opts);
  });
  t.mock.method(fs, 'accessSync', (target, mode) => {
    if (probeBusy) {
      probeBusy = false;
      throw busy('access');
    }
    return realAccess(target, mode);
  });
  assert.deepEqual([...newHandle.get(entry1).colorBytes], [55]);
  assert.equal(probeBusy, false);
});

test('A16-34 八审收口：持锁发布后释放前轮换不留死锁与暂存（F1）、根取样带退避（F2）、ino=0n 区分不同根（F3）、ERR_* 参数错误不吞（F4/M7）及 M5/M6 断言', (t) => {
  const { openShotCache, computeFrameCacheKey } = jobs;
  const baseSpec = makeBaseSpec;
  const sampleMeta = {};
  const parent = tmpDir(t);

  // F1: 已取得锁并完成帧 renameSync，在释放锁与回收暂存之前把 root 改名为 rotated 并在原路径重建 root（且新 root 已有新锁）
  const root1 = path.join(parent, 'live');
  const rotated1 = path.join(parent, 'rotated');
  const c1 = openShotCache(root1);
  const entryA = computeFrameCacheKey(baseSpec());
  const realRename = fs.renameSync;
  let rotateInFlight = true;
  const renameHook = t.mock.method(fs, 'renameSync', (from, to) => {
    const res = realRename(from, to);
    if (rotateInFlight && String(to).endsWith('.frame')) {
      rotateInFlight = false;
      realRename(root1, rotated1);
      fs.mkdirSync(root1, { recursive: true });
      fs.writeFileSync(path.join(root1, '.cache.lock'), '999999\n');
    }
    return res;
  });
  c1.put(entryA, { colorBytes: Buffer.from([77]), meta: sampleMeta, runId: 'r-f1' });
  renameHook.mock.restore();
  // 新根的锁未被误删
  assert.equal(fs.existsSync(path.join(root1, '.cache.lock')), true);
  fs.rmSync(path.join(root1, '.cache.lock'), { force: true });
  // 旧根（rotated1）零残留 .cache.lock 与 .write-*，且可立即打开执行 prune 不超时
  const leftovers = fs.readdirSync(rotated1).filter(n => n === '.cache.lock' || n.startsWith('.write-'));
  assert.deepEqual(leftovers, []);
  const rotatedHandle = openShotCache(rotated1);
  assert.deepEqual([...rotatedHandle.get(entryA).colorBytes], [77]);
  assert.deepEqual(rotatedHandle.prune({ maxAgeMs: 86_400_000, lockTimeoutMs: 50 }), { removed: 0 });

  // F2: put 路径上每一处根身份取样（bigint lstat，含 currentState 的入口与持锁后两次）各遇一次 EBUSY/EPERM/EACCES 都退避重试、当轮发布成功
  const root2 = path.join(parent, 'f2');
  const c2 = openShotCache(root2);
  const realLstat = fs.lstatSync;
  let seqByte = 10;
  let sites = 0;
  for (let site = 1, fired = true; fired; site += 1) {
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      seqByte += 1;
      let seenRoot = 0;
      const m = t.mock.method(fs, 'lstatSync', (target, opts) => {
        if (opts?.bigint && String(target) === c2.root && (seenRoot += 1) === site) {
          throw Object.assign(new Error(`${code}: root stamp`), { code, syscall: 'lstat' });
        }
        return realLstat(target, opts);
      });
      c2.put(entryA, { colorBytes: Buffer.from([seqByte]), meta: sampleMeta, runId: `r-${site}-${code}` });
      m.mock.restore();
      assert.deepEqual([...c2.get(entryA).colorBytes], [seqByte]);
      fired = seenRoot >= site;
    }
    if (fired) sites = site;
  }
  assert.ok(sites >= 2, `currentState 的两次取样都要被打到，实际只有 ${sites} 处`);

  // F3: 同设备（非零 dev）但 ino=0n 的两个不同目录不得共用锁状态，第二根重入发布必须取得自己的 .cache.lock
  const root3A = path.join(parent, 'ino0-a');
  const root3B = path.join(parent, 'ino0-b');
  const c3A = openShotCache(root3A);
  const c3B = openShotCache(root3B);
  const real3A = fs.realpathSync.native(root3A);
  const real3B = fs.realpathSync.native(root3B);
  const inoMock = t.mock.method(fs, 'lstatSync', (target, opts) => {
    const st = realLstat(target, opts);
    const resolved = path.resolve(String(target));
    if (st && opts?.bigint && (resolved === real3A || resolved === real3B)) {
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: 0n });
    }
    return st;
  });
  let rootBLockObserved = false;
  const renameSpy = t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(to).startsWith(real3A) && String(to).endsWith('.frame')) {
      c3B.put(entryA, { colorBytes: Buffer.from([2]), meta: sampleMeta, runId: 'r-3b' });
    }
    if (String(to).startsWith(real3B) && String(to).endsWith('.frame')) {
      rootBLockObserved = fs.existsSync(path.join(real3B, '.cache.lock'));
    }
    return realRename(from, to);
  });
  c3A.put(entryA, { colorBytes: Buffer.from([1]), meta: sampleMeta, runId: 'r-3a' });
  renameSpy.mock.restore();
  inoMock.mock.restore();
  assert.equal(rootBLockObserved, true, 'ino=0n 时第二缓存根发布必须取得自己的 .cache.lock');

  // F4 & M7: 坏帧机会性清理遇到 Node 参数/编程错误（ERR_INVALID_ARG_TYPE 或无 code TypeError）必须原样抛出，不得吞成 undefined
  const root4 = path.join(parent, 'f4');
  const c4 = openShotCache(root4);
  c4.put(entryA, { colorBytes: Buffer.from([9]), meta: sampleMeta, runId: 'r-f4' });
  const badFramePath = path.join(
    fs.realpathSync.native(root4),
    entryA.tier,
    `shot-${entryA.shotId}`,
    entryA.shotKey.slice(7),
    `${entryA.key.slice(7)}.frame`
  );
  fs.writeFileSync(badFramePath, 'corrupted-header\nbytes');
  for (const bugErr of [
    Object.assign(new TypeError('The "prefix" argument must be of type string'), { code: 'ERR_INVALID_ARG_TYPE' }),
    new TypeError('plain bug without code'),
  ]) {
    const mkMock = failStagingMkdir(t, bugErr); // get 里只有建锁会建 .write- 暂存目录
    assert.throws(() => c4.get(entryA), err => err === bugErr);
    mkMock.mock.restore();
    assert.equal(fs.existsSync(badFramePath), true);
  }

  // M5: 只在等锁期间轮换重建根（入口取样时还是旧根）：拿到锁后按新根重认状态，临界区里别的句柄重入 prune 直接执行、不等自己的锁
  const root5 = path.join(parent, 'm5');
  const c5 = openShotCache(root5);
  const entryB = computeFrameCacheKey(baseSpec({ shot: { ...baseSpec().shot, id: 's02' } }));
  c5.put(entryB, { colorBytes: Buffer.from([4]), meta: sampleMeta, runId: 'r-m5-old' });
  fs.writeFileSync(path.join(c5.root, '.cache.lock'), `${process.pid}\n`); // 活进程占着锁，逼 put 进等锁循环
  const realExists = fs.existsSync;
  let lockProbes = 0;
  const existsHook = t.mock.method(fs, 'existsSync', (target) => {
    if (String(target).endsWith('.cache.lock') && (lockProbes += 1) === 2) {
      realRename(c5.root, path.join(parent, 'm5-retired'));
      fs.mkdirSync(c5.root);
      // 新根里放一帧旧的：重入的 prune 有东西可删才会真去拿锁
      fs.cpSync(path.join(parent, 'm5-retired', entryB.tier), path.join(c5.root, entryB.tier), { recursive: true });
    }
    return realExists(target);
  });
  let reentrant;
  const m5Rename = t.mock.method(fs, 'renameSync', (from, to) => {
    if (!reentrant && String(to).endsWith('.frame')) {
      try {
        reentrant = openShotCache(root5).prune({ maxAgeMs: 0, now: Date.now() + 5000, lockTimeoutMs: 30 });
      } catch (error) {
        reentrant = error;
      }
    }
    return realRename(from, to);
  });
  c5.put(entryA, { colorBytes: Buffer.from([5]), meta: sampleMeta, runId: 'r-m5' });
  m5Rename.mock.restore();
  existsHook.mock.restore();
  assert.ok(lockProbes >= 2, '轮换必须发生在等锁期间');
  assert.deepEqual(reentrant, { removed: 1 });
  assert.equal(c5.get(entryB), undefined);
  assert.deepEqual([...c5.get(entryA).colorBytes], [5]);
  assert.deepEqual(fs.readdirSync(path.join(parent, 'm5-retired')).filter(n => n.startsWith('.write-')), [], '旧根里的发布暂存目录要跟着回收');

  // M6: 写模式下 renameSync 遇一次 EBUSY 且 accessSync(W_OK) 也遇一次 EBUSY 时继续退避并当轮发布成功
  let writeRenameBusy = true;
  let writeAccessBusy = true;
  const realAccess = fs.accessSync;
  const mRen = t.mock.method(fs, 'renameSync', (from, to) => {
    if (writeRenameBusy && String(to).endsWith('.frame')) {
      writeRenameBusy = false;
      throw Object.assign(new Error('EBUSY: rename'), { code: 'EBUSY' });
    }
    return realRename(from, to);
  });
  const mAcc = t.mock.method(fs, 'accessSync', (target, mode) => {
    if (writeAccessBusy && mode === fs.constants.W_OK) {
      writeAccessBusy = false;
      throw Object.assign(new Error('EBUSY: access'), { code: 'EBUSY' });
    }
    return realAccess(target, mode);
  });
  c2.put(entryA, { colorBytes: Buffer.from([88]), meta: sampleMeta, runId: 'r-m6' });
  mRen.mock.restore();
  mAcc.mock.restore();
  assert.deepEqual([...c2.get(entryA).colorBytes], [88]);
});

test('A16-35 九审收口：建锁早期轮换回收（linkSync 即刻轮换）、ino=0n 锁凭据防误删新代、兄弟枚举 EBUSY 退避、区分大小写回退及 unlinkSync 异常传播', async (t) => {
  const { openShotCache, computeFrameCacheKey } = jobs;
  const baseSpec = makeBaseSpec;
  const sampleMeta = {};
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-a16-r9-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const entryA = computeFrameCacheKey(baseSpec());

  await t.test('1) 主锁 linkSync 刚返回即轮换目录并在新根预置存活锁：拒绝进入新代临界区（ETIMEDOUT）、旧根零残留、新根锁完整保留；无预置锁时重取新根锁后再进回调', (st) => {
    const root = path.join(parent, 'early-lock');
    const retired = path.join(parent, 'early-lock-old');
    const cache = openShotCache(root);
    cache.put(entryA, { colorBytes: Buffer.from([31]), meta: sampleMeta, runId: 'r-early' });
    const realLink = fs.linkSync;
    const realRename = fs.renameSync;
    const liveNewLock = `${process.pid} newgen-uuid\n`;
    let rotated = false;
    st.mock.method(fs, 'linkSync', (src, dst) => {
      const r = realLink(src, dst);
      if (!rotated && String(dst).endsWith('.cache.lock')) {
        rotated = true;
        realRename(cache.root, retired);
        fs.mkdirSync(cache.root, { recursive: true });
        fs.writeFileSync(path.join(cache.root, '.cache.lock'), liveNewLock);
      }
      return r;
    });
    assert.throws(
      () => cache.prune({ maxAgeMs: 0, now: Date.now() + 5000, lockTimeoutMs: 50 }),
      err => err?.code === 'ETIMEDOUT',
      '新根已被另一把存活锁保护时，建在旧根的锁不得放行进入新根临界区',
    );
    assert.equal(rotated, true);
    assert.equal(fs.readFileSync(path.join(cache.root, '.cache.lock'), 'utf8'), liveNewLock);
    fs.rmSync(path.join(cache.root, '.cache.lock'), { force: true });
    assert.deepEqual(fs.readdirSync(retired).filter(n => n === '.cache.lock' || n.startsWith('.write-')), []);

    // 若轮换后的新根没有别的锁，应当回收旧根锁并在新根重新持锁后正常完成
    const root2 = path.join(parent, 'early-lock-reacquire');
    const retired2 = path.join(parent, 'early-lock-reacquire-old');
    const cache2 = openShotCache(root2);
    cache2.put(entryA, { colorBytes: Buffer.from([32]), meta: sampleMeta, runId: 'r-early2' });
    let rotated2 = false;
    st.mock.restoreAll();
    st.mock.method(fs, 'linkSync', (src, dst) => {
      const r = realLink(src, dst);
      if (!rotated2 && String(dst) === path.join(cache2.root, '.cache.lock')) {
        rotated2 = true;
        realRename(cache2.root, retired2);
        fs.mkdirSync(cache2.root, { recursive: true });
      }
      return r;
    });
    assert.deepEqual(cache2.prune({ maxAgeMs: 0, now: Date.now() + 5000, lockTimeoutMs: 200 }), { removed: 0 });
    assert.equal(rotated2, true);
    assert.deepEqual(fs.readdirSync(retired2).filter(n => n === '.cache.lock' || n.startsWith('.write-')), []);
    assert.deepEqual(fs.readdirSync(cache2.root).filter(n => n === '.cache.lock' || n.startsWith('.write-')), []);
  });

  await t.test('2) 锁文件 ino=0n 且兄弟目录枚举单次报 EBUSY 时：按锁内唯一凭据精准回收旧代锁，绝不误删新根同名锁', (st) => {
    const root = path.join(parent, 'ino0-lock');
    const retired = path.join(parent, 'ino0-lock-old');
    const cache = openShotCache(root);
    const realLstat = fs.lstatSync;
    const realRename = fs.renameSync;
    const realReaddir = fs.readdirSync;
    st.mock.method(fs, 'lstatSync', (target, opts) => {
      const s = realLstat(target, opts);
      if (s && opts?.bigint && String(target).endsWith('.cache.lock')) {
        return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ino: 0n });
      }
      return s;
    });
    let readdirBusy = true;
    st.mock.method(fs, 'readdirSync', (dir, opts) => {
      if (readdirBusy && path.resolve(String(dir)) === fs.realpathSync.native(parent)) {
        readdirBusy = false;
        throw Object.assign(new Error('EBUSY: readdir'), { code: 'EBUSY' });
      }
      return realReaddir(dir, opts);
    });
    let flipped = false;
    st.mock.method(fs, 'renameSync', (from, to) => {
      const r = realRename(from, to);
      if (!flipped && String(to).endsWith('.frame')) {
        flipped = true;
        realRename(cache.root, retired);
        fs.mkdirSync(cache.root, { recursive: true });
        fs.writeFileSync(path.join(cache.root, '.cache.lock'), '888888 other\n');
      }
      return r;
    });
    cache.put(entryA, { colorBytes: Buffer.from([66]), meta: sampleMeta, runId: 'r-ino0' });
    assert.equal(readdirBusy, false);
    assert.equal(fs.readFileSync(path.join(cache.root, '.cache.lock'), 'utf8'), '888888 other\n');
    fs.rmSync(path.join(cache.root, '.cache.lock'), { force: true });
    assert.deepEqual(fs.readdirSync(retired).filter(n => n === '.cache.lock' || n.startsWith('.write-')), []);
  });

  await t.test('3) 删除阶段（unlinkSync）遇系统错误返回未命中，遇 ERR_INVALID_ARG_TYPE 或普通 TypeError 原样抛出', (st) => {
    const root = path.join(parent, 'unlink-err');
    const cache = openShotCache(root);
    cache.put(entryA, { colorBytes: Buffer.from([12]), meta: sampleMeta, runId: 'r-ul' });
    const badPath = path.join(cache.root, entryA.tier, `shot-${entryA.shotId}`, entryA.shotKey.slice(7), `${entryA.key.slice(7)}.frame`);
    fs.writeFileSync(badPath, 'broken\nbytes');
    const realUnlink = fs.unlinkSync;
    for (const sysErr of [
      Object.assign(new Error('UNKNOWN'), { code: 'UNKNOWN' }),
      Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }),
    ]) {
      const m = st.mock.method(fs, 'unlinkSync', (p) => {
        if (String(p).endsWith('.frame')) throw sysErr;
        return realUnlink(p);
      });
      assert.equal(cache.get(entryA), undefined);
      m.mock.restore();
    }
    for (const bugErr of [
      Object.assign(new TypeError('bad path'), { code: 'ERR_INVALID_ARG_TYPE' }),
      new TypeError('plain unlink bug'),
    ]) {
      const m = st.mock.method(fs, 'unlinkSync', (p) => {
        if (String(p).endsWith('.frame')) throw bugErr;
        return realUnlink(p);
      });
      assert.throws(() => cache.get(entryA), err => err === bugErr);
      m.mock.restore();
    }
  });

  await t.test('4) 节点号为 0 时按内核给出的真实路径原样分根：只差大小写的两个路径各取各的锁，解析到同一路径的别名共用状态', (st) => {
    // 用三个真实目录模拟区分大小写的卷：A 解析成 Vol/Cache，B 解析成 Vol/cache（另一个目录），C 是 A 的别名写法
    const [a, b, alias] = ['cs-a', 'cs-b', 'cs-alias'].map(name => openShotCache(path.join(parent, name)));
    const resolved = new Map([[a.root, path.join(parent, 'Vol', 'Cache')], [b.root, path.join(parent, 'Vol', 'cache')], [alias.root, path.join(parent, 'Vol', 'Cache')]]);
    const realLstat = fs.lstatSync;
    st.mock.method(fs, 'lstatSync', (target, opts) => {
      const s = realLstat(target, opts);
      return s && opts?.bigint && resolved.has(String(target)) ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ino: 0n }) : s;
    });
    const realNative = fs.realpathSync.native;
    st.mock.method(fs.realpathSync, 'native', target => resolved.get(String(target)) ?? realNative(target));
    const realRename = fs.renameSync;
    const locked = {};
    st.mock.method(fs, 'renameSync', (from, to) => {
      const dest = String(to);
      if (dest.endsWith('.frame')) {
        if (dest.startsWith(a.root + path.sep) && !('b' in locked)) {
          locked.b = null;
          b.put(entryA, { colorBytes: Buffer.from([2]), meta: sampleMeta, runId: 'r-cs-b' });
          alias.put(entryA, { colorBytes: Buffer.from([3]), meta: sampleMeta, runId: 'r-cs-alias' });
        }
        if (dest.startsWith(b.root + path.sep)) locked.b = fs.existsSync(path.join(b.root, '.cache.lock'));
        if (dest.startsWith(alias.root + path.sep)) locked.alias = fs.existsSync(path.join(alias.root, '.cache.lock'));
      }
      return realRename(from, to);
    });
    a.put(entryA, { colorBytes: Buffer.from([1]), meta: sampleMeta, runId: 'r-cs-a' });
    assert.deepEqual(locked, { b: true, alias: false }, '只差大小写的另一个根要取自己的锁；同一路径的别名在临界区里重入、不再建锁');
  });

  await t.test('5) 释放锁的每次尝试都重新认主：删锁遇 EBUSY 或 ENOENT 的空档里根被轮换，下一次尝试到旧根里删自己的锁；读不出锁内容时按节点号照样放锁', (st) => {
    const realRm = fs.rmSync;
    const realRename = fs.renameSync;
    for (const mode of ['EBUSY', 'ENOENT']) {
      const root = path.join(parent, `retry-${mode}`);
      const retired = `${root}-old`;
      const cache = openShotCache(root);
      const lock = path.join(cache.root, '.cache.lock');
      let rotated = false;
      const m = st.mock.method(fs, 'rmSync', (target, opts) => {
        if (!rotated && String(target) === lock) {
          rotated = true;
          realRename(cache.root, retired);
          fs.mkdirSync(cache.root);
          if (mode === 'EBUSY') {
            fs.writeFileSync(lock, '777777 other\n');
            throw Object.assign(new Error('EBUSY: unlink'), { code: 'EBUSY' });
          }
        }
        return realRm(target, opts); // ENOENT 一档：原路径上已经没有锁，真实删除自己报 ENOENT
      });
      cache.put(entryA, { colorBytes: Buffer.from([51]), meta: sampleMeta, runId: `r-retry-${mode}` });
      m.mock.restore();
      assert.equal(rotated, true);
      if (mode === 'EBUSY') assert.equal(fs.readFileSync(lock, 'utf8'), '777777 other\n');
      assert.deepEqual(fs.readdirSync(retired).filter(n => n === '.cache.lock' || n.startsWith('.write-')), [], `${mode}：旧根里不留自己的锁和暂存`);
    }

    // 句柄耗尽时读不了锁内容：节点号对得上就放锁，不把自己的锁当成别人的留下
    const cache = openShotCache(path.join(parent, 'emfile'));
    const realRead = fs.readFileSync;
    st.mock.method(fs, 'readFileSync', (target, ...rest) => {
      if (String(target).endsWith('.cache.lock')) throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
      return realRead(target, ...rest);
    });
    cache.put(entryA, { colorBytes: Buffer.from([52]), meta: sampleMeta, runId: 'r-emfile' });
    assert.equal(fs.existsSync(path.join(cache.root, '.cache.lock')), false);
  });
});

test('A16-36 十审收口（Red -> Green）：双真锁代际交换互斥、回调中途轮换绑定持锁代、释放持续 EBUSY 显式报错且可恢复、以及 4 项单点变异全杀', async (t) => {
  const { openShotCache, computeFrameCacheKey, appendJobLedger, readJobLedger } = jobs;
  const { withFileLock } = await import('./ledger.mjs');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-a16-r10-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const entryA = computeFrameCacheKey(makeBaseSpec());

  await t.test('1) 两把真实 withFileLock 锁在内层 linkSync 后交换目录代际：内层回调 0 次执行并超时，外层锁无损，释放后两代均空', (st) => {
    const cur = path.join(parent, 'swap-cur');
    const aside = path.join(parent, 'swap-aside');
    const tmp = path.join(parent, 'swap-tmp');
    fs.mkdirSync(cur, { recursive: true });
    const record = path.join(cur, 'record');
    const realLink = fs.linkSync;
    const realRename = fs.renameSync;
    let innerCalls = 0;

    withFileLock(record, () => {
      const outerLockPayload = fs.readFileSync(`${record}.lock`, 'utf8');
      realRename(cur, aside);
      fs.mkdirSync(cur, { recursive: true });
      let swapped = false;
      const hook = st.mock.method(fs, 'linkSync', (src, dst) => {
        const res = realLink(src, dst);
        if (!swapped && String(dst) === `${record}.lock`) {
          swapped = true;
          realRename(cur, tmp);
          realRename(aside, cur);
          realRename(tmp, aside);
        }
        return res;
      });
      assert.throws(
        () => withFileLock(record, () => { innerCalls += 1; }, 50, '测试'),
        err => err?.code === 'ETIMEDOUT',
        '当前路径已被换回外层仍持锁的代际时，内层绝不能进入回调',
      );
      hook.mock.restore();
      assert.equal(swapped, true);
      assert.equal(innerCalls, 0);
      assert.equal(fs.readFileSync(`${record}.lock`, 'utf8'), outerLockPayload, '外层持有的锁不能被内层误删');
      assert.deepEqual(fs.readdirSync(aside), [], '内层建在另一代的锁与暂存必须已清干净');
    }, 500, '测试');

    assert.deepEqual(fs.readdirSync(cur), []);
    assert.deepEqual(fs.readdirSync(aside), []);
  });

  await t.test('2) 回调执行中途目录被轮换且新代预置另一把锁：appendJobLedger 只写自己持锁的那一代账本，绝不污染新代', (st) => {
    const jobsDir = path.join(parent, 'ledger-cur');
    const jobsRetired = path.join(parent, 'ledger-retired');
    fs.mkdirSync(jobsDir, { recursive: true });
    const ledgerPath = path.join(jobsDir, 'ledger.jsonl');
    const realRead = fs.readFileSync;
    const realRename = fs.renameSync;
    const newLock = `${process.pid} other-ledger-lock\n`;
    let rotatedOnLoad = false;
    st.mock.method(fs, 'readFileSync', (target, ...rest) => {
      if (!rotatedOnLoad && String(target) === ledgerPath) {
        rotatedOnLoad = true;
        realRename(jobsDir, jobsRetired);
        fs.mkdirSync(jobsDir, { recursive: true });
        fs.writeFileSync(path.join(jobsDir, 'ledger.jsonl.lock'), newLock);
      }
      return realRead(target, ...rest);
    });

    const row = appendJobLedger(ledgerPath, {
      jobId: 'job-rot-1',
      attempt: 1,
      kind: 'render',
      status: 'succeeded',
      wallMs: 12,
      renderedFrames: 1,
      deliveredFrames: 1,
      diskBytes: 0,
    });
    st.mock.restoreAll();
    assert.equal(rotatedOnLoad, true);
    assert.equal(row.seq, 1);
    assert.equal(fs.existsSync(path.join(jobsDir, 'ledger.jsonl')), false, '不得无锁写入新代目录');
    assert.equal(fs.readFileSync(path.join(jobsDir, 'ledger.jsonl.lock'), 'utf8'), newLock, '新代锁完整保留');
    fs.rmSync(path.join(jobsDir, 'ledger.jsonl.lock'), { force: true });
    const retiredRows = readJobLedger(path.join(jobsRetired, 'ledger.jsonl'));
    assert.equal(retiredRows.length, 1);
    assert.equal(retiredRows[0].jobId, 'job-rot-1');
    assert.equal(fs.existsSync(path.join(jobsRetired, 'ledger.jsonl.lock')), false, '旧代锁已精准释放');
  });

  await t.test('3) 释放阶段兄弟枚举持续 EBUSY 直至退避耗尽：必须显式抛出 EBUSY，且故障解除后同进程可立即重取旧代锁恢复', (st) => {
    // macOS 的默认临时目录是符号链接（/var → /private/var）：先取真实路径，注入的故障才对得上 withFileLock 列的那个上一级
    const sub = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, 'ebusy-rel-')));
    const cur = path.join(sub, 'old');
    const retired = path.join(sub, 'old-retired');
    fs.mkdirSync(cur, { recursive: true });
    const realRename = fs.renameSync;
    const realReaddir = fs.readdirSync;
    const subReal = fs.realpathSync.native(sub);
    let failReaddir = false;
    let readdirAttempts = 0;

    st.mock.method(fs, 'readdirSync', (dir, opts) => {
      if (failReaddir && path.resolve(String(dir)) === subReal) {
        readdirAttempts += 1;
        throw Object.assign(new Error('EBUSY: persistent sibling enum failure'), { code: 'EBUSY' });
      }
      return realReaddir(dir, opts);
    });

    assert.throws(
      () => withFileLock(path.join(cur, 'record'), () => {
        realRename(cur, retired);
        fs.mkdirSync(cur, { recursive: true });
        failReaddir = true;
        return 'done';
      }, 200, '测试'),
      err => err?.code === 'EBUSY',
      '释放锁遇持续 EBUSY 不能静默吞错返回成功',
    );
    assert.ok(readdirAttempts >= 13, `应当跑满退避重试，实测 ${readdirAttempts}`);
    assert.equal(fs.existsSync(path.join(retired, 'record.lock')), true, 'EBUSY 期间锁仍在旧代目录');

    // 撤销故障后，同一存活进程再次对旧代目录加锁必须自动识别并清理孤儿锁，正常取得锁恢复！
    failReaddir = false;
    const recovered = withFileLock(path.join(retired, 'record'), () => 'recovered', 200, '测试');
    assert.equal(recovered, 'recovered');
    assert.equal(fs.existsSync(path.join(retired, 'record.lock')), false);
  });

  await t.test('4) 四项 R10 单点变异差分断言：建锁失败暂存回收、帧暂存早期轮换、pending+lock 双零节点号且同 PID 异 UUID 锁凭据', (st) => {
    const realMkdir = fs.mkdirSync;
    const realRename = fs.renameSync;
    const realLstat = fs.lstatSync;

    // 4a: 建锁 mkdir 刚成功即轮换且新根已有锁导致 linkSync 报 EEXIST -> catch 分支必须按 locateOwned 清掉旧根 .write-*
    const lockFailRoot = path.join(parent, 'mut-lock-fail');
    const lockFailRetired = path.join(parent, 'mut-lock-fail-old');
    const c1 = openShotCache(lockFailRoot);
    c1.put(entryA, { colorBytes: Buffer.from([11]), meta: {}, runId: 'r-m1' });
    let rotatedLockStaging = false;
    let m1 = st.mock.method(fs, 'mkdirSync', (target, opts) => {
      const res = realMkdir(target, opts);
      const s = String(target);
      if (!rotatedLockStaging && s.startsWith(c1.root + path.sep) && path.basename(s).startsWith('.write-')) {
        rotatedLockStaging = true;
        realRename(c1.root, lockFailRetired);
        realMkdir(c1.root, { recursive: true });
        fs.writeFileSync(path.join(c1.root, '.cache.lock'), `${process.pid} blocker\n`);
      }
      return res;
    });
    assert.throws(() => c1.prune({ maxAgeMs: 0, now: Date.now() + 5000, lockTimeoutMs: 40 }), err => err?.code === 'ETIMEDOUT');
    m1.mock.restore();
    fs.rmSync(path.join(c1.root, '.cache.lock'), { force: true });
    assert.equal(rotatedLockStaging, true);
    assert.deepEqual(fs.readdirSync(lockFailRetired).filter(n => n.startsWith('.write-') || n === '.cache.lock'), []);

    // 4b: 帧暂存 mkdir 刚成功即轮换 -> put 重试发到新根读回 77，新旧两代零 .write-* 残留
    const frameStageRoot = path.join(parent, 'mut-frame-stage');
    const frameStageRetired = path.join(parent, 'mut-frame-stage-old');
    const c2 = openShotCache(frameStageRoot);
    let rotatedFrameStaging = false;
    let m2 = st.mock.method(fs, 'mkdirSync', (target, opts) => {
      const res = realMkdir(target, opts);
      const s = String(target);
      if (!rotatedFrameStaging && s.startsWith(c2.root + path.sep) && path.basename(s).startsWith('.write-')) {
        rotatedFrameStaging = true;
        realRename(c2.root, frameStageRetired);
        realMkdir(c2.root, { recursive: true });
      }
      return res;
    });
    c2.put(entryA, { colorBytes: Buffer.from([77]), meta: {}, runId: 'r-m2' });
    m2.mock.restore();
    assert.equal(rotatedFrameStaging, true);
    assert.deepEqual(c2.get(entryA)?.colorBytes, Buffer.from([77]));
    assert.deepEqual(fs.readdirSync(frameStageRetired).filter(n => n.startsWith('.write-') || n === '.cache.lock'), []);
    assert.deepEqual(fs.readdirSync(c2.root).filter(n => n.startsWith('.write-') || n === '.cache.lock'), []);

    // 4c + 4d: 发布前 pending 与两代最终 .cache.lock 均返回 ino=0n，且新代预置锁同为当前 process.pid 但不同 UUID
    const dualZeroRoot = path.join(parent, 'mut-dual-zero');
    const dualZeroRetired = path.join(parent, 'mut-dual-zero-old');
    const c3 = openShotCache(dualZeroRoot);
    const samePidOtherUuid = `${process.pid} other-distinct-uuid\n`;
    let pendingZeroHits = 0;
    let lockZeroHits = 0;
    let flippedDual = false;
    st.mock.method(fs, 'lstatSync', (target, opts) => {
      const s = realLstat(target, opts);
      if (s && opts?.bigint) {
        const p = String(target);
        if (p.endsWith(`${path.sep}pending`)) {
          pendingZeroHits += 1;
          return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ino: 0n });
        }
        if (p.endsWith('.cache.lock')) {
          lockZeroHits += 1;
          return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ino: 0n });
        }
      }
      return s;
    });
    st.mock.method(fs, 'renameSync', (from, to) => {
      const r = realRename(from, to);
      if (!flippedDual && String(to).endsWith('.frame')) {
        flippedDual = true;
        realRename(c3.root, dualZeroRetired);
        realMkdir(c3.root, { recursive: true });
        fs.writeFileSync(path.join(c3.root, '.cache.lock'), samePidOtherUuid);
      }
      return r;
    });
    c3.put(entryA, { colorBytes: Buffer.from([88]), meta: {}, runId: 'r-m3' });
    st.mock.restoreAll();
    assert.ok(pendingZeroHits >= 1, '必须覆盖发布前 pending 的零节点号');
    assert.ok(lockZeroHits >= 2, '必须覆盖最终锁的零节点号');
    assert.equal(fs.readFileSync(path.join(c3.root, '.cache.lock'), 'utf8'), samePidOtherUuid, '不得误删同 PID 异 UUID 的新代锁');
    fs.rmSync(path.join(c3.root, '.cache.lock'), { force: true });
    assert.deepEqual(fs.readdirSync(dualZeroRetired).filter(n => n === '.cache.lock' || n.startsWith('.write-')), []);
  });

  await t.test('5) 进回调前的一瞬间根被轮换：清理只在锁所在的那一代里核对删除；帧暂存与锁不在同一代时不在原路径上无锁发布', (st) => {
    const realLstat = fs.lstatSync;
    const realRename = fs.renameSync;
    const leftovers = dir => fs.readdirSync(dir).filter(n => n === '.cache.lock' || n.startsWith('.write-'));
    // 锁路径上第 2 次带节点号的取样，就是回调里认「锁在哪一代」的那一次（第 1 次是建锁后的归属复核）
    const beforeCallback = (lock, act) => {
      let samples = 0;
      return st.mock.method(fs, 'lstatSync', (target, opts) => {
        if (opts?.bigint && String(target) === lock && ++samples === 2) act();
        return realLstat(target, opts);
      });
    };

    const cache = openShotCache(path.join(parent, 'pre-callback'));
    const retired = `${cache.root}-old`;
    cache.put(entryA, { colorBytes: Buffer.from([41]), meta: {}, runId: 'r-pre' });
    beforeCallback(path.join(cache.root, '.cache.lock'), () => {
      realRename(cache.root, retired);
      fs.mkdirSync(cache.root);
    });
    // 临界区里（锁在旧目录）再往原路径上的新目录发布：新目录不归这把锁管，要另取新目录自己的锁，不能当成重入
    const realUnlink = fs.unlinkSync;
    const lockedAtNestedPublish = [];
    st.mock.method(fs, 'unlinkSync', (target) => {
      if (String(target).endsWith('.frame')) {
        const watch = st.mock.method(fs, 'renameSync', (from, to) => {
          if (String(to).endsWith('.frame')) lockedAtNestedPublish.push(fs.existsSync(path.join(cache.root, '.cache.lock')));
          return realRename(from, to);
        });
        cache.put(entryA, { colorBytes: Buffer.from([43]), meta: {}, runId: 'r-nested' });
        watch.mock.restore();
      }
      return realUnlink(target);
    });
    assert.deepEqual(cache.prune({ maxAgeMs: 0, now: Date.now() + 5000, lockTimeoutMs: 200 }), { removed: 1 }, '过期帧在锁所在的旧目录里删掉');
    st.mock.restoreAll();
    assert.deepEqual(lockedAtNestedPublish, [true]);
    assert.deepEqual([...cache.get(entryA).colorBytes], [43]);
    assert.equal(openShotCache(retired).get(entryA), undefined);
    assert.deepEqual(leftovers(retired), []);
    assert.deepEqual(leftovers(cache.root), []);

    // 帧暂存写好之后、取锁之前轮换（暂存留在 X，锁建在 Y），进回调前又换回 X：原路径上有暂存、没有自己的锁
    const split = openShotCache(path.join(parent, 'split-gen'));
    const aside = `${split.root}-aside`;
    const lock = path.join(split.root, '.cache.lock');
    const realWrite = fs.writeFileSync;
    let staged = false;
    st.mock.method(fs, 'writeFileSync', (target, ...rest) => {
      const result = realWrite(target, ...rest);
      if (!staged && String(target).startsWith(split.root + path.sep) && String(target).endsWith(`${path.sep}pending`)) {
        staged = true;
        realRename(split.root, aside);
        fs.mkdirSync(split.root);
      }
      return result;
    });
    beforeCallback(lock, () => {
      realRename(split.root, `${aside}-tmp`);
      realRename(aside, split.root);
      realRename(`${aside}-tmp`, aside);
    });
    const lockedAtPublish = [];
    st.mock.method(fs, 'renameSync', (from, to) => {
      if (String(to).endsWith('.frame')) lockedAtPublish.push(fs.existsSync(lock));
      return realRename(from, to);
    });
    split.put(entryA, { colorBytes: Buffer.from([42]), meta: {}, runId: 'r-split' });
    st.mock.restoreAll();
    assert.deepEqual(lockedAtPublish, [true], '只发布一次，发布时原路径上是自己的锁');
    assert.deepEqual([...split.get(entryA).colorBytes], [42]);
    assert.deepEqual(leftovers(aside), []);
    assert.deepEqual(leftovers(split.root), []);
  });
});

test('A16-37 十一审收口（Red -> Green）：缓存根 ino=0n 轮换后重入新根必取新锁、queue.replay 绑定持锁代、兄弟枚举成功但旧锁不可读（EBUSY / chmod 000）显式报错且恢复、建锁复核单次 EBUSY 退避', async (t) => {
  const { openShotCache, computeFrameCacheKey, appendJobLedger, openWorkspace, loadQueue } = jobs;
  const { withFileLock } = await import('./ledger.mjs');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-a16-r11-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const entryA = computeFrameCacheKey(makeBaseSpec());

  await t.test('1) 缓存根 bigint lstat 返回 ino=0n 时，外层持锁期间轮换目录再重入 put：新根必须持有自己的 .cache.lock', (st) => {
    const root = path.join(parent, 'ino0-reenter');
    const retired = path.join(parent, 'ino0-reenter-old');
    const cache = openShotCache(root);
    const realLstat = fs.lstatSync;
    const realRename = fs.renameSync;

    st.mock.method(fs, 'lstatSync', (target, opts) => {
      const s = realLstat(target, opts);
      if (s && opts?.bigint && String(target) === cache.root) {
        return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ino: 0n });
      }
      return s;
    });

    let rotated = false;
    let innerLocks = null;
    st.mock.method(fs, 'renameSync', (from, to) => {
      const res = realRename(from, to);
      const dest = String(to);
      if (dest.endsWith('.frame')) {
        if (!rotated) {
          rotated = true;
          realRename(cache.root, retired);
          fs.mkdirSync(cache.root, { recursive: true });
          cache.put(entryA, { colorBytes: Buffer.from([2]), meta: {}, runId: 'r-inner' });
        } else {
          innerLocks = {
            newRootHasLock: fs.existsSync(path.join(cache.root, '.cache.lock')),
            oldRootHasLock: fs.existsSync(path.join(retired, '.cache.lock')),
          };
        }
      }
      return res;
    });

    cache.put(entryA, { colorBytes: Buffer.from([1]), meta: {}, runId: 'r-outer' });
    st.mock.restoreAll();
    assert.deepEqual(innerLocks, { newRootHasLock: true, oldRootHasLock: true }, '轮换后新根与旧根必须各自持锁');
    assert.deepEqual([...openShotCache(retired).get(entryA).colorBytes], [1]);
    assert.deepEqual([...cache.get(entryA).colorBytes], [2]);
    assert.deepEqual(fs.readdirSync(retired).filter(n => n === '.cache.lock' || n.startsWith('.write-')), []);
    assert.deepEqual(fs.readdirSync(cache.root).filter(n => n === '.cache.lock' || n.startsWith('.write-')), []);
  });

  await t.test('2) queue.replay() 在首次打开 job.json 前及运行中发生目录轮换且新代由另一把锁持有时：认主、领取、运行与终态落盘全程绑定 old-generation，绝不污染 new-generation，且 getJob 支持一元 map 回调', async (st) => {
    const wsOld = path.join(parent, 'ws-replay');
    const wsNew = path.join(parent, 'ws-replay-new');
    for (const [wsDir, handlerName, tag] of [[wsOld, 'old-generation', 'old'], [wsNew, 'new-generation', 'new']]) {
      fs.mkdirSync(path.join(wsDir, 'shots'), { recursive: true });
      fs.writeFileSync(path.join(wsDir, 'shots', 's01.js'), 'export default {};\n');
      fs.writeFileSync(path.join(wsDir, 'film.json'), JSON.stringify({
        format: 'film/3.0',
        id: 'replay-gen-test',
        shots: [{ id: 's01', entry: 'shots/s01.js', in: 0, out: 2 }],
      }));
      openWorkspace(wsDir).commitRevision(0);
      const qInit = loadQueue(wsDir, { handlers: { [handlerName]: async () => ({}) } });
      qInit.enqueue({ id: 'job-1', kind: 'draft', handler: handlerName, payload: tag, rev: 0 });
      assert.deepEqual(['job-1'].map(qInit.getJob).map(j => j.id), ['job-1'], 'ids.map(queue.getJob) 不得受 map 下标二参干扰');
    }

    const jobRetired = path.join(fs.realpathSync(wsOld), 'jobs', 'job-1-retired');
    const jobRetired2 = path.join(fs.realpathSync(wsOld), 'jobs', 'job-1-retired-2');
    const newJobDir = path.join(fs.realpathSync(wsNew), 'jobs', 'job-1');
    const oldJobDir = path.join(fs.realpathSync(wsOld), 'jobs', 'job-1');
    const realRename = fs.renameSync;
    const realOpenSync = fs.openSync;
    const seen = [];
    let rotatedOnOpen = false;
    let rotatedMidRun = false;

    const q = loadQueue(wsOld, {
      handlers: {
        'old-generation': async ({ job, step }) => {
          seen.push({ handler: 'old-generation', payload: job.payload });
          await step('rotate-mid-run', async () => {
            if (!rotatedMidRun) {
              rotatedMidRun = true;
              realRename(jobRetired, jobRetired2);
            }
          });
          return { ran: 'old' };
        },
        'new-generation': async ({ job }) => {
          seen.push({ handler: 'new-generation', payload: job.payload });
          return { ran: 'new' };
        },
      },
    });

    let pendingReplay;
    try {
      withFileLock(path.join(newJobDir, 'job.json'), () => {
        st.mock.method(fs, 'openSync', (target, ...rest) => {
          if (!rotatedOnOpen && String(target) === path.join(oldJobDir, 'job.json') && fs.existsSync(path.join(oldJobDir, 'job.json.lock'))) {
            rotatedOnOpen = true;
            realRename(oldJobDir, jobRetired);
            realRename(newJobDir, oldJobDir);
          }
          return realOpenSync(target, ...rest);
        });
        pendingReplay = q.replay('job-1');
        st.mock.restoreAll();
      }, 500, '测试');

      const replayed = await pendingReplay;
      assert.equal(rotatedOnOpen, true, '必须在首次打开 oldJobDir/job.json 前触发轮换');
      assert.equal(rotatedMidRun, true, '必须在步骤执行中触发二次目录轮换');
      assert.equal(replayed.status, 'succeeded');
      assert.equal(replayed.handler, 'old-generation');
      assert.equal(replayed.payload, 'old');
      assert.deepEqual(seen, [{ handler: 'old-generation', payload: 'old' }]);

      const oldOnDisk = JSON.parse(fs.readFileSync(path.join(jobRetired2, 'job.json'), 'utf8'));
      const newOnDisk = JSON.parse(fs.readFileSync(path.join(oldJobDir, 'job.json'), 'utf8'));
      assert.equal(oldOnDisk.handler, 'old-generation');
      assert.equal(oldOnDisk.payload, 'old');
      assert.equal(oldOnDisk.status, 'succeeded');
      assert.equal(fs.existsSync(path.join(jobRetired2, 'attempt-1.owner-1')), true, '领取文件必须落在 old-generation 目录');

      assert.equal(newOnDisk.handler, 'new-generation');
      assert.equal(newOnDisk.payload, 'new');
      assert.equal(newOnDisk.status, 'queued', '轮换进来的 new-generation 记录必须保持原样 queued，绝不可被 old 覆盖');
      assert.deepEqual(
        fs.readdirSync(oldJobDir).filter(name => name.startsWith('attempt-')),
        [],
        'new-generation 目录不得被写入 old-generation 的领取文件',
      );
    } finally {
      st.mock.restoreAll();
      if (rotatedMidRun && fs.existsSync(jobRetired2)) {
        realRename(jobRetired2, jobRetired);
      }
      if (rotatedOnOpen) {
        realRename(oldJobDir, newJobDir);
        realRename(jobRetired, oldJobDir);
      }
    }
  });

  await t.test('3) 兄弟目录可列出但旧代锁候选持续 EBUSY 或目录权限 000：释放必须报错登记孤儿锁，故障恢复后同进程重取成功；无关 000 兄弟目录不干扰正常回收', (st) => {
    const sub = fs.mkdtempSync(path.join(parent, 'sib-unreadable-'));
    const unrelated000 = path.join(sub, 'unrelated-unreadable');
    fs.mkdirSync(unrelated000, { mode: 0o700 });
    fs.chmodSync(unrelated000, 0o000);
    try {
      // 3a: 存在无关 000 兄弟目录时，正常轮换仍顺利找到可读旧代锁并清除
      const okCur = path.join(sub, 'ok-cur');
      const okRetired = path.join(sub, 'ok-retired');
      fs.mkdirSync(okCur, { recursive: true });
      const realRename = fs.renameSync;
      withFileLock(path.join(okCur, 'record'), () => {
        realRename(okCur, okRetired);
        fs.mkdirSync(okCur, { recursive: true });
      }, 200, '测试');
      assert.equal(fs.existsSync(path.join(okRetired, 'record.lock')), false);

      // 3b: 已枚举到的旧锁自身 lstatSync 持续 13 次 EBUSY -> 释放必须抛 EBUSY，故障解除后重取恢复
      const busyCur = path.join(sub, 'busy-cur');
      const busyRetired = path.join(sub, 'busy-retired');
      fs.mkdirSync(busyCur, { recursive: true });
      const realLstat = fs.lstatSync;
      let failRetiredLstat = false;
      const retiredLockPath = path.join(busyRetired, 'record.lock');
      st.mock.method(fs, 'lstatSync', (target, opts) => {
        if (failRetiredLstat && path.resolve(String(target)) === path.resolve(retiredLockPath)) {
          throw Object.assign(new Error('EBUSY: retired lock lstat'), { code: 'EBUSY' });
        }
        return realLstat(target, opts);
      });
      assert.throws(
        () => withFileLock(path.join(busyCur, 'record'), () => {
          realRename(busyCur, busyRetired);
          fs.mkdirSync(busyCur, { recursive: true });
          failRetiredLstat = true;
          return 'done';
        }, 200, '测试'),
        err => err?.code === 'EBUSY',
      );
      failRetiredLstat = false;
      st.mock.restoreAll();
      assert.equal(withFileLock(path.join(busyRetired, 'record'), () => 'recovered', 200, '测试'), 'recovered');
      assert.equal(fs.existsSync(retiredLockPath), false);

      // 3c: 真实操作系统权限将旧代目录临时设为 000 -> 释放抛 EACCES/EPERM，恢复 0700 后同进程立即重取成功
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        const permCur = path.join(sub, 'perm-cur');
        const permRetired = path.join(sub, 'perm-retired');
        fs.mkdirSync(permCur, { recursive: true });
        try {
          assert.throws(
            () => withFileLock(path.join(permCur, 'record'), () => {
              realRename(permCur, permRetired);
              fs.mkdirSync(permCur, { recursive: true });
              fs.chmodSync(permRetired, 0o000);
              return 'done';
            }, 200, '测试'),
            err => ['EACCES', 'EPERM'].includes(err?.code),
          );
          fs.chmodSync(permRetired, 0o700);
          assert.equal(withFileLock(path.join(permRetired, 'record'), () => 'recovered-perm', 200, '测试'), 'recovered-perm');
          assert.equal(fs.existsSync(path.join(permRetired, 'record.lock')), false);
        } finally {
          try { fs.chmodSync(permRetired, 0o700); } catch {}
        }
      }
    } finally {
      try { fs.chmodSync(unrelated000, 0o700); } catch {}
    }
  });

  await t.test('4) 建锁发布后归属复核 mine(lock) 遇单次 EBUSY 时退避重试，当次 appendJobLedger 直接成功', (st) => {
    const dir = path.join(parent, 'mine-ebusy');
    fs.mkdirSync(dir, { recursive: true });
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const lockPath = `${ledgerPath}.lock`;
    const realLstat = fs.lstatSync;
    let injected = false;
    st.mock.method(fs, 'lstatSync', (target, opts) => {
      if (!injected && opts?.bigint && String(target) === lockPath) {
        injected = true;
        throw Object.assign(new Error('EBUSY: transient post-link lstat'), { code: 'EBUSY' });
      }
      return realLstat(target, opts);
    });
    const row = appendJobLedger(ledgerPath, {
      jobId: 'job-mine-ebusy',
      attempt: 1,
      kind: 'render',
      status: 'succeeded',
      wallMs: 5,
      renderedFrames: 1,
      deliveredFrames: 1,
      diskBytes: 0,
    });
    st.mock.restoreAll();
    assert.equal(injected, true);
    assert.equal(row.seq, 1);
  });
});

test('A16-38 十三审收口（Red -> Green）：领取前轮换（runJob / replay / cancelJob）与终态锁重取轮换均严格核对锁与领取令牌同代归属', async (t) => {
  const { loadQueue, openWorkspace, Scheduler } = jobs;
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-a16-r14-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));

  function makeWs(name) {
    const wsDir = path.join(parent, name);
    fs.mkdirSync(path.join(wsDir, 'shots'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'shots', 's01.js'), 'export default {};\n');
    fs.writeFileSync(path.join(wsDir, 'film.json'), JSON.stringify({
      format: 'film/3.0',
      id: 'r14-gen-test',
      shots: [{ id: 's01', entry: 'shots/s01.js', in: 0, out: 2 }],
    }));
    openWorkspace(wsDir).commitRevision(0);
    return wsDir;
  }

  for (const mode of ['runJob', 'replay']) {
    await t.test(`1-${mode}) 持锁读完后、领取前（scheduler.request 交接点）发生目录轮换且同 ID/handler/payload/snapshot 相同时：只领取并落盘旧代，新代零污染`, async () => {
      const ws = makeWs(`ws-preclaim-${mode}`);
      const qSetup = loadQueue(ws, { handlers: { draft: async () => ({ ok: 1 }) } });
      qSetup.enqueue({ id: 'job-1', kind: 'draft', handler: 'draft', payload: null, rev: 0, keep: 'none', vramMB: 1 });

      const jobsDir = path.join(fs.realpathSync(ws), 'jobs');
      const curDir = path.join(jobsDir, 'job-1');
      const retiredDir = path.join(jobsDir, 'job-1-retired');
      const incomingDir = path.join(jobsDir, 'job-1-incoming');
      fs.renameSync(curDir, retiredDir);
      qSetup.enqueue({ id: 'job-1', kind: 'draft', handler: 'draft', payload: null, rev: 0, keep: 'all', vramMB: 2 });
      fs.renameSync(curDir, incomingDir);
      fs.renameSync(retiredDir, curDir);
      const newOriginalBytes = fs.readFileSync(path.join(incomingDir, 'job.json'), 'utf8');

      let rotated = false;
      const baseScheduler = new Scheduler({ totalVramMB: 64 });
      const customScheduler = {
        request(req) {
          const out = baseScheduler.request(req);
          if (!rotated && fs.existsSync(path.join(curDir, 'job.json.lock'))) {
            rotated = true;
            fs.renameSync(curDir, retiredDir);
            fs.renameSync(incomingDir, curDir);
          }
          return out;
        },
        acquire(req, opts) { return baseScheduler.acquire(req, opts); },
      };

      const q = loadQueue(ws, { scheduler: customScheduler, handlers: { draft: async () => ({ done: mode }) } });
      const res = await q[mode]('job-1');
      assert.equal(rotated, true);
      assert.equal(res.status, 'succeeded');

      const oldDisk = JSON.parse(fs.readFileSync(path.join(retiredDir, 'job.json'), 'utf8'));
      assert.equal(oldDisk.status, 'succeeded');
      assert.equal(oldDisk.keep, 'none');
      assert.equal(oldDisk.request.vramMB, 1);
      assert.equal(fs.existsSync(path.join(retiredDir, 'attempt-1.owner-1')), true);

      assert.equal(fs.readFileSync(path.join(curDir, 'job.json'), 'utf8'), newOriginalBytes);
      assert.deepEqual(fs.readdirSync(curDir).filter(n => n.startsWith('attempt-')), []);
    });
  }

  await t.test('2) cancelJob 在读后、创建领取暂存目录前发生目录轮换：只取消旧代，新代不留残留领取文件且可正常 runJob', async (st) => {
    const ws = makeWs('ws-cancel-preclaim');
    const qSetup = loadQueue(ws, { handlers: { draft: async () => ({ ran: 'new' }) } });
    qSetup.enqueue({ id: 'job-1', kind: 'draft', handler: 'draft', payload: null, rev: 0 });

    const jobsDir = path.join(fs.realpathSync(ws), 'jobs');
    const curDir = path.join(jobsDir, 'job-1');
    const retiredDir = path.join(jobsDir, 'job-1-retired');
    const incomingDir = path.join(jobsDir, 'job-1-incoming');
    fs.renameSync(curDir, retiredDir);
    qSetup.enqueue({ id: 'job-1', kind: 'draft', handler: 'draft', payload: null, rev: 0 });
    fs.renameSync(curDir, incomingDir);
    fs.renameSync(retiredDir, curDir);
    const newOriginalBytes = fs.readFileSync(path.join(incomingDir, 'job.json'), 'utf8');

    const realMkdir = fs.mkdirSync;
    const realRename = fs.renameSync;
    let rotated = false;
    st.mock.method(fs, 'mkdirSync', (target, opts) => {
      // 跳过建锁自身的 .lock-* 暂存目录，精确拦截 claim 阶段首次建 .write-* 暂存目录前
      if (!rotated && String(target).startsWith(path.join(curDir, '.write-')) && fs.existsSync(path.join(curDir, 'job.json.lock'))) {
        rotated = true;
        realRename(curDir, retiredDir);
        realRename(incomingDir, curDir);
      }
      return realMkdir(target, opts);
    });

    const canceled = await qSetup.cancelJob('job-1');
    st.mock.restoreAll();
    assert.equal(rotated, true);
    assert.equal(canceled.status, 'canceled');

    const oldDisk = JSON.parse(fs.readFileSync(path.join(retiredDir, 'job.json'), 'utf8'));
    assert.equal(oldDisk.status, 'canceled');
    assert.equal(fs.existsSync(path.join(retiredDir, 'attempt-1.owner-1')), true);

    assert.equal(fs.readFileSync(path.join(curDir, 'job.json'), 'utf8'), newOriginalBytes);
    assert.deepEqual(fs.readdirSync(curDir).filter(n => n.startsWith('attempt-')), []);

    const ranNew = await qSetup.runJob('job-1');
    assert.equal(ranNew.status, 'succeeded');
    assert.deepEqual(ranNew.result, { ran: 'new' });
  });

  await t.test('3) finish 重取终态锁时在硬链接成功、归属复核前发生目录轮换：终态必须写回旧代目录，绝不覆盖新代', async (st) => {
    const ws = makeWs('ws-finish-lock-rotate');
    const q = loadQueue(ws, {
      handlers: {
        old: async () => {
          inFinishPhase = true;
          return { side: 'old' };
        },
        new: async () => ({ side: 'new' }),
      },
    });
    q.enqueue({ id: 'job-1', kind: 'draft', handler: 'old', payload: 'old', rev: 0 });

    const jobsDir = path.join(fs.realpathSync(ws), 'jobs');
    const curDir = path.join(jobsDir, 'job-1');
    const retiredDir = path.join(jobsDir, 'job-1-retired');
    const incomingDir = path.join(jobsDir, 'job-1-incoming');
    fs.renameSync(curDir, retiredDir);
    q.enqueue({ id: 'job-1', kind: 'draft', handler: 'new', payload: 'new', rev: 0 });
    fs.renameSync(curDir, incomingDir);
    fs.renameSync(retiredDir, curDir);
    const newOriginalBytes = fs.readFileSync(path.join(incomingDir, 'job.json'), 'utf8');

    const realLink = fs.linkSync;
    const realRename = fs.renameSync;
    let inFinishPhase = false;
    let rotated = false;
    st.mock.method(fs, 'linkSync', (src, dst) => {
      const out = realLink(src, dst);
      if (inFinishPhase && !rotated && String(dst) === path.join(curDir, 'job.json.lock')) {
        rotated = true;
        realRename(curDir, retiredDir);
        realRename(incomingDir, curDir);
      }
      return out;
    });

    const done = await q.runJob('job-1');
    st.mock.restoreAll();
    assert.equal(rotated, true);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.handler, 'old');

    const oldDisk = JSON.parse(fs.readFileSync(path.join(retiredDir, 'job.json'), 'utf8'));
    assert.equal(oldDisk.handler, 'old');
    assert.equal(oldDisk.payload, 'old');
    assert.equal(oldDisk.status, 'succeeded');
    assert.equal(fs.existsSync(path.join(retiredDir, 'attempt-1.owner-1')), true);

    assert.equal(fs.readFileSync(path.join(curDir, 'job.json'), 'utf8'), newOriginalBytes);
    assert.deepEqual(fs.readdirSync(curDir).filter(n => n.startsWith('attempt-')), []);
  });
});
