// audio.event-mix 在合成一侧的实现：照事件表把短音效精确到采样点地摆进一条 48000 赫兹的立体声，垫上配乐，整体防削波；
// 另带起音检测，用来把点击吸到配乐的起音上，和事后审计事件是不是踩在起音上。
// 合成宿主怎么用 Handle 还没有契约，这里定的用法写在卡文件的 ports.requires 里：ctx 带 fps 和 seed；合成工具调 Handle.object.mix、audit、snap。
// 事件时刻 → 采样点：round((frame + sub) × 48000 × 分母 ÷ 分子)，和合成收尾的事件混音同一个口径：先乘完再除一次，
// 不先算「每帧多少采样点」再乘，分数帧率下正好半个采样点的时刻才不会被中间的浮点数带偏。

const RATE = 48000, HOP = 240; // 起音检测的步长：5 毫秒
const fail = (message) => { throw Object.assign(new RangeError(`audio.event-mix：${message}`), { code: 'usage.bad-argument' }); };
const gain = (db) => 10 ** (db / 20);

/** 带种子的噪声，[-1, 1) */
function noise(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 31 - 1;
  };
}

/** 自带的两个音色，单声道，第一个采样就是起音：click 是 12 毫秒的点击瞬态，kick 是 220 毫秒往下扫的低频鼓点 */
const VOICES = {
  click(seed) {
    const rnd = noise(seed);
    return Float32Array.from({ length: 0.012 * RATE }, (_, i) => (0.6 * rnd() + 0.4 * Math.sin((2 * Math.PI * 2400 * i) / RATE)) * Math.exp(-i / (0.002 * RATE)));
  },
  kick() {
    let phase = 0;
    return Float32Array.from({ length: 0.22 * RATE }, (_, i) => {
      phase += (2 * Math.PI * (48 + 110 * Math.exp(-i / (0.03 * RATE)))) / RATE;
      return Math.sin(phase) * Math.exp(-i / (0.06 * RATE));
    });
  },
};

const stereoOf = (sound, name) => {
  const channels = sound instanceof Float32Array ? [sound, sound] : sound;
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2 || channels.some((c) => !(c instanceof Float32Array) || c.length < 1 || c.length !== channels[0].length)) fail(`${name} 要是一个或两个一样长、不空的 32 位浮点声道`);
  if (!channels.every((c) => c.every(Number.isFinite))) fail(`${name} 里有不是有限数的采样（NaN 或无穷）`);
  return channels.length === 1 ? [channels[0], channels[0]] : channels;
};
/** 这张卡只做 48000 赫兹；采样率可以不写，写了就得是它 */
const checkRate = (rate) => { if (rate !== undefined && rate !== RATE) fail(`采样率只能是 ${RATE} 赫兹，给的是 ${rate}`); };

/**
 * ctx：用到 fps（"分子/分母"，帧每秒）和 seed（点击音色的噪声种子，不带当 0）；带 sampleRate 的话必须是 48000。
 * 参数和数据写法不对的（帧号、子帧相位、增益不是有限数或出了界，样本是空的或带 NaN、无穷，采样率不是 48000）一律报 usage.bad-argument。
 * mix、snap、audit 对事件是同一套校验：事件表里每一条（不带 audio 的也查）都得是对象，frame 是全片里的安全整数帧号，sub 不写或者是 [0, 1) 里的数值（字符串不收）；
 * snap、audit 的全片帧数从声音的长度换算。三个入口的 sampleRate 都可以不写，写了就得是 48000。
 * Handle.object：
 *   voices                 自带音色 { click, kick }，各是一段单声道样本。
 *   mix(events, { frames, bed, samples, sampleRate })
 *       events 是事件表（events/0.1，frames 取它自己的）或者事件条目的数组；只放带 audio 的条目，条目可带 sub（子帧相位）和 gainDb（这一条另加的增益）。
 *       audio 先在 samples（{ 名字: 单声道样本或 [左, 右] }）里找，再在自带音色里找，都没有报错。bed 是垫在下面的配乐（一个或两个声道），比全片长的截掉。
 *       每段音效乘 gainDb，尾巴 fadeMs 毫秒线性收到 0（被片尾截断的也收）；混完峰值超过 ceilingDb 时整体降增益到正好压线，不做限幅。
 *       返回 { channels: [左, 右], placements: [{ id, audio, frame, sub, sample, clippedTail }], peakDb, scaleDb }。
 *   onsets(channels)       起音的采样点下标：5 毫秒一步的能量（两个声道各自平方再平均，左右反相也不会抵消），比上一步涨得最多的那一步；涨幅不到全曲最大涨幅的 onsetFloor 倍的不算，50 毫秒内只认一个。准到一步（5 毫秒）。
 *   snap(frames, channels, { sampleRate }) 把每个帧号换成离它最近的起音所在的帧（四舍五入到整数帧）。
 *   audit(channels, events, { sampleRate }) 逐条量事件离最近的起音差几帧（正数是起音晚到）：返回 { total, hits, hitRate, baseline, rows: [{ id, frame, delta }] }；
 *       差不超过 toleranceFrames 算命中；baseline 是随机基线：全片的整数帧里，离某个起音不超过 toleranceFrames 的占多少。
 */
export function create(ctx, params) {
  const fps = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(String(ctx.fps));
  if (!fps) fail(`帧率要写成 "分子/分母"，给的是 ${JSON.stringify(ctx.fps)}`);
  checkRate(ctx.sampleRate);
  for (const key of ['gainDb', 'ceilingDb', 'fadeMs', 'toleranceFrames', 'onsetFloor']) if (typeof params?.[key] !== 'number' || !Number.isFinite(params[key])) fail(`参数 ${key} 要是有限的数，给的是 ${params?.[key]}`);
  if (params.toleranceFrames < 0 || params.fadeMs < 0 || !(params.onsetFloor > 0)) fail('toleranceFrames、fadeMs 不能是负数，onsetFloor 要大于 0');
  // perFrame 只用来把采样点换回帧号（给起音和审计）；帧号换采样点一律走 sampleAt
  const num = Number(fps[1]), den = Number(fps[2]), perFrame = (RATE * den) / num, sampleAt = (frames) => Math.round((frames * RATE * den) / num);
  const voices = { click: VOICES.click(ctx.seed ?? 0), kick: VOICES.kick() };
  /** 声音有多少帧：sampleAt 的反算，mix 按 frames 帧混出来的声音换回来还是 frames */
  const framesOf = (channels) => Math.round((stereoOf(channels, 'channels')[0].length * num) / (RATE * den));
  /** mix、snap、audit 共用的时刻校验。sub 先看类型：字符串 "0.5" 过得了大小比较，再被加号拼成 "10.5" */
  const checkTime = (frame, sub, frames, what) => {
    if (!Number.isSafeInteger(frame) || frame < 0 || frame >= frames) fail(`${what} 的帧号要是全片 0 到 ${frames - 1} 帧里的整数，给的是 ${frame}`);
    if (sub !== undefined && !(typeof sub === 'number' && sub >= 0 && sub < 1)) fail(`${what} 的 sub 要是 [0, 1) 里的数，给的是 ${JSON.stringify(sub)}`);
  };
  /** mix、audit 共用：整张事件表逐条校验（照下标走，数组里的空洞也拦得住），交回带 audio 的条目 */
  const entries = (events, frames) => {
    const list = Array.isArray(events) ? events : events?.events;
    if (!Array.isArray(list)) fail('events 要是事件条目的数组，或者带 events 数组的事件表');
    for (let i = 0; i < list.length; i++) {
      if (list[i] === null || typeof list[i] !== 'object' || Array.isArray(list[i])) fail(`第 ${i} 条事件要是一个对象`);
      checkTime(list[i].frame, list[i].sub, frames, `事件 ${list[i].id}`);
    }
    return list.filter((e) => e.audio !== undefined);
  };

  function mix(events, { frames = events?.frames, bed, samples = {}, sampleRate } = {}) {
    checkRate(sampleRate);
    if (!Number.isSafeInteger(frames) || frames < 1) fail(`frames 要是正整数帧数，给的是 ${frames}`);
    const length = sampleAt(frames), left = new Float32Array(length), right = new Float32Array(length);
    if (bed) stereoOf(bed, 'bed').forEach((c, k) => (k ? right : left).set(c.subarray(0, length)));
    const fade = Math.round((params.fadeMs / 1000) * RATE);
    const placements = entries(events, frames).map((e) => {
      const sound = Object.hasOwn(samples, e.audio) ? samples[e.audio] : Object.hasOwn(voices, e.audio) ? voices[e.audio] : fail(`事件 ${e.id} 要的声音 ${e.audio} 不在 samples 里，也不是自带音色（${Object.keys(voices).join('、')}）`);
      const [l, r] = stereoOf(sound, `声音 ${e.audio}`), sub = e.sub ?? 0;
      if (!Number.isFinite(e.gainDb ?? 0)) fail(`事件 ${e.id} 的 gainDb 要是有限的数，给的是 ${e.gainDb}`);
      const sample = sampleAt(e.frame + sub), n = Math.min(l.length, length - sample), g = gain(params.gainDb + (e.gainDb ?? 0));
      for (let i = 0; i < n; i++) {
        const env = g * Math.min(1, (n - i) / fade);
        left[sample + i] += l[i] * env;
        right[sample + i] += r[i] * env;
      }
      return { id: e.id, audio: e.audio, frame: e.frame, sub, sample, clippedTail: l.length - n };
    });
    let peak = 0;
    for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    const scale = Math.min(1, gain(params.ceilingDb) / peak);
    if (scale < 1) for (let i = 0; i < length; i++) { left[i] *= scale; right[i] *= scale; }
    return { channels: [left, right], placements, peakDb: 20 * Math.log10(peak * scale), scaleDb: 20 * Math.log10(scale) };
  }

  function onsets(channels) {
    // 能量按声道各自平方再平均，不先把左右加起来：左右反相的立体声加起来是 0，会把起音整个消掉
    const [l, r] = stereoOf(channels, 'channels'), steps = Math.floor(l.length / HOP), rise = new Float64Array(steps);
    let before = 0, top = 0;
    for (let k = 0; k < steps; k++) {
      let energy = 0;
      for (let i = k * HOP; i < (k + 1) * HOP; i++) energy += (l[i] * l[i] + r[i] * r[i]) / 2;
      rise[k] = Math.max(0, energy - before);
      top = Math.max(top, rise[k]);
      before = energy;
    }
    const out = [], near = 10; // 50 毫秒
    for (let k = 0; k < steps; k++) {
      if (rise[k] <= 0 || rise[k] < params.onsetFloor * top) continue;
      let best = true;
      for (let j = Math.max(0, k - near); j <= Math.min(steps - 1, k + near) && best; j++) best = rise[j] < rise[k] || (rise[j] === rise[k] && j >= k);
      if (best) out.push(k * HOP);
    }
    return out;
  }
  const onsetFrames = (channels) => onsets(channels).map((s) => s / perFrame);
  const nearest = (frame, list) => list.reduce((best, o) => (Math.abs(o - frame) < Math.abs(best - frame) ? o : best), Infinity);

  return {
    object: {
      voices, mix, onsets,
      snap(frames, channels, { sampleRate } = {}) {
        checkRate(sampleRate);
        const list = onsetFrames(channels), total = framesOf(channels);
        if (!Array.isArray(frames)) fail('snap 要的是帧号的数组');
        for (let i = 0; i < frames.length; i++) checkTime(frames[i], undefined, total, `snap 的第 ${i} 个帧号`);
        if (!list.length) fail('这段声音里没找到起音，吸不了');
        return frames.map((f) => Math.round(nearest(f, list)));
      },
      audit(channels, events, { sampleRate } = {}) {
        checkRate(sampleRate);
        const list = onsetFrames(channels), tol = params.toleranceFrames, frames = framesOf(channels);
        const rows = entries(events, frames).map((e) => ({ id: e.id, frame: e.frame, delta: nearest(e.frame + (e.sub ?? 0), list) - e.frame - (e.sub ?? 0) }));
        const hits = rows.filter((r) => Math.abs(r.delta) <= tol).length;
        let near = 0;
        for (let f = 0; f < frames; f++) if (Math.abs(nearest(f, list) - f) <= tol) near++;
        return { total: rows.length, hits, hitRate: rows.length ? hits / rows.length : 0, baseline: frames ? near / frames : 0, rows };
      },
    },
    dispose() {},
  };
}
