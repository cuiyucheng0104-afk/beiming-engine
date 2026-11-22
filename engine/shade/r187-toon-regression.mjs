// 北冥引擎 · 卡通着色回归对拍执行器：three r187 对 r170 金标准，在无头 Chrome WebGL2 上实渲、读回像素、算 PSNR 过门。
// 两张互相独立的页面（各自的 import map 把 three 指到 r170 / r187）渲同一套标定场景（r187-toon-regression.scene.mjs），
// 彩色与法线 / ID 通道各比整帧与四个子区；负对照（大幅扰动）与逐特性消融（只关一项特性）都在 r187 上改坏后再对 r170 金标准，
// 前者必须明显跌破门限、后者必须过不了门，证明这道门分得出差别、每项特性都在画面里。
// 静态服务与浏览器启动用渲染器的同一套（engine/render/lib：BEIMING_CHROME / BEIMING_ANGLE 照常生效）。
//
//   node engine/shade/r187-toon-regression.mjs [--write] [--json] [--frames <目录>]
//       --write 把结果写进 docs/quality/r187-toon-regression.{json,md}；退出码 0 过门、1 没过、2 参数写错、3 环境缺依赖（没有浏览器或没装 r187）
//       --frames <目录> 把读回的像素存成裸 RGBA8（自下而上；base 是整帧 640×480，变体是一个子区 320×240），排查差异时看图：
//           ffmpeg -f rawvideo -pix_fmt rgba -s 640x480 -i golden-base-color.rgba -vf vflip -frames:v 1 golden.png
//   过门 = PSNR ≥ 45 dB 且差 > 1 级的像素 ≤ 0.1%（只看 PSNR 时，占画面很小的特性整项坏掉也过得去）
//   runR187ToonRegression() → { skipped } | { revisions, platform, gate, cases, negativeControls, ablations, consoleWarnings, unknownRevisionWarnings, overallPass, frames }
//       frames：读回的原始像素（Buffer，不进报告）
//       consoleWarnings：r170 / r187 两页的控制台告警与报错（应为空）；unknownRevisionWarnings：把版本号改成 999 的那一页收到的告警（应有版本告警）
//       skipped 以环境码开头（SKIP_CODES：env.playwright-missing / env.browser-launch / env.three-r187-missing），调用方据此显式跳过
//   compareFrames(a, b, { width, region, channels }) → { psnrDb, exactMatch, maxAbsDiff, fracGt1, fracGt5 }
//       PSNR 按区域内全部像素、channels 个通道合并算；逐字节相同记 99 并带 exactMatch: true；frac* 是任一通道差 > 1 / > 5 级的像素占比
import fs from 'node:fs';
import process from 'node:process';   // eslint 把 engine/ 下的 .mjs 当浏览器端，Node 全局显式导入
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../render/lib/server.mjs';
import { launchBrowser, defaultAngle } from '../render/lib/gpu.mjs';
import { QW, QH, REGIONS, VARIANTS } from './r187-toon-regression.scene.mjs';

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
const pageHtml = (rev, names) => `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"${BUILDS[rev]}"}}</script>
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
  const n = region.w * region.h, r6 = v => Math.round(v * 1e6) / 1e6;
  return { psnrDb: se === 0 ? 99 : Math.round(1000 * Math.log10(255 * 255 * n * channels / se)) / 100, exactMatch: se === 0, maxAbsDiff: max, fracGt1: r6(gt1 / n), fracGt5: r6(gt5 / n) };
}

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

export async function runR187ToonRegression() {
  if (!fs.existsSync(path.join(ROOT, BUILDS[187]))) return { skipped: 'env.three-r187-missing：没装可选依赖 three-webgpu（= three@0.187.0），先 npm install --include=optional --ignore-scripts' };
  let browser;
  try { browser = await launchBrowser(); } catch (e) { if (SKIP_CODES.includes(e.code)) return { skipped: `${e.code}：${e.message}` }; throw e; }
  const variantNames = Object.keys(VARIANTS).filter(n => n !== 'base');
  const server = createServer({ root: ROOT, middleware: (req, res, { done }) => {
    if (req.url === BUILDS[999]) { done(200, { 'Content-Type': 'text/javascript; charset=utf-8' }, SHIM_999); return true; }
    const m = /^\/__s5__\/(170|187|999)\?v=([\w,-]*)$/.exec(req.url);
    if (m) done(200, { 'Content-Type': 'text/html; charset=utf-8' }, pageHtml(m[1], m[2].split(',').filter(Boolean)));
    return !!m;
  } });
  const warnings = [], unknown = [];
  try {
    const { url } = await server.listen(0);
    const chrome = browser.version();
    const golden = await shoot(browser, url, 170, ['base'], warnings);
    const cand = await shoot(browser, url, 187, ['base', ...variantNames], warnings);
    await shoot(browser, url, 999, [], unknown);
    const W = QW * 2, full = { x: 0, y: 0, w: W, h: QH * 2 }, sub = { x: 0, y: 0, w: QW, h: QH }, G = golden.frames.base, K = cand.frames.base;
    const regionOf = id => { const r = REGIONS.find(q => q.id === id); return { x: r.x, y: r.y, w: QW, h: QH }; };
    const crop = (buf, r) => { const out = Buffer.alloc(QW * QH * 4); for (let y = 0; y < QH; y++) buf.copy(out, y * QW * 4, ((r.y + y) * W + r.x) * 4, ((r.y + y) * W + r.x + QW) * 4); return out; };
    const passes = m => m.psnrDb >= TOON_PSNR_GATE_DB && m.fracGt1 <= TOON_MAX_FRAC_GT1;
    const gate = (id, what, m) => ({ id, what, ...m, pass: passes(m) });
    const cases = [
      gate('frame', '彩色整帧（2 × 2 子区）', compareFrames(G.color, K.color, { width: W, region: full })),
      ...REGIONS.map(r => gate(r.id, '彩色子区', compareFrames(G.color, K.color, { width: W, region: regionOf(r.id) }))),
      gate('id-frame', '法线 + 物体 / 实例 ID 通道整帧（uToonPass = 1，RGBA 四通道）', compareFrames(G.id, K.id, { width: W, region: full, channels: 4 })),
      ...REGIONS.map(r => gate('id:' + r.id, '法线 / ID 通道子区', compareFrames(G.id, K.id, { width: W, region: regionOf(r.id), channels: 4 }))),
    ];
    // 变体只读回它所属的子区：与金标准同一子区（彩色或法线 / ID 通道）比
    const versus = n => { const v = VARIANTS[n], id = v.pass === 'id'; const m = compareFrames(crop(id ? G.id : G.color, regionOf(v.region)), cand.frames[n].crop, { width: QW, region: sub, channels: id ? 4 : 3 }); return { id: n, what: v.what, region: v.region, ...m, pass: passes(m) }; };
    const of = kind => variantNames.filter(n => VARIANTS[n].kind === kind).map(versus);
    const negativeControls = of('negative').map(m => ({ ...m, caught: m.psnrDb < NEGATIVE_MAX_PSNR_DB }));
    const ablations = of('ablation').map(m => ({ ...m, caught: !m.pass }));
    cases.push(...of('identity').map(({ region, ...m }) => m));
    return {
      revisions: { golden: golden.revision, candidate: cand.revision },
      platform: { os: process.platform, arch: process.arch, node: process.version, chrome, angle: defaultAngle(), webglRenderer: cand.gpu, webglRendererGolden: golden.gpu },
      gate: { minPsnrDb: TOON_PSNR_GATE_DB, maxFracGt1: TOON_MAX_FRAC_GT1, negativeMaxPsnrDb: NEGATIVE_MAX_PSNR_DB, frame: { width: W, height: QH * 2 }, region: { width: QW, height: QH } },
      cases, negativeControls, ablations, consoleWarnings: warnings, unknownRevisionWarnings: unknown,
      overallPass: warnings.length === 0 && unknown.some(w => w.includes('当前 r999')) && cases.every(c => c.pass) && [...negativeControls, ...ablations].every(n => n.caught),
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

结论：**${r.overallPass ? '过门' : '没过门'}**。\`engine/shade\`（patch.js / toon.js / surface.js）在 three r${r.revisions.candidate} 下实渲的画面，逐项对 r${r.revisions.golden} 金标准 PSNR ≥ ${r.gate.minPsnrDb} dB 且差 > 1 级的像素 ≤ ${r.gate.maxFracGt1 * 100}%（${r.cases.filter(c => c.pass).length} / ${r.cases.length} 项过门，其中 ${r.cases.filter(c => c.exactMatch).length} 项逐字节相同）；负对照 ${r.negativeControls.filter(c => c.caught).length} / ${r.negativeControls.length} 组跌破 ${r.gate.negativeMaxPsnrDb} dB；逐特性消融 ${r.ablations.filter(c => c.caught).length} / ${r.ablations.length} 组被门拦住；两版页面控制台告警 ${r.consoleWarnings.length} 条。

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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--frames'), dumpDir = at > 0 ? process.argv[at + 1] : null;
  const bad = process.argv.slice(2).filter((a, i) => !['--write', '--json', '--frames'].includes(a) && i + 2 !== at + 1);
  if (bad.length) { console.error(`不认识的参数：${bad.join(' ')}（只有 --write、--json、--frames <目录>）`); process.exit(2); }
  if (at > 0 && (!dumpDir || dumpDir.startsWith('--'))) { console.error('--frames 后面要写一个目录'); process.exit(2); }
  if (dumpDir) fs.mkdirSync(dumpDir, { recursive: true });
  const r = await runR187ToonRegression();
  if (r.skipped) { console.error(r.skipped); process.exit(3); }
  const { frames, ...report } = r;
  if (dumpDir) for (const [side, set] of Object.entries(frames)) for (const [n, f] of Object.entries(set)) for (const [k, buf] of Object.entries(f)) fs.writeFileSync(path.join(dumpDir, `${side}-${n}-${k}.rgba`), buf);
  report.notes = NOTES;
  if (process.argv.includes('--write')) {
    const out = { schema: 'beiming.r187-toon-regression/1', generatedBy: 'node engine/shade/r187-toon-regression.mjs --write', ...report };
    fs.writeFileSync(path.join(ROOT, 'docs/quality/r187-toon-regression.json'), JSON.stringify(out, null, 2) + '\n');
    fs.writeFileSync(path.join(ROOT, 'docs/quality/r187-toon-regression.md'), reportMarkdown(out));
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    const line = (tag, c) => console.log(`${tag}  ${c.id.padEnd(24)} ${String(c.psnrDb).padStart(6)} dB  max ${String(c.maxAbsDiff).padStart(3)}  >1 ${(c.fracGt1 * 100).toFixed(3)}%  >5 ${(c.fracGt5 * 100).toFixed(3)}%`);
    for (const c of report.cases) line(c.pass ? '过门' : '没过', c);
    for (const c of [...report.negativeControls, ...report.ablations]) line(c.caught ? '拦住' : '漏过', c);
    for (const w of report.consoleWarnings) console.log('告警  ' + w);
    console.log(`未知版本（r999）告警 ${report.unknownRevisionWarnings.length} 条：${report.unknownRevisionWarnings[0] ?? '没有（应当有）'}`);
    console.log(report.overallPass ? '结论：过门' : '结论：没过门');
  }
  process.exit(report.overallPass ? 0 : 1);
}
