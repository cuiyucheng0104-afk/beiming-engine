// 画面能量尺子与小指标（O8）：高光溢出、静止区噪声残差、边缘锯齿与闪烁、色板色差、轮廓重合度。
// 都是同步纯函数，不用随机数，同一输入重复读数逐位一致。公式与参数口径见 ../DETAILS.md。
//
// 帧：{ width, height, <像素数组> }，像素数组的键是 rgba（4 通道）、rgb（3 通道）、luma / mask / ids（单通道）
// 或 data（按 长度 / (宽 × 高) 判 1、3、4 通道），只能给一个。Uint8Array / Uint8ClampedArray 是显示空间 8 位码值，
// Float32Array / Float64Array 是场景线性值（可以大于 1）。阈值一律用输入自己的量纲。
// 坐标原点在左上；roi 是 { x, y, width, height } 整数像素框。
// 入参不对抛 RangeError，code 是冻结错误码 usage.bad-argument。
import { srgbToLab } from '../../../tools/eval/lib/metrics.mjs';
import { colorPalette } from './image-layout.mjs';

function bad(message) { throw Object.assign(new RangeError(message), { code: 'usage.bad-argument' }); }
function need(ok, message) { if (!ok) bad(message); }
function number(value, name, low = 0, high = Infinity) {
  need(Number.isFinite(value) && value >= low && value <= high, `无效参数 ${name}`);
  return value;
}
function options(opts, allowed) {
  need(opts !== null && typeof opts === 'object' && !Array.isArray(opts), '选项须为对象');
  for (const key of Object.keys(opts)) need(allowed.includes(key), `未知选项 ${key}`);
  return opts;
}

const FIELDS = { rgba: 4, rgb: 3, luma: 1, mask: 1, ids: 1, data: 0 };
const BYTES = [Uint8Array, Uint8ClampedArray], FLOATS = [Float32Array, Float64Array];
const WIDE = [Uint16Array, Uint32Array, Int32Array];
const isA = (value, types) => types.some(type => value instanceof type);

// wide 为真时另收 16、32 位整数数组（编号层用）。
function read(frame, label, wide = false) {
  need(frame !== null && typeof frame === 'object', `${label}须为帧对象`);
  const { width, height } = frame;
  need(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0, `${label}宽高须为正整数`);
  const keys = Object.keys(FIELDS).filter(key => frame[key] !== undefined);
  need(keys.length === 1, `${label}须恰好给一个像素数组（rgba、rgb、luma、mask、ids、data）`);
  const data = frame[keys[0]], float = isA(data, FLOATS);
  need(float || isA(data, BYTES) || (wide && isA(data, WIDE)), `${label}的像素数组类型不支持`);
  const channels = data.length / (width * height);
  need([1, 3, 4].includes(channels) && (!FIELDS[keys[0]] || FIELDS[keys[0]] === channels), `${label}的像素数组长度与宽高不符`);
  if (float) for (let i = 0; i < data.length; i++) need(Number.isFinite(data[i]), `${label}含非有限数`);
  return { width, height, data, channels, float, scale: float ? 1 : 255 };
}

// 普通数组一律逐索引查自有属性：map、every、some 会跳过稀疏数组的空洞，Array.from 和下标读取会顺着原型链读到别处挂的值。
function items(list, label) {
  const out = [];
  for (let i = 0; i < list.length; i++) { need(Object.hasOwn(list, i), `${label}第 ${i} 项是空洞`); out.push(list[i]); }
  return out;
}
const triple = (value, ok = Number.isFinite) => Array.isArray(value) && value.length === 3 &&
  [0, 1, 2].every(i => Object.hasOwn(value, i) && typeof value[i] === 'number' && ok(value[i]));

function sequence(frames, min, name) {
  need(Array.isArray(frames) && frames.length >= min, `${name} 至少要 ${min} 帧`);
  const list = items(frames, name).map((frame, i) => read(frame, `第 ${i} 帧`));
  for (const f of list) {
    need(f.width === list[0].width && f.height === list[0].height && f.channels === list[0].channels &&
      f.float === list[0].float, '各帧的尺寸、通道数或数值类型不一致');
  }
  return list;
}

function region({ width, height }, roi) {
  if (roi === undefined) return { x: 0, y: 0, width, height };
  need(roi !== null && typeof roi === 'object' && [roi.x, roi.y, roi.width, roi.height].every(Number.isInteger) &&
    roi.x >= 0 && roi.y >= 0 && roi.width > 0 && roi.height > 0 &&
    roi.x + roi.width <= width && roi.y + roi.height <= height, 'roi 须为画面内的整数像素框');
  return roi;
}

// Rec.709 亮度，裁到 roi。8 位输入直接对码值加权。
function lumaPlane({ width, data, channels }, { x, y, width: w, height: h }) {
  const out = new Float64Array(w * h);
  for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
    const i = ((y + row) * width + x + col) * channels;
    out[row * w + col] = channels === 1 ? data[i] : 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  return out;
}

// 任一色分量达到 threshold 的像素占比。默认阈值：8 位 254，线性浮点 1（显示白）。
// alphaMask 为 true 时只数本帧 alpha 大于 0 的像素；也可以给与画面等大的单通道数组（8 位、浮点定型数组或普通数组），
// 元素须为布尔或非负有限数，大于 0 计入。
// 平顶斑块：最大分量等于全区峰值、且有四邻域同伴的像素；峰值不到阈值一半时不算。
export function clipHighlightRatio(frame, opts = {}) {
  const { threshold, roi, alphaMask } = options(opts, ['threshold', 'roi', 'alphaMask']);
  const img = read(frame, '帧'), { width, data, channels, float } = img;
  const limit = threshold === undefined ? (float ? 1 : 254)
    : number(threshold, 'threshold', float ? -Infinity : 0, float ? Infinity : 255);
  const own = alphaMask === true, external = !own && alphaMask !== undefined && alphaMask !== false;
  need(!own || channels === 4, 'alphaMask 为 true 时帧须带 alpha 通道');
  if (external) {
    need((Array.isArray(alphaMask) || isA(alphaMask, [...BYTES, ...FLOATS])) && alphaMask.length === width * img.height,
      'alphaMask 须为 true 或与画面等大的单通道数组');
    for (let i = 0; i < alphaMask.length; i++) {
      const v = alphaMask[i];
      need(Object.hasOwn(alphaMask, i) && (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v) && v >= 0)),
        'alphaMask 的元素须为布尔或非负有限数，不能有空洞');
    }
  }
  const { x, y, width: w, height: h } = region(img, roi), colors = Math.min(channels, 3);
  const top = new Float64Array(w * h).fill(-Infinity), hits = [0, 0, 0];
  let total = 0, clipped = 0, peak = -Infinity;
  for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
    const p = (y + row) * width + x + col;
    if (own ? !(data[p * 4 + 3] > 0) : external && !(alphaMask[p] > 0)) continue;
    total++;
    let most = -Infinity;
    for (let c = 0; c < colors; c++) {
      const v = data[p * channels + c];
      if (v > most) most = v;
      if (v >= limit) hits[c]++;
    }
    top[row * w + col] = most;
    if (most > peak) peak = most;
    if (most >= limit) clipped++;
  }
  let plateau = 0;
  if (total && peak >= limit / 2) {
    for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
      const i = row * w + col;
      if (top[i] === peak && ((col > 0 && top[i - 1] === peak) || (col < w - 1 && top[i + 1] === peak) ||
        (row > 0 && top[i - w] === peak) || (row < h - 1 && top[i + w] === peak))) plateau++;
    }
  }
  const share = n => total ? n / total : 0, ratio = share(clipped);
  return { metric: 'metric:clip.highlight-ratio', value: ratio, unit: 'ratio', ratio, clippedPixels: clipped,
    totalPixels: total, peakMax: total ? peak : null,
    channelRatios: colors === 1 ? [ratio, ratio, ratio] : hits.map(share),
    threshold: limit, plateauPixels: plateau, plateauRatio: share(plateau) };
}

const COHERENT = 0.6, COLLAPSE = 0.35 ** 2, DENSE = 1 / 4, PAIRS = 4;

// 有没有非零整数位移（各向不超过 reach）能把上一帧的块配准到本帧：残差平方和不超过 limit。只试源块整个落在量测区内的位移。
function registers(cur, prev, w, h, [x0, x1, y0, y1], reach, limit) {
  for (let dy = Math.max(-reach, y1 - h); dy <= Math.min(reach, y0); dy++) for (let dx = Math.max(-reach, x1 - w); dx <= Math.min(reach, x0); dx++) {
    if (!dx && !dy) continue;
    let rest = 0;
    for (let y = y0; y < y1 && rest <= limit; y++) {
      for (let x = x0; x < x1; x++) rest += (cur[y * w + x] - prev[(y - dy) * w + x - dx]) ** 2;
    }
    if (rest <= limit) return true;
  }
  return false;
}

// 稀疏纹理的整体平移。块里只有几个像素在变时，单看这一块、单向配准不作数：消失的孤立脉冲随便挪一下就对上了平场。
// 改验守恒：找非零整数位移 s，让 cur(p) = prev(p − s)（本帧的每个亮点都有来处）且 prev(p) = cur(p + s)（上一帧的每个亮点都有去处），
// 两个方向的残差平方和先在本块 box、再在外扩一圈的 3×3 块窗口 wide 上都塌到零位移的 COLLAPSE 以下，
// 且窗口里比过的变化像素不少于 PAIRS 个。来处或去处出了量测区的像素不比。at 是块内 |d| 最大的像素，先拿它筛位移。
function drifts(cur, prev, d, w, h, box, wide, reach, floor, energy, at) {
  const rx = Math.min(reach, (w - 1) >> 1), ry = Math.min(reach, (h - 1) >> 1), px = at % w, py = (at - px) / w;
  // 框内比过的变化像素数；残差没塌（或中途超过 cap）回 -1。
  const fits = ([x0, x1, y0, y1], dx, dy, cap) => {
    const off = dy * w + dx;
    let rest = 0, zero = 0, changed = 0;
    for (let y = Math.max(y0, dy, -dy); y < Math.min(y1, h - dy, h + dy); y++) {
      for (let x = Math.max(x0, dx, -dx); x < Math.min(x1, w - dx, w + dx); x++) {
        const i = y * w + x;
        rest += (cur[i] - prev[i - off]) ** 2 + (prev[i] - cur[i + off]) ** 2;
        zero += d[i] * d[i];
        if (Math.abs(d[i]) > floor) changed++;
      }
      if (rest > cap) return -1;
    }
    return rest <= 2 * COLLAPSE * zero ? changed : -1;
  };
  const cap = 2 * COLLAPSE * energy;
  for (let dy = -ry; dy <= ry; dy++) for (let dx = -rx; dx <= rx; dx++) {
    if ((!dx && !dy) || fits([px, px + 1, py, py + 1], dx, dy, cap) < 0) continue;
    if (fits(box, dx, dy, cap) >= 0 && fits(wide, dx, dy, Infinity) >= PAIRS) return true;
  }
  return false;
}

// 相邻帧亮度差 d 的四邻域拉普拉斯在静止块上的均方根，除以 √40 折算成等效的单帧白噪声标准差。
// 块内 max|d| 不超过 motionThreshold 的直接算静止；超过的，满足下面任一条才是运动块，否则是静止区的随机噪声
// （高斯噪声、稀疏的散粒脉冲都留在静止区里计数）：
//   成片：块内横向或纵向相邻像素的 d 乘积和，绝对值超过 Σd² 的 0.6 倍（移动的边与条纹、整块亮度跳变、全画幅切换）；
//   配准：有非零整数位移（各向不超过 maxShift）让残差均方根塌到零位移的 0.35 倍以下。块内至少四分之一像素的 |d| 超过
//         motionThreshold 时单向配准本块就算（整体平移的细纹理）；不到四分之一时按 drifts 双向验守恒（平移的稀疏点阵；
//         稀疏脉冲凑巧对上一两个的不算）。
// 运动块连同外圈八块都不计。
// shortcut: 单个像素的移动、亚像素慢移或旋转形变的细纹理、叠在有纹理的静止背景上的稀疏点阵既不成片也配不准，会读成噪声；要分开得另给运动真值掩码。
export function noiseResidual(frames, opts = {}) {
  const { roi, block = 8, motionThreshold, maxShift = 6 } = options(opts, ['roi', 'block', 'motionThreshold', 'maxShift']);
  const list = sequence(frames, 2, 'noiseResidual');
  const r = region(list[0], roi), w = r.width, h = r.height;
  need(Number.isInteger(block) && block >= 4 && block <= Math.min(w, h), 'block 须为 4 到量测区域短边之间的整数');
  need(Number.isSafeInteger(maxShift) && maxShift >= 0, 'maxShift 须为非负安全整数');
  const floor = motionThreshold === undefined ? 2 / 255 * list[0].scale : number(motionThreshold, 'motionThreshold');
  const planes = list.map(f => lumaPlane(f, r));
  const cols = Math.floor(w / block), rows = Math.floor(h / block);
  // 末行末列不足一块的余数并进最后一块。
  const extent = (bx, by) => [bx * block, bx === cols - 1 ? w : (bx + 1) * block, by * block, by === rows - 1 ? h : (by + 1) * block];
  const d = new Float64Array(w * h), lap = new Float64Array(w * h), moving = new Uint8Array(cols * rows);
  let sum = 0, count = 0, staticPixels = 0;
  for (let t = 1; t < planes.length; t++) {
    const cur = planes[t], prev = planes[t - 1];
    for (let i = 0; i < d.length; i++) d[i] = cur[i] - prev[i];
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      lap[i] = 4 * d[i] - d[i - 1] - d[i + 1] - d[i - w] - d[i + w];
    }
    for (let by = 0; by < rows; by++) for (let bx = 0; bx < cols; bx++) {
      const box = extent(bx, by), [x0, x1, y0, y1] = box;
      let peak = 0, at = 0, energy = 0, across = 0, down = 0, changed = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const v = d[y * w + x], size = Math.abs(v);
        if (size > peak) { peak = size; at = y * w + x; }
        if (size > floor) changed++;
        energy += v * v;
        if (x + 1 < x1) across += v * d[y * w + x + 1];
        if (y + 1 < y1) down += v * d[(y + 1) * w + x];
      }
      const wide = [extent(Math.max(0, bx - 1), by)[0], extent(Math.min(cols - 1, bx + 1), by)[1],
        extent(bx, Math.max(0, by - 1))[2], extent(bx, Math.min(rows - 1, by + 1))[3]];
      moving[by * cols + bx] = peak > floor && (Math.max(Math.abs(across), Math.abs(down)) > COHERENT * energy ||
        (changed >= DENSE * (x1 - x0) * (y1 - y0) ? registers(cur, prev, w, h, box, maxShift, COLLAPSE * energy)
          : drifts(cur, prev, d, w, h, box, wide, maxShift, floor, energy, at))) ? 1 : 0;
    }
    for (let by = 0; by < rows; by++) for (let bx = 0; bx < cols; bx++) {
      let still = true;
      for (let j = Math.max(0, by - 1); j <= Math.min(rows - 1, by + 1); j++) {
        for (let i = Math.max(0, bx - 1); i <= Math.min(cols - 1, bx + 1); i++) if (moving[j * cols + i]) still = false;
      }
      if (!still) continue;
      const [x0, x1, y0, y1] = extent(bx, by);
      staticPixels += (x1 - x0) * (y1 - y0);
      for (let y = Math.max(1, y0); y < Math.min(h - 1, y1); y++) {
        for (let x = Math.max(1, x0); x < Math.min(w - 1, x1); x++) { sum += lap[y * w + x] ** 2; count++; }
      }
    }
  }
  const totalPixels = w * h * (planes.length - 1);
  return { metric: 'metric:noise.residual', value: count ? Math.sqrt(sum / count / 40) : null,
    unit: list[0].float ? 'linear' : 'code8', status: count ? 'ok' : 'no-static-region',
    staticRatio: staticPixels / totalPixels, staticPixels, totalPixels, pairs: planes.length - 1,
    block, motionThreshold: floor, maxShift };
}

const REACH = 6;

// 以 i 为心、沿 along 方向取半宽 R 的窗，求 across 方向相邻三行各自的窗内亮度和的二阶差分，再除以窗内极差，单位像素。
// R 从 1 起加到 REACH，取第一个两端平坦的窗（两端各两列在三行上的极差不超过 tol），保证没有边界从窗的侧面穿出；找不到回 NaN。
function wobble(L, i, along, across, tol) {
  for (let R = 1; R <= REACH; R++) {
    let flat = true;
    for (const side of [-1, 1]) {
      let lo = Infinity, hi = -Infinity;
      for (let j = -1; j <= 1; j++) for (let k = R; k <= R + 1; k++) {
        const v = L[i + j * across + side * k * along];
        lo = Math.min(lo, v); hi = Math.max(hi, v);
      }
      if (hi - lo > tol) flat = false;
    }
    if (!flat) continue;
    const sums = [0, 0, 0];
    let lo = Infinity, hi = -Infinity;
    for (let j = -1; j <= 1; j++) for (let k = -R; k <= R; k++) {
      const v = L[i + j * across + k * along];
      sums[j + 1] += v; lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
    return Math.abs(sums[0] - 2 * sums[1] + sums[2]) / (hi - lo);
  }
  return NaN;
}

// 锯齿度：强边缘像素（Sobel 幅值 / 4 不低于 edgeThreshold）上，逐行（近水平的边逐列）覆盖面积的二阶差分绝对值的平均，单位像素。
// 盒滤波抗锯齿下直边、细杆每行的覆盖面积随行号线性变化，读数接近 0；点采样的阶梯读数约 2·min(s, 1 − s)，s 是每行的横移量。
// 距量测区边缘不到 REACH + 1 像素的边缘不计；数值按输入原样量，不做色彩空间换算。
// 闪烁（至少 3 帧）：细节区像素上，相邻两次帧间亮度变化反号时取较小的那次幅度，再取平均。
// 细节区：任一帧里 Sobel 幅值 / 4、向右向下的单步差分、横纵二阶差分的最大值不低于 edgeThreshold 的像素；
// 1 像素交替的条纹、棋盘在 Sobel 的隔一像素差分里正好抵消，靠后两项认。
// shortcut: 正好 0°、45°、90° 的点采样阶梯每行面积等差，读不出锯齿；这类画面看 flicker 或换成比参考图。
export function aliasEdge(input, opts = {}) {
  const { roi, edgeThreshold } = options(opts, ['roi', 'edgeThreshold']);
  const list = Array.isArray(input) ? sequence(input, 1, 'aliasEdge') : [read(input, '帧')];
  const r = region(list[0], roi), w = r.width, h = r.height;
  const limit = edgeThreshold === undefined ? 32 / 255 * list[0].scale : number(edgeThreshold, 'edgeThreshold');
  const planes = list.map(f => lumaPlane(f, r)), detail = new Uint8Array(w * h);
  let sum = 0, edges = 0;
  for (const L of planes) {
    for (let y = REACH + 1; y < h - REACH - 1; y++) for (let x = REACH + 1; x < w - REACH - 1; x++) {
      const i = y * w + x, c = L[i];
      const gx = L[i - w + 1] + 2 * L[i + 1] + L[i + w + 1] - L[i - w - 1] - 2 * L[i - 1] - L[i + w - 1];
      const gy = L[i + w - 1] + 2 * L[i + w] + L[i + w + 1] - L[i - w - 1] - 2 * L[i - w] - L[i - w + 1];
      const edge = Math.hypot(gx, gy) / 4;
      const fine = Math.max(edge, Math.abs(L[i + 1] - c), Math.abs(L[i + w] - c),
        Math.abs(2 * c - L[i - 1] - L[i + 1]), Math.abs(2 * c - L[i - w] - L[i + w]));
      if (fine === 0 || fine < limit) continue;
      detail[i] = 1;
      if (edge === 0 || edge < limit) continue;
      const step = Math.abs(gx) >= Math.abs(gy) ? wobble(L, i, 1, w, limit / 4) : wobble(L, i, w, 1, limit / 4);
      if (Number.isNaN(step)) continue;
      sum += step; edges++;
    }
  }
  let flicker = null, detailPixels = 0;
  if (planes.length >= 3) {
    let energy = 0;
    for (let i = 0; i < detail.length; i++) {
      if (!detail[i]) continue;
      detailPixels++;
      for (let t = 1; t < planes.length - 1; t++) {
        const before = planes[t][i] - planes[t - 1][i], after = planes[t + 1][i] - planes[t][i];
        if (before * after < 0) energy += Math.min(Math.abs(before), Math.abs(after));
      }
    }
    flicker = detailPixels ? energy / (detailPixels * (planes.length - 2)) : 0;
  }
  const jaggedness = edges ? sum / edges : 0;
  return { metric: 'metric:alias.edge', value: jaggedness, unit: 'px', status: edges ? 'ok' : 'no-edges', jaggedness,
    edgePixels: edges, edgeRatio: edges / (w * h * planes.length), flicker,
    flickerUnit: list[0].float ? 'linear' : 'code8', detailPixels, frames: planes.length, edgeThreshold: limit };
}

const encode = v => { const c = Math.min(1, Math.max(0, v)); return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)); };

// 色板：[r, g, b] 或 { rgb, share? } 或 { lab, share? } 的数组；给帧时用 colorPalette 取前 k 个主色。
// 线性浮点帧先截到 0 到 1 再按 sRGB 编成 8 位。
function palette(input, k, label) {
  if (!Array.isArray(input)) {
    const { width, height, data, channels, float } = read(input, label);
    const rgba = new Uint8Array(width * height * 4).fill(255);
    for (let p = 0; p < width * height; p++) for (let c = 0; c < 3; c++) {
      const v = data[p * channels + (channels === 1 ? 0 : c)];
      rgba[p * 4 + c] = float ? encode(v) : v;
    }
    return colorPalette({ width, height, rgba }, k).details.palette.map(({ rgb, share }) => ({ color: rgb, share, lab: srgbToLab(...rgb) }));
  }
  need(input.length > 0, `${label}色板不能为空`);
  const colors = items(input, `${label}色板`).map(entry => {
    const item = Array.isArray(entry) ? { rgb: entry } : entry;
    need(item !== null && typeof item === 'object' && (item.rgb === undefined) !== (item.lab === undefined), `${label}色板的颜色须给 rgb 或 lab 之一`);
    const { rgb, lab, share = 1 } = item;
    need(rgb ? triple(rgb, c => Number.isInteger(c) && c >= 0 && c <= 255) : triple(lab), `${label}色板的色值无效`);
    return { color: [...(rgb ?? lab)], share: number(share, 'share'), lab: lab ? [...lab] : srgbToLab(...rgb) };
  });
  const top = colors.reduce((most, c) => Math.max(most, c.share), 0);
  need(top > 0, `${label}色板的 share 不能全为 0`);
  // share 只看比例，先除以最大的那个：极大的 share 直接求和、乘色差会溢出成 Infinity。
  for (const c of colors) c.share /= top;
  return colors;
}

const top = v => Math.min(v, Number.MAX_VALUE), rad = d => d * Math.PI / 180;
// c⁷ / (c⁷ + 25⁷) 的有界写法：c 为 0 得 0，c 极大得 1，中间不溢出。
const ratio7 = c => 1 / (1 + (25 / c) ** 7);

// CIEDE2000（Sharma 等 2005），与 tools/eval/lib/metrics.mjs 的 deltaE00 同式，常规范围读数对到 1e-9。
// 那一版彩度上到 1e44 时 C⁷ 溢出，同色自比也出 Infinity；这里各项都写成有界的比值或先减半再算：
// 任何有限 Lab 都得有限非负数，三个分量逐一相等恰为 0，超出双精度的色差封顶在 Number.MAX_VALUE。
function de00([L1, a1, b1], [L2, a2, b2]) {
  if (L1 === L2 && a1 === a2 && b1 === b2) return 0;
  // 彩度大到 1 + G 会让 a 溢出时，G 早已是 0。
  const G = 0.5 * (1 - Math.sqrt(ratio7(top(Math.hypot(a1, b1)) / 2 + top(Math.hypot(a2, b2)) / 2)));
  const A1 = (1 + G) * a1, A2 = (1 + G) * a2, C1 = top(Math.hypot(A1, b1)), C2 = top(Math.hypot(A2, b2));
  const hue = (b, a) => { if (a === 0 && b === 0) return 0; const v = Math.atan2(b, a) * 180 / Math.PI; return v >= 0 ? v : v + 360; };
  const h1 = hue(b1, A1), h2 = hue(b2, A2), gray = C1 === 0 || C2 === 0;
  let dh = gray ? 0 : h2 - h1, hb = h1 + h2;
  if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  if (!gray) hb = Math.abs(h1 - h2) <= 180 ? hb / 2 : hb < 360 ? (hb + 360) / 2 : (hb - 360) / 2;
  const Cb = C1 / 2 + C2 / 2, q = L1 / 2 + L2 / 2 - 50;
  const T = 1 - 0.17 * Math.cos(rad(hb - 30)) + 0.24 * Math.cos(rad(2 * hb)) + 0.32 * Math.cos(rad(3 * hb + 6)) - 0.20 * Math.cos(rad(4 * hb - 63));
  // S_L 原式 1 + 0.015·q² / √(20 + q²)，分子分母同除以 |q|。
  const Sl = 1 + 0.015 * Math.abs(q) / Math.sqrt(1 + 20 / (q * q)), Sc = 1 + 0.045 * Cb, Sh = 1 + 0.015 * Cb * T;
  const Rt = -Math.sin(rad(60 * Math.exp(-(((hb - 275) / 25) ** 2)))) * 2 * Math.sqrt(ratio7(Cb));
  // halfL 是 ΔL′ / S_L 的一半：L 一正一负都极大时差值本身会溢出。色度项、色相项有界（不超过 45 与 1905）。
  const halfL = (L2 / 2 - L1 / 2) / Sl, tC = (C2 - C1) / Sc, tH = Math.sqrt(C1) * Math.sqrt(C2) / Sh * 2 * Math.sin(rad(dh / 2));
  return top(2 * Math.hypot(halfL, Math.sqrt(Math.max(0, tC * tC + tH * tH + Rt * tC * tH)) / 2));
}

// 每个颜色到对面色板最近色的 CIEDE2000 色差，按 share 归一加权。
function nearest(from, to) {
  const weightSum = from.reduce((sum, c) => sum + c.share, 0);
  let mean = 0, max = 0, weighted = 0;
  const pairs = from.map(({ color, share, lab }) => {
    let best = Infinity, index = 0;
    to.forEach((other, j) => { const e = de00(lab, other.lab); if (e < best) { best = e; index = j; } });
    mean += best / from.length; max = Math.max(max, best); weighted += best * share / weightSum;
    return { color, share: share / weightSum, nearest: to[index].color, index, de00: best };
  });
  // 几个封顶的色差相加，舍入可能刚好越过 Number.MAX_VALUE。
  return { meanDe00: top(mean), maxDe00: max, weightedDe00: top(weighted), pairs };
}

// 顶层的 meanDe00、maxDe00、weightedDe00、pairs 是候选的每个主色到参考色板最近色；reverse 是参考的每个色到候选。
// value 取两个方向平均色差里大的那个：多出色板外的主色、或缺了参考里的色，都会抬高它。
export function colorPaletteDe00(candidate, reference, opts = {}) {
  const { k = 6 } = options(opts, ['k']);
  need(Number.isInteger(k) && k >= 1, 'k 须为正整数');
  const a = palette(candidate, k, '候选'), b = palette(reference, k, '参考');
  const forward = nearest(a, b), reverse = nearest(b, a);
  return { metric: 'metric:color.palette-de00', value: Math.max(forward.meanDe00, reverse.meanDe00), unit: 'deltaE00',
    ...forward, reverse };
}

// 掩码来源按选项与通道数定：给 id 时读单通道编号层里等于 id 的像素；给 background 时取与背景色差超过 tol 的像素；
// 四通道帧取 alpha 大于 threshold（默认半幅）；单通道取大于 threshold（默认 0）。选项对两边同样生效。
function shape(input, label, { id, background, tol, threshold }) {
  const { width, data, channels, scale } = read(input, label, id !== undefined);
  if (id !== undefined) {
    need(channels === 1, `${label}须为单通道编号层`);
    return p => data[p] === id;
  }
  if (background !== undefined) {
    need(channels >= 3, `${label}须为彩色帧`);
    return p => Math.max(...background.map((c, k) => Math.abs(data[p * channels + k] - c))) > tol;
  }
  need(channels !== 3, `${label}是三通道帧，须给 background 才能分出前景`);
  const limit = threshold ?? (channels === 4 ? scale / 2 : 0);
  return p => data[p * channels + channels - 1] > limit;
}

// a 是候选、b 是参考：precision = 交 / a 的面积，recall = 交 / b 的面积，bboxIou 是两个紧包围盒的交并比。
// 两边都空时各比值取 emptyValue（默认 1）并置 emptyBoth；只有一边空时都是 0。
export function shapeIou(a, b, opts = {}) {
  const o = options(opts, ['roi', 'threshold', 'id', 'background', 'tol', 'emptyValue']);
  const { roi, id, background, tol = 0, threshold, emptyValue = 1 } = o;
  need(id === undefined || Number.isInteger(id), 'id 须为整数');
  need(background === undefined || triple(background), 'background 须为三个有限数');
  number(tol, 'tol'); number(emptyValue, 'emptyValue', 0, 1);
  if (threshold !== undefined) number(threshold, 'threshold', -Infinity);
  need(a?.width === b?.width && a?.height === b?.height, '两边尺寸不一致');
  const inA = shape(a, '候选', { id, background, tol, threshold }), inB = shape(b, '参考', { id, background, tol, threshold });
  const { x, y, width: w, height: h } = region(a, roi);
  const boxA = [w, h, -1, -1], boxB = [w, h, -1, -1];
  const grow = (box, col, row) => { box[0] = Math.min(box[0], col); box[1] = Math.min(box[1], row); box[2] = Math.max(box[2], col); box[3] = Math.max(box[3], row); };
  let areaA = 0, areaB = 0, intersection = 0;
  for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
    const p = (y + row) * a.width + x + col, hitA = inA(p), hitB = inB(p);
    if (hitA) { areaA++; grow(boxA, col, row); }
    if (hitB) { areaB++; grow(boxB, col, row); }
    if (hitA && hitB) intersection++;
  }
  const union = areaA + areaB - intersection, emptyBoth = union === 0;
  const ratio = (n, total) => total ? n / total : emptyBoth ? emptyValue : 0;
  const area = box => Math.max(0, box[2] - box[0] + 1) * Math.max(0, box[3] - box[1] + 1);
  const overlap = area([Math.max(boxA[0], boxB[0]), Math.max(boxA[1], boxB[1]), Math.min(boxA[2], boxB[2]), Math.min(boxA[3], boxB[3])]);
  const iou = ratio(intersection, union);
  return { metric: 'metric:shape.iou', value: iou, unit: 'ratio', iou, intersection, union,
    precision: ratio(intersection, areaA), recall: ratio(intersection, areaB),
    bboxIou: areaA && areaB ? overlap / (area(boxA) + area(boxB) - overlap) : ratio(0, 0), areaA, areaB, emptyBoth };
}

// 标准指标名（题目文件 scoring[].metric 的点分小写名）到函数的登记表；带不带 metric: 前缀都认。
export const ENERGY_METRICS = Object.freeze({
  'clip.highlight-ratio': clipHighlightRatio,
  'noise.residual': noiseResidual,
  'alias.edge': aliasEdge,
  'color.palette-de00': colorPaletteDe00,
  'shape.iou': shapeIou,
});

export function runEnergyMetric(name, ...args) {
  const key = typeof name === 'string' ? name.replace(/^metric:/, '') : '';
  need(Object.hasOwn(ENERGY_METRICS, key), `未知指标 ${String(name)}`);
  return ENERGY_METRICS[key](...args);
}
