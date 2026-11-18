// 北冥引擎 · 离屏出片 · 装载：Node 里的 WebGPU（Dawn 官方绑定 webgpu）与 three.js r187 的 WebGPU / TSL 构建。
//   loadGpu() → Promise<{ THREE, TSL }>
//     首次调用时把 Dawn 的全局（navigator.gpu、GPUBufferUsage、GPUTextureUsage 等）装进 globalThis，之后返回同一份。
//     缺 webgpu 或 three-webgpu 时抛 CliError('env.offscreen-deps')（退出码 3）。
// three 仍锁 r170（旧作品与页面渲染器用）；这里用别名包 three-webgpu（= three@0.187.0）取 r187，两版不混用。
// 这条链路只用宽松许可组件：不 import engine/native/，不读 RAEA_BIN、BNE_RT_BIN（决定 D12）。
import { CliError } from '../../tools/lib/cli.mjs';

let loaded = null;

export async function loadGpu() {
  if (loaded) return loaded;
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
