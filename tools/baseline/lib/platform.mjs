// 北冥仓库 · 平台键：从 WebGL 实际报出的渲染器字串判断后端与设备，金标准按平台分组存放。
//
//   backendOf(renderer)   'metal' | 'vulkan' | 'd3d11' | 'd3d9' | 'gl' | 'swiftshader' | 'llvmpipe' | 'warp' | 'unknown'
//   isSoftware(backend)   软件光栅（SwiftShader、llvmpipe、WARP）
//   osKey()               'darwin' | 'win' | 'linux'
//   platformKey(renderer) 例：darwin-metal、win-vulkan、linux-swiftshader（目录名，也是清单里的 platformKey）
//   deviceSlug(renderer)  例：apple-m5-pro、nvidia-geforce-rtx-5090、swiftshader-device-subzero
//   toolVersions(root)    { node, playwright, three }（从 root/node_modules 读，不 import 包）
// 同一平台键下，设备或浏览器版本不同也照样比，只是按容差判定并在报告里提示；平台键不同时只能按跨平台容差（SSIM/PSNR）比。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function backendOf(renderer = '') {
  const r = String(renderer).toLowerCase();
  if (r.includes('swiftshader')) return 'swiftshader';
  if (/llvmpipe|softpipe/.test(r)) return 'llvmpipe';
  if (/basic render|\bwarp\b/.test(r)) return 'warp';
  if (r.includes('metal')) return 'metal';
  if (r.includes('vulkan')) return 'vulkan';
  if (/direct3d11|d3d11/.test(r)) return 'd3d11';
  if (/direct3d9|d3d9/.test(r)) return 'd3d9';
  if (r.includes('opengl')) return 'gl';
  return 'unknown';
}
export const isSoftware = b => ['swiftshader', 'llvmpipe', 'warp'].includes(b);
export function osKey(p = process.platform) {
  return p === 'darwin' ? 'darwin' : p === 'win32' ? 'win' : p === 'linux' ? 'linux' : p;
}
export const platformKey = renderer => `${osKey()}-${backendOf(renderer)}`;

export function deviceName(renderer = '') {
  const r = String(renderer);
  let m = /Metal Renderer:\s*([^,)]+)/i.exec(r);
  if (m) return m[1].trim();
  m = /Vulkan [\d.]+ \((.+?) \(0x[0-9a-f]+\)\)/i.exec(r);
  if (m) return m[1].trim();
  m = /ANGLE \([^,]+,\s*(.+?) \(0x[0-9a-f]+\)/i.exec(r);
  if (m) return m[1].trim();
  m = /ANGLE \([^,]+,\s*([^,]+)/i.exec(r);
  if (m) return m[1].trim();
  return r.trim() || 'unknown';
}
export const deviceSlug = renderer => deviceName(renderer).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'unknown';

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
export function toolVersions(root) {
  return {
    node: process.versions.node,
    playwright: readJson(path.join(root, 'node_modules/playwright-core/package.json'))?.version ?? null,
    three: readJson(path.join(root, 'node_modules/three/package.json'))?.version ?? null,
  };
}
export const osDescription = () => `${os.platform()} ${os.release()} ${os.arch()}`;
