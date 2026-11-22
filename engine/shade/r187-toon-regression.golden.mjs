// 北冥引擎 · 卡通着色回归的冻结 r170 金标准：不随待测的 engine/shade 重生的那一份参照（Node 侧，回归夹具，不是 engine 的公开模块）。
// 对拍执行器两边跑的是同一份 engine/shade，两版一起漂移时自比照样全等；这里把改动前（基线提交）的 r170 结果存进
// r187-toon-regression.golden.json，每次对拍都拿当前代码去比它：
//   shaders   4 族材质 × 4 组参数，各取卡通 / 阴影深度材质在 r170 下 onBeforeCompile 之后的顶点与片元源码（共 64 段）与 uniform 初值，存 SHA-256
//   thumbs    标定场景 r170 彩色帧四个子区的 16 × 12 块均值缩略图（每块 20 × 20 像素的 RGB 均值）；分档线、投影、表面层挪了位置，块均值跟着变
// 缩略图比对留容差（不同显卡 / 软件渲染在投影与物体边缘上差几个像素）；着色器摘要是逐字节的，画面上看不出的改动也拦。
//
//   shaderDigests() → { '族/参数': { shaders, uniforms } }   只能在 r170 下算（Node 里的 three 就是 r170）；uniform 浮点初值先收到单精度
//   thumb(rgba, width, { x, y }) → Uint8Array   一个子区（QW × QH，左下角在 x / y）的缩略图
//   thumbDiff(a, b) → { maxBlockDiff, meanBlockDiff, pass }   块均值差（级）的最大值与平均值；pass = 两个都不超过 THUMB_GATE
//   checkGolden(rgba, width) → { baseline, backend, shaders, shadersChanged, gate, regions: [{ id, maxBlockDiff, meanBlockDiff, pass }], pass }
//   freezeGolden(rgba, width, { baseline, backend })   重写 golden.json。只在有意改画面、按 docs/style-baselines/POLICY.md 审批之后才重冻
import fs from 'node:fs';
import { Buffer } from 'node:buffer';   // eslint 把 engine/ 下的 .mjs 当浏览器端，Node 全局显式导入
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { toonKind } from './toon.js';
import { patchLayer, paintLayer, muralLayer } from './surface.js';
import { QW, QH, REGIONS } from './r187-toon-regression.scene.mjs';

const FILE = new URL('./r187-toon-regression.golden.json', import.meta.url);
const TW = 16, TH = 12;
// 容差按实测定：同一份代码换后端（macOS Metal 对 SwiftShader）四个子区最大 1 / 2 / 6 / 1 级、平均 0.05 到 0.08 级（差在投影边缘）；
// 分档阈值 step1 整体挪 0.08 时最大 8 到 48 级、平均 0.26 到 1.5 级。平均值管整片漂移，最大值管局部大改
export const THUMB_GATE = { maxBlockDiff: 12, meanBlockDiff: 0.15 };

const FAMILIES = {
  plain: () => toonKind({ name: 'g-plain' }),
  layers: () => toonKind({ name: 'g-layers', layers: [patchLayer(), muralLayer] }),
  'tint-rim-sky': () => toonKind({ name: 'g-tint', rimCore: true, skyStepUniform: true, layers: [patchLayer({ rust: 'tint', core: false, algaeK: 0.6 })] }),
  custom: () => toonKind({ name: 'g-custom', featherMin: 0.03, bandAA: 2, layers: [paintLayer],
    pars: 'uniform float uG;\n', glsl: 'float gF( float x ) { return x * uG; }\n', uniforms: o => ({ uG: { value: o.g ?? 0.5 } }), vars: 'float gV = 0.0;\n',
    shade: { rimNormal: 'normalize( N + vec3( 0.0, 0.1, 0.0 ) )', bands: 'm1 = gF( m1 );', skyMask: ' * 0.9', afterSky: 'col *= 1.0;', flatMask: ' * 0.8', afterFill: 'col += 0.0;',
      rimScale: ' * 0.7', rimLitColor: 'uRimColor', afterRim: 'col = col.rgb;', final: 'col = clamp( col, 0.0, 1.0 );', passPre: 'toonId = fract( toonId + gV );', passNormal: 'normalize( normal )' } }),
};
const PARAMS = {
  default: {},
  rest: { rest: true, color: '#c8553d', shade1: '#7a2f45', shade2: '#3a1d40', rimColor2: '#ffffff', rimLitColor2: '#fff2c0', rimLitAmt: 0.9, fillAmt: 0.8, skyAmt: 0.7, side: THREE.DoubleSide },
  'noid-translucent': { noId: true, translucent: true, instanceId: false, outlineW: 0.5 },
  hooks: { vertexPars: 'uniform float uBend;\n', vertexMainStart: 'float gT = 0.0;\n', vertexBegin: 'transformed.x += uBend * position.y;\n', vertexNormal: 'objectNormal = normalize( objectNormal );\n',
    fragmentPars: 'uniform float uTone;\n', fragmentBase: 'diffuseColor.rgb *= uTone;\n', fragmentAlbedo: 'toonInk = 0.1;\n', fragmentNormal: 'normal = normalize( normal );\n',
    uniforms: { uBend: { value: 1.3 }, uTone: { value: 0.9 } }, defines: { G_HOOK: 1 } },
};
const sha = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
// uniform 是按单精度传给 WebGL 的；float64 末位随 V8 版本漂（Color 的 sRGB 转线性走 Math.pow，Node 22 / 24 差 1 ULP），先收到单精度再算摘要
const f32 = (v, drift) => Array.isArray(v) ? v.map(x => f32(x, drift)) : Number.isFinite(v) ? Math.fround(drift(v)) : v;   // -0 由 JSON.stringify 写成 0
const compiled = (mat, lib) => { const sh = { uniforms: {}, defines: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader }; mat.onBeforeCompile(sh); return sh; };

export function shaderDigests(drift = x => x) {   // drift 只给测试用：算摘要前先扰动每个 uniform 浮点初值
  if (THREE.REVISION !== '170') throw new Error(`冻结的金标准是 r170 的：这里的 three 是 r${THREE.REVISION}`);
  const out = {};
  for (const [f, kind] of Object.entries(FAMILIES)) for (const [p, opts] of Object.entries(PARAMS)) {
    const k = kind(), mat = k.make(opts), depth = k.depth(mat);
    const toon = compiled(mat, THREE.ShaderLib.toon), dep = compiled(depth, THREE.ShaderLib.depth);
    const values = Object.keys(toon.uniforms).sort().map(n => { const v = toon.uniforms[n].value; return [n, f32(v?.toArray ? v.toArray() : v, drift)]; });
    out[`${f}/${p}`] = {
      shaders: sha([toon.vertexShader, toon.fragmentShader, toon.defines, dep.vertexShader, dep.fragmentShader, dep.defines]),
      uniforms: sha([values, mat.side, mat.transparent, mat.depthWrite, depth.side]),
    };
  }
  return out;
}

export function thumb(rgba, width, { x, y }) {
  const bw = QW / TW, bh = QH / TH, out = new Uint8Array(TW * TH * 3);
  for (let by = 0; by < TH; by++) for (let bx = 0; bx < TW; bx++) for (let c = 0; c < 3; c++) {
    let sum = 0;
    for (let py = 0; py < bh; py++) for (let px = 0; px < bw; px++) sum += rgba[((y + by * bh + py) * width + x + bx * bw + px) * 4 + c];
    out[(by * TW + bx) * 3 + c] = Math.round(sum / (bw * bh));
  }
  return out;
}
export function thumbDiff(a, b) {
  let max = a.length === b.length ? 0 : 255, sum = 0;   // 长度不对（没冻结过、文件坏了）= 全变了
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - (b[i] ?? 255)); sum += d; if (d > max) max = d; }
  const meanBlockDiff = Math.ceil(1000 * sum / a.length) / 1000;
  return { maxBlockDiff: max, meanBlockDiff, pass: max <= THUMB_GATE.maxBlockDiff && meanBlockDiff <= THUMB_GATE.meanBlockDiff };
}

export function checkGolden(rgba, width) {
  const frozen = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : { shaders: {}, thumbs: {} }, now = shaderDigests();   // 还没冻结过 = 全部算变了
  const keys = [...new Set([...Object.keys(frozen.shaders), ...Object.keys(now)])];
  const shadersChanged = keys.flatMap(k => ['shaders', 'uniforms'].filter(w => frozen.shaders[k]?.[w] !== now[k]?.[w]).map(w => `${k}：${w === 'shaders' ? '着色器源码' : 'uniform 初值'}`));
  const regions = REGIONS.map(r => ({ id: r.id, ...thumbDiff(thumb(rgba, width, r), Buffer.from(frozen.thumbs[r.id] ?? '', 'base64')) }));
  return { baseline: frozen.baseline, backend: frozen.backend, shaders: keys.length * 4, shadersChanged, gate: THUMB_GATE, regions, pass: shadersChanged.length === 0 && regions.every(r => r.pass) };
}

export function freezeGolden(rgba, width, { baseline, backend }) {
  const thumbs = Object.fromEntries(REGIONS.map(r => [r.id, Buffer.from(thumb(rgba, width, r)).toString('base64')]));
  fs.writeFileSync(FILE, JSON.stringify({ schema: 'beiming.r187-toon-golden/1', baseline, three: THREE.REVISION, backend, thumb: { width: TW, height: TH }, shaders: shaderDigests(), thumbs }, null, 2) + '\n');
}
