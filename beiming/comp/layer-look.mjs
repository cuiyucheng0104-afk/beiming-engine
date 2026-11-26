import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { encodePng } from '../observe/sheet.mjs';
import { checkContract } from './audio.mjs';
import { deliver } from './deliver.mjs';
import { assertPlainObject } from './script-audio.mjs';
import { bad, framePath, normalizeShot, parseFps } from './stitch.mjs';

const AUXILIARY = ['depth', 'objectId', 'normal'];
const STYLED_PATTERN = 'styled.%06d.png';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function validatePng(header, layer, size, label) {
  const gray = layer === 'depth' || layer === 'objectId';
  if (header.length < 29 || !header.subarray(0, 8).equals(PNG_SIGNATURE)
      || header.readUInt32BE(8) !== 13 || header.toString('ascii', 12, 16) !== 'IHDR'
      || header[24] !== (gray ? 16 : 8) || (gray ? header[25] !== 0 : ![2, 6].includes(header[25]))
      || header[26] !== 0 || header[27] !== 0 || header[28] !== 0) {
    throw bad(`${label} 必须是${gray ? ' 16 位灰度' : ' 8 位 RGB/RGBA'}非隔行 PNG`);
  }
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  if (width !== size[0] || height !== size[1]) {
    throw bad(`${label} 尺寸 ${width}×${height} 与输出 ${size.join('×')} 不一致`);
  }
}

function preflightFile(file, layer, size, label) {
  if (typeof file !== 'string' || !file.trim() || file.includes('\0')
      || !statSync(file, { throwIfNoEntry: false })?.isFile()) throw bad(`${label} 缺失有效的输入文件`);
  const fd = openSync(file, 'r');
  try {
    const header = Buffer.alloc(29);
    validatePng(header.subarray(0, readSync(fd, header)), layer, size, label);
  } finally {
    closeSync(fd);
  }
}

/** 把选中的显示参考镜头交给调用方的 RGB8 分层渲染器，再用常规交付链编码。 */
export async function composeLayerLookFilm(opts) {
  assertPlainObject(opts, '分层风格化选项');
  const { film, frames, layerLook, outDir, ...deliveryOpts } = opts;
  assertPlainObject(layerLook, 'layerLook');
  const { shotId, renderFrame } = layerLook;
  if (typeof shotId !== 'string' || typeof renderFrame !== 'function') {
    throw bad('layerLook 需要指定镜头 shotId 及 renderFrame 渲染器');
  }
  checkContract(film, 'film/3.0');
  const shot = film.shots.find(({ id }) => id === shotId);
  if (!shot || !Object.hasOwn(frames ?? {}, shotId)) throw bad(`分层风格化找不到镜头 ${shotId} 的帧序列`);
  if (shot.colorRef !== 'display') throw bad(`分层风格化镜头 ${shotId} 必须是显示参考镜头`);
  const sequence = frames[shotId];
  assertPlainObject(sequence, `镜头 ${shotId} 的帧序列`);
  const { auxiliaryLayers, ...colorSequence } = sequence;
  const color = normalizeShot({ ...colorSequence, id: shotId, in: shot.in, out: shot.out, colorRef: shot.colorRef }, { checkFiles: false });
  if (color.kind !== 'png' || color.transfer !== 'srgb') throw bad(`分层风格化镜头 ${shotId} 只收显示编码 sRGB PNG 序列`);
  if (typeof outDir !== 'string' || !outDir.trim() || outDir.includes('\0')) throw bad('outDir 必须是不含空字节的非空路径');

  const size = [...film.output.size];
  const [width, height] = size;
  if (size.some((n) => n % 2 !== 0)) throw bad('分层风格化的成片尺寸必须为偶数');
  const { num, den } = parseFps(film.output.fps);
  assertPlainObject(auxiliaryLayers, `镜头 ${shotId} 的辅助层声明 auxiliaryLayers`);
  for (const name of AUXILIARY) {
    if (!Object.hasOwn(auxiliaryLayers, name) || !Array.isArray(auxiliaryLayers[name]) || auxiliaryLayers[name].length !== color.count) {
      throw bad(`分层风格化镜头 ${shotId} 的 ${name} 必须声明 ${color.count} 张逐帧 PNG`);
    }
  }
  const { depthUnitM } = auxiliaryLayers;
  if (!Number.isFinite(depthUnitM) || depthUnitM <= 0) throw bad('depthUnitM 必须是正有限数（米／深度码值）');

  const inputs = Array.from({ length: color.count }, (_, frame) => ({
    color: framePath(color.pattern, color.start + frame),
    ...Object.fromEntries(AUXILIARY.map((name) => [name, auxiliaryLayers[name][frame]])),
  }));
  const label = (frame, layer) => `镜头 ${shotId} 局部第 ${frame} 帧的 ${layer}`;
  for (const [frame, paths] of inputs.entries()) {
    for (const [layer, file] of Object.entries(paths)) preflightFile(file, layer, size, label(frame, layer));
  }

  const parent = dirname(resolve(outDir));
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, '.beiming-x8-'));
  try {
    for (const [frame, paths] of inputs.entries()) {
      const layers = Object.fromEntries(Object.entries(paths).map(([layer, file]) => {
        const bytes = readFileSync(file);
        validatePng(bytes, layer, size, label(frame, layer));
        return [layer, bytes];
      }));
      const rgb = await renderFrame({ shotId, frame, time: frame * den / num, size: [...size], depthUnitM, layers });
      if (!(rgb instanceof Uint8Array) || rgb.length !== width * height * 3) {
        throw bad(`${label(frame, 'renderFrame')} 必须返回 ${width}×${height} 的 RGB8 字节`);
      }
      writeFileSync(join(dir, framePath(STYLED_PATTERN, frame)), encodePng({ width, height, rgb }), { flag: 'wx' });
    }
    const styled = { ...colorSequence, pattern: join(dir, STYLED_PATTERN), start: 0, kind: 'png', transfer: 'srgb' };
    return await deliver({ ...deliveryOpts, film, outDir, frames: { ...frames, [shotId]: styled } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
