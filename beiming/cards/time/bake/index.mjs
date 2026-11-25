// time.bake：记忆预演成表求值器。
// 将带历史状态/积分轨迹的动力系统在固定步长 dt = 1 / (sampleHz * substeps) 上预演并烘焙为不可变表，
// 支持 nearest / linear / cubic（Catmull-Rom）插值与任意乱序抽帧 O(1) 查询，与顺序推演逐位一致。

const GRAVITY = 9.81;
const INTERP_MODES = new Set(['nearest', 'linear', 'cubic']);

function bad(message) {
  return Object.assign(new TypeError(message), { code: 'usage.bad-argument' });
}

function assertNum(x, name, min = -Infinity, max = Infinity) {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max) {
    throw bad(`Invalid ${name}`);
  }
  return x;
}

function assertInt(x, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(x) || x < min || x > max) {
    throw bad(`Invalid ${name}`);
  }
  return x;
}

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

function catmullRom(p0, p1, p2, p3, f) {
  const f2 = f * f;
  const f3 = f2 * f;
  return 0.5 * (
    2 * p1
    + (-p0 + p2) * f
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * f3
  );
}

/**
 * 在固定步长网格上预演带记忆系统并冻结为不可变表。
 * config: { t0=0, duration, sampleHz, substeps=1, warmupSteps=0, initialState, step(state, t, dt) }
 */
export function bakeTrajectory(config) {
  if (!config || typeof config !== 'object') throw bad('Invalid bake config');
  const t0 = assertNum(config.t0 ?? 0, 't0');
  const duration = assertNum(config.duration, 'duration');
  if (!(duration > 0)) throw bad('duration must be positive');
  const sampleHz = assertNum(config.sampleHz, 'sampleHz');
  if (!(sampleHz > 0)) throw bad('sampleHz must be positive');
  const substeps = assertInt(config.substeps ?? 1, 'substeps', 1, 1024);
  const warmupSteps = assertInt(config.warmupSteps ?? 0, 'warmupSteps', 0, 100000);
  const initialState = config.initialState;
  if (!Array.isArray(initialState) || initialState.length === 0 || !initialState.every(Number.isFinite)) {
    throw bad('Invalid initialState');
  }
  if (typeof config.step !== 'function') throw bad('Missing step function');

  const channels = initialState.length;
  const sampleCount = Math.round(duration * sampleHz) + 1;
  const sampleDt = 1 / sampleHz;
  const subDt = sampleDt / substeps;
  const data = new Float64Array(sampleCount * channels);

  let state = [...initialState];
  for (let k = -warmupSteps; k < sampleCount; k++) {
    if (k >= 0) {
      const base = k * channels;
      for (let c = 0; c < channels; c++) {
        data[base + c] = state[c];
      }
    }
    if (k === sampleCount - 1) break;
    const stepStartTime = t0 + Math.max(0, k) * sampleDt;
    for (let s = 0; s < substeps; s++) {
      const tCur = stepStartTime + s * subDt;
      const next = config.step(state, tCur, subDt, k, s);
      if (!Array.isArray(next) || next.length !== channels || !next.every(Number.isFinite)) {
        throw bad('step() must return finite array matching initialState length');
      }
      state = next;
    }
  }

  return Object.freeze({
    t0,
    duration,
    sampleHz,
    sampleDt,
    substeps,
    warmupSteps,
    sampleCount,
    channels,
    data,
  });
}

/**
 * 从头顺序积分到目标时刻 time（用于对拍验证烘焙表在网格时刻与顺序推演逐位一致）。
 */
export function simulateSequentialAt(config, time) {
  if (!config || typeof config !== 'object') throw bad('Invalid config');
  const t0 = assertNum(config.t0 ?? 0, 't0');
  const duration = assertNum(config.duration, 'duration');
  const sampleHz = assertNum(config.sampleHz, 'sampleHz');
  const substeps = assertInt(config.substeps ?? 1, 'substeps', 1, 1024);
  const warmupSteps = assertInt(config.warmupSteps ?? 0, 'warmupSteps', 0, 100000);
  const tClamped = clamp(assertNum(time, 'time'), t0, t0 + duration);
  const sampleDt = 1 / sampleHz;
  const subDt = sampleDt / substeps;
  const targetIndex = Math.round((tClamped - t0) * sampleHz);

  let state = [...config.initialState];
  for (let k = -warmupSteps; k < targetIndex; k++) {
    const stepStartTime = t0 + Math.max(0, k) * sampleDt;
    for (let s = 0; s < substeps; s++) {
      state = config.step(state, stepStartTime + s * subDt, subDt, k, s);
    }
  }
  return state;
}

/**
 * O(1) 随机访问查询已烘焙表：支持 'nearest' | 'linear' | 'cubic'（Catmull-Rom）。
 */
export function queryBakedTable(table, time, { interpolation = 'linear' } = {}) {
  if (!table || typeof table !== 'object' || !(table.data instanceof Float64Array)) {
    throw bad('Invalid baked table');
  }
  if (!INTERP_MODES.has(interpolation)) throw bad(`Invalid interpolation: ${interpolation}`);
  const t = assertNum(time, 'time');
  const { t0, duration, sampleHz, sampleCount, channels, data } = table;
  const x = clamp((t - t0) * sampleHz, 0, sampleCount - 1);
  const k = Math.min(sampleCount - 1, Math.floor(x));
  const f = x - k;

  const readRow = (idx) => {
    const clampedIdx = clamp(idx, 0, sampleCount - 1);
    const base = clampedIdx * channels;
    const row = new Array(channels);
    for (let c = 0; c < channels; c++) row[c] = data[base + c];
    return row;
  };

  if (f <= 1e-12 || k >= sampleCount - 1) {
    return readRow(k);
  }

  if (interpolation === 'nearest') {
    return readRow(f < 0.5 ? k : k + 1);
  }

  if (interpolation === 'linear') {
    const r0 = readRow(k);
    const r1 = readRow(k + 1);
    return r0.map((v, c) => v + (r1[c] - v) * f);
  }

  // cubic Catmull-Rom
  const r0 = readRow(k - 1);
  const r1 = readRow(k);
  const r2 = readRow(k + 1);
  const r3 = readRow(k + 2);
  return r1.map((_, c) => catmullRom(r0[c], r1[c], r2[c], r3[c], f));
}

function buildDeclarativeTable(spec) {
  const durationS = assertNum(spec.durationS ?? 4.0, 'spec.durationS', 1e-3, 3600);
  const sampleHz = assertNum(spec.sampleHz ?? 30, 'spec.sampleHz', 1e-2, 1000);
  const substeps = assertInt(spec.substeps ?? 2, 'spec.substeps', 1, 64);
  const warmupSteps = assertInt(spec.warmupSteps ?? 15, 'spec.warmupSteps', 0, 10000);
  const tracks = spec.tracks;
  if (!Array.isArray(tracks) || tracks.length === 0) throw bad('spec.tracks must be non-empty array');

  // 每条轨道 4 个状态量：[hx, hz, vx, vz]（悬挂摆体水平指向分量与水平速度）
  const normalizedTracks = tracks.map((tr, i) => {
    if (!tr || typeof tr !== 'object' || typeof tr.id !== 'string' || !tr.id.trim()) {
      throw bad(`Invalid track at ${i}`);
    }
    const lengthM = assertNum(tr.lengthM, `tracks[${i}].lengthM`, 0.05, 100);
    const drag = assertNum(tr.drag ?? 0.088, `tracks[${i}].drag`, 0, 10);
    const damping = assertNum(tr.damping ?? 0.3, `tracks[${i}].damping`, 0, 50);
    const windBase = tr.windBase ?? [2.3, -0.8];
    if (!Array.isArray(windBase) || windBase.length !== 2 || !windBase.every(Number.isFinite)) {
      throw bad(`Invalid tracks[${i}].windBase`);
    }
    const gustAmp = assertNum(tr.gustAmp ?? 5.0, `tracks[${i}].gustAmp`, 0, 200);
    const gustTimeS = assertNum(tr.gustTimeS ?? 1.0, `tracks[${i}].gustTimeS`, 0, 3600);
    return { id: tr.id, lengthM, drag, damping, windBase, gustAmp, gustTimeS };
  });

  const initialState = normalizedTracks.flatMap(() => [0, 0, 0, 0]);
  const table = bakeTrajectory({
    t0: 0,
    duration: durationS,
    sampleHz,
    substeps,
    warmupSteps,
    initialState,
    step(state, t, dt) {
      const next = new Array(state.length);
      for (let i = 0; i < normalizedTracks.length; i++) {
        const tr = normalizedTracks[i];
        const o = i * 4;
        const hx = state[o];
        const hz = state[o + 1];
        const vx = state[o + 2];
        const vz = state[o + 3];
        const dtGust = t - tr.gustTimeS;
        const gust = dtGust > 0 ? tr.gustAmp * Math.exp(-dtGust * 2.2) * Math.sin(dtGust * 5.0) : 0;
        const wx = tr.windBase[0] * (1 + 0.25 * Math.sin(t * 1.7 + i)) + gust;
        const wz = tr.windBase[1] * (1 + 0.25 * Math.cos(t * 1.3 + i)) + 0.5 * gust;
        const rx = wx - vx;
        const rz = wz - vz;
        const relSpd = Math.hypot(rx, rz);
        const restore = GRAVITY / tr.lengthM;
        const ax = -restore * hx + tr.drag * relSpd * rx - tr.damping * vx;
        const az = -restore * hz + tr.drag * relSpd * rz - tr.damping * vz;
        const nvx = vx + ax * dt;
        const nvz = vz + az * dt;
        let nhx = hx + nvx * dt;
        let nhz = hz + nvz * dt;
        const hm = Math.hypot(nhx, nhz);
        if (hm > 0.85) {
          const s = 0.85 / hm;
          nhx *= s;
          nhz *= s;
        }
        next[o] = nhx;
        next[o + 1] = nhz;
        next[o + 2] = nvx;
        next[o + 3] = nvz;
      }
      return next;
    },
  });

  return { table, normalizedTracks };
}

function parseFps(fps) {
  if (typeof fps === 'string') {
    const m = /^(\d+)\/(\d+)$/.exec(fps);
    if (!m || Number(m[2]) === 0) throw bad('Invalid fps');
    return Number(m[1]) / Number(m[2]);
  }
  return assertNum(fps ?? 60, 'fps', 1e-3, 10000);
}

export function evaluate(ctx, params, frame = ctx?.frame ?? 0, sub = ctx?.sub ?? 0) {
  if (!ctx || typeof ctx !== 'object') throw bad('Invalid ctx');
  const spec = params?.spec;
  if (!spec || typeof spec !== 'object') throw bad('Missing params.spec');
  const interpolation = spec.interpolation ?? 'cubic';
  if (!INTERP_MODES.has(interpolation)) throw bad(`Invalid interpolation: ${interpolation}`);
  const fps = parseFps(ctx.fps ?? 60);
  const f = assertNum(frame, 'frame');
  const s = assertNum(sub, 'sub', 0, 1);
  const time = assertNum(ctx.time ?? ctx.uTime ?? (f + s) / fps, 'time');

  const { table, normalizedTracks } = buildDeclarativeTable(spec);
  const values = queryBakedTable(table, time, { interpolation });

  const byTrack = {};
  let maxTiltDeg = 0;
  for (let i = 0; i < normalizedTracks.length; i++) {
    const tr = normalizedTracks[i];
    const hx = values[i * 4];
    const hz = values[i * 4 + 1];
    const vx = values[i * 4 + 2];
    const vz = values[i * 4 + 3];
    const tiltDeg = (Math.asin(Math.min(1, Math.hypot(hx, hz))) * 180) / Math.PI;
    if (tiltDeg > maxTiltDeg) maxTiltDeg = tiltDeg;
    byTrack[tr.id] = { hx, hz, vx, vz, tiltDeg };
  }

  return {
    baked: {
      time,
      sampleCount: table.sampleCount,
      values,
      tracks: byTrack,
    },
    readings: {
      trackCount: normalizedTracks.length,
      sampleCount: table.sampleCount,
      maxTiltDeg,
    },
  };
}
