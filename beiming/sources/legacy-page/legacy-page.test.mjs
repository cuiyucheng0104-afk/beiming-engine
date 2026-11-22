// S15 单测（Red -> Green）：sources/legacy-page 能力声明（limited、sceneQuery 为空）、六函数接口、文字框元数据与已发布作品锁文件及基线哈希核对
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadContracts } from '../../kernel/contracts/validate.mjs';
import { eventsTable, shotInput as kernelShotInput } from '../../kernel/eval/input.mjs';
import { upgradeFilmV2ToV3 } from '../../kernel/film-upgrade.mjs';
import * as legacyPage from './index.mjs';
import { publishedBaseline, staticEnvMismatch } from './locks.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// validate 交回 { schemaErrors, violations }：两样都空才算过
const problemsOf = (r) => [...r.schemaErrors, ...Object.entries(r.violations).map(([id, p]) => `${id}: ${p[0]}`)];

// 确定性旧页面驱动：红通道随时刻变，其余固定；文字框按页面约定 v1 的 { text, box: [x, y, w, h], alpha }
// over.fill(t) → [r, g, b]、over.texts(w, h) → TEXTS 原样、over.gpu → 渲染器名
const fakeDriver = (log = [], over = {}) => ({
  async open(opts) {
    log.push({ open: opts });
    const [w, h] = opts.size;
    return {
      gpu: over.gpu,
      async render(t) {
        log.push({ render: t });
        const rgba = new Uint8Array(w * h * 4);
        const [r, g, b] = over.fill ? over.fill(t) : [Math.min(255, Math.round(128 + t * 24)), 64, 255];
        for (let i = 0; i < rgba.length; i += 4) { rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255; }
        return rgba;
      },
      async texts(t) {
        log.push({ texts: t });
        return over.texts ? over.texts(w, h) : [
          { id: 'title', text: '北冥', box: [2, 2, w - 4, h - 4], alpha: 1 },
          { text: '隐', box: [0, 0, 1, 1], alpha: 0 },
          { text: '', box: [0, 0, 1, 1], alpha: 1 },
        ];
      },
      async close() { log.push('close'); },
    };
  },
});

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const code = (c) => (err) => err?.code === c;
const withTmp = async (fn) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-s15-'));
  try { return await fn(d); } finally { fs.rmSync(d, { recursive: true, force: true }); }
};
const renders = (log) => log.filter((x) => x?.render !== undefined).map((x) => x.render);
const realInput = (workId, shotId) => {
  const film = upgradeFilmV2ToV3(readJson(path.join(REPO, 'films', workId, 'film.json')));
  return kernelShotInput(film, shotId, eventsTable(film));
};
const metaBytes = (meta) => Buffer.byteLength(JSON.stringify(meta));

const shotInput = () => ({
  film: 'f-legacy',
  output: { size: [16, 16], fps: '24/1' },
  shot: { id: 's01', in: 0, out: 12, source: 'legacy-page', host: 'page', mode: 'native-code', entry: 'index.html', colorRef: 'display', seed: 7, shutter: { angleDeg: 0, samples: 1 } },
  events: { format: 'events/0.1', film: 'f-legacy', fps: '24/1', frames: 12, events: [{ id: 'hit', frame: 3, sub: 0, kind: 'named', from: 'film' }] },
});

const srgbToLinear = (c8) => { const c = c8 / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };

test('S15-1 caps() 通过契约校验，conformance 为 limited 且 sceneQuery 为空', async () => {
  assert.equal(typeof legacyPage.caps, 'function');
  const c = legacyPage.caps();
  assert.equal(c.id, 'legacy-page');
  assert.equal(c.conformance, 'limited');
  assert.deepEqual(c.sceneQuery, []);
  assert.equal(c.outputs.depth, false);
  assert.equal(c.outputs.objectId, false);
  assert.equal(c.outputs.normal, false);
  assert.equal(c.outputs.motion, false);
  assert.equal(c.outputs.meta, true);

  const contracts = await loadContracts();
  assert.deepEqual(problemsOf(contracts.validate(c)), []);
});

test('S15-2 open/manifest/render/query/close：sRGB 线性化、meta/0.1 (camera/entities 为 null + TEXTS 文字框)、乱序一致、query 报 contract.unsupported-query', async () => {
  const contracts = await loadContracts();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-s15-'));
  try {
    const log = [];
    const env = { lock: null, tier: 'final', workspace: ws, filmDir: ws };
    const s1 = await legacyPage.open(shotInput(), env, { driver: fakeDriver(log) });
    assert.deepEqual(log[0].open.size, [16, 16]);
    assert.deepEqual(s1.manifest(), { frames: 12, entities: [] });

    const r3 = await s1.render(3, {}, ['color', 'meta']);
    assert.ok(r3.layers?.color?.hash?.startsWith('sha256:'));
    assert.deepEqual(r3.layers.color.shape, [16, 16, 4]);
    assert.equal(r3.layers.color.file, 's01/000003/color.f32');
    // 颜色层逐字节：8 位 sRGB 按分段传递函数解码，透明度 1
    const buf = fs.readFileSync(path.join(ws, r3.layers.color.file));
    assert.equal(buf.length, 16 * 16 * 4 * 4);
    const px = new Float32Array(buf.buffer, buf.byteOffset, 4);
    const red = Math.min(255, Math.round(128 + (3 / 24) * 24));
    assert.deepEqual([...px], [Math.fround(srgbToLinear(red)), Math.fround(srgbToLinear(64)), 1, 1]);

    assert.equal(r3.meta.seed, 7);
    assert.equal(r3.meta.hash.color, `sha256:${createHash('sha256').update(buf).digest('hex')}`);
    assert.equal(r3.layers.color.hash, r3.meta.hash.color);
    assert.equal(r3.meta.camera, null);
    assert.equal(r3.meta.entities, null);
    assert.equal(r3.meta.source.renderer, 'legacy-page');
    assert.deepEqual(r3.meta.texts, [{ id: 'title', text: '北冥', bbox2d: [2, 2, 14, 14] }]);
    assert.deepEqual(r3.meta.events, [{ id: 'hit', frame: 3 }]);
    assert.match(r3.meta.ext['legacy-page.pixelSha256'], /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(problemsOf(contracts.validate(r3.meta)), []);

    // 乱序渲染第 8 帧再重渲第 3 帧，颜色层哈希逐位一致
    await s1.render(8, {}, ['color', 'meta']);
    const r3Repeat = await s1.render(3, {}, ['color', 'meta']);
    assert.equal(r3Repeat.layers.color.hash, r3.layers.color.hash);

    // 只要元数据：不出像素，hash.color 与 stats 都是 null
    const metaOnly = await s1.render(5, {}, ['meta']);
    assert.deepEqual(metaOnly.layers, {});
    assert.equal(metaOnly.meta.hash.color, null);
    assert.equal(metaOnly.meta.stats, null);
    assert.deepEqual(problemsOf(contracts.validate(metaOnly.meta)), []);

    const code = (c) => (err) => err?.code === c;
    await assert.rejects(() => s1.render(12, {}, ['meta']), code('usage.bad-argument'));
    await assert.rejects(() => s1.render(0, {}, ['depth']), code('contract.unsupported-output'));
    await assert.rejects(() => s1.render(0, { samples: 4 }, ['color']), code('contract.unsupported-option'));
    await assert.rejects(() => s1.render(0, { shutter: { angleDeg: 0, samples: 3 } }, ['color']), code('contract.shutter-conflict'));

    // 场景查询必须报 contract.unsupported-query
    await assert.rejects(() => s1.query(0, { kind: 'bbox3d', of: ['hero'] }), code('contract.unsupported-query'));

    await s1.close();
    await s1.close();
    assert.equal(log.filter((x) => x === 'close').length, 1);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('S15-2b open 拒掉旧页面装不了的输入', async () => {
  const env = { lock: null, tier: 'final', workspace: os.tmpdir(), filmDir: os.tmpdir() };
  const code = (c) => (err) => err?.code === c;
  const withShot = (patch) => { const i = shotInput(); Object.assign(i.shot, patch); return i; };
  await assert.rejects(() => legacyPage.open(withShot({ mode: 'cards-data' }), env, { driver: fakeDriver() }), code('contract.unsupported-mode'));
  await assert.rejects(() => legacyPage.open(withShot({ seed: undefined }), env, { driver: fakeDriver() }), code('env.lock-required'));
  await assert.rejects(() => legacyPage.open(withShot({ colorRef: 'scene' }), env, { driver: fakeDriver() }), code('contract.unsupported-input'));
});

test('S15-3 已发布作品锁文件全部通过 lock/0.1 契约校验，且基线哈希核对器抓得出篡改', async () => {
  const contracts = await loadContracts();
  assert.deepEqual([...legacyPage.PUBLISHED_WORKS], ['beiming-10s', 'chendu', 'du']);

  for (const workId of legacyPage.PUBLISHED_WORKS) {
    const lock = legacyPage.loadLegacyLock(workId);
    assert.deepEqual(problemsOf(contracts.validate(lock)), [], `${workId} 锁文件未通过 lock/1.0 校验`);
    // 和升级后的片子描述对得上（种子派生、镜头、帧源、全片级卡）
    const film = upgradeFilmV2ToV3(JSON.parse(fs.readFileSync(path.join(REPO, 'films', workId, 'film.json'), 'utf8')));
    assert.deepEqual(problemsOf(contracts.validate({ format: 'lock-check/0.1', lock, film })), [], `${workId} 锁核对未过`);
  }

  const baseline = legacyPage.getBaselineHashes('beiming-10s');
  assert.ok(Object.keys(baseline).length > 0, '应能读取 beiming-10s 基线哈希表');
  assert.deepEqual(legacyPage.verifyBaselineHashes('beiming-10s', baseline, { baseline: 'golden' }), { ok: true, mismatched: [], missing: [] });

  const [firstKey, secondKey] = Object.keys(baseline);
  const tampered = { ...baseline, [firstKey]: 'sha256:' + '0'.repeat(64) };
  delete tampered[secondKey];
  const failCheck = legacyPage.verifyBaselineHashes('beiming-10s', tampered, { baseline: 'golden' });
  assert.equal(failCheck.ok, false);
  assert.deepEqual(failCheck.mismatched, [firstKey]);
  assert.deepEqual(failCheck.missing, [secondKey]);

  assert.equal(legacyPage.verifyBaselineHashes('chendu', {}, { baseline: 'golden' }).reason, 'no-baseline');
  assert.throws(() => legacyPage.loadLegacyLock('nope'), RangeError);
});

const HASH_KEY = 'legacy-page.pixelSha256';
const SHA = /^sha256:[0-9a-f]{64}$/;
const withShot = (patch, events) => { const i = shotInput(); Object.assign(i.shot, patch); if (events) Object.assign(i.events, events); return i; };
const openFake = (input, ws, log = [], over = {}) => legacyPage.open(input, { lock: null, tier: 'final', workspace: ws, filmDir: ws }, { driver: fakeDriver(log, over) });

test('S15-4 镜像目录 films/beiming-10s 自动解析到仓库根页面入口，按全片帧数和 shot.in + f 驱动 render(t)', async () => {
  await withTmp(async (ws) => {
    const lock = legacyPage.loadLegacyLock('beiming-10s');
    const incomplete = structuredClone(lock);
    delete incomplete.sources.three;
    await assert.rejects(() => legacyPage.open(realInput('beiming-10s', 'b'), { lock: incomplete, tier: 'draft', workspace: ws, filmDir: ws }, { driver: fakeDriver() }), code('contract.unsupported-input'));
    const log = [];
    const s = await legacyPage.open(realInput('beiming-10s', 'b'), { lock, tier: 'draft', workspace: ws, filmDir: path.join(REPO, 'films/beiming-10s') }, { driver: fakeDriver(log) });
    assert.equal(path.resolve(log[0].open.dir), REPO);
    assert.equal(log[0].open.frameCount, 240);
    assert.deepEqual(s.manifest(), { frames: 48, entities: [] });
    const { meta } = await s.render(5, {}, ['color', 'meta']);
    assert.equal(meta.seed, lock.seeds.b);
    assert.deepEqual(renders(log), [77 / 24]);
    await s.close();

    // 目录里没有 index.html、film.json 标了 mirror.paths = repo：同样解析到仓库根
    const mirror = path.join(ws, 'mirror');
    fs.mkdirSync(mirror);
    fs.writeFileSync(path.join(mirror, 'film.json'), JSON.stringify({ mirror: { paths: 'repo' } }));
    const logM = [];
    await (await openFake(shotInput(), mirror, logM)).close();
    assert.equal(path.resolve(logM[0].open.dir), REPO);

    // 没标镜像（或自己就有 index.html）：目录不变
    const plain = path.join(ws, 'plain');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'film.json'), '{}');
    const logP = [];
    await (await openFake(shotInput(), plain, logP)).close();
    assert.equal(path.resolve(logP[0].open.dir), plain);

    // 镜头出点超出全片帧数：拒掉，并且不留开着的页面
    const logB = [];
    await assert.rejects(() => openFake(withShot({}, { frames: 8 }), ws, logB), code('usage.bad-argument'));
    assert.equal(logB.filter((x) => x?.open).length, 0);
  });
});

test('S15-5 render 支持可选精确时刻 timeSec：页面和文字框都按这个时刻取，越出本帧区间或多子帧时拒掉', async () => {
  await withTmp(async (ws) => {
    const log = [];
    const s = await openFake(shotInput(), ws, log);
    await s.render(3, { timeSec: 3.25 / 24 }, ['color', 'meta']);
    assert.deepEqual(renders(log), [3.25 / 24]);
    assert.deepEqual(log.filter((x) => x?.texts !== undefined).map((x) => x.texts), [3.25 / 24]);
    await s.render(3, { timeSec: 3 / 24 }, ['color']);
    assert.equal(renders(log).at(-1), 3 / 24);
    for (const bad of [2.99 / 24, 4 / 24, NaN, '3']) await assert.rejects(() => s.render(3, { timeSec: bad }, ['color']), code('usage.bad-argument'));
    await assert.rejects(() => s.render(3, { timeSec: 3.5 / 24, shutter: { angleDeg: 180, samples: 3 } }, ['color']), code('usage.bad-argument'));
    await s.close();
  });
});

test('S15-5b 180 度快门在两个采样区间的中点取样，颜色层保存线性光均值', async () => {
  await withTmp(async (ws) => {
    const log = [];
    const session = await openFake(shotInput(), ws, log, { fill: (t) => t < 3.25 / 24 ? [0, 64, 255] : [255, 128, 0] });
    try {
      const { layers } = await session.render(3, { shutter: { angleDeg: 180, samples: 2 } }, ['color']);
      assert.deepEqual(renders(log), [3.125 / 24, 3.375 / 24]);
      const bytes = fs.readFileSync(path.join(ws, layers.color.file));
      const pixel = new Float32Array(bytes.buffer, bytes.byteOffset, 4);
      assert.deepEqual([...pixel], [0.5, Math.fround((srgbToLinear(64) + srgbToLinear(128)) / 2), 0.5, 1]);
    } finally { await session.close(); }
  });
});

test('S15-6 TEXTS 同时认 [x,y,w,h]、{x0,y0,x1,y1}、{x,y,w,h} 和条目顶层 x0..y1；可见文字的坐标非有限就报错', async () => {
  const contracts = await loadContracts();
  await withTmp(async (ws) => {
    const s = await openFake(shotInput(), ws, [], {
      texts: () => [
        { id: 'a', text: 'a', box: [1, 2, 3, 4], alpha: 1 },
        { text: 'b', box: { x0: 1, y0: 2, x1: 5, y1: 9 } },
        { text: 'c', box: { x: 1, y: 2, w: 3, h: 4 } },
        { text: 'd', x0: 1, y0: 2, x1: 3, y1: 4 },
        { text: 'e', box: [1, 2, -3, -4] },
        { text: 'hidden', box: [NaN, 0, 1, 1], alpha: 0 },
      ],
    });
    const r = await s.render(0, {}, ['meta']);
    assert.deepEqual(r.meta.texts, [
      { id: 'a', text: 'a', bbox2d: [1, 2, 4, 6] },
      { text: 'b', bbox2d: [1, 2, 5, 9] },
      { text: 'c', bbox2d: [1, 2, 4, 6] },
      { text: 'd', bbox2d: [1, 2, 3, 4] },
      { text: 'e', bbox2d: [1, 2, 1, 2] },
    ]);
    assert.deepEqual(problemsOf(contracts.validate(r.meta)), []);
    await s.close();
    for (const box of [[Number.MAX_VALUE, 0, Number.MAX_VALUE, 1], [NaN, 0, 1, 1], [0, 0, Infinity, 1], [0, '1', 1, 1], { x0: 0, y0: 0, x1: NaN, y1: 1 }, { x: 0, y: 0, w: -Infinity, h: 1 }, [0, 0, 1], 'box', null]) {
      const bad = await openFake(shotInput(), ws, [], { texts: () => [{ text: 'x', box }] });
      await assert.rejects(() => bad.render(0, {}, ['meta']), code('failure.render'), JSON.stringify(box));
      await bad.close();
    }
  });
});

test('S15-7 元数据序列化后严格不超过 65536 字节：超长文字截断、塞不下的文字框丢弃并记账', async () => {
  const contracts = await loadContracts();
  await withTmp(async (ws) => {
    const many = await openFake(shotInput(), ws, [], { texts: () => Array.from({ length: 200 }, (_, i) => ({ id: `t${i}`, text: 'x'.repeat(5000), box: [0, 0, 1, 1] })) });
    const r = await many.render(0, {}, ['meta']);
    const n = metaBytes(r.meta);
    assert.ok(n <= 65536 && n > 65536 - 1500, `装得太满或太空：${n}`);
    assert.ok(r.meta.texts.length > 0 && r.meta.texts.length < 200);
    assert.ok(r.meta.texts.every((t) => [...t.text].length <= 1024));
    assert.deepEqual(r.meta.ext['legacy-page.texts-trimmed'], { truncated: r.meta.texts.length, dropped: 200 - r.meta.texts.length });
    assert.deepEqual(problemsOf(contracts.validate(r.meta)), []);
    await many.close();

    const cjk = await openFake(shotInput(), ws, [], { texts: () => [{ text: '北'.repeat(100000), box: [0, 0, 1, 1] }, ...Array.from({ length: 5000 }, () => ({ text: '冥', box: [0, 0, 1, 1] }))] });
    const c = await cjk.render(0, {}, ['color', 'meta']);
    assert.ok(metaBytes(c.meta) <= 65536);
    assert.equal([...c.meta.texts[0].text].length, 1024);
    await cjk.close();

    const few = await openFake(shotInput(), ws);
    assert.equal((await few.render(0, {}, ['meta'])).meta.ext, undefined);
    await few.close();
  });
});

test('S15-8 写层文件只落在工作区内：镜头标识不合法、符号链接逃逸都拒掉，外面不留文件', async () => {
  await withTmp(async (ws) => {
    for (const id of ['../x', 'A', 'a/b', 'film', '', 'a b', '-a']) {
      await assert.rejects(() => openFake(withShot({ id }), ws), code('usage.bad-argument'), `shot.id=${JSON.stringify(id)}`);
    }
    const work = path.join(ws, 'work'), outside = path.join(ws, 'outside');
    fs.mkdirSync(work);
    fs.mkdirSync(outside);

    const input = shotInput();
    const stable = await openFake(input, path.join(ws, 'stable'));
    input.shot.id = 'renamed';
    const frame = await stable.render(3, {}, ['color']);
    assert.equal(frame.layers.color.file, 's01/000003/color.f32');
    assert.equal(frame.meta.shot, 's01');
    await stable.close();

    // 镜头目录本身是指向外面的符号链接
    fs.symlinkSync(outside, path.join(work, 's01'));
    const s = await openFake(shotInput(), work);
    await assert.rejects(() => s.render(0, {}, ['color']), code('usage.bad-argument'));
    assert.deepEqual(fs.readdirSync(outside), []);
    await s.close();
    fs.rmSync(path.join(work, 's01'));

    // 帧目录是符号链接
    fs.mkdirSync(path.join(work, 's01'));
    fs.symlinkSync(outside, path.join(work, 's01', '000001'));
    const s2 = await openFake(shotInput(), work);
    await assert.rejects(() => s2.render(1, {}, ['color']), code('usage.bad-argument'));
    assert.deepEqual(fs.readdirSync(outside), []);

    // 目标文件是符号链接：不跟着写到外面去
    fs.mkdirSync(path.join(work, 's01', '000002'));
    const victim = path.join(outside, 'victim.txt');
    fs.writeFileSync(victim, 'keep');
    fs.symlinkSync(victim, path.join(work, 's01', '000002', 'color.f32'));
    await assert.rejects(() => s2.render(2, {}, ['color']), code('usage.bad-argument'));
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');

    // 正常帧照写，工作区本身是符号链接也行（真实路径在它里面）
    const link = path.join(ws, 'work-link');
    fs.symlinkSync(work, link);
    const s3 = await openFake(shotInput(), link);
    const r = await s3.render(4, {}, ['color']);
    assert.ok(fs.existsSync(path.join(work, r.layers.color.file)));
    await s2.close();
    await s3.close();
  });
});

test('S15-9 杀变异断言：低亮 sRGB 线性段、帧号越界、关后拒用、shot.in 偏移、像素摘要', async () => {
  // 码值 5 落在 c <= 0.04045 的线性段，两支差约 2.2e-4，阈值变异必被抓到；码值 10 紧贴阈值，两支差 < 1e-6
  for (const v of [0, 5, 10]) assert.ok(Math.abs(legacyPage.SRGB_TO_LINEAR[v] - v / 255 / 12.92) < 1e-6, `码值 ${v}`);
  assert.ok(Math.abs(legacyPage.SRGB_TO_LINEAR[11] - ((11 / 255 + 0.055) / 1.055) ** 2.4) < 1e-7);
  assert.equal(legacyPage.SRGB_TO_LINEAR[255], 1);

  await withTmp(async (ws) => {
    const log = [];
    const s = await openFake(shotInput(), ws, log, { fill: () => [5, 10, 11] });
    const r = await s.render(0, {}, ['color']);
    const bytes = fs.readFileSync(path.join(ws, r.layers.color.file));
    const px = new Float32Array(bytes.buffer, bytes.byteOffset, 4);
    assert.ok(Math.abs(px[0] - 5 / 255 / 12.92) < 1e-6);
    assert.ok(Math.abs(px[1] - 10 / 255 / 12.92) < 1e-6);
    assert.ok(Math.abs(px[2] - srgbToLinear(11)) < 1e-6);

    for (const f of [-1, 12, 1.5, NaN, '0']) await assert.rejects(() => s.render(f, {}, ['meta']), code('usage.bad-argument'), `f=${f}`);
    await assert.rejects(() => s.query(-1, { kind: 'bbox3d', of: [] }), code('usage.bad-argument'));
    await s.close();
    await assert.rejects(() => s.render(0, {}, ['meta']), code('usage.bad-argument'));
    await assert.rejects(() => s.query(0, { kind: 'bbox3d', of: [] }), code('usage.bad-argument'));

    // shot.in = 24：局部第 0 帧是全片第 24 帧，页面拿到 24 / fps
    const logIn = [];
    const s24 = await openFake(withShot({ in: 24, out: 36 }, { frames: 36 }), ws, logIn);
    const m = await s24.render(0, {}, ['color', 'meta']);
    assert.deepEqual(renders(logIn), [24 / 24]);
    assert.equal(m.meta.frame, 24);
    assert.equal(m.meta.shotFrame, 0);
    await s24.close();
  });

  // 像素摘要：只认 RGB 三个通道、随像素变、与独立算法一致
  const rgba = Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 0]);
  const expected = `sha256:${createHash('sha256').update(Buffer.concat([Buffer.from('RGB8 2x1\n'), Buffer.from([1, 2, 3, 4, 5, 6])])).digest('hex')}`;
  assert.equal(legacyPage.pixelHash(rgba, [2, 1]), expected);
  const changed = Uint8Array.from(rgba);
  changed[5] = 9;
  assert.notEqual(legacyPage.pixelHash(changed, [2, 1]), expected);
  const alphaOnly = Uint8Array.from(rgba);
  alphaOnly[7] = 7;
  assert.equal(legacyPage.pixelHash(alphaOnly, [2, 1]), expected);
  const zeros = legacyPage.pixelHash(new Uint8Array(8), [2, 1]);
  assert.notEqual(zeros, expected);
  assert.match(zeros, SHA);
  await withTmp(async (ws) => {
    const s = await openFake(shotInput(), ws);
    const a = (await s.render(0, {}, ['color', 'meta'])).meta.ext[HASH_KEY];
    const b = (await s.render(5, {}, ['color', 'meta'])).meta.ext[HASH_KEY];
    assert.match(a, SHA);
    assert.notEqual(a, b);
    assert.notEqual(a, legacyPage.pixelHash(new Uint8Array(16 * 16 * 4), [16, 16]));
    await s.close();
  });
});

// 真实子进程验证生命周期：进程必须自己退出（不靠外层信号强杀）
const childRun = (script, env) => {
  const started = Date.now();
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 5000, cwd: REPO });
  return { ...r, ms: Date.now() - started };
};
const INDEX_URL = pathToFileURL(path.join(REPO, 'beiming/sources/legacy-page/index.mjs')).href;
const CHILD = `
const lp = await import(process.env.LP_INDEX);
const input = { film: 'fx', output: { size: [320, 180], fps: '24/1' }, shot: { id: 's01', in: 0, out: 24, source: 'legacy-page', host: 'page', mode: 'native-code', entry: 'index.html', colorRef: 'display', seed: 1 } };
try {
  const s = await lp.open(input, { lock: null, tier: 'final', workspace: process.env.LP_WS, filmDir: process.env.LP_FILM });
  const r = await s.render(0, {}, ['color', 'meta']);
  await s.close();
  console.log(JSON.stringify({ ok: true, hash: r.meta.ext['${HASH_KEY}'] }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, code: e.code, message: e.message }));
}
`;

test('S15-10a 浏览器起不来（空浏览器缓存）：open 抛 env.browser-launch，子进程 5 秒内自行退出', async () => {
  await withTmp(async (ws) => {
    const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(ws, 'empty-browsers'), LP_INDEX: INDEX_URL, LP_WS: ws, LP_FILM: path.join(REPO, 'tests/golden/fixtures/pure') };
    delete env.BEIMING_CHROME;
    fs.mkdirSync(env.PLAYWRIGHT_BROWSERS_PATH);
    const r = childRun(CHILD, env);
    assert.equal(r.signal, null, `被信号杀掉：${r.signal}（挂住了）\n${r.stderr}`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout.trim().split('\n').at(-1)).code, 'env.browser-launch', r.stdout);
    assert.ok(r.ms < 5000, `退出用了 ${r.ms} ms`);
  });
});

test('S15-10b 正常开页面渲 1 帧再 close：子进程退出码 0，全程 5 秒内自行退出，帧哈希与金标一致', async (t) => {
  await withTmp(async (ws) => {
    const env = { ...process.env, LP_INDEX: INDEX_URL, LP_WS: ws, LP_FILM: path.join(REPO, 'tests/golden/fixtures/pure') };
    const r = childRun(CHILD, env);
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1) || '{}');
    assert.equal(r.signal, null, `被信号杀掉：${r.signal}（挂住了）\n${r.stderr}`);
    assert.equal(r.status, 0, r.stderr);
    if (out.code === 'env.browser-launch') return t.skip(`本机起不了浏览器：${out.message}`);
    assert.equal(out.ok, true, r.stdout);
    assert.match(out.hash, SHA);
    assert.ok(r.ms < 5000, `开页、渲染、关闭至退出共用 ${r.ms} ms`);
    if (process.platform === 'darwin') {
      const golden = readJson(path.join(REPO, 'tests/golden/darwin-metal/manifest.json')).sets.fixtures.frames.find((f) => f.id === 'fixture:pure@320x180#f=0');
      assert.equal(out.hash, `sha256:${golden['pixelSha256']}`);
    }
  });
});

test('S15-10c 两个真实会话共用静态服务，最后一个会话关闭后才停止监听', async (t) => {
  await withTmp(async (ws) => {
    const env = { lock: null, tier: 'final', workspace: ws, filmDir: path.join(REPO, 'tests/golden/fixtures/pure') };
    const requests = channel('http.server.request.start');
    let server;
    const onRequest = (event) => { server ??= event.server; };
    requests.subscribe(onRequest);
    const sessions = [];
    try {
      const opened = await Promise.allSettled([legacyPage.open(shotInput(), env), legacyPage.open(shotInput(), env)]);
      for (const result of opened) if (result.status === 'fulfilled') sessions.push(result.value);
      if (opened.every((r) => r.status === 'rejected' && r.reason?.code === 'env.browser-launch')) return t.skip('本机起不了浏览器');
      for (const result of opened) if (result.status === 'rejected') throw result.reason;
      assert.equal(legacyPage.browserSessions(), 2);
      await sessions[0].close();
      assert.equal(legacyPage.browserSessions(), 1);
      assert.equal(server.listening, true);
      const { layers } = await sessions[1].render(1, {}, ['color']);
      assert.match(layers.color.hash, SHA);
      await sessions[1].close();
      assert.equal(legacyPage.browserSessions(), 0);
      assert.equal(server.listening, false);
    } finally {
      requests.unsubscribe(onRequest);
      await Promise.all(sessions.map((s) => s.close()));
    }
  });
});

// —— 基线核对：缺集合、缺 env.three、空帧表、少帧、摘要不对一律 ok: false ——
const GOLDEN_MANIFEST = 'tests/golden/darwin-metal/manifest.json';
const withGoldenRoot = (edit, fn) => withTmp(async (root) => {
  const manifest = readJson(path.join(REPO, GOLDEN_MANIFEST));
  edit(manifest);
  fs.mkdirSync(path.join(root, path.dirname(GOLDEN_MANIFEST)), { recursive: true });
  fs.writeFileSync(path.join(root, GOLDEN_MANIFEST), JSON.stringify(manifest));
  return fn(root);
});

test('S15-11a 金标基线核对：缺集合、缺 env.three、three 不符、空帧表一律 ok: false 并写明原因，绝不放行', async () => {
  const golden = legacyPage.getBaselineHashes('beiming-10s');
  const verify = (repoRoot, rendered = golden) => legacyPage.verifyBaselineHashes('beiming-10s', rendered, { baseline: 'golden', repoRoot });
  const cases = [
    ['缺 beiming-detail 集合', (m) => { delete m.sets['beiming-detail']; }, /beiming-detail/],
    ['缺 beiming-core 集合', (m) => { delete m.sets['beiming-core']; }, /beiming-core/],
    ['两个集合都没有', (m) => { delete m.sets['beiming-detail']; delete m.sets['beiming-core']; }, /beiming-(core|detail)/],
    ['没有 sets', (m) => { delete m.sets; }, /beiming-(core|detail)/],
    ['一个集合缺 env.three', (m) => { delete m.sets['beiming-detail'].env.three; }, /three/],
    ['一个集合没有 env', (m) => { delete m.sets['beiming-detail'].env; }, /three/],
    ['两个集合都缺 env.three', (m) => { delete m.sets['beiming-detail'].env.three; delete m.sets['beiming-core'].env.three; }, /three/],
    ['env.three 版本不符', (m) => { m.sets['beiming-core'].env.three = '0.169.0'; }, /0\.169\.0/],
    ['两个集合帧表都空', (m) => { m.sets['beiming-core'].frames = []; m.sets['beiming-detail'].frames = []; }, /empty-baseline/],
    ['一个集合帧表空', (m) => { m.sets['beiming-detail'].frames = []; }, /empty-baseline/],
  ];
  for (const [name, edit, reason] of cases) {
    await withGoldenRoot(edit, (root) => {
      const r = verify(root);
      assert.equal(r.ok, false, name);
      assert.match(r.reason, reason, name);
    });
  }
  // 基线完好但出片什么都没有：全是 missing
  const empty = verify(REPO, {});
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.missing.sort(), Object.keys(golden).sort());
  // 出片摘要写成不合格式
  const [k] = Object.keys(golden);
  const badFormat = verify(REPO, { ...golden, [k]: 'nope' });
  assert.equal(badFormat.ok, false);
  assert.deepEqual(badFormat.mismatched, [k]);
  // 没有基线的作品不放行
  assert.equal(legacyPage.verifyBaselineHashes('chendu', {}, { baseline: 'golden' }).ok, false);
  assert.throws(() => legacyPage.verifyBaselineHashes('nope', {}), RangeError);
  assert.throws(() => legacyPage.verifyBaselineHashes('du', {}, { baseline: 'weird' }), RangeError);
});

const goodEnv = { platform: 'darwin', arch: 'arm64', three: '0.170.0', renderer: 'GPU-X' };
const h = (n) => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const publishedFile = (root, works) => {
  const file = path.join(root, 'published.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 'legacy-page-baselines/1', works }));
  return file;
};

test('S15-11b 已发布作品基线核对：缺作品、缺 env.three、空帧表、少帧、摘要不匹配、环境不符一律 ok: false', async () => {
  await withTmp(async (root) => {
    const work = (over = {}) => ({ env: goodEnv, frames: [{ id: 'f000000', frame: 0, hash: h(1) }, { id: 'f000010', frame: 10, hash: h(2) }], ...over });
    const rendered = { f000000: h(1), f000010: h(2) };
    const verify = (works, got = rendered, extra = {}) => legacyPage.verifyBaselineHashes('beiming-10s', got, { baselinesFile: publishedFile(root, works), env: goodEnv, ...extra });

    assert.deepEqual(verify({ 'beiming-10s': work() }), { ok: true, mismatched: [], missing: [] });
    assert.equal(verify({ 'beiming-10s': work() }, { ...rendered, extra: h(9) }).ok, true);

    const no = verify({});
    assert.equal(no.ok, false);
    assert.equal(no.reason, 'no-baseline');
    assert.equal(legacyPage.verifyBaselineHashes('beiming-10s', rendered, { baselinesFile: path.join(root, 'absent.json') }).reason, 'no-baseline');

    const noThree = verify({ 'beiming-10s': work({ env: { platform: 'darwin', arch: 'arm64', renderer: 'GPU-X' } }) });
    assert.equal(noThree.ok, false);
    assert.match(noThree.reason, /three/);
    assert.equal(verify({ 'beiming-10s': work({ env: undefined }) }).ok, false);
    const wrongThree = verify({ 'beiming-10s': work({ env: { ...goodEnv, three: '0.169.0' } }) });
    assert.equal(wrongThree.ok, false);
    assert.match(wrongThree.reason, /0\.169\.0/);
    // 不给出片环境时，基线自己的 three 不符也得拦住（不能只靠 env-mismatch 兜）
    const wrongThreeNoEnv = verify({ 'beiming-10s': work({ env: { ...goodEnv, three: '0.169.0' } }) }, rendered, { env: undefined });
    assert.equal(wrongThreeNoEnv.ok, false);
    assert.match(wrongThreeNoEnv.reason, /three-mismatch.*0\.169\.0/);

    const repeated = work();
    repeated.frames.push({ ...repeated.frames[0], frame: 1 });
    assert.equal(verify({ 'beiming-10s': repeated }).ok, false);
    const emptyFrames = verify({ 'beiming-10s': work({ frames: [] }) });
    assert.equal(emptyFrames.ok, false);
    assert.match(emptyFrames.reason, /empty-baseline/);
    assert.equal(verify({ 'beiming-10s': work({ frames: undefined }) }).ok, false);
    assert.equal(verify({ 'beiming-10s': work({ frames: [{ id: 'f000000', frame: 0, hash: 'oops' }] }) }).ok, false);
    // 基线里的摘要不合格式：出片交回一模一样的坏值也不放行
    const badHash = verify({ 'beiming-10s': work({ frames: [{ id: 'f000000', frame: 0, hash: 'oops' }] }) }, { f000000: 'oops' });
    assert.equal(badHash.ok, false);
    assert.match(badHash.reason, /bad-baseline/);

    const few = verify({ 'beiming-10s': work() }, { f000000: h(1) });
    assert.equal(few.ok, false);
    assert.deepEqual(few.missing, ['f000010']);
    const all = verify({ 'beiming-10s': work() }, {});
    assert.equal(all.ok, false);
    assert.deepEqual(all.missing, ['f000000', 'f000010']);
    const mism = verify({ 'beiming-10s': work() }, { f000000: h(1), f000010: h(3) });
    assert.equal(mism.ok, false);
    assert.deepEqual(mism.mismatched, ['f000010']);
    assert.deepEqual(mism.missing, []);

    // 基线绑定出片环境：平台、架构、渲染器、three 任何一项不同都不算过
    for (const patch of [{ platform: 'linux' }, { arch: 'x64' }, { renderer: 'GPU-Y' }, { three: '0.171.0' }]) {
      const r = verify({ 'beiming-10s': work() }, rendered, { env: { ...goodEnv, ...patch } });
      assert.equal(r.ok, false, JSON.stringify(patch));
      assert.match(r.reason, /env-mismatch/);
    }
  });
});

test('S15-11d 读取冻结风格参照，金标文件或摘要缺失时对账失败', async () => {
  const style = { baseline: 'style' };
  const ref = readJson(path.join(REPO, 'docs/style-baselines/beiming-original@v1/darwin-metal.json'));
  const hashes = legacyPage.getBaselineHashes('beiming-10s', style);
  const frames = ref.frames.filter((f) => f.page === 'film' && !f.query);
  assert.deepEqual(Object.keys(hashes).sort(), frames.map((f) => f.id).sort());
  assert.equal(legacyPage.verifyBaselineHashes('beiming-10s', hashes, style).ok, true);
  assert.equal(legacyPage.verifyBaselineHashes('du', {}, style).ok, false);
  await withTmp(async (repoRoot) => {
    for (const baseline of ['golden', 'style']) {
      const r = legacyPage.verifyBaselineHashes('beiming-10s', {}, { baseline, repoRoot });
      assert.equal(r.ok, false);
      assert.match(r.reason, /missing/);
    }
  });
  await withGoldenRoot((m) => {
    const rows = m.sets['beiming-core'].frames;
    const i = rows.findIndex((f) => f.page === 'film' && !f.query);
    rows[i] = { id: rows[i].id, page: 'film' };
  }, (repoRoot) => {
    const opts = { repoRoot, baseline: 'golden' };
    assert.equal(legacyPage.verifyBaselineHashes('beiming-10s', legacyPage.getBaselineHashes('beiming-10s', opts), opts).ok, false);
  });
});

test('S15-11c published-baselines.json：三部作品都有实测基线（env 完整、帧表非空、摘要合格式），按自己的记录核对通过', () => {
  const file = path.join(REPO, 'beiming/sources/legacy-page/baselines/published-baselines.json');
  const doc = readJson(file);
  assert.deepEqual(Object.keys(doc.works).sort(), [...legacyPage.PUBLISHED_WORKS].sort());
  for (const [workId, w] of Object.entries(doc.works)) {
    for (const k of ['platform', 'arch', 'renderer']) assert.ok(typeof w.env[k] === 'string' && w.env[k], `${workId}.env.${k}`);
    assert.equal(w.env.three, '0.170.0');
    assert.ok(w.frames.length >= 3, `${workId} 帧太少`);
    const film = readJson(path.join(REPO, 'films', workId, 'film.json'));
    assert.equal(new Set(w.frames.map((f) => f.id)).size, w.frames.length);
    for (const f of w.frames) {
      assert.match(f.hash, SHA);
      assert.equal(f.id, `f${String(f.frame).padStart(6, '0')}`);
      assert.ok(Number.isInteger(f.frame) && f.frame >= 0 && f.frame < film.output.frameCount);
    }
    // 每个镜头至少一帧，含全片首帧和末帧
    for (const s of film.shots) assert.ok(w.frames.some((f) => f.frame >= s.in && f.frame < s.out), `${workId} 镜头 ${s.id} 没有基线帧`);
    assert.ok(w.frames.some((f) => f.frame === 0) && w.frames.some((f) => f.frame === film.output.frameCount - 1));
    const rendered = Object.fromEntries(w.frames.map((f) => [f.id, f.hash]));
    assert.deepEqual(legacyPage.verifyBaselineHashes(workId, rendered, { env: w.env }), { ok: true, mismatched: [], missing: [] });
    assert.equal(legacyPage.verifyBaselineHashes(workId, {}, { env: w.env }).ok, false);
  }
});

test('S15-12a rebuildAndVerifyWork（假页面）：按基线帧表逐镜头开会话、按 shot.in + f 取时刻、对账并关净会话', async () => {
  await withTmp(async (root) => {
    const fill = (t) => [Math.round(t * 10) % 256, 40, 200];
    const size = [960, 520]; // draft：beiming-10s 的 1920x1040 缩放 0.5
    const hashAt = (t) => legacyPage.pixelHash(Uint8Array.from({ length: size[0] * size[1] * 4 }, (_, i) => [...fill(t), 255][i & 3]), size);
    const frames = [0, 40, 96, 239].map((frame) => ({ id: `f${String(frame).padStart(6, '0')}`, frame, hash: hashAt(frame / 24) }));
    const env = { ...goodEnv, platform: process.platform, arch: process.arch, renderer: 'SwiftShader-Test' };
    const baselinesFile = publishedFile(root, { 'beiming-10s': { env, frames } });
    const over = { fill, gpu: env.renderer };
    const run = (file = baselinesFile, o = over) => {
      const log = [];
      return legacyPage.rebuildAndVerifyWork('beiming-10s', { driver: fakeDriver(log, o), baselinesFile: file, tier: 'draft', workspace: path.join(root, 'ws') }).then((r) => ({ r, log }));
    };

    const { r, log } = await run();
    assert.deepEqual(r, { ok: true, mismatched: [], missing: [] });
    assert.deepEqual(renders(log), [0, 40 / 24, 96 / 24, 239 / 24]);
    assert.equal(log.filter((x) => x?.open).length, 3, '三个镜头各开一个会话');
    assert.equal(log.filter((x) => x === 'close').length, 3);
    assert.equal(log.find((x) => x?.open).open.frameCount, 240);
    assert.equal(fs.existsSync(path.join(root, 'ws')), true, '调用方给的工作区不删');

    // 截图后模拟颜色层写错，重建须从落盘颜色发现差异。
    const workspace = path.join(root, 'damaged');
    const colorFile = path.join(workspace, 'a/000000/color.f32');
    const damaged = fakeDriver([], { ...over, texts: () => {
      if (fs.existsSync(colorFile)) {
        const fd = fs.openSync(colorFile, 'r+');
        try { fs.writeSync(fd, Float32Array.of(1)); } finally { fs.closeSync(fd); }
      }
      return [];
    } });
    const detected = await legacyPage.rebuildAndVerifyWork('beiming-10s', { driver: damaged, baselinesFile, tier: 'draft', workspace });
    assert.deepEqual(detected.mismatched, ['f000000']);

    // 篡改一帧摘要：对账抓得出
    const bad = publishedFile(path.join(root), { 'beiming-10s': { env, frames: frames.map((f, i) => (i === 1 ? { ...f, hash: h(7) } : f)) } });
    const res = (await run(bad)).r;
    assert.equal(res.ok, false);
    assert.deepEqual(res.mismatched, ['f000040']);

    // 渲染器名对不上基线：环境不符
    const mismatchEnv = (await run(baselinesFile, { ...over, gpu: 'GPU-Z' })).r;
    assert.equal(mismatchEnv.ok, false);
    assert.match(mismatchEnv.reason, /env-mismatch/);

    // 渲到一半失败：会话仍然关净，没给工作区时临时目录被清理
    const logF = [];
    const broken = fakeDriver(logF, over);
    const origOpen = broken.open;
    broken.open = async (o) => { const p = await origOpen(o); const r0 = p.render; p.render = async (t) => { if (t > 1) throw new Error('boom'); return r0(t); }; return p; };
    const tmpBefore = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('bm-legacy-rebuild-'));
    await assert.rejects(() => legacyPage.rebuildAndVerifyWork('beiming-10s', { driver: broken, baselinesFile, tier: 'draft' }), /boom/);
    assert.equal(logF.filter((x) => x?.open).length, logF.filter((x) => x === 'close').length);
    assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('bm-legacy-rebuild-')), tmpBefore);

    // 没有基线的作品：不开任何会话
    const logN = [];
    const none = await legacyPage.rebuildAndVerifyWork('du', { driver: fakeDriver(logN), baselinesFile, tier: 'draft' });
    assert.equal(none.ok, false);
    assert.equal(none.reason, 'no-baseline');
    assert.equal(logN.length, 0);
    await assert.rejects(() => legacyPage.rebuildAndVerifyWork('nope', {}), RangeError);
  });
});

test('S15-12c 真实页面重建三部作品：从 films/<作品> + 锁文件开页出帧，与 published-baselines.json 逐帧一致', async (t) => {
  for (const workId of legacyPage.PUBLISHED_WORKS) {
    let r;
    try { r = await legacyPage.rebuildAndVerifyWork(workId); } catch (e) {
      if (String(e?.code).startsWith('env.')) return t.skip(`本机起不了浏览器：${e.message}`);
      throw e;
    }
    if (!r.ok && /env-mismatch/.test(r.reason ?? '')) return t.skip(`基线绑定另一台机器的出片环境：${r.reason}`);
    assert.deepEqual(r, { ok: true, mismatched: [], missing: [] }, workId);
  }
});

for (const workId of legacyPage.PUBLISHED_WORKS) {
  test(`S15-13 旧截图链独立复算 ${workId} 的全部登记帧`, async (t) => {
    const { problem, env, list: frames } = publishedBaseline(workId);
    assert.equal(problem, undefined, problem);
    const mismatch = staticEnvMismatch(env);
    if (mismatch) return t.skip(mismatch);
    const dir = workId === 'beiming-10s' ? '.' : path.join('films', workId);
    await withTmp(async (out) => {
      for (const batch of [frames.slice(0, 1), frames.slice(1)]) {
        if (!batch.length) continue;
        const r = spawnSync(process.execPath, ['engine/render/still.mjs', dir, '--frame', batch.map((f) => f.frame).join(','), '--out', out], { cwd: REPO, encoding: 'utf8', timeout: 120000 });
        if (r.status === 3) return t.skip(`本机渲不了：${r.stderr.slice(0, 200)}`);
        assert.equal(r.status, 0, r.stderr);
        const gpu = readJson(path.join(out, 'still.run.json')).gpu?.renderer;
        if (gpu !== env.renderer) return t.skip(`基线绑定另一出片环境，本机渲染器为 ${gpu}`);
      }
      const png = await import('../../../tools/baseline/lib/png.mjs');
      for (const f of frames) {
        const img = png.decodePNG(fs.readFileSync(path.join(out, `${f.id}.png`)));
        assert.equal(`sha256:${png.pixelSha256(img)}`, f.hash, f.id);
      }
    });
  });
}

test('S15-R3 静态环境不符时零开页，实测 GPU 不符时渲一帧即关闭', async () => {
  await withTmp(async (root) => {
    const frames = [0, 40, 96].map((frame) => ({ id: `f${String(frame).padStart(6, '0')}`, frame, hash: h(1) }));
    const env = { ...goodEnv, platform: process.platform, arch: process.arch, renderer: 'SwiftShader-Test' };
    const run = async (work, reason) => {
      const log = [];
      const r = await legacyPage.rebuildAndVerifyWork('beiming-10s', {
        driver: fakeDriver(log, { gpu: 'GPU-X' }), baselinesFile: publishedFile(root, { 'beiming-10s': work }), tier: 'draft',
      });
      assert.match(r.reason, reason);
      assert.deepEqual(r, { ok: false, reason: r.reason, missing: [], mismatched: [] });
      return log;
    };
    for (const patch of [{ platform: 'other' }, { arch: 'other' }]) {
      assert.deepEqual(await run({ env: { ...env, ...patch }, frames }, /^env-mismatch/), []);
    }

    const log = await run({ env, frames }, /^env-mismatch.*renderer/);
    assert.equal(log.filter((x) => x?.open).length, 1);
    assert.deepEqual(renders(log), [0]);
    assert.equal(log.at(-1), 'close');

    const otherEnv = { ...env, platform: 'other' };
    for (const [work, reason] of [
      [{ env: otherEnv }, /^empty-baseline/],
      [{ env: otherEnv, frames: [] }, /^empty-baseline/],
      [{ env: otherEnv, frames: [frames[0], { ...frames[1], hash: 'bad' }] }, /^bad-baseline/],
      [{ env: otherEnv, frames: [{ ...frames[0], hash: [h(1)] }] }, /^bad-baseline/],
      [{ env: { ...otherEnv, three: undefined }, frames }, /^three-mismatch/],
      [{ env: { ...otherEnv, three: '0.169.0' }, frames }, /^three-mismatch/],
    ]) assert.deepEqual(await run(work, reason), []);

    const angle = process.env.BEIMING_ANGLE;
    try {
      for (const value of ['swiftshader', ' SwiftShader ']) {
        process.env.BEIMING_ANGLE = value;
        assert.deepEqual(await run({ env: { ...env, renderer: 'GPU-X' }, frames }, /^env-mismatch.*swiftshader/i), []);
      }
    } finally {
      if (angle === undefined) delete process.env.BEIMING_ANGLE;
      else process.env.BEIMING_ANGLE = angle;
    }
  });
});
