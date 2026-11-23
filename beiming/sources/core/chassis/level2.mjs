#!/usr/bin/env node
// 北冥 · 对拍阶梯第 2 级：我方 GGX 金属闭包与矩形面光接进路径追踪内核（build.mjs 从 ../path/ 编出的 core-render）后渲图对答案。
//   上游自带的漫反射白炉用我们的程序跑要过，画面中央的均值与记下来的数相等；金属白炉 22 个读数对 Cycles（±0.5%）；
//   矩形面光照漫反射平面对解析值（0.2% 且 3 个标准误以内）；闭包、面光、接线各故意改错一项必须不过；同种子两遍逐字节相同。
//   node beiming/sources/core/chassis/level2.mjs [--out 报告.json]
// 退出码：0 全部过；4 有一项不过；3 缺工具链（git、cargo、npm、网络、显卡）。
// 渲染一律取内核的线性浮点原始输出（--hdr，曝光与后期之前），不降噪，萤火虫钳制放到不起作用。
// 场景入口暂时还是上游 ThreeRT 的：场景库、打包工具、自带的测试脚本按固定提交取（build.mjs 的 ensureUpstream）。
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { URL } from 'node:url';
import { CliError, defineCommand, isMain, runCli } from '../../../../tools/lib/cli.mjs';
import { polygonIrradiance } from '../fncheck/checks.mjs';
import { COMMIT, OUT, PRESETS, UPSTREAM, buildRenderer, ensureNodeModules, ensureUpstream, missing } from './build.mjs';

export const CYCLES = JSON.parse(fs.readFileSync(new URL('./cycles-furnace-metal.json', import.meta.url), 'utf8'));
export const GATES = { furnaceRel: 5e-3, analyticRel: 2e-3, analyticSE: 3 };
// 上游自带的漫反射白炉，画面中央的全精度均值，按显卡各记一个。同一台机器上渲染是确定的，记过的显卡要逐位相等。
// 换显卡或驱动，着色器编出来的浮点运算次序不同，均值会差在第 8 位上（这两台之间差 1.1e-8），所以没记过的显卡
// 按相对 1e-6 比。记法：在那台机器上跑一遍本脚本，把报告里 diffuseFurnace.mean 填进来。
export const DIFFUSE = { tolerance: 1e-6, recorded: { 'Apple M5 Pro|Metal': 0.9999757122248412, 'NVIDIA GeForce RTX 5090|Vulkan': 0.9999757010489703 } };
const WORK = path.join(OUT, 'level2');
const ROUGHNESS = Object.keys(CYCLES.GGX);
const lum = (px, i) => 0.2126 * px[3 * i] + 0.7152 * px[3 * i + 1] + 0.0722 * px[3 * i + 2];
const meanSe = xs => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { mean: m, se: Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1) / xs.length) };
};

/** 像素中心离画面中心小于 r 像素的像素下标（Cycles 白炉的读数口径） */
export function discPixels(w, h, r) {
  const out = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x + 0.5 - w / 2) ** 2 + (y + 0.5 - h / 2) ** 2 < r * r) out.push(y * w + x);
  return out;
}

/** 亮度 L 的单面朗伯矩形灯（灯心 center，半边向量 u、v）照 z = 0 上反照率 albedo 的朗伯平面，[-half, half]² 上出射辐亮度的均值（中点求积，双精度） */
export function rectMean({ L, albedo, light: { center: c, u, v }, half, n = 256 }) {
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => c.map((x, k) => x + a * u[k] + b * v[k]));
  let s = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) s += polygonIrradiance([half * ((2 * i + 1) / n - 1), half * ((2 * j + 1) / n - 1), 0], [0, 0, 1], corners);
  return albedo / Math.PI * L * s / (n * n);
}

// ---------------------------------------------------------------------------------------------------------------
// 场景：写成上游 ThreeRT 的场景模块（默认导出 () => { scene, camera, options }），用上游的 tools/bundle-game.ts 打包

const head = `import { Color, GeometryFunction, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, ProceduralGeometry, ProceduralMesh, RectAreaLight, Scene, SkyColor } from "@threert/scene";`;
// 球心在原点的单位解析球（ThreeRT 的程序化几何函数）。ThreeRT 自带的 proceduralSpheres 用 |o|² − r² 求判别式，相机在 100 m 外时
// 相消误差把交点挪开约 1e-4，比它的射线起点偏移还大，反射光线会从球里面出发；这里先求射线上离球心最近的点再算，误差在 1e-5 以下
const SPHERE = `new ProceduralGeometry(new GeometryFunction("beiming_unit_sphere", { code: \`
    let a = dot(i.d, i.d);
    let b = dot(i.o, i.d) / a;
    let f = i.o - b * i.d;
    let disc = 1.0 - dot(f, f);
    if (disc >= 0.0) {
        let q = sqrt(disc / a);
        var t = -b - q;
        if (t <= i.tmin) { t = -b + q; }
        if (t > i.tmin && t < i.tmax) {
            o.t = t;
            o.normal = i.o + i.d * t;
            o.material = 0u;
        }
    }\` }), [-1, -1, -1, 1, 1, 1])`;
const cam = (pos, fovDeg) => `const c = new PerspectiveCamera(${fovDeg}, 1, 0.01, 10000); c.position.set(${pos}); c.lookAt(0, 0, 0); c.setManualExposure(0); scene.add(c);`;
const opts = (size, native) => `{ name: "level2", width: ${size}, height: ${size}, preset: "cinematic", overrides: { native: ${JSON.stringify({ clampIndirect: 1e30, ...native })} } }`;

/** 白炉：ThreeRT 没有正交相机，用透视相机放在 D 处，过球心那个平面上的半高取 Cycles 正交相机的 1.25。
 *  白炉里一个像素的值只取决于视线对球的碰撞参数 b（入射角 asin b），透视下 b = ρ / sqrt(1 + (ρ/D)²)（ρ 是过球心平面上的位置），
 *  与正交差的是 (ρ/D)² 的二阶小量；读数随 D 的变化由两档 D 实测给出。球是解析球（程序化几何，见 SPHERE），不是网格 */
function furnaceScene({ roughness, compensate, D }) {
  return `${head}
export default function () {
  const scene = new Scene();
  scene.environment = new SkyColor(0xffffff, 1);
  scene.add(new ProceduralMesh(${SPHERE}, new MeshStandardMaterial({ color: new Color().setRGB(1, 1, 1), metalness: 1, roughness: ${roughness} })));
  ${cam(`0, 0, ${D}`, (2 * Math.atan(1.25 / D) * 180) / Math.PI)}
  return { scene, camera: c, options: ${opts(128, { energyCompensation: compensate ? 1 : 0 })} };
}`;
}

/** 解析场景的几何：z = 0 上反照率 0.5 的朗伯平面（20 m 见方、朝 +z），边长 0.5 m、亮度 10 nits 的方形纯光，
 *  相机在 (0, 0, 3) 正对平面，64×64 像素看平面上 ±0.4 m，取中间 16×16 像素（平面上 ±0.1 m）。相机光轴垂直于平面，
 *  像素到平面是线性映射，像素内均匀抖动，所以区域的像素均值就是平面上那个方块里出射辐亮度的均值；方块对称，灯左右翻转读数不变 */
export const RECT = { L: 10, albedo: 0.5, size: 0.5, image: 64, region: 16, Zc: 3, halfView: 0.4 };
const GEOMS = [{ name: '正对', position: [0, 0, 1] }, { name: '斜向', position: [0.8, 0, 0.9] }];

/** three.js 的 lookAt（灯与相机的 -z 指向目标、上方向 +y）定出的灯面半边向量 */
function lightAxes(position, size) {
  const z = position.map(x => x / Math.hypot(...position));
  const x0 = [z[2], 0, -z[0]], lx = Math.hypot(...x0), x = x0.map(a => a / lx);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return { center: position, u: x.map(a => a * size / 2), v: y.map(a => a * size / 2) };
}

function rectScene({ position }) {
  const { L, albedo: a, size, image, Zc, halfView } = RECT;
  return `${head}
export default function () {
  const scene = new Scene();
  scene.environment = new SkyColor(0xffffff, 0);
  scene.add(new Mesh(new PlaneGeometry(20, 20), new MeshPhysicalMaterial({ color: new Color().setRGB(${a}, ${a}, ${a}), roughness: 1, metalness: 0, specularIntensity: 0 })));
  const r = new RectAreaLight(0xffffff, ${L}, ${size}, ${size});
  r.position.set(${position});
  r.lookAt(0, 0, 0);
  r.card = false;
  scene.add(r);
  ${cam(`0, 0, ${Zc}`, (2 * Math.atan(halfView / Zc) * 180) / Math.PI)}
  return { scene, camera: c, options: ${opts(image, { energyCompensation: 0 })} };
}`;
}

/** 把场景源码打成 ThreeRT 的场景包（按内容命名，同一份只打一次） */
function bundle(name, source) {
  const dir = path.join(WORK, 'scenes');
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, `${name}.scene.js`), out = path.join(dir, `${name}.js`);
  if (fs.existsSync(out) && fs.existsSync(src) && fs.readFileSync(src, 'utf8') === source) return out;
  fs.writeFileSync(src, source);
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(UPSTREAM, 'tools', 'bundle-game.ts'), src, '-o', out], { cwd: UPSTREAM, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`打场景包 ${name} 失败：${err}`))));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// 渲染：一个 core-render serve 进程是一个种子（THREERT_SEED 在进程启动时读一次；内核的环境变量沿用上游的名字）

async function serve(bin, seed) {
  const p = spawn(bin, ['serve', '--presets', PRESETS], { cwd: UPSTREAM, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, THREERT_SEED: String(seed) } });
  let err = '';
  p.stderr.on('data', d => { err = (err + d).slice(-4000); });
  const lines = createInterface({ input: p.stdout })[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done) throw missing(`core-render serve 没起来（拿不到显卡？）：${err.trim().split('\n').slice(-3).join(' ')}`);
  const adapter = JSON.parse(first.value).adapter;
  let id = 0;
  return {
    adapter,
    async render(game, spp, tag) {
      const hdr = path.join(WORK, 'raw', `${tag}-s${seed}.raw`);
      fs.mkdirSync(path.dirname(hdr), { recursive: true });
      p.stdin.write(`${JSON.stringify({ id: ++id, game, assets: UPSTREAM, out: hdr.replace(/\.raw$/, '.png'), hdr, spp, denoise: false })}\n`);
      const reply = JSON.parse((await lines.next()).value ?? '{"ok":false,"error":"serve 退出了"}');
      if (!reply.ok) throw new Error(`渲染 ${tag} 失败：${reply.error}\n${err}`);
      const buf = fs.readFileSync(hdr);
      return { px: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4), bytes: buf, w: reply.stats.width, h: reply.stats.height };
    },
    close: () => new Promise(resolve => { p.on('close', resolve); p.stdin.end(); }),
  };
}

/** 每个种子开一个渲染进程，把 jobs（{ game, spp, tag, read(image) → 数 }）各渲一遍，返回 [作业][种子] 的读数 */
async function renderSeeds(bin, seeds, jobs) {
  const out = jobs.map(() => []);
  let adapter;
  for (const seed of seeds) {
    const s = await serve(bin, seed);
    adapter = s.adapter;
    try {
      for (const [k, j] of jobs.entries()) out[k].push(j.read(await s.render(j.game, j.spp, j.tag)));
    } finally { await s.close(); }
  }
  return { readings: out, adapter };
}

// ---------------------------------------------------------------------------------------------------------------

const FURNACE = { spp: 1024, seeds: [1, 2, 3, 4], D: [100, 30] };
const ANALYTIC = { spp: 4096, seeds: [1, 2, 3, 4, 5, 6, 7, 8] };

export async function furnace(bin, { D = FURNACE.D[0], seeds = FURNACE.seeds, rows = null } = {}) {
  const disc = discPixels(128, 128, CYCLES.image.inner_disc_frac * CYCLES.image.sphere_radius_px);
  const cases = rows ?? ['GGX', 'MULTI_GGX'].flatMap(distribution => ROUGHNESS.map(roughness => ({ distribution, roughness })));
  const jobs = [];
  for (const c of cases) {
    const tag = `furnace-${c.distribution}-r${c.roughness}-D${D}`;
    jobs.push({ tag, spp: FURNACE.spp, game: await bundle(tag, furnaceScene({ roughness: +c.roughness, compensate: c.distribution === 'MULTI_GGX', D })), read: ({ px }) => disc.reduce((s, i) => s + lum(px, i), 0) / disc.length });
  }
  const { readings, adapter } = await renderSeeds(bin, seeds, jobs);
  return {
    adapter,
    rows: cases.map((c, k) => {
      const { mean, se } = meanSe(readings[k]), ref = CYCLES[c.distribution][c.roughness];
      return { ...c, ours: mean, se, cycles: ref, rel: mean / ref - 1 };
    }),
  };
}

export async function analytic(bin, { seeds = ANALYTIC.seeds, geoms = GEOMS } = {}) {
  const { image, region } = RECT, lo = (image - region) / 2;
  const jobs = [];
  for (const g of geoms) {
    jobs.push({
      tag: `rect-${g.position.join('_')}`, spp: ANALYTIC.spp, game: await bundle(`rect-${g.position.join('_')}`, rectScene(g)),
      read: ({ px, w }) => {
        let s = 0;
        for (let y = lo; y < lo + region; y++) for (let x = lo; x < lo + region; x++) s += lum(px, y * w + x);
        return s / (region * region);
      },
    });
  }
  const { readings } = await renderSeeds(bin, seeds, jobs);
  return geoms.map((g, k) => {
    const { mean, se } = meanSe(readings[k]);
    const exact = rectMean({ L: RECT.L, albedo: RECT.albedo, light: lightAxes(g.position, RECT.size), half: RECT.halfView * region / image });
    return { name: g.name, position: g.position, seeds: seeds.length, spp: ANALYTIC.spp, mean, se, exact, rel: mean / exact - 1, z: (mean - exact) / se };
  });
}

/** 上游自带的漫反射白炉（tests/render/furnace-diffuse.ts），用上游的 tools/test-render.ts 跑我们的程序 */
function upstreamTest(bin) {
  const out = path.join(WORK, 'upstream-test');
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(UPSTREAM, 'tools', 'test-render.ts'), 'furnace/diffuse', '--out', out, '--json', path.join(out, 'results.json')],
      { cwd: UPSTREAM, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, THREERT_BIN: bin, THREERT_GPU_LOCK: path.join(WORK, 'gpu.lock') } });
    let log = '';
    p.stdout.on('data', d => { log += d; });
    p.stderr.on('data', d => { log += d; });
    p.on('close', () => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')).results.find(x => x.id === 'furnace/diffuse');
        resolve({ ...r, raw: fs.readFileSync(path.join(out, 'furnace-diffuse.raw')) });
      } catch (e) { reject(new Error(`上游的漫反射白炉没跑出结果：${e.message}\n${log}`)); }
    });
  });
}

// 负对照：在源码的拷贝上各故意改错一项（build.mjs 的 inject；file 相对 beiming/sources/core/，工作树不动）
const NEGATIVE = [
  {
    target: 'closure', name: '闭包：求值的遮蔽项漏掉出射方向的 lambda（G2 写成 G1）',
    inject: { file: 'shaders/microfacet.wgsl', from: 'reflectance * common_ / (1.0 + lambdaO + lambdaI)', to: 'reflectance * common_ / (1.0 + lambdaI)' },
    run: async bin => (await furnace(bin, { seeds: [1], rows: ['0.30', '0.60', '1.00'].map(roughness => ({ distribution: 'GGX', roughness })) })).rows, gate: GATES.furnaceRel,
  },
  {
    target: 'area_light', name: '面光：辐射通量到辐亮度的换算多乘 1%',
    inject: { file: 'shaders/area_light.wgsl', from: 'ls.eval_fac = M_1_PI_F * invarea;', to: 'ls.eval_fac = M_1_PI_F * invarea * 1.01;' },
    run: async bin => analytic(bin, { seeds: [1, 2] }), gate: GATES.analyticRel,
  },
  {
    target: 'mis', name: '接线：材质采样打到矩形纯光时不取光（多重重要性采样只剩光源一侧的权重）',
    inject: { file: 'path/shaders/integrator.wgsl', from: 'if (!LIVE && state.legacy.bm_surf) {', to: 'if (false && state.legacy.bm_surf) {' },
    run: async bin => analytic(bin, { seeds: [1, 2] }), gate: GATES.analyticRel,
  },
];

/** 跑完第 2 级，返回报告（ok 为全部过） */
export async function runLevel2({ allowFetch = true, log = () => {} } = {}) {
  const t0 = Date.now();
  const say = s => log(`[${((Date.now() - t0) / 1000).toFixed(0)} s] ${s}`);
  ensureUpstream({ allowFetch });
  say('构建：从 beiming/sources/core/path/ 编 core-render');
  const ours = buildRenderer();
  ensureNodeModules();
  const info = spawnSync(ours.bin, ['info'], { encoding: 'utf8' });
  if (info.status !== 0) throw missing(`core-render info 没跑起来（拿不到显卡？）：${(info.stderr || String(info.error)).trim().split('\n').slice(-3).join(' ')}`);
  const gpu = JSON.parse(info.stdout);

  say('上游自带的漫反射白炉');
  const diffuse = await upstreamTest(ours.bin);
  // 它自己报的读数只留 4 位有效数字，这里另从原始输出按它的取样区域（画面中央 10%）算全精度均值
  const center = px => {
    const [w, h] = [160, 90], [x0, x1, y0, y1] = [Math.floor(0.45 * w), Math.ceil(0.55 * w), Math.floor(0.45 * h), Math.ceil(0.55 * h)];
    let s = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += lum(px, y * w + x);
    return s / ((x1 - x0) * (y1 - y0));
  };
  const mean = center(new Float32Array(diffuse.raw.buffer, diffuse.raw.byteOffset, diffuse.raw.length / 4));
  const recorded = DIFFUSE.recorded[`${gpu.adapter}|${gpu.backend}`] ?? null;
  const diffuseFurnace = {
    status: diffuse.status, measured: diffuse.measured, mean, adapter: gpu.adapter, backend: gpu.backend, recorded,
    // 按「显卡加后端」记数。记过的应当逐位相等；换了驱动或着色器编译器会差在末位，那时只要还在容差内就算过，并提示重新登记。没记过的按容差对已有的记录比
    exact: recorded !== null && mean === recorded,
    matches: (recorded === null ? Object.values(DIFFUSE.recorded) : [recorded]).some(v => Math.abs(mean / v - 1) < DIFFUSE.tolerance),
    rule: recorded === null ? `这块显卡与后端没记过，按相对 ${DIFFUSE.tolerance} 比` : mean === recorded ? '逐位相等' : `与记录不再逐位相等，仍在相对 ${DIFFUSE.tolerance} 之内；请重新登记这块显卡的数`,
  };

  say('金属白炉');
  const main = await furnace(ours.bin);
  const near = await furnace(ours.bin, { D: FURNACE.D[1], seeds: [1] });
  const camera = { D: FURNACE.D, fovNote: '过球心平面上的半高 1.25（正交 ortho_scale 2.5 的一半）', maxRelChange: Math.max(...main.rows.map((r, k) => Math.abs(near.rows[k].ours / r.ours - 1))) };

  say('矩形面光照漫反射平面');
  const ana = await analytic(ours.bin);

  say('负对照');
  const negative = [];
  for (const n of NEGATIVE) {
    const b = buildRenderer({ inject: [n.inject] });
    const rows = await n.run(b.bin);
    negative.push({ target: n.target, name: n.name, inject: n.inject, gate: n.gate, rows, worstRel: rows.reduce((w, r) => (Math.abs(r.rel) > Math.abs(w) ? r.rel : w), 0) });
  }

  say('同一种子渲两遍');
  const det = {};
  const one = async () => {
    const s = await serve(ours.bin, 7);
    try {
      return [await s.render(await bundle('det-furnace', furnaceScene({ roughness: 0.5, compensate: true, D: 100 })), 256, 'det-furnace'), await s.render(await bundle('det-rect', rectScene(GEOMS[1])), 256, 'det-rect')].map(r => Buffer.from(r.bytes));
    } finally { await s.close(); }
  };
  const [a, b] = [await one(), await one()];
  det.identical = a.every((x, k) => x.equals(b[k]));
  det.maxAbsDiff = Math.max(...a.map((x, k) => {
    const p = new Float32Array(x.buffer, x.byteOffset, x.length / 4), q = new Float32Array(b[k].buffer, b[k].byteOffset, b[k].length / 4);
    return p.reduce((m, v, i) => Math.max(m, Math.abs(v - q[i])), 0);
  }));
  det.cases = ['白炉 粗糙度 0.5 开补偿 256 采样', '斜向面光 256 采样'];

  const checks = {
    构建: diffuseFurnace.status === 'pass' && diffuseFurnace.matches,
    白炉: main.rows.every(r => Math.abs(r.rel) <= GATES.furnaceRel && r.se / r.cycles < GATES.furnaceRel / 10) && camera.maxRelChange < GATES.furnaceRel / 10,
    解析场景: ana.every(x => Math.abs(x.rel) <= GATES.analyticRel && Math.abs(x.z) <= GATES.analyticSE),
    负对照: negative.every(n => Math.abs(n.worstRel) > n.gate),
    确定性: det.identical,
  };
  say('完成');
  return {
    ok: Object.values(checks).every(Boolean), checks, gates: GATES, platform: `${process.platform}-${process.arch}`, adapter: main.adapter, seconds: (Date.now() - t0) / 1000,
    core: { source: 'beiming/sources/core/path', bin: path.basename(ours.bin), key: ours.key, shaders: ours.shaders }, upstream: { commit: COMMIT, use: '场景库、场景打包工具、自带的测试脚本、素材根目录' },
    diffuseFurnace,
    furnace: { spp: FURNACE.spp, seeds: FURNACE.seeds, D: FURNACE.D[0], image: CYCLES.image, rows: main.rows, camera, nearRows: near.rows },
    analytic: ana, analyticSetup: RECT, negative, determinism: det,
  };
}

export const command = defineCommand({
  name: 'chassis-level2',
  summary: '对拍阶梯第 2 级：我方闭包与面光接进路径追踪内核后渲白炉（对 Cycles）与解析场景，外加负对照与确定性',
  usage: ['node beiming/sources/core/chassis/level2.mjs [--out 报告.json]'],
  options: { out: { type: 'string', arg: '<文件>', describe: '报告写到哪里（默认 out/chassis/level2/report.json）' } },
  exitCodes: { 0: '全部过', 2: '用法错误', 3: '缺工具链', 4: '有一项不过' },
  async run(ctx) {
    let report;
    try {
      report = await runLevel2({ log: s => ctx.log.info(s) });
    } catch (e) {
      if (e.missing) throw new CliError('env.chassis-toolchain', `缺工具链：${e.missing}`, '要 git、cargo（Rust 1.100.0，可以在 ~/.cargo/bin）、npm、第一次取源码时的网络，以及能跑 wgpu 的显卡');
      throw e;
    }
    const file = path.resolve(ctx.opts.out ?? path.join(WORK, 'report.json'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    for (const r of report.furnace.rows) ctx.out(`${Math.abs(r.rel) <= GATES.furnaceRel ? '✓' : '✗'} 白炉 ${r.distribution.padEnd(9)} ${r.roughness}  我方 ${r.ours.toFixed(6)} ± ${r.se.toExponential(1)}  Cycles ${r.cycles.toFixed(6)}  相对差 ${r.rel.toExponential(2)}`);
    for (const a of report.analytic) ctx.out(`${Math.abs(a.rel) <= GATES.analyticRel && Math.abs(a.z) <= GATES.analyticSE ? '✓' : '✗'} 面光 ${a.name}  我方 ${a.mean.toPrecision(7)} ± ${a.se.toExponential(1)}  解析 ${a.exact.toPrecision(7)}  相对差 ${a.rel.toExponential(2)}  ${a.z.toFixed(2)} 个标准误`);
    for (const n of report.negative) ctx.out(`${Math.abs(n.worstRel) > n.gate ? '✓' : '✗'} 负对照 ${n.name}：最大相对差 ${n.worstRel.toExponential(2)}`);
    ctx.out(`各项：${Object.entries(report.checks).map(([k, v]) => `${k} ${v ? '过' : '不过'}`).join('，')}；报告：${file}`);
    const bad = Object.keys(report.checks).filter(k => !report.checks[k]);
    return { data: report, outputs: [{ path: file, kind: 'report' }], ...(bad.length && { error: { code: 'contract.chassis-level2', message: `不过：${bad.join('、')}`, hint: `明细见 ${file}` } }) };
  },
});

if (isMain(import.meta.url)) await runCli(command);
