// fx.post-state：纯函数后期状态结构体与事件包络求值器。
// 任意帧序抽帧逐位一致，无跨帧可变状态。

const EVENT_KINDS = new Set(['pulse', 'strike', 'window', 'hit', 'ring', 'dusk']);

function badArg(msg) {
  return Object.assign(new TypeError(msg), { code: 'usage.bad-argument' });
}

function clamp(v, lo = 0, hi = 1) {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(a, b, x) {
  if (b <= a) return x >= b ? 1 : 0;
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 平滑起音 + 指数衰减脉冲 */
export function pulseEnv(t, t0, attack = 0.04, release = 0.3) {
  if (t < t0) return 0;
  if (attack > 0 && t < t0 + attack) return smoothstep(t0, t0 + attack, t);
  return Math.exp(-(t - t0 - attack) / Math.max(release, 1e-6));
}

/** 窗口平滑淡入淡出 */
export function windowEnv(t, a, b, up = 0.3, dn = 0.4) {
  if (b <= a) return 0;
  return smoothstep(a, a + up, t) * (1 - smoothstep(b - dn, b, t));
}

/** 确定性时间值噪声闪烁 */
export function flickerNoise(t, hz) {
  const x = t * hz;
  const i = Math.floor(x);
  const f = x - i;
  const h = (k) => {
    const s = Math.sin(k * 127.1 + 3.7) * 43758.5453;
    return s - Math.floor(s);
  };
  return lerp(h(i), h(i + 1), f * f * (3 - 2 * f));
}

/** 撞击色散短脉冲（0..0.025s 线性拉升，0.025..0.28s 二次衰减，区间外精确为 0） */
export function hitFringeEnv(dt, amp = 1) {
  if (dt < 0 || dt > 0.28) return 0;
  if (dt < 0.025) return (amp * dt) / 0.025;
  const u = 1 - (dt - 0.025) / 0.255;
  return amp * u * u;
}

function parseFps(fps) {
  if (typeof fps === 'number') {
    if (!Number.isFinite(fps) || fps <= 0) throw badArg(`fx.post-state 非法帧率: ${fps}`);
    return fps;
  }
  if (typeof fps === 'string') {
    const parts = fps.split('/').map(Number);
    if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1]) && parts[0] > 0 && parts[1] > 0) {
      return parts[0] / parts[1];
    }
    const n = Number(fps);
    if (Number.isFinite(n) && n > 0) return n;
  }
  throw badArg(`fx.post-state 非法帧率: ${JSON.stringify(fps)}`);
}

/** 纯函数按秒时刻 t 求值后期参数结构体 */
export function evaluatePostState(tSec, params = {}) {
  if (!Number.isFinite(tSec)) throw badArg(`fx.post-state 时刻必须是有限数，收到 ${tSec}`);
  const events = params.events ?? [];
  if (!Array.isArray(events)) throw badArg('fx.post-state 的 events 必须是数组');

  const baseExp = params.exposure ?? 1.0;
  const baseBloom = params.bloom ?? 0.06;
  const baseAo = params.ao ?? 0.9;
  const baseShaft = params.shaft ?? 1.0;
  const baseGod = params.god ?? 0.55;
  const baseCa = params.ca ?? 0.006;
  const baseVig = params.vignette ?? 0.42;
  const fadeInSec = params.fadeInSec ?? 0;
  const fadeOutStartSec = params.fadeOutStartSec ?? -1;
  const durationSec = params.durationSec ?? 90;

  let exposureAdd = 0;
  let exposureMul = 1;
  let bloomAdd = 0;
  let aoAdd = 0;
  let shaftMul = 1;
  let godAdd = 0;
  let flash = 0;
  let shake = 0;
  let white = 0;
  let kick = 0;
  let fringe = 0;
  let dipTriggered = 0;

  let ring = { x: 0.5, y: 0.5, radius: 0, width: 0.05, strength: 0, squash: 1, angleDeg: 0 };

  for (const ev of events) {
    if (!ev || typeof ev !== 'object' || !EVENT_KINDS.has(ev.kind) || !Number.isFinite(ev.at)) {
      throw badArg(`fx.post-state 非法事件项: ${JSON.stringify(ev)}`);
    }
    const dt = tSec - ev.at;

    if (ev.kind === 'pulse') {
      const lead = ev.dipLead ?? 0.036;
      const gap = ev.dipGap ?? 0.002;
      if (ev.preDip && tSec >= ev.at - lead && tSec < ev.at - gap) {
        dipTriggered = Math.max(dipTriggered, ev.preDip);
      }
      const env = pulseEnv(tSec, ev.at, ev.attack ?? 0.04, ev.release ?? 0.3);
      if (env > 0) {
        if (ev.flash) flash += ev.flash * env;
        if (ev.exposure) exposureAdd += ev.exposure * env;
        if (ev.bloom) bloomAdd += ev.bloom * env;
        if (ev.ao) aoAdd += ev.ao * env;
        if (ev.god) godAdd += ev.god * env;
        if (ev.shake) shake += ev.shake * env;
        if (ev.kick) kick += ev.kick * env;
        if (ev.white) white += ev.white * env;
      }
    } else if (ev.kind === 'strike') {
      const win = ev.window ?? 0.7;
      const lead = ev.dipLead ?? 0.036;
      const gap = ev.dipGap ?? 0.002;
      if (ev.preDip && tSec >= ev.at - lead && tSec < ev.at - gap) {
        dipTriggered = Math.max(dipTriggered, ev.preDip);
      }
      if (dt >= 0 && dt < win) {
        const tau = ev.tau ?? 0.07;
        const rDelay = ev.restrikeDelay ?? 0.11;
        const rGain = ev.restrikeGain ?? 0.6;
        const rTau = ev.restrikeTau ?? 0.05;
        const fVal = Math.exp(-dt / tau) + (dt > rDelay ? rGain * Math.exp(-(dt - rDelay) / rTau) : 0);
        if (ev.flash) flash += ev.flash * fVal;
        if (ev.exposure) exposureAdd += ev.exposure * Math.min(fVal, 1.5);
        if (ev.shake) shake += ev.shake * fVal;
      }
      if (ev.fringe) fringe += hitFringeEnv(dt, ev.fringe);
    } else if (ev.kind === 'window') {
      const end = ev.end ?? (ev.at + (ev.duration ?? 1));
      const wVal = windowEnv(tSec, ev.at, end, ev.attack ?? 0.3, ev.release ?? 0.2);
      if (wVal > 0) {
        const mod = ev.flickerHz
          ? ((ev.flickerBase ?? 0.5) + (ev.flickerAmp ?? 0.5) * flickerNoise(tSec, ev.flickerHz))
          : 1;
        const k = wVal * mod;
        if (ev.flash) flash += ev.flash * k;
        if (ev.exposure) exposureAdd += ev.exposure * wVal;
        if (ev.bloom) bloomAdd += ev.bloom * wVal;
        if (ev.shake) shake += ev.shake * k;
        if (ev.shaft !== undefined) shaftMul *= lerp(1, ev.shaft, wVal);
      }
    } else if (ev.kind === 'hit') {
      fringe += hitFringeEnv(dt, ev.amp ?? 1);
      if (ev.kick) kick += ev.kick * pulseEnv(tSec, ev.at, ev.attack ?? 0.02, ev.release ?? 0.16);
    } else if (ev.kind === 'ring') {
      const dur = ev.duration ?? 1.1;
      if (dt >= 0 && dt < dur) {
        const r0 = ev.radius0 ?? 0.04;
        const rMax = ev.radiusMax ?? 0.8;
        const rate = ev.rate ?? 3.0;
        const radius = r0 + (rMax - r0) * (1 - Math.exp(-dt * rate));
        const att = smoothstep(0, ev.attack ?? 0.03, dt);
        const strength = (ev.strength ?? 0.016) * Math.exp(-dt / (ev.decay ?? 0.22)) * att;
        if (strength > ring.strength) {
          const wMin = ev.widthMin ?? 0.02;
          const wFac = ev.widthFactor ?? 0.10;
          const wGrow = ev.widthGrowth ?? 0.12;
          ring = {
            x: ev.center ? ev.center[0] : 0.5,
            y: ev.center ? ev.center[1] : 0.5,
            radius,
            width: Math.max(wMin, radius * (wFac + wGrow * dt)),
            strength,
            squash: ev.squash ?? 1,
            angleDeg: ev.angleDeg ?? 0,
          };
        }
      }
    } else if (ev.kind === 'dusk') {
      const end = ev.end ?? durationSec;
      const target = ev.targetScale ?? 0.3;
      exposureMul *= lerp(1, target, smoothstep(ev.at, end, tSec));
    }
  }

  // 首尾淡入淡出包络（t <= 0 或 t >= durationSec 在启用淡入/淡出时精确归零）
  const fadeIn = fadeInSec > 0 ? smoothstep(0, fadeInSec, tSec) : (tSec < 0 ? 0 : 1);
  const fadeOut = (fadeOutStartSec >= 0 && fadeOutStartSec < durationSec)
    ? (1 - smoothstep(fadeOutStartSec, durationSec, tSec))
    : (tSec > durationSec ? 0 : 1);
  const fade = clamp(fadeIn * fadeOut, 0, 1);

  const exposure = Math.max(0, (baseExp + exposureAdd + 4 * white - dipTriggered) * exposureMul);
  const bloom = clamp(baseBloom + bloomAdd, 0, 1);
  const ao = clamp(baseAo + aoAdd, 0, 1);
  const shaft = Math.max(0, baseShaft * shaftMul);
  const god = Math.max(0, baseGod + godAdd);

  return {
    exposure,
    bloom,
    ao,
    shaft,
    god,
    ca: baseCa,
    vignette: baseVig,
    flash,
    fade,
    shake,
    white,
    lens: {
      fringe: clamp(fringe, 0, 1),
      kick,
      ring,
    },
  };
}

/** data 落点标准 evaluate(inputs, params, f, sub) 入口 */
export function evaluate(inputs = {}, params = {}, f = 0, sub = 0) {
  if (!Number.isFinite(f) || !Number.isFinite(sub)) {
    throw badArg(`fx.post-state 帧号与子帧必须是有限数: f=${f}, sub=${sub}`);
  }
  const fps = parseFps(inputs.fps ?? '60/1');
  const shotIn = inputs.shot?.in ?? 0;
  if (!Number.isFinite(shotIn)) throw badArg(`fx.post-state 非法 shot.in: ${shotIn}`);
  const tSec = (shotIn + f + sub) / fps;
  return { postState: evaluatePostState(tSec, params) };
}
