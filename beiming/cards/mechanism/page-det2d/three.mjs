// 页面宿主会给每个镜头一个新页面。字体预检放在模块装载屏障里（运行时的 create 不可异步）。
/* global URL, location, fetch, crypto, btoa, FontFace, document, window, Element, devicePixelRatio */
import { createTwoDStage } from '../../../sources/three/two-d.js';
import { bad, FONT, hostField, pageConfig, requireValue, stagePlan } from './config.mjs';

async function prepare() {
  const url = new URL(FONT.path, import.meta.url);
  requireValue(url.origin === location.origin && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname), '字体只从回环页面宿主装载');
  const response = await fetch(url, { mode: 'same-origin', redirect: 'error', credentials: 'omit' });
  requireValue(response.ok && response.url === url.href, '锁定的本地字体取不到');
  const bytes = await response.arrayBuffer(), digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  requireValue(`sha256-${btoa(String.fromCharCode(...digest))}` === FONT.integrity, '字体字节与锁不符');
  // FontFace 持有刚才核过的字节，不把 URL 再交给排版器取第二次。
  const face = await new FontFace(FONT.family, bytes, { weight: '100 900' }).load();
  await document.fonts.ready;
  return { THREE: await import('three'), face };
}
const native = typeof window === 'undefined' ? null : await prepare().catch((err) => { throw bad(`本地字体或页面依赖未就绪：${err.message}`); });
const handles = new WeakMap();
let active = null, policyInstalled = false;

// CSP 在浏览器资源加载层执行（含 fetch/XHR、CSS、图片、字体等），不是只检查一个网络开关。
// 已应用的 CSP 不能通过移除 meta 撤销；契约要求每个会话独占页面，策略同页面一起结束。
function lockDocument() {
  if (!policyInstalled) {
    const policy = document.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'";
    document.head.append(policy);
    policyInstalled = true;
  }
  const sheet = document.createElement('style');
  sheet.textContent = '@layer det2d { *,*::before,*::after { animation:none!important; transition:none!important; scroll-behavior:auto!important; -webkit-font-smoothing:antialiased!important; } }';
  document.head.prepend(sheet);
  const undo = [() => sheet.remove()];
  try {
    const denied = () => { throw bad('页面只按帧号出图，不接受定时器或动画'); };
    for (const [owner, names] of [[window, ['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback']], [Element.prototype, ['animate']]]) {
      for (const name of names) {
        const old = Object.getOwnPropertyDescriptor(owner, name);
        if (!old) continue;
        Object.defineProperty(owner, name, { ...old, value: denied });
        undo.push(() => Object.defineProperty(owner, name, old));
      }
    }
    return () => undo.reverse().forEach((restore) => restore());
  } catch (e) { undo.reverse().forEach((restore) => restore()); throw e; }
}
function ready(face) {
  requireValue(face.status === 'loaded' && document.fonts.status === 'loaded' && document.fonts.has(face) && document.fonts.check(`16px "${FONT.family}"`), '锁定字体未就绪');
  requireValue([...document.fonts].every((other) => other === face), '独占的二维舞台含未登记字体');
}

/** 同步的 CR create。cards-data 由宿主挂 object、调 apply；原生代码经 mountStage 走同一生命周期。 */
export function create(ctx, params = {}) {
  const cfg = pageConfig(ctx, params), THREE = hostField(ctx, 'THREE'), r = hostField(ctx, 'renderer');
  requireValue(native && THREE === native.THREE && r && Object.getPrototypeOf(r) === THREE.WebGLRenderer.prototype, '必须由 three/page 宿主创建');
  const gl = r.getContext();
  requireValue(devicePixelRatio === cfg.pixelRatio && gl.getContextAttributes()?.antialias === cfg.antialias, '设备像素比必须为 1，WebGL 必须禁用 MSAA');
  const object = new THREE.Group();
  if (!active) {
    document.fonts.add(native.face);
    try {
      ready(native.face);
      const ratio = r.getPixelRatio(), space = r.outputColorSpace, tone = r.toneMapping, bufferSpace = gl.drawingBufferColorSpace;
      const unlock = lockDocument();
      active = { refs: 0, r, paper: new THREE.Color(cfg.paper), backgrounds: new Map(), release() {
        for (const [scene, original] of this.backgrounds) if (scene.background === this.paper) scene.background = original;
        unlock(); document.fonts.delete(native.face);
        r.setPixelRatio(ratio); r.outputColorSpace = space; r.toneMapping = tone; gl.drawingBufferColorSpace = bufferSpace;
      } };
      r.outputColorSpace = THREE.SRGBColorSpace; gl.drawingBufferColorSpace = cfg.colorProfile;
      r.toneMapping = THREE.NoToneMapping; r.setPixelRatio(cfg.pixelRatio);
    } catch (e) { if (active) active.release(); else document.fonts.delete(native.face); active = null; throw e; }
  }
  requireValue(active.r === r, '一个页面只用于一个渲染器');
  const scope = active;
  scope.refs++;
  const handle = { object,
    apply(f, sub) {
      requireValue(handles.has(handle) && Number.isSafeInteger(f) && f >= 0 && Number.isFinite(sub) && sub >= 0 && sub < 1, '失效的实例或不合法的帧键');
      ready(native.face);
      requireValue(!document.getAnimations().some((a) => a.playState === 'running' || a.pending), '页面含墙钟动画');
      requireValue(r.getPixelRatio() === cfg.pixelRatio && gl.drawingBufferColorSpace === cfg.colorProfile && r.outputColorSpace === THREE.SRGBColorSpace && r.toneMapping === THREE.NoToneMapping, '渲染器的确定性配置被改写');
      const scene = object.parent;
      requireValue(scene?.isScene === true, '机制对象必须挂在场景上');
      if (!scope.backgrounds.has(scene)) scope.backgrounds.set(scene, scene.background);
      scene.background = scope.paper;
    },
    dispose() {
      if (!handles.delete(handle)) return;
      object.removeFromParent();
      if (--scope.refs === 0) { scope.release(); active = null; }
    },
  };
  handles.set(handle, ctx);
  return handle;
}

/** 原生 S3 使用一组惰性面板声明，不执行调用方的绘制回调。字用内联子集的灰阶覆盖；网格不插值、不用 MSAA。 */
export function mountStage(ctx, page, panels) {
  requireValue(handles.has(page) && handles.get(page) === ctx, '需要同一镜头的 page.det2d 实例');
  const plan = stagePlan(ctx, panels);
  const elements = plan.map(({ name, rect, fill, text, fontPx, from, until, fade }) => ({ kind: 'canvas2d', name, rect,
    opacity: (f) => f < from || f >= until ? 0 : f < until - fade ? 1 : (until - f) / (fade + 1),
    draw(c, tools) {
      c.imageSmoothingEnabled = false;
      c.fillStyle = fill; c.fillRect(0, 0, tools.width, tools.height);
      if (!text) return;
      c.font = `400 ${fontPx}px "${FONT.family}"`; c.fillStyle = '#101010';
      tools.text(`${name}.line`, text, 2, fontPx);
    },
  }));
  return createTwoDStage(ctx, { elements }).then((stage) => {
    stage.scene.background = null; // 纸底只有机制的 apply 写，S3 的默认底色不能掩盖漏装。
    stage.scene.add(page.object);
    for (const mesh of Object.values(stage.entities)) mesh.material.map.minFilter = mesh.material.map.magFilter = native.THREE.NearestFilter;
    return { ...stage,
      state(f, sub) { page.apply(f, sub); stage.state(f, 0); },
      dispose() { try { stage.dispose(); } finally { page.dispose(); } },
    };
  });
}
