// 内核读场景包（core-render 的 pack-info、render-pack）的测试。包都是 scenepack.mjs 当场写出的小包，放在系统临时目录里。
// 纯逻辑部分（写出器、必填字段的枚举、契约的判定函数）任何机器都跑。要渲染程序的部分：BEIMING_CHASSIS_E2E=1 时现编（缺工具链
// 算失败），否则只用已经编好、源码摘要对得上的那一份，没有就跳过。要显卡的部分渲不出来时同样按 E2E 定跳过还是失败。
// 从 Blender 导出的场景包不进仓库：BEIMING_CORE_TEST_PACKS 列出它们的目录（按系统的路径分隔符隔开），每个目录旁边放
// 「目录名.blender-stats.json」（Blender 一侧数出来的统计）；不设就跳过这一条。
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checks } from '../../../kernel/contracts/scene-pack/check.mjs';
import { OUT, PRESETS, buildRenderer, sourceKey } from './build.mjs';
import { fullPack, requiredPaths, symmetricPack, withoutField, writePack } from './scenepack.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(HERE, '../../../kernel/contracts/scene-pack/schema/scene-pack.schema.json'), 'utf8'));
const E2E = process.env.BEIMING_CHASSIS_E2E === '1';
const EXE = process.platform === 'win32' ? '.exe' : '';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-scenepack-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
// 负对照：去掉镜像实例平铺时的绕序翻转（内核在这一处按行列式的符号翻转三角形的顶点次序）
const NO_FLIP = [{ file: 'path/src/scene.rs', from: 'let mirrored = world.determinant() < 0.0;', to: 'let mirrored = false;' }];

let dirs = 0;
const fresh = (spec, tweak) => {
  const dir = path.join(TMP, `p${dirs++}`);
  const files = writePack(dir, spec);
  if (tweak) tweak(dir);
  return { dir, files };
};
const allChecks = rec => Object.fromEntries(Object.entries(checks).map(([k, fn]) => [k, fn(rec)]).filter(([, v]) => v.length));

/** 渲染程序：E2E 时现编；否则只用编好的那份 */
function renderer(t, inject = []) {
  if (E2E) return buildRenderer({ inject }).bin;
  const bin = path.join(OUT, 'bin', `core-render-${sourceKey(inject)}${EXE}`);
  if (fs.existsSync(bin)) return bin;
  t.skip('没有编好的渲染程序（设 BEIMING_CHASSIS_E2E=1 现编）');
  return null;
}
const run = (bin, args, env = {}) => spawnSync(bin, [...args, '--presets', PRESETS], { encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, ...env } });
const info = (bin, dir, args = []) => {
  const r = run(bin, ['pack-info', dir, ...args]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
/** 读失败时 stderr 最后一行的 {error: {code, at, message}} */
const failure = (r) => {
  assert.ok(r.status !== 0 && r.status !== 101 && r.signal === null, `应该是带码的报错，不是 panic：退出 ${r.status}，${r.stderr}`);
  return JSON.parse(r.stderr.trim().split('\n').at(-1)).error;
};
const record = (bin, dir, frame = 0) => {
  const out = path.join(dir, `..`, `${path.basename(dir)}-record.json`);
  info(bin, dir, ['--frame', String(frame), '--record', out]);
  return JSON.parse(fs.readFileSync(out, 'utf8'));
};

test('写出器：同样的输入逐字节相同；写出的包过契约的全部判定（文件集合、形状与字节数、镜像标记、实体编号）', () => {
  for (const make of [fullPack, symmetricPack]) {
    const spec = make();
    const a = fresh(spec), b = fresh(make());
    for (const f of a.files) assert.ok(fs.readFileSync(path.join(a.dir, f.path)).equals(fs.readFileSync(path.join(b.dir, f.path))), f.path);
    const m = spec.manifest, n = spec.rows.length;
    const frameInstances = [];
    for (let k = 0; k < m.frames.count; k++) for (let row = 0; row < n; row++) frameInstances.push({ frame: k, row, mat16: spec.tables.instances.slice((k * n + row) * 16, (k * n + row + 1) * 16) });
    const rec = { format: 'scene-pack-check/0.1', pack: m, files: a.files, geometry: { skins: 0, animations: 0, morphTargets: 0 }, tables: { instances: spec.rows, frameInstances } };
    assert.deepEqual(allChecks(rec), {});
  }
});

test('必填字段照结构定义的 required 枚举：清单每一层、条件分支（矩形面光的 size、平行光的 dir、surface 的三个参数、四种节点的字段）都列到', () => {
  const paths = requiredPaths(SCHEMA, fullPack().manifest);
  for (const p of ['format', 'units.meter', 'geometry.meshes[1].attrs', 'instances.class', 'materials[1].params.roughness', 'materials[1].pattern[0].radius',
    'materials[1].pattern[1].onlyLocal', 'materials[1].pattern[2].edges', 'materials[1].pattern[3].set', 'lights[0].size', 'lights[1].watts', 'lights[2].dir',
    'lights[2].irradiance', 'world.visibleToCamera', 'camera.far', 'frames.lights.fields', 'source.sha256']) assert.ok(paths.includes(p), p);
  assert.ok(!paths.includes('lights[2].watts') && !paths.includes('camera.sensorHeight'), '条件之外的字段不算必填');
  assert.equal(new Set(paths).size, paths.length);
  assert.ok(paths.length >= 80, `只枚举出 ${paths.length} 个`);
});

test('pack-info：统计照实（三角形数是内核平铺的），核对记录过契约全部判定，镜像实例的几何法线取了反（SP7）', (t) => {
  const bin = renderer(t);
  if (!bin) return;
  const spec = fullPack();
  const { dir } = fresh(spec);
  const s = info(bin, dir);
  assert.deepEqual({ triangles: s.triangles, meshTriangles: s.meshTriangles, instances: s.instances, drawn: s.drawn, entities: s.entities, mirrored: s.mirrored, materials: s.materials, lights: s.lights, frames: s.frames, patternNodes: s.patternNodes, lightLinks: s.lightLinks, zeroCornerNormals: s.zeroCornerNormals },
    { triangles: 10, meshTriangles: 4, instances: 5, drawn: 5, entities: 4, mirrored: 1, materials: 2, lights: 3, frames: 2, patternNodes: 4, lightLinks: 1, zeroCornerNormals: 0 });
  assert.deepEqual(s.lightTypes, { 'area-rect': 1, point: 1, sun: 1 });
  assert.deepEqual(s.notApplied.pattern, [{ material: 'lined', nodes: 4 }]);
  for (const frame of [0, 1]) {
    const rec = record(bin, dir, frame);
    assert.equal(rec.normalProbes.length, 5);
    assert.deepEqual(allChecks(rec), {}, `第 ${frame} 帧`);
    // raw 另在这里从写进去的顶点与矩阵算一遍，方向要和读入器报的一致
    const g = spec.meshes;
    for (const p of rec.normalProbes) {
      const [mi] = spec.rows[p.row], tri = p.ext['core.triangle'];
      const m = spec.tables.instances.slice((frame * 5 + p.row) * 16, (frame * 5 + p.row + 1) * 16);
      const q = [0, 1, 2].map(c => { const v = g[mi].indices[tri * 3 + c]; const x = g[mi].positions.slice(v * 3, v * 3 + 3); return [0, 1, 2].map(r => m[r] * x[0] + m[4 + r] * x[1] + m[8 + r] * x[2] + m[12 + r]); });
      const e1 = q[1].map((x, i) => x - q[0][i]), e2 = q[2].map((x, i) => x - q[0][i]);
      const raw = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const cos = raw.reduce((a, x, i) => a + x * p.raw[i], 0) / Math.hypot(...raw) / Math.hypot(...p.raw);
      assert.ok(cos > 0.999999, `第 ${p.row} 行的 raw 对不上：${cos}`);
    }
  }
});

test('缺字段：结构定义里每个必填字段删一次，读入器都报 contract.bad-value，at 正是这个字段的路径，一个不漏', (t) => {
  const bin = renderer(t);
  if (!bin) return;
  const spec = fullPack();
  const paths = requiredPaths(SCHEMA, spec.manifest);
  const wrong = [];
  for (const at of paths) {
    const { dir } = fresh({ ...spec, layout: spec.manifest, manifest: withoutField(spec.manifest, at) });
    const r = run(bin, ['pack-info', dir]);
    const e = r.status === 0 ? null : failure(r);
    if (!e || e.code !== 'contract.bad-value' || e.at !== at || r.status !== 4) wrong.push(`${at}：${JSON.stringify(e)}（退出 ${r.status}）`);
  }
  assert.deepEqual(wrong, [], `${paths.length} 个必填字段里这些没报对`);
});

/** 坏包：每一种都必须是带码的报错（不 panic、不越界读），码与位置照写 */
const BAD = [
  ['实例表的网格下标越界', s => { s.rows[1][0] = 7; }, 'contract.bad-value', 'instances.file'],
  ['实例表的材质下标越界', s => { s.rows[0][1] = 2; }, 'contract.bad-value', 'instances.file'],
  ['灯表的 shape 和灯数对不上', s => { s.manifest.frames.lights.shape = [2, 2, 17]; }, 'contract.bad-value', 'frames.lights.shape'],
  ['实例表的 shape 不是 [实例数, 4]', s => { s.manifest.instances.shape = [5, 3]; }, 'contract.bad-value', 'instances.shape'],
  ['相机表的字节数和 shape 对不上', null, 'contract.bad-value', 'frames.camera.file', d => fs.truncateSync(path.join(d, 'frames/camera.f32'), 19 * 4 * 2 - 4)],
  ['实例表文件多了字节', null, 'contract.bad-value', 'instances.file', d => fs.appendFileSync(path.join(d, 'instances.u32'), Buffer.alloc(4))],
  ['每帧状态表里有 NaN', s => { s.tables.instances[17] = NaN; }, 'contract.bad-value', 'frames.instances.file'],
  ['每帧状态表里有无穷', s => { s.tables.camera[16] = Infinity; }, 'contract.bad-value', 'frames.camera.file'],
  ['几何文件的路径带 ..', s => { s.manifest.geometry.file = '../geometry.glb'; }, 'contract.bad-value', 'geometry.file'],
  ['实例表的路径是绝对路径', s => { s.manifest.instances.file = '/instances.u32'; }, 'contract.bad-value', 'instances.file'],
  ['表的路径以反斜杠开头', s => { s.manifest.frames.camera.file = '\\frames\\camera.f32'; }, 'contract.bad-value', 'frames.camera.file'],
  ['未知的图案节点名', s => { s.manifest.materials[1].pattern[2].node = 'toonLine'; }, 'contract.unknown-node', 'materials[1].pattern[2].node'],
  ['清单写的三角形数和几何文件对不上', s => { s.manifest.geometry.meshes[0].tris = 3; }, 'contract.bad-value', 'geometry.meshes[0].tris'],
  ['几何文件的下标越界', s => { s.meshes[0].indices[5] = 9; }, 'contract.bad-value', 'geometry.meshes[0]'],
  ['镜像实例没标第四列（SP3）', s => { s.rows[2][3] = 0; }, 'contract.bad-value', 'instances.file'],
  ['实体编号与名字不是一一对应（SP10）', s => { s.rows[4][2] = 5; }, 'contract.bad-value', 'instances.file'],
  ['清单里有契约没定义的键', s => { s.manifest.camera.fov = 1; }, 'contract.unknown-key', 'camera.fov'],
  ['灯光链接一个实体都配不到（SP12）', s => { s.manifest.lights[0].link = ['nobody']; }, 'contract.bad-value', 'lights[0].link[0]'],
  ['正交相机', s => { s.manifest.camera.type = 'ortho'; }, 'contract.unsupported-input', 'camera.type'],
  ['参数还没登记的闭包', s => { s.manifest.materials[0].closure = 'toon'; }, 'contract.unsupported-input', 'materials[0].closure'],
];

test('坏包：下标越界、形状不符、字节数不符、NaN 与无穷、路径带 .. 或绝对路径、未知节点名……全部是带错误码的报错', (t) => {
  const bin = renderer(t);
  if (!bin) return;
  for (const [name, edit, code, at, tweak] of BAD) {
    const spec = fullPack();
    edit?.(spec);
    const { dir } = fresh(spec, tweak);
    const e = failure(run(bin, ['pack-info', dir]));
    assert.deepEqual([e.code, e.at], [code, at], `${name}：${e.message}`);
  }
  const { dir } = fresh(fullPack());
  const r = run(bin, ['pack-info', dir, '--frame', '2']);
  assert.equal(r.status, 2);
  assert.equal(failure(r).code, 'usage.bad-argument');
  // SP17：读入方报 contract.unknown-node 的观测写成核对记录，过；当成读进来了，不过
  const spec = fullPack();
  spec.manifest.materials[1].pattern[2].node = 'toonLine';
  const bad = fresh(spec);
  const e = failure(run(bin, ['pack-info', bad.dir]));
  const rec = loads => ({ format: 'scene-pack-check/0.1', pack: spec.manifest, loads });
  assert.deepEqual(checks.SP17(rec([{ status: 'error', code: e.code }])), []);
  assert.equal(checks.SP17(rec([{ status: 'ok' }])).length, 1);
});

/** 左右对称的包渲 8 个种子：每个种子左半与右半的平均亮度差；返回差的均值、标准误与第一个种子的原始输出 */
function halves(bin, dir) {
  const W = 128, H = 64, d = [];
  let first = null;
  for (let seed = 1; seed <= 8; seed++) {
    const hdr = path.join(dir, '..', `${path.basename(dir)}-${path.basename(bin)}-s${seed}.raw`);
    const r = spawnSync(bin, ['render-pack', dir, '-o', `${hdr}.png`, '--hdr', hdr, '--spp', '64', '--width', String(W), '--height', String(H), '--no-denoise', '--presets', PRESETS], { encoding: 'utf8', env: { ...process.env, THREERT_SEED: String(seed) } });
    if (r.status !== 0) return { error: r.stderr };
    const b = fs.readFileSync(hdr);
    first ??= b;
    const px = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
    let left = 0, right = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3, l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      assert.ok(Number.isFinite(l));
      if (x < W / 2) left += l; else right += l;
    }
    d.push((left - right) / (W * H / 2));
  }
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  const se = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / (d.length - 1) / d.length);
  return { mean, se, z: mean / se, first };
}

const symmetric = { dir: null, ok: null };
test('显卡：左右对称的包（右边是镜像件）左右两半平均亮度差在 3 个标准误以内；去掉镜像的绕序翻转后核对记录的 SP7 不过', (t) => {
  const bin = renderer(t);
  if (!bin) return;
  symmetric.dir = fresh(symmetricPack()).dir;
  const ok = halves(bin, symmetric.dir);
  if (ok.error) {
    if (!E2E) { t.skip(`渲不出来（多半是没有显卡）：${ok.error.trim().split('\n').at(-1)}`); return; }
    assert.fail(ok.error);
  }
  symmetric.ok = ok;
  t.diagnostic(`镜像对：左右差 ${ok.mean.toExponential(3)}，标准误 ${ok.se.toExponential(3)}，z = ${ok.z.toFixed(2)}`);
  assert.ok(Math.abs(ok.z) <= 3, `z = ${ok.z}`);
  assert.deepEqual(allChecks(record(bin, symmetric.dir)), {});
  const broken = renderer(t, NO_FLIP);
  if (!broken) return;
  assert.equal(checks.SP7(record(broken, symmetric.dir)).length, 1, '去掉翻转之后镜像件那一行 SP7 必须不过');
});

// 还过不了：内核着色时把几何法线翻向来路、再让着色法线与它同侧（shaders/shader.wgsl 的 surface），不透明的表面画出来与三角形的
// 绕序无关，去掉翻转画面只差在浮点末位（苹果显卡上实测：一个种子 24576 个数里 1273 个不同，相对差至多 3.1e-7）。
// 场景包能写的材质只有不透明的 surface，在画面上量不出翻没翻。
test('显卡负对照：去掉镜像的绕序翻转后，左右两半的平均亮度差超过 3 个标准误', { todo: '内核对不透明表面不看绕序，画面上量不出（见上面的注释）' }, (t) => {
  if (!symmetric.ok) { t.skip('上一条没渲出来'); return; }
  const broken = renderer(t, NO_FLIP);
  if (!broken) return;
  const neg = halves(broken, symmetric.dir);
  if (neg.error) assert.fail(neg.error);
  t.diagnostic(`负对照：左右差 ${neg.mean.toExponential(3)}，标准误 ${neg.se.toExponential(3)}，z = ${neg.z.toFixed(2)}；第一个种子的原始输出与不去掉翻转时${neg.first.equals(symmetric.ok.first) ? '逐字节相同' : '不全相同'}`);
  assert.ok(Math.abs(neg.z) > 3, `z = ${neg.z}`);
});

test('从 Blender 导出的场景包（BEIMING_CORE_TEST_PACKS）：统计与 Blender 一侧逐项相等，核对记录过全部判定，首末两帧渲得出、没有 NaN', (t) => {
  const list = (process.env.BEIMING_CORE_TEST_PACKS ?? '').split(path.delimiter).filter(Boolean);
  if (!list.length) { t.skip('没设 BEIMING_CORE_TEST_PACKS'); return; }
  const bin = renderer(t);
  if (!bin) return;
  for (const dir of list) {
    const blender = JSON.parse(fs.readFileSync(`${dir.replace(/[\\/]+$/, '')}.blender-stats.json`, 'utf8'));
    const s = info(bin, dir);
    assert.deepEqual([s.triangles, s.instances, s.lights, s.mirrored, s.frames], [blender.tris, blender.mesh_objects, blender.lights, blender.mirrored_objects.length, blender.frames.length], dir);
    t.diagnostic(`${path.basename(dir)}：${JSON.stringify({ triangles: s.triangles, instances: s.instances, entities: s.entities, lights: s.lights, mirrored: s.mirrored, materials: s.materials, frames: s.frames, patternNodes: s.patternNodes, lightLinks: s.lightLinks })}`);
    const work = path.join(TMP, `real${dirs++}`);
    fs.mkdirSync(work);
    for (const frame of [...new Set([0, s.frames - 1])]) {
      const out = path.join(work, `f${frame}.json`);
      info(bin, dir, ['--frame', String(frame), '--record', out]);
      assert.deepEqual(allChecks(JSON.parse(fs.readFileSync(out, 'utf8'))), {}, `第 ${frame} 帧`);
      const hdr = path.join(work, `f${frame}.raw`);
      const r = run(bin, ['render-pack', dir, '--frame', String(frame), '-o', `${hdr}.png`, '--hdr', hdr, '--spp', '16', '--width', '320', '--height', '180', '--no-denoise']);
      if (r.status !== 0 && !E2E) { t.skip(`渲不出来（多半是没有显卡）：${r.stderr.trim().split('\n').at(-1)}`); return; }
      assert.equal(r.status, 0, r.stderr);
      const b = fs.readFileSync(hdr);
      const px = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
      assert.ok(px.every(Number.isFinite) && px.some(x => x > 0), `第 ${frame} 帧有 NaN 或全黑`);
    }
  }
});
