// 北冥引擎 · 分层风格化：把外部光追渲染器出的一帧分层图（颜色、深度、物体编号、相机空间法线）变成北冥画风的一张图。
// 光追给出物理正确的阴影与明暗，这里只做三件事：求墨线（物体编号不连续 + 深度折痕 + 法线夹角）、把连续明暗压成几档色阶（保留色相与阴影形状）、
// 叠 Kuwahara 笔触与纸纹。画面只取决于输入与 p.t（墨线按拍抖动，种子 = floor(t × boilFps)），不用随机数与时钟。
//
//   decodePng(bytes) → { width, height, channels, depth, data }   浏览器可用的 PNG 解码（8 / 16 位，灰度 / 灰度+α / RGB / RGBA，非隔行）：
//                          data 是 Uint8Array 或 Uint16Array（depth = 16 时），按像素交错。浏览器自带的图片解码会把 16 位降成 8 位，
//                          深度与物体编号必须精确，所以自己解（fetch 字节 → 解析块 → DecompressionStream('deflate') → 反滤波；
//                          反滤波的写法取自 tools/qa/lib/png.mjs）
//   loadLayers(dir, frame = 0, fetchBytes?) → { color, depth, ids, normal, depthUnit, width, height }
//                          读 <dir>/<帧号6位>.png / .depth.png / .object_index.png / .view_normal.png 与 meta.json；
//                          四张图都是 decodePng 的结果；depthUnit = meta.json frames[].depth_unit_m（每个深度单位多少米）
//   createLayerLook(renderer, w, h, opts?) → { render(layers, p), dispose() }
//     w × h 必须等于分层图尺寸。render 默认画到当前画布（p.target 给了就画进去）；画布大小建议也设成 w × h
//     （renderer.setPixelRatio(1); renderer.setSize(w, h)），否则整幅会被拉伸。
//     layers   loadLayers 的结果（同一个对象反复传不会重复上传）
//     p        {
//       t                  秒；只用于墨线按拍抖动
//       view               'final'（默认）| 'color'（原始光追）| 'ids' | 'edge'（只看墨线）| 'toon'（色阶，无墨线无纸纹）
//       split              0..1：画面左边这一段显示原始光追，右边风格化（用于对照）
//       outline            { width 2.4 线宽（像素，按 1080 高标定）  color '#1b1a22' 墨色  tint 0.35 墨色跟随本地色变深的比例
//                            wobble 1.6 抖动幅度  warp 60 抖动波长  boilFps 12 每秒抖几次  pressure 0.25 笔压起伏
//                            inner 0.55 内部线（折痕、法线）相对外轮廓的粗细  depthThreshold 0.03 折痕阈值（1/z 二阶差分）
//                            normalThreshold 0.5 法线夹角余弦低于它画线  opacity 1 }   false = 关
//       toon               { bands 3 档数  soft 0.07 档间过渡（档宽的比例）  lo 0.35 / hi 0.92 参与分档的亮度范围
//                            sky 0 天空（编号 0）的档数，0 = 不分档只留笔触 }   false = 关
//       kuwahara           { radius 3  strength 1  q 8 }   false = 关
//       paper              { strength 0.1  scale 1 }   false = 关
//     }
//
// 为什么没直接用 engine/look/ink.js：它的边缘着色器绑死了场景渲染目标（编码的编号图 + three 的深度纹理 + 雾），
// 这里的输入是 16 位整数编号与米制深度，所以只复用 HASH_NOISE 噪声、全屏 pass、Kuwahara 与纸纹，边缘与笔画着色器写成最小的一份（思路同 ink.js：
// 近的一侧拥有线、圆头笔 + 域扭曲抖动 + 笔压）。

import * as THREE from 'three';
import { HASH_NOISE } from './glsl.js';
import { createFullscreen, renderTarget } from './pass.js';
import { createKuwahara } from './kuwahara.js';
import { createPaper } from './paper.js';
import { toColor } from './params.js';

// ── PNG 解码 ──
const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CH = { 0: 1, 2: 3, 4: 2, 6: 4 };

export async function decodePng(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 8 || SIG.some((b, i) => u8[i] !== b)) throw new Error('不是 PNG 文件');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let off = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= u8.length) {
    const len = dv.getUint32(off), type = String.fromCharCode(...u8.subarray(off + 4, off + 8));
    if (type === 'IHDR') { width = dv.getUint32(off + 8); height = dv.getUint32(off + 12); depth = u8[off + 16]; ctype = u8[off + 17]; interlace = u8[off + 20]; }
    else if (type === 'IDAT') idat.push(u8.subarray(off + 8, off + 8 + len));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const channels = CH[ctype];
  if (!channels || (depth !== 8 && depth !== 16) || interlace !== 0) throw new Error(`只支持 8 / 16 位非隔行的灰度、RGB、RGBA PNG（收到颜色类型 ${ctype}、${depth} 位、隔行=${interlace}）`);
  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  idat.reduce((o, c) => (joined.set(c, o), o + c.length), 0);
  const raw = new Uint8Array(await new Response(new Blob([joined]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const bpp = channels * depth / 8, stride = width * bpp;
  if (raw.length < height * (stride + 1)) throw new Error('PNG 数据不完整');
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], line = y * (stride + 1) + 1, cur = y * stride, prev = cur - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[cur + x - bpp] : 0, b = y ? px[prev + x] : 0, c = x >= bpp && y ? px[prev + x - bpp] : 0;
      let v = raw[line + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[cur + x] = v & 255;
    }
  }
  let data = px;
  if (depth === 16) { data = new Uint16Array(width * height * channels); for (let i = 0; i < data.length; i++) data[i] = (px[2 * i] << 8) | px[2 * i + 1]; }
  return { width, height, channels, depth, data };
}

export async function loadLayers(dir, frame = 0, fetchBytes = async u => { const r = await fetch(u); if (!r.ok) throw new Error(`读不到 ${u}（HTTP ${r.status}）`); return new Uint8Array(await r.arrayBuffer()); }) {
  const base = `${String(dir).replace(/\/+$/, '')}/${String(frame).padStart(6, '0')}`;
  const [color, depth, ids, normal, metaBytes] = await Promise.all([`.png`, `.depth.png`, `.object_index.png`, `.view_normal.png`].map(s => fetchBytes(base + s).then(decodePng)).concat(fetchBytes(`${String(dir).replace(/\/+$/, '')}/meta.json`)));
  const meta = JSON.parse(new TextDecoder().decode(metaBytes));
  const fr = meta.frames?.find(f => f.index === Number(frame)) ?? meta.frames?.[0];
  if (!fr?.depth_unit_m) throw new Error(`meta.json 里找不到第 ${frame} 帧的 depth_unit_m`);
  return { color, depth, ids, normal, depthUnit: fr.depth_unit_m, width: color.width, height: color.height };
}

// ── 着色器（坐标一律是 GL 方向：上传时已把行翻过来，texelFetch(gl_FragCoord) 就是同一像素） ──
const EDGE_FS = /* glsl */`
uniform sampler2D tId, tDepth, tNormal;
uniform vec2 uRes;
uniform float uHalfW, uInner, uDepthThr, uNormThr, uOpacity;
float gid(ivec2 p){ return texelFetch(tId, p, 0).x; }
float gz(ivec2 p){ return texelFetch(tDepth, p, 0).x; }
vec3 gn(ivec2 p){ return texelFetch(tNormal, p, 0).xyz * 2. - 1.; }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy), mx = ivec2(uRes) - 1;
  float id0 = gid(p), z0 = gz(p), iz0 = 1. / z0;
  vec3 n0 = gn(p);
  bool outline = false, inner = false;
  ivec2 N4[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
  for (int k = 0; k < 4; k++) {
    ivec2 q = clamp(p + N4[k], ivec2(0), mx);
    float idq = gid(q);
    if (idq != id0) {
      float zq = gz(q), rel = (zq - z0) / z0;
      // 近的一侧拥有这条线；深度几乎一样时固定让编号大的一侧画
      if (rel > .002 || (rel > -.002 && id0 > idq)) outline = true;
    } else if (id0 > .5 && dot(n0, gn(q)) < uNormThr) inner = true;
  }
  if (id0 > .5) {
    // 折痕：1/z 的二阶差分（平面上恒为 0），只在近的一侧出线
    ivec2 AX[4] = ivec2[4](ivec2(1, 0), ivec2(0, 1), ivec2(1, 1), ivec2(1, -1));
    for (int k = 0; k < 4; k++) {
      float zp = gz(clamp(p + AX[k], ivec2(0), mx)), zm = gz(clamp(p - AX[k], ivec2(0), mx));
      if ((1. / zp + 1. / zm - 2. * iz0) / iz0 < -uDepthThr) inner = true;
    }
  }
  if (!outline && !inner) { gl_FragColor = vec4(0.); return; }
  gl_FragColor = vec4(uOpacity, uHalfW * (outline ? 1. : uInner), 0., 1.);
}`;

// 笔画：以边缘像素为圆心画圆头笔，查找坐标做低频域扭曲（抖动）；SR 是搜索半径（编译期常量）
const STROKE_FS = /* glsl */`
${HASH_NOISE}
uniform sampler2D tEdge;
uniform vec2 uRes;
uniform float uWobble, uWarp, uPressure, uSeed;
void main(){
  vec2 c = gl_FragCoord.xy;
  uint sd = uint(uSeed) * 7919u + 13u;
  vec2 a = c / uWarp, b = c / (uWarp * .31);
  vec2 q = c + (vec2(vnoise(a, sd), vnoise(a + 31.7, sd + 1u)) * 2. - 1.) * uWobble
            + (vec2(vnoise(b, sd + 2u), vnoise(b + 13.1, sd + 3u)) * 2. - 1.) * uWobble * .3;
  float pr = 1. + uPressure * (vnoise(q / (uWarp * .45), sd + 5u) * 2. - 1.);
  ivec2 b0 = ivec2(floor(q)), mx = ivec2(uRes) - 1;
  float cov = 0.;
  for (int j = -SR; j <= SR; j++) for (int i = -SR; i <= SR; i++) {
    ivec2 e = b0 + ivec2(i, j);
    if (any(lessThan(e, ivec2(0))) || any(greaterThan(e, mx))) continue;
    vec4 E = texelFetch(tEdge, e, 0);
    if (E.x <= 0.) continue;
    cov = max(cov, clamp(E.y * pr + .5 - length(q - (vec2(e) + .5)), 0., 1.) * E.x);
  }
  gl_FragColor = vec4(cov, 0., 0., 1.);
}`;

const FINAL_FS = /* glsl */`
${HASH_NOISE}
uniform sampler2D tColor, tKuwa, tLine, tId, tPaper;
uniform vec2 uRes, uPaperSize;
uniform vec3 uInk;
uniform float uView, uSplit, uTint, uPaper, uPaperMid, uBands, uSkyBands, uSoft, uLo, uHi;
float lum(vec3 c){ return dot(c, vec3(.2126, .7152, .0722)); }
float quant(float L, float n){
  float s = clamp((L - uLo) / (uHi - uLo), 0., 1.) * n;
  float bnd = floor(s + .5), d = s - bnd;
  float lower = clamp(bnd - 1., 0., n - 1.), upper = clamp(bnd, 0., n - 1.);
  float xq = mix((lower + .5) / n, (upper + .5) / n, smoothstep(-uSoft, uSoft, d));
  return mix(uLo, uHi, xq);
}
vec3 toon(vec3 c, float id){
  float n = id < .5 ? uSkyBands : uBands;
  if (n < 1.5) return c;
  float L = lum(c);
  return L < .002 ? c : clamp(c * (quant(L, n) / L), 0., 1.);
}
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 raw = texelFetch(tColor, p, 0).rgb;
  float id = texelFetch(tId, p, 0).x, cov = texelFetch(tLine, p, 0).x;
  vec3 c = toon(texelFetch(tKuwa, p, 0).rgb, id), o;
  if (uView == 1.) o = raw;
  else if (uView == 2.) o = id < .5 ? vec3(1.) : vec3(h21(ivec2(int(id), 1), 7u), h21(ivec2(int(id), 2), 7u), h21(ivec2(int(id), 3), 7u)) * .8 + .1;
  else if (uView == 3.) o = mix(vec3(.96, .94, .9), uInk, cov);
  else if (uView == 4.) o = c;
  else {
    if (uPaper > 0.) c *= 1. + uPaper * 2. * (texture2D(tPaper, gl_FragCoord.xy / uPaperSize).r - uPaperMid);
    o = mix(c, mix(uInk, c * .25, uTint), cov);
  }
  if (gl_FragCoord.x < uSplit * uRes.x) o = raw;
  gl_FragColor = vec4(o, 1.);
}`;

const D_OUT = { width: 2.4, color: '#1b1a22', tint: .35, wobble: 1.6, warp: 60, boilFps: 12, pressure: .25, inner: .55, depthThreshold: .03, normalThreshold: .5, opacity: 1 };
const D_TOON = { bands: 3, soft: .07, lo: .35, hi: .92, sky: 0 };
const D_KUWA = { radius: 3, strength: 1, q: 8 };
const D_PAPER = { strength: .1, scale: 1 };
const VIEWS = { final: 0, color: 1, ids: 2, edge: 3, toon: 4 };
const opt = (v, d) => (v === false ? null : { ...d, ...(v === true || v == null ? {} : v) });

export function createLayerLook(renderer, w, h, o = {}) {
  const fx = createFullscreen(renderer), kuwa = createKuwahara(fx), paper = createPaper(fx, renderer, { url: o.paperUrl ?? null });
  paper.resize(w, h);
  const T = { edge: renderTarget(w, h, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }), line: renderTarget(w, h), kuwa: renderTarget(w, h) };
  const edgeMat = fx.material(EDGE_FS, { tId: { value: null }, tDepth: { value: null }, tNormal: { value: null }, uRes: { value: new THREE.Vector2(w, h) }, uHalfW: { value: 1 }, uInner: { value: .5 }, uDepthThr: { value: .03 }, uNormThr: { value: .5 }, uOpacity: { value: 1 } });
  const strokes = new Map();
  const strokeMat = R => {
    if (!strokes.has(R)) strokes.set(R, fx.material(STROKE_FS, { tEdge: { value: null }, uRes: { value: new THREE.Vector2(w, h) }, uWobble: { value: 0 }, uWarp: { value: 60 }, uPressure: { value: 0 }, uSeed: { value: 0 } }, { SR: R }));
    return strokes.get(R);
  };
  const finalMat = fx.material(FINAL_FS, { tColor: { value: null }, tKuwa: { value: null }, tLine: { value: null }, tId: { value: null }, tPaper: { value: null }, uRes: { value: new THREE.Vector2(w, h) }, uPaperSize: { value: new THREE.Vector2(1, 1) }, uInk: { value: new THREE.Vector3() },
    uView: { value: 0 }, uSplit: { value: 0 }, uTint: { value: 0 }, uPaper: { value: 0 }, uPaperMid: { value: .5 }, uBands: { value: 3 }, uSkyBands: { value: 0 }, uSoft: { value: .07 }, uLo: { value: .35 }, uHi: { value: .92 } });
  const noKuwa = { radius: 2, strength: 0, q: 8 }, cam = { near: .1, far: 100 };

  let tex = null, src = null;
  const upload = L => {
    if (L.width !== w || L.height !== h) throw new Error(`分层图 ${L.width}×${L.height} 与 createLayerLook 的 ${w}×${h} 不符`);
    tex?.forEach(t => t.dispose());
    const n = w * h;
    const mk = (data, fmt, type) => { const t = new THREE.DataTexture(data, w, h, fmt, type); t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true; return t; };
    const flip = (get, ch, Arr) => { const out = new Arr(n * ch); for (let y = 0; y < h; y++) { const so = (h - 1 - y) * w, dstRow = y * w; for (let x = 0; x < w; x++) for (let c = 0; c < ch; c++) out[(dstRow + x) * ch + c] = get(so + x, c); } return out; };
    const rgba = (img, alpha) => flip((i, c) => (c === 3 ? alpha : img.data[i * img.channels + Math.min(c, img.channels - 1)]), 4, Uint8Array);
    const cT = mk(rgba(L.color, 0), THREE.RGBAFormat, THREE.UnsignedByteType);   // alpha 0 = Kuwahara 不保护
    cT.minFilter = cT.magFilter = THREE.LinearFilter;
    tex = [cT,
      mk(flip(i => L.depth.data[i] * L.depthUnit, 1, Float32Array), THREE.RedFormat, THREE.FloatType),
      mk(flip(i => L.ids.data[i], 1, Float32Array), THREE.RedFormat, THREE.FloatType),
      mk(rgba(L.normal, 255), THREE.RGBAFormat, THREE.UnsignedByteType)];
    src = L;
  };

  function render(L, p = {}) {
    if (src !== L) upload(L);
    const [tC, tD, tI, tN] = tex, k = h / 1080;
    const OL = opt(p.outline, D_OUT), TN = opt(p.toon, D_TOON), KU = opt(p.kuwahara, D_KUWA), PA = opt(p.paper, D_PAPER);
    const prevRT = renderer.getRenderTarget();
    paper.prepare();
    kuwa.render({ src: tC, depth: tD, camera: cam, p: KU ?? noKuwa, k, w, h }, T.kuwa);
    if (OL) {
      const e = edgeMat.uniforms;
      e.tId.value = tI; e.tDepth.value = tD; e.tNormal.value = tN;
      e.uHalfW.value = OL.width * .5 * k; e.uInner.value = OL.inner; e.uDepthThr.value = OL.depthThreshold; e.uNormThr.value = OL.normalThreshold; e.uOpacity.value = OL.opacity;
      fx.draw(edgeMat, T.edge);
      const R = Math.max(2, Math.ceil(OL.width * .5 * k * (1 + OL.pressure) + 1));
      const s = strokeMat(R).uniforms;
      s.tEdge.value = T.edge.texture; s.uWobble.value = OL.wobble * k; s.uWarp.value = OL.warp * k; s.uPressure.value = OL.pressure;
      s.uSeed.value = Math.floor((p.t ?? 0) * OL.boilFps + 1e-6) % 100000;
      fx.draw(strokeMat(R), T.line);
    } else renderer.setRenderTarget(T.line), renderer.setClearColor(0, 1), renderer.clear(true, false, false);
    const f = finalMat.uniforms, pl = PA ? paper.layer(PA, Math.max(1, Math.round(k)), k) : null;
    f.tColor.value = tC; f.tKuwa.value = T.kuwa.texture; f.tLine.value = T.line.texture; f.tId.value = tI;
    f.uInk.value.set(...toColor(OL?.color ?? D_OUT.color).toArray());
    f.uTint.value = OL?.tint ?? 0; f.uView.value = VIEWS[p.view ?? 'final'] ?? 0; f.uSplit.value = p.split ?? 0;
    f.uPaper.value = pl?.strength ?? 0; f.uPaperMid.value = pl?.mid ?? .5; f.tPaper.value = pl?.tex ?? tC; f.uPaperSize.value.set(pl?.w ?? 1, pl?.h ?? 1);
    f.uBands.value = TN?.bands ?? 0; f.uSkyBands.value = TN?.sky ?? 0; f.uSoft.value = TN?.soft ?? .07; f.uLo.value = TN?.lo ?? .35; f.uHi.value = TN?.hi ?? .92;
    fx.draw(finalMat, p.target ?? null);
    renderer.setRenderTarget(prevRT);
  }

  return {
    render,
    dispose() {
      tex?.forEach(t => t.dispose());
      Object.values(T).forEach(t => t.dispose());
      [edgeMat, finalMat, ...strokes.values()].forEach(m => m.dispose());
      kuwa.dispose(); paper.dispose(); fx.dispose();
    },
  };
}
