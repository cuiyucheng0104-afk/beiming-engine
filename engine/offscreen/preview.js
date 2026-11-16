// 北冥引擎 · 离屏出片 · 预览宿主（在浏览器里跑）：用 Chrome 的 WebGPU 渲作品模块，接口与出片宿主 host.mjs 一致，两边加载同一份作品。
//   createPreviewHost({ THREE, TSL, canvas, width, height, fps = 24 }) → Promise<Host>
//       THREE、TSL 由页面经 import map 取 three-webgpu（r187）后传进来；canvas 是给 WebGPURenderer 的画布（可以不挂到页面上）
//   Host.load(url)              动态导入作品模块（同源 URL）并调用 build({ THREE, TSL, renderer, width, height, fps, pipeline })
//   Host.renderFrame(work, f)   先等一次真实的 requestAnimationFrame（three 在那里推进节点帧号），再把 work.render(f) 画进 sRGB 渲染目标并读回；
//                               返回 Promise<Uint8Array>（RGBA8，行序自上而下），与出片宿主读回的字节格式相同
//   Host.show(work, f, ctx2d)   渲一帧，把读回的像素画到一个 2D 画布上看（显示的就是对拍用的那份像素）
//   Host.pipeline(node)         后期管线工厂（关掉管线内的 sRGB 输出变换，理由同 host.mjs）
// 页面上拿不到 WebGPU 适配器时，WebGPURenderer.init() 会抛错：Linux 的无头浏览器要加 --enable-unsafe-webgpu --enable-features=Vulkan。
export function resolvePreviewWork(value, base = location.href) {
  const url = new URL(value, base);
  if (typeof value !== 'string' || !value.startsWith('/') || url.origin !== new URL(base).origin) throw new Error('作品模块必须是同源仓库路径');
  return url.href;
}

export async function createPreviewHost({ THREE, TSL, canvas, width, height, fps = 24 }) {
  if (!navigator.gpu) throw new Error('这个浏览器没有 WebGPU（navigator.gpu 不存在）');
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  await renderer.init();
  if (!renderer.backend.isWebGPUBackend) throw new Error('WebGPURenderer 落到了 WebGL 后端：浏览器拿不到 WebGPU 适配器');
  renderer.setSize(width, height, false);
  const target = new THREE.RenderTarget(width, height, { colorSpace: THREE.SRGBColorSpace });
  const pipelines = [], works = [];
  const pipeline = node => {
    const p = new THREE.RenderPipeline(renderer, node);
    p.outputColorTransform = false;
    pipelines.push(p);
    return p;
  };
  const nextFrame = () => new Promise(r => requestAnimationFrame(r));
  const host = {
    THREE, TSL, renderer, width, height, fps, pipeline,
    async load(url) {
      const mod = await import(resolvePreviewWork(url));
      if (typeof mod.build !== 'function') throw new TypeError(`${url} 没有导出 build(ctx)`);
      const work = mod.build({ THREE, TSL, renderer, width, height, fps, pipeline });
      works.push(work);
      return work;
    },
    async renderFrame(work, f) {
      await nextFrame();
      renderer.setRenderTarget(target);
      work.render(f);
      return renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
    },
    async show(work, f, ctx2d) {
      const px = await host.renderFrame(work, f);
      ctx2d.putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength), width, height), 0, 0);
    },
    dispose() {
      for (const w of works) w.dispose?.();
      for (const p of pipelines) p.dispose?.();
      target.dispose();
      renderer.dispose();
    },
  };
  return host;
}
