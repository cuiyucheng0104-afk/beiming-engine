// S15 单测（Red -> Green）：sources/legacy-page 能力声明（limited、sceneQuery 为空）、六函数接口、文字框元数据与已发布作品锁文件及基线哈希核对
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadContracts } from '../../kernel/contracts/validate.mjs';
import { upgradeFilmV2ToV3 } from '../../kernel/film-upgrade.mjs';
import * as legacyPage from './index.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// validate 交回 { schemaErrors, violations }：两样都空才算过
const problemsOf = (r) => [...r.schemaErrors, ...Object.entries(r.violations).map(([id, p]) => `${id}: ${p[0]}`)];

// 确定性旧页面驱动：红通道随时刻变，其余固定；文字框按页面约定 v1 的 { text, box: [x, y, w, h], alpha }
const fakeDriver = (log = []) => ({
  async open(opts) {
    log.push({ open: opts });
    const [w, h] = opts.size;
    return {
      async render(t) {
        log.push({ render: t });
        const rgba = new Uint8Array(w * h * 4);
        const v = Math.min(255, Math.round(128 + t * 24));
        for (let i = 0; i < rgba.length; i += 4) { rgba[i] = v; rgba[i + 1] = 64; rgba[i + 2] = 255; rgba[i + 3] = 255; }
        return rgba;
      },
      async texts(t) {
        log.push({ texts: t });
        return [
          { id: 'title', text: '北冥', box: [2, 2, w - 4, h - 4], alpha: 1 },
          { text: '隐', box: [0, 0, 1, 1], alpha: 0 },
          { text: '', box: [0, 0, 1, 1], alpha: 1 },
        ];
      },
      async close() { log.push('close'); },
    };
  },
});

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
  assert.deepEqual(legacyPage.verifyBaselineHashes('beiming-10s', baseline), { ok: true, mismatched: [], missing: [] });

  const [firstKey, secondKey] = Object.keys(baseline);
  const tampered = { ...baseline, [firstKey]: 'sha256:' + '0'.repeat(64) };
  delete tampered[secondKey];
  const failCheck = legacyPage.verifyBaselineHashes('beiming-10s', tampered);
  assert.equal(failCheck.ok, false);
  assert.deepEqual(failCheck.mismatched, [firstKey]);
  assert.deepEqual(failCheck.missing, [secondKey]);

  assert.equal(legacyPage.verifyBaselineHashes('chendu', {}).reason, 'no-baseline');
  assert.throws(() => legacyPage.loadLegacyLock('nope'), RangeError);
});
