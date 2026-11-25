// Pure-function traveling lateral & heave wave field along spine arclength.

const TAU = Math.PI * 2;
const DEG2RAD = Math.PI / 180;

export const DEFAULT_SWIM_CONFIG = Object.freeze({
  wavelength: 39,
  slip: 0.16,
  idleSpeed: 5.5,
  ampSlow: 1.25,
  ampFast: 0.85,
  speedSlow: 14,
  speedFast: 60,
  heaveRatio: 0.55,
  heaveFreqRatio: 0.63,
  heavePhaseDeg: (1.3 * 180) / Math.PI,
  headFade: [7, 34],
  tailBoostStart: 60,
  tailBoostBase: 0.85,
  tailBoostGain: 0.9,
  verticalFade: [0.24, 0.52],
  stirWavelength: 23,
  stirSpeed: 15,
  stirSideAmp: 0.95,
  stirHeaveAmp: 0.5,
  stirHeadFade: [5, 22],
  stirTailFadeFrac: [0.5, 1.0],
});

function badArgument(message) {
  return Object.assign(new TypeError(message), { code: 'usage.bad-argument' });
}

function requireCondition(condition, message) {
  if (!condition) throw badArgument(message);
}

function requireNumber(value, field, min = -Infinity, max = Infinity) {
  requireCondition(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, `Invalid ${field}`);
  return value;
}

function parseRate(fps) {
  if (typeof fps === 'string') {
    const match = /^(\d+)\/(\d+)$/.exec(fps);
    requireCondition(Boolean(match), 'Invalid fps');
    const den = Number(match[2]);
    requireCondition(den > 0, 'Invalid fps');
    return requireNumber(Number(match[1]) / den, 'fps', Number.MIN_VALUE);
  }
  return requireNumber(fps, 'fps', Number.MIN_VALUE);
}

function clamp(x, min = 0, max = 1) {
  return x < min ? min : x > max ? max : x;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, x) {
  if (edge1 === edge0) return x >= edge1 ? 1 : 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function resolveConfig(cfg) {
  const merged = { ...DEFAULT_SWIM_CONFIG, ...(cfg ?? {}) };
  requireNumber(merged.wavelength, 'wavelength', Number.MIN_VALUE);
  requireNumber(merged.slip, 'slip', 0);
  requireNumber(merged.idleSpeed, 'idleSpeed', 0);
  requireNumber(merged.ampSlow, 'ampSlow', 0);
  requireNumber(merged.ampFast, 'ampFast', 0);
  requireNumber(merged.speedSlow, 'speedSlow', 0);
  requireNumber(merged.speedFast, 'speedFast', 0);
  requireNumber(merged.heaveRatio, 'heaveRatio', 0);
  requireNumber(merged.heaveFreqRatio, 'heaveFreqRatio', Number.MIN_VALUE);
  requireNumber(merged.heavePhaseDeg, 'heavePhaseDeg');
  requireNumber(merged.stirWavelength, 'stirWavelength', Number.MIN_VALUE);
  requireNumber(merged.stirSpeed, 'stirSpeed', 0);
  requireCondition(Array.isArray(merged.headFade) && merged.headFade.length === 2, 'Invalid headFade');
  requireCondition(Array.isArray(merged.verticalFade) && merged.verticalFade.length === 2, 'Invalid verticalFade');
  requireCondition(Array.isArray(merged.stirHeadFade) && merged.stirHeadFade.length === 2, 'Invalid stirHeadFade');
  requireCondition(Array.isArray(merged.stirTailFadeFrac) && merged.stirTailFadeFrac.length === 2, 'Invalid stirTailFadeFrac');
  return merged;
}

function normalizeVec3(v, field) {
  requireCondition(Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x)), `Invalid ${field}`);
  const len = Math.hypot(v[0], v[1], v[2]);
  requireCondition(len > 1e-12, `Invalid ${field}: zero vector`);
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * Evaluate traveling swim-wave offset at body arclength `arclength` behind head,
 * using tail-ward unit tangent `tangent` and wave `state`.
 */
export function swimOffsetAt(arclength, tangent, state) {
  requireNumber(arclength, 'arclength', 0);
  const vT = normalizeVec3(tangent, 'tangent');
  requireCondition(state && typeof state === 'object', 'Invalid state');

  const cfg = resolveConfig(state.config);
  const time = requireNumber(state.time ?? 0, 'time');
  const headS = requireNumber(state.headS ?? 0, 'headS');
  const sPhase = requireNumber(state.sPhase ?? 0, 'sPhase');
  const speed = requireNumber(state.speed ?? 20, 'speed', 0);
  const bodyLength = requireNumber(state.bodyLength ?? 172, 'bodyLength', Number.MIN_VALUE);
  const amplitude = requireNumber(state.amplitude ?? 1, 'amplitude', 0);
  const calm = requireNumber(state.calm ?? 1, 'calm', 0);
  const stir = requireNumber(state.stir ?? 0, 'stir', 0);
  const quiet = requireNumber(state.quiet ?? 0, 'quiet', 0, 1);
  const phaseRad = state.phaseRad !== undefined
    ? requireNumber(state.phaseRad, 'phaseRad')
    : requireNumber(state.phaseDeg ?? 0, 'phaseDeg') * DEG2RAD;

  const wK = TAU / cfg.wavelength;
  const wPh = -(1 + cfg.slip) * (headS + sPhase) * wK - cfg.idleSpeed * time * wK + phaseRad;
  const phase = arclength * wK + wPh;

  const hl = Math.hypot(vT[0], vT[2]);
  const levelFactor = smoothstep(cfg.verticalFade[0], cfg.verticalFade[1], hl) * (1 - quiet);

  if (amplitude === 0 || levelFactor === 0 || (calm === 0 && stir <= 0.01)) {
    return { offset: [0, 0, 0], lateral: 0, heave: 0, envelope: 0, phaseRad: phase, levelFactor };
  }

  const wAmp = lerp(cfg.ampSlow, cfg.ampFast, smoothstep(cfg.speedSlow, cfg.speedFast, speed)) * calm * amplitude;
  const envelope = smoothstep(cfg.headFade[0], cfg.headFade[1], arclength)
    * (cfg.tailBoostBase + cfg.tailBoostGain * smoothstep(cfg.tailBoostStart, bodyLength, arclength))
    * levelFactor;

  const heavePhaseRad = cfg.heavePhaseDeg * DEG2RAD;
  let ws = envelope * wAmp * Math.sin(phase);
  let wh = envelope * cfg.heaveRatio * calm * amplitude * Math.sin(phase * cfg.heaveFreqRatio + heavePhaseRad);

  if (stir > 0.01) {
    const sK = TAU / cfg.stirWavelength;
    const sPh = -cfg.stirSpeed * time * sK + phaseRad * 1.7;
    const e2 = stir * amplitude * levelFactor
      * smoothstep(cfg.stirHeadFade[0], cfg.stirHeadFade[1], arclength)
      * (1 - 0.5 * smoothstep(bodyLength * cfg.stirTailFadeFrac[0], bodyLength * cfg.stirTailFadeFrac[1], arclength));
    ws += e2 * cfg.stirSideAmp * Math.sin(arclength * sK + sPh);
    wh += e2 * cfg.stirHeaveAmp * Math.cos(arclength * sK * 0.8 + sPh * 0.9);
  }

  const sx = vT[2] / hl;
  const sz = -vT[0] / hl;
  const hx = (-vT[1] * vT[0]) / hl;
  const hz = (-vT[1] * vT[2]) / hl;

  const ox = sx * ws + hx * wh;
  const oy = hl * wh;
  const oz = sz * ws + hz * wh;

  return {
    offset: [ox || 0, oy || 0, oz || 0],
    lateral: ws || 0,
    heave: wh || 0,
    envelope: envelope || 0,
    phaseRad: phase,
    levelFactor,
  };
}

/** Evaluate swim offsets for an array of stations `{ s, tan, quiet? }`. */
export function evaluateSwimStations(stations, state) {
  requireCondition(Array.isArray(stations), 'Invalid stations');
  return stations.map((station) => {
    requireCondition(station && typeof station === 'object', 'Invalid station');
    const res = swimOffsetAt(station.s, station.tan, {
      ...state,
      quiet: station.quiet ?? state?.quiet ?? 0,
    });
    return { s: station.s, ...res };
  });
}

/** Standard card/0.1 data evaluate entry. */
export function evaluate(ctx, params, frame = ctx?.frame ?? 0, sub = ctx?.sub ?? 0) {
  requireCondition(ctx && typeof ctx === 'object', 'Invalid ctx');
  requireCondition(params && typeof params === 'object', 'Invalid params');

  const fps = parseRate(ctx.fps ?? 60);
  const tick = requireNumber(frame, 'frame') + requireNumber(sub, 'sub', 0, 1);
  const time = requireNumber(ctx.time ?? ctx.uTime ?? tick / fps, 'time');
  const bodyLength = requireNumber(params.bodyLength ?? 172, 'bodyLength', Number.MIN_VALUE);
  const config = resolveConfig(params.config);

  const state = {
    config,
    time,
    bodyLength,
    amplitude: requireNumber(params.amplitude ?? 1, 'amplitude', 0),
    calm: requireNumber(params.calm ?? 1, 'calm', 0),
    stir: requireNumber(params.stir ?? 0, 'stir', 0),
    phaseDeg: requireNumber(params.phaseDeg ?? 0, 'phaseDeg'),
    speed: requireNumber(params.speed ?? 20, 'speed', 0),
    headS: requireNumber(params.headS ?? time * (params.speed ?? 20), 'headS'),
    sPhase: requireNumber(params.sPhase ?? 0, 'sPhase'),
  };

  const stationsInput = Array.isArray(ctx.stations)
    ? ctx.stations
    : Array.from({ length: 17 }, (_, i) => ({
      s: (bodyLength * i) / 16,
      tan: [0, 0, -1],
    }));

  const stations = evaluateSwimStations(stationsInput, state);
  let maxOffsetM = 0;
  for (const st of stations) {
    const n = Math.hypot(st.offset[0], st.offset[1], st.offset[2]);
    if (n > maxOffsetM) maxOffsetM = n;
  }

  return {
    swim: { time, stations },
    readings: {
      stationCount: stations.length,
      maxOffsetM,
    },
  };
}
