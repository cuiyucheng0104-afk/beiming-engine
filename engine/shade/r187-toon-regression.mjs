// 北冥引擎 · 卡通着色回归对拍执行器：three r187 对 r170 金标准，在无头 Chrome WebGL2 上实渲、读回像素、算 PSNR 过门。
// 两张互相独立的页面（各自的 import map 把 three 指到 r170 / r187）渲同一套标定场景（r187-toon-regression.scene.mjs），
// 彩色与法线 / ID 通道各比整帧与四个子区；负对照（大幅扰动）与逐特性消融（只关一项特性）都在 r187 上改坏后再对 r170 金标准，
// 前者必须明显跌破门限、后者必须过不了门，证明这道门分得出差别、每项特性都在画面里。
// 静态服务与浏览器启动用渲染器的同一套（engine/render/lib：BEIMING_CHROME / BEIMING_ANGLE 照常生效）。
//
// 另有三道不靠「两版互比」的核对：两页实报的 three 版本必须是 170 / 187；拼图里的四个法线 / ID 子区各对一张单独渲的参照并含预期的物体 / 实例 ID；
// r170 这边再对一份冻结的金标准（r187-toon-regression.golden.mjs：改动前的着色器摘要与缩略图），两版一起漂移时靠它报出来。
//
//   node engine/shade/r187-toon-regression.mjs [--write] [--json] [--frames <目录>] [--freeze <基线提交>]
//       --write 把结果写进 docs/quality/r187-toon-regression.{json,md}；
//       退出码 0 过门、1 没过、2 参数写错、3 环境不对（没有浏览器、没装 r187，或两页的 three 不是 170 / 187：env.three-revision-mismatch）
//       --freeze <基线提交> 用这次的 r170 结果重写冻结的金标准 r187-toon-regression.golden.json（只在有意改画面并按 POLICY 审批之后；不做对拍判定）
//       --frames <目录> 把读回的像素存成裸 RGBA8（自下而上；base 是整帧 640×480，变体与 idref 是一个子区 320×240），排查差异时看图：
//           ffmpeg -f rawvideo -pix_fmt rgba -s 640x480 -i golden-base-color.rgba -vf vflip -frames:v 1 golden.png
//   过门 = PSNR ≥ 45 dB 且差 > 1 级的像素 ≤ 0.1%（只看 PSNR 时，占画面很小的特性整项坏掉也过得去）；按未舍入的读数判，
//       报告里的读数向不利的一边取整（PSNR 向下取两位、占比向上取六位），不会出现「写着 45 却没过」
//   runR187ToonRegression({ builds }) → { skipped } | { error, revisions, overallPass: false }
//       | { revisions, platform, gate, cases, layoutChecks, goldenAnchor, negativeControls, ablations, consoleWarnings, unknownRevisionWarnings, overallPass, frames }
//       builds：覆盖页面里 three 的构建路径（测试用：把 187 指到 r170 的构建，验证错版报 error）
//       layoutChecks：两版各四条，拼图里的法线 / ID 子区对独立参照（过门且最大差 ≤ 1 级）+ 预期的物体 / 实例 ID（idsExpected / idsMissing）
//       goldenAnchor：r170 对冻结金标准（checkGolden 的返回值）
//       frames：读回的原始像素（Buffer，不进报告）
//       consoleWarnings：r170 / r187 两页的控制台告警与报错（应为空）；unknownRevisionWarnings：把版本号改成 999 的那一页收到的告警（应有版本告警）
//       skipped 以环境码开头（SKIP_CODES：env.playwright-missing / env.browser-launch / env.three-r187-missing），调用方据此显式跳过
//   compareFrames(a, b, { width, region, channels }) → { psnrDb, exactMatch, maxAbsDiff, fracGt1, fracGt5, pass }
//       PSNR 按区域内全部像素、channels 个通道合并算；逐字节相同记 99 并带 exactMatch: true（有差时最高记 98.99，不与它混）；frac* 是任一通道差 > 1 / > 5 级的像素占比；
//       读数都不舍入，pass 就是用它们判的门
import fs from 'node:fs';
import process from 'node:process';   // eslint 把 engine/ 下的 .mjs 当浏览器端，Node 全局显式导入
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isMain } from '../../tools/lib/cli.mjs';
import { createServer } from '../render/lib/server.mjs';
import { launchBrowser, defaultAngle } from '../render/lib/gpu.mjs';
import { QW, QH, REGIONS, VARIANTS } from './r187-toon-regression.scene.mjs';
import { checkGolden, freezeGolden } from './r187-toon-regression.golden.mjs';

export const TOON_PSNR_GATE_DB = 45;       // 过门：r187 对 r170 每一项 PSNR ≥ 45 dB……
export const TOON_MAX_FRAC_GT1 = 0.001;    // ……且任一通道差 > 1 级的像素不超过 0.1%
export const NEGATIVE_MAX_PSNR_DB = 35;    // 负对照：必须 < 35 dB
export const SKIP_CODES = ['env.playwright-missing', 'env.browser-launch', 'env.three-r187-missing'];

// 软件渲染（SwiftShader）下 Chrome 对本执行器自己的 readPixels 报的驱动性能提示，与 three / engine 无关，不算告警；别的告警与报错一条不放
const READBACK_STALL = /GL Driver Message \(OpenGL, Performance, [^)]*\): GPU stall due to ReadPixels/;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUILDS = { 170: '/node_modules/three/build/three.module.js', 187: '/node_modules/three-webgpu/build/three.module.js', 999: '/__s5__/three-r999.js' };
// 没对拍过的版本：r187 的构建，只把版本号改成 999（自己的导出盖过 export *），用来实测 engine/shade 的版本告警还在
const SHIM_999 = `export * from '${'/node_modules/three-webgpu/build/three.module.js'}';\nexport const REVISION = '999';\n`;
const pageHtml = (build, names) => `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"${build}"}}</script>
<script>
window.addEventListener('error', e => { window.RESULT ??= { error: String(e.message || e) }; });
window.addEventListener('unhandledrejection', e => { window.RESULT ??= { error: String(e.reason && e.reason.stack || e.reason) }; });
</script>
</head><body style="margin:0;background:#000"><script type="module">
${names.length ? `import { renderSuite } from '/engine/shade/r187-toon-regression.scene.mjs';
window.RESULT = renderSuite(${JSON.stringify(names)});` : `import * as THREE from 'three';
import '/engine/shade/patch.js';
window.RESULT = { revision: THREE.REVISION, frames: {} };`}
</script></body></html>`;

export function compareFrames(a, b, { width, region, channels = 3 }) {
  let se = 0, max = 0, gt1 = 0, gt5 = 0;
  for (let y = region.y; y < region.y + region.h; y++) for (let x = region.x; x < region.x + region.w; x++) {
    let worst = 0;
    for (let c = 0, i = (y * width + x) * 4; c < channels; c++) { const d = Math.abs(a[i + c] - b[i + c]); se += d * d; if (d > worst) worst = d; }
    if (worst > max) max = worst; if (worst > 1) gt1++; if (worst > 5) gt5++;
  }
  const n = region.w * region.h, psnrDb = se === 0 ? 99 : Math.min(98.99, 10 * Math.log10(255 * 255 * n * channels / se));
  return { psnrDb, exactMatch: se === 0, maxAbsDiff: max, fracGt1: gt1 / n, fracGt5: gt5 / n, pass: psnrDb >= TOON_PSNR_GATE_DB && gt1 / n <= TOON_MAX_FRAC_GT1 };
}
// 进报告的读数：向不利的一边取整（判门在 compareFrames 里用未舍入的值做完了）
const up6 = v => Math.ceil(v * 1e6) / 1e6, shown = m => ({ ...m, psnrDb: Math.floor(m.psnrDb * 100) / 100, fracGt1: up6(m.fracGt1), fracGt5: up6(m.fracGt5) });
const revisionError = r => r.golden === '170' && r.candidate === '187' ? null
  : `env.three-revision-mismatch：金标准页的 three 实报 r${r.golden}（要 r170）、待测页实报 r${r.candidate}（要 r187）。node_modules/three 应当是 three@0.170.0、node_modules/three-webgpu 应当是 three@0.187.0：npm install --include=optional --ignore-scripts 重装`;
// 法线 / ID 通道 alpha 里的物体 / 实例 ID（toon.js 的 passGlsl 同一条公式）
const idByte = (id, inst) => Math.round(255 * ((id * 0.7548776662 + inst * 0.5698402910 + 0.137) % 1));

async function shoot(browser, base, rev, names, warnings) {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
  page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !READBACK_STALL.test(m.text())) warnings.push(`r${rev}: ${m.text().slice(0, 240)}`); });
  try {
    await page.goto(`${base}__s5__/${rev}?v=${names.join(',')}`, { waitUntil: 'commit' });
    await page.waitForFunction(() => window.RESULT !== undefined, null, { timeout: 300000 });   // 软件渲染（CI 的 SwiftShader）下编译着色器慢
    const r = await page.evaluate(() => window.RESULT);
    if (r.error) throw new Error(`r${rev} 页面出错：${r.error}`);
    for (const f of Object.values(r.frames)) for (const k of Object.keys(f)) f[k] = Buffer.from(f[k], 'base64');
    return r;
  } finally { await page.close(); }
}

export async function runR187ToonRegression({ builds } = {}) {
  const B = { ...BUILDS, ...builds };
  if (!fs.existsSync(path.join(ROOT, B[187]))) return { skipped: 'env.three-r187-missing：没装可选依赖 three-webgpu（= three@0.187.0），先 npm install --include=optional --ignore-scripts' };
  let browser;
  try { browser = await launchBrowser(); } catch (e) { if (SKIP_CODES.includes(e.code)) return { skipped: `${e.code}：${e.message}` }; throw e; }
  const variantNames = Object.keys(VARIANTS).filter(n => n !== 'base');
  const server = createServer({ root: ROOT, middleware: (req, res, { done }) => {
    if (req.url === B[999]) { done(200, { 'Content-Type': 'text/javascript; charset=utf-8' }, SHIM_999); return true; }
    const m = /^\/__s5__\/(170|187|999)\?v=([\w,-]*)$/.exec(req.url);
    if (m) done(200, { 'Content-Type': 'text/html; charset=utf-8' }, pageHtml(B[m[1]], m[2].split(',').filter(Boolean)));
    return !!m;
  } });
  const warnings = [], unknown = [];
  try {
    const { url } = await server.listen(0);
    const chrome = browser.version();
    // 先核两页实报的版本（只加载、不渲染），错版直接报出来：170 对 170 的自比不是双版本回归
    const probed = { golden: (await shoot(browser, url, 170, [], warnings)).revision, candidate: (await shoot(browser, url, 187, [], warnings)).revision };
    if (revisionError(probed)) return { error: revisionError(probed), revisions: probed, overallPass: false };
    const golden = await shoot(browser, url, 170, ['base'], warnings);
    const cand = await shoot(browser, url, 187, ['base', ...variantNames], warnings);
    await shoot(browser, url, 999, [], unknown);
    const W = QW * 2, full = { x: 0, y: 0, w: W, h: QH * 2 }, sub = { x: 0, y: 0, w: QW, h: QH }, G = golden.frames.base, K = cand.frames.base;
    const regionOf = id => { const r = REGIONS.find(q => q.id === id); return { x: r.x, y: r.y, w: QW, h: QH }; };
    const crop = (buf, r) => { const out = Buffer.alloc(QW * QH * 4); for (let y = 0; y < QH; y++) buf.copy(out, y * QW * 4, ((r.y + y) * W + r.x) * 4, ((r.y + y) * W + r.x + QW) * 4); return out; };
    const gate = (id, what, m) => ({ id, what, ...shown(m) });
    const cases = [
      gate('frame', '彩色整帧（2 × 2 子区）', compareFrames(G.color, K.color, { width: W, region: full })),
      ...REGIONS.map(r => gate(r.id, '彩色子区', compareFrames(G.color, K.color, { width: W, region: regionOf(r.id) }))),
      gate('id-frame', '法线 + 物体 / 实例 ID 通道整帧（uToonPass = 1，RGBA 四通道）', compareFrames(G.id, K.id, { width: W, region: full, channels: 4 })),
      ...REGIONS.map(r => gate('id:' + r.id, '法线 / ID 通道子区', compareFrames(G.id, K.id, { width: W, region: regionOf(r.id), channels: 4 }))),
    ];
    // 变体只读回它所属的子区：与金标准同一子区（彩色或法线 / ID 通道）比
    const versus = n => { const v = VARIANTS[n], id = v.pass === 'id'; const m = compareFrames(crop(id ? G.id : G.color, regionOf(v.region)), cand.frames[n].crop, { width: QW, region: sub, channels: id ? 4 : 3 }); return { id: n, what: v.what, region: v.region, ...shown(m), caught: v.kind === 'negative' ? m.psnrDb < NEGATIVE_MAX_PSNR_DB : !m.pass }; };
    const of = kind => variantNames.filter(n => VARIANTS[n].kind === kind).map(versus);
    const negativeControls = of('negative'), ablations = of('ablation');
    cases.push(...of('identity').map(({ region, caught, ...m }) => m));
    // 拼图布局：每个法线 / ID 子区对一张单独渲的参照，并且通道里确实有这个场景的物体 / 实例 ID（各占 16 个像素以上；差 1 级算同一个）。
    // 参照不要求逐字节：SwiftShader 上全等，macOS Metal 上实例化那个子区实测有 2 个字节（法线的 z 分量）差 1 级，所以是过门且最大差 ≤ 1 级
    const layoutChecks = [['r170', golden], ['r187', cand]].flatMap(([tag, side]) => REGIONS.map(r => {
      const tile = crop(side.frames.base.id, r), m = compareFrames(tile, side.frames.idref[r.id], { width: QW, region: sub, channels: 4 });
      const area = new Map(); for (let i = 3; i < tile.length; i += 4) area.set(tile[i], (area.get(tile[i]) ?? 0) + 1);
      const want = r.ids.flatMap(([id, n]) => Array.from({ length: n }, (_, i) => idByte(id, i)));
      const idsMissing = want.filter(b => ![b - 1, b, b + 1].some(v => area.get(v) >= 16));
      return { id: `${tag}:${r.id}`, what: '拼图里的法线 / ID 子区对单独渲的参照', ...shown(m), idsExpected: want.length, idsMissing, pass: m.pass && m.maxAbsDiff <= 1 && idsMissing.length === 0 };
    }));
    const goldenAnchor = checkGolden(G.color, W);
    const revisions = { golden: golden.revision, candidate: cand.revision };
    return {
      revisions,
      platform: { os: process.platform, arch: process.arch, node: process.version, chrome, angle: defaultAngle(), webglRenderer: cand.gpu, webglRendererGolden: golden.gpu },
      gate: { minPsnrDb: TOON_PSNR_GATE_DB, maxFracGt1: TOON_MAX_FRAC_GT1, negativeMaxPsnrDb: NEGATIVE_MAX_PSNR_DB, frame: { width: W, height: QH * 2 }, region: { width: QW, height: QH } },
      cases, layoutChecks, goldenAnchor, negativeControls, ablations, consoleWarnings: warnings, unknownRevisionWarnings: unknown,
      overallPass: !revisionError(revisions) && warnings.length === 0 && unknown.some(w => w.includes('当前 r999')) && [...cases, ...layoutChecks].every(c => c.pass) && goldenAnchor.pass && [...negativeControls, ...ablations].every(n => n.caught),
      frames: { golden: golden.frames, candidate: cand.frames },   // 原始像素（不进报告），调试时存图用
    };
  } finally { await browser.close(); await server.close(); }
}

// 逐行比对 three@0.170.0 与 three@0.187.0 的 MeshToonMaterial / MeshDepthMaterial / 平行光阴影着色器后的结论（读数是本执行器实测）
const NOTES = [
  '投影采样核（唯一会改变画面的差异）：r187 删掉了 PCFSoftShadowMap，PCFShadowMap 改成深度纹理 + 硬件比较采样（sampler2DShadow）+ 按屏幕像素旋转的 5 点 Vogel 圆盘，投影边缘带屏幕空间抖动。`quantizeShadow` 在 r187 下把这段换回 r170 PCFSoftShadowMap 的确定性 3 × 3 双线性核（取样点落在纹素中心，硬件比较在那里等于单个纹素的 step）。不换核时过不了门：开发时临时关掉换核、在 macOS Metal 上量过一次，投影所在的两个子区只有 36 到 39 dB（一次性实验的读数，本执行器不复现它；要复现就把 `quantizeShadow` 里换核那一支临时关掉再跑）。',
  '软阴影类型：r187 下把 `renderer.shadowMap.type` 设成 PCFSoftShadowMap 会被 three 退回 PCFShadowMap 并告警；标定场景在 r187 下直接设 PCFShadowMap，两版都没有告警。`engine/stage/film.js` 的 `createFilm` 默认值仍写死 PCFSoftShadowMap（不在本次改动范围），整条出片链切到 r187 时要跟着改成 PCFShadowMap。',
  '版本告警：`engine/shade` 以前只认 r170，在 r187 下每次加载都告警；现在 r170 / r187 都不告警，别的版本照旧告警（对拍时另开一页把 r187 的版本号改成 999 实测，告警在）；着色器锚点缺失时两版都直接抛错。',
  '不影响卡通着色的差异：meshtoon 片元去掉了 `#include <packing>`（卡通栈不用其中的函数）；`lights_fragment_begin` / `lights_fragment_end` 多了 SunLight、光照探针网格、Lambert / Phong 的 IBL，MeshToonMaterial 都不走（卡通合成只取第一盏平行光的方向与投影，颜色全按参数给定，没有光照衰减参与）；`color_fragment` 把顶点色与带 alpha 的顶点色合成一支，实例色结果相同；`common` 把 `inverseTransformDirection` 改名并留了同义宏；深度材质多了反向深度分支，默认不开。',
  '阴影深度：r170 把深度打包进 RGBA8 颜色纹理，r187 直接用深度纹理；带顶点形变的 `makeDepthMaterial` 两版都照常生效（r187 只用它的顶点形变，片元输出不再被读）。',
  '没有覆盖的：r170 的 PCFShadowMap（17 点核）在 r187 下没有等价物，r187 的 PCF 一律按上面的软阴影核出；VSMShadowMap、点光源与聚光灯投影、translucent / noId 材质、three 自带的非卡通材质不在这套对拍里；paintLayer 的海绵点 rustDapple 与 muralLayer 的细碎点 dotAmt 在标定机位下被按屏幕频率淡出，画面里没有，这两个子项没有比到。',
];
const row = c => `| \`${c.id}\` | ${c.what} | ${c.exactMatch ? '逐字节相同' : c.psnrDb + ' dB'} | ${c.maxAbsDiff} | ${(c.fracGt1 * 100).toFixed(3)}% | ${(c.fracGt5 * 100).toFixed(3)}% |`;
export function reportMarkdown(r) {
  const p = r.platform;
  return `# r187 卡通着色回归：对 r170 金标准

本页由 \`node engine/shade/r187-toon-regression.mjs --write\` 生成，数据在同名的 \`.json\` 里；不要手改，重跑即可。

结论：**${r.overallPass ? '过门' : '没过门'}**。\`engine/shade\`（patch.js / toon.js / surface.js）在 three r${r.revisions.candidate} 下实渲的画面，逐项对 r${r.revisions.golden} 金标准 PSNR ≥ ${r.gate.minPsnrDb} dB 且差 > 1 级的像素 ≤ ${r.gate.maxFracGt1 * 100}%（${r.cases.filter(c => c.pass).length} / ${r.cases.length} 项过门，其中 ${r.cases.filter(c => c.exactMatch).length} 项逐字节相同）；负对照 ${r.negativeControls.filter(c => c.caught).length} / ${r.negativeControls.length} 组跌破 ${r.gate.negativeMaxPsnrDb} dB；逐特性消融 ${r.ablations.filter(c => c.caught).length} / ${r.ablations.length} 组被门拦住；拼图布局核对 ${r.layoutChecks.filter(c => c.pass).length} / ${r.layoutChecks.length} 条对上；r170 对冻结的金标准（基线 \`${r.goldenAnchor.baseline}\`）${r.goldenAnchor.pass ? '没变' : '**变了**'}；两版页面控制台告警 ${r.consoleWarnings.length} 条。

- 实际运行平台：${p.os}-${p.arch}，Node ${p.node}，无头 Chrome ${p.chrome}，ANGLE 后端 ${p.angle}
- WebGL 渲染器：${p.webglRenderer}
- 这份读数只代表上面这台机器；别的显卡或软件渲染要在那台机器上重跑

## 怎么比的

两张互相独立的测试页，各自的 import map 把 \`three\` 指到 r170（\`three\`）或 r187（\`three-webgpu\` 别名包），渲同一套确定性标定场景（\`engine/shade/r187-toon-regression.scene.mjs\`），渲染器设置与 \`createFilm\` 相同（sRGB 输出、不做色调映射、不开抗锯齿、软阴影）。整帧 ${r.gate.frame.width} × ${r.gate.frame.height}，分成 2 × 2 个 ${r.gate.region.width} × ${r.gate.region.height} 子区；彩色只比 RGB，法线 / ID 通道（旧的 uToonPass = 1：视空间法线 + 物体 / 实例 ID）同样的 2 × 2 布局、比 RGBA。PSNR 按区域内全部像素（含背景）合并计算；只看 PSNR 时，占画面很小的特性整项坏掉也过得去，所以过门还要求差 > 1 级的像素不超过 ${r.gate.maxFracGt1 * 100}%。

| 子区 | 覆盖的特性 |
|---|---|
| \`bands-rim-fill-sky\` | 三档分档、羽化、明暗交界线噪声 edgeNoise、双色亮芯撕边边缘光（rimCore / rimBreak）、两档下方补光、天空冷光 |
| \`shadow-deform\` | 平行光量化投影、顶点形变钩子 vertexBegin、makeDepthMaterial 阴影对齐 |
| \`surface-layers\` | patchLayer（color / tint 两种锈斑）、paintLayer、muralLayer 三种表面风化层；没有灯时的主光方向 uKeyDirW |
| \`instanced-tints\` | InstancedMesh 每个实例独立的三档色调、实例化投影 |

## r187 对 r170

| 项 | 内容 | PSNR | 最大单通道差 | 差 > 1 级的像素 | 差 > 5 级的像素 |
|---|---|---|---|---|---|
${r.cases.map(row).join('\n')}

## 拼图布局核对（各版自己比自己）

上表两边用的是同一套拼图画法，画错了位置会一起错。这里每个场景再单独渲一张 ${r.gate.region.width} × ${r.gate.region.height} 的法线 / ID 参照（自己的渲染目标，不设子区视口），拼图里对应的子区对它要过门且最大差不超过 1 级（SwiftShader 上逐字节相同；macOS Metal 上实例化那个子区实测有 2 个字节差 1 级，在法线的 z 分量上），并且通道里要有这个场景全部的物体 / 实例 ID。彩色拼图直接画在画布上，没有单独的参照；彩色子区画错了位置时，下一节按子区冻结的缩略图会变。

| 项 | 内容 | PSNR | 最大单通道差 | 差 > 1 级的像素 | 差 > 5 级的像素 | 预期的 ID | 没找到的 ID |
|---|---|---|---|---|---|---|---|
${r.layoutChecks.map(c => `${row(c)} ${c.idsExpected} 个 | ${c.idsMissing.length ? c.idsMissing.join('、') : '无'} |`).join('\n')}

## r170 对冻结的金标准

上面两节的 r170 与 r187 跑的是同一份 \`engine/shade\`，两版一起改坏时互比照样全等。所以 r170 这边另外对一份冻结的金标准（\`engine/shade/r187-toon-regression.golden.json\`，基线 \`${r.goldenAnchor.baseline}\`，缩略图冻结于 ${r.goldenAnchor.backend}），它不随待测代码重生：

- 着色器摘要：4 族材质 × 4 组参数，各取卡通 / 阴影深度材质在 r170 下 \`onBeforeCompile\` 之后的顶点与片元源码（共 ${r.goldenAnchor.shaders} 段）与 uniform 初值的 SHA-256，逐字节比。${r.goldenAnchor.shadersChanged.length ? `**变了 ${r.goldenAnchor.shadersChanged.length} 项**：${r.goldenAnchor.shadersChanged.join('；')}` : '没有变化'}。
- 缩略图：r170 彩色帧每个子区的 16 × 12 块均值（每块 20 × 20 像素），块均值差最大不超过 ${r.goldenAnchor.gate.maxBlockDiff} 级、平均不超过 ${r.goldenAnchor.gate.meanBlockDiff} 级。容差是给不同显卡 / 软件渲染在投影与物体边缘上的出入留的（macOS Metal 对 SwiftShader 实测最大 6 级、平均不到 0.08 级）；分档阈值整体挪 0.08 时最大 8 到 48 级、平均 0.26 到 1.5 级。

| 子区 | 最大块均值差 | 平均块均值差 | 判定 |
|---|---|---|---|
${r.goldenAnchor.regions.map(t => `| \`${t.id}\` | ${t.maxBlockDiff} 级 | ${t.meanBlockDiff} 级 | ${t.pass ? '没变' : '**变了**'} |`).join('\n')}

有意改画面时才重冻（\`--freeze <基线提交>\`），先按 \`docs/style-baselines/POLICY.md\` 审批；不是有意改的，这里变红就是回退。

## 负对照（在 r187 上故意改坏，再对 r170 金标准）

每一条只在它所属的子区里算，必须 < ${r.gate.negativeMaxPsnrDb} dB 才算被拦住。

| 项 | 改了什么 | PSNR | 最大单通道差 | 差 > 1 级的像素 | 差 > 5 级的像素 |
|---|---|---|---|---|---|
${r.negativeControls.map(row).join('\n')}

## 逐特性消融（在 r187 上只关掉一项特性，再对 r170 金标准）

每一条只在它所属的子区里算（法线 / ID 通道的两条比那个通道），必须过不了门：说明这项特性确实在标定画面里，坏了门看得见。

| 项 | 关掉了什么 | PSNR | 最大单通道差 | 差 > 1 级的像素 | 差 > 5 级的像素 |
|---|---|---|---|---|---|
${r.ablations.map(row).join('\n')}

## 两版之间的差异与处理

${r.notes.map(n => `- ${n}`).join('\n')}
`;
}

if (isMain(import.meta.url)) {   // 按真实路径比：经符号链接（macOS 的 /tmp 等）启动也算
  let opt;
  try { opt = parseArgs({ options: { write: { type: 'boolean' }, json: { type: 'boolean' }, frames: { type: 'string' }, freeze: { type: 'string' } } }).values; }
  catch (e) { console.error(`不认识的参数或缺值：${e.message}（只有 --write、--json、--frames <目录>、--freeze <基线提交>）`); process.exit(2); }
  const dumpDir = opt.frames;
  if (dumpDir) fs.mkdirSync(dumpDir, { recursive: true });
  const r = await runR187ToonRegression();
  if (r.skipped || r.error) { console.error(r.skipped || r.error); process.exit(3); }
  const { frames, ...report } = r;
  if (dumpDir) for (const [side, set] of Object.entries(frames)) for (const [n, f] of Object.entries(set)) for (const [k, buf] of Object.entries(f)) fs.writeFileSync(path.join(dumpDir, `${side}-${n}-${k}.rgba`), buf);
  report.notes = NOTES;
  if (opt.freeze) {
    freezeGolden(frames.golden.base.color, QW * 2, { baseline: opt.freeze, backend: `${report.platform.angle}：${report.platform.webglRendererGolden}` });
    console.error(`已用这次的 r170 结果重写冻结的金标准（基线 ${opt.freeze}）；再跑一遍不带 --freeze 的对拍`);
    process.exit(0);
  }
  if (opt.write) {
    const out = { schema: 'beiming.r187-toon-regression/1', generatedBy: 'node engine/shade/r187-toon-regression.mjs --write', ...report };
    fs.writeFileSync(path.join(ROOT, 'docs/quality/r187-toon-regression.json'), JSON.stringify(out, null, 2) + '\n');
    fs.writeFileSync(path.join(ROOT, 'docs/quality/r187-toon-regression.md'), reportMarkdown(out));
  }
  if (opt.json) console.log(JSON.stringify(report, null, 2));
  else {
    const line = (tag, c) => console.log(`${tag}  ${c.id.padEnd(24)} ${String(c.psnrDb).padStart(6)} dB  max ${String(c.maxAbsDiff).padStart(3)}  >1 ${(c.fracGt1 * 100).toFixed(3)}%  >5 ${(c.fracGt5 * 100).toFixed(3)}%`);
    for (const c of report.cases) line(c.pass ? '过门' : '没过', c);
    for (const c of report.layoutChecks) line(c.pass ? '对上' : '没对上', c);
    const g = report.goldenAnchor;
    for (const w of g.shadersChanged) console.log('金标准  变了  ' + w);
    for (const t of g.regions) console.log(`${t.pass ? '金标准  没变' : '金标准  变了'}  ${t.id.padEnd(24)} 缩略图块均值差：最大 ${t.maxBlockDiff} 级（容差 ${g.gate.maxBlockDiff}），平均 ${t.meanBlockDiff} 级（容差 ${g.gate.meanBlockDiff}）`);
    for (const c of [...report.negativeControls, ...report.ablations]) line(c.caught ? '拦住' : '漏过', c);
    for (const w of report.consoleWarnings) console.log('告警  ' + w);
    console.log(`未知版本（r999）告警 ${report.unknownRevisionWarnings.length} 条：${report.unknownRevisionWarnings[0] ?? '没有（应当有）'}`);
    console.log(report.overallPass ? '结论：过门' : '结论：没过门');
  }
  process.exit(report.overallPass ? 0 : 1);
}
