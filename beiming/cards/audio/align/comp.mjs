// audio.align 在合成一侧的实现：把一段现成的配乐对到正片上，让它的低频重击落在指定的硬切帧上。
// 只做三样：平移；拉伸比不出 [0.97, 1.03] 的线性重采样；可选的一次交叉淡化剪接。要的拉伸比出了界就报错，不悄悄做大倍率变速。
// 合成宿主怎么用 Handle 还没有契约，这里定的用法写在卡文件的 ports.requires 里：ctx 带 fps；合成工具调 Handle.object.hits、align。
// 口径：正片时刻 = offsetSec + stretch × 配乐时刻，stretch 大于 1 是放慢；和观察工具量拉伸比的口径相同。

const RATE = 48000, LIMIT = [0.97, 1.03], EPS = 1e-9;
const WINDOW = 0.02 * RATE, STEP = 0.001 * RATE; // 找重击：20 毫秒的能量窗，1 毫秒一步
const refuse = (message) => { throw Object.assign(new RangeError(`audio.align：${message}`), { code: 'usage.bad-argument' }); };

function checked(channels) {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2 || channels.some((c) => !(c instanceof Float32Array) || c.length !== channels[0].length)) refuse('配乐要是一个或两个一样长的 32 位浮点声道，采样率 48000 赫兹');
  return channels;
}

/** 低频重击的时刻（秒）：两级一阶低通之后 20 毫秒窗的能量，取局部最大（前后 150 毫秒内最大）且不低于全曲最大值 floor 倍的窗，时刻是窗的起点 */
function findHits(channels, lowHz, floor) {
  const n = channels[0].length, k = 1 - Math.exp((-2 * Math.PI * lowHz) / RATE), sum = new Float64Array(n + 1);
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    const x = channels.length === 1 ? channels[0][i] : (channels[0][i] + channels[1][i]) / 2;
    a += k * (x - a);
    b += k * (a - b);
    sum[i + 1] = sum[i] + b * b;
  }
  const steps = Math.max(0, Math.floor((n - WINDOW) / STEP) + 1), energy = Float64Array.from({ length: steps }, (_, j) => sum[j * STEP + WINDOW] - sum[j * STEP]);
  const top = energy.reduce((m, v) => Math.max(m, v), 0), near = 150, out = [];
  for (let j = 0; j < steps; j++) {
    if (energy[j] <= 0 || energy[j] < floor * top) continue;
    let best = true;
    for (let i = Math.max(0, j - near); i <= Math.min(steps - 1, j + near) && best; i++) best = energy[i] < energy[j] || (energy[i] === energy[j] && i >= j);
    if (best) out.push((j * STEP) / RATE);
  }
  return out;
}

/**
 * ctx：用到 fps（"分子/分母"，帧每秒）。params：stretchMin、stretchMax 只能在 [0.97, 1.03] 里收窄；splice 许不许剪接一次；crossfadeMs 剪接处交叉淡化多长；
 * lowHz、hitFloor 是找低频重击用的低通频率和门限。
 * Handle.object：
 *   hits(channels)  配乐里低频重击的时刻，秒，从早到晚。
 *   align(channels, { frames, anchors, stretch, offsetSec })
 *       frames 是正片的总帧数，交回的声音正好这么长，配乐盖不到的地方是静音。
 *       anchors 一个或两个 { frame, hit } 或 { frame, sourceSec }：配乐的这一刻要落在正片的第 frame 帧上；hit 是 hits() 里的第几个，负数从后往前数。
 *         一个锚点只平移。两个锚点先算拉伸比，在界内就只拉伸加平移；出界时 splice 没开就报错，开了就在两个锚点正中间剪掉（或者重放）一段，
 *         接缝在 ±20 毫秒里挑波形最像的位置再交叉淡化，剩下不到一个接缝搜索范围的差用拉伸比补齐。
 *       不给 anchors 时直接用 stretch（不写是 1）和 offsetSec（不写是 0）。
 *       返回 { channels: [左, 右], stretch, offsetSec, splice, anchors }：splice 是 null 或 { cutSec, resumeSec, crossfadeMs }（配乐放到 cutSec 接着从 resumeSec 放）；
 *       anchors 每项 { frame, sourceSec }。
 */
export function create(ctx, params) {
  const [num, den] = ctx.fps.split('/').map(Number), [lo, hi] = [params.stretchMin, params.stretchMax];
  if (!(LIMIT[0] <= lo && lo <= hi && hi <= LIMIT[1])) refuse(`拉伸比的范围只能在 [${LIMIT}] 里收窄，给的是 [${lo}, ${hi}]`);
  const inRange = (s) => s >= lo - EPS && s <= hi + EPS;
  const hits = (channels) => findHits(checked(channels), params.lowHz, params.hitFloor);

  function align(channels, { frames, anchors, stretch = 1, offsetSec = 0 } = {}) {
    const src = checked(channels), total = src[0].length / RATE;
    if (!Number.isInteger(frames) || frames < 1) refuse(`frames 要是正整数帧数，给的是 ${frames}`);
    let splice = null, marks = [];
    if (anchors !== undefined) {
      if (!Array.isArray(anchors) || anchors.length < 1 || anchors.length > 2) refuse('anchors 要一个或两个锚点');
      const found = anchors.some((a) => a.hit !== undefined) ? hits(src) : [];
      marks = anchors.map((a) => {
        const sourceSec = a.hit === undefined ? a.sourceSec : found.at(a.hit);
        if (!Number.isInteger(a.frame) || a.frame < 0 || a.frame >= frames) refuse(`锚点的 frame ${a.frame} 不在正片的 0 到 ${frames - 1} 帧里`);
        if (!(sourceSec >= 0 && sourceSec <= total)) refuse(a.hit === undefined ? `锚点的 sourceSec ${a.sourceSec} 不在配乐的 0 到 ${total} 秒里` : `配乐里只找到 ${found.length} 个低频重击，没有第 ${a.hit} 个`);
        return { frame: a.frame, sourceSec };
      }).sort((p, q) => p.sourceSec - q.sourceSec);
      const [first, last] = [marks[0], marks.at(-1)], at = (m) => (m.frame * den) / num;
      stretch = 1;
      if (marks.length === 2) {
        const want = at(last) - at(first), have = last.sourceSec - first.sourceSec;
        if (!(want > 0 && have > 0)) refuse('两个锚点在配乐里和正片里的先后要一致，且不能重合');
        stretch = want / have;
        if (!inRange(stretch)) {
          if (!params.splice) refuse(`两个锚点要的拉伸比是 ${stretch.toFixed(4)}，出了 [${lo}, ${hi}]；这张卡不做更大的变速，要么换锚点，要么把 splice 打开剪接一次`);
          // 在两个锚点正中间对称地剪：放到 cut 接着从 resume 放，剪掉（have − want）秒；负数就是往回重放
          const mid = (first.sourceSec + last.sourceSec) / 2, half = params.crossfadeMs / 2000, search = 0.02;
          const cutSec = mid - (have - want) / 2, margin = half + search + WINDOW / RATE;
          if (Math.min(cutSec, mid + (have - want) / 2) < first.sourceSec + margin || Math.max(cutSec, mid + (have - want) / 2) > last.sourceSec - margin) refuse(`两个锚点之间只有 ${have.toFixed(3)} 秒，剪接一次凑不出正片要的 ${want.toFixed(3)} 秒`);
          const resumeSec = bestSeam(src, cutSec, mid + (have - want) / 2, half, search);
          splice = { cutSec, resumeSec, crossfadeMs: params.crossfadeMs };
          stretch = want / (cutSec - first.sourceSec + last.sourceSec - resumeSec);
          if (!inRange(stretch)) refuse(`剪接之后还要 ${stretch.toFixed(4)} 的拉伸比，出了 [${lo}, ${hi}]`);
        }
      }
      // 剪接之后的时间轴上，后一个锚点提前了 resume − cut
      offsetSec = at(last) - stretch * (last.sourceSec - (splice ? splice.resumeSec - splice.cutSec : 0));
    } else if (!inRange(stretch)) {
      refuse(`要的拉伸比 ${stretch} 出了 [${lo}, ${hi}]，这张卡不做更大的变速`);
    }

    // shortcut: 线性插值重采样，音高跟着拉伸比变（不超过 3%）、高频略有损失；要保音高或者更宽的拉伸范围时换成窗函数 sinc 或相位声码器
    const length = Math.round((frames * RATE * den) / num), jump = splice ? (splice.resumeSec - splice.cutSec) * RATE : 0;
    const cut = splice ? splice.cutSec * RATE : Infinity, half = splice ? (splice.crossfadeMs / 2000) * RATE : 0;
    const out = [0, 1].map((c) => {
      const from = src[Math.min(c, src.length - 1)], to = new Float32Array(length), n = from.length;
      const read = (u) => {
        if (u < 0 || u > n - 1) return 0;
        const i = Math.floor(u), next = i + 1 < n ? from[i + 1] : from[i];
        return from[i] + (next - from[i]) * (u - i);
      };
      for (let i = 0; i < length; i++) {
        const u = (i - offsetSec * RATE) / stretch;
        if (u <= cut - half) to[i] = read(u);
        else if (u >= cut + half) to[i] = read(u + jump);
        else { const w = (u - cut + half) / (2 * half); to[i] = read(u) * (1 - w) + read(u + jump) * w; }
      }
      return to;
    });
    return { channels: out, stretch, offsetSec, splice, anchors: marks };
  }

  return { object: { hits, align }, dispose() {} };
}

/** 接缝挑在哪：在 resume ± search 秒里找一个位置，让它前后 half 秒的波形和 cut 前后 half 秒的最像（归一化互相关最大），返回秒 */
function bestSeam(src, cutSec, resumeSec, half, search) {
  const x = src[0], w = Math.round(half * RATE), c = Math.round(cutSec * RATE);
  let best = Math.round(resumeSec * RATE), top = -Infinity;
  for (let r = best - Math.round(search * RATE); r <= Math.round(resumeSec * RATE) + Math.round(search * RATE); r++) {
    let dot = 0, power = 0;
    for (let i = -w; i < w; i++) { const v = x[r + i] ?? 0; dot += (x[c + i] ?? 0) * v; power += v * v; }
    const score = power > 0 ? dot / Math.sqrt(power) : 0;
    if (score > top) { top = score; best = r; }
  }
  return best / RATE;
}
