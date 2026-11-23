// blur.subframe 在 three 帧源里的底层机制实现（visibleToAgent = false）：
// 1. 按 shutterAngleDeg（0..360°）与子帧数 samples（1..64）生成分层中点采样时刻表；
// 2. 开启 clampToShot（默认 true）时，把快门采样区间严格钳制在当前镜头 [shot.in, shot.in + shot.frames) 内，
//    确保切点后首帧（f = shot.in）绝不向前跨切点采样上一镜头，从根源上消除切点重影（O9 cut.ghost = 0）；
// 3. 在色调映射之前的场景线性光空间（32 位浮点 Float32Array RGBA）中做逐子帧加权平均。

const node = globalThis.process;
const isProxy = node?.versions?.node
  ? (node.getBuiltinModule?.('node:util/types') ?? await import('node:util/types')).isProxy
  : () => false;

const ALIGNMENTS = Object.freeze(['centered', 'forward', 'backward']);

const fail = (message) => {
  throw Object.assign(new RangeError(`blur.subframe：${message}`), { code: 'usage.bad-argument' });
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
  if (v instanceof Float32Array) {
    if (isProxy(v.buffer) || Object.getPrototypeOf(v) !== Float32Array.prototype) fail(`${what} 必须是原生 Float32Array`);
    for (let i = 0; i < v.length; i++) {
      if (!Number.isFinite(v[i])) fail(`${what}[${i}] 不能是 NaN 或 Infinity`);
    }
    return new Float32Array(v);
  }
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

/**
 * 计算第 frame 帧在镜头区间 shot 内的确定性子帧采样时刻表。
 */
export function subframeTimes(rawFrame, rawShot = { in: 0, frames: 48 }, rawOpts = {}) {
  const frame = snapValue('frame', rawFrame);
  const shot = snapValue('shot', rawShot);
  const opts = snapValue('opts', rawOpts);

  if (!Number.isSafeInteger(frame) || frame < 0) {
    fail(`frame 必须是非负整数帧号，给的是 ${frame}`);
  }
  if (!isPlainObject(shot)) fail('shot 必须是 { in, frames } 普通对象');
  checkAllowedKeys('shot', shot, ['in', 'frames', 'id']);
  const shotIn = shot.in ?? 0;
  const shotFrames = shot.frames ?? 48;
  if (!Number.isSafeInteger(shotIn) || shotIn < 0) fail(`shot.in 必须是非负整数，给的是 ${shotIn}`);
  if (!Number.isSafeInteger(shotFrames) || shotFrames < 1) fail(`shot.frames 必须是正整数，给的是 ${shotFrames}`);
  const shotOut = shotIn + shotFrames;

  if (frame < shotIn || frame >= shotOut) {
    fail(`frame ${frame} 不在当前镜头区间 [${shotIn}, ${shotOut}) 内`);
  }

  if (!isPlainObject(opts)) fail('opts 必须是普通对象');
  checkAllowedKeys('opts', opts, ['shutterAngleDeg', 'samples', 'clampToShot', 'alignment']);

  const shutterAngleDeg = opts.shutterAngleDeg ?? 180;
  const samples = opts.samples ?? 8;
  const clampToShot = opts.clampToShot ?? true;
  const alignment = opts.alignment ?? 'centered';

  if (!(typeof shutterAngleDeg === 'number' && shutterAngleDeg >= 0 && shutterAngleDeg <= 360)) {
    fail(`shutterAngleDeg 必须在 [0, 360] 内，给的是 ${shutterAngleDeg}`);
  }
  if (!Number.isInteger(samples) || samples < 1 || samples > 64) {
    fail(`samples 必须是 [1, 64] 内的整数，给的是 ${samples}`);
  }
  if (typeof clampToShot !== 'boolean') fail('clampToShot 必须是布尔值');
  if (!ALIGNMENTS.includes(alignment)) {
    fail(`alignment 只能是 ${ALIGNMENTS.join('/')}，给的是 ${JSON.stringify(alignment)}`);
  }

  const span = shutterAngleDeg / 360;
  if (samples === 1 || span === 0) {
    return [
      {
        index: 0,
        t: frame,
        frame,
        sub: 0,
        weight: 1,
        clamped: false,
        inShot: true,
      },
    ];
  }

  let rawStart;
  let rawEnd;
  if (alignment === 'forward') {
    rawStart = frame;
    rawEnd = frame + span;
  } else if (alignment === 'backward') {
    rawStart = frame - span;
    rawEnd = frame;
  } else {
    rawStart = frame - span * 0.5;
    rawEnd = frame + span * 0.5;
  }

  const maxValidTime = shotOut - 1e-6;
  const weight = 1 / samples;
  const out = [];

  for (let i = 0; i < samples; i++) {
    const u = (i + 0.5) / samples;
    const rawT = rawStart + u * (rawEnd - rawStart);
    let t = rawT;
    let clamped = false;

    if (clampToShot) {
      // 若快门窗口越过镜头起点 shotIn 或终点 shotOut，将快门窗口平移钳制在 [shotIn, shotOut) 内，
      // 既保证所有子帧严格落在当前镜头内（零跨切点采样），又保留子帧在窗口内的分层展开。
      let winStart = rawStart;
      let winEnd = rawEnd;
      if (winStart < shotIn) {
        winStart = shotIn;
        winEnd = Math.min(maxValidTime, shotIn + span);
      }
      if (winEnd > maxValidTime) {
        winEnd = maxValidTime;
        winStart = Math.max(shotIn, winEnd - span);
      }
      t = Math.max(shotIn, Math.min(maxValidTime, winStart + u * (winEnd - winStart)));
      clamped = Math.abs(t - rawT) > 1e-9;
    }

    const intFrame = Math.floor(t);
    const sub = Math.max(0, Math.min(1 - 1e-9, t - intFrame));
    out.push({
      index: i,
      t,
      frame: intFrame,
      sub,
      weight,
      clamped,
      inShot: t >= shotIn && t < shotOut,
    });
  }

  return out;
}

/**
 * 在场景线性光空间（Float32Array RGBA）对多张子帧做加权平均。
 */
export function accumulateLinear(rawSubframes) {
  const subframes = snapValue('subframes', rawSubframes);
  if (!Array.isArray(subframes) || subframes.length < 1) {
    fail('subframes 必须是非空数组');
  }

  const normalized = subframes.map((item, idx) => {
    if (item instanceof Float32Array) {
      return { rgba: item, weight: 1 };
    }
    if (isPlainObject(item) && item.rgba instanceof Float32Array) {
      checkAllowedKeys(`subframes[${idx}]`, item, ['rgba', 'weight']);
      const w = item.weight ?? 1;
      if (!(typeof w === 'number' && w > 0)) fail(`subframes[${idx}].weight 必须是正数`);
      return { rgba: item.rgba, weight: w };
    }
    fail(`subframes[${idx}] 必须是 Float32Array 或 { rgba: Float32Array, weight? }`);
  });

  const len = normalized[0].rgba.length;
  if (len < 4 || len % 4 !== 0) {
    fail(`线性 RGBA 缓冲长度必须是 4 的正整数倍，实际为 ${len}`);
  }

  let totalWeight = 0;
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i].rgba.length !== len) {
      fail(`subframes[${i}] 长度 ${normalized[i].rgba.length} 与首帧长度 ${len} 不一致`);
    }
    totalWeight += normalized[i].weight;
  }
  if (!(totalWeight > 0)) fail('子帧总权重必须大于 0');

  const acc = new Float64Array(len);
  for (let i = 0; i < normalized.length; i++) {
    const { rgba, weight } = normalized[i];
    for (let k = 0; k < len; k++) {
      acc[k] += rgba[k] * weight;
    }
  }
  const out = new Float32Array(len);
  for (let k = 0; k < len; k++) {
    const v = acc[k] / totalWeight;
    out[k] = v === 0 ? 0 : v;
  }
  return out;
}

/**
 * 测定切点后首帧线性缓冲 rawBlended 中混入上一镜头特征 rawPrevShot 的重影能量占比。
 */
export function measureCutGhosting(rawBlended, rawPrevShot, rawCurrShot) {
  const blended = snapValue('blended', rawBlended);
  const prevShot = snapValue('prevShot', rawPrevShot);
  const currShot = snapValue('currShot', rawCurrShot);
  if (!(blended instanceof Float32Array && prevShot instanceof Float32Array && currShot instanceof Float32Array)) {
    fail('measureCutGhosting 的三个输入都必须是 Float32Array');
  }
  if (blended.length < 4 || blended.length % 4 !== 0 || blended.length !== prevShot.length || blended.length !== currShot.length) {
    fail('measureCutGhosting 的三个缓冲长度必须一致且为 4 的倍数');
  }

  let num = 0;
  let den = 0;
  let maxGhostDelta = 0;
  for (let i = 0; i < blended.length; i++) {
    if (i % 4 === 3) continue; // 只算 RGB 线性辐射亮度通道
    const diffPrev = prevShot[i] - currShot[i];
    const diffBlend = blended[i] - currShot[i];
    const absDelta = Math.abs(diffBlend);
    if (absDelta > maxGhostDelta) maxGhostDelta = absDelta;
    num += diffBlend * diffPrev;
    den += diffPrev * diffPrev;
  }

  const ghostRatio = den <= 1e-12 ? 0 : Math.max(0, num / den);
  return {
    ghostRatio: ghostRatio === 0 ? 0 : ghostRatio,
    maxGhostDelta: maxGhostDelta === 0 ? 0 : maxGhostDelta,
  };
}

/**
 * 按子帧时刻表调用 renderAtTime(t, sample) 并在场景线性光空间求平均。
 */
export function renderSubframeBlur(rawFrame, rawShot, renderAtTime, rawOpts = {}) {
  if (typeof renderAtTime !== 'function') {
    fail('renderAtTime 必须是渲染回调函数');
  }
  const schedule = subframeTimes(rawFrame, rawShot, rawOpts);
  const buffers = schedule.map((s) => {
    const buf = renderAtTime(s.t, s);
    return { rgba: buf, weight: s.weight };
  });
  const rgba = accumulateLinear(buffers);
  const clampedCount = schedule.filter((s) => s.clamped).length;
  const outOfShotCount = schedule.filter((s) => !s.inShot).length;
  return {
    frame: rawFrame,
    schedule,
    rgba,
    clampedCount,
    outOfShotCount,
  };
}

/**
 * 卡主入口 create(ctx, params)
 */
export function create(rawCtx = {}, rawParams = {}) {
  const ctx = snapValue('ctx', rawCtx);
  const params = snapValue('params', rawParams);
  if (!isPlainObject(ctx)) fail('ctx 必须是普通对象');
  checkAllowedKeys('ctx', ctx, ['shot', 'fps', 'size']);
  if (!isPlainObject(params)) fail('params 必须是普通对象');
  checkAllowedKeys('params', params, ['shutterAngleDeg', 'samples', 'clampToShot', 'policy']);

  const shot = ctx.shot ?? { in: 0, frames: 48 };
  const shutterAngleDeg = params.shutterAngleDeg ?? 180;
  const samples = params.samples ?? 8;
  const policy = params.policy ?? { alignment: 'centered', clampToShot: params.clampToShot ?? true };
  if (!isPlainObject(policy)) fail('params.policy 必须是普通对象');
  checkAllowedKeys('params.policy', policy, ['alignment', 'clampToShot']);

  const clampToShot = params.clampToShot ?? policy.clampToShot ?? true;
  const alignment = policy.alignment ?? 'centered';

  // 先预校验一次镜头首帧时刻表以尽早拦截非法参数
  subframeTimes(shot.in ?? 0, shot, { shutterAngleDeg, samples, clampToShot, alignment });

  function scheduleFor(f) {
    return subframeTimes(f, shot, { shutterAngleDeg, samples, clampToShot, alignment });
  }

  function renderFrame(f, renderAtTime) {
    return renderSubframeBlur(f, shot, renderAtTime, { shutterAngleDeg, samples, clampToShot, alignment });
  }

  return {
    object: {
      shutterAngleDeg,
      samples,
      clampToShot,
      alignment,
      subframeTimes: scheduleFor,
      accumulateLinear,
      measureCutGhosting,
      renderFrame,
    },
    apply(f, sub = 0) {
      if (!Number.isSafeInteger(f) || f < 0) fail(`帧号 f 必须是非负整数，给的是 ${f}`);
      if (!(typeof sub === 'number' && sub >= 0 && sub < 1)) fail(`子帧相位 sub 必须在 [0, 1) 内，给的是 ${sub}`);
      const sched = scheduleFor(f);
      return {
        frame: f,
        sub,
        samples: sched.length,
        minTime: sched[0].t,
        maxTime: sched[sched.length - 1].t,
        clampedCount: sched.filter((s) => s.clamped).length,
      };
    },
    meta(f) {
      const sched = scheduleFor(f);
      return {
        readings: {
          subframeSamples: sched.length,
          shutterAngleDeg,
          clampedSamples: sched.filter((s) => s.clamped).length,
          outOfShotSamples: sched.filter((s) => !s.inShot).length,
        },
      };
    },
    dispose() {},
  };
}
