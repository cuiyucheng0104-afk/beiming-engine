#!/usr/bin/env node
// 北冥 · 对拍阶梯第 4 级：灯光。核心对标准答案机（Blender 5.2.3 Cycles，处理器，不降噪）出的参考包，按（场景包, 帧）一个取值点。
//   每个取值点核心照参考包的设置出 16 个种子（带 --passes，读颜色与每个分灯组），两道门照第 3 级（level3.mjs）逐通道判：
//     floor  核心一个种子对参考包 seed00 的整帧 HDR-FLIP 平均值 ≤ k × 地板。color 的地板读参考包的 floor.seedVsSeedFlipMean；
//            分灯组的地板参考包里没有，拿参考包 seed00 对 seed01 的同一个通道现算（量法与标准答案机量地板时相同），报告里写明是现算的
//     welch  核心 16 个种子对参考包 16 个种子
//   只判 l4/a（高光，27 帧）与 l4/b（点光、平行光）；别的只记不判：l4/c 链接（Cycles 有反弹光，比照记录见下）、l4/d 倒角与 AO
//   （图案节点还没生效）、l4/e 镜子与 l4/f 真包（核心没有漫反射、光泽各 4 次的分类弹射上限，间接光会混进来）。
//   另有四项：
//     能量比  每个取值点每个分灯组：核心 16 个种子均值对收敛图的整帧 RGB 之和，要在 [0.97, 1.03]（判，含只记两道门的取值点）
//     自检    黑世界、只有一盏灯的取值点：每像素 1 个样本时灯组之和逐像素等于 color（相对 1e-6）
//     链接    内核侧构造一个没有别的反弹路径的场景（一块板、黑世界、一盏只链接到画面外另一个物体的灯）：那盏灯的灯组严格为 0；
//            l4/c 与对照包（去掉链接）在被排除的实体（参考包核对记录 linkReading 的 excludedEntities）的整像素上 linked/control 只记录
//     负对照  关掉灯光链接（链接一项必须不过）、材质采样打中矩形纯光不做多重重要性采样（l4/a 两道门至少一项不过），
//            阴影射线不做明暗交界线的偏移（l4/a 两道门至少一项不过）；在 out/ 下的源码副本里改、另编
//   node beiming/sources/core/chassis/level4.mjs --root <参考包根目录> [--only <场景包名>] [--no-negative] [--out 报告.json]
//   参考包根目录同第 3 级（coverage.json、scene-packs/、refs/、checks.json）；不给 --root 时读 BEIMING_CORE_LADDER_ROOT。
// 退出码：0 全部过；4 有一项不过；3 缺工具链或参考包；2 用法错误。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { CliError, defineCommand, isMain, runCli } from '../../../../tools/lib/cli.mjs';
import { readExr } from '../../../verify/exr/exr.mjs';
import { floorGate, welchGate, THRESHOLDS } from '../../../verify/floorgate.mjs';
import { hdrFlip } from '../../../verify/hdrflip.mjs';
import { OUT, PRESETS, buildRenderer, missing } from './build.mjs';
import { MATCH, SEEDS } from './level3.mjs';
import { IDENTITY, translate, writePack } from './scenepack.mjs';

const WORK = path.join(OUT, 'level4');
/** 判两道门的取值点（编号前缀） */
export const JUDGED = ['l4/a/', 'l4/b/'];
export const ENERGY = [0.97, 1.03];
export const SELF_REL = 1e-6;
/** 对照包：去掉链接的 l4-link，不在覆盖表里，按参考包清单的 ref 认 */
export const CONTROL = 'l4-link-control';
const LIGHT = 'path/shaders/light.wgsl';
const AREA = 'shaders/area_light.wgsl';
export const NEGATIVES = [
  { name: '关掉灯光链接', check: 'link', inject: [{ file: LIGHT, from: 'fn light_linked(li: Light, receiver_set: u32) -> bool {\n', to: 'fn light_linked(li: Light, receiver_set: u32) -> bool {\n    return true;\n' }] },
  { name: '材质采样打中矩形纯光不做多重重要性采样（权重取 1）', check: 'l4a', inject: [{ file: LIGHT, from: 'let w = select(power_heuristic(pdf_b, e.pdf), 1.0, (state.flag & PATH_RAY_MIS_SKIP) != 0u);', to: 'let w = 1.0;' }] },
  { name: '阴影射线不做明暗交界线的偏移', check: 'l4a', inject: [{ file: AREA, from: '    if (offset_cutoff > 0.0) {\n      var NL', to: '    if (offset_cutoff > 1e30) {\n      var NL' }] },
];

const frame = (w, h, data) => ({ width: w, height: h, data, channels: 3 });

/** 参考包根目录里第 4 级的取值点：按（场景包, 帧）一个，加对照包。[{ ids, pack, frame, size, ref, judged }] */
export function level4Points(root) {
  const file = path.join(root, 'coverage.json');
  if (!fs.existsSync(file)) throw missing(`参考包根目录 ${root} 里没有 coverage.json`);
  const by = new Map();
  for (const p of JSON.parse(fs.readFileSync(file, 'utf8')).points.filter((x) => x.id.startsWith('l4/'))) {
    const pack = path.basename(p.scenePackDir), key = `${pack}#${p.frame}`;
    if (!by.has(key)) by.set(key, { ids: [], pack, frame: p.frame, size: p.size, ref: p.ref, judged: JUDGED.some((j) => p.id.startsWith(j)) });
    const g = by.get(key);
    if (g.ref !== p.ref) throw new Error(`覆盖表里 ${pack} 第 ${p.frame} 帧的取值点指向不同的参考包`);
    g.ids.push(p.id);
  }
  const refs = path.join(root, 'refs');
  for (const d of fs.existsSync(refs) ? fs.readdirSync(refs) : []) {
    const f = path.join(refs, d, 'ref.json');
    if (!fs.existsSync(f)) continue;
    const r = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (r.ref?.split('/')[1] === CONTROL && fs.existsSync(path.join(root, 'scene-packs', CONTROL))) {
      const link = [...by.values()].find((g) => g.pack === 'l4-link');
      by.set(`${CONTROL}#0`, { ids: ['l4/c/link-control'], pack: CONTROL, frame: 0, size: link?.size ?? [480, 270], ref: d, judged: false });
    }
  }
  return [...by.values()];
}

/** 参考包：清单与每个种子、收敛图的 color 与各分灯组（RGB，行主序）、物体编号与覆盖率 */
export function readRefLayers(root, address) {
  const dir = path.join(root, 'refs', address);
  const ref = JSON.parse(fs.readFileSync(path.join(dir, 'ref.json'), 'utf8'));
  const names = ['color', ...ref.channels.filter((c) => c.startsWith('lightgroup:'))];
  const load = (name) => {
    const e = readExr(fs.readFileSync(path.join(dir, name)));
    const c = e.channels, n = e.width * e.height, layers = {};
    for (const ch of names) {
      const rgb = new Float32Array(3 * n);
      for (let i = 0; i < n; i++) { rgb[3 * i] = c[`${ch}.R`][i]; rgb[3 * i + 1] = c[`${ch}.G`][i]; rgb[3 * i + 2] = c[`${ch}.B`][i]; }
      layers[ch] = rgb;
    }
    return { w: e.width, h: e.height, layers, id: c['objectId.id'], coverage: c['objectId.coverage'] };
  };
  return { ref, names, seeds: ref.files.filter((f) => /^seed\d+\.exr$/.test(f)).map(load), converged: load('converged.exr') };
}

const readF32 = (file) => { const b = fs.readFileSync(file); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

/** 核心按参考包的设置渲一个种子、出层，返回 { layers: { color, 'lightgroup:<名>': RGB 浮点 }, id, coverage, adapter } */
export function renderPasses(bin, packDir, { frame: k, size: [w, h], spp, seed, override }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-level4-'));
  try {
    const dir = path.join(tmp, 'passes'), stats = path.join(tmp, 's.json');
    const r = spawnSync(bin, ['render-pack', packDir, '-o', path.join(tmp, 'o.png'), '--passes', dir, '--stats', stats, '--frame', String(k), '--spp', String(spp),
      '--width', String(w), '--height', String(h), '--no-denoise', '--presets', PRESETS, '--override', JSON.stringify({ native: override })],
    { encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, THREERT_SEED: String(seed) } });
    if (r.status !== 0) throw Object.assign(new Error(`render-pack ${path.basename(packDir)} 种子 ${seed} 失败：${r.stderr.trim().split('\n').at(-1)}`), /adapter|GPU|显卡/i.test(r.stderr) ? { missing: 'GPU' } : {});
    const table = JSON.parse(fs.readFileSync(path.join(dir, 'passes.json'), 'utf8'));
    const rgba = readF32(path.join(dir, 'color.f32')), n = w * h, color = new Float32Array(3 * n);
    if (rgba.length !== 4 * n) throw new Error(`color 层的大小不对：${rgba.length} 个数，要 ${4 * n}`);
    for (let i = 0; i < n; i++) { color[3 * i] = rgba[4 * i]; color[3 * i + 1] = rgba[4 * i + 1]; color[3 * i + 2] = rgba[4 * i + 2]; }
    const layers = { color };
    for (const c of table.channels.filter((x) => x.name.startsWith('lightgroup:'))) layers[c.name] = readF32(path.join(dir, `lightgroup-${c.name.slice('lightgroup:'.length)}.f32`));
    const s = JSON.parse(fs.readFileSync(stats, 'utf8'));
    return { layers, id: new Uint32Array(readF32(path.join(dir, 'objectId.u32')).buffer), adapter: s.adapter ?? s.gpu ?? null };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

const sum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };

/** 能量比：核心各种子的整帧和的均值对收敛图的整帧和；收敛图为 0 时记 null */
export function energyRatio(cores, converged) {
  const ref = sum(converged), core = cores.reduce((a, c) => a + sum(c), 0) / cores.length;
  return ref > 0 ? core / ref : null;
}

/** 自检：灯组之和对 color，逐像素逐分量的最大相对差（|Σ − c| / max(|c|, 1e-30)；两边都是 0 记 0） */
export function groupSumError(layers) {
  const groups = Object.keys(layers).filter((k) => k.startsWith('lightgroup:')), c = layers.color;
  let worst = 0;
  for (let i = 0; i < c.length; i++) {
    let s = 0;
    for (const g of groups) s += layers[g][i];
    const d = Math.abs(s - c[i]);
    if (d > 0) worst = Math.max(worst, d / Math.max(Math.abs(c[i]), 1e-30));
  }
  return worst;
}

/** 一个通道的两道门。refFloor 为 null 时现算（参考包 seed00 对 seed01） */
function gates(w, h, cores, seeds, ref, refFloor) {
  const computed = refFloor === null;
  const fl = computed ? hdrFlip(frame(w, h, seeds[0]), frame(w, h, seeds[1])).value : refFloor;
  const value = hdrFlip(frame(w, h, seeds[0]), frame(w, h, cores[0])).value;
  const f = fl > 0 ? floorGate({ pack: { ...ref, floor: { ...ref.floor, seedVsSeedFlipMean: Math.min(fl, 1) } }, value }) : { status: 'unset', value, reason: '地板是 0（这一层全黑）' };
  const wg = welchGate(cores.map((c) => frame(w, h, c)), seeds.map((c) => frame(w, h, c)));
  return {
    floor: { status: f.status, value, threshold: f.threshold ?? null, floor: fl, floorSource: computed ? '现算：参考包 seed00 对 seed01' : '参考包清单 floor.seedVsSeedFlipMean' },
    welch: { pass: wg.pass, significantRatio: wg.significantRatio, alpha: wg.alpha, flat: wg.pHistogram.flat, testedUnits: wg.testedUnits },
    ok: f.status === 'pass' && wg.pass,
  };
}

/** 判一个取值点：逐通道两道门、能量比、自检（黑世界单灯时） */
export function judgePoint(root, bin, g, { override } = {}) {
  const cyc = readRefLayers(root, g.ref);
  const { ref } = cyc;
  if (cyc.seeds.length !== SEEDS.length) throw new Error(`${g.pack} 的参考包有 ${cyc.seeds.length} 个种子，要 ${SEEDS.length} 个`);
  const packDir = path.join(root, 'scene-packs', g.pack);
  const manifest = JSON.parse(fs.readFileSync(path.join(packDir, 'pack.json'), 'utf8'));
  const [w, h] = g.size;
  let adapter = null;
  const runs = SEEDS.map((seed) => {
    const r = renderPasses(bin, packDir, { frame: g.frame, size: g.size, spp: ref.samples, seed, override: override ?? MATCH(ref) });
    adapter = r.adapter;
    return r;
  });
  const channels = cyc.names.map((name) => {
    if (!runs[0].layers[name]) throw new Error(`${g.pack}：核心没有出 ${name} 这一层`);
    const cores = runs.map((r) => r.layers[name]), seeds = cyc.seeds.map((s) => s.layers[name]);
    return { name, ...gates(w, h, cores, seeds, ref, name === 'color' ? ref.floor.seedVsSeedFlipMean : null), energy: name === 'color' ? null : energyRatio(cores, cyc.converged.layers[name]) };
  });
  // 自检逐样本做：每像素 1 个样本时一个样本里各次贡献加进颜色与灯组的次序相同；1024 个样本的均值里两边累加的结合次序不同，
  // 单精度的舍入就有 1e-5 量级的相对差
  const single = manifest.lights.length === 1 && manifest.world.color.every((c) => c === 0);
  const selfCheck = single ? groupSumError(renderPasses(bin, packDir, { frame: g.frame, size: g.size, spp: 1, seed: 0, override: override ?? MATCH(ref) }).layers) : null;
  const energyOk = channels.every((c) => c.energy === null || (c.energy >= ENERGY[0] && c.energy <= ENERGY[1]));
  return {
    ids: g.ids, pack: g.pack, frame: g.frame, ref: g.ref, judged: g.judged, adapter, spp: ref.samples, size: g.size, channels,
    gatesOk: channels.every((c) => c.ok), energyOk, selfCheck, selfOk: selfCheck === null || selfCheck <= SELF_REL,
    runs: g.pack.startsWith('l4-link') ? runs.map((r) => r.layers['lightgroup:key']) : undefined,
    objectId: g.pack.startsWith('l4-link') ? cyc.converged : undefined,
  };
}

/** 链接比：被排除的实体（物体编号）整像素上 lightgroup:key 的平均亮度，linked / control（核心 16 种子均值；Cycles 收敛图） */
export function linkRatio(linked, control, entities) {
  const { id, coverage } = linked.objectId;
  const lum = (a, i) => 0.2126 * a[3 * i] + 0.7152 * a[3 * i + 1] + 0.0722 * a[3 * i + 2];
  const mean = (layers) => { let s = 0, n = 0; for (let i = 0; i < id.length; i++) if (entities.includes(id[i]) && coverage[i] === 1) { s += lum(layers, i); n++; } return { s: s / Math.max(n, 1), n }; };
  const coreMean = (runs) => runs.reduce((a, r) => a + mean(r).s, 0) / runs.length;
  const l = coreMean(linked.runs), c = coreMean(control.runs);
  const cl = mean(linked.objectId.layers['lightgroup:key']).s, cc = mean(control.objectId.layers['lightgroup:key']);
  return { pixels: cc.n, core: { linked: l, control: c, ratio: c > 0 ? l / c : null }, cycles: { linked: cl, control: cc.s, ratio: cc.s > 0 ? cl / cc.s : null } };
}

/** 内核侧的链接场景：一块 4 m 见方的板（实体 1）正对相机，板前 2 m 一盏朝它的矩形纯光，只链接到画面外、灯背面的另一块小板（实体 2）。
 *  黑世界，板只能被这盏灯照到，而这盏灯照不到它：key 那一层必须处处严格为 0 */
export function linkScenePack() {
  const plate = (name, s) => ({ name, positions: [-s, -s, 0, s, -s, 0, s, s, 0, -s, s, 0], normals: Array(4).fill([0, 0, 1]).flat(), indices: [0, 1, 2, 0, 2, 3] });
  const meshes = [plate('board', 2), plate('other', 0.1)];
  const manifest = {
    format: 'scene-pack/0.1', id: 'pack:chassis-link@1', units: { meter: 1, up: 'Y', hand: 'right' },
    geometry: { file: 'geometry.glb', meshes: meshes.map((m) => ({ name: m.name, tris: 2, attrs: ['position', 'cornerNormal'] })) },
    instances: { file: 'instances.u32', shape: [2, 4], names: ['board', 'other'], class: ['part', 'part'] },
    materials: [{ name: 'matte', closure: 'surface', params: { baseColor: [0.8, 0.8, 0.8], metallic: 0, roughness: 0.5 } }],
    lights: [{ name: 'key', type: 'area-rect', size: [1, 1], watts: 100, color: [1, 1, 1], visibleToCamera: false, link: ['other'] }],
    world: { color: [0, 0, 0], visibleToCamera: true },
    camera: { type: 'persp', near: 0.05, far: 50 },
    frames: {
      count: 1,
      instances: { file: 'frames/instances.f32', shape: [1, 2, 16], fields: ['mat16'] },
      camera: { file: 'frames/camera.f32', shape: [1, 17], fields: ['mat16', 'fovY'] },
      lights: { file: 'frames/lights.f32', shape: [1, 1, 16], fields: ['mat16'] },
    },
    source: { exporter: 'chassis/level4@0.1', blender: '5.2.3', sha256: '0'.repeat(64) },
  };
  return { manifest, meshes, rows: [[0, 0, 1, 0], [1, 0, 2, 0]], tables: { instances: [...IDENTITY, ...translate(30, 0, 2.5)], camera: [...translate(0, 0, 4), 0.8], lights: translate(0, 0, 2) } };
}

/** 渲内核侧的链接场景，返回 key 那一层的最大值与颜色的最大值 */
export function linkCheck(bin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-level4-link-'));
  try {
    writePack(dir, linkScenePack());
    const r = renderPasses(bin, dir, { frame: 0, size: [64, 48], spp: 64, seed: 0, override: { energyCompensation: 1, maxBounces: 8 } });
    const max = (a) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    return { keyMax: max(r.layers['lightgroup:key']), colorMax: max(r.layers.color), ok: max(r.layers['lightgroup:key']) === 0 };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const mark = (r) => ({ ...r, ok: (!r.judged || r.gatesOk) && r.energyOk && r.selfOk });
const strip = ({ runs, objectId, ...r }) => r;

export async function runLevel4({ root, only, negative = true, log = () => {} }) {
  if (!root) throw missing('参考包根目录（--root 或 BEIMING_CORE_LADDER_ROOT）');
  const points = level4Points(root).filter((g) => !only || g.pack === only);
  if (!points.length) throw new Error(only ? `第 4 级里没有场景包 ${only}` : '覆盖表里没有第 4 级的取值点');
  const { bin } = buildRenderer();
  const rows = [];
  for (const g of points) {
    log(`第 4 级 ${g.pack} 第 ${g.frame} 帧：${SEEDS.length} 个种子${g.judged ? '' : '（只记不判两道门）'}`);
    rows.push(mark(judgePoint(root, bin, g)));
  }
  const checks = fs.existsSync(path.join(root, 'checks.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'checks.json'), 'utf8')) : {};
  const linked = rows.find((r) => r.pack === 'l4-link'), control = rows.find((r) => r.pack === CONTROL);
  const reading = checks.linkReading ?? null;
  const link = {
    constructed: linkCheck(bin),
    record: linked && control && reading ? { ...linkRatio(linked, control, reading.excludedEntities), oracle: reading } : null,
  };
  const negatives = [];
  if (negative && !only) {
    for (const n of NEGATIVES) {
      log(`负对照：${n.name}`);
      const b = buildRenderer({ inject: n.inject }).bin;
      let caught;
      let detail;
      if (n.check === 'link') {
        detail = linkCheck(b);
        caught = !detail.ok;
      } else {
        // l4/a 每个包的第 0、2 帧（0° 与 75°）
        const pts = points.filter((g) => g.ids.some((id) => id.startsWith('l4/a/')) && g.frame !== 1);
        detail = pts.map((g) => { const r = judgePoint(root, b, g); return { pack: g.pack, frame: g.frame, gatesOk: r.gatesOk, channels: r.channels.map((c) => ({ name: c.name, floor: c.floor.status, welch: c.welch.pass })) }; });
        caught = detail.some((d) => !d.gatesOk);
      }
      negatives.push({ name: n.name, caught, detail });
    }
  }
  const out = rows.map(strip);
  return {
    format: 'beiming.core.level4/1', k: THRESHOLDS.k, alpha: THRESHOLDS.welch.alpha, seeds: SEEDS.length, energy: ENERGY, adapter: out[0]?.adapter ?? null,
    rows: out, link, negatives,
    ok: out.every((r) => r.ok) && link.constructed.ok && negatives.every((n) => n.caught),
  };
}

export const command = defineCommand({
  name: 'chassis-level4',
  summary: '对拍阶梯第 4 级：灯光。核心 16 个种子对标准答案机的参考包，逐通道（color 与各分灯组）过两道门，加能量比、灯组自检与灯光链接',
  usage: ['node beiming/sources/core/chassis/level4.mjs --root <参考包根目录> [--only <场景包名>] [--no-negative] [--out 报告.json]'],
  options: {
    root: { type: 'string', arg: '<目录>', describe: '参考包根目录（coverage.json、scene-packs/、refs/）；默认读 BEIMING_CORE_LADDER_ROOT' },
    only: { type: 'string', arg: '<场景包名>', describe: '只判这一包（不跑负对照）' },
    'no-negative': { type: 'boolean', describe: '不跑负对照' },
    out: { type: 'string', arg: '<文件>', describe: '报告写到哪里（默认 out/chassis/level4/report.json）' },
  },
  exitCodes: { 0: '全部过', 2: '用法错误', 3: '缺工具链或参考包', 4: '有一项不过' },
  async run(ctx) {
    let report;
    try {
      report = await runLevel4({ root: ctx.opts.root ?? process.env.BEIMING_CORE_LADDER_ROOT, only: ctx.opts.only, negative: !ctx.opts['no-negative'], log: (s) => ctx.log.info(s) });
    } catch (e) {
      if (e.missing) throw new CliError('env.chassis-toolchain', `缺：${e.missing}`, '参考包由标准答案机出，不在仓库里；要 cargo 与能跑 wgpu 的显卡');
      throw e;
    }
    const file = path.resolve(ctx.opts.out ?? path.join(WORK, 'report.json'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    for (const r of report.rows) {
      const ch = r.channels.map((c) => `${c.name} FLIP ${c.floor.value.toExponential(2)}/${c.floor.threshold?.toExponential(2) ?? '—'}${c.floor.status === 'pass' ? '' : `（${c.floor.status}）`} Welch ${c.welch.significantRatio.toExponential(1)}${c.welch.pass ? '' : '✗'}${c.energy === null ? '' : ` 能量比 ${c.energy?.toFixed(4)}`}`).join('；');
      ctx.out(`${r.ok ? '✓' : '✗'} ${r.pack}#${r.frame}${r.judged ? '' : '（两道门只记）'}  ${ch}${r.selfCheck === null ? '' : `  自检 ${r.selfCheck.toExponential(1)}`}`);
    }
    ctx.out(`${report.link.constructed.ok ? '✓' : '✗'} 链接（内核侧场景）：key 层最大 ${report.link.constructed.keyMax}，颜色最大 ${report.link.constructed.colorMax}`);
    if (report.link.record) ctx.out(`  l4/c 链接比（只记）：核心 ${report.link.record.core.ratio?.toExponential(3)}，Cycles 收敛图 ${report.link.record.cycles.ratio?.toExponential(3)}，核对记录 ${report.link.record.oracle.ratio.toExponential(3)}（${report.link.record.pixels} 个像素）`);
    for (const n of report.negatives) ctx.out(`${n.caught ? '✓' : '✗'} 负对照 ${n.name}：${n.caught ? '判得出' : '判不出'}`);
    ctx.out(`报告：${file}`);
    return { data: report, outputs: [{ path: file, kind: 'report' }], ...(!report.ok && { error: { code: 'contract.chassis-level4', message: '第 4 级有不过的项', hint: `明细见 ${file}` } }) };
  },
});

if (isMain(import.meta.url)) await runCli(command);
