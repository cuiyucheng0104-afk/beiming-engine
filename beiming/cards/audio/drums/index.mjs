// audio.drums 在合成一侧的实现：
// 1. 纯数学振荡器 + Mulberry32 确定性伪随机噪声合成 48000 Hz 32-bit 浮点鼓组与工业机械重音（kick/snare/hihat/rim/accent），零外部音频素材依赖；
// 2. 时刻到采样点换算严格遵循 round((frame + sub) × 48000 × 分母 ÷ 分子)，支持等功率立体声声像 pan ∈ [-1, 1]；
// 3. 混音后若峰值超过 ceilingDb 则整轨等比下压防削波，并交出按帧号与 id 排好序的 events/0.1 事件条目与逐帧能量读数。

const node = globalThis.process;
const isProxy = node?.versions?.node
  ? (node.getBuiltinModule?.('node:util/types') ?? await import('node:util/types')).isProxy
  : () => false;

export const SAMPLE_RATE = 48000;
export const VOICE_NAMES = Object.freeze(['kick', 'snare', 'hihat', 'rim', 'accent']);
const HIT_ID_RE = /^[a-z][a-z0-9_-]*$/;
const FPS_RE = /^([1-9][0-9]*)\/([1-9][0-9]*)$/;

const fail = (message) => {
  throw Object.assign(new RangeError(`audio.drums：${message}`), { code: 'usage.bad-argument' });
};

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || isProxy(v) || Array.isArray(v) || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function snapValue(what, v, depth = 0) {
  if (depth > 16) fail(`${what} 嵌套层级过深`);
  if (v === null || v === undefined || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail(`${what} 必须是有限数，给的是 ${v}`);
    return v;
  }
  if (typeof v !== 'object') fail(`${what} 类型不合法（${typeof v}）`);
  if (isProxy(v)) fail(`${what} 不能是 Proxy`);
  if (Array.isArray(v)) {
    if (Object.getPrototypeOf(v) !== Array.prototype) fail(`${what} 必须是普通数组`);
    const props = Object.getOwnPropertyDescriptors(v);
    const keys = Reflect.ownKeys(props);
    const n = props.length?.value;
    if (!Number.isInteger(n) || keys.length !== n + 1) fail(`${what} 不能是稀疏数组或带额外属性`);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const d = props[i];
      if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) fail(`${what}[${i}] 必须是可枚举的自有数据属性`);
      out[i] = snapValue(`${what}[${i}]`, d.value, depth + 1);
    }
    return out;
  }
  if (!isPlainObject(v)) fail(`${what} 必须是普通对象`);
  const props = Object.getOwnPropertyDescriptors(v);
  const keys = Reflect.ownKeys(props);
  const out = {};
  for (const k of keys) {
    if (typeof k !== 'string') fail(`${what} 不能包含 Symbol 键`);
    const d = props[k];
    if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) fail(`${what}.${k} 不能是访问器或不可枚举属性`);
    out[k] = snapValue(`${what}.${k}`, d.value, depth + 1);
  }
  return out;
}

function checkAllowedKeys(what, obj, allowed) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) fail(`${what} 包含未声明的键 ${JSON.stringify(k)}`);
  }
}

const dbToGain = (db) => 10 ** (db / 20);
const gainToDb = (g) => (g <= 1e-12 ? -240 : 20 * Math.log10(g));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2147483648 - 1;
  };
}

function parseFps(fpsStr) {
  if (typeof fpsStr !== 'string') fail(`fps 必须是 "分子/分母" 字符串，给的是 ${JSON.stringify(fpsStr)}`);
  const m = FPS_RE.exec(fpsStr);
  if (!m) fail(`fps 格式不合法：${JSON.stringify(fpsStr)}`);
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0) {
    fail(`fps 分子分母必须是正整数：${fpsStr}`);
  }
  return [num, den];
}

/**
 * 合成单个打击乐或机械重音音色（48000 Hz 单声道 Float32Array）。
 */
export function synthesizeVoice(rawVoice, rawOpts = {}) {
  const voice = snapValue('voice', rawVoice);
  const opts = snapValue('opts', rawOpts);
  if (typeof voice !== 'string' || !VOICE_NAMES.includes(voice)) {
    fail(`未知音色 ${JSON.stringify(voice)}，允许值为 ${VOICE_NAMES.join('/')}`);
  }
  if (!isPlainObject(opts)) fail('opts 必须是普通对象');
  checkAllowedKeys('opts', opts, ['seed', 'velocity', 'sampleRate']);
  if (opts.sampleRate !== undefined && opts.sampleRate !== SAMPLE_RATE) {
    fail(`采样率只能是 ${SAMPLE_RATE} Hz，给的是 ${opts.sampleRate}`);
  }
  const seed = opts.seed ?? 0;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    fail(`seed 必须是 [0, 4294967295] 内的整数，给的是 ${seed}`);
  }
  const velocity = opts.velocity ?? 1;
  if (!(typeof velocity === 'number' && velocity > 0 && velocity <= 2)) {
    fail(`velocity 必须在 (0, 2] 内，给的是 ${velocity}`);
  }

  let length = 0;
  let out;

  if (voice === 'kick') {
    // 220 ms 指数扫频底鼓（156 Hz -> 46 Hz）+ 瞬态鼓槌击打，纯确定性相位积分
    length = Math.round(0.22 * SAMPLE_RATE);
    out = new Float32Array(length);
    let phase = 0;
    let clickPhase = 0;
    for (let i = 0; i < length; i++) {
      const freq = 46 + 112 * Math.exp(-i / (0.028 * SAMPLE_RATE));
      phase += (2 * Math.PI * freq) / SAMPLE_RATE;
      clickPhase += (2 * Math.PI * 1650) / SAMPLE_RATE;
      const body = Math.sin(phase) * Math.exp(-i / (0.065 * SAMPLE_RATE));
      const click = 0.22 * Math.sin(clickPhase) * Math.exp(-i / (0.0018 * SAMPLE_RATE));
      out[i] = (body + click) * velocity;
    }
  } else if (voice === 'snare') {
    // 180 ms 军鼓：双腔体谐振（185 Hz + 330 Hz）+ 带种子沙带噪声
    length = Math.round(0.18 * SAMPLE_RATE);
    out = new Float32Array(length);
    const rnd = mulberry32((seed ^ 0x534e4152) >>> 0);
    let p1 = 0;
    let p2 = 0;
    let prevNoise = 0;
    for (let i = 0; i < length; i++) {
      p1 += (2 * Math.PI * (185 + 45 * Math.exp(-i / (0.012 * SAMPLE_RATE)))) / SAMPLE_RATE;
      p2 += (2 * Math.PI * 330) / SAMPLE_RATE;
      const tone = (0.45 * Math.sin(p1) + 0.25 * Math.sin(p2)) * Math.exp(-i / (0.028 * SAMPLE_RATE));
      const rawN = rnd();
      const hpNoise = rawN - 0.55 * prevNoise;
      prevNoise = rawN;
      const wire = 0.55 * hpNoise * Math.exp(-i / (0.045 * SAMPLE_RATE));
      out[i] = (tone + wire) * velocity;
    }
  } else if (voice === 'hihat') {
    // 75 ms 踩镲：6 个非谐金属方波簇 + 高通噪声瞬态
    length = Math.round(0.075 * SAMPLE_RATE);
    out = new Float32Array(length);
    const rnd = mulberry32((seed ^ 0x48484154) >>> 0);
    const ratios = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];
    const phases = new Float64Array(ratios.length);
    let prev = 0;
    for (let i = 0; i < length; i++) {
      let metal = 0;
      for (let k = 0; k < ratios.length; k++) {
        phases[k] += (2 * Math.PI * ratios[k] * 6.2) / SAMPLE_RATE;
        metal += Math.sin(phases[k]) >= 0 ? 1 : -1;
      }
      metal /= ratios.length;
      const raw = 0.5 * metal + 0.5 * rnd();
      const hp = raw - 0.78 * prev;
      prev = raw;
      out[i] = hp * Math.exp(-i / (0.016 * SAMPLE_RATE)) * velocity;
    }
  } else if (voice === 'rim') {
    // 45 ms 机械卡扣 / 鼓边敲击（820 Hz + 1960 Hz + 3400 Hz 短促谐振）
    length = Math.round(0.045 * SAMPLE_RATE);
    out = new Float32Array(length);
    const rnd = mulberry32((seed ^ 0x52494d53) >>> 0);
    for (let i = 0; i < length; i++) {
      const t = i / SAMPLE_RATE;
      const tone = 0.55 * Math.sin(2 * Math.PI * 820 * t) * Math.exp(-i / (0.008 * SAMPLE_RATE))
        + 0.35 * Math.sin(2 * Math.PI * 1960 * t) * Math.exp(-i / (0.0045 * SAMPLE_RATE))
        + 0.25 * Math.sin(2 * Math.PI * 3400 * t) * Math.exp(-i / (0.002 * SAMPLE_RATE));
      const snap = 0.35 * rnd() * Math.exp(-i / (0.0015 * SAMPLE_RATE));
      out[i] = (tone + snap) * velocity;
    }
  } else {
    // accent：260 ms 工业重音（62 Hz 低频重锤 + 1240 Hz 金属共鸣 + 瞬态冲击）
    length = Math.round(0.26 * SAMPLE_RATE);
    out = new Float32Array(length);
    const rnd = mulberry32((seed ^ 0x41434e54) >>> 0);
    let subPhase = 0;
    for (let i = 0; i < length; i++) {
      const t = i / SAMPLE_RATE;
      const freq = 58 + 96 * Math.exp(-i / (0.022 * SAMPLE_RATE));
      subPhase += (2 * Math.PI * freq) / SAMPLE_RATE;
      const sub = 0.65 * Math.sin(subPhase) * Math.exp(-i / (0.08 * SAMPLE_RATE));
      const clang = 0.3 * Math.sin(2 * Math.PI * 1240 * t + 1.5 * Math.sin(2 * Math.PI * 710 * t)) * Math.exp(-i / (0.032 * SAMPLE_RATE));
      const burst = 0.35 * rnd() * Math.exp(-i / (0.006 * SAMPLE_RATE));
      out[i] = (sub + clang + burst) * velocity;
    }
  }

  // 尾部 2 ms (96 采样) 余弦渐隐防截断毛刺，并消除 -0
  const fadeSamples = Math.min(96, Math.floor(length / 4));
  for (let k = 0; k < fadeSamples; k++) {
    const idx = length - 1 - k;
    const v = out[idx] * (k / fadeSamples);
    out[idx] = v === 0 ? 0 : v;
  }
  return out;
}

/**
 * 依据节拍与打击点表渲染整条 48000 Hz 立体声鼓轨。
 */
export function renderDrums(rawSpec = {}) {
  const spec = snapValue('spec', rawSpec);
  if (!isPlainObject(spec)) fail('renderDrums 参数必须是普通对象');
  checkAllowedKeys('spec', spec, ['fps', 'frames', 'shotIn', 'seed', 'pattern', 'gainDb', 'ceilingDb', 'sampleRate']);

  if (spec.sampleRate !== undefined && spec.sampleRate !== SAMPLE_RATE) {
    fail(`sampleRate 只能是 ${SAMPLE_RATE} Hz，给的是 ${spec.sampleRate}`);
  }
  const [num, den] = parseFps(spec.fps ?? '24/1');
  const frames = spec.frames ?? 48;
  if (!Number.isSafeInteger(frames) || frames < 1) {
    fail(`frames 必须是正整数帧数，给的是 ${frames}`);
  }
  const shotIn = spec.shotIn ?? 0;
  if (!Number.isSafeInteger(shotIn) || shotIn < 0) {
    fail(`shotIn 必须是非负整数，给的是 ${shotIn}`);
  }
  const seed = spec.seed ?? 0;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    fail(`seed 必须是 [0, 4294967295] 内的整数，给的是 ${seed}`);
  }

  const gainDb = spec.gainDb ?? -3;
  const ceilingDb = spec.ceilingDb ?? -1;
  if (!(typeof gainDb === 'number' && gainDb >= -60 && gainDb <= 12)) {
    fail(`gainDb 必须在 [-60, 12] 内，给的是 ${gainDb}`);
  }
  if (!(typeof ceilingDb === 'number' && ceilingDb >= -24 && ceilingDb <= 0)) {
    fail(`ceilingDb 必须在 [-24, 0] 内，给的是 ${ceilingDb}`);
  }

  const pattern = spec.pattern ?? {};
  if (!isPlainObject(pattern)) fail('pattern 必须是普通对象');
  checkAllowedKeys('pattern', pattern, ['bpm', 'stepsPerBeat', 'hits']);
  if (pattern.bpm !== undefined && !(typeof pattern.bpm === 'number' && pattern.bpm >= 20 && pattern.bpm <= 300)) {
    fail(`pattern.bpm 必须在 [20, 300] 内，给的是 ${pattern.bpm}`);
  }
  if (pattern.stepsPerBeat !== undefined && (!Number.isInteger(pattern.stepsPerBeat) || pattern.stepsPerBeat < 1 || pattern.stepsPerBeat > 16)) {
    fail(`pattern.stepsPerBeat 必须是 [1, 16] 内的整数，给的是 ${pattern.stepsPerBeat}`);
  }

  const rawHits = pattern.hits;
  if (!Array.isArray(rawHits) || rawHits.length < 1) {
    fail('pattern.hits 必须是至少含一项打击点的数组');
  }

  const totalSamples = Math.round((frames * SAMPLE_RATE * den) / num);
  const left = new Float32Array(totalSamples);
  const right = new Float32Array(totalSamples);
  const linearGain = dbToGain(gainDb);

  const seenIds = new Set();
  const placements = [];
  const events = [];

  for (let i = 0; i < rawHits.length; i++) {
    const h = rawHits[i];
    if (!isPlainObject(h)) fail(`hits[${i}] 必须是普通对象`);
    checkAllowedKeys(`hits[${i}]`, h, ['id', 'voice', 'frame', 'sub', 'velocity', 'pan']);
    if (typeof h.id !== 'string' || !HIT_ID_RE.test(h.id)) {
      fail(`hits[${i}].id ${JSON.stringify(h.id)} 不合法`);
    }
    if (seenIds.has(h.id)) fail(`hits 中存在重复的 id ${JSON.stringify(h.id)}`);
    seenIds.add(h.id);
    if (typeof h.voice !== 'string' || !VOICE_NAMES.includes(h.voice)) {
      fail(`hits[${i}].voice ${JSON.stringify(h.voice)} 不合法`);
    }
    if (!Number.isSafeInteger(h.frame) || h.frame < 0 || h.frame >= frames) {
      fail(`hits[${i}] (${h.id}) 的 frame ${h.frame} 超出有效帧范围 [0, ${frames})`);
    }
    const sub = h.sub ?? 0;
    if (!(typeof sub === 'number' && sub >= 0 && sub < 1)) {
      fail(`hits[${i}] (${h.id}) 的 sub 必须在 [0, 1) 内，给的是 ${sub}`);
    }
    const velocity = h.velocity ?? 1;
    if (!(typeof velocity === 'number' && velocity > 0 && velocity <= 2)) {
      fail(`hits[${i}] (${h.id}) 的 velocity 必须在 (0, 2] 内，给的是 ${velocity}`);
    }
    const pan = h.pan ?? 0;
    if (!(typeof pan === 'number' && pan >= -1 && pan <= 1)) {
      fail(`hits[${i}] (${h.id}) 的 pan 必须在 [-1, 1] 内，给的是 ${pan}`);
    }

    const startSample = Math.round(((h.frame + sub) * SAMPLE_RATE * den) / num);
    const hitSeed = ((seed + Math.imul(i + 1, 0x9e3779b1)) >>> 0);
    const mono = synthesizeVoice(h.voice, { seed: hitSeed, velocity });

    // 等功率立体声声像
    const angle = ((pan + 1) * Math.PI) / 4;
    const gainL = Math.cos(angle) * linearGain;
    const gainR = Math.sin(angle) * linearGain;

    const avail = Math.max(0, Math.min(mono.length, totalSamples - startSample));
    const clippedTail = avail < mono.length;
    const tailFade = Math.min(96, Math.floor(avail / 4));

    for (let s = 0; s < avail; s++) {
      let env = 1;
      if (clippedTail && tailFade > 0 && s >= avail - tailFade) {
        env = (avail - 1 - s) / tailFade;
      }
      const v = mono[s] * env;
      left[startSample + s] += v * gainL;
      right[startSample + s] += v * gainR;
    }

    placements.push({
      id: h.id,
      voice: h.voice,
      frame: h.frame,
      filmFrame: shotIn + h.frame,
      sub,
      sample: startSample,
      velocity,
      pan,
      clippedTail,
    });

    events.push({
      id: h.id,
      frame: shotIn + h.frame,
      sub,
      kind: 'named',
      from: 'film',
      audio: h.voice,
      sync: 'onset',
    });
  }

  events.sort((a, b) => a.frame - b.frame || a.sub - b.sub || (a.id < b.id ? -1 : 1));

  let peak = 0;
  for (let i = 0; i < totalSamples; i++) {
    const al = Math.abs(left[i]);
    const ar = Math.abs(right[i]);
    if (al > peak) peak = al;
    if (ar > peak) peak = ar;
  }

  const ceilingLinear = dbToGain(ceilingDb);
  let scale = 1;
  if (peak > ceilingLinear && peak > 0) {
    scale = ceilingLinear / peak;
    for (let i = 0; i < totalSamples; i++) {
      left[i] *= scale;
      right[i] *= scale;
    }
    peak *= scale;
  }

  return {
    sampleRate: SAMPLE_RATE,
    channels: [left, right],
    placements,
    events,
    peakDb: gainToDb(peak),
    scaleDb: gainToDb(scale),
  };
}

/**
 * 卡主入口 create(ctx, params)
 */
export function create(rawCtx = {}, rawParams = {}) {
  const ctx = snapValue('ctx', rawCtx);
  const params = snapValue('params', rawParams);
  if (!isPlainObject(ctx)) fail('ctx 必须是普通对象');
  checkAllowedKeys('ctx', ctx, ['fps', 'frames', 'seed', 'shot', 'sampleRate']);
  if (!isPlainObject(params)) fail('params 必须是普通对象');
  checkAllowedKeys('params', params, ['pattern', 'gainDb', 'ceilingDb']);

  const fps = ctx.fps ?? '24/1';
  const [num, den] = parseFps(fps);
  const shotIn = ctx.shot?.in ?? 0;
  const frames = ctx.frames ?? ctx.shot?.frames ?? 48;
  const seed = ctx.seed ?? 0;

  const pattern = params.pattern ?? {
    bpm: 120,
    stepsPerBeat: 4,
    hits: [
      { id: 'beat-0-kick', voice: 'kick', frame: 0, sub: 0, velocity: 1, pan: 0 },
      { id: 'beat-1-hihat', voice: 'hihat', frame: Math.min(6, frames - 1), sub: 0, velocity: 0.65, pan: -0.2 },
    ],
  };

  const rendered = renderDrums({
    fps,
    frames,
    shotIn,
    seed,
    pattern,
    gainDb: params.gainDb ?? -3,
    ceilingDb: params.ceilingDb ?? -1,
    sampleRate: ctx.sampleRate,
  });

  function frameWindow(f) {
    if (!Number.isSafeInteger(f) || f < 0 || f >= frames) {
      fail(`帧号 f 必须在 [0, ${frames}) 内，给的是 ${f}`);
    }
    const s0 = Math.round((f * SAMPLE_RATE * den) / num);
    const s1 = Math.min(rendered.channels[0].length, Math.round(((f + 1) * SAMPLE_RATE * den) / num));
    return [s0, s1];
  }

  function sliceFrame(f) {
    const [s0, s1] = frameWindow(f);
    return [
      rendered.channels[0].slice(s0, s1),
      rendered.channels[1].slice(s0, s1),
    ];
  }

  return {
    object: {
      sampleRate: SAMPLE_RATE,
      channels: rendered.channels,
      placements: rendered.placements,
      events: rendered.events,
      peakDb: rendered.peakDb,
      scaleDb: rendered.scaleDb,
      synthesizeVoice,
      render: renderDrums,
      sliceFrame,
    },
    meta(f) {
      const [s0, s1] = frameWindow(f);
      const left = rendered.channels[0];
      const right = rendered.channels[1];
      let sumSq = 0;
      let peak = 0;
      const count = Math.max(1, s1 - s0);
      for (let i = s0; i < s1; i++) {
        const l = left[i];
        const r = right[i];
        sumSq += 0.5 * (l * l + r * r);
        const m = Math.max(Math.abs(l), Math.abs(r));
        if (m > peak) peak = m;
      }
      const hitCount = rendered.placements.filter((p) => p.frame === f).length;
      return {
        readings: {
          rms: Math.sqrt(sumSq / count),
          peak,
          hitCount,
        },
      };
    },
    dispose() {},
  };
}
