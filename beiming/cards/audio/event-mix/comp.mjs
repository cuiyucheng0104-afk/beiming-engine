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
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2) fail(`${name} 要是一个或两个一样长、不空的 32 位浮点声道`);
  // 照下标一个个看：some、every 会跳过数组里的空洞，少一轨的声道数组就混过去了
  for (let k = 0; k < channels.length; k++) {
    if (!(channels[k] instanceof Float32Array) || channels[k].length < 1 || channels[k].length !== channels[0].length) fail(`${name} 要是一个或两个一样长、不空的 32 位浮点声道`);
    if (!channels[k].every(Number.isFinite)) fail(`${name} 里有不是有限数的采样（NaN 或无穷）`);
  }
  return channels.length === 1 ? [channels[0], channels[0]] : channels;
};
/** 这张卡只做 48000 赫兹；采样率可以不写，写了就得是它 */
const checkRate = (rate) => { if (rate !== undefined && rate !== RATE) fail(`采样率只能是 ${RATE} 赫兹，给的是 ${rate}`); };
const isPlain = (o) => Object.prototype.toString.call(o) === '[object Object]';
const wholeFrames = (n) => (Number.isSafeInteger(n) && n >= 1 ? n : fail(`frames 要是正整数帧数，给的是 ${n}`));
/** mix、snap、audit 共用的选项校验：三个入口收同一份选项、各取各的，哪一项写了都得合法，不认识的才不管 */
const options = (opts = {}) => {
  if (!isPlain(opts)) fail('选项要是一个对象');
  checkRate(opts.sampleRate);
  // windowFrames 是正的有限数，0 也不收：零窗口等于不吸，不写 snap 就是了；toleranceFrames 可以是 0（一帧不差才算命中）
  if (opts.windowFrames !== undefined && !(Number.isFinite(opts.windowFrames) && opts.windowFrames > 0)) fail(`选项 windowFrames 要是大于 0 的有限数，给的是 ${opts.windowFrames}`);
  if (opts.toleranceFrames !== undefined && !(Number.isFinite(opts.toleranceFrames) && opts.toleranceFrames >= 0)) fail(`选项 toleranceFrames 要是不小于 0 的有限数，给的是 ${opts.toleranceFrames}`);
  if (opts.samples !== undefined && !isPlain(opts.samples)) fail('samples 要是 { 名字: 样本 } 的对象');
  return opts;
};
/** mix、snap、audit 共用的全片帧数：选项里的 frames 优先，其次是事件表自己写的，都没有才用声音的长度换算（mix 没有声音可量，必须给）；写了的都得是正的安全整数，被盖掉的也查 */
const filmFrames = (opts, events, fromSound) => {
  for (const n of [opts.frames, events?.frames]) if (n !== undefined) wholeFrames(n);
  return wholeFrames(opts.frames ?? events?.frames ?? fromSound);
};

/**
 * ctx：用到 fps（"分子/分母"，帧每秒）和 seed（点击音色的噪声种子，不带当 0）；带 sampleRate 的话必须是 48000。
 * 参数和数据写法不对的（帧号、子帧相位、增益不是有限数或出了界，样本是空的或带 NaN、无穷，采样率不是 48000）一律报 usage.bad-argument。
 * mix、audit 收事件表或事件条目的数组，snap 收帧号的数组，时刻是同一套校验：事件表里每一条（不带 audio 的也查）都得是对象，frame 是全片里的安全整数帧号，sub 不写或者是 [0, 1) 里的数值（字符串不收）。
 * 全片帧数三个入口是同一个来源：选项里的 frames，没有就是事件表自己的 frames，都没有时 snap、audit 从声音的长度换算、mix 报错。正片可以比配乐短：片尾之后的事件报错；snap、audit 只在正片那一段声音里找起音，片尾之后的采样不参与（门槛也不看它）。
 * 选项三个入口可以给同一份，要是对象：frames、sampleRate（可以不写，写了就得是 48000）、windowFrames（snap 用，大于 0 的有限数）、toleranceFrames（audit 用，不小于 0 的有限数），写了的在哪个入口都查。
 * 声道数组要密实：两个声道缺一个（数组里有空洞）报错，不拿另一个顶上。
 * Handle.object：
 *   voices                 自带音色 { click, kick }，各是一段单声道样本。
 *   mix(events, { frames, bed, samples, sampleRate })
 *       events 是事件表（events/0.1，frames 取它自己的）或者事件条目的数组；只放带 audio 的条目，条目可带 sub（子帧相位）和 gainDb（这一条另加的增益）。
 *       audio 先在 samples（{ 名字: 单声道样本或 [左, 右] }）里找，再在自带音色里找，都没有报错。bed 是垫在下面的配乐（一个或两个声道），比全片长的截掉。
 *       每段音效乘 gainDb，尾巴 fadeMs 毫秒线性收到 0（被片尾截断的也收）；混完峰值超过 ceilingDb 时整体降增益到正好压线，不做限幅。
 *       返回 { channels: [左, 右], placements: [{ id, audio, frame, sub, sample, clippedTail }], peakDb, scaleDb }。
 *   onsets(channels)       起音的采样点下标：5 毫秒一步的能量（两个声道各自平方再平均，左右反相也不会抵消），比上一步涨得最多的那一步；涨幅是每个采样点的平均能量涨了多少，不到全曲最大涨幅的 onsetFloor 倍的不算，50 毫秒内只认一个。准到一步（5 毫秒）；声音末尾连着的 0（两个声道都是 0）先剥掉，后面多几帧少几帧静音找到的是同一批起音；剩下的声音末尾不满一步的那一段也算一步，它和紧邻前一步里最响的同样长的一段比：垫着底音的点击找得到，一直响着的长音不多出起音。
 *   snap(frames, channels, { frames, windowFrames, sampleRate })
 *       把每个帧号换成离它最近的起音所在的帧（四舍五入到整数帧，起音在最后半帧里的收在最后一帧）；交回的帧号都在全片里，可以直接交给同一片长的 mix、audit。
 *       给了 windowFrames 时，要挪的帧数超过它的帧号留在原地；选项里的 frames 是全片帧数。
 *   audit(channels, events, { frames, toleranceFrames, sampleRate })
 *       逐条量事件离最近的起音差几帧（正数是起音晚到；照采样点算，事件的落点和 mix 是同一个，混在起音上的差值正好是 0）：返回 { total, hits, hitRate, baseline, rows: [{ id, frame, delta }] }；
 *       差不超过 toleranceFrames（选项里的优先，没有用参数的）算命中；baseline 是随机基线：全片每个整数帧各放一个事件时的命中率，和逐条审计是同一个判据。
 */
export function create(ctx, params) {
  const fps = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(String(ctx?.fps));
  if (!fps) fail(`帧率要写成 "分子/分母"，给的是 ${JSON.stringify(ctx?.fps)}`);
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

  function mix(events, opts) {
    const o = options(opts), { bed, samples = {} } = o, frames = filmFrames(o, events), length = sampleAt(frames);
    let left, right;
    try { left = new Float32Array(length); right = new Float32Array(length); } catch { fail(`全片 ${frames} 帧的声音太长，开不出这么大的缓冲`); }
    if (bed !== undefined) stereoOf(bed, 'bed').forEach((c, k) => (k ? right : left).set(c.subarray(0, length)));
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
    // 步数向上取整：声音不是整数步时最后那一步不满，那里的起音也算（25 帧的正片是 50000 个采样点，最后一步只有 80 个）
    // 涨幅一律除以这一步的采样数，是「每个采样点的平均能量涨了多少」：80 个采样点的片尾和 240 个的整步才能放在同一个门槛下比
    // 不满的那一步不和前一整步比（长短不一样，长音的瞬时起伏会变成假起音）：和紧邻前一步里任何一段同样长的采样比，
    // 比其中最响的那段还多出来的才算涨。长音的起伏前一步里都出现过，多不出来；只看前一步，和整步的参照是同一段，不越过静音去拿更早的声音
    // 末尾连着的 0 先剥掉再分步：同一段声音后面接多少静音，分出来的步都一样（不然静音把最后一步凑满，平均涨幅被摊薄，门槛边上的起音时有时无）
    // shortcut: 最后一步不满时（片尾切在一步中间，或者最后一个声音停在一步中间、后面只剩 0），落在里面的短声音平均下来比落在整步里重 240 ÷ 这一步采样数 倍；要不分位置一样重时改成滑动的整步窗
    const [l, r] = stereoOf(channels, 'channels');
    let total = l.length;
    while (total > 0 && l[total - 1] === 0 && r[total - 1] === 0) total--;
    const steps = Math.ceil(total / HOP), rise = new Float64Array(steps);
    const power = (i) => (l[i] * l[i] + r[i] * r[i]) / 2;
    let before = 0, top = 0;
    for (let k = 0; k < steps; k++) {
      const start = k * HOP, end = Math.min(start + HOP, total), n = end - start;
      let energy = 0;
      for (let i = start; i < end; i++) energy += power(i);
      if (n < HOP && k > 0) {
        const from = Math.max(0, start - HOP);
        let run = 0;
        before = 0;
        for (let i = from; i < start; i++) {
          run += power(i) - (i - n >= from ? power(i - n) : 0);
          if (i - n + 1 >= from) before = Math.max(before, run);
        }
      }
      rise[k] = Math.max(0, energy - before) / n;
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
  /** 正片里的起音（采样点）。先把声音截到正片的长度再找：正片比配乐短时片尾之后的观众听不到，那里再响也不该抬高门槛、压掉片内的起音 */
  const onsetsIn = (channels, frames) => onsets(stereoOf(channels, 'channels').map((c) => c.subarray(0, sampleAt(frames))));
  /** 起音在第几帧（带小数） */
  const onsetFrames = (channels, frames) => onsetsIn(channels, frames).map((s) => s / perFrame);
  const nearest = (frame, list) => list.reduce((best, o) => (Math.abs(o - frame) < Math.abs(best - frame) ? o : best), Infinity);
  /** [lo, hi] 里第一个让 ok 成立的整数（ok 在这一段里先不成立后成立），都不成立交回 hi + 1 */
  const first = (lo, hi, ok) => {
    while (lo <= hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (ok(mid)) hi = mid - 1; else lo = mid + 1;
    }
    return lo;
  };

  return {
    object: {
      voices, mix, onsets,
      snap(frames, channels, opts) {
        const o = options(opts), { windowFrames = Infinity } = o, total = filmFrames(o, undefined, framesOf(channels)), list = onsetFrames(channels, total);
        if (!Array.isArray(frames)) fail('snap 要的是帧号的数组');
        for (let i = 0; i < frames.length; i++) checkTime(frames[i], undefined, total, `snap 的第 ${i} 个帧号`);
        if (!list.length) fail('这段声音在全片里没找到起音，吸不了');
        // 起音在最后半帧里时四舍五入会进到片尾之后的那一帧，收回最后一帧
        return frames.map((f) => {
          const to = Math.min(total - 1, Math.round(nearest(f, list)));
          return Math.abs(to - f) <= windowFrames ? to : f;
        });
      },
      audit(channels, events, opts) {
        const o = options(opts), { toleranceFrames: tol = params.toleranceFrames } = o, frames = filmFrames(o, events, framesOf(channels)), found = onsetsIn(channels, frames);
        // 逐条审计和随机基线共用的判据。差值照采样点算，事件的落点和 mix 是同一个 sampleAt：混在起音上的事件差值正好是 0，不留先减帧号再减子帧的浮点尾数
        const offset = (at, onset) => (onset - at) / perFrame, hit = (at, onset) => Math.abs(offset(at, onset)) <= tol;
        const rows = entries(events, frames).map((e) => { const at = sampleAt(e.frame + (e.sub ?? 0)); return { id: e.id, frame: e.frame, delta: offset(at, nearest(at, found)) }; });
        const hits = rows.filter((r) => Math.abs(r.delta) <= tol).length;
        // 随机基线：全片每个整数帧各放一个事件时的命中率，和上面是同一个 hit、同一个落点，分数帧率、一帧不差时两边也是同一个数。
        // 不逐帧扫（全片可以比声音长很多）：落点跟着帧号只增不减，一个起音命中的帧是连着的一段，两头用二分找；起音从早到晚，盖过的不重数
        let near = 0, from = 0;
        for (const onset of found) {
          const after = first(from, frames - 1, (f) => sampleAt(f) > onset);
          const lo = first(from, after - 1, (f) => hit(sampleAt(f), onset)), end = first(after, frames - 1, (f) => !hit(sampleAt(f), onset));
          near += end - lo;
          from = end;
        }
        return { total: rows.length, hits, hitRate: rows.length ? hits / rows.length : 0, baseline: near / frames, rows };
      },
    },
    dispose() {},
  };
}
