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
  assert.equal(second.calls, 4, '先补渲后两帧，检出尖峰后再把复用的前两帧重渲');
  assert.deepEqual([s01.totalFrames, s01.renderedFrames, s01.cachedFrames], [4, 4, 0]);
  assert.equal(s01.seamCheck.ok, true);
  assert.equal(s01.seamCheck.rerendered, true);
  assert.deepEqual(s01.seamCheck.spikes.map((s) => s.frame), [2]);
  assert.equal(run.ok, true);
  assert.deepEqual([run.totalFrames, run.totalRenderedFrames, run.totalCachedFrames], [4, 4, 0]);

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
  assert.equal(noFloats.calls, 4);
  assert.equal(unknown.shots[0].seamCheck.rerendered, true);
  assert.deepEqual([unknown.shots[0].renderedFrames, unknown.shots[0].cachedFrames], [4, 0]);

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
