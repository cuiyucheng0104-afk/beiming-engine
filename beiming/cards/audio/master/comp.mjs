// audio.master 在合成一侧的实现：量响度和真峰值，整体调增益到目标。
// 合成宿主怎么用 Handle 还没有契约，这里定的用法写在卡文件的 ports.requires 里：合成工具调 Handle.object.measure、Handle.object.master。
// 响度照 ITU-R BS.1770：K 加权（两级二阶滤波）、400 毫秒的块每 100 毫秒一块、绝对门限 −70 LUFS、相对门限比过了绝对门限的平均低 10 LU。
// 真峰值：4 倍过采样（每相 12 个抽头、汉宁窗的 sinc 插值）之后取绝对值最大的样本。

const RATE = 48000;
// 48000 赫兹下 K 加权的两级滤波系数 [b0, b1, b2, a1, a2]：第一级是高频搁架，第二级是高通
const STAGES = [
  [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585],
  [1, -2, 1, -1.99004745483398, 0.99007225036621],
];
const BLOCK = 0.4 * RATE, STEP = 0.1 * RATE;
const OVERSAMPLE = 4, TAPS = 12;
// 第 p 相的插值核：采样点之间 p ÷ 4 处的值
const PHASES = Array.from({ length: OVERSAMPLE }, (_, p) => Array.from({ length: TAPS }, (_, k) => {
  const x = k - TAPS / 2 + 1 - p / OVERSAMPLE, window = 0.5 + 0.5 * Math.cos((Math.PI * x) / (TAPS / 2));
  return (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * window;
}));
const db = (power) => 10 * Math.log10(power);

function biquad(input, [b0, b1, b2, a1, a2]) {
  const out = new Float64Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i], y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y; x2 = x1; x1 = x; y2 = y1; y1 = y;
  }
  return out;
}

/** 门限之后的综合响度，LUFS；一块都过不了绝对门限时是 −Infinity */
function loudness(channels) {
  const weighted = channels.map((c) => STAGES.reduce(biquad, c)), n = channels[0].length, blocks = [];
  for (let start = 0; start + BLOCK <= n; start += STEP) {
    let power = 0;
    for (const c of weighted) { let sum = 0; for (let i = start; i < start + BLOCK; i++) sum += c[i] * c[i]; power += sum / BLOCK; }
    blocks.push(power);
  }
  const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;
  const loud = blocks.filter((p) => -0.691 + db(p) > -70);
  if (!loud.length) return -Infinity;
  const relative = -0.691 + db(mean(loud)) - 10;
  return -0.691 + db(mean(loud.filter((p) => -0.691 + db(p) > relative)));
}

/** 真峰值，dBTP */
function truePeak(channels) {
  let peak = 0;
  for (const c of channels) {
    for (let i = 0; i < c.length; i++) {
      for (const kernel of PHASES) {
        let v = 0;
        for (let k = 0; k < TAPS; k++) { const j = i + k - TAPS / 2 + 1; if (j >= 0 && j < c.length) v += c[j] * kernel[k]; }
        peak = Math.max(peak, Math.abs(v));
      }
    }
  }
  return 20 * Math.log10(peak);
}

function checked(channels, sampleRate) {
  if (sampleRate !== RATE) throw new RangeError(`audio.master 这一版只做 ${RATE} 赫兹，给的是 ${sampleRate}`);
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2 || channels.some((c) => c.length !== channels[0].length)) throw new RangeError('audio.master 要一个或两个一样长的声道');
  if (channels[0].length < BLOCK) throw new RangeError('audio.master 量响度至少要 400 毫秒的声音');
}

/** params：loudness 目标响度（LUFS），truePeak 真峰值上限（dBTP） */
export function create(ctx, params) {
  const measure = (channels, sampleRate) => {
    checked(channels, sampleRate);
    return { loudnessLufs: loudness(channels), truePeakDbtp: truePeak(channels) };
  };
  return {
    object: {
      /** channels：一个或两个声道的样本（满幅是 ±1）；sampleRate 赫兹。返回 { loudnessLufs, truePeakDbtp } */
      measure,
      /**
       * 整体调增益：先按目标响度算增益，调完真峰值超过上限时把增益降到正好到上限。不做限幅，不动声音的动态。
       * 返回 { channels, gainDb, loudnessLufs, truePeakDbtp, limitedBy }：调完的样本（32 位浮点）、加的增益（分贝）、调完的响度和真峰值、
       * 增益是被哪一样定住的（loudness 或 truePeak）。
       */
      master(channels, sampleRate) {
        const before = measure(channels, sampleRate);
        if (!Number.isFinite(before.loudnessLufs)) throw new RangeError('audio.master 拿到的声音过不了 −70 LUFS 的门限，定不出增益');
        const wanted = params.loudness - before.loudnessLufs, room = params.truePeak - before.truePeakDbtp;
        const gainDb = Math.min(wanted, room), gain = 10 ** (gainDb / 20);
        return {
          channels: channels.map((c) => Float32Array.from(c, (v) => v * gain)), gainDb,
          loudnessLufs: before.loudnessLufs + gainDb, truePeakDbtp: before.truePeakDbtp + gainDb, limitedBy: wanted <= room ? 'loudness' : 'truePeak',
        };
      },
    },
    dispose() {},
  };
}
