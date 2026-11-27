#!/usr/bin/env node
// 北冥 · 核心编进的 OIDN 与 Blender（Cycles）自己的降噪对拍：Cycles 渲一帧，存带降噪特征层的多层 EXR（Noisy Image、
// Denoising Albedo、Denoising Normal 与它自己降噪后的 Combined）；把带噪颜色与两个特征层喂给带 OIDN 的 core-render 的
// `denoise` 子命令（render-pack 用的同一个 denoise::oidn()，同设备、质量 HIGH、同预过滤），和 Combined 逐像素比。
//   node beiming/sources/core/chassis/oidn-parity.mjs [--device cpu|cuda|metal] [--prefilter accurate|fast|none] [--spp 16]
//       [--width 320 --height 240] [--exr 现成的.exr] [--bin core-render] [--rows cycles|exr] [--build oidn|oidn23] [--print]
// 场景由下面的 SCENE 在 Blender 里现搭（不读任何文件），EXR 与场景不进仓库；记录写 oidn-parity/<平台>-<设备>-<预过滤>.json（--build oidn23
// 写 <平台>-oidn23-<设备>-<预过滤>.json），随提交入库。
// Blender 与 OIDN 库照 build.mjs 的 verifyOidnLibs 找、核对（同一个 Blender 安装：它降噪用的库就是核心链接的那一份）。--build 选构建档：
// oidn（默认）对 Blender 5.2 与 OIDN 2.5，oidn23 对 Blender 4.5 与 OIDN 2.3（BEIMING_BLENDER 指向 Blender 4.5，或 BEIMING_OIDN_LIB 指向它的 lib）；
// 渲参考的 Blender 报的版本与锁文件这一项的不同就不比（退出码 3）。
// 行序：EXR 第一行是画面最上面一行；Cycles 的渲染缓冲第一行是最下面一行，OIDN 拿到的是后者，所以喂进去之前上下翻过来（--rows
// cycles，默认），出来再翻回去；卷积网络对上下翻转不是逐位不变的。--rows exr 不翻，查口径用。
// 判据：每个分量 |核心 − Combined| ≤ 1e-3 × max(1, |Combined|)（暗处看绝对差，亮处看相对差）。另记最大绝对差与最大相对差
// （分母取 max(|Combined|, 1e-6)）。退出码：0 过；4 不过（记录照写）；3 缺 Blender、库对不上、没编进 OIDN 或设备建不起来；2 用法错误。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildOidnRenderer, findBlender, verifyOidnLibs } from './build.mjs';
import { runMain, usage } from './passes-exr.mjs';

export const RECORDS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'oidn-parity');
export const TOLERANCE = 1e-3;
const sha256 = data => createHash('sha256').update(data).digest('hex');

/** Blender 一侧：最小场景（地面、漫反射方块、带光泽的球、面光、弱环境光），Cycles 渲一帧存多层 EXR（32 位、不压缩） */
export const SCENE = String.raw`
import bpy, sys
out, device, prefilter, spp, width, height = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.engine = 'CYCLES'
cy = sc.cycles
if device == 'cpu':
    cy.device = 'CPU'
    cy.denoising_use_gpu = False
else:
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = device.upper()
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type == device.upper()
    if not any(d.use for d in prefs.devices):
        raise SystemExit('no %s device' % device)
    cy.device = 'GPU'
    cy.denoising_use_gpu = True
cy.samples = int(spp)
cy.use_adaptive_sampling = False
cy.seed = 0
cy.use_denoising = True
cy.denoiser = 'OPENIMAGEDENOISE'
cy.denoising_input_passes = 'RGB_ALBEDO_NORMAL'
cy.denoising_prefilter = prefilter.upper()
cy.denoising_quality = 'HIGH'
sc.view_layers[0].cycles.denoising_store_passes = True
sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = int(width), int(height), 100
def material(name, color, rough, metal):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = color
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    return m
def add(op, mat, **kw):
    op(**kw)
    bpy.context.active_object.data.materials.append(mat)
add(bpy.ops.mesh.primitive_plane_add, material('floor', (0.8, 0.8, 0.8, 1), 0.6, 0.0), size=12)
add(bpy.ops.mesh.primitive_cube_add, material('red', (0.8, 0.1, 0.05, 1), 0.5, 0.0), size=1.5, location=(1.6, 0.8, 0.75))
add(bpy.ops.mesh.primitive_uv_sphere_add, material('gold', (0.9, 0.7, 0.3, 1), 0.25, 1.0), radius=1.0, location=(-0.8, -0.4, 1.0))
bpy.ops.object.light_add(type='AREA', location=(0.5, -1.5, 5.0))
bpy.context.active_object.data.energy = 600.0
bpy.context.active_object.data.size = 1.5
world = bpy.data.worlds.new('w')
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.3, 0.4, 0.6, 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.3
sc.world = world
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
sc.collection.objects.link(cam)
cam.location = (6.0, -6.5, 4.0)
t = cam.constraints.new('TRACK_TO')
t.target = bpy.data.objects['Sphere']
sc.camera = cam
f = sc.render.image_settings
f.media_type = 'MULTI_LAYER_IMAGE'
f.file_format, f.color_depth, f.exr_codec = 'OPEN_EXR_MULTILAYER', '32', 'NONE'
sc.render.filepath = out
bpy.ops.render.render(write_still=True)
print('BEIMING_BLENDER_VERSION', bpy.app.version_string)
`;

/**
 * 读 Blender 5 存的多层 EXR：多部件（版本标志 0x1000，每个通道一个部件）、扫描线、不压缩、32 位浮点。verify/exr 的 readExr
 * 只认单部件，这里只为对拍读一份 Blender 自己写的文件，别的写法一律拒绝。返回 { width, height, channels: { 名: Float32Array } }。
 */
export function readBlenderExr(bytes) {
  const d = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  const fail = why => { throw new Error(`Blender 的 EXR：${why}`); };
  if (d.readInt32LE(0) !== 20000630) fail('不是 EXR');
  const version = d.readInt32LE(4);
  if ((version & 0xff) !== 2 || (version & 0x200) || (version & 0x800)) fail(`版本标志 0x${version.toString(16)} 不是扫描线`);
  const multi = (version & 0x1000) !== 0;
  const str = () => { const end = d.indexOf(0, pos); if (end < pos) fail('名字没有结尾'); const s = d.toString('latin1', pos, end); pos = end + 1; return s; };
  const parts = [];
  for (;;) {
    const attrs = new Map();
    for (let name; (name = str());) {
      const type = str(), size = d.readInt32LE(pos);
      attrs.set(name, { type, value: d.subarray(pos + 4, pos + 4 + size) });
      pos += 4 + size;
    }
    if (!attrs.size) break;
    const dw = attrs.get('dataWindow')?.value, comp = attrs.get('compression')?.value[0], list = attrs.get('channels')?.value;
    if (!dw || !list) fail('缺 dataWindow 或 channels');
    if (comp !== 0) fail(`压缩方式 ${comp}，要 NONE`);
    if (attrs.get('type') && !/scanlineimage/.test(attrs.get('type').value.toString('latin1'))) fail('部件不是扫描线');
    const chans = [];
    for (let p = 0; p < list.length - 1;) {
      const end = list.indexOf(0, p), name = list.toString('latin1', p, end), type = list.readInt32LE(end + 1);
      if (type !== 2) fail(`${name} 不是 32 位浮点`);
      chans.push(name);
      p = end + 17;
    }
    parts.push({ minY: dw.readInt32LE(4), width: dw.readInt32LE(8) - dw.readInt32LE(0) + 1, height: dw.readInt32LE(12) - dw.readInt32LE(4) + 1, chans });
    if (!multi) break;
  }
  const { width, height } = parts[0];
  if (parts.some(p => p.width !== width || p.height !== height)) fail('各部件的画面尺寸不同');
  pos += parts.length * height * 8; // 偏移表：不压缩时一行一块，下面按块头里的部件号与行号放
  const channels = Object.create(null);
  for (const p of parts) for (const c of p.chans) channels[c] = new Float32Array(width * height);
  for (let k = 0; k < parts.length * height; k++) {
    const part = multi ? d.readInt32LE(pos) : 0;
    if (multi) pos += 4;
    const p = parts[part], y = d.readInt32LE(pos) - p.minY, size = d.readInt32LE(pos + 4);
    if (!p || y < 0 || y >= height || size !== width * 4 * p.chans.length) fail('扫描线块头不对');
    pos += 8;
    p.chans.forEach((c, j) => { for (let x = 0; x < width; x++) channels[c][y * width + x] = d.readFloatLE(pos + (j * width + x) * 4); });
    pos += size;
  }
  return { width, height, channels };
}

/** 多层 EXR 里某一层的几个分量（层名后缀匹配，如 'Noisy Image'），交织成 RGB f32 */
export function layer(exr, name, comps) {
  const key = c => Object.keys(exr.channels).find(k => k.endsWith(`.${name}.${c}`) || k === `${name}.${c}`);
  const planes = comps.map(c => {
    const k = key(c);
    if (!k) throw new Error(`EXR 里没有 ${name}.${c}（有：${Object.keys(exr.channels).join('、')}）`);
    return exr.channels[k];
  });
  const n = exr.width * exr.height, out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++) out[i * 3 + j] = planes[j][i];
  return out;
}

/** RGB f32 图上下翻转（返回新数组） */
export function flipRows(px, width, height) {
  const out = new Float32Array(px.length), row = width * 3;
  for (let y = 0; y < height; y++) out.set(px.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
  return out;
}

/** 逐分量比：{ maxAbs, maxRel, worst（判据比值最大的一个：比值、像素、分量、两边的值）, pass } */
export function compare(ours, ref, width) {
  let maxAbs = 0, maxRel = 0, worst = { ratio: 0 };
  for (let i = 0; i < ref.length; i++) {
    const d = Math.abs(ours[i] - ref[i]);
    if (!(d <= Infinity)) return { maxAbs: null, maxRel: null, worst: { at: i }, pass: false };
    maxAbs = Math.max(maxAbs, d);
    maxRel = Math.max(maxRel, d / Math.max(Math.abs(ref[i]), 1e-6));
    const ratio = d / (TOLERANCE * Math.max(1, Math.abs(ref[i])));
    if (ratio > worst.ratio) worst = { ratio, x: Math.floor(i / 3) % width, y: Math.floor(i / 3 / width), component: 'RGB'[i % 3], ours: ours[i], ref: ref[i] };
  }
  return { maxAbs, maxRel, worst, pass: worst.ratio <= 1 };
}

/** 命令行；返回退出码 */
export function main(argv) {
  const { values: o } = parseArgs({ args: argv, options: Object.fromEntries(['device', 'prefilter', 'spp', 'width', 'height', 'exr', 'bin', 'rows', 'build'].map(k => [k, { type: 'string' }]).concat([['print', { type: 'boolean' }]])) });
  const device = o.device ?? 'cpu', prefilter = o.prefilter ?? 'accurate', rows = o.rows ?? 'cycles', build = o.build ?? 'oidn';
  if (!['cpu', 'cuda', 'metal'].includes(device) || !['accurate', 'fast', 'none'].includes(prefilter) || !['cycles', 'exr'].includes(rows) || !['oidn', 'oidn23'].includes(build)) throw usage('--device cpu|cuda|metal，--prefilter accurate|fast|none，--rows cycles|exr，--build oidn|oidn23');
  const [spp, width, height] = [['spp', 16], ['width', 320], ['height', 240]].map(([k, d]) => {
    const n = Number(o[k] ?? d);
    if (!Number.isInteger(n) || n <= 0) throw usage(`--${k} 要正整数`);
    return n;
  });
  let lib, built;
  try {
    lib = verifyOidnLibs(process.env, build);
    built = o.bin ? { bin: o.bin, key: null } : buildOidnRenderer(process.env, build);
  } catch (e) {
    throw Object.assign(e, { exit: e.missing ? 3 : 1 });
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'core-oidn-parity-'));
  try {
    let exrFile = o.exr, blender = null;
    if (!exrFile) {
      exrFile = path.join(work, 'cycles.exr');
      const script = path.join(work, 'scene.py');
      fs.writeFileSync(script, SCENE);
      const bin = findBlender();
      if (!bin) throw Object.assign(new Error('找不到 Blender：设 BEIMING_BLENDER'), { exit: 3 });
      const r = spawnSync(bin, ['-b', '--factory-startup', '-noaudio', '--python-exit-code', '1', '--python', script, '--', exrFile, device, prefilter, String(spp), String(width), String(height)], { encoding: 'utf8', maxBuffer: 1 << 26 });
      if (r.status !== 0 || !fs.existsSync(exrFile)) throw Object.assign(new Error(`Blender 没渲出来：${(r.stdout + r.stderr).trim().split('\n').slice(-5).join(' ')}`), { exit: 3 });
      blender = r.stdout.match(/BEIMING_BLENDER_VERSION (\S+)/)?.[1] ?? null;
      if (blender !== lib.entry.blender) throw Object.assign(new Error(`渲参考的 Blender 是 ${blender}，锁文件这一项（${build}）的库是 Blender ${lib.entry.blender} 自带的：设 BEIMING_BLENDER 指向 Blender ${lib.entry.blender}`), { exit: 3 });
    }
    const bytes = fs.readFileSync(exrFile);
    const exr = readBlenderExr(bytes);
    const [w, h] = [exr.width, exr.height];
    const flip = px => (rows === 'cycles' ? flipRows(px, w, h) : px);
    const inputs = { color: layer(exr, 'Noisy Image', ['R', 'G', 'B']), albedo: layer(exr, 'Denoising Albedo', ['R', 'G', 'B']), normal: layer(exr, 'Denoising Normal', ['X', 'Y', 'Z']) };
    const ref = layer(exr, 'Combined', ['R', 'G', 'B']);
    for (const [k, v] of Object.entries(inputs)) fs.writeFileSync(path.join(work, `${k}.f32`), Buffer.from(flip(v).buffer));
    const outFile = path.join(work, 'ours.f32');
    const r = spawnSync(built.bin, ['denoise', '--width', String(w), '--height', String(h), '--color', path.join(work, 'color.f32'), '--albedo', path.join(work, 'albedo.f32'), '--normal', path.join(work, 'normal.f32'), '-o', outFile, '--device', device, '--prefilter', prefilter], { encoding: 'utf8' });
    if (r.status !== 0) throw Object.assign(new Error(`core-render denoise 失败：${r.stderr.trim().split('\n').slice(-3).join(' ')}`), { exit: 3 });
    const stats = JSON.parse(r.stdout.trim().split('\n').pop());
    const raw = fs.readFileSync(outFile);
    const ours = flip(new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4));
    const cmp = compare(ours, ref, w);
    // 不降噪的差：同一个判据下带噪颜色离 Combined 多远，说明这一帧的降噪确实动了画面
    const noisy = compare(inputs.color, ref, w);
    const record = {
      format: 'core-oidn-parity/0.1', platform: lib.platform, build, blender: blender ?? lib.entry.blender, oidn: lib.entry.oidn,
      oidnLibs: Object.fromEntries(Object.entries(lib.entry.files).filter(([f]) => f.startsWith('libOpenImageDenoise'))),
      kernel: built.key, device, prefilter, quality: 'high', rows, spp, width: w, height: h, exrSha256: sha256(bytes), sceneSha256: o.exr ? null : sha256(SCENE),
      tolerance: TOLERANCE, maxAbs: cmp.maxAbs, maxRel: cmp.maxRel, worst: cmp.worst, pass: cmp.pass, bitwiseEqual: cmp.maxAbs === 0,
      noisyVsCombined: { maxAbs: noisy.maxAbs, maxRel: noisy.maxRel }, denoiseMs: stats.denoise_ms,
    };
    console.log(`${lib.platform} ${build} ${device} ${prefilter}：最大绝对差 ${cmp.maxAbs}，最大相对差 ${cmp.maxRel}，${cmp.pass ? '过' : '不过'}（判据 ${TOLERANCE}；带噪颜色对 Combined 的最大绝对差 ${noisy.maxAbs}）`);
    if (o.print) console.log(JSON.stringify(record, null, 1));
    else {
      const file = path.join(RECORDS, `${lib.platform}${build === 'oidn' ? '' : `-${build}`}-${device}-${prefilter}.json`);
      fs.mkdirSync(RECORDS, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(record, null, 1)}\n`);
      console.log(`写到 ${file}`);
    }
    return cmp.pass ? 0 : 4;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

runMain(import.meta.url, main);
