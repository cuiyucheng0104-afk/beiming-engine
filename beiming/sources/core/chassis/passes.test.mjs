// 内核出层（core-render render-pack --passes）的测试：层文件的形状与字节数、辅助层取首个样本（边缘不出现平均值）、覆盖率、
// 透明度、加辅助层不改颜色层。包由 scenepack.mjs 当场写在系统临时目录里；从 Blender 导出的包由 BEIMING_CORE_TEST_PACKS 指过去。
// 要渲染程序与显卡：BEIMING_CHASSIS_E2E=1 时现编、渲不出来算失败；否则只用编好的那份，没有或渲不出来就跳过。
// 颜色样本落在像素里的哪一点，这里照内核的取数（path/src/sample.rs 与 shaders/sample.wgsl 的 rng2，像素种子照 rng_pixel）在 JS 里
// 重算一遍，再照场景规格（scenepack.mjs 的 PLATES）自己求交：覆盖率拿它数出来的比例去对，不取内核自己的说法。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { checks } from '../../../kernel/contracts/passes/check.mjs';
import { loadContracts } from '../../../kernel/contracts/validate.mjs';
import { OUT, PRESETS, buildRenderer, sourceKey } from './build.mjs';
import { PLATES, platesPack, symmetricPack, writePack } from './scenepack.mjs';

const E2E = process.env.BEIMING_CHASSIS_E2E === '1';
const EXE = process.platform === 'win32' ? '.exe' : '';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-passes-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
let dirs = 0;
const fresh = (spec) => { const dir = path.join(TMP, `p${dirs++}`); writePack(dir, spec); return dir; };

function renderer(t) {
  if (E2E) return buildRenderer().bin;
  const bin = path.join(OUT, 'bin', `core-render-${sourceKey([])}${EXE}`);
  if (fs.existsSync(bin)) return bin;
  t.skip('没有编好的渲染程序（设 BEIMING_CHASSIS_E2E=1 现编）');
  return null;
}
const run = (bin, args) => spawnSync(bin, [...args, '--presets', PRESETS], { encoding: 'utf8', maxBuffer: 1 << 28 });

/** 渲一帧；passes 给目录时出层。渲不出来：E2E 时失败，否则返回 null（调用方跳过） */
function render(t, bin, dir, { w, h, spp, passes, frame = 0 }) {
  const out = path.join(TMP, `r${dirs++}`);
  fs.mkdirSync(out);
  const args = ['render-pack', dir, '--frame', String(frame), '-o', path.join(out, 'out.png'), '--hdr', path.join(out, 'hdr.raw'), '--spp', String(spp), '--width', String(w), '--height', String(h), '--no-denoise'];
  const r = run(bin, passes ? [...args, '--passes', path.join(out, 'passes')] : args);
  if (r.status !== 0) {
    if (!E2E) { t.skip(`渲不出来（多半是没有显卡）：${r.stderr.trim().split('\n').at(-1)}`); return null; }
    assert.fail(r.stderr);
  }
  return { out, stats: JSON.parse(r.stdout), hdr: fs.readFileSync(path.join(out, 'hdr.raw')) };
}

/** 层文件按类型读成数组（带 byteOffset） */
function layer(dir, file) {
  const b = fs.readFileSync(path.join(dir, file));
  return file.endsWith('.u32') ? new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4) : new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

// ------------------------------------------------------------------------------------------------ 内核取数的 JS 一份

const u = x => x >>> 0;
const mul = (a, b) => u(Math.imul(a, b));
function hashHp(i) {
  i = u(i);
  i = u(i ^ (i >>> 16)); i = mul(i, 0x21f0aaad); i = u(i ^ (i >>> 15)); i = mul(i, 0xd35a2d97); i = u(i ^ (i >>> 15));
  return u(i ^ 0xe6fe3beb);
}
function owenRev(n, seed) {
  n = u(n); n = u(n ^ mul(n, 0x3d20adea)); n = u(n + seed); n = mul(n, u((seed >>> 16) | 1)); n = u(n ^ mul(n, 0x05526c56)); n = u(n ^ mul(n, 0x53a22864));
  return n;
}
function rev(x) {
  let r = 0;
  for (let i = 0; i < 32; i++) r = u((r << 1) | ((x >>> i) & 1));
  return r;
}
// Sobol 第 1 维的方向数（sample.rs 的 SOBOL_REV[0]：dirs(1, 0, [1, 0, 0])）
const SOBOL1 = (() => {
  const m = [1];
  for (let i = 1; i < 32; i++) m.push(u(m[i - 1] ^ (m[i - 1] << 1)));
  return m.map((v, i) => rev(u(v << (31 - i))));
})();
const K = Math.fround(1 / 4294967808);
function sobolOwen(revIndex, dim, seed) {
  let r = 0;
  if (dim === 0) r = rev(revIndex);
  else {
    let [x, i] = [u(revIndex), 0];
    for (let k = 0; k < 16 && x !== 0; k++) {
      const j = Math.clz32(x);
      r = u(r ^ SOBOL1[i + j]);
      i += j + 1;
      x = u(u(x << j) << 1);
    }
  }
  return Math.fround(Math.fround(rev(owenRev(r, seed))) * K);
}
const hashIqnt2d = (x, y) => mul(1103515245, u(mul(1103515245, u((x >>> 1) ^ y)) ^ (mul(1103515245, u((y >>> 1) ^ x)) >>> 3)));
/** 第 s 个颜色样本在像素 (x, y) 里的位置：内核相机那一段的 rng2(PRNG_FILTER)，种子是默认用户种子 0x5eed 过一次 hash_hp */
function jitter(x, y, s) {
  const px = u(hashIqnt2d(x, y) ^ hashHp(0x5eed));
  const seed = u(px ^ hashHp(0));
  const i = u(owenRev(rev(s), u(seed ^ 0xf8ade99a)) & 0xffff0000);
  return [sobolOwen(i, 0, u(seed ^ 0xe0aaaf76)), sobolOwen(i, 1, u(seed ^ 0x94964d4e))];
}

// ------------------------------------------------------------------------------------------------ 两块板自己求交

const [C, S] = [Math.cos(PLATES.tilt), Math.sin(PLATES.tilt)];
/** 像素 (x, y) 里 (jx, jy) 那一点的射线打到哪块板：{ id, depth, normal }（相机空间，相机看 -z，所以与世界坐标相同） */
function plates(x, y, jx, jy, w, h) {
  const f = Math.fround;
  const ndc = [f(f(f(f(x + jx) / w) * 2) - 1), f(1 - f(f(f(y + jy) / h) * 2))];
  const tan = Math.tan(PLATES.fovY / 2);
  const d = [ndc[0] * tan * (w / h), ndc[1] * tan, -1];
  const z0 = PLATES.camera[2];
  const [px, py] = [d[0] * z0, d[1] * z0];
  const edge = 0.25 - ((py + 3) / 6) * 0.5;
  if (px > -3 && Math.abs(py) < 3 && px < edge) return { id: 2, depth: z0, normal: [0, 0, 1] };
  // 后板：法线 (sin, 0, cos)，过 (0, 0, backAt)；d 沿相机前方的分量是 1，所以射线参数就是平面深度
  return { id: 1, depth: (C * (z0 - PLATES.backAt)) / (C - S * d[0]), normal: [S, 0, C] };
}
const near = (a, b, rel) => Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b));

// ------------------------------------------------------------------------------------------------ 每个通道的文件

const SHAPES = { color: 4, depth: 1, objectId: 1, 'objectId.coverage': 1, normal: 3, motion: 2, denoiseAlbedo: 3, denoiseNormal: 3 };
const FILES = { color: 'color.f32', depth: 'depth.f32', objectId: 'objectId.u32', 'objectId.coverage': 'objectId.coverage.f32', normal: 'normal.f32', motion: 'motion.f32', denoiseAlbedo: 'denoiseAlbedo.f32', denoiseNormal: 'denoiseNormal.f32' };

/** 出层目录：八个文件与每个分灯组一个文件（两个测试包都只有一盏灯 key，组名就是灯名）的字节数照 [高, 宽, 分量数] × 4；
 *  stdout 里的层表与文件一致；通道声明过结构定义与 PS1 的名字要求，分灯组排在七个固定通道之后 */
async function checkFiles(dir, stats, w, h) {
  const names = fs.readdirSync(dir).sort();
  const groups = { 'lightgroup:key': 'lightgroup-key.f32' };
  assert.deepEqual(names, [...Object.values(FILES), ...Object.values(groups), 'passes.json'].sort());
  for (const [name, k] of [...Object.entries(SHAPES), ...Object.keys(groups).map(g => [g, 3])]) {
    const file = FILES[name] ?? groups[name];
    assert.equal(fs.statSync(path.join(dir, file)).size, h * w * k * 4, name);
    assert.deepEqual(stats.passes.layers[name].shape, [h, w, k], name);
    assert.equal(stats.passes.layers[name].file, file, name);
  }
  const table = JSON.parse(fs.readFileSync(path.join(dir, 'passes.json'), 'utf8'));
  const { validate } = await loadContracts();
  assert.deepEqual(validate(table), { contract: 'passes', schemaErrors: [], violations: {} });
  assert.deepEqual(table.channels.map(c => c.name), ['color', 'depth', 'objectId', 'normal', 'motion', 'denoiseAlbedo', 'denoiseNormal', ...Object.keys(groups)]);
  return table;
}

test('两块错开的板：深度、编号、法线取首个样本，边缘上只有两块板各自的值；覆盖率等于照内核取数重算的比例；只有一帧的包 motion 全 0；核对记录过 PS1 到 PS6，负对照不过', async (t) => {
  const bin = renderer(t);
  if (!bin) return;
  const [w, h, spp] = [64, 36, 16];
  const r = render(t, bin, fresh(platesPack()), { w, h, spp, passes: true });
  if (!r) return;
  const dir = path.join(r.out, 'passes');
  const table = await checkFiles(dir, r.stats, w, h);
  const [depth, id, cov, normal, motion] = [layer(dir, 'depth.f32'), layer(dir, 'objectId.u32'), layer(dir, 'objectId.coverage.f32'), layer(dir, 'normal.f32'), layer(dir, 'motion.f32')];
  // 只有一帧的包：motion 每个像素都是 (0, 0)（输出通道契约 5.6）
  assert.ok(motion.every(v => Object.is(v, 0)), '只有一帧的包 motion 全 0');
  const pixels = [];
  let mixed = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const center = plates(x, y, 0.5, 0.5, w, h);
      const samples = Array.from({ length: spp }, (_, s) => plates(x, y, ...jitter(x, y, s), w, h));
      const k = samples.filter(s => s.id === center.id).length;
      // 每个像素：编号就是像素中心那条射线打到的；深度与法线是那块板在像素中心的值（不是两块的混合）
      assert.equal(id[p], center.id, `(${x}, ${y}) 的编号`);
      assert.ok(near(depth[p], center.depth, 1e-5), `(${x}, ${y}) 的深度 ${depth[p]}，${center.id} 号板在那里是 ${center.depth}`);
      // 法线照 Cycles 存成 16 位八面体编码（path/src/packed_normal.rs），每个分量偏开到 2^-15 上下
      [0, 1, 2].forEach(c => assert.ok(Math.abs(normal[p * 3 + c] - center.normal[c]) <= 4e-5, `(${x}, ${y}) 的法线`));
      assert.ok(Math.abs(cov[p] - k / spp) <= 1e-6, `(${x}, ${y}) 的覆盖率 ${cov[p]}，数出来 ${k}/${spp}`);
      if (k > 0 && k < spp) {
        mixed++;
        pixels.push({
          producer: 'core', x, y,
          // aux 取内核自己的辅助样本（就是层里的那一格）；它是不是像素中心的那一条，上面已经照场景规格对过
          aux: { id: id[p], depth: depth[p], normal: [0, 1, 2].map(c => normal[p * 3 + c]), motion: [motion[p * 2], motion[p * 2 + 1]] },
          samples: samples.map(s => ({ id: s.id, depth: s.depth, normal: s.normal })),
          out: { depth: depth[p], id: id[p], coverage: cov[p], normal: [0, 1, 2].map(c => normal[p * 3 + c]), motion: [motion[p * 2], motion[p * 2 + 1]] },
        });
      }
    }
  }
  t.diagnostic(`边缘上覆盖率严格在 0 与 1 之间的像素 ${mixed} 个`);
  assert.ok(mixed >= 10, '边缘上要有覆盖率严格在 0 与 1 之间的像素');
  const rec = { format: 'passes-check/0.1', sides: [{ producer: 'core', table }], pixels };
  const { validate } = await loadContracts();
  const v = validate(rec);
  assert.deepEqual(v.schemaErrors, []);
  // PS1 要出层方的声明含七个固定通道：motion 出了，七个齐了
  assert.deepEqual(v.violations, {});
  // 负对照：辅助层换成颜色样本的平均（深度、编号、法线逐个取平均），PS4 必须不过，边缘像素的深度也不再是任何一块板的
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const averaged = { ...rec, pixels: pixels.map(p => ({ ...p, out: { ...p.out, depth: avg(p.samples.map(s => s.depth)), id: Math.round(avg(p.samples.map(s => s.id))), normal: [0, 1, 2].map(c => avg(p.samples.map(s => s.normal[c]))) } })) };
  assert.ok(averaged.pixels.every(p => checks.PS4({ ...averaged, pixels: [p] }).length > 0), '每个边缘像素 PS4 都不过');
  // 后板在像素中心的深度（射线参数取像素中心那一条）：平均出来的深度既不是前板的 3，也不是它
  const backAt = (p) => { const d = plates(p.x, p.y, 0.5, 0.5, w, h); return d.id === 1 ? d.depth : p.samples.find(s => s.id === 1).depth; };
  assert.ok(averaged.pixels.every(p => !near(p.out.depth, PLATES.camera[2], 1e-5) && !near(p.out.depth, backAt(p), 1e-4)), '平均出来的深度不是两块板之一');
});

test('透明度：背景对相机可见时 A 全是 1；不可见时什么都没打到的像素 A 与 RGB 都是 0，打到板的像素 A 是 1；颜色预乘 A', (t) => {
  const bin = renderer(t);
  if (!bin) return;
  const [w, h, spp] = [48, 27, 4];
  for (const visible of [true, false]) {
    const spec = symmetricPack();
    spec.manifest.world = { color: [0.3, 0.3, 0.3], visibleToCamera: visible };
    const r = render(t, bin, fresh(spec), { w, h, spp, passes: true });
    if (!r) return;
    const dir = path.join(r.out, 'passes');
    const [color, id, depth] = [layer(dir, 'color.f32'), layer(dir, 'objectId.u32'), layer(dir, 'depth.f32')];
    let [bg, hit] = [0, 0];
    for (let p = 0; p < w * h; p++) {
      const a = color[p * 4 + 3];
      if (visible) assert.equal(a, 1, `像素 ${p}`);
      // 像素中心没打到（深度 1e10）且四周都没打到的像素：A 与 RGB 是 0
      else if (depth[p] === 1e10 && a === 0) { bg++; assert.deepEqual([0, 1, 2].map(c => color[p * 4 + c]), [0, 0, 0]); }
      else if (id[p] !== 0 && a === 1) hit++;
      assert.ok(a >= 0 && a <= 1);
    }
    if (!visible) assert.ok(bg > 100 && hit > 100, `背景像素 ${bg} 个、整个打到板的像素 ${hit} 个`);
  }
});

test('加辅助层不改颜色：同一个包要不要辅助层，颜色的原始输出逐字节相同；color 层的 RGB 就是它', (t) => {
  const bin = renderer(t);
  if (!bin) return;
  const [w, h, spp] = [64, 36, 8];
  const dir = fresh(platesPack());
  const a = render(t, bin, dir, { w, h, spp, passes: false });
  if (!a) return;
  const b = render(t, bin, dir, { w, h, spp, passes: true });
  assert.ok(a.hdr.equals(b.hdr), '颜色的原始输出逐字节相同');
  const rgb = new Float32Array(a.hdr.buffer, a.hdr.byteOffset, a.hdr.byteLength / 4);
  const color = layer(path.join(b.out, 'passes'), 'color.f32');
  for (let p = 0; p < w * h; p++) [0, 1, 2].forEach(c => assert.ok(Object.is(color[p * 4 + c], rgb[p * 3 + c]), `像素 ${p}`));
});

test('从 Blender 导出的场景包（BEIMING_CORE_TEST_PACKS）：每个通道各出一帧，字节数对、有限、不全是同一个值，编号都在实例表里；加辅助层颜色不变', async (t) => {
  const list = (process.env.BEIMING_CORE_TEST_PACKS ?? '').split(path.delimiter).filter(Boolean);
  if (!list.length) { t.skip('没设 BEIMING_CORE_TEST_PACKS'); return; }
  const bin = renderer(t);
  if (!bin) return;
  const [w, h, spp] = [320, 180, 16];
  for (const pack of list) {
    const r = render(t, bin, pack, { w, h, spp, passes: true });
    if (!r) return;
    const dir = path.join(r.out, 'passes');
    await checkFiles(dir, r.stats, w, h);
    for (const [name, file] of Object.entries(FILES)) {
      const v = layer(dir, file);
      assert.ok(v.every(Number.isFinite), `${path.basename(pack)} 的 ${name} 有非有限数`);
      // （motion 在不动的包上本来就全是 0，不查）
      if (name !== 'motion') assert.ok(v.some(x => x !== v[0]), `${path.basename(pack)} 的 ${name} 全是同一个值`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(pack, 'pack.json'), 'utf8'));
    const rows = layer(pack, manifest.instances.file);
    const entities = new Set(Array.from({ length: manifest.instances.shape[0] }, (_, i) => rows[i * 4 + 2]));
    const seen = [...new Set(layer(dir, 'objectId.u32'))].filter(x => x !== 0);
    assert.ok(seen.length > 0 && seen.every(x => entities.has(x)), `${path.basename(pack)} 的编号 ${seen.filter(x => !entities.has(x))} 不在实例表里`);
    t.diagnostic(`${path.basename(pack)}：画面里出现 ${seen.length} 个实体（实例表里 ${entities.size} 个）`);
    const plain = render(t, bin, pack, { w, h, spp, passes: false });
    assert.ok(plain.hdr.equals(r.hdr), `${path.basename(pack)}：加辅助层颜色变了`);
  }
});
