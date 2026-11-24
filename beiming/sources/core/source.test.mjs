// 核心帧源接口（source.mjs、caps.mjs）的测试：能力声明过帧源接口契约；成片档与快门角大于 0 被拒；一次 render 的元数据过每帧元数据契约、
// 层引用与帧源核对记录过帧源接口契约（F1、F17、F21、F27 等）；从 Blender 导出的场景包（BEIMING_CORE_TEST_PACKS）经帧源出一帧，
// 每个通道的文件字节数对、有限、不全为同一个值，编号都在实体清单里；一致性探针（probe.mjs）七项都过。
// 要渲染程序与显卡的几条：BEIMING_CHASSIS_E2E=1 时现编、渲不出来算失败；否则只用编好的那份，没有或渲不出来就跳过。
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { loadContracts } from '../../kernel/contracts/validate.mjs';
import { caps } from './caps.mjs';
import { OUT, buildRenderer, sourceKey } from './chassis/build.mjs';
import { platesPack, writePack } from './chassis/scenepack.mjs';
import { runProbe } from './probe.mjs';
import { planRender, startSource } from './source.mjs';

const E2E = process.env.BEIMING_CHASSIS_E2E === '1';
const EXE = process.platform === 'win32' ? '.exe' : '';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-core-source-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const { validate } = await loadContracts();
const ok = (v) => assert.deepEqual({ schemaErrors: v.schemaErrors, violations: v.violations }, { schemaErrors: [], violations: {} });
const sha = (file) => `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
const ALL = ['meta', 'color', 'depth', 'objectId', 'normal', 'denoiseAlbedo', 'denoiseNormal'];

let n = 0;
const fresh = (name) => { const d = path.join(TMP, `${name}${n++}`); fs.mkdirSync(d); return d; };
const shotOf = (entry, extra = {}) => ({ id: 's01', in: 0, out: 1, source: 'core', host: 'offscreen', mode: 'build-script', entry, colorRef: 'scene', seed: 7, ...extra });
const inputOf = (entry, size = [64, 36], extra) => ({ film: 'core-test', output: { size, fps: '24/1' }, shot: shotOf(entry, extra) });
const envOf = (tier = 'draft') => ({ lock: null, tier, workspace: fresh('ws'), filmDir: TMP });
const codeOf = async (p) => { try { await p; return null; } catch (e) { return e.code ?? e.message; } };

function renderer(t) {
  if (E2E) return buildRenderer().bin;
  const bin = path.join(OUT, 'bin', `core-render-${sourceKey([])}${EXE}`);
  if (fs.existsSync(bin)) return bin;
  t.skip('没有编好的渲染程序（设 BEIMING_CHASSIS_E2E=1 现编）');
  return null;
}
/** 渲一次；渲不出来（没有显卡）时 E2E 算失败，否则跳过 */
async function rendered(t, session, f, opts, want) {
  try { return await session.render(f, opts, want); } catch (e) {
    if (E2E || e.code) throw e;
    t.skip(`渲不出来（多半是没有显卡）：${e.message.split('\n').at(-1)}`);
    return null;
  }
}

test('能力声明：过帧源接口契约的结构定义与判定函数（含 F10、F15、F22、F29），落在登记表 core 一项之内', () => {
  const c = caps('0123456789abcdef');
  ok(validate(c));
  assert.equal(c.outputs.motion, false, 'motion 照实写交不出');
  assert.equal(c.motionBlur.mode, 'native');
});

test('成片档被拒：env.tier 是 final 时 open 报带码的错，信息里有「还没过门」；没要渲染程序就拒', async () => {
  const src = await startSource({ bin: path.join(TMP, 'no-such-renderer') });
  const e = await src.open(inputOf('pack'), envOf('final')).then(() => null, (x) => x);
  assert.equal(e?.code, 'contract.unsupported-mode');
  assert.match(e.message, /还没过门/);
});

test('快门角大于 0 报 contract.unsupported-option；快门角 0 配多个子帧报 contract.shutter-conflict；没声明的输出报 contract.unsupported-output', () => {
  const c = caps('x'), shot = shotOf('pack');
  const code = (f) => { try { f(); return null; } catch (e) { return e.code; } };
  assert.equal(code(() => planRender(c, shot, [64, 36], 'draft', { shutter: { angleDeg: 90, samples: 1 } }, ['color'], {})), 'contract.unsupported-option');
  assert.equal(code(() => planRender(c, shotOf('pack', { shutter: { angleDeg: 180 } }), [64, 36], 'draft', {}, ['color'], {})), 'contract.unsupported-option');
  assert.match((() => { try { planRender(c, shot, [64, 36], 'draft', { shutter: { angleDeg: 1, samples: 1 } }, ['color'], {}); } catch (e) { return e.message; } })(), /运动模糊还没做/);
  assert.equal(code(() => planRender(c, shot, [64, 36], 'draft', { shutter: { angleDeg: 0, samples: 2 } }, ['color'], {})), 'contract.shutter-conflict');
  assert.equal(code(() => planRender(c, shot, [64, 36], 'draft', {}, ['color', 'motion'], {})), 'contract.unsupported-output');
  assert.equal(code(() => planRender(c, shot, [64, 36], 'draft', { scale: 2 }, ['color'], {})), 'usage.bad-argument');
  assert.deepEqual(planRender(c, shot, [64, 36], 'draft', {}, ['color'], {}).size, [32, 18], '草稿档默认缩放 0.5');
});

test('两块错开的板经帧源接口出一帧：元数据过每帧元数据契约（renderer 是 core），层引用与帧源核对记录过帧源接口契约', async (t) => {
  const bin = renderer(t);
  if (!bin) return;
  const dir = fresh('plates');
  writePack(dir, platesPack());
  const src = await startSource({ bin });
  const [w, h] = [64, 36], env = envOf(), input = inputOf(dir, [w, h], { tiers: { draft: { samples: 8, scale: 1 } } });
  const s = await src.open(input, env);
  const r = await rendered(t, s, 0, {}, ALL);
  if (!r) return;
  // 每帧元数据
  assert.equal(r.meta.source.renderer, 'core');
  ok(validate(r.meta));
  const metaOnly = await s.render(0, {}, ['meta']);
  ok(validate(metaOnly.meta));
  assert.deepEqual(metaOnly.layers, {});
  const metaRow = (call, m, color) => ({
    call, shotFrame: 0, tier: 'draft', metas: 1, metaBytes: Buffer.byteLength(JSON.stringify(m)), metaFilm: m.film, metaShot: m.shot, metaFps: m.fps, metaFrame: m.frame,
    metaShotFrame: m.shotFrame, metaSeed: m.seed, metaSize: m.size, metaTier: m.source.tier, metaSourceId: m.source.id,
    ...(color ? { colorFileHash: sha(path.join(env.workspace, color.file)), colorShape: color.shape, metaHashColor: m.hash.color } : {}),
  });
  ok(validate({ format: 'meta-check/0.1', film: input.film, shot: 's01', start: 0, seed: 7, fps: '24/1', source: 'core', renders: [metaRow(0, r.meta, r.layers.color), metaRow(1, metaOnly.meta)] }));
  // 层引用：每个单独过结构定义与 F21；核对记录里由测试自己重算哈希与字节数
  for (const ref of Object.values(r.layers)) ok(validate(ref, 'source', 'layer-ref.schema.json'));
  const layerRefs = Object.entries(r.layers).map(([output, ref]) => {
    const file = path.join(env.workspace, ref.file);
    return { output, shape: ref.shape, hash: ref.hash, fileHash: sha(file), fileBytes: fs.statSync(file).size };
  });
  const manifest = s.manifest();
  ok(validate(manifest, 'source', 'manifest.schema.json'));
  const q = await s.query(0, { kind: 'bbox3d', of: ['front'] });
  ok(validate(q, 'source', 'query-result.schema.json'));
  const opened = (extra) => ({ hasLock: false, hasSeed: true, usesCards: false, usesAssets: false, host: 'offscreen', mode: 'build-script', ...extra });
  const call = async (want, opts = {}) => {
    try {
      const x = await s.render(0, opts, want);
      return { status: 'ok', meta: Boolean(x.meta), layers: Object.keys(x.layers), metaShutterAngleDeg: x.meta.camera.shutterAngleDeg };
    } catch (e) { return { status: 'error', code: e.code }; }
  };
  const rec = {
    format: 'source-check/0.1', shot: 's01', caps: src.caps(), scenePack: true, manifest,
    opens: [
      opened({ status: 'ok' }),
      opened({ host: 'page', status: 'error', code: await codeOf(src.open(inputOf(dir, [w, h], { host: 'page' }), envOf())) }),
      opened({ hasSeed: false, status: 'error', code: await codeOf(src.open(inputOf(dir, [w, h], { seed: undefined }), envOf())) }),
    ],
    renders: [
      { shotFrame: 0, want: ALL, shutterAngleDeg: 0, size: [w, h], status: 'ok', meta: true, layers: Object.keys(r.layers), layerRefs, metaShutterAngleDeg: r.meta.camera.shutterAngleDeg, colorRef: r.meta.colorRef, shotColorRef: 'scene' },
      { shotFrame: 0, want: ['meta'], shutterAngleDeg: 0, size: [w, h], ...(await call(['meta'])) },
      { shotFrame: 0, want: ['color', 'motion'], shutterAngleDeg: 0, ...(await call(['color', 'motion'])) },
      { shotFrame: 0, want: ['color'], shutterAngleDeg: 0, shutterSamples: 2, ...(await call(['color'], { shutter: { angleDeg: 0, samples: 2 } })) },
      { shotFrame: 0, want: ['color'], shutterAngleDeg: 90, shutterSamples: 1, ...(await call(['color'], { shutter: { angleDeg: 90, samples: 1 } })) },
    ],
    queries: [
      { kind: 'bbox3d', status: 'ok', total: 1, returned: q.items.length },
      { kind: 'intersect', status: 'error', code: await codeOf(s.query(0, { kind: 'intersect', of: ['front'], against: ['back'] })) },
    ],
    badArgs: [
      { call: 'render', arg: 'f', status: 'error', code: await codeOf(s.render(1, {}, ['color'])) },
      { call: 'render', arg: 'want', status: 'error', code: await codeOf(s.render(0, {}, ['color', 'color'])) },
      { call: 'query', arg: 'f', status: 'error', code: await codeOf(s.query(-1, { kind: 'bbox3d', of: ['front'] })) },
    ],
    metaEntities: [{ shotFrame: 0, entities: r.meta.entities.map(({ id, name, class: c }) => ({ id, name, class: c })) }],
  };
  assert.equal(rec.renders[4].code, 'contract.unsupported-option');
  ok(validate(rec));
  await s.close();
});

test('从 Blender 导出的场景包（BEIMING_CORE_TEST_PACKS）经帧源接口各出一帧：每个通道字节数对、有限、不全为同一个值，编号都在实体清单里', async (t) => {
  const list = (process.env.BEIMING_CORE_TEST_PACKS ?? '').split(path.delimiter).filter(Boolean);
  if (!list.length) { t.skip('没设 BEIMING_CORE_TEST_PACKS'); return; }
  const bin = renderer(t);
  if (!bin) return;
  const src = await startSource({ bin });
  for (const pack of list) {
    const env = envOf(), s = await src.open(inputOf(pack, [320, 180], { tiers: { draft: { samples: 16, scale: 1 } } }), env);
    const r = await rendered(t, s, 0, {}, ALL);
    if (!r) return;
    ok(validate(r.meta));
    const ids = new Set(s.manifest().entities.map((e) => e.id));
    const dir = path.join(env.workspace, path.dirname(r.layers.color.file));
    const read = (file) => { const b = fs.readFileSync(path.join(dir, file)); return file.endsWith('.u32') ? new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4) : new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
    const files = [...Object.entries(r.layers).map(([name, ref]) => [name, path.basename(ref.file), ref.shape]), ['objectId.coverage', 'objectId.coverage.f32', [180, 320, 1]]];
    for (const [name, file, shape] of files) {
      const v = read(file);
      assert.equal(v.length * 4, shape.reduce((a, b) => a * b, 4), `${path.basename(pack)} 的 ${name} 字节数`);
      assert.ok(v.every(Number.isFinite), `${path.basename(pack)} 的 ${name} 有非有限数`);
      assert.ok(v.some((x) => x !== v[0]), `${path.basename(pack)} 的 ${name} 全是同一个值`);
    }
    const seen = [...new Set(read('objectId.u32'))].filter((x) => x !== 0);
    assert.ok(seen.length > 0 && seen.every((x) => ids.has(x)), `${path.basename(pack)} 的编号 ${seen.filter((x) => !ids.has(x))} 不在实体清单里`);
    for (const e of r.meta.entities) assert.ok(ids.has(e.id), `元数据里的实体 ${e.name} 不在实体清单里`);
    t.diagnostic(`${path.basename(pack)}：画面里 ${seen.length} 个实体，清单里 ${ids.size} 个，元数据 ${JSON.stringify(r.meta).length} 字节`);
  }
});

test('一致性探针：七项（颜色线性度、深度、编号与元数据、法线、相机约定、乱序、重复两遍）都过 evaluateSourceConformance', async (t) => {
  const bin = renderer(t);
  if (!bin) return;
  let out;
  try { out = await runProbe({ bin, machine: process.platform }); } catch (e) {
    if (E2E || e.code) throw e;
    t.skip(`渲不出来（多半是没有显卡）：${e.message.split('\n').at(-1)}`);
    return;
  }
  for (const row of out.report.rows) t.diagnostic(`${row.id} ${row.status} ${JSON.stringify(row.measured)}`);
  t.diagnostic(`确定性：${JSON.stringify(out.determinism)}`);
  assert.equal(out.report.ok, true, JSON.stringify(out.report.rows.filter((r) => r.status !== 'pass')));
  assert.deepEqual(out.report.rows.map((r) => r.status), Array(7).fill('pass'));
});
