// 北冥引擎 · 编号图与后期回归对拍执行器：three r187 对 r170 金标准，在无头 Chrome WebGL2 上实渲、读回像素过门（r187 卡通栈回归之二；
// 卡通着色层那一半在 engine/shade/r187-toon-regression.mjs）。
// 两张互相独立的页面（各自的 import map 把 three 与 three/addons/ 一起指到 r170 / r187）渲同一个标定场景（r187-look-regression.scene.mjs）：
//   ID 图      engine/look/ids.js 的半浮点输出原值读回：离散编号（低 11 位、高位两段）两版逐像素相同，线宽 / 可见度两个通道差 ≤ 0.001，
//              预期的编号都在、没有多出来的；球的线宽系数与两种可见度（露出的、被半透明玻璃挡着的）对得上给定值
//   逐级与整帧 中间缓冲（ID 视图、ID 图深度、边缘、墨线、bloom、纸纹、Kuwahara 之后）、只开一道后期的画面、各道全开的整帧，逐项 PSNR 过门
//   负对照（大幅扰动）与逐道消融（只关一道 / 只改坏 ID 图的一个分支）都在 r187 上改坏后再对 r170 金标准：前者必须明显跌破门限，后者必须过不了门
// 另有两道不靠「两版互比」的核对：两页实报的 three 版本与 OutputPass 实际解析到的包版本必须是 170 / 187；
// r170 这边再对一份冻结的金标准（r187-look-regression.golden.mjs），两版一起漂移时靠它报出来。
// 片段补丁没命中算构建失败（FX22）：verifyShaderPatchBuild 在两版页面里故意改错一段 three 的着色器原文，三条编译路径都必须抛错。
//
//   node engine/look/r187-look-regression.mjs [--write] [--json] [--frames <目录>] [--freeze <基线提交>]
//       --write 把结果写进 docs/quality/r187-look-regression.{json,md}；
//       退出码 0 过门、1 没过、2 参数写错、3 环境不对（没有浏览器、没装 r187，或两页的 three / addons 不是 170 / 187：env.three-revision-mismatch）
//       --freeze <基线提交> 用这次的 r170 结果重写冻结的金标准 r187-look-regression.golden.json（只在有意改画面并按 POLICY 审批之后；不做对拍判定）
//       --frames <目录> 把读回的整帧与各级画面存成裸 RGBA8（640 × 480，自下而上），排查差异时看图：
//           ffmpeg -f rawvideo -pix_fmt rgba -s 640x480 -i golden-base-final.rgba -vf vflip -frames:v 1 golden.png
//   过门与读数取整同 engine/shade/r187-toon-regression.mjs 的 compareFrames：PSNR ≥ 50 dB、差 > 1 级的像素 ≤ 0.1%、差 > 5 级的像素 ≤ 0.1%，按未舍入的读数判
//   runR187LookRegression({ builds }) → { skipped } | { error, revisions, overallPass: false }
//       | { revisions, platform, gate, idMap, cases, goldenAnchor, negativeControls, ablations, consoleWarnings, overallPass, frames, shaders }
//       builds：覆盖页面里的构建路径 { 170 | 187: { three, addons } }（测试用：把 187 的 three 或 addons 指到 r170，验证错版报 error）
//       frames / shaders：读回的原始像素、r170 页这一趟编译的着色器源码（不进报告）；skipped 以环境码开头（SKIP_CODES），调用方据此显式跳过
//   judgeLookRegression({ revisions, platform, frames, shaders, consoleWarnings }) → 同上但不带 frames / shaders：对读回的结果重判一遍，不启动浏览器
//   compareIdMaps(a, b) → { idDiffCount, widthAlphaDiffCount, widthMaxAbsDiff, alphaMaxAbsDiff, pass }   a / b 是半浮点 RGBA 原值；
//       pass = 编号零差异且线宽 / 可见度最大差 ≤ ID_CHANNEL_TOL
//   verifyShaderPatchBuild({ corruptions = [null], builds }) → { skipped } | { runs: [{ corrupt, results: [{ revision, stages: { compile, look, ids } }], failed }] }
//       corruptions：scene.mjs 的 CORRUPTIONS 里的改法，一种一轮（null = 不改，正对照），每轮在 r170 / r187 两页各建一遍；
//       每条编译路径 null = 没出错，否则是抛出的错误信息；failed = 有任何一条路径出错（构建应当失败）
import fs from 'node:fs';
import zlib from 'node:zlib';
import process from 'node:process';   // eslint 把 engine/ 下的 .mjs 当浏览器端，Node 全局显式导入
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isMain } from '../../tools/lib/cli.mjs';
import { createServer } from '../render/lib/server.mjs';
import { launchBrowser, defaultAngle } from '../render/lib/gpu.mjs';
import { compareFrames, TOON_PSNR_GATE_DB, TOON_MAX_FRAC_GT1, TOON_MAX_FRAC_GT5, NEGATIVE_MAX_PSNR_DB, SKIP_CODES } from '../shade/r187-toon-regression.mjs';
import { W, H, STAGES, VARIANTS, EXPECT_IDS, IDS, BALL } from './r187-look-regression.scene.mjs';
import { checkGolden, freezeGolden, decodeIds, THUMB_SKIP } from './r187-look-regression.golden.mjs';

export { SKIP_CODES };
export const ID_CHANNEL_TOL = 1e-3;   // 线宽 / 可见度两个半浮点通道的容差；编号本身不留容差
const MIN_PIXELS = 16;                // 一个编号、一项消融至少要占这么多像素才算数

// 软件渲染（SwiftShader）下 Chrome 对本执行器自己的 readPixels 报的驱动性能提示，与 three / engine 无关，不算告警；别的告警与报错一条不放
const READBACK_STALL = /GL Driver Message \(OpenGL, Performance, [^)]*\): GPU stall due to ReadPixels/;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUILDS = {
  170: { three: '/node_modules/three/build/three.module.js', addons: '/node_modules/three/examples/jsm/' },
  187: { three: '/node_modules/three-webgpu/build/three.module.js', addons: '/node_modules/three-webgpu/examples/jsm/' },
};
const SCENE = '/engine/look/r187-look-regression.scene.mjs';
const BODY = {
  probe: () => `import * as THREE from 'three';
window.RESULT = { revision: THREE.REVISION, addons: import.meta.resolve('three/addons/postprocessing/OutputPass.js') };`,
  suite: names => `import { renderSuite, pack } from '${SCENE}';
const r = renderSuite(${JSON.stringify(names)});
window.FRAME = (n, k) => pack(r.frames[n][k]);
window.RESULT = { ...r, frames: Object.fromEntries(Object.entries(r.frames).map(([n, f]) => [n, Object.keys(f)])) };`,
  patch: ([name]) => `import { corrupt, patchBuild } from '${SCENE}';
${name ? `corrupt(${JSON.stringify(name)});` : ''}
window.RESULT = patchBuild();`,
};
const pageHtml = (build, body) => `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"${build.three}","three/addons/":"${build.addons}"}}</script>
<script>
window.addEventListener('error', e => { window.RESULT ??= { error: String(e.message || e) }; });
window.addEventListener('unhandledrejection', e => { window.RESULT ??= { error: String(e.reason && e.reason.stack || e.reason) }; });
</script>
</head><body style="margin:0;background:#000"><script type="module">
${body}
</script></body></html>`;

// 进报告的读数：向不利的一边取整（判门在 compareFrames 里用未舍入的值做完了）
const up6 = v => Math.ceil(v * 1e6) / 1e6, shown = m => ({ ...m, psnrDb: Math.floor(m.psnrDb * 100) / 100, fracGt1: up6(m.fracGt1), fracGt5: up6(m.fracGt5) });
// OutputPass 实际解析到的地址 → 它所在的包的版本（node_modules/<包>/package.json 的 0.<版本>.x）
function addonsRevision(url) {
  const m = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(new URL(url).pathname);
  try { return m ? JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', m[1], 'package.json'), 'utf8')).version.split('.')[1] : '?'; } catch { return '?'; }
}
const revisionError = r => r.golden === '170' && r.candidate === '187' && r.goldenAddons === '170' && r.candidateAddons === '187' ? null
  : `env.three-revision-mismatch：金标准页的 three 实报 r${r.golden}、OutputPass 来自 r${r.goldenAddons}（都要 r170）；待测页的 three 实报 r${r.candidate}、OutputPass 来自 r${r.candidateAddons}（都要 r187）。node_modules/three 应当是 three@0.170.0、node_modules/three-webgpu 应当是 three@0.187.0：npm install --include=optional --ignore-scripts 重装`;

async function shoot(browser, base, rev, mode, names, warnings) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !READBACK_STALL.test(m.text())) warnings.push(`r${rev}: ${m.text().slice(0, 240)}`); });
  try {
    await page.goto(`${base}__s6__/${rev}/${mode}?v=${names.join(',')}`, { waitUntil: 'commit' });
    await page.waitForFunction(() => window.RESULT !== undefined, null, { timeout: 600000 });   // 软件渲染（CI 的 SwiftShader）下编译着色器慢
    const r = await page.evaluate(() => window.RESULT);
    if (r.error) throw new Error(`r${rev} 页面出错：${r.error}`);
    if (mode === 'suite') for (const [n, keys] of Object.entries(r.frames)) {
      r.frames[n] = {};
      for (const k of keys) {
        const raw = zlib.gunzipSync(Buffer.from(await page.evaluate(([n, k]) => window.FRAME(n, k), [n, k]), 'base64'));
        r.frames[n][k] = k === 'id' ? new Uint16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length)) : raw;
      }
    }
    return r;
  } finally { await page.close(); }
}

// 起浏览器与静态服务，跑完收掉；没有浏览器 / 没装 r187 时返回 { skipped }
async function withPages(builds, fn) {
  const B = { 170: { ...BUILDS[170], ...builds?.[170] }, 187: { ...BUILDS[187], ...builds?.[187] } };
  if (!fs.existsSync(path.join(ROOT, BUILDS[187].three))) return { skipped: 'env.three-r187-missing：没装可选依赖 three-webgpu（= three@0.187.0），先 npm install --include=optional --ignore-scripts' };
  let browser;
  try { browser = await launchBrowser(); } catch (e) { if (SKIP_CODES.includes(e.code)) return { skipped: `${e.code}：${e.message}` }; throw e; }
  const server = createServer({ root: ROOT, middleware: (req, res, { done }) => {
    const m = /^\/__s6__\/(170|187)\/(probe|suite|patch)\?v=([\w,-]*)$/.exec(req.url);
    if (m) done(200, { 'Content-Type': 'text/html; charset=utf-8' }, pageHtml(B[m[1]], BODY[m[2]](m[3].split(',').filter(Boolean))));
    return !!m;
  } });
  try { const { url } = await server.listen(0); return await fn(browser, url); }
  finally { await browser.close(); await server.close(); }
}

export function runR187LookRegression({ builds } = {}) {
  return withPages(builds, async (browser, url) => {
    const warnings = [], chrome = browser.version();
    // 先核两页实报的版本（只加载、不渲染），错版直接报出来：170 对 170 的自比、或 r187 的核配 r170 的 OutputPass，都不是双版本回归
    const pg = await shoot(browser, url, 170, 'probe', [], warnings), pk = await shoot(browser, url, 187, 'probe', [], warnings);
    const revisions = { golden: pg.revision, candidate: pk.revision, goldenAddons: addonsRevision(pg.addons), candidateAddons: addonsRevision(pk.addons) };
    if (revisionError(revisions)) return { error: revisionError(revisions), revisions, overallPass: false };
    const golden = await shoot(browser, url, 170, 'suite', ['base'], warnings);
    const cand = await shoot(browser, url, 187, 'suite', ['base', ...Object.keys(VARIANTS)], warnings);
    const frames = { golden: golden.frames, candidate: cand.frames };
    return {
      ...judgeLookRegression({
        revisions, frames, shaders: golden.shaders, consoleWarnings: warnings,
        platform: { os: process.platform, arch: process.arch, node: process.version, chrome, angle: defaultAngle(), webglRenderer: cand.gpu, webglRendererGolden: golden.gpu },
      }),
      frames, shaders: golden.shaders,   // 原始像素与 r170 页的着色器源码（不进报告）：调试时存图、测试里重判用
    };
  });
}

export function compareIdMaps(a, b) {
  const A = decodeIds(a), B = decodeIds(b);
  let idDiffCount = 0, widthAlphaDiffCount = 0, widthMaxAbsDiff = 0, alphaMaxAbsDiff = 0;
  for (let i = 0; i < A.id.length; i++) {
    const dw = Math.abs(A.width[i] - B.width[i]), da = Math.abs(A.alpha[i] - B.alpha[i]);
    if (A.id[i] !== B.id[i]) idDiffCount++;
    if (dw > ID_CHANNEL_TOL || da > ID_CHANNEL_TOL) widthAlphaDiffCount++;
    if (dw > widthMaxAbsDiff) widthMaxAbsDiff = dw; if (da > alphaMaxAbsDiff) alphaMaxAbsDiff = da;
  }
  return { idDiffCount, widthAlphaDiffCount, widthMaxAbsDiff, alphaMaxAbsDiff, pass: idDiffCount === 0 && widthMaxAbsDiff <= ID_CHANNEL_TOL && alphaMaxAbsDiff <= ID_CHANNEL_TOL };
}
// 一版自己的 ID 图：预期的编号都在（各占 MIN_PIXELS 个像素以上）、没有多出来的编号、高位段确实用上了、球的线宽系数与两种可见度对得上
function idCensus(tag, px) {
  const { id, width, alpha } = decodeIds(px), area = new Map(), near = (v, want) => Math.abs(v - want) <= ID_CHANNEL_TOL;
  let highSegmentPixels = 0, ballWidthOff = 0, ballOpen = 0, ballBehindGlass = 0, ballAlphaOff = 0;
  for (let i = 0; i < id.length; i++) {
    if (id[i] === 0) continue;
    area.set(id[i], (area.get(id[i]) ?? 0) + 1); if (id[i] >= 2048) highSegmentPixels++;
    if (id[i] !== IDS.ball) continue;
    if (!near(width[i], BALL.width)) ballWidthOff++;
    if (near(alpha[i], BALL.alpha)) ballOpen++; else if (near(alpha[i], BALL.alpha * (1 - BALL.glass))) ballBehindGlass++; else ballAlphaOff++;
  }
  const idsMissing = EXPECT_IDS.filter(v => !(area.get(v) >= MIN_PIXELS)), idsUnexpected = [...area.keys()].filter(v => !EXPECT_IDS.includes(v)).sort((x, y) => x - y);
  const ball = { widthOff: ballWidthOff, open: ballOpen, behindGlass: ballBehindGlass, alphaOff: ballAlphaOff };
  return { id: tag, idsExpected: EXPECT_IDS.length, idsMissing, idsUnexpected, highSegmentPixels, ball,
    pass: idsMissing.length === 0 && idsUnexpected.length === 0 && highSegmentPixels >= MIN_PIXELS && ballWidthOff === 0 && ballAlphaOff === 0 && ballOpen >= MIN_PIXELS && ballBehindGlass >= MIN_PIXELS };
}

// 判定与实渲分开：只看读回的像素与两页的自报，不碰浏览器（测试里改坏读回的像素再判一遍）
export function judgeLookRegression({ revisions, platform, frames, shaders, consoleWarnings }) {
  const G = frames.golden.base, K = frames.candidate.base, full = { x: 0, y: 0, w: W, h: H }, names = Object.keys(VARIANTS);
  const cases = STAGES.map(s => ({ id: s.id, what: s.what, ...shown(compareFrames(G[s.id], K[s.id], { width: W, region: full })) }));
  const versus = n => {
    const v = VARIANTS[n], side = frames.candidate[n];
    if (v.pass === 'id') { const m = compareIdMaps(G.id, side.id); return { id: n, what: v.what, pass: m.pass, ...m, caught: Math.max(m.idDiffCount, m.widthAlphaDiffCount) >= MIN_PIXELS }; }
    const m = compareFrames(G.final, side.final, { width: W, region: full });
    return { id: n, what: v.what, ...shown(m), caught: v.kind === 'negative' ? m.psnrDb < NEGATIVE_MAX_PSNR_DB : !m.pass };
  };
  const of = kind => names.filter(n => VARIANTS[n].kind === kind).map(versus);
  const negativeControls = of('negative'), ablations = of('ablation'), same = of('identity');
  cases.push(...same.filter(c => VARIANTS[c.id].pass !== 'id').map(({ caught, ...m }) => m));
  const rebuilt = same.find(c => VARIANTS[c.id].pass === 'id');
  const sides = [idCensus('r170', G.id), idCensus('r187', K.id)];
  const idMap = { what: 'ID 图（ids.js 的半浮点输出原值）：r187 对 r170', width: W, height: H, channelTol: ID_CHANNEL_TOL, ...compareIdMaps(G.id, K.id), sides,
    rebuilt: { id: rebuilt.id, what: rebuilt.what, idDiffCount: rebuilt.idDiffCount, widthAlphaDiffCount: rebuilt.widthAlphaDiffCount, pass: rebuilt.pass } };
  idMap.pass = idMap.pass && sides.every(s => s.pass) && rebuilt.pass;
  const goldenAnchor = checkGolden(G, shaders);
  return {
    revisions, platform,
    gate: { minPsnrDb: TOON_PSNR_GATE_DB, maxFracGt1: TOON_MAX_FRAC_GT1, maxFracGt5: TOON_MAX_FRAC_GT5, negativeMaxPsnrDb: NEGATIVE_MAX_PSNR_DB, idChannelTol: ID_CHANNEL_TOL, frame: { width: W, height: H } },
    idMap, cases, goldenAnchor, negativeControls, ablations, consoleWarnings,
    overallPass: !revisionError(revisions) && consoleWarnings.length === 0 && idMap.pass && cases.every(c => c.pass) && goldenAnchor.pass && [...negativeControls, ...ablations].every(n => n.caught),
  };
}

export function verifyShaderPatchBuild({ corruptions = [null], builds } = {}) {
  return withPages(builds, async (browser, url) => {
    const runs = [];
    for (const corrupt of corruptions) {
      const results = [];
      for (const rev of [170, 187]) results.push(await shoot(browser, url, rev, 'patch', corrupt ? [corrupt] : [], []));   // 这里的控制台报错是预期的，不收
      runs.push({ corrupt, results, failed: results.some(r => Object.values(r.stages).some(Boolean)) });
    }
    return { runs };
  });
}

// 逐项比对两版在这条链路上的差异后的结论（读数是本执行器实测）
const NOTES = [
  '结论：这条链路上 `engine/look` 不用为 r187 改一行（`engine/look/*.js` 与基线提交逐字节相同，所以 r170 的输出也没变）。ID 图的半浮点原值、七张中间缓冲、九张只开一道的画面与整帧，本执行器在 macOS Metal 与 SwiftShader 上实测都是两版逐字节相同。',
  'OutputPass：两页各用自己那一版的 `three/addons/postprocessing/OutputPass.js`（执行器按它实际解析到的包核版本，r187 的核配 r170 的 OutputPass 会报 `env.three-revision-mismatch`）。逐行比对两版：r187 把内部的 `fsQuad` 改名 `_fsQuad`、加了 `isOutputPass` 标记与 CustomToneMapping 分支，NoToneMapping + sRGB 输出这一路的着色器相同；`createLook` 只调 `out.render` 与 `out.material.dispose()`，两版都在。',
  '渲染目标与深度：主场景（MSAA 4 倍、半浮点、FloatType 深度纹理）与 ID 图（Nearest、半浮点、FloatType 深度纹理）两版读回一致；`readRenderTargetPixels` 读半浮点目标两版都要给 Uint16Array。ID 图的顶点着色器用的 three 块（batching、morphtarget、morphinstance、skinning、begin_vertex、project_vertex）r187 里都在，InstancedMesh 的 `gl_InstanceID` 编号两版相同。',
  '投影：标定场景里的卡通材质带平行光投影。r187 删掉了 PCFSoftShadowMap，场景在 r187 下设 PCFShadowMap，采样核由 `engine/shade` 的 `quantizeShadow` 换回 r170 的（见 [r187-toon-regression.md](r187-toon-regression.md)）；`engine/stage/film.js` 的 `createFilm` 默认值仍写死 PCFSoftShadowMap（不在本次改动范围），整条出片链切到 r187 时要跟着改。',
  '片段补丁没命中算构建失败（FX22）：`engine/shade/patch.js` 收紧了两处以前会悄悄放过的地方。给了 `vertexNormal` 钩子而着色器里没有 `#include <beginnormal_vertex>` 时现在抛错（以前不打这段补丁、照常出图）；投影块既不是 r187 的写法、也没有 r170 自带的软阴影核（`SHADOWMAP_TYPE_PCF_SOFT`）时抛错（以前按 r170 的路走、不换核）。r170 下打完补丁的着色器源码与改动前逐字节相同（`engine/shade/r187-toon-regression.golden.json` 的 64 段摘要没变）。',
  '构建失败的实测（`engine/look/r187-look-regression.test.mjs` 的 FX22 用例）：两版页面里故意改错六种着色器原文（卡通合成替换的那一行光照、两处 `#include` 被展开成原文、投影块里 `getShadow` 的返回写法、阴影深度材质的 `#include <begin_vertex>`、软阴影采样核），`renderer.compile`、`look.render`、单独的 ID 图三条编译路径都同步抛错并点名锚点（阴影深度材质只在渲阴影时编译，`renderer.compile` 与单独的 ID 图碰不到它，整条后期链那一路抛）；ID 图里只吞物体自己的 `onBeforeRender` 出的错，材质 `onBeforeCompile` 的错照常抛出。渲染器这边（`engine/render/page.mjs` + `lib/patch-check.mjs`）：这个错不管是置 READY 之前的未捕获异常、`render(t)` 抛错，还是被页面接住后只打到控制台，`still.mjs` 都以退出码 1（`failure.shader-error`）失败、不留图，`--allow-gl-errors` 不放行；改动前「只打到控制台」那一路是退出码 0、照常出一张没打补丁的图。',
  '没有覆盖的：OutputPass 的色调映射各分支（出片链用 NoToneMapping）；外部图片纸纹（`paperUrl`、纸纹锚点与面积取样变体）；Kuwahara 的各向异性分支与远近换半径；蒙皮、变形目标、BatchedMesh 的 ID；Sprite / Points / Line 的挡线判定；非 1080 标定的像素缩放（本场景按自己的画幅标定，k = 1）；r187 的 WebGPURenderer（它不走 `onBeforeCompile`，是另一条路线）。',
];
const row = c => `| \`${c.id}\` | ${c.what} | ${c.exactMatch ? '逐字节相同' : c.psnrDb + ' dB'} | ${c.maxAbsDiff} | ${(c.fracGt1 * 100).toFixed(3)}% | ${(c.fracGt5 * 100).toFixed(3)}% |`;
export function reportMarkdown(r) {
  const p = r.platform, m = r.idMap, g = r.goldenAnchor, idAbl = r.ablations.filter(a => a.idDiffCount !== undefined), postAbl = r.ablations.filter(a => a.idDiffCount === undefined);
  return `# r187 编号图与后期回归：对 r170 金标准

本页由 \`node engine/look/r187-look-regression.mjs --write\` 生成，数据在同名的 \`.json\` 里；不要手改，重跑即可。卡通着色层那一半见 [r187-toon-regression.md](r187-toon-regression.md)。

结论：**${r.overallPass ? '过门' : '没过门'}**。\`engine/look\`（ID 图与整条后期链）在 three r${r.revisions.candidate} 下实渲的结果对 r${r.revisions.golden} 金标准：ID 图的离散编号 ${m.idDiffCount} 个像素不同（要 0），线宽 / 可见度通道最大差 ${Math.max(m.widthMaxAbsDiff, m.alphaMaxAbsDiff)}（容差 ${m.channelTol}）；逐级与整帧 ${r.cases.filter(c => c.pass).length} / ${r.cases.length} 项过门（PSNR ≥ ${r.gate.minPsnrDb} dB、差 > 1 级的像素 ≤ ${r.gate.maxFracGt1 * 100}%、差 > 5 级的像素 ≤ ${r.gate.maxFracGt5 * 100}%），其中 ${r.cases.filter(c => c.exactMatch).length} 项逐字节相同；负对照 ${r.negativeControls.filter(c => c.caught).length} / ${r.negativeControls.length} 组跌破 ${r.gate.negativeMaxPsnrDb} dB；逐道消融 ${r.ablations.filter(c => c.caught).length} / ${r.ablations.length} 组被门拦住；r170 对冻结的金标准（基线 \`${g.baseline}\`）${g.pass ? '没变' : '**变了**'}；两版页面控制台告警 ${r.consoleWarnings.length} 条。

- 实际运行平台：${p.os}-${p.arch}，Node ${p.node}，无头 Chrome ${p.chrome}，ANGLE 后端 ${p.angle}
- WebGL 渲染器：${p.webglRenderer}
- 两页的 three 实报 r${r.revisions.golden} / r${r.revisions.candidate}；\`three/addons/postprocessing/OutputPass.js\` 实际解析到的包是 r${r.revisions.goldenAddons} / r${r.revisions.candidateAddons}
- 这份读数只代表上面这台机器；别的显卡或软件渲染要在那台机器上重跑

## 怎么比的

两张互相独立的测试页，各自的 import map 把 \`three\` 与 \`three/addons/\` 一起指到 r170（\`three\`）或 r187（\`three-webgpu\` 别名包），渲同一个确定性标定场景（\`engine/look/r187-look-regression.scene.mjs\`，${r.gate.frame.width} × ${r.gate.frame.height}），渲染器设置与 \`createFilm\` 相同（sRGB 输出、不做色调映射、不开抗锯齿、软阴影），后期用 \`createLook\`（墨线超采样 2 倍、主场景 MSAA 4 倍、像素量按本画幅标定）。场景里有卡通材质、three 自带材质与 ShaderMaterial，投影、顶点形变、线性 HDR 的亮点都在。

## ID 图（物体 / 实例编号）

\`createIdPass\` 单独渲到与成片同样配置的渲染目标（半浮点 RGBA、Nearest、带深度纹理），读回半浮点原值，RGBA = （编号低 11 位，编号高位，线宽系数，线可见度）。编号是离散值，不留容差。

| 项 | 编号不同的像素 | 线宽 / 可见度超出容差的像素 | 线宽最大差 | 可见度最大差 | 判定 |
|---|---|---|---|---|---|
| r187 对 r170 | ${m.idDiffCount} | ${m.widthAlphaDiffCount} | ${m.widthMaxAbsDiff} | ${m.alphaMaxAbsDiff} | ${m.idDiffCount === 0 && m.widthAlphaDiffCount === 0 ? '相同' : '**不同**'} |
| \`${m.rebuilt.id}\`：${m.rebuilt.what} | ${m.rebuilt.idDiffCount} | ${m.rebuilt.widthAlphaDiffCount} | | | ${m.rebuilt.pass ? '相同' : '**不同**'} |

各版自己的 ID 图里，预期的 ${m.sides[0].idsExpected} 个编号都要在（各占 ${MIN_PIXELS} 个像素以上）、不能有多出来的编号。彩屑是 2100 个实例的 InstancedMesh，露出的 6 个实例编号 ${IDS.confetti.join('、')}，跨过 11 位低段（2048 = 低段 0、高段 1）；它后面的物体编号 ${IDS.ball} 到 ${IDS.duo}，全在高段。球的线宽系数给的是 ${BALL.width}，可见度 ${BALL.alpha}，被不透明度 ${BALL.glass} 的半透明玻璃挡着的那一半应当是 ${BALL.alpha} × ${1 - BALL.glass}。

| 版本 | 没找到的编号 | 多出来的编号 | 高段（≥ 2048）像素 | 球：线宽不对的像素 | 球：露出 / 玻璃后 / 可见度不对的像素 | 判定 |
|---|---|---|---|---|---|---|
${m.sides.map(s => `| ${s.id} | ${s.idsMissing.length ? s.idsMissing.join('、') : '无'} | ${s.idsUnexpected.length ? s.idsUnexpected.join('、') : '无'} | ${s.highSegmentPixels} | ${s.ball.widthOff} | ${s.ball.open} / ${s.ball.behindGlass} / ${s.ball.alphaOff} | ${s.pass ? '对上' : '**没对上**'} |`).join('\n')}

| 场景里的物体 | 走的分支 |
|---|---|
| 彩屑（InstancedMesh × 2100） | 逐实例编号（\`outlinePerInstance\` 默认），低 / 高两段 |
| 球 | 普通网格，\`outlineWidth\` / \`outlineAlpha\` |
| 卵石（InstancedMesh × 5） | \`outlinePerInstance: false\`，整批共用一个编号 |
| 躯干 + 头 | \`outlineGroup\` 写在父节点上，子物体继承，同组一个编号 |
| 叶片 | three 自带材质 + 带 alpha 的贴图，按 \`alphaTest\` 镂空（CUTOUT），贴图带 repeat / offset |
| 芦苇 | 材质里的顶点位移经 \`outlineVertex\` 交给 ID 图；自带阴影深度材质与法线钩子 |
| 双材质方块 | 两个面用 \`noId\` 材质，这两组不进 ID 图 |
| 地面、灯 | 实心挡线（自动判定的与显式 \`'solid'\`） |
| 玻璃、挡块、柱子、幽灵块 | 透明材质半挡（soft）、ShaderMaterial 自动判成 own、卡通材质显式 \`'own'\`、\`outlineOccluder: false\` 不挡 |

## 逐级与整帧：r187 对 r170

\`view-*\` 是 \`look.render\` 的 debug 视图（中间缓冲原样画出来），\`solo-*\` 是只开一道后期、其余都关的整条链，\`final\` 是各道全开的整帧。都从画布读回 RGBA8，只比 RGB。

| 项 | 内容 | PSNR | 最大单通道差 | 差 > 1 级的像素 | 差 > 5 级的像素 |
|---|---|---|---|---|---|
${r.cases.map(row).join('\n')}

## r170 对冻结的金标准

上面的 r170 与 r187 跑的是同一份 \`engine/look\`，两版一起改坏时互比照样全等。所以 r170 这边另外对一份冻结的金标准（\`engine/look/r187-look-regression.golden.json\`，基线 \`${g.baseline}\`，冻结于 ${g.backend}），它不随待测代码重生：

- 着色器摘要：标定场景这一趟在 r170 下交给 WebGL 编译的全部着色器源码（three 展开 \`#include\`、加完前缀之后的最终文本，共 ${g.shaders} 段）各自的 SHA-256，逐字节比。${g.shadersChanged.added + g.shadersChanged.removed ? `**变了**：${g.shadersChanged.added} 段不在冻结的金标准里，金标准里有 ${g.shadersChanged.removed} 段这次没出现` : '没有变化'}。
- 缩略图：逐级画面各一张 16 × 12 的缩略图，每块 40 × 40 像素，存 RGB 均值与粗糙度（块内绿色通道相邻像素差的平均值 × 8；均值看不出的颗粒、纸纹、笔触靠它）。均值差最大不超过 ${g.gate.maxBlockDiff} 级、平均不超过 ${g.gate.meanBlockDiff} 级（按 RGB 里最差的通道），粗糙度差最大不超过 ${g.gate.maxRoughDiff}、平均不超过 ${g.gate.meanRoughDiff}。容差是给不同显卡 / 软件渲染留的：macOS Metal 对 SwiftShader 实测均值最大差 1 级、平均不到 0.28 级，粗糙度最大差 3、平均不到 0.22；只关一道后期时至少有一项远超容差（关颗粒：粗糙度平均 5；关 Kuwahara：粗糙度最大 32；关 bloom：均值最大 24）。离散的 ID / 深度 / 边缘视图（\`${THUMB_SKIP.join('`、`')}\`）不存缩略图：物体边缘差一个像素块差就很大，ID 由下一条的编号像素数管，深度与边缘的结果落在墨线里。
- ID 图：冻结的每个编号都要在、不能多，像素数与冻结时相差不超过 ${g.gate.idArea.pixels} 个或 ${g.gate.idArea.ratio * 100}%（取大的）。本次 ${g.ids.filter(i => i.pass).length} / ${g.ids.length} 个编号对上${g.ids.some(i => !i.pass) ? `，**没对上**：${g.ids.filter(i => !i.pass).map(i => `${i.id}（冻结 ${i.frozen}、现在 ${i.now}）`).join('、')}` : ''}。

| 画面 | 均值最大差 | 均值平均差 | 粗糙度最大差 | 粗糙度平均差 | 判定 |
|---|---|---|---|---|---|
${g.frames.map(t => `| \`${t.id}\` | ${t.maxBlockDiff} 级 | ${t.meanBlockDiff} 级 | ${t.maxRoughDiff} | ${t.meanRoughDiff} | ${t.pass ? '没变' : '**变了**'} |`).join('\n')}

有意改画面时才重冻（\`--freeze <基线提交>\`），先按 \`docs/style-baselines/POLICY.md\` 审批；不是有意改的，这里变红就是回退。

## 负对照（在 r187 上故意改坏，再对 r170 金标准的整帧）

必须 < ${r.gate.negativeMaxPsnrDb} dB 才算被拦住。

| 项 | 改了什么 | PSNR | 最大单通道差 | 差 > 1 级的像素 | 差 > 5 级的像素 |
|---|---|---|---|---|---|
${r.negativeControls.map(row).join('\n')}

## 逐道消融（在 r187 上只关一道后期，再对 r170 金标准的整帧）

必须过不了门：说明这一道确实在整帧里，坏了门看得见。

| 项 | 关掉了什么 | PSNR | 最大单通道差 | 差 > 1 级的像素 | 差 > 5 级的像素 |
|---|---|---|---|---|---|
${postAbl.map(row).join('\n')}

## ID 图消融（在 r187 上只改坏 ID 图的一个分支，再对 r170 金标准的 ID 图）

必须有 ${MIN_PIXELS} 个以上的像素编号不同、或线宽 / 可见度超出容差。

| 项 | 改了什么 | 编号不同的像素 | 线宽 / 可见度超出容差的像素 | 判定 |
|---|---|---|---|---|
${idAbl.map(a => `| \`${a.id}\` | ${a.what} | ${a.idDiffCount} | ${a.widthAlphaDiffCount} | ${a.caught ? '拦住' : '**漏过**'} |`).join('\n')}

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
  const r = await runR187LookRegression();
  if (r.skipped || r.error) { console.error(r.skipped || r.error); process.exit(3); }
  const { frames, shaders, ...report } = r;
  if (dumpDir) for (const [side, set] of Object.entries(frames)) for (const [n, f] of Object.entries(set)) for (const [k, buf] of Object.entries(f)) if (k !== 'id') fs.writeFileSync(path.join(dumpDir, `${side}-${n}-${k}.rgba`), buf);
  report.notes = NOTES;
  if (opt.freeze) {
    freezeGolden(frames.golden.base, shaders, { baseline: opt.freeze, backend: `${report.platform.angle}：${report.platform.webglRendererGolden}` });
    console.error(`已用这次的 r170 结果重写冻结的金标准（基线 ${opt.freeze}）；再跑一遍不带 --freeze 的对拍`);
    process.exit(0);
  }
  if (opt.write) {
    const out = { schema: 'beiming.r187-look-regression/1', generatedBy: 'node engine/look/r187-look-regression.mjs --write', ...report };
    fs.writeFileSync(path.join(ROOT, 'docs/quality/r187-look-regression.json'), JSON.stringify(out, null, 2) + '\n');
    fs.writeFileSync(path.join(ROOT, 'docs/quality/r187-look-regression.md'), reportMarkdown(out));
  }
  if (opt.json) console.log(JSON.stringify(report, null, 2));
  else {
    const line = (tag, c) => console.log(`${tag}  ${c.id.padEnd(18)} ${String(c.psnrDb).padStart(6)} dB  max ${String(c.maxAbsDiff).padStart(3)}  >1 ${(c.fracGt1 * 100).toFixed(3)}%  >5 ${(c.fracGt5 * 100).toFixed(3)}%`);
    const idLine = (tag, c) => console.log(`${tag}  ${c.id.padEnd(18)} 编号不同 ${c.idDiffCount} 个像素，线宽 / 可见度超出容差 ${c.widthAlphaDiffCount} 个`);
    const m = report.idMap, g = report.goldenAnchor;
    idLine(m.idDiffCount === 0 && m.widthAlphaDiffCount === 0 ? '过门' : '没过', { ...m, id: 'id-map' });
    idLine(m.rebuilt.pass ? '过门' : '没过', m.rebuilt);
    for (const s of m.sides) console.log(`${s.pass ? '对上' : '没对上'}  ${s.id} 的 ID 图：缺 [${s.idsMissing}]，多 [${s.idsUnexpected}]，高段 ${s.highSegmentPixels} 像素，球 ${JSON.stringify(s.ball)}`);
    for (const c of report.cases) line(c.pass ? '过门' : '没过', c);
    console.log(`${g.shadersChanged.added + g.shadersChanged.removed ? '金标准  变了' : '金标准  没变'}  着色器源码 ${g.shaders} 段：${g.shadersChanged.added} 段不在金标准里，金标准里有 ${g.shadersChanged.removed} 段没出现`);
    for (const t of g.frames) console.log(`${t.pass ? '金标准  没变' : '金标准  变了'}  ${t.id.padEnd(18)} 缩略图：均值差最大 ${t.maxBlockDiff} / 平均 ${t.meanBlockDiff} 级（容差 ${g.gate.maxBlockDiff} / ${g.gate.meanBlockDiff}），粗糙度差最大 ${t.maxRoughDiff} / 平均 ${t.meanRoughDiff}（容差 ${g.gate.maxRoughDiff} / ${g.gate.meanRoughDiff}）`);
    for (const i of g.ids.filter(i => !i.pass)) console.log(`金标准  变了  编号 ${i.id}：冻结 ${i.frozen} 像素，现在 ${i.now}`);
    for (const c of [...report.negativeControls, ...report.ablations]) (c.idDiffCount !== undefined ? idLine : line)(c.caught ? '拦住' : '漏过', c);
    for (const w of report.consoleWarnings) console.log('告警  ' + w);
    console.log(report.overallPass ? '结论：过门' : '结论：没过门');
  }
  process.exit(report.overallPass ? 0 : 1);
}
