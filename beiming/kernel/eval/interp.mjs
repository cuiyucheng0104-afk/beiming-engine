function checkShotSample(f, sub, shotFrames) {
  if (!Number.isSafeInteger(shotFrames) || shotFrames < 1) throw new RangeError('镜头帧数必须是正整数');
  if (!Number.isSafeInteger(f) || f < 0 || f >= shotFrames) throw new RangeError('局部帧号越出镜头');
  if (!Number.isFinite(sub) || sub < 0 || sub >= 1) throw new RangeError('子帧相位必须在 [0, 1) 内');
}

/** 校验局部帧号和相位，按时间键契约取 f + sub。 */
export function clampShotSample(f, sub, shotFrames) {
  checkShotSample(f, sub, shotFrames);
  return f + sub;
}

export function evalClosedForm(fn, f, sub, shotFrames) {
  return fn(clampShotSample(f, sub, shotFrames));
}

function tuple(value, size) {
  if (!(Array.isArray(value) || ArrayBuffer.isView(value)) || value.length !== size) {
    throw new TypeError(`样本必须有 ${size} 个分量`);
  }
  const result = Array.from(value);
  if (!result.every(Number.isFinite)) throw new RangeError('样本必须为有限数');
  return result;
}

function phase(samples, f, sub, shotFrames) {
  checkShotSample(f, sub, shotFrames);
  if (samples.length < shotFrames) throw new RangeError('本镜头的样本不齐');
  return f === shotFrames - 1 ? 0 : sub;
}

export function interpVec3(samples, f, sub, shotFrames) {
  const t = phase(samples, f, sub, shotFrames);
  const a = tuple(samples[f], 3);
  if (t === 0) return a;
  const b = tuple(samples[f + 1], 3);
  return a.map((v, i) => v * (1 - t) + b[i] * t);
}

function unit(value) {
  const q = tuple(value, 4);
  const length = Math.hypot(...q);
  if (!length || !Number.isFinite(length)) throw new RangeError('四元数无法归一化');
  return q.map(v => v / length);
}

export function slerpQuat(q0, q1, t) {
  if (!Number.isFinite(t) || t < 0 || t > 1) throw new RangeError('插值相位必须在 [0, 1] 内');
  const a = unit(q0);
  let b = unit(q1);
  let dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  if (dot < 0) {
    b = b.map(v => -v);
    dot = -dot;
  }
  if (dot > 0.9995) return unit(a.map((v, i) => v + t * (b[i] - v)));
  const theta = Math.acos(dot);
  const w0 = Math.sin((1 - t) * theta) / Math.sin(theta);
  const w1 = Math.sin(t * theta) / Math.sin(theta);
  return unit(a.map((v, i) => w0 * v + w1 * b[i]));
}

export function interpQuat(samples, f, sub, shotFrames) {
  const t = phase(samples, f, sub, shotFrames);
  if (t === 0) return unit(samples[f]);
  return slerpQuat(samples[f], samples[f + 1], t);
}
