// 北冥引擎 · 离屏出片 · 装载：Node 里的 WebGPU（Dawn 官方绑定 webgpu）与 three.js r187 的 WebGPU / TSL 构建。
//   loadGpu() → Promise<{ THREE, TSL }>
//     首次调用前按 WP1.3 规范配置驱动级着色器磁盘缓存（落入仓库 .cache/offscreen-shader-cache，尊重用户已有环境变量）；
//     把 Dawn 的全局（navigator.gpu、GPUBufferUsage、GPUTextureUsage 等）装进 globalThis，之后返回同一份。
//     缺 webgpu 或 three-webgpu 时抛 CliError('env.offscreen-deps')（退出码 3）。
//   configureShaderCacheEnv(env?, opts?) → { enabled, dir, nvidiaPath, mesaPath, reason }
//     纯配置函数：必须在 import('webgpu') 触发 Vulkan/GL 驱动加载前调用；目录不可写时静默降级，不阻断渲染。
// three 仍锁 r170（旧作品与页面渲染器用）；这里用别名包 three-webgpu（= three@0.187.0）取 r187，两版不混用。
// 这条链路只用宽松许可组件：不 import engine/native/，不读 RAEA_BIN、BNE_RT_BIN（决定 D12）。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CliError } from '../../tools/lib/cli.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function tryMkdir(dir, mkdir) {
  try {
    mkdir(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export function configureShaderCacheEnv(env = process.env, { root = REPO_ROOT, mkdir = fs.mkdirSync } = {}) {
  const toggle = String(env.BEIMING_SHADER_CACHE ?? '').trim().toLowerCase();
  if (toggle === '0' || toggle === 'off' || toggle === 'false') {
    return { enabled: false, dir: null, nvidiaPath: null, mesaPath: null, reason: 'disabled-by-env' };
  }
  const baseDir = env.BEIMING_SHADER_CACHE_DIR
    ? path.resolve(root, env.BEIMING_SHADER_CACHE_DIR)
    : path.join(root, '.cache', 'offscreen-shader-cache');

  let nvidiaPath = env.__GL_SHADER_DISK_CACHE_PATH ?? null;
  if (env.__GL_SHADER_DISK_CACHE === undefined) env.__GL_SHADER_DISK_CACHE = '1';
  if (env.__GL_SHADER_DISK_CACHE !== '0') {
    if (env.__GL_SHADER_DISK_CACHE_SKIP_CLEANUP === undefined) env.__GL_SHADER_DISK_CACHE_SKIP_CLEANUP = '1';
    if (env.__GL_SHADER_DISK_CACHE_PATH === undefined) {
      const nvDir = path.join(baseDir, 'nvidia');
      if (tryMkdir(nvDir, mkdir)) {
        env.__GL_SHADER_DISK_CACHE_PATH = nvDir;
        nvidiaPath = nvDir;
      }
    }
  }

  let mesaPath = env.MESA_SHADER_CACHE_DIR ?? null;
  const mesaOff = String(env.MESA_SHADER_CACHE_DISABLE ?? '').trim().toLowerCase();
  if (mesaOff !== 'true' && mesaOff !== '1' && env.MESA_SHADER_CACHE_DIR === undefined) {
    const mesaDir = path.join(baseDir, 'mesa');
    if (tryMkdir(mesaDir, mkdir)) {
      env.MESA_SHADER_CACHE_DIR = mesaDir;
      mesaPath = mesaDir;
    }
  }

  return { enabled: true, dir: baseDir, nvidiaPath, mesaPath, reason: null };
}

let loaded = null;

export async function loadGpu() {
  if (loaded) return loaded;
  configureShaderCacheEnv();
  let dawn, THREE, TSL;
  try {
    dawn = await import('webgpu');
    THREE = await import('three-webgpu/webgpu');
    TSL = await import('three-webgpu/tsl');
  } catch (e) {
    throw new CliError('env.offscreen-deps', `加载不了离屏出片的依赖（${String(e?.message ?? e).split('\n')[0]}）`, {
      hint: '在仓库根运行 npm install --include=optional --ignore-scripts（需要可选依赖 webgpu 与 three-webgpu）',
    });
  }
  Object.assign(globalThis, dawn.globals);
  const gpu = dawn.create([]);
  if (globalThis.navigator) Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true });
  else globalThis.navigator = { gpu };
  loaded = { THREE, TSL };
  return loaded;
}
