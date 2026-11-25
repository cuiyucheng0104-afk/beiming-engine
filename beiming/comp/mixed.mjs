import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deliver } from './deliver.mjs';
import { bad, framePath, parseFps, runTool, srgbEncode, tools } from './stitch.mjs';
import { createFrameOverlay } from './x7-overlay.shot.js';

const ENTRY = fileURLToPath(new URL('./x7-overlay.shot.js', import.meta.url));
const PATTERN = 'overlay.%06d.png';

function pageRgba8(bytes, rgba) {
  if (bytes.length !== rgba.length * 4) throw bad('页面颜色层尺寸与 meta 不一致');
  // 页面 WebGL 在透明底上混合，颜色层是预乘的线性 RGB。先解预乘，再做 sRGB 编码。
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = bytes.readFloatLE((i + 3) * 4);
    rgba[i + 3] = Math.round(alpha * 255);
    for (let c = 0; c < 3; c++) rgba[i + c] = rgba[i + 3] ? Math.round(255 * srgbEncode(bytes.readFloatLE((i + c) * 4) / alpha)) : 0;
  }
}

/** 按镜头局部帧号排列的 meta/0.1 → 直通 RGBA PNG 序列。outDir 是父目录已存在的新目录。 */
export async function renderAnchoredOverlayFrames({ meta, params, outDir, pageSource, timeoutMs }) {
  const { size, fps, film } = meta?.[0] ?? {};
  parseFps(fps);
  const frames = meta.length;
  const callouts = createFrameOverlay({ size, frames }, meta, params);
  if (typeof outDir !== 'string' || !outDir.trim() || outDir.includes('\0')) throw bad('overlay.outDir 必须是非空路径');
  const dir = resolve(outDir);
  if (existsSync(dir)) throw bad('overlay.outDir 必须是新目录');
  const rgba = Buffer.alloc(size[0] * size[1] * 4);
  const ffmpeg = tools().ffmpeg;
  const work = mkdtempSync(join(dirname(dir), '.beiming-x7-'));
  const workspace = join(work, 'page');
  let session;
  try {
    if (pageSource) {
      session = await pageSource.open({
        film, output: { size, fps, frames }, shot: {
          id: 'x7-overlay', in: 0, out: frames, source: 'three', host: 'page', mode: 'native-code',
          entry: basename(ENTRY), seed: 0, colorRef: 'display', params: { meta, overlay: params },
        },
      }, { lock: null, tier: 'final', filmDir: dirname(ENTRY), workspace });
    }
    for (let f = 0; f < frames; f++) {
      if (session) {
        const { layers } = await session.render(f, {}, ['color']);
        pageRgba8(readFileSync(join(workspace, layers.color.file)), rgba);
      } else {
        rgba.fill(0);
        callouts.object.draw(f, rgba);
      }
      runTool(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'rawvideo', '-pixel_format', 'rgba',
        '-video_size', size.join('x'), '-i', '-', '-frames:v', '1', '-threads:v', '1', '-c:v', 'png',
        '-update', '1', framePath(join(work, PATTERN), f)], { input: rgba, timeoutMs, what: `写叠加层第 ${f} 帧` });
    }
    await session?.close();
    session = undefined;
    rmSync(workspace, { recursive: true, force: true });
    renameSync(work, dir);
    return { pattern: join(dir, PATTERN), kind: 'png', start: 0 };
  } finally {
    try { await session?.close(); } finally { rmSync(work, { recursive: true, force: true }); }
  }
}

/** 把透明序列挂到指定镜头，再按 film 的镜头表与硬切交给 deliver。其余参数沿用 deliver。 */
export function composeMixedFilm({ overlayShot, overlay, frames, ...opts }) {
  const { film } = opts;
  if (!(film?.shots?.length >= 2) || !film.shots.some((s) => s.id === overlayShot) || !frames?.[overlayShot] || !overlay) {
    throw bad('混用交付需要至少两镜头，并指定有底图和透明序列的 overlayShot');
  }
  if (!film.delivery?.web || !film.delivery.contact) throw bad('混用交付六件套需要开启 delivery.web 和 delivery.contact');
  return deliver({ ...opts, frames: { ...frames, [overlayShot]: { ...frames[overlayShot], overlay } } });
}

/** 读 8 位 RGB(A) 中亮点的像素中心质心。roi 为半开像素窗口，RGBA 时也用阈值排除透明像素。 */
export function measureOverlayAnchorCenter(pixels, { size, channels = 3, roi, threshold = 235 } = {}) {
  const [width, height] = Array.isArray(size) ? size : [];
  const bounds = roi ?? [0, 0, width, height];
  if (size?.length !== 2 || ![width, height].every((n) => Number.isSafeInteger(n) && n > 0) || ![3, 4].includes(channels)
      || !(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) || pixels.length !== width * height * channels
      || !Array.isArray(bounds) || bounds.length !== 4 || !Array.from(bounds).every(Number.isInteger)
      || !Number.isFinite(threshold) || threshold < 0 || threshold > 255) throw bad('质心量测需要匹配的 RGB(A) 像素、整数窗口和 8 位阈值');
  const [x0, y0, x1, y1] = bounds;
  let sx = 0, sy = 0, count = 0;
  for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
      const i = (y * width + x) * channels;
      if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2], channels === 4 ? pixels[i + 3] : 255) < threshold) continue;
      sx += x + 0.5;
      sy += y + 0.5;
      count++;
    }
  }
  return count ? [sx / count, sy / count] : null;
}
