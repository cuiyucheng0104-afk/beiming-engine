// 北冥引擎 · 离屏出片 · 出片宿主：在 Node + Dawn 里替作品模块建渲染器与渲染目标，按帧号渲一帧并读回像素。没有画布，也没有浏览器。
//   createHost({ gpu, width, height, fps = 24, device, query = '' }) → Promise<Host>
//       query：交给作品 build 的查询串（同页面的 location.search，不带 ?），作品按它切预演、调试等模式
//       gpu 来自 load.mjs 的 loadGpu()；给了 device 就共用它（一张卡上同时出多部片时共用一个 GPUDevice）
//   Host.load(file)             动态导入作品模块（绝对路径）并调用（await）build({ THREE, TSL, renderer, width, height, fps, pipeline, query })；
//                               作品契约见 docs/offscreen/README.md 2.1
//   Host.renderFrame(work, f)   推进帧时钟（时刻 = f / fps），把 work.render(f) 画进 sRGB 渲染目标，不等待地发起读回；
//                               返回读回的 Promise<Uint8Array>（RGBA8，行序自上而下）。读回的拷贝命令在返回前已提交，可以接着渲下一帧
//   Host.renderFrameYuv(work,f) 同上，但经 GPU 计算管线直接打包成有限范围 BT.709 yuv420p（width×height×1.5 字节，省 62.5% 读回与 CPU swscale）
//   Host.pipeline(node)         后期管线工厂：RenderPipeline，关掉管线内的 sRGB 输出变换（渲染目标已经是 sRGB，再转一次会亮一截）
//   Host.dispose()              释放作品、管线、渲染目标与渲染器（自己建的设备随渲染器销毁；共用的设备不动）
// 帧时钟见 clock.mjs：three 在构造渲染器时取全局 self 当动画循环的上下文，所以每个宿主在构造前把自己的时钟装成 self。
import { pathToFileURL } from 'node:url';
import { createFrameClock } from './clock.mjs';
import { createYuvPacker } from './yuv.mjs';
import { CliError, usageError } from '../../tools/lib/cli.mjs';

export async function createHost({ gpu, width, height, fps = 24, device, query = '' } = {}) {
  const { THREE, TSL } = gpu;
  let ownsDevice = false;
  if (!device) {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new CliError('env.webgpu-unavailable', 'Dawn 拿不到 WebGPU 适配器', { hint: '检查显卡驱动与 Vulkan / Metal 支持；离屏出片不回退到 WebGL' });
    try { device = await adapter.requestDevice({ requiredFeatures: [...adapter.features] }); }
    catch (e) { throw new CliError('env.webgpu-unavailable', `Dawn 创建 GPU 设备失败：${e.message}`, { hint: '检查显卡驱动与当前 GPU 资源' }); }
    ownsDevice = true;
  }
  const limit = device.limits.maxTextureDimension2D;
  if (width > limit || height > limit) {
    if (ownsDevice) device.destroy();
    throw usageError('bad-value', `画幅 ${width}x${height} 超过设备纹理边长上限 ${limit}`, '减小 --size，或使用支持该画幅的 GPU');
  }
  const clock = createFrameClock();
  globalThis.self = clock.self;
  const canvas = {
    width, height, style: {}, addEventListener() {}, removeEventListener() {},
    getContext() { throw new Error('离屏宿主没有画布上下文：作品只能画进宿主给的渲染目标'); },
  };
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, device });
  let fault = null;
  const recordFault = info => { fault ??= new CliError('failure.gpu', `GPU 错误：${info.message || '设备不可用'}`, { hint: '检查显存与驱动，减少并发或画幅后重试' }); };
  const onGpuError = event => recordFault(event.error ?? event);
  renderer.onError = renderer.onDeviceLost = recordFault;
  try {
    await renderer.init();
    if (!renderer.backend.isWebGPUBackend) throw new CliError('env.webgpu-unavailable', 'Dawn 未建立 WebGPU 后端', { hint: '检查显卡驱动，离屏出片不支持 WebGL 回退' });
  } catch (e) {
    renderer.dispose();
    if (ownsDevice) device.destroy();
    throw e;
  }
  device.addEventListener('uncapturederror', onGpuError);
  const check = () => { if (fault) throw fault; };
  renderer.setSize(width, height, false);
  const target = new THREE.RenderTarget(width, height, { colorSpace: THREE.SRGBColorSpace });
  const pipelines = [], works = [];
  let yuvPacker = null;
  const pipeline = node => {
    const p = new THREE.RenderPipeline(renderer, node);
    p.outputColorTransform = false;
    pipelines.push(p);
    return p;
  };
  return {
    THREE, TSL, renderer, device: renderer.backend.device, width, height, fps, pipeline,
    async load(file) {
      const mod = await import(pathToFileURL(file).href);
      if (typeof mod.build !== 'function') throw new TypeError(`${file} 没有导出 build(ctx)：作品模块契约见 docs/offscreen/README.md 2.1`);
      const work = await mod.build({ THREE, TSL, renderer, width, height, fps, pipeline, query: new URLSearchParams(query) });   // build 可以是 async（真片要先载字体、画布）
      if (typeof work?.render !== 'function') throw new TypeError(`${file} 的 build() 要返回 { render(f) }`);
      works.push(work);
      return work;
    },
    renderFrame(work, f) {
      check();
      clock.tick((f * 1000) / fps);
      renderer.setRenderTarget(target);
      work.render(f);
      return renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height).then(px => { check(); return px; });
    },
    renderFrameYuv(work, f) {
      check();
      clock.tick((f * 1000) / fps);
      renderer.setRenderTarget(target);
      work.render(f);
      yuvPacker ??= createYuvPacker({ device: renderer.backend.device, width, height });
      const gpuTex = renderer.backend.get(target.texture)?.texture;
      if (!gpuTex) throw new CliError('failure.gpu', '渲染目标未分配 GPU 纹理（作品 render(f) 没有向目标绘制任何内容）', null);
      return yuvPacker.packTexture(gpuTex).then(px => { check(); return px; });
    },
    dispose() {
      for (const w of works) w.dispose?.();
      for (const p of pipelines) p.dispose?.();
      yuvPacker?.dispose();
      device.removeEventListener('uncapturederror', onGpuError);
      target.dispose();
      renderer.dispose();
      if (ownsDevice) device.destroy();
    },
  };
}
