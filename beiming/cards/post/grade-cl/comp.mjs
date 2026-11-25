// post.grade-cl 纯 CPU 终混调色与显示变换实现（与 three.js WebGL2 着色器数学逐项等价）。
// 流程：径向 kick/可选冲击波扭曲 -> 径向色差采样 -> 可选径向拖影 -> 混合 Bloom/God/Shaft/Flash
// -> 曝光与暗角 -> ACES RRT/ODT 拟合 -> 饱和度 -> 冷暖分离色调 -> S 型反差 -> 伽马 -> 8 位抖动/颗粒 -> Fade。

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const fract = (x) => x - Math.floor(x);

export const DEFAULT_GRADE_PARAMS = Object.freeze({
  exposure: 1.0,
  bloom: 0.06,
  god: 0.55,
  shaftColor: [0, 0, 0],
  caBase: 0.006,
  vignette: 0.42,
  flash: 0,
  fade: 1,
  shake: 0,
  kick: 0,
  fringe: 0,
  ring: [0.5, 0.5, 0, 0],
  ringShape: [1, 1, 0, 0.05],
  useLensFx: null,
  saturation: 1.06,
  shadowTint: [-0.002, 0.003, 0.012],
  highlightTint: [0.014, 0.006, -0.010],
  contrast: 0.44,
  gamma: 2.2,
  grain: 0.018,
  ditherMode: 'hash',
  time: 0,
  origin: 'top-left',
});

/** ACES RRT+ODT 拟合（输入线性 Rec.709 RGB，输出 [0, 1] 色调映射结果） */
export function acesFit(rgb) {
  const r = rgb[0] / 0.6;
  const g = rgb[1] / 0.6;
  const b = rgb[2] / 0.6;

  // 输入矩阵（与 GLSL 列主序 mat3 右乘等价）
  const vr = 0.59719 * r + 0.35458 * g + 0.04823 * b;
  const vg = 0.07600 * r + 0.90834 * g + 0.01566 * b;
  const vb = 0.02840 * r + 0.13383 * g + 0.83777 * b;

  // RRTAndODTFit
  const fr = (vr * (vr + 0.0245786) - 0.000090537) / (vr * (0.983729 * vr + 0.4329510) + 0.238081);
  const fg = (vg * (vg + 0.0245786) - 0.000090537) / (vg * (0.983729 * vg + 0.4329510) + 0.238081);
  const fb = (vb * (vb + 0.0245786) - 0.000090537) / (vb * (0.983729 * vb + 0.4329510) + 0.238081);

  // 输出矩阵
  const or = 1.60475 * fr - 0.53108 * fg - 0.07367 * fb;
  const og = -0.10208 * fr + 1.10813 * fg - 0.00605 * fb;
  const ob = -0.00327 * fr - 0.07276 * fg + 1.07602 * fb;

  return [clamp01(or), clamp01(og), clamp01(ob)];
}

/** 标量版抖动/颗粒噪声：支持屏幕哈希噪声（默认）或三角 TPDF 蓝/交错梯度抖动 */
export function ditherSample(fx, fy, time, mode, amp) {
  if (!amp || mode === 'none') return 0;
  if (mode === 'triangular') {
    const tShift = fract(time) * 19.37;
    const g1 = fract(52.9829189 * fract(0.06711056 * (fx + tShift) + 0.00583715 * (fy + tShift)));
    const g2 = fract(52.9829189 * fract(0.06711056 * (fx + 17.0 + tShift) + 0.00583715 * (fy + 31.0 + tShift)));
    return (g1 - g2) * amp;
  }
  // hash 模式：使用单精度浮点近似 GLSL highp float 的 sin(dot(...))
  const shift = fract(time) * 91.7;
  const dp = (fx + shift) * 12.9898 + (fy + shift) * 78.233;
  const n = fract(Math.sin(dp) * 43758.5453);
  return (n - 0.5) * amp;
}

/** 单像素线性 HDR -> 显示空间 [0, 1] 调色核心（不含空间采样） */
export function gradePixel(rgb, params = {}, uv = [0.5, 0.5], fragCoord = [0.5, 0.5]) {
  const p = { ...DEFAULT_GRADE_PARAMS, ...params };
  const qx = uv[0] - 0.5;
  const qy = uv[1] - 0.5;
  const r2 = qx * qx + qy * qy;
  const vig = 1.0 - p.vignette * smoothstep(0.10, 0.75, r2 * 1.25);
  const scale = p.exposure * vig;

  let r = Math.max(0, rgb[0]) * scale;
  let g = Math.max(0, rgb[1]) * scale;
  let b = Math.max(0, rgb[2]) * scale;

  // ACES 拟合
  const inv06 = 1 / 0.6;
  const sr = r * inv06, sg = g * inv06, sb = b * inv06;
  const vr = 0.59719 * sr + 0.35458 * sg + 0.04823 * sb;
  const vg = 0.07600 * sr + 0.90834 * sg + 0.01566 * sb;
  const vb = 0.02840 * sr + 0.13383 * sg + 0.83777 * sb;
  const fr = (vr * (vr + 0.0245786) - 0.000090537) / (vr * (0.983729 * vr + 0.4329510) + 0.238081);
  const fg = (vg * (vg + 0.0245786) - 0.000090537) / (vg * (0.983729 * vg + 0.4329510) + 0.238081);
  const fb = (vb * (vb + 0.0245786) - 0.000090537) / (vb * (0.983729 * vb + 0.4329510) + 0.238081);
  r = clamp01(1.60475 * fr - 0.53108 * fg - 0.07367 * fb);
  g = clamp01(-0.10208 * fr + 1.10813 * fg - 0.00605 * fb);
  b = clamp01(-0.00327 * fr - 0.07276 * fg + 1.07602 * fb);

  // 饱和度 + 分离色调
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const sat = p.saturation;
  const invL = 1.0 - l;
  const sh = p.shadowTint;
  const hi = p.highlightTint;
  r = l + (r - l) * sat + sh[0] * invL + hi[0] * l;
  g = l + (g - l) * sat + sh[1] * invL + hi[1] * l;
  b = l + (b - l) * sat + sh[2] * invL + hi[2] * l;

  // 打印 S 曲线反差
  const k = p.contrast;
  r += (r * r * (3 - 2 * r) - r) * k;
  g += (g * g * (3 - 2 * g) - g) * k;
  b += (b * b * (3 - 2 * b) - b) * k;

  // 伽马显示变换
  const invG = 1.0 / p.gamma;
  r = r > 0 ? Math.pow(r, invG) : 0;
  g = g > 0 ? Math.pow(g, invG) : 0;
  b = b > 0 ? Math.pow(b, invG) : 0;

  // 抖动/颗粒 + Fade
  const n = ditherSample(fragCoord[0], fragCoord[1], p.time, p.ditherMode, p.grain);
  const fade = p.fade;
  return [
    clamp01((r + n) * fade),
    clamp01((g + n) * fade),
    clamp01((b + n) * fade),
  ];
}

function normalizeLayer(layer, fallbackW, fallbackH) {
  if (!layer) return null;
  if (layer instanceof Float32Array || layer instanceof Float64Array) {
    const ch = layer.length / (fallbackW * fallbackH);
    if (ch !== 1 && ch !== 3 && ch !== 4) {
      throw Object.assign(new RangeError(`post.grade-cl 层数据长度 ${layer.length} 与 ${fallbackW}x${fallbackH} 不符`), { code: 'usage.bad-argument' });
    }
    return { data: layer, width: fallbackW, height: fallbackH, channels: ch };
  }
  if (typeof layer === 'object' && layer.data && layer.width > 0 && layer.height > 0) {
    const ch = layer.channels ?? (layer.data.length / (layer.width * layer.height));
    return { data: layer.data, width: layer.width, height: layer.height, channels: ch };
  }
  throw Object.assign(new TypeError('post.grade-cl 无效图层输入'), { code: 'usage.bad-argument' });
}

/** ClampToEdge 双线性采样（UV 原点在左下角，与 WebGL texture2D 一致；topDown 标记决定内存行 0 是顶部还是底部） */
function sampleChannel(layer, u, v, chIdx, topDown) {
  const { data, width, height, channels } = layer;
  const uc = u < 0 ? 0 : u > 1 ? 1 : u;
  const vc = v < 0 ? 0 : v > 1 ? 1 : v;
  let fx = uc * width - 0.5;
  let fy = (topDown ? (1 - vc) : vc) * height - 0.5;
  if (fx < 0) fx = 0; else if (fx > width - 1) fx = width - 1;
  if (fy < 0) fy = 0; else if (fy > height - 1) fy = height - 1;
  const x0 = fx | 0;
  const y0 = fy | 0;
  const x1 = x0 + 1 < width ? x0 + 1 : x0;
  const y1 = y0 + 1 < height ? y0 + 1 : y0;
  const tx = fx - x0;
  const ty = fy - y0;
  const i00 = (y0 * width + x0) * channels + chIdx;
  const i10 = (y0 * width + x1) * channels + chIdx;
  const i01 = (y1 * width + x0) * channels + chIdx;
  const i11 = (y1 * width + x1) * channels + chIdx;
  const top = data[i00] + (data[i10] - data[i00]) * tx;
  const bot = data[i01] + (data[i11] - data[i01]) * tx;
  return top + (bot - top) * ty;
}

function sampleRGB(layer, u, v, topDown, out) {
  const { data, width, height, channels } = layer;
  const uc = u < 0 ? 0 : u > 1 ? 1 : u;
  const vc = v < 0 ? 0 : v > 1 ? 1 : v;
  let fx = uc * width - 0.5;
  let fy = (topDown ? (1 - vc) : vc) * height - 0.5;
  if (fx < 0) fx = 0; else if (fx > width - 1) fx = width - 1;
  if (fy < 0) fy = 0; else if (fy > height - 1) fy = height - 1;
  const x0 = fx | 0;
  const y0 = fy | 0;
  const x1 = x0 + 1 < width ? x0 + 1 : x0;
  const y1 = y0 + 1 < height ? y0 + 1 : y0;
  const tx = fx - x0;
  const ty = fy - y0;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  const i00 = (y0 * width + x0) * channels;
  const i10 = (y0 * width + x1) * channels;
  const i01 = (y1 * width + x0) * channels;
  const i11 = (y1 * width + x1) * channels;
  if (channels === 1) {
    const val = data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11;
    out[0] = val; out[1] = val; out[2] = val;
    return;
  }
  out[0] = data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11;
  out[1] = data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11;
  out[2] = data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11;
}

/**
 * 纯 CPU 终混求值入口：将线性 HDR 主色 + 可选 Bloom / God / Shaft 合成为 8 位显示 RGBA。
 * @param {{ color: Float32Array|object, bloom?: Float32Array|object, god?: Float32Array|object, shaft?: Float32Array|object }} inputs
 * @param {object} params
 * @param {[number, number]} size
 * @returns {Uint8ClampedArray}
 */
export function evaluate(inputs, params = {}, size) {
  const [w, h] = size;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw Object.assign(new RangeError('post.grade-cl 需要正整数宽高 size=[w, h]'), { code: 'usage.bad-argument' });
  }
  const colorL = normalizeLayer(inputs?.color, w, h);
  if (!colorL) throw Object.assign(new TypeError('post.grade-cl 缺少 inputs.color'), { code: 'usage.bad-argument' });
  const bloomL = normalizeLayer(inputs.bloom, w, h);
  const godL = normalizeLayer(inputs.god, w, h);
  const shaftL = normalizeLayer(inputs.shaft, w, h);

  const p = { ...DEFAULT_GRADE_PARAMS, ...params };
  const topDown = p.origin !== 'bottom-left';
  const out = new Uint8ClampedArray(w * h * 4);

  const exposure = p.exposure;
  const bloomMix = p.bloom;
  const godGain = godL ? p.god : 0;
  const shaftC0 = shaftL ? (p.shaftColor?.[0] ?? 0) : 0;
  const shaftC1 = shaftL ? (p.shaftColor?.[1] ?? 0) : 0;
  const shaftC2 = shaftL ? (p.shaftColor?.[2] ?? 0) : 0;
  const hasShaft = shaftL !== null && (shaftC0 !== 0 || shaftC1 !== 0 || shaftC2 !== 0);
  const flash = p.flash;
  const fade = p.fade;
  const vigK = p.vignette;
  const caBase = p.caBase;
  const shake = p.shake;
  const kick = p.kick;
  const fringe = p.fringe;
  const ring = p.ring ?? [0.5, 0.5, 0, 0];
  const ringS = p.ringShape ?? [1, 1, 0, 0.05];
  const rx = ring[0], ry = ring[1], rRad = ring[2], rStr = ring[3];
  const rSq = Math.max(ringS[0], 1e-4), rCos = ringS[1], rSin = ringS[2], rWid = Math.max(ringS[3], 1e-4);
  const fx2 = p.useLensFx !== null && p.useLensFx !== undefined
    ? Boolean(p.useLensFx)
    : (fringe > 0 || rStr > 0 || kick > 1e-4 || shake > 0.075);

  const caK = fx2
    ? (caBase + Math.min(shake * 0.02, 0.0015) + 0.004 * fringe)
    : (caBase + Math.min(shake * 0.02 + kick * 0.012, 0.010));
  const smearActive = fx2 && kick > 0.2;
  const smearK = smearActive ? Math.min(kick - 0.2, 1.4) * 0.020 : 0;

  const sat = p.saturation;
  const sh0 = p.shadowTint[0], sh1 = p.shadowTint[1], sh2 = p.shadowTint[2];
  const hi0 = p.highlightTint[0], hi1 = p.highlightTint[1], hi2 = p.highlightTint[2];
  const contrast = p.contrast;
  const invGamma = 1.0 / p.gamma;
  const grain = p.grain;
  const ditherMode = p.ditherMode;
  const time = p.time;
  const shiftHash = fract(time) * 91.7;
  const shiftTri = fract(time) * 19.37;
  const asp = w / h;
  const stx = 4.0 / w;
  const sty = 4.0 / h;
  const inv06 = 1.0 / 0.6;

  const tmpB = [0, 0, 0];
  const tmpG = [0, 0, 0];
  const tmpS = [0, 0, 0];

  for (let row = 0; row < h; row++) {
    const v0 = topDown ? (h - 0.5 - row) / h : (row + 0.5) / h;
    const fragY = topDown ? (h - 0.5 - row) : (row + 0.5);
    const qy = v0 - 0.5;
    const qy2 = qy * qy;

    for (let col = 0; col < w; col++) {
      const u0 = (col + 0.5) / w;
      const fragX = col + 0.5;
      const qx = u0 - 0.5;
      const r2 = qx * qx + qy2;

      let u = u0 - qx * (r2 * kick * 0.20);
      let v = v0 - qy * (r2 * kick * 0.20);

      if (fx2 && rStr > 0) {
        const dx = (u0 - rx) * asp;
        const dy = v0 - ry;
        const ex = (dx * rCos + dy * rSin) / rSq;
        const ey = -dx * rSin + dy * rCos;
        const rr = Math.hypot(ex, ey);
        const xVal = (rr - rRad) / rWid;
        const face = Math.abs(ex) / Math.max(rr, 1e-4);
        const dl = Math.max(Math.hypot(dx, dy), 1e-4);
        const mag = xVal * Math.exp(-xVal * xVal) * rStr * (0.25 + 0.75 * face);
        u -= (dx / dl / asp) * mag;
        v -= (dy / dl) * mag;
      }

      const cax = qx * r2 * caK;
      const cay = qy * r2 * caK;
      let cr, cg, cb;
      if (cax === 0 && cay === 0) {
        sampleRGB(colorL, u, v, topDown, tmpS);
        cr = tmpS[0]; cg = tmpS[1]; cb = tmpS[2];
      } else {
        cr = sampleChannel(colorL, u - cax, v - cay, 0, topDown);
        cg = sampleChannel(colorL, u, v, colorL.channels > 1 ? 1 : 0, topDown);
        cb = sampleChannel(colorL, u + cax, v + cay, colorL.channels > 2 ? 2 : 0, topDown);
      }

      if (smearActive) {
        const rbx = qx * r2 * smearK;
        const rby = qy * r2 * smearK;
        sampleRGB(colorL, u - rbx, v - rby, topDown, tmpS);
        const s1r = tmpS[0], s1g = tmpS[1], s1b = tmpS[2];
        sampleRGB(colorL, u - 2 * rbx, v - 2 * rby, topDown, tmpS);
        const s2r = tmpS[0], s2g = tmpS[1], s2b = tmpS[2];
        sampleRGB(colorL, u - 3 * rbx, v - 3 * rby, topDown, tmpS);
        cr = (cr * 1.4 + s1r * 1.2 + s2r * 0.9 + tmpS[0] * 0.5) * 0.25;
        cg = (cg * 1.4 + s1g * 1.2 + s2g * 0.9 + tmpS[1] * 0.5) * 0.25;
        cb = (cb * 1.4 + s1b * 1.2 + s2b * 0.9 + tmpS[2] * 0.5) * 0.25;
      }

      let br = 0, bg = 0, bb = 0;
      if (bloomL) {
        sampleRGB(bloomL, u, v, topDown, tmpB);
        br = tmpB[0]; bg = tmpB[1]; bb = tmpB[2];
      }

      let gr = 0, gg = 0, gb = 0;
      if (godGain > 0 && godL) {
        sampleRGB(godL, u, v, topDown, tmpG);
        gr = tmpG[0] * godGain;
        gg = tmpG[1] * godGain * 0.72;
        gb = tmpG[2] * godGain * 0.46;
      }

      let shVal = 0;
      if (hasShaft) {
        shVal = 0.25 * (
          sampleChannel(shaftL, u + stx, v + sty, 0, topDown) +
          sampleChannel(shaftL, u - stx, v - sty, 0, topDown) +
          sampleChannel(shaftL, u + stx, v - sty, 0, topDown) +
          sampleChannel(shaftL, u - stx, v + sty, 0, topDown)
        );
      }

      const invB = 1.0 - bloomMix;
      cr = cr * invB + br * bloomMix + gr + shVal * shaftC0;
      cg = cg * invB + bg * bloomMix + gg + shVal * shaftC1;
      cb = cb * invB + bb * bloomMix + gb + shVal * shaftC2;
      if (cr < 0) cr = 0;
      if (cg < 0) cg = 0;
      if (cb < 0) cb = 0;

      if (flash > 0) {
        const fl = flash * 0.25;
        cr += br * fl;
        cg += bg * fl;
        cb += bb * fl;
      }

      const vig = 1.0 - vigK * smoothstep(0.10, 0.75, r2 * 1.25);
      const sc = exposure * vig * inv06;
      const sr = cr * sc, sg = cg * sc, sb = cb * sc;

      // ACES RRT/ODT 拟合
      const vr = 0.59719 * sr + 0.35458 * sg + 0.04823 * sb;
      const vg = 0.07600 * sr + 0.90834 * sg + 0.01566 * sb;
      const vb = 0.02840 * sr + 0.13383 * sg + 0.83777 * sb;
      const fr = (vr * (vr + 0.0245786) - 0.000090537) / (vr * (0.983729 * vr + 0.4329510) + 0.238081);
      const fg = (vg * (vg + 0.0245786) - 0.000090537) / (vg * (0.983729 * vg + 0.4329510) + 0.238081);
      const fb = (vb * (vb + 0.0245786) - 0.000090537) / (vb * (0.983729 * vb + 0.4329510) + 0.238081);
      cr = clamp01(1.60475 * fr - 0.53108 * fg - 0.07367 * fb);
      cg = clamp01(-0.10208 * fr + 1.10813 * fg - 0.00605 * fb);
      cb = clamp01(-0.00327 * fr - 0.07276 * fg + 1.07602 * fb);

      const l = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb;
      const invL = 1.0 - l;
      cr = l + (cr - l) * sat + sh0 * invL + hi0 * l;
      cg = l + (cg - l) * sat + sh1 * invL + hi1 * l;
      cb = l + (cb - l) * sat + sh2 * invL + hi2 * l;

      cr += (cr * cr * (3 - 2 * cr) - cr) * contrast;
      cg += (cg * cg * (3 - 2 * cg) - cg) * contrast;
      cb += (cb * cb * (3 - 2 * cb) - cb) * contrast;

      cr = cr > 0 ? Math.pow(cr, invGamma) : 0;
      cg = cg > 0 ? Math.pow(cg, invGamma) : 0;
      cb = cb > 0 ? Math.pow(cb, invGamma) : 0;

      let n = 0;
      if (grain > 0 && ditherMode !== 'none') {
        if (ditherMode === 'triangular') {
          const g1 = fract(52.9829189 * fract(0.06711056 * (fragX + shiftTri) + 0.00583715 * (fragY + shiftTri)));
          const g2 = fract(52.9829189 * fract(0.06711056 * (fragX + 17 + shiftTri) + 0.00583715 * (fragY + 31 + shiftTri)));
          n = (g1 - g2) * grain;
        } else {
          const dp = (fragX + shiftHash) * 12.9898 + (fragY + shiftHash) * 78.233;
          n = (fract(Math.sin(dp) * 43758.5453) - 0.5) * grain;
        }
      }

      const idx = (row * w + col) * 4;
      out[idx] = Math.round(clamp01((cr + n) * fade) * 255);
      out[idx + 1] = Math.round(clamp01((cg + n) * fade) * 255);
      out[idx + 2] = Math.round(clamp01((cb + n) * fade) * 255);
      out[idx + 3] = 255;
    }
  }
  return out;
}

/** 合成一侧的标准 create 句柄（CF2 要求 comp 落点使用 shape: 'create'） */
export function create(ctx = {}, params = {}) {
  const base = { ...DEFAULT_GRADE_PARAMS, ...params };
  let frame = 0;
  let subFrame = 0;
  let overrides = {};
  const fps = typeof ctx.fps === 'number' && ctx.fps > 0 ? ctx.fps : 60;

  return {
    apply(f, sub = 0, state = null) {
      frame = f;
      subFrame = sub;
      if (state && typeof state === 'object') overrides = state;
    },
    object: {
      grade(inputs, size, extra = {}) {
        const merged = { ...base, ...overrides, ...extra };
        if (merged.time === 0 && (frame !== 0 || subFrame !== 0)) {
          merged.time = (frame + subFrame) / fps;
        }
        return evaluate(inputs, merged, size);
      },
      evaluate(inputs, size, extra = {}) {
        return evaluate(inputs, { ...base, ...overrides, ...extra }, size);
      },
    },
    dispose() {},
  };
}
