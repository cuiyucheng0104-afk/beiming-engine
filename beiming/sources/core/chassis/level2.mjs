#!/usr/bin/env node
// 北冥 · 对拍阶梯第 2 级：我方 GGX 金属闭包与矩形面光接进路径追踪内核（build.mjs 从 ../path/ 编出的 core-render）后渲图对答案。
//   上游自带的漫反射白炉用我们的程序跑要过，画面中央的均值与记下来的数相等；金属白炉 22 个读数对 Cycles（±0.5%）；
//   电介质与混合白炉（原理化 BSDF）14 个读数、底色 0 的电介质白炉 7 个读数对 Cycles（±0.5%）；镜中的矩形纯光对 F·L（0.2%）；网格的公共边上相机射线不漏（软件求交一个都不许少，苹果显卡的硬件求交只钉上限）；Pharr 自发光球与矩形面光照漫反射平面四种几何对解析值
//   （32 个种子，0.2% 以内，且在 3 个标准误或相对 2e-6 以内）；闭包、面光、接线故意改错十四项，每项必须不过；
//   同种子两遍逐字节相同。
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
// 电介质与混合白炉：底色 1 的原理化 BSDF，键是「金属度/粗糙度」；做法与金属白炉相同（见那份文件的 source.method_check）
export const PRINCIPLED = JSON.parse(fs.readFileSync(new URL('./cycles-furnace-principled.json', import.meta.url), 'utf8'));
// 对 F0 敏感的电介质白炉：底色 0、金属度 0 的原理化 BSDF（只剩电介质高光，读数就是它的方向反照率），
// 键是「折射率/高光等级/高光染色/粗糙度」；做法与上面那份相同，脚本另一份（见 source）
export const PRINCIPLED_F0 = JSON.parse(fs.readFileSync(new URL('./cycles-furnace-principled-f0.json', import.meta.url), 'utf8'));
// analyticFloor：数值精度的底。解析场景的标准误可以小到相对 1e-6 以下，而单精度算出来的读数对解析值本来就有
// 百万分之零点五以内的固定残差（同一串随机数在两块显卡上还系统地差 2e-7 到 6e-7），只按标准误判就是在判这点残差。
// 底取相对 2e-6，约为残差的五倍。种子取 32 个：8 个种子估出来的标准误尾巴很重，均值超过 3 个标准误的概率约 2%
export const GATES = { furnaceRel: 5e-3, analyticRel: 2e-3, analyticSE: 3, analyticFloor: 2e-6 };
export const mirrorOk = a => Math.abs(a.rel) <= GATES.analyticRel;
export const analyticOk = a => Math.abs(a.rel) <= GATES.analyticRel && (Math.abs(a.z) <= GATES.analyticSE || Math.abs(a.rel) <= GATES.analyticFloor);
/** 超过了 3 个标准误、靠那条底才过的读数：输出里要提示 */
export const passedByFloor = a => analyticOk(a) && Math.abs(a.z) > GATES.analyticSE;
// 上游自带的漫反射白炉，画面中央的全精度均值，按显卡各记一个。同一台机器上渲染是确定的，记过的显卡要逐位相等。
// 换显卡或驱动，着色器编出来的浮点运算次序不同，均值会差在第 8 位上（这两台之间差 0.9e-8），所以没记过的显卡
// 按相对 1e-6 比。记法：在那台机器上跑一遍本脚本，把报告里 diffuseFurnace.mean 填进来。
// 2026-11-25 两台都重记过：漫反射改走照 Cycles 移植的 bsdf_diffuse（余弦半球采样、取 PRNG_SURFACE_BSDF 那组随机数），
// 不再是上游顶替的朗伯（它把 5% 的样本分给零高光的那一瓣，随机数也是上游的那一组），读数随之换了一串噪声（苹果显卡
// 1.0007596 → 1.0004397，英伟达显卡 1.0007596 → 1.0004399，都仍在上游自己的 2% 门内；两台之间现在差 1.1e-7）
export const DIFFUSE = { tolerance: 1e-6, recorded: { 'Apple M5 Pro|Metal': 1.0004397429525853, 'NVIDIA GeForce RTX 5090|Vulkan': 1.0004398547112943 } };
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

/** 亮度 L 的单面朗伯矩形灯（灯心 center，半边向量 u、v）照 z = 0 上反照率 albedo 的朗伯平面，[-half, half]² 上出射辐亮度的均值（中点求积，双精度；n = 1024 时求积误差在相对 4e-8 以下；256 时近灯是 6.8e-7，与读数的残差同量级） */
export function rectMean({ L, albedo, light: { center: c, u, v }, half, n = 1024 }) {
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
function furnaceScene({ roughness, compensate, D, metalness = 1, maxBounces, color = 1, ior, specularIntensity }) {
  const physical = ior !== undefined || specularIntensity !== undefined;
  const extra = physical ? `, ior: ${ior ?? 1.5}, specularIntensity: ${specularIntensity ?? 1}` : '';
  return `${head}
export default function () {
  const scene = new Scene();
  scene.environment = new SkyColor(0xffffff, 1);
  scene.add(new ProceduralMesh(${SPHERE}, new ${physical ? 'MeshPhysicalMaterial' : 'MeshStandardMaterial'}({ color: new Color().setRGB(${color}, ${color}, ${color}), metalness: ${metalness}, roughness: ${roughness}${extra} })));
  ${cam(`0, 0, ${D}`, (2 * Math.atan(1.25 / D) * 180) / Math.PI)}
  return { scene, camera: c, options: ${opts(128, { energyCompensation: compensate ? 1 : 0, ...(maxBounces && { maxBounces }) })} };
}`;
}

/** Pharr 的自发光球（PBRT 第 3 版的「white furnace」变体）：相机在半径 1 的解析球里面，球面是反照率 albedo 的朗伯面、
 *  自发光辐亮度 Le，世界是黑的。处处的出射辐亮度满足 L = Le + albedo·L，所以每个像素都趋近 Le/(1 − albedo)。
 *  弹射上限取 128（截断的偏差是 albedo^129，远在门限之下）。高光强度 0：没有电介质高光，只有漫反射与发光 */
export const PHARR = { albedo: 0.5, Le: 0.5, image: 64, maxBounces: 128 };
function pharrScene() {
  const { albedo: a, Le, image, maxBounces } = PHARR;
  return `${head}
export default function () {
  const scene = new Scene();
  scene.environment = new SkyColor(0xffffff, 0);
  scene.add(new ProceduralMesh(${SPHERE}, new MeshPhysicalMaterial({ color: new Color().setRGB(${a}, ${a}, ${a}), roughness: 1, metalness: 0, specularIntensity: 0, emissive: new Color().setRGB(1, 1, 1), emissiveIntensity: ${Le} })));
  const c = new PerspectiveCamera(60, 1, 0.01, 10); c.position.set(0, 0, 0.3); c.lookAt(0.2, 0.1, -1); c.setManualExposure(0); scene.add(c);
  return { scene, camera: c, options: ${opts(image, { energyCompensation: 1, maxBounces })} };
}`;
}

/** 解析场景的几何：z = 0 上反照率 0.5 的朗伯平面（20 m 见方、朝 +z），边长 0.5 m、亮度 10 nits 的方形纯光，
 *  相机在 (0, 0, 3) 正对平面，64×64 像素看平面上 ±0.4 m，取中间 16×16 像素（平面上 ±0.1 m）。相机光轴垂直于平面，
 *  像素到平面是线性映射，像素内均匀抖动，所以区域的像素均值就是平面上那个方块里出射辐亮度的均值；方块对称，灯左右翻转读数不变 */
export const RECT = { L: 10, albedo: 0.5, size: 0.5, image: 64, region: 16, Zc: 3, halfView: 0.4 };
const GEOMS = [{ name: '正对', position: [0, 0, 1] }, { name: '斜向', position: [0.8, 0, 0.9] }];
// 灯高 0.25 m 正对。射线起点沿法线挪开的那一点距离与灯距的比，它比上面两种大：材质采样一侧要是从挪开的起点算矩形灯，
// 这个读数偏高万分之二（上面两种只有百万分之二与千万分之四）。它的噪声也大（32 个种子的标准误是相对 5e-6 上下），
// 只进第 2 级的判定，不进回归基线逐位比的那 24 个读数
const NEAR = { name: '近灯', position: [0, 0, 0.25] };
// 斜向那个几何，灯背后 30 微米放一块 0.7 m 见方、与灯平行的黑板（plate 是板离灯面的米数）。黑板不反光，解析值与斜向相同。
// 30 微米比射线起点挪开的那一点距离小：材质采样一侧要是把从挪开的起点量的遮挡距离直接与从着色点量的灯距比，
// 会把灯判成被板挡住，读数偏低千分之一点五。也只进第 2 级的判定
const PLATE = { name: '灯后有板', position: [0.8, 0, 0.9], plate: 3e-5 };

/** three.js 的 lookAt（灯与相机的 -z 指向目标、上方向 +y）定出的灯面半边向量 */
function lightAxes(position, size) {
  const z = position.map(x => x / Math.hypot(...position));
  const x0 = [z[2], 0, -z[0]], lx = Math.hypot(...x0), x = x0.map(a => a / lx);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return { center: position, u: x.map(a => a * size / 2), v: y.map(a => a * size / 2) };
}

function rectScene({ position, plate }) {
  const { L, albedo: a, size, image, Zc, halfView } = RECT;
  const k = 1 + (plate ?? 0) / Math.hypot(...position);
  return `${head}
export default function () {
  const scene = new Scene();
  scene.environment = new SkyColor(0xffffff, 0);
  scene.add(new Mesh(new PlaneGeometry(20, 20), new MeshPhysicalMaterial({ color: new Color().setRGB(${a}, ${a}, ${a}), roughness: 1, metalness: 0, specularIntensity: 0 })));
  const r = new RectAreaLight(0xffffff, ${L}, ${size}, ${size});
  r.position.set(${position});
  r.lookAt(0, 0, 0);
  r.card = false;
  scene.add(r);${plate === undefined ? '' : `
  const bk = new Mesh(new PlaneGeometry(0.7, 0.7), new MeshPhysicalMaterial({ color: new Color().setRGB(0, 0, 0), roughness: 1, metalness: 0, specularIntensity: 0 }));
  bk.position.set(${position.map(x => x * k)});
  bk.lookAt(0, 0, 0);
  scene.add(bk);`}
  ${cam(`0, 0, ${Zc}`, (2 * Math.atan(halfView / Zc) * 180) / Math.PI)}
  return { scene, camera: c, options: ${opts(image, { energyCompensation: 0 })} };
}`;
}

/** 镜中的矩形纯光：z = 0 上粗糙度 0、金属度 0 的平面，两个三角形的公共边过原点、斜穿看的那一小块（底色 0.8：电介质高光是奇异的一瓣，
 *  压在漫反射上），世界是黑的。软件求交在公共边上不漏（见 edge）；苹果显卡默认的硬件求交器在那里漏一点相机射线，读数随之少约
 *  8e-5（相对），在 0.2% 的门内，不另作处理（内核条文「与 Cycles、与上游不一样的地方」第 47 条）。
 *  边长 size 的方形纯光放在离原点 R、与法线夹角 alpha 的方向上正对原点；相机在镜像方向上离原点 Zc，视角窄到每条相机射线
 *  经镜面反射都打在灯上。奇异的一瓣照 Cycles 不做多重重要性采样（PATH_RAY_MIS_SKIP），所以镜里的灯是 F·L 的全份；
 *  做错了按 power_heuristic(pb, pl) 加权：pb 约为 1e6 乘这一瓣的选中概率（约 0.11），pl = 1/灯的立体角（约 1e5），丢约一半。
 *  漫反射照到的那一点由「灯绕法线转 90°」的同一场景减掉（灯到原点的夹角不变，漫反射的读数相同；漫反射本身只有 F·L 的 1e-5）。
 *  关能量补偿：F 就是电介质的菲涅耳（广义 Schlick 在 exponent < 0、高光等级 0.5、染色 1 时等于它），权重是 1 */
export const MIRROR = { L: 10, albedo: 0.8, alpha: 60, R: 1, size: 3.2e-3, Zc: 3, fov: 0.02, ior: 1.5, image: 64 };
function mirrorScene({ turned }) {
  const { L, albedo: a, alpha, R, size, Zc, fov, image } = MIRROR, t = (alpha * Math.PI) / 180;
  const light = turned ? [0, R * Math.sin(t), R * Math.cos(t)] : [R * Math.sin(t), 0, R * Math.cos(t)];
  return `${head}
export default function () {
  const scene = new Scene();
  scene.environment = new SkyColor(0xffffff, 0);
  const m = new Mesh(new PlaneGeometry(20, 20), new MeshPhysicalMaterial({ color: new Color().setRGB(${a}, ${a}, ${a}), roughness: 0, metalness: 0, ior: ${MIRROR.ior} }));
  scene.add(m);
  const r = new RectAreaLight(0xffffff, ${L}, ${size}, ${size});
  r.position.set(${light});
  r.lookAt(0, 0, 0);
  r.card = false;
  scene.add(r);
  ${cam(`${-Zc * Math.sin(t)}, 0, ${Zc * Math.cos(t)}`, fov)}
  return { scene, camera: c, options: ${opts(image, { energyCompensation: 0 })} };
}`;
}

/** 电介质的非偏振菲涅耳反射率（双精度） */
export function fresnelDielectric(cosi, eta) {
  const ct = Math.sqrt(1 - (1 - cosi * cosi) / (eta * eta));
  const rs = (cosi - eta * ct) / (cosi + eta * ct), rp = (eta * cosi - ct) / (eta * cosi + ct);
  return (rs * rs + rp * rp) / 2;
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

async function serve(bin, seed, env = {}) {
  const p = spawn(bin, ['serve', '--presets', PRESETS], { cwd: UPSTREAM, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, THREERT_SEED: String(seed), ...env } });
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
async function renderSeeds(bin, seeds, jobs, env = {}) {
  const out = jobs.map(() => []);
  let adapter;
  for (const seed of seeds) {
    const s = await serve(bin, seed, env);
    adapter = s.adapter;
    try {
      for (const [k, j] of jobs.entries()) out[k].push(j.read(await s.render(j.game, j.spp, j.tag)));
    } finally { await s.close(); }
  }
  return { readings: out, adapter };
}

// ---------------------------------------------------------------------------------------------------------------

const FURNACE = { spp: 1024, seeds: [1, 2, 3, 4], D: [100, 30] };
const ANALYTIC = { spp: 4096, seeds: Array.from({ length: 32 }, (_, k) => k + 1) };
const MIRROR_SEEDS = ANALYTIC.seeds.slice(0, 8);

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

/** 电介质与混合白炉：原理化 BSDF（底色 1，其余取默认：折射率 1.5、高光等级 0.5），开能量补偿（Cycles 节点默认的分布
 *  MULTI_GGX），弹射上限 128（与 Cycles 那边相同）。读数口径与金属白炉相同 */
export async function principledFurnace(bin, { D = FURNACE.D[0], seeds = FURNACE.seeds, keys = Object.keys(PRINCIPLED.readings) } = {}) {
  const disc = discPixels(128, 128, PRINCIPLED.image.inner_disc_frac * PRINCIPLED.image.sphere_radius_px);
  const jobs = [];
  for (const k of keys) {
    const [metalness, roughness] = k.split('/').map(Number);
    const tag = `furnace-principled-m${metalness}-r${roughness}-D${D}`;
    jobs.push({ tag, spp: FURNACE.spp, game: await bundle(tag, furnaceScene({ roughness, metalness, compensate: true, D, maxBounces: 128 })), read: ({ px }) => disc.reduce((s, i) => s + lum(px, i), 0) / disc.length });
  }
  const { readings } = await renderSeeds(bin, seeds, jobs);
  return keys.map((k, j) => {
    const { mean, se } = meanSe(readings[j]), ref = PRINCIPLED.readings[k];
    const [metalness, roughness] = k.split('/');
    return { key: k, metalness, roughness, ours: mean, se, cycles: ref, rel: mean / ref - 1 };
  });
}

/** 对 F0 敏感的电介质白炉（底色 0）：读数口径与金属白炉相同。场景还带不进高光染色（材质记录的边缘色格子没有人写），
 *  染色不是白的那几档在源码拷贝上把材质输入值里高光染色的默认值换掉（build.mjs 的 inject），场景里只有这一个球 */
export const F0_TINT_INJECT = tint => ({ file: 'path/shaders/shader.wgsl', from: 'inp.specular_tint = vec3<f32>(1.0);', to: `inp.specular_tint = vec3<f32>(${tint.join(', ')});` });
export async function principledF0Furnace(bin, { D = FURNACE.D[0], seeds = FURNACE.seeds, keys = Object.keys(PRINCIPLED_F0.readings), inject = [] } = {}) {
  const disc = discPixels(128, 128, PRINCIPLED_F0.image.inner_disc_frac * PRINCIPLED_F0.image.sphere_radius_px);
  const parse = k => { const [ior, level, tint, roughness] = k.split('/'); return { ior: +ior, level: +level, tint: tint.split(',').map(Number), roughness: +roughness }; };
  const groups = new Map();
  for (const k of keys) {
    const t = parse(k).tint.join(','), g = groups.get(t) ?? [];
    groups.set(t, [...g, k]);
  }
  const out = new Map();
  for (const [t, ks] of groups) {
    const tint = t.split(',').map(Number);
    const b = tint.every(x => x === 1) ? bin : buildRenderer({ inject: [...inject, F0_TINT_INJECT(tint)] }).bin;
    const jobs = [];
    for (const k of ks) {
      const c = parse(k);
      const tag = `furnace-f0-ior${c.ior}-lvl${c.level}-r${c.roughness}-D${D}`;
      jobs.push({ tag, spp: FURNACE.spp, game: await bundle(tag, furnaceScene({ roughness: c.roughness, metalness: 0, color: 0, ior: c.ior, specularIntensity: 2 * c.level, compensate: true, D, maxBounces: 128 })), read: ({ px }) => disc.reduce((s, i) => s + lum(px, i), 0) / disc.length });
    }
    const { readings } = await renderSeeds(b, seeds, jobs);
    ks.forEach((k, j) => out.set(k, readings[j]));
  }
  return keys.map(k => {
    const { mean, se } = meanSe(out.get(k)), ref = PRINCIPLED_F0.readings[k];
    return { key: k, ...parse(k), ours: mean, se, cycles: ref, rel: mean / ref - 1 };
  });
}

/** 镜中的矩形纯光：每个种子「灯在镜里」减「灯绕法线转 90°」的全图均值，对 F·L，只判相对差（mirrorOk）。
 *  不判标准误：改对之后仍有一点没查明的残差，60° 时相对 −1.2e-5（16 个种子、每个 4096 采样时是 3.3 个标准误；30° 时
 *  −4.7e-5）。它与多重重要性采样无关（只留置了 PATH_RAY_MIS_SKIP 的那些路径取矩形纯光，残差不变），底色为 0、只有一个
 *  闭包时没有（相对 4e-6 以内，单精度的菲涅耳在这里的底），有漫反射闭包时才有，随漫反射与高光取样权重之比变大。
 *  要守的错（不置 PATH_RAY_MIS_SKIP）丢 44%，相对差的门（0.2%）够用 */
export async function mirror(bin, { seeds = MIRROR_SEEDS } = {}) {
  const read = ({ px, w, h }) => { let s = 0; for (let i = 0; i < w * h; i++) s += lum(px, i); return s / (w * h); };
  const jobs = [false, true].map(turned => ({ tag: `mirror-rect${turned ? '-turned' : ''}`, turned }));
  for (const j of jobs) Object.assign(j, { spp: ANALYTIC.spp, game: await bundle(j.tag, mirrorScene(j)), read });
  const { readings } = await renderSeeds(bin, seeds, jobs);
  const { mean, se } = meanSe(readings[0].map((a, k) => a - readings[1][k]));
  const exact = fresnelDielectric(Math.cos((MIRROR.alpha * Math.PI) / 180), MIRROR.ior) * MIRROR.L;
  return [{ name: '镜中矩形灯', seeds: seeds.length, spp: ANALYTIC.spp, mean, se, exact, rel: mean / exact - 1, z: (mean - exact) / se, turned: meanSe(readings[1]).mean }];
}

/** 网格的公共边：z = 0 上两个三角形的方形自发光平面（PlaneGeometry(20, 20)，底色 0、高光 0、辐亮度 Le），世界是黑的；相机照
 *  镜中测试的几何（离原点 3、斜 60°、视角 0.02°，看原点周围约 1 mm），对角线（两个三角形的公共边）斜穿画面。被平面盖满的像素
 *  该正好是 Le，少的就是从公共边穿过去的相机射线：数低于 Le·(1 − 1e-6) 的像素。无噪声，读数与种子无关。
 *  视角宽了测不出来（每个像素里打在边上那一窄条的比例太小）。软件求交（THREERT_HWRT=0）与默认的求交（有硬件光追时是硬件）各一遍。
 *  判法（edgeOk）：软件求交与英伟达的硬件求交一个像素都不许少；苹果显卡的硬件求交器本身在公共边上漏（内核条文「与 Cycles、
 *  与上游不一样的地方」第 47 条），只钉上限 EDGE.appleHwrtMax（实测 65 个像素的约 1.5 倍），苹果修好了也不会红 */
export const EDGE = { Le: 1, half: 10, image: 64, spp: 1024, D: 3, tilt: 60, fov: 0.02, appleHwrtMax: 97 };
function edgeScene(p = EDGE) {
  const { Le, half, image, D, tilt, fov } = p, t = (tilt * Math.PI) / 180;
  return `${head}
export default function () {
  const scene = new Scene();
  scene.environment = new SkyColor(0xffffff, ${p.sky ?? 0});
  scene.add(new Mesh(new PlaneGeometry(${2 * half}, ${2 * half}), new MeshPhysicalMaterial({ color: new Color().setRGB(0, 0, 0), metalness: 0, roughness: 1, specularIntensity: 0, emissive: new Color().setRGB(1, 1, 1), emissiveIntensity: ${Le} })));
  ${cam(`${-D * Math.sin(t)}, 0, ${D * Math.cos(t)}`, fov)}
  return { scene, camera: c, options: ${opts(image, {})} };
}`;
}
/** 读数：{ hwrt, short（少的像素数）, worst（最差一个像素少的比例）, mean, rel（全图均值对 Le 的相对差） }。hwrt 为假时强制软件求交；
 *  为真时用默认的求交（显卡没有硬件光追时也是软件求交，这时 hwrt 记成假）。dump 拿到原始图（调试用） */
export async function edge(bin, { hwrt = true, scene = EDGE, dump } = {}) {
  const env = hwrt ? {} : { THREERT_HWRT: '0' };
  const read = ({ px, w, h }) => {
    let s = 0, short = 0, worst = 0;
    for (let i = 0; i < w * h; i++) { const v = lum(px, i); s += v; if (v < scene.Le * (1 - 1e-6)) short++; worst = Math.max(worst, 1 - v / scene.Le); }
    if (dump) dump({ px, w, h });
    return { mean: s / (w * h), short, worst };
  };
  const tag = `edge-${scene.tilt}-${scene.fov}-${scene.half}-${scene.sky ?? 0}`;
  const { readings, adapter } = await renderSeeds(bin, [1], [{ tag, spp: scene.spp, game: await bundle(tag, edgeScene(scene)), read }], env);
  const info = JSON.parse(spawnSync(bin, ['info'], { encoding: 'utf8', env: { ...process.env, ...env } }).stdout);
  const r = readings[0][0];
  return { adapter, backend: info.backend, hwrt: info.hwrt, spp: scene.spp, ...r, rel: r.mean / scene.Le - 1 };
}
export const edgeOk = r => r.short <= (r.hwrt && r.backend === 'Metal' ? EDGE.appleHwrtMax : 0);
// 公共边的负对照：容差 FLT_EPSILON·|U+V+W| 放到门槛的另一侧（公共边上 |U| 不到容差时两个三角形都判不中，不再防水），
// 软件求交下必须有少了的像素（两台机器上漏得不一样多，只判有没有）
export const EDGE_NEGATIVE = { name: '三角形求交：容差放反，公共边不再防水', inject: { file: 'shaders/util.wgsl', from: 'if (!(minUVW >= -eps || maxUVW <= eps)) {', to: 'if (!(minUVW >= eps || maxUVW <= -eps)) {' } };

/** Pharr 的自发光球：全图像素亮度的均值对 Le/(1 − albedo)，判法与矩形面光的解析场景相同（analyticOk） */
export async function pharr(bin, { seeds = ANALYTIC.seeds } = {}) {
  const job = { tag: 'pharr-emissive-sphere', spp: ANALYTIC.spp, game: await bundle('pharr-emissive-sphere', pharrScene()), read: ({ px, w, h }) => { let s = 0; for (let i = 0; i < w * h; i++) s += lum(px, i); return s / (w * h); } };
  const { readings } = await renderSeeds(bin, seeds, [job]);
  const { mean, se } = meanSe(readings[0]), exact = PHARR.Le / (1 - PHARR.albedo);
  return [{ name: 'Pharr 自发光球', seeds: seeds.length, spp: ANALYTIC.spp, mean, se, exact, rel: mean / exact - 1, z: (mean - exact) / se }];
}

export async function analytic(bin, { seeds = ANALYTIC.seeds, geoms = GEOMS } = {}) {
  const { image, region } = RECT, lo = (image - region) / 2;
  const jobs = [];
  for (const g of geoms) {
    const tag = `rect-${g.position.join('_')}${g.plate === undefined ? '' : `-plate${g.plate}`}`;
    jobs.push({
      tag, spp: ANALYTIC.spp, game: await bundle(tag, rectScene(g)),
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

// 负对照：在源码的拷贝上各故意改错一项（build.mjs 的 inject；file 相对 beiming/sources/core/，工作树不动）。
// near 是这项改错该量到的最大相对差：读数要在门外，还要落在 near 的 ±5% 之内（fine 的两项 ±30%）。改错的读数挪了位置，说明接线变了
// （纯金属没采到方向的样本曾经漏进白炉，这一项从 0.557 变成 1.20，照旧在门外，当时没有人发现）。
// fine 的三项改错很小（十万分之二、万分之二、千分之一点五），在 0.2% 之内：它们要的是解析场景的整条判法（analyticOk）判不过，
// 守的是那条底没有把这个量级的错放过去。它们的读数里噪声与数值残差占百分之几到十几，所以容差放到 ±30%
export const negativeTolerance = n => (n.fine ? 0.3 : 0.05);
// 原理化 BSDF 那五项负对照登记的读数（最大相对差），2026-11-25 在苹果显卡上量的。漫反射与自发光两项可以手算：
// Le/(1 − 0.98·0.5) 对 Le/(1 − 0.5) 是 −1.96%；发光多乘 1% 是 +1%
const PRINCIPLED_NEAR = { dielectric_fresnel: -1.38e-2, layering: 5.41e-2, diffuse: -1.97e-2, pick: 1.75e-1, emission: 9.91e-3 };
// 奇异的一瓣与电介质高光的 F0 那三项，2026-11-25 在苹果显卡上量的
const SINGULAR_NEAR = { mis_skip: -0.442, specular_f0: 0.791, specular_exponent: -0.127 };
export const negativeOk = n => (n.fine ? n.rows.some(r => !analyticOk(r)) : Math.abs(n.worstRel) > n.gate) && Math.abs(n.worstRel / n.near - 1) <= negativeTolerance(n);
// 继续弹射的射线起点改回改动之前的沿法线挪开（上游的 offset_origin），给上面说的两项负对照垫底
const ORIGIN_OFFSET = { file: 'path/shaders/integrator.wgsl', from: 'ray.P = surface_ray_P(sd.P, sd.Ng, l, sd.prim, sd.inst);', to: 'ray.P = offset_origin(sd.P, select(sd.Ng, -sd.Ng, dot(l, sd.Ng) < 0.0));' };
const NEGATIVE = [
  {
    target: 'closure', name: '闭包：求值的遮蔽项漏掉出射方向的 lambda（G2 写成 G1）',
    // （电介质高光的求值有同样一行，所以连着下一个函数的名字一起认，只改金属那一处）
    inject: { file: 'shaders/microfacet.wgsl', from: 'reflectance * common_ / (1.0 + lambdaO + lambdaI), common_ / (1.0 + lambdaI));\n}\n\n// kernel/closure/bsdf_microfacet.h:1106-1114: bsdf_microfacet_ggx_eval，求值乘 energy_scale，概率密度不乘\nfn bsdf_microfacet_ggx_eval(N', to: 'reflectance * common_ / (1.0 + lambdaI), common_ / (1.0 + lambdaI));\n}\n\n// kernel/closure/bsdf_microfacet.h:1106-1114: bsdf_microfacet_ggx_eval，求值乘 energy_scale，概率密度不乘\nfn bsdf_microfacet_ggx_eval(N' },
    // near 原来是 0.557：那时材质采样一侧采到方向后再调一遍求值，改错的求值两侧都用上；现在照 Cycles 用采样函数自己算的求值
    // 与概率密度（surface_shader_bsdf_sample_closure），改错的只剩光源一侧的求值，读数挪到 0.241
    run: async bin => (await furnace(bin, { seeds: [1], rows: ['0.30', '0.60', '1.00'].map(roughness => ({ distribution: 'GGX', roughness })) })).rows, gate: GATES.furnaceRel, near: 0.241,
  },
  {
    target: 'area_light', name: '面光：辐射通量到辐亮度的换算多乘 1%',
    inject: { file: 'shaders/area_light.wgsl', from: 'ls.eval_fac = M_1_PI_F * invarea;', to: 'ls.eval_fac = M_1_PI_F * invarea * 1.01;' },
    run: async bin => analytic(bin, { seeds: [1, 2] }), gate: GATES.analyticRel, near: 1.0e-2,
  },
  {
    target: 'mis', name: '接线：材质采样打到矩形纯光时不取光（多重重要性采样只剩光源一侧的权重）',
    inject: { file: 'path/shaders/integrator.wgsl', from: 'if (!LIVE && state.legacy.bm_surf) {', to: 'if (false && state.legacy.bm_surf) {' },
    // near 原来是 −4.87e-3：平面那时是上游顶替的朗伯，材质采样有 5% 分给零高光的那一瓣，材质一侧的权重小一些；改走照 Cycles 的
    // bsdf_diffuse（全部按余弦采样）之后材质一侧的权重变大，关掉它丢的份额跟着变大
    run: async bin => analytic(bin, { seeds: [1, 2] }), gate: GATES.analyticRel, near: -5.25e-3,
  },
  {
    target: 'area_light_fine', name: '面光：辐射通量到辐亮度的换算多乘十万分之二',
    inject: { file: 'shaders/area_light.wgsl', from: 'ls.eval_fac = M_1_PI_F * invarea;', to: 'ls.eval_fac = M_1_PI_F * invarea * 1.00002;' },
    run: async bin => analytic(bin), fine: true, gate: GATES.analyticFloor, near: 2.0e-5,
  },
  // 下面两项改错的地方只在射线起点与着色点不同时起作用。继续弹射的射线照 Cycles 从着色点出发之后，三角形上两者只在自交测试
  // 测不中时才差一个 ray_offset，解析场景量不出；所以两项都先把继续弹射的起点改回沿法线挪开（ORIGIN_OFFSET），再注入改错。
  // 守的仍是那两行（过程几何照旧挪开，那里两个点照旧不同）
  {
    target: 'mis_origin', name: '接线：（起点改回沿法线挪开）材质采样打到矩形纯光时从挪开的射线起点算（两侧的权重配不平）',
    inject: [ORIGIN_OFFSET, { file: 'path/shaders/integrator.wgsl', from: 'bm_rect_hits(state.mis_origin_P, ray.D,', to: 'bm_rect_hits(ray.P, ray.D,' }],
    run: async bin => analytic(bin, { geoms: [NEAR] }), fine: true, gate: GATES.analyticFloor, near: 2.0e-4,
  },
  {
    target: 'mis_occluder', name: '接线：（起点改回沿法线挪开）材质采样打到矩形纯光时遮挡距离直接拿 hit.t 比（灯紧贴背后的面时这一侧整份丢掉）',
    inject: [ORIGIN_OFFSET, { file: 'path/shaders/integrator.wgsl', from: 'select(hit.t + dot(ray.P - state.mis_origin_P, ray.D), INF, hit.tri == 0xffffffffu)', to: 'select(hit.t, INF, hit.tri == 0xffffffffu)' }],
    run: async bin => analytic(bin, { seeds: ANALYTIC.seeds.slice(0, 8), geoms: [PLATE] }), fine: true, gate: GATES.analyticFloor, near: -1.48e-3,
  },
  // 原理化 BSDF 的接线：电介质高光、层间权重、漫反射、多闭包选择、自发光各改错一项
  {
    target: 'dielectric_fresnel', name: '电介质高光：菲涅耳不随角度变（广义 Schlick 的插值系数 s 恒为 0，反射率停在 F0）',
    inject: { file: 'shaders/microfacet.wgsl', from: 'let s = saturate(inverse_lerp(F0_real, 1.0, F_real));', to: 'let s = 0.0;' },
    run: async bin => principledFurnace(bin, { seeds: [1], keys: ['0.00/0.00', '0.00/0.50'] }), gate: GATES.furnaceRel, near: PRINCIPLED_NEAR.dielectric_fresnel,
  },
  {
    target: 'layering', name: '层间权重：电介质高光下面的漫反射不按高光的反照率衰减',
    inject: { file: 'path/shaders/shader.wgsl', from: 'weight = closure_layering_weight(closure_albedo(c, wi), weight);', to: 'weight = weight;' },
    run: async bin => principledFurnace(bin, { seeds: [1], keys: ['0.00/0.20', '0.00/0.80'] }), gate: GATES.furnaceRel, near: PRINCIPLED_NEAR.layering,
  },
  {
    target: 'diffuse', name: '漫反射：采样一侧的求值少乘 2%（概率密度不变）',
    inject: { file: 'shaders/microfacet.wgsl', from: 'return MicrofacetSample(LABEL_REFLECT | LABEL_DIFFUSE, vec3f(s.pdf), s.wo, s.pdf);', to: 'return MicrofacetSample(LABEL_REFLECT | LABEL_DIFFUSE, vec3f(s.pdf * 0.98), s.wo, s.pdf);' },
    run: async bin => pharr(bin, { seeds: [1, 2] }), gate: GATES.analyticRel, near: PRINCIPLED_NEAR.diffuse,
  },
  {
    target: 'pick', name: '多闭包选择：选闭包的随机数只用到一半（后面的闭包很少被选到，与合起来的概率密度配不上）',
    inject: { file: 'path/shaders/closure.wgsl', from: 'let rr = rand.z * sum;', to: 'let rr = rand.z * sum * 0.5;' },
    run: async bin => principledFurnace(bin, { seeds: [1], keys: ['0.50/0.20', '0.50/0.80'] }), gate: GATES.furnaceRel, near: PRINCIPLED_NEAR.pick,
  },
  {
    target: 'emission', name: '自发光：发光值多乘 1%',
    inject: { file: 'path/shaders/closure.wgsl', from: 'return emissive_simple_eval(sd.Ng, sd.wi) * sd.emission;', to: 'return emissive_simple_eval(sd.Ng, sd.wi) * sd.emission * 1.01;' },
    run: async bin => pharr(bin, { seeds: [1, 2] }), gate: GATES.analyticRel, near: PRINCIPLED_NEAR.emission,
  },
  // 奇异的一瓣不置 PATH_RAY_MIS_SKIP（镜里的灯按 power_heuristic 加权）；电介质高光的 F0 一致地加倍、菲涅耳的 exponent 写错：
  // 后两项前后一致地错，底色 1 的白炉里被下层漫反射补平（相对差在 1e-3 以下），要底色 0 的白炉才抓得到
  {
    target: 'mis_skip', name: '奇异的一瓣：不置 PATH_RAY_MIS_SKIP（下一次打到灯仍按多重重要性采样加权）',
    inject: { file: 'path/shaders/integrator.wgsl', from: 'state.flag |= PATH_RAY_MIS_SKIP;\n            } else {', to: 'state.flag &= ~PATH_RAY_MIS_SKIP;\n            } else {' },
    run: async bin => mirror(bin, { seeds: [1, 2] }), gate: GATES.analyticRel, near: SINGULAR_NEAR.mis_skip,
  },
  {
    target: 'specular_f0', name: '电介质高光：F0 前后一致地加倍（高光染色乘在两倍的 F0 上）',
    inject: { file: 'path/shaders/shader.wgsl', from: 'fe.x * inputs.specular_tint', to: '2.0 * fe.x * inputs.specular_tint' },
    run: async bin => principledF0Furnace(bin, { seeds: [1], keys: ['1.50/0.50/1,1,1/0.30', '1.50/0.80/1,1,1/0.30'] }), gate: GATES.furnaceRel, near: SINGULAR_NEAR.specular_f0,
  },
  {
    target: 'specular_exponent', name: '电介质高光：菲涅耳走错一支（exponent 取 5，Schlick 近似，不是 −eta）',
    inject: { file: 'path/shaders/shader.wgsl', from: 'c.exponent = -fe.y;', to: 'c.exponent = 5.0;' },
    run: async bin => principledF0Furnace(bin, { seeds: [1], keys: ['1.50/0.50/1,1,1/0.30', '1.33/0.50/1,1,1/0.30'] }), gate: GATES.furnaceRel, near: SINGULAR_NEAR.specular_exponent,
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
    rule: recorded === null ? `这块显卡与后端没记过，按相对 ${DIFFUSE.tolerance} 比` : mean === recorded ? '逐位相等' : `与记录不再逐位相等；在相对 ${DIFFUSE.tolerance} 之内算过，过不过都请重新登记这块显卡的数`,
  };

  say('金属白炉');
  const main = await furnace(ours.bin);
  const near = await furnace(ours.bin, { D: FURNACE.D[1], seeds: [1] });
  const camera = { D: FURNACE.D, fovNote: '过球心平面上的半高 1.25（正交 ortho_scale 2.5 的一半）', maxRelChange: Math.max(...main.rows.map((r, k) => Math.abs(near.rows[k].ours / r.ours - 1))) };

  say('电介质与混合白炉');
  const principled = await principledFurnace(ours.bin);

  say('对 F0 敏感的电介质白炉（底色 0）');
  const principledF0 = await principledF0Furnace(ours.bin);

  say('镜中的矩形纯光');
  const mirrorRows = await mirror(ours.bin);

  say('网格的公共边');
  const edgeRows = [await edge(ours.bin, { hwrt: true }), await edge(ours.bin, { hwrt: false })];
  const edgeNegative = { name: EDGE_NEGATIVE.name, inject: EDGE_NEGATIVE.inject, ...(await edge(buildRenderer({ inject: [EDGE_NEGATIVE.inject] }).bin, { hwrt: false })) };

  say('Pharr 自发光球');
  const emissive = await pharr(ours.bin);

  say('矩形面光照漫反射平面');
  const ana = await analytic(ours.bin, { geoms: [...GEOMS, NEAR, PLATE] });

  say('负对照');
  const negative = [];
  for (const n of NEGATIVE) {
    const b = buildRenderer({ inject: [n.inject].flat() });
    const rows = await n.run(b.bin);
    negative.push({ target: n.target, name: n.name, inject: n.inject, gate: n.gate, near: n.near, fine: n.fine === true, rows, worstRel: rows.reduce((w, r) => (Math.abs(r.rel) > Math.abs(w) ? r.rel : w), 0) });
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
    解析场景: ana.every(analyticOk),
    电介质白炉: principled.every(r => Math.abs(r.rel) <= GATES.furnaceRel && r.se / r.cycles < GATES.furnaceRel / 10),
    F0白炉: principledF0.every(r => Math.abs(r.rel) <= GATES.furnaceRel && r.se / r.cycles < GATES.furnaceRel / 10),
    奇异镜面: mirrorRows.every(mirrorOk),
    公共边: edgeRows.every(edgeOk) && edgeNegative.short > 0,
    自发光: emissive.every(analyticOk),
    负对照: negative.every(negativeOk),
    确定性: det.identical,
  };
  say('完成');
  return {
    ok: Object.values(checks).every(Boolean), checks, gates: GATES, platform: `${process.platform}-${process.arch}`, adapter: main.adapter, seconds: (Date.now() - t0) / 1000,
    core: { source: 'beiming/sources/core/path', bin: path.basename(ours.bin), key: ours.key, shaders: ours.shaders }, upstream: { commit: COMMIT, use: '场景库、场景打包工具、自带的测试脚本、素材根目录' },
    diffuseFurnace,
    furnace: { spp: FURNACE.spp, seeds: FURNACE.seeds, D: FURNACE.D[0], image: CYCLES.image, rows: main.rows, camera, nearRows: near.rows },
    principled: { spp: FURNACE.spp, seeds: FURNACE.seeds, D: FURNACE.D[0], source: PRINCIPLED.source, rows: principled },
    principledF0: { spp: FURNACE.spp, seeds: FURNACE.seeds, D: FURNACE.D[0], source: PRINCIPLED_F0.source, rows: principledF0 },
    mirror: mirrorRows, mirrorSetup: MIRROR, edge: edgeRows, edgeSetup: EDGE, edgeNegative,
    emissive, emissiveSetup: PHARR,
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
    for (const r of report.principled.rows) ctx.out(`${Math.abs(r.rel) <= GATES.furnaceRel ? '✓' : '✗'} 白炉 原理化 金属度 ${r.metalness} 粗糙度 ${r.roughness}  我方 ${r.ours.toFixed(6)} ± ${r.se.toExponential(1)}  Cycles ${r.cycles.toFixed(6)}  相对差 ${r.rel.toExponential(2)}`);
    for (const r of report.principledF0.rows) ctx.out(`${Math.abs(r.rel) <= GATES.furnaceRel ? '✓' : '✗'} 白炉 原理化 底色 0 ${r.key}  我方 ${r.ours.toFixed(6)} ± ${r.se.toExponential(1)}  Cycles ${r.cycles.toFixed(6)}  相对差 ${r.rel.toExponential(2)}`);
    for (const a of report.mirror) ctx.out(`${mirrorOk(a) ? '✓' : '✗'} ${a.name}  我方 ${a.mean.toPrecision(7)} ± ${a.se.toExponential(1)}  解析 ${a.exact.toPrecision(7)}  相对差 ${a.rel.toExponential(2)}  ${a.z.toFixed(2)} 个标准误（只记录）`);
    for (const r of report.edge) ctx.out(`${edgeOk(r) ? '✓' : '✗'} 网格的公共边（${r.hwrt ? '硬件求交' : '软件求交'}）  少了的像素 ${r.short}（${r.hwrt && r.backend === 'Metal' ? `苹果显卡的硬件求交器漏，上限 ${EDGE.appleHwrtMax}` : '不许有'}）  最差一个像素少 ${(r.worst * 100).toFixed(2)}%  全图均值相对差 ${r.rel.toExponential(2)}`);
    ctx.out(`${report.edgeNegative.short > 0 ? '✓' : '✗'} 负对照 ${report.edgeNegative.name}：软件求交少了 ${report.edgeNegative.short} 个像素（必须有）`);
    for (const a of report.emissive) ctx.out(`${analyticOk(a) ? '✓' : '✗'} ${a.name}  我方 ${a.mean.toPrecision(7)} ± ${a.se.toExponential(1)}  解析 ${a.exact.toPrecision(7)}  相对差 ${a.rel.toExponential(2)}  ${a.z.toFixed(2)} 个标准误`);
    for (const a of report.analytic) ctx.out(`${analyticOk(a) ? '✓' : '✗'} 面光 ${a.name}  我方 ${a.mean.toPrecision(7)} ± ${a.se.toExponential(1)}  解析 ${a.exact.toPrecision(7)}  相对差 ${a.rel.toExponential(2)}  ${a.z.toFixed(2)} 个标准误`);
    for (const a of report.analytic.filter(passedByFloor)) ctx.out(`提示 面光 ${a.name} 超过了 ${GATES.analyticSE} 个标准误，是按数值精度的底（相对 ${GATES.analyticFloor}）过的`);
    for (const n of report.negative) ctx.out(`${negativeOk(n) ? '✓' : '✗'} 负对照 ${n.name}：最大相对差 ${n.worstRel.toExponential(2)}（该在 ${n.near.toExponential(2)} 的 ±${negativeTolerance(n) * 100}% 之内${n.fine ? '，且解析场景的判法判它不过' : ''}）`);
    ctx.out(`各项：${Object.entries(report.checks).map(([k, v]) => `${k} ${v ? '过' : '不过'}`).join('，')}；报告：${file}`);
    const bad = Object.keys(report.checks).filter(k => !report.checks[k]);
    return { data: report, outputs: [{ path: file, kind: 'report' }], ...(bad.length && { error: { code: 'contract.chassis-level2', message: `不过：${bad.join('、')}`, hint: `明细见 ${file}` } }) };
  },
});

if (isMain(import.meta.url)) await runCli(command);
