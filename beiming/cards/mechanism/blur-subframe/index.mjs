// blur.subframe 在 three 帧源里的底层机制实现（visibleToAgent = false）：
// 1. 按 shutterAngleDeg（0..360°）与子帧数 samples（1..64）生成分层中点采样时刻表，默认前向快门严格对齐 T5/T14 shutterSubs 契约；
// 2. 开启 clampToShot（默认 true）时，把快门采样区间严格钳制在当前镜头 [shot.in, shot.in + shot.frames) 内，
//    确保切点后首帧（f = shot.in）绝不向前跨切点采样上一镜头，从根源上消除切点重影（O9 cut.ghost = 0）；
// 3. 在色调映射之前的场景线性光空间（32 位浮点 Float32Array RGBA）中即时消费并做逐子帧加权平均。

const ALIGNMENTS = Object.freeze(['centered', 'forward', 'backward']);
const HOST_CTX_KEYS = Object.freeze([
  'tracks',
  'cards',
  'params',
  'seed',
  'rng',
  'assets',
  'anchor',
  'tokens',
  'size',
  'fps',
  'frames',
  'shot',
  'events',
  'THREE',
  'renderer',
]);

const fail = (message) => {
  throw Object.assign(new RangeError(`blur.subframe：${message}`), { code: 'usage.bad-argument' });
};

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function cloneAndValidateFloat32(what, v) {
  if (!(v instanceof Float32Array)) fail(`${what} 必须是 Float32Array`);
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i])) fail(`${what}[${i}] 不能是 NaN 或 Infinity`);
  }
  return new Float32Array(v);
}

function snapValue(what, v, depth = 0) {
  if (depth > 16) fail(`${what} 嵌套层级过深`);
  if (v === null || v === undefined || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail(`${what} 必须是有限数，给的是 ${v}`);
    return v;
  }
  if (typeof v !== 'object') fail(`${what} 类型不合法（${typeof v}）`);
  if (v instanceof Float32Array) {
    return cloneAndValidateFloat32(what, v);
  }
  if (Array.isArray(v)) {
    const n = v.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      if (!(i in v)) fail(`${what} 不能是稀疏数组`);
      out[i] = snapValue(`${what}[${i}]`, v[i], depth + 1);
    }
    return out;
  }
  if (!isPlainObject(v)) fail(`${what} 必须是普通对象`);
  if (Object.getOwnPropertySymbols(v).length > 0) fail(`${what} 不能包含 Symbol 键`);
  const out = {};
  for (const k of Object.keys(v)) {
    out[k] = snapValue(`${what}.${k}`, v[k], depth + 1);
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
  checkAllowedKeys('shot', shot, ['in', 'frames', 'id', 'out']);
  const shotIn = shot.in ?? 0;
  const shotFrames = shot.frames ?? (Number.isSafeInteger(shot.out) ? shot.out - shotIn : 48);
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
  if (typeof clampToShot !== 'boolean') fail('clampToShot 必须是布尔值');
  const alignment = opts.alignment ?? (clampToShot ? 'forward' : 'centered');

  if (!(typeof shutterAngleDeg === 'number' && shutterAngleDeg >= 0 && shutterAngleDeg <= 360)) {
    fail(`shutterAngleDeg 必须在 [0, 360] 内，给的是 ${shutterAngleDeg}`);
  }
  if (!Number.isInteger(samples) || samples < 1 || samples > 64) {
    fail(`samples 必须是 [1, 64] 内的整数，给的是 ${samples}`);
  }
  if (!ALIGNMENTS.includes(alignment)) {
    fail(`alignment 只能是 ${ALIGNMENTS.join('/')}，给的是 ${JSON.stringify(alignment)}`);
  }

  const span = shutterAngleDeg / 360;
  if (span === 0) {
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

  const weight = 1 / samples;
  const out = [];

  if (alignment === 'forward') {
    for (let i = 0; i < samples; i++) {
      // 严格遵循 T5/T14 运算顺序：((i + 0.5) / N) * (shutterAngleDeg / 360)
      const sub = ((i + 0.5) / samples) * (shutterAngleDeg / 360);
      const t = frame + sub;
      out.push({
        index: i,
        t,
        frame,
        sub,
        weight,
        clamped: false,
        inShot: t >= shotIn && t < shotOut,
      });
    }
    return out;
  }

  let rawStart;
  let rawEnd;
  if (alignment === 'backward') {
    rawStart = frame - span;
    rawEnd = frame;
  } else {
    rawStart = frame - span * 0.5;
    rawEnd = frame + span * 0.5;
  }

  const maxValidTime = shotOut - 1e-6;
  for (let i = 0; i < samples; i++) {
    const u = (i + 0.5) / samples;
    const rawT = rawStart + u * (rawEnd - rawStart);
    let t = rawT;
    let clamped = false;

    if (clampToShot) {
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
 * 按子帧时刻表调用 renderAtTime(t, sample) 并在场景线性光空间即时消费求平均（兼容复用同一读回缓冲）。
 */
export function renderSubframeBlur(rawFrame, rawShot, renderAtTime, rawOpts = {}) {
  if (typeof renderAtTime !== 'function') {
    fail('renderAtTime 必须是渲染回调函数');
  }
  const schedule = subframeTimes(rawFrame, rawShot, rawOpts);
  const buffers = [];
  for (let i = 0; i < schedule.length; i++) {
    const s = schedule[i];
    const rawBuf = renderAtTime(s.t, s);
    // 在下一次回调覆写前立即校验并拷贝消费当前样本
    const snapBuf = cloneAndValidateFloat32(`subframes[${i}]`, rawBuf);
    buffers.push({ rgba: snapBuf, weight: s.weight });
  }
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
  if (!isPlainObject(rawCtx)) fail('ctx 必须是普通对象');
  if (Object.getOwnPropertySymbols(rawCtx).length > 0) fail('ctx 不能包含 Symbol 键');
  checkAllowedKeys('ctx', rawCtx, HOST_CTX_KEYS);

  const shot = rawCtx.shot !== undefined ? snapValue('ctx.shot', rawCtx.shot) : { in: 0, frames: 48 };
  if (rawCtx.fps !== undefined) {
    const fps = snapValue('ctx.fps', rawCtx.fps);
    if (typeof fps !== 'string' || !/^[1-9][0-9]*\/[1-9][0-9]*$/.test(fps)) fail('ctx.fps 格式不合法');
  }
  if (rawCtx.size !== undefined) {
    const size = snapValue('ctx.size', rawCtx.size);
    if (!Array.isArray(size) || size.length !== 2 || !Number.isInteger(size[0]) || !Number.isInteger(size[1]) || size[0] < 1 || size[1] < 1) {
      fail('ctx.size 必须是 [width, height] 正整数对');
    }
  }

  const params = snapValue('params', rawParams);
  if (!isPlainObject(params)) fail('params 必须是普通对象');
  checkAllowedKeys('params', params, ['shutterAngleDeg', 'samples', 'clampToShot', 'policy']);

  if (!isPlainObject(shot)) fail('ctx.shot 必须是 { in, frames } 普通对象');
  checkAllowedKeys('ctx.shot', shot, ['in', 'frames', 'id', 'out']);
  const shotIn = shot.in ?? 0;
  const shotFrames = shot.frames ?? (Number.isSafeInteger(shot.out) ? shot.out - shotIn : 48);
  const normalizedShot = { in: shotIn, frames: shotFrames };

  const shutterAngleDeg = params.shutterAngleDeg ?? 180;
  const samples = params.samples ?? 8;
  const hasExplicitPolicy = params.policy !== undefined;
  const policy = hasExplicitPolicy ? params.policy : { alignment: 'forward', clampToShot: params.clampToShot ?? true };
  if (!isPlainObject(policy)) fail('params.policy 必须是普通对象');
  checkAllowedKeys('params.policy', policy, ['alignment', 'clampToShot']);

  const clampToShot = params.clampToShot ?? policy.clampToShot ?? true;
  const alignment = (!clampToShot && (!hasExplicitPolicy || policy.clampToShot === true))
    ? 'centered'
    : (policy.alignment ?? (clampToShot ? 'forward' : 'centered'));

  // 先预校验一次镜头首帧时刻表以尽早拦截非法参数
  subframeTimes(shotIn, normalizedShot, { shutterAngleDeg, samples, clampToShot, alignment });

  /**
   * 统一将 Handle 边界收到的镜头局部帧号 f ∈ [0, shotFrames) 换算为全片帧号 shotIn + f；
   * 若调用方直接传入了不与局部区间重叠的全片帧号 f ∈ [shotIn, shotIn + shotFrames)，亦保持兼容。
   */
  function toGlobalFrame(rawF) {
    const f = snapValue('frame', rawF);
    if (!Number.isSafeInteger(f) || f < 0) {
      fail(`帧号 f 必须是非负整数，给的是 ${f}`);
    }
    if (f >= 0 && f < shotFrames) {
      return shotIn + f;
    }
    if (f >= shotIn && f < shotIn + shotFrames) {
      return f;
    }
    fail(`帧号 ${f} 超出镜头局部区间 [0, ${shotFrames}) 与全片区间 [${shotIn}, ${shotIn + shotFrames})`);
  }

  function scheduleFor(f) {
    const globalF = toGlobalFrame(f);
    return subframeTimes(globalF, normalizedShot, { shutterAngleDeg, samples, clampToShot, alignment });
  }

  function renderFrame(f, renderAtTime) {
    const globalF = toGlobalFrame(f);
    return renderSubframeBlur(globalF, normalizedShot, renderAtTime, { shutterAngleDeg, samples, clampToShot, alignment });
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
      const globalF = toGlobalFrame(f);
      if (!(typeof sub === 'number' && Number.isFinite(sub) && sub >= 0 && sub < 1)) {
        fail(`子帧相位 sub 必须在 [0, 1) 内，给的是 ${sub}`);
      }
      const sched = subframeTimes(globalF, normalizedShot, { shutterAngleDeg, samples, clampToShot, alignment });
      return {
        frame: f,
        filmFrame: globalF,
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
