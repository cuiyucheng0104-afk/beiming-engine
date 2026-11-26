import { types } from 'node:util';
import { motionZoomPan } from './image-layout.mjs';

const OPTIONS = ['width', 'height', 'exclusionRadius', 'maxPan'];
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteBuffer = Object.getOwnPropertyDescriptor(typedArray, 'buffer').get;
const byteOffset = Object.getOwnPropertyDescriptor(typedArray, 'byteOffset').get;
const byteLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength').get;

function bad(message) {
  throw Object.assign(new RangeError(message), { code: 'usage.bad-argument' });
}

function byteView(data, label) {
  if (!types.isUint8Array(data) || byteLength.call(data) === 0) bad(`${label}须为非空 Uint8Array`);
  // Use the actual byte range for Buffer slices and typed-array subclasses.
  return new Uint8Array(byteBuffer.call(data), byteOffset.call(data), byteLength.call(data));
}

function grayFrame(data, area, label) {
  const frame = byteView(data, label);
  if (frame.length !== area) bad(`${label}的像素数与宽高不符`);
  return frame;
}

function ranking(frame, errors, area) {
  return frame < 0 ? null : { frame, meanAbsError: errors[frame] / area };
}

/** Rank grayscale frames by whole-frame mean absolute error in 8-bit code values. */
export function stillMatch(query, candidates, options = {}) {
  if (!options || typeof options !== 'object' || types.isProxy(options) || Array.isArray(options)) bad('选项须为对象');
  for (const key of Object.keys(options)) {
    if (!OPTIONS.includes(key)) bad(`未知选项 ${key}`);
  }
  const { width, height, exclusionRadius = 10, maxPan } = options;
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0)) bad('宽高须为正整数');
  const area = width * height;
  if (!Number.isSafeInteger(area * 255)) bad('像素数超出量测范围');
  if (!Number.isSafeInteger(exclusionRadius) || exclusionRadius < 0) bad('exclusionRadius 须为非负整数');
  if (maxPan !== undefined && (!Number.isSafeInteger(maxPan) || maxPan < 0)) bad('maxPan 须为非负整数');
  const still = grayFrame(query, area, '剧照');

  if (types.isProxy(candidates)) bad('候选帧不能是代理');
  const packed = Array.isArray(candidates) ? null : byteView(candidates, '候选帧');
  if (packed && packed.length % area !== 0) bad('紧密缓冲须包含整数个完整帧');
  const length = packed ? packed.length / area : candidates.length;
  if (length === 0) bad('须提供至少一帧候选');

  const errors = [];
  let bestFrame = -1;
  let bestPixels;
  for (let frame = 0; frame < length; frame++) {
    let pixels;
    if (packed) {
      pixels = packed.subarray(frame * area, (frame + 1) * area);
    } else {
      const slot = Object.getOwnPropertyDescriptor(candidates, frame);
      if (!slot || !Object.hasOwn(slot, 'value')) bad(`缺少候选第 ${frame} 帧`);
      pixels = grayFrame(slot.value, area, `候选第 ${frame} 帧`);
    }
    let error = 0;
    for (let pixel = 0; pixel < area; pixel++) error += Math.abs(still[pixel] - pixels[pixel]);
    errors.push(error);
    if (bestFrame < 0 || error < errors[bestFrame]) {
      bestFrame = frame;
      bestPixels = pixels;
    }
  }

  let runnerUp = -1;
  for (let frame = 0; frame < length; frame++) {
    if (Math.abs(frame - bestFrame) <= exclusionRadius) continue;
    if (runnerUp < 0 || errors[frame] < errors[runnerUp]) runnerUp = frame;
  }

  let offset = null;
  if (maxPan !== undefined) {
    const movement = motionZoomPan(still, bestPixels, width, height, { scales: [1], maxPan });
    const { dx, dy } = movement.value;
    offset = { dx, dy, meanAbsError: movement.details.meanAbsError };
  }
  return { metric: 'metric:still.match', value: bestFrame, unit: 'frames', details: {
    best: ranking(bestFrame, errors, area), runnerUp: ranking(runnerUp, errors, area), offset,
  } };
}
