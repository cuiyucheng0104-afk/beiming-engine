// 北冥引擎 · 在页面脚本之前注入的两段代码（page.addInitScript）。都不改变页面画面：
//   renderInfo(info)   window.__RENDER = Object.freeze({ fps, width, height, profile, frameCount, contract })：
//                      渲染器告诉页面这次按什么帧率、尺寸、档位出片（页面约定 v1，README「页面约定」）。fps 为 null 表示
//                      调用方没指定帧率，页面按自己的帧率（并声明 window.FPS）
//   faultWatch()       给每个 WebGL / WebGL2 上下文的画布挂 webglcontextlost 监听，触发时记进 window.__BEIMING_FAULTS；
//                      包装 HTMLCanvasElement / OffscreenCanvas 的 getContext，参数原样转交，返回的上下文不变
// 渲染器每帧 render 之后读一次 __BEIMING_FAULTS 的长度：上下文丢失（显存不够、驱动 TDR、forceContextLoss）立即判失败，
// 不会把后面的黑帧编码进成片。

export function renderInfo(info) {
  Object.defineProperty(window, '__RENDER', { value: Object.freeze({ ...info }), writable: false, configurable: false, enumerable: false });
}

export function faultWatch() {
  if (window.__BEIMING_FAULTS) return;
  const faults = [];
  Object.defineProperty(window, '__BEIMING_FAULTS', { value: faults, writable: false, configurable: false, enumerable: false });
  const watched = new WeakSet();
  const watch = canvas => {
    if (watched.has(canvas)) return;
    watched.add(canvas);
    canvas.addEventListener('webglcontextlost', () => { faults.push({ kind: 'context-lost', canvas: canvas.id || canvas.constructor.name }); });
  };
  for (const C of [globalThis.HTMLCanvasElement, globalThis.OffscreenCanvas]) {
    if (!C?.prototype?.getContext) continue;
    const original = C.prototype.getContext;
    Object.defineProperty(C.prototype, 'getContext', {
      configurable: true, writable: true,
      value: function getContext(type, ...rest) {
        const ctx = original.call(this, type, ...rest);
        if (ctx && /^(webgl2?|experimental-webgl)$/i.test(String(type))) watch(this);
        return ctx;
      },
    });
  }
}
