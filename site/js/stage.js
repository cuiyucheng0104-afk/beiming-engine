// 北冥作品站 · 舞台（实时引擎）：青绿仙山鲲在访客浏览器里一帧一帧地被算出来。
// 鲲用影片原版代码构建（src/kun_qinglv.js 的 createKun、src/toon_qinglv.js 的卡通材质），
// 合成移植自 lab/kun_qinglv.js（两遍渲染 + 墨线着色器），纸纹与雾用 engine/look 的模块，时间量化用 engine/core/clock.js。
// 接口见 site/CONTRACT.md 第 2 节；机位见 ./stage/rig.js，合成见 ./stage/compositor.js，画质与 CPU 探针见 ./stage/quality.js。
//
//   const stage = await createStage(canvas, { reducedMotion, quality, onStats });   // null = 不支持 / 初始化失败 / 设备太慢
//   stage.setScene('hero' | 'layers' | 'idle', progress)   stage.setLayer(0..4)   stage.setPointer(nx, ny)
//   stage.play() / pause() / resize() / dispose()          await stage.firstFrame（太久画不出来会 reject）
//
// 额外（契约之外，调用方可以不理）：画布上会派发这些事件
//   'stage:lost'      detail.reason：'context'（WebGL 上下文丢失）或 'slow'（像素比降到最低档后仍连续 3 秒低于 15 fps，
//                     舞台已自行销毁）。
//                     调用方把海报接回来；'context' 之后可能还有 'stage:restored'，'slow' 之后不会再有。
//   'stage:restored'  上下文恢复、管线重新预热完，时间回到 t = 0（与海报同一姿态），可以再交叉淡入一次。
//   'stage:deferred'  这台设备建鲲要占主线程较久（detail.estMs），舞台会等访客停下来（detail.needScroll：还要先滚动过）、
//                     主线程空闲时再建；在那之前 createStage 不返回，海报一直在。
//   'stage:skipped'   createStage 即将返回 null 的原因：detail.reason = 'software'（软件渲染）或 'cpu'（建鲲预计 > 800 ms），
//                     调用方可以据此写更准确的读数（不支持 WebGL2 时不派发）。
//   'stage:beat'      鲲一拍三换姿态的那一帧（约每秒 8 次）：detail = { frame（24 fps 的全局帧号）, beat, scene, layer }，
//                     给“时”这一步的帧条之类的东西对拍用。
// stage.debug 只给开发测试页用。
//
// 时间：第一帧之后先停 1 秒（覆盖调用方 0.9 秒的交叉淡入：海报就是 t = 0 的姿态，须子、胸鳍对得上），再用 0.6 秒缓到正常速度。
// “时”这一步（layers 场景、进度过半、第 3.5 层以上）：起伏 5 → 14、点头 0.022 → 0.05，每 2.6 秒甩一次 0.8 秒的尾，
// 镜头缓慢环绕；一拍三的顿挫这样才看得出来。滚回“景”时恢复平滑。
import * as THREE from 'three';
import { createKun } from '@film/kun_qinglv.js';
import { setToonGlobals, PALETTE } from '@film/toon_qinglv.js';
import { frameOf, hold, heldTime } from '@engine/core/clock.js';
import { createCompositor } from './stage/compositor.js';
import { SCENES, POINTER_SCENES, KUN_CENTER, applyShot, blendShot, copyShot, gazeTarget } from './stage/rig.js';
import { pickTier, createGovernor, cpuProbe } from './stage/quality.js';

export const LAYERS = Object.freeze([
  { key: 'form', glyph: '形', module: 'engine/form' },
  { key: 'shade', glyph: '光', module: 'engine/shade' },
  { key: 'look', glyph: '笔', module: 'engine/look' },
  { key: 'stage', glyph: '景', module: 'engine/stage' },
  { key: 'time', glyph: '时', module: 'engine/core/clock.js' },
]);

const SKY_URL = new URL('../assets/stage-sky.webp', import.meta.url).href;
const SKY_ASPECT = 2;                          // stage-sky.webp 是 2:1（取自 assets/plates/sky_dawn.png）
const KEY_DIR = new THREE.Vector3(0.75, 0.1, 0.65).normalize();   // 主光方向同 lab/kun_qinglv.js：黄昏逆光
// 空气透视：从鲲最近处起算（start 每帧按机位距离给），越往尾巴、往远处越淡；颜色是天空同一支紫
const FOG = { color: '#a497d6', colorHigh: '#c3b4e6', density: 0.0009, start: 0, max: 0.5 };
const SCENE_BLEND = 1.2;                       // 换场景时机位过渡（秒）
// 最多约 60 帧每秒，省电：按“攒够一帧的时间再画”来跳帧。120 Hz 隔帧画，90 Hz 三帧画两帧（以前固定间隔跳帧，
// 90 Hz 屏上只剩 45 帧，降档逻辑还会把它当成卡顿），60 Hz 及以下每帧都画
const FRAME_MS = 1000 / 60;
const HOLD_MS = 1000, WAKE_MS = 600;           // 第一帧之后时间停 1 秒，再用 0.6 秒缓到正常速度
// “时”这一步把动作放大（ART-4）：起伏、点头 [平时, 放大]。摆尾（一次 0.8 秒、每 2.6 秒一次）：游动相位往前赶 2 秒，
// 横摆幅度 ×1.75、上下摆幅 ×2.5（尾鳍像鲸一样往下拍），身体借力抬起 12、抬头 0.03 弧度再落回。
// 平时的起伏每拍只动 1 像素多，一拍三看不出来；摆尾时整条鲲每拍跳 4–8 像素，顿挫一眼可见。镜头另外缓慢环绕
const TIME_FX = { bob: [5, 14], roll: [0.022, 0.05], flickDur: 0.8, flickEvery: 2.6, flickPhase: 2.0, flickAmpZ: 0.75, flickAmpY: 1.5,
  flickLift: 12, flickNod: 0.03, camYaw: 0.06, camPitch: 0.018 };
const LOW_FPS = 15, LOW_SECS = 3;              // 实时画面连续 3 秒低于 15 fps：自行销毁，交回海报
const FIRST_TIMEOUT_MS = 15000;                // 页面可见的时间累计 15 秒还画不出第一帧：firstFrame reject，调用方保持海报
// 建鲲是一整块同步计算（影片源码，拆不开；Worker 里用不了 importmap，也挪不过去），只能挑时机（UX-9）：
// 先用 cpuProbe() 探一下 CPU，按标定比例预估它要占多久主线程。实测（M5 Pro，Chrome 降速 1–6 倍；探针热身后取最快）
// 建鲲 ≈ 探针 × 39–49，手机档 lod 0.3 也一样（lod 只省 GPU，不省这段 CPU），取 46。
// ≤ 300 ms 直接建（M5 Pro 实测 130–210 ms）；≤ 500 ms 等访客 0.8 秒没有操作、主线程空闲时再建；
// ≤ 800 ms 还要等访客先滚动过（首屏的按钮不会被它卡住）；再慢（约比 M5 Pro 慢 5 倍以上的 CPU）就不建，只留海报和静帧。
const PROBE_K = 46, BUILD_NOW_MS = 300, BUILD_SCROLL_MS = 500, BUILD_MAX_MS = 800;
// 软件渲染（SwiftShader、llvmpipe、Windows 基本显示驱动）：直接放弃。一定要拿原始串判断：解析成显示名之后，
// 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device …), SwiftShader driver)' 只剩 'Vulkan 1.3.0'，会漏判（UX-3）
const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render|microsoft basic/i;

const clamp01 = x => Math.min(1, Math.max(0, x));
const lerp = (a, b, k) => a + (b - a) * k;
const smooth01 = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const easeInOut = k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));
const idle = () => new Promise(r => (window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 120 }) : setTimeout(r, 16)));

function rendererString(gl) {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch { return ''; }
}
// 显示用的简短 GPU 名（'ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, …)' → 'Apple M5 Pro'）
function gpuName(raw) {
  const m = /Renderer:\s*([^,)]+)/.exec(raw) || /^ANGLE \([^,]+,\s*([^,(]+)/.exec(raw);
  return (m ? m[1] : raw).trim().slice(0, 48);
}
const loseContext = gl => { try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* 无所谓 */ } };

function countTriangles(root) {
  let tri = 0;
  root.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry, t = (g.index ? g.index.count : g.attributes.position.count) / 3;
    tri += t * (o.isInstancedMesh ? o.count : (g.isInstancedBufferGeometry ? g.instanceCount : 1));
  });
  return Math.round(tri);
}

// 天空贴图：优先 createImageBitmap（在后台线程解码，不翻转；着色器里翻 v），老浏览器退回 TextureLoader
async function loadSky() {
  let tex = null;
  if (typeof createImageBitmap === 'function') {
    try {
      const res = await fetch(SKY_URL);
      if (!res.ok) throw new Error(`${res.status}`);
      const bmp = await createImageBitmap(await res.blob());
      tex = new THREE.Texture(bmp); tex.flipY = false; tex.userData.flipV = true; tex.needsUpdate = true;
    } catch { tex = null; }
  }
  if (!tex) { tex = await new THREE.TextureLoader().loadAsync(SKY_URL); tex.userData.flipV = false; }
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  return tex;
}

// 等访客停下来再建鲲：quietMs 内没有滚动、按键、点按、移动指针，页面可见，主线程进入空闲（requestIdleCallback 按时回调，
// 剩余时间 ≥ minIdle；页面上有别的 rAF 在跑时空闲期最多到下一帧，所以门槛不能设成 40–50 ms，否则永远等不到）；
// needScroll 时还要先滚动过（离开首屏的按钮区）。返回等了多少毫秒。
function quietMoment({ quietMs = 800, minIdle = 4, needScroll = false } = {}) {
  return new Promise(resolve => {
    const t0 = performance.now(), opts = { passive: true, capture: true };
    const INPUT = ['wheel', 'touchstart', 'touchmove', 'pointerdown', 'pointermove', 'keydown'];
    let scrolled = !needScroll || window.scrollY > 0, last = t0, timer = 0, done = false;
    const onScroll = () => { scrolled = true; last = performance.now(); };
    const onInput = () => { last = performance.now(); };
    window.addEventListener('scroll', onScroll, opts);
    INPUT.forEach(e => window.addEventListener(e, onInput, opts));
    const finish = () => {
      if (done) return;
      done = true; clearTimeout(timer);
      window.removeEventListener('scroll', onScroll, opts);
      INPUT.forEach(e => window.removeEventListener(e, onInput, opts));
      resolve(performance.now() - t0);
    };
    const quiet = () => document.visibilityState === 'visible' && scrolled && performance.now() - last >= quietMs;
    const check = () => {
      timer = 0;
      if (!quiet()) { timer = setTimeout(check, 250); return; }
      if (!window.requestIdleCallback) { finish(); return; }
      requestIdleCallback(dl => {
        if (quiet() && !dl.didTimeout && dl.timeRemaining() >= minIdle) finish();
        else timer = setTimeout(check, 200);
      }, { timeout: 1000 });
    };
    check();
  });
}

export async function createStage(canvas, { reducedMotion = false, quality = 'auto', onStats = null, lod = null, defer = true } = {}) {
  const T0 = performance.now();
  let renderer = null;
  try {
    // —— WebGL2 + 硬件加速（软件渲染时直接放弃，调用方继续显示海报）——
    const probe = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: true, stencil: false,
      powerPreference: 'high-performance', failIfMajorPerformanceCaveat: true, preserveDrawingBuffer: false });
    if (!probe) return null;
    const raw = rendererString(probe);
    if (SOFTWARE_GL.test(raw)) {
      console.warn(`[stage] 软件渲染（${raw.slice(0, 120)}），保持海报`);
      loseContext(probe);
      canvas.dispatchEvent(new CustomEvent('stage:skipped', { detail: { reason: 'software' } }));
      return null;
    }
    renderer = new THREE.WebGLRenderer({ canvas, context: probe, alpha: true, premultipliedAlpha: true, antialias: false });
  } catch (err) {
    console.warn('[stage] WebGL2 不可用：', err?.message || err);
    return null;
  }

  try {
    return await build(canvas, renderer, { reducedMotion, quality, onStats, T0, lodOverride: lod, defer });
  } catch (err) {
    console.warn('[stage] 初始化失败：', err?.message || err);
    try { renderer.dispose(); } catch { /* 已经坏了 */ }
    return null;
  }
}

async function build(canvas, renderer, { reducedMotion, quality, onStats, T0, lodOverride, defer }) {
  const gl = renderer.getContext();
  const gpu = gpuName(rendererString(gl));
  const floatRT = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
  if (!floatRT) { renderer.dispose(); return null; }

  const tier = pickTier(quality, { w: canvas.clientWidth || window.innerWidth, h: canvas.clientHeight || window.innerHeight });
  if (lodOverride) tier.lod = Math.min(1, Math.max(0.1, +lodOverride));   // 只给测试页调参用
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.info.autoReset = false;

  const skyP = loadSky().catch(err => { console.warn('[stage] 天空贴图加载失败：', err?.message || err); return null; });

  // —— 建鲲：先让出一帧，让海报与标题先画出来；再用 CPU 探针预估它要卡主线程多久，决定现在建、晚点建还是不建 ——
  await nextFrame();
  await idle();
  // 探针：先跑一遍热身（含 JIT 编译），再分 4 个任务各跑 3 遍，取最快的一次。单次冷跑的读数会撞上垃圾回收或别的脚本，
  // 同一台机器能差一倍以上（实测 12–55 ms），会把快机器误判成慢机器
  cpuProbe(1); await idle();
  let probeMs = Infinity;
  for (let i = 0; i < 4; i++) { probeMs = Math.min(probeMs, cpuProbe(3)); await idle(); }
  const estMs = probeMs * PROBE_K;
  let deferMs = 0;
  if (defer && !reducedMotion) {
    if (estMs > BUILD_MAX_MS) {
      console.warn(`[stage] 这台设备建鲲预计要占主线程约 ${Math.round(estMs)} ms，只保留海报`);
      renderer.dispose(); loseContext(gl);
      canvas.dispatchEvent(new CustomEvent('stage:skipped', { detail: { reason: 'cpu', estMs: Math.round(estMs) } }));
      return null;
    }
    if (estMs > BUILD_NOW_MS) {
      const needScroll = estMs > BUILD_SCROLL_MS;
      canvas.dispatchEvent(new CustomEvent('stage:deferred', { detail: { estMs: Math.round(estMs), needScroll } }));
      deferMs = await quietMoment({ quietMs: 800, needScroll });
    }
  }
  const tb = performance.now();
  const kun = createKun({ lod: tier.lod });
  const buildMs = performance.now() - tb;
  const triangles = countTriangles(kun.group);
  const AMPZ = kun.uniforms.uKunAmpZ.value, AMPY = kun.uniforms.uKunAmpY.value;   // 横摆、上下摆幅度（摆尾时临时加大）

  const scene = new THREE.Scene();
  scene.add(kun.group);
  const key = new THREE.DirectionalLight('#ffd3b0', 1);
  key.position.copy(KEY_DIR); key.target.position.set(0, 0, 0);
  scene.add(key, key.target);
  setToonGlobals({ fillDir: [0.08, -1, 0.1], keyDir: KEY_DIR.toArray(), pass: 0 });
  kun.fitShadow(key, { size: tier.shadow });

  const camera = new THREE.PerspectiveCamera(30, 16 / 9, 5, 6000);
  const comp = createCompositor(renderer, { msaa: tier.msaa });
  const sky = await skyP;
  comp.setSky(sky);

  // —— 状态 ——
  const S = {
    t: 0, liveMs: 0, playing: !reducedMotion, hidden: document.visibilityState === 'hidden', lost: false, disposed: false, gen: 0,
    scene: 'hero', progress: 0, progS: 0, layer: 4,
    pointer: { x: 0, y: 0 }, pointerS: { x: 0, y: 0 }, par: 0,
    shot: null, from: null, blendStart: -1,
    lastTs: NaN, pr: tier.ladder[0], cw: 0, ch: 0, aspect: 16 / 9, tune: null,
    raf: 0, lastNow: -1, prevRaf: -1, acc: 0, frames: 0, statT: 0, statFrames: 0, statGaps: [], calls: 0, firstDone: false, warm: false,
    boost: 0, forceBoost: null, flicks: [], swimOff: 0, flickOn: false, nextFlick: 0, lowSecs: 0,
  };
  const center = KUN_CENTER.clone();
  const gaze = new THREE.Vector3();
  const skyUV = new THREE.Vector4(1, 1, 0, 0);
  const ptr = { x: 0, y: 0 };
  let dist = 1000;

  const governor = createGovernor(tier, pr => { S.pr = pr; resize(true); });

  // —— 循环开关、静态补帧（先声明：resize 会用到）——
  const running = () => S.playing && !S.hidden && !S.lost && !S.disposed && !reducedMotion;
  let stillPending = false;
  function requestStill() {
    // 暂停 / 减少动态时：属性一变就补画一帧静态画面（合并到下一帧）
    if (stillPending || running() || S.disposed) return;
    stillPending = true;
    requestAnimationFrame(() => { stillPending = false; if (!running() && S.warm) draw(0, true); });
  }

  // —— 尺寸：用布局尺寸（clientWidth / clientHeight），不受 CSS transform 影响 ——
  function measure() {
    let w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) { const r = canvas.getBoundingClientRect(); w = r.width; h = r.height; }
    return [Math.round(w), Math.round(h)];
  }
  function resize(force = false) {
    if (S.disposed) return;
    const [cw, ch] = measure();
    if (!cw || !ch) return;                               // 画布还没显示出来：等 ResizeObserver
    if (!force && cw === S.cw && ch === S.ch && renderer.getPixelRatio() === S.pr) return;
    S.cw = cw; S.ch = ch; S.aspect = cw / ch;
    renderer.setPixelRatio(S.pr);
    renderer.setSize(cw, ch, false);
    const db = renderer.getDrawingBufferSize(new THREE.Vector2());
    comp.setSize(db.x, db.y);
    if (!S.playing || S.hidden || reducedMotion) requestStill();
  }
  let resizeTimer = 0;
  const ro = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    // 第一次立刻量；之后（手机地址栏伸缩、拖窗口）合并成一次，免得反复重建渲染目标
    if (!S.cw) resize(); else resizeTimer = setTimeout(() => resize(), 120);
  });
  ro.observe(canvas);

  // —— 时间：第一帧后先停住，再缓缓走起来（0 → 1）——
  const wake = () => smooth01((S.liveMs - HOLD_MS) / WAKE_MS);

  // —— “时”这一步的放大量：layers 场景、进度过半（叙事末尾，不是开头“拆开”之前）、第 3.5 → 4 层 ——
  function boostTarget() {
    if (S.forceBoost !== null) return S.forceBoost;
    if (S.scene !== 'layers' || S.progress < 0.5) return 0;
    return smooth01((Math.min(4, Math.max(0, S.layer)) - 3.5) / 0.5);
  }
  function updateBoost(dt, snap) {
    const target = boostTarget();
    S.boost = snap ? target : S.boost + (target - S.boost) * (1 - Math.exp(-dt / 0.25));
    if (S.boost < 1e-3 && target === 0) S.boost = 0;
  }
  // 摆尾：动作放大后每 2.6 秒甩一次。用动画时间记开始时刻，姿态按一拍三取样，所以甩尾本身也是 8 fps 的
  function scheduleFlicks() {
    if (S.boost > 0.6) {
      if (!S.flickOn) { S.flickOn = true; S.nextFlick = S.t + 0.15; }
      if (S.t >= S.nextFlick) {
        S.flicks.push(S.t); S.nextFlick = S.t + TIME_FX.flickEvery;
        while (S.flicks.length > 12 && S.flicks[0] + TIME_FX.flickDur < S.t - 1) { S.flicks.shift(); S.swimOff += TIME_FX.flickPhase; }
      }
    } else if (S.boost < 0.3) S.flickOn = false;
  }
  // 摆尾期间游动相位往前赶（尾巴快速扫过去），横摆幅度临时加大（正弦包络）
  function swimTime(tau) {
    let ts = tau + S.swimOff;
    for (const t0 of S.flicks) ts += TIME_FX.flickPhase * smooth01((tau - t0) / TIME_FX.flickDur);
    return ts;
  }
  function flickBump(tau) {
    let b = 0;
    for (const t0 of S.flicks) { const u = (tau - t0) / TIME_FX.flickDur; if (u > 0 && u < 1) b = Math.max(b, Math.sin(Math.PI * u)); }
    return b;
  }

  // —— 每帧：时钟 → 机位 → 姿态 → 渲染 ——
  function sceneShot(name, t) { return SCENES[name](S.aspect, S.progS, t); }

  function updateCamera(dt, snap) {
    const kP = snap ? 1 : 1 - Math.exp(-dt / 0.12), kM = snap ? 1 : 1 - Math.exp(-dt / 0.35);
    S.progS += (S.progress - S.progS) * kP;
    const parT = POINTER_SCENES.has(S.scene) ? wake() : 0;     // 交叉淡入期间不跟鼠标（和海报对齐）
    S.par += (parT - S.par) * kM;
    S.pointerS.x += (S.pointer.x - S.pointerS.x) * kM;
    S.pointerS.y += (S.pointer.y - S.pointerS.y) * kM;
    const target = S.tune ? { ...sceneShot(S.scene, S.t), ...S.tune } : sceneShot(S.scene, S.t);
    if (S.boost > 0) {                                        // “时”：镜头每帧都在动（缓慢环绕），鲲一拍三
      target.yaw += S.boost * TIME_FX.camYaw * Math.sin(S.t * 0.55);
      target.pitch += S.boost * TIME_FX.camPitch * Math.sin(S.t * 0.41 + 0.6);
    }
    if (S.from && !snap) {
      const k = clamp01((S.t - S.blendStart) / SCENE_BLEND);
      S.shot = blendShot(S.from, target, easeInOut(k), S.shot || {});
      if (k >= 1) S.from = null;
    } else { S.from = null; S.shot = copyShot(target, S.shot || {}); }
    dist = applyShot(camera, S.shot, S.aspect, center, S.pointerS, S.par);
    // 天空：cover 铺满，随机位轻微平移（远景视差）
    const zoom = 1.08, a = S.aspect / SKY_ASPECT;
    let sx = 1 / zoom, sy = 1 / zoom;
    if (a > 1) sy /= a; else sx *= a;
    const px = -S.shot.yaw * 0.12 + S.pointerS.x * 0.012 * S.par, py = -S.shot.pitch * 0.25 + S.pointerS.y * 0.01 * S.par;
    skyUV.set(sx, sy, clamp01((1 - sx) * (0.5 + px)), clamp01((1 - sy) * (0.42 + py)));
  }

  function poseKun(stepAmt, live, force) {
    const f = frameOf(S.t);
    const held = heldTime(f, 3);                        // 一拍三：每三帧换一次姿态（8 fps）
    const tau = S.t + (held - S.t) * stepAmt;           // 0–3 层平滑，4 层一拍三；中间按比例过渡
    const changed = tau !== S.lastTs;
    if (changed || stepAmt < 1 || force) {
      const ts = swimTime(tau), bump = flickBump(tau);
      kun.uniforms.uKunAmpZ.value = AMPZ * (1 + TIME_FX.flickAmpZ * bump);
      kun.uniforms.uKunAmpY.value = AMPY * (1 + TIME_FX.flickAmpY * bump);
      // 目光跟着姿态走：一拍三时只在换姿态的那一帧更新，平滑时每帧更新；交叉淡入期间不跟鼠标
      const w = wake(); ptr.x = S.pointerS.x * w; ptr.y = S.pointerS.y * w;
      gazeTarget(camera, ptr, dist, gaze);
      // 缓慢游动：上下起伏 + 微微点头 / 侧倾（和姿态同一个时间，所以也一拍三）；“时”这一步幅度放大
      const bob = lerp(TIME_FX.bob[0], TIME_FX.bob[1], S.boost), roll = lerp(TIME_FX.roll[0], TIME_FX.roll[1], S.boost);
      kun.group.position.set(0, bob * Math.sin(ts * 0.62) + TIME_FX.flickLift * bump, 0);
      kun.group.rotation.set(0.018 * Math.sin(ts * 0.5 + 0.4), 0, roll * Math.sin(ts * 0.43 + 1.1) + TIME_FX.flickNod * bump);
      kun.setPose(ts, { look: gaze });
      S.lastTs = tau;
      if (live && changed && stepAmt >= 1) {
        canvas.dispatchEvent(new CustomEvent('stage:beat', { detail: { frame: f, beat: hold(f, 3), scene: S.scene, layer: S.layer } }));
      }
    }
    return changed;
  }

  const fog = { ...FOG };
  const fogAt = () => { fog.start = Math.max(0, dist - 260); return fog; };

  function draw(dt, snap = false, live = false) {
    if (S.lost || S.disposed || !S.cw) return false;
    renderer.info.reset();
    const L = Math.min(4, Math.max(0, S.layer));
    if (snap) updateBoost(0, true);
    updateCamera(dt, snap);
    const shadow = poseKun(clamp01(L - 3), live, snap) || snap || !S.firstDone;
    const f = frameOf(S.t);
    const inkOn = clamp01(L - 1);
    setToonGlobals({ inkTime: hold(f, 2) });           // 影片共享时钟：瀑布流动、云片抖动，一拍二
    comp.render(scene, camera, {
      // 形：结构线用 --ink-soft 本色（浓度 1），轮廓与纸色的对比 ≥ 3:1（UX-13；原来 0.4 的淡墨只有约 2:1）
      toon: clamp01(L), lineForm: 1 - clamp01(L), ink: inkOn, grain: 0.12 * inkOn,
      sky: sky ? clamp01(L - 2) : 0, haze: clamp01(L - 2),
      inkT: L >= 1.5 ? hold(f, 2) : 0,                  // 墨线一拍二抖动
      skyUV, fog: fogAt(), shadow, lineFade: [dist * 0.75, dist * 1.7],
    });
    S.calls = renderer.info.render.calls;
    S.frames++;
    if (!S.firstDone) {
      S.firstDone = true;
      firstFrameMs = performance.now() - T0;
      nextFrame().then(() => resolveFirst({ ms: firstFrameMs }));
    }
    return true;
  }

  // —— 第一帧：画出来就 resolve；“该画却画不出来”的时间（在播放、页面可见、上下文正常）累计 15 秒就 reject，
  //    调用方保持海报。调用方暂停期间（滚到了作品区）不计时，免得回来以后实时画面已经被放弃 ——
  let resolveFirst, rejectFirst, firstFrameMs = 0, firstTimer = 0;
  const firstFrame = new Promise((res, rej) => { resolveFirst = res; rejectFirst = rej; });
  firstFrame.catch(() => { /* 调用方自己处理；这里只免掉“未处理的 rejection” */ });
  (function watchFirst() {
    let seen = 0, last = performance.now();
    const tick = () => {
      firstTimer = 0;
      const now = performance.now();
      if (S.playing && !S.lost && document.visibilityState === 'visible') seen += now - last;
      last = now;
      if (S.firstDone || S.disposed) return;
      if (seen > FIRST_TIMEOUT_MS) { rejectFirst(new Error('实时画面迟迟画不出第一帧')); return; }
      firstTimer = setTimeout(tick, 500);
    };
    firstTimer = setTimeout(tick, 500);
  })();

  // —— 循环 ——
  function loop(now) {
    S.raf = 0;
    if (!running()) return;
    S.raf = requestAnimationFrame(loop);
    if (!S.warm) return;                                // 管线还在预热：海报继续顶着
    if (S.prevRaf >= 0) S.acc += now - S.prevRaf;
    S.prevRaf = now;
    if (S.lastNow >= 0) {
      if (S.acc < FRAME_MS * 0.9) return;              // 高刷屏：攒够约一帧（60 fps）的时间再画
      S.acc -= FRAME_MS;
      if (S.acc < 0 || S.acc > FRAME_MS) S.acc = 0;    // 慢帧不追赶
    }
    const frameMs = S.lastNow < 0 ? 0 : now - S.lastNow;
    const dt = Math.min(0.1, frameMs / 1000);
    S.lastNow = now;
    if (S.firstDone) S.liveMs += frameMs;
    S.t += dt * wake();
    updateBoost(dt, false);
    scheduleFlicks();
    const t0 = performance.now();
    draw(dt, false, true);
    if (frameMs > 0) governor.frame(frameMs, now, performance.now() - t0);
    stats(now, frameMs);
  }
  function stats(now, frameMs) {
    S.statFrames++;
    if (frameMs > 0 && S.statGaps.length < 600) S.statGaps.push(frameMs);
    if (!S.statT) S.statT = now;
    const el = now - S.statT;
    if (el >= 1000) {
      const fps = S.statFrames * 1000 / el;
      const s = { fps: Math.round(fps), triangles, drawCalls: S.calls, pixelRatio: S.pr, gpu };
      const gaps = S.statGaps.sort((a, b) => a - b), mid = gaps.length ? gaps[gaps.length >> 1] : el;
      S.statT = now; S.statFrames = 0; S.statGaps = [];
      if (onStats) { try { onStats(s); } catch (e) { console.warn('[stage] onStats 出错：', e); } }
      // 连续 3 个统计窗口低于 15 fps（软件渲染漏判、极弱的显卡）：放弃实时画面，交回海报（UX-3）。
      // 只算“每一帧都慢”的窗口（帧间隔中位数也 > 1/15 秒）：偶尔一次长卡顿（别的脚本、截图）不算；
      // 而且要先让降档试过：像素比已经降到最低档还这么慢才算（低于 5 fps 的软件渲染级别不用等）。
      // 这样页面别处一阵 2–3 秒的繁忙不会让舞台永久放弃，降档能救回来的也不会被放弃
      const atBottom = !tier.adaptive || governor.step >= tier.ladder.length - 1;
      if (fps < LOW_FPS && mid > 1000 / LOW_FPS && (atBottom || fps < 5)) { if (++S.lowSecs >= LOW_SECS) giveUp('slow', fps); } else S.lowSecs = 0;
    }
  }
  function kick() {
    if (running() && !S.raf) {
      S.lastNow = -1; S.prevRaf = -1; S.acc = 0; S.statT = 0; S.statFrames = 0; S.statGaps = [];
      governor.reset(); S.raf = requestAnimationFrame(loop);
    }
  }
  function halt() { if (S.raf) cancelAnimationFrame(S.raf); S.raf = 0; }
  function giveUp(reason, fps) {
    if (S.disposed) return;
    console.warn(`[stage] 实时画面只有 ${fps.toFixed(1)} fps，交回海报`);
    stage.dispose();
    try { renderer.forceContextLoss(); } catch { /* 无所谓 */ }
    canvas.dispatchEvent(new CustomEvent('stage:lost', { detail: { reason } }));
  }

  const onVis = () => {
    S.hidden = document.visibilityState === 'hidden';
    if (S.hidden) halt(); else kick();
  };
  document.addEventListener('visibilitychange', onVis);
  const onLost = e => {
    e.preventDefault(); S.lost = true; S.gen++; halt();
    canvas.dispatchEvent(new CustomEvent('stage:lost', { detail: { reason: 'context' } }));
  };
  // 上下文恢复：three 已换上新的 GL 状态。旧上下文里的阴影贴图、渲染目标、纸纹都不 dispose（删旧对象会刷
  // “object does not belong to this context” 警告，UX-25），只丢掉引用；着色器重新并行编译、管线重新预热，再接着画
  const onRestored = async () => {
    if (S.disposed) return;
    const gen = ++S.gen;
    key.shadow.map = null;
    comp.restore();
    resize(true);
    if (sky) sky.needsUpdate = true;                 // ImageBitmap 还在（没 close），可以重新上传
    S.warm = false;
    try { await compileAll(); await warmUp(gen); } catch (err) { console.warn('[stage] 恢复后预热出错：', err?.message || err); }
    if (gen !== S.gen || S.disposed) return;
    S.lost = false; S.warm = true; S.lastTs = NaN;
    // 时间从头来：调用方会从海报（t = 0 的姿态）再交叉淡入一次
    S.t = 0; S.liveMs = 0; S.flicks = []; S.swimOff = 0; S.flickOn = false; S.from = null; S.par = 0;
    canvas.dispatchEvent(new CustomEvent('stage:restored'));
    if (running()) kick(); else requestStill();
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  // —— 着色器：第一帧要用到的程序全部先并行编译（KHR_parallel_shader_compile），链接完再预取 uniform / attribute。
  //    这样第一帧里没有任何同步等 GPU 的调用；否则 three 在程序第一次使用时的查询会把主线程卡到 GPU 编完为止。
  const SHADOW_SIDE = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide };
  const standIns = new Map();                          // 阴影深度的替身材质（释放会连带释放共享的程序，dispose 时再放）
  async function compileAll() {
    const all = new Set(), add = set => set && set.forEach(m => all.add(m));
    // ① 两遍渲染的材质：两遍都画进渲染目标（线性输出），编译时也绑着渲染目标，编出来的才是同一个变体
    renderer.setRenderTarget(comp.targets.color);
    add(renderer.compile(scene, camera));
    // ② 阴影深度材质：照 three 的 WebGLShadowMap 选材质、定面向（正面 → 背面），临时换到网格上编
    const swaps = [];
    kun.group.traverse(o => {
      if (!o.isMesh || !o.castShadow || !o.material || Array.isArray(o.material)) return;
      const m = o.material, side = m.shadowSide ?? SHADOW_SIDE[m.side];
      let d = o.customDepthMaterial;
      if (!d) {
        d = standIns.get(side);
        if (!d) { d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }); standIns.set(side, d); }
      }
      d.side = side;
      swaps.push([o, m]); o.material = d;
    });
    try { add(renderer.compile(scene, camera)); } finally { for (const [o, m] of swaps) o.material = m; }
    // ③ 合成着色器：输出到画布（sRGB 变体）
    renderer.setRenderTarget(null);
    const proxy = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), comp.material), ps = new THREE.Scene();
    proxy.frustumCulled = false; ps.add(proxy);
    add(renderer.compile(ps, camera));
    proxy.geometry.dispose();
    // ④ 等链接完成（轮询完成状态，不阻塞），再预取。双面透明材质（鳍）three 会编正、背两个变体，都要算上
    await readyAndPrefetch(all);
  }
  function programsOf(mats) {
    const out = new Set();
    for (const m of mats) { const pr = renderer.properties.get(m); pr.programs?.forEach(p => out.add(p)); if (pr.currentProgram) out.add(pr.currentProgram); }
    return out;
  }
  async function readyAndPrefetch(mats) {
    const progs = programsOf(mats), t0 = performance.now();
    await new Promise(done => (function check() {
      let left = 0;
      for (const p of progs) if (!p.isReady()) left++;
      if (!left || performance.now() - t0 > 20000) done(); else setTimeout(check, 16);
    })());
    for (const p of progs) { p.getUniforms(); p.getAttributes(); }
  }

  // —— 先把大块数据送上 GPU（这时 GPU 还闲着）：纸纹、天空贴图、全部网格顶点（按组分帧传，每帧传一组）。
  //    放到预热里再传，会排在 GPU 编管线的队尾，主线程要等它们传完。
  const WARM = 31;
  function meshGroups() {
    const groups = new Map();
    kun.group.traverse(o => {
      if (!o.isMesh || !o.material) return;
      const m = o.material, k = (m.customProgramCacheKey ? m.customProgramCacheKey() : m.type) + (o.isInstancedMesh ? '#i' : '') + (m.transparent ? '#t' : '');
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(o);
    });
    return [...groups.values()];
  }
  async function uploadAll() {
    comp.prepare();
    if (sky) renderer.initTexture(sky);
    const rt = new THREE.WebGLRenderTarget(4, 4), mat = new THREE.MeshBasicMaterial({ colorWrite: false });
    // 上传用的极简材质也先异步编好（普通网格、实例网格两个变体）
    const pm = new THREE.Mesh(new THREE.BufferGeometry(), mat), pi = new THREE.InstancedMesh(new THREE.BufferGeometry(), mat, 1), ps = new THREE.Scene();
    ps.add(pm, pi);
    renderer.setRenderTarget(rt);
    const mats = renderer.compile(ps, camera);
    renderer.setRenderTarget(null);
    await readyAndPrefetch(mats);
    pm.geometry.dispose(); pi.geometry.dispose(); pi.dispose();
    key.layers.enable(WARM); camera.layers.set(WARM); scene.overrideMaterial = mat;
    try {
      for (const list of meshGroups()) {
        if (S.disposed) return;
        for (const o of list) o.layers.enable(WARM);
        renderer.setRenderTarget(rt); renderer.render(scene, camera); renderer.setRenderTarget(null);
        for (const o of list) o.layers.disable(WARM);
        await nextFrame();
      }
    } finally {
      scene.overrideMaterial = null; camera.layers.set(0); key.layers.disable(WARM);
      rt.dispose(); mat.dispose();
    }
  }

  resize(true);
  const tc = performance.now();
  updateCamera(0, true); poseKun(1, false, true);
  await uploadAll();
  const uploadMs = performance.now() - tc;
  await compileAll();
  const compileMs = performance.now() - tc;

  // —— 管线预热：每帧只画一组材质，让 GPU 一次只编几个渲染管线（Metal 第一次见到某个着色器 + 渲染目标组合时
  //    要现编管线，全部堆在第一帧会让整页卡住好几秒）。用第 31 层把一组网格单独挑出来；合成在空通道上预热，画面全透明。
  //    gen 变了（上下文丢了 / 又恢复了一次）就停下，交给新的那一轮。
  const warmLog = [];
  async function warmUp(gen) {
    const groups = meshGroups();
    const base = { toon: 1, lineForm: 0, ink: 1, grain: 0.12, sky: 1, haze: 1, inkT: 0, skyUV, fog: fogAt(), lineFade: [dist * 0.75, dist * 1.7] };
    const stale = () => S.disposed || gen !== S.gen;
    key.layers.enable(WARM); camera.layers.set(WARM);
    try {
      for (const list of groups) {
        for (const o of list) o.layers.enable(WARM);
        for (const only of ['color', 'normal']) {            // 彩色、法线两遍分到两帧：一帧只编一两个管线
          if (stale()) return;                               // 等帧期间可能被销毁 / 丢上下文
          const t = performance.now();
          comp.render(scene, camera, { ...base, shadow: only === 'color', only });
          warmLog.push(Math.round(performance.now() - t));
          await nextFrame();
        }
        for (const o of list) o.layers.disable(WARM);
      }
      if (stale()) return;
      const t = performance.now();
      comp.render(new THREE.Scene(), camera, { ...base, shadow: false });   // 空通道 → 合成输出全透明
      warmLog.push(Math.round(performance.now() - t));
      await nextFrame();
    } finally {
      camera.layers.set(0); key.layers.disable(WARM);
      for (const list of groups) for (const o of list) o.layers.disable(WARM);
    }
  }
  const tw = performance.now();
  let warmMs = 0;
  const gen0 = S.gen;
  warmUp(gen0).catch(err => console.warn('[stage] 预热出错：', err?.message || err)).finally(() => {
    warmMs = performance.now() - tw;
    if (gen0 !== S.gen || S.disposed) return;           // 预热期间丢过上下文：交给恢复那一轮
    S.warm = true; S.lastTs = NaN;
    if (reducedMotion) requestStill(); else kick();
  });

  let loseExt = null;
  const stage = {
    layers: LAYERS,
    setScene(name, progress = 0) {
      if (!SCENES[name]) return;
      const p = clamp01(+progress || 0);
      if (name !== S.scene) {
        S.from = S.shot ? copyShot(S.shot) : null; S.blendStart = S.t; S.scene = name;
        S.progS = p;                         // 新场景的进度直接就位，过渡交给机位混合
      }
      S.progress = p;
      if (!running()) { S.from = null; requestStill(); }
    },
    setLayer(x) { S.layer = Math.min(4, Math.max(0, +x || 0)); if (!running()) requestStill(); },
    setPointer(nx, ny) {
      S.pointer.x = Math.min(1, Math.max(-1, +nx || 0)); S.pointer.y = Math.min(1, Math.max(-1, +ny || 0));
    },
    play() { if (reducedMotion) return; S.playing = true; kick(); },
    pause() { S.playing = false; halt(); },
    resize() { resize(); },
    firstFrame,
    dispose() {
      if (S.disposed) return;
      S.disposed = true; halt(); ro.disconnect(); clearTimeout(resizeTimer); clearTimeout(firstTimer);
      document.removeEventListener('visibilitychange', onVis);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      if (!S.lost) {                                    // 上下文丢着的时候不删 GL 对象（删的是旧上下文的，只会刷警告）
        comp.dispose();
        kun.group.traverse(o => {
          if (o.geometry) o.geometry.dispose();
          const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
          for (const m of ms) m.dispose();
          o.customDepthMaterial?.dispose();
        });
        key.shadow.map?.dispose();
        standIns.forEach(d => d.dispose());
        sky?.dispose();
      }
      sky?.image?.close?.();
      renderer.dispose();
      resolveFirst({ ms: 0, disposed: true });
    },
    // 开发测试页用（site/dev/stage/）：定格到某一时刻渲染、读构建数据
    debug: {
      renderAt(t, { pointer } = {}) {
        S.t = t; S.lastTs = NaN; S.liveMs = HOLD_MS + WAKE_MS;
        if (pointer) { S.pointer.x = S.pointerS.x = pointer[0]; S.pointer.y = S.pointerS.y = pointer[1]; }
        S.progS = S.progress; S.from = null;
        S.par = POINTER_SCENES.has(S.scene) ? 1 : 0;
        const t0 = performance.now(); draw(0, true); gl.finish(); return performance.now() - t0;
      },
      setPixelRatio(pr) { S.pr = pr; resize(true); },
      tune(o) { S.tune = o || null; },               // 调机位用：临时覆盖当前场景的机位参数
      // “时”这一步：boost 固定放大量（null = 按场景 / 层 / 进度自动），flicks 指定摆尾开始时刻（动画时间，秒）
      timeFx({ boost = null, flicks = null } = {}) {
        S.forceBoost = boost;
        if (flicks) { S.flicks = flicks.slice(); S.swimOff = 0; S.flickOn = !!flicks.length; S.nextFlick = Infinity; }
      },
      // 模拟上下文丢失 / 恢复（丢失期间 getExtension 返回 null，所以扩展对象要先存下来）
      loseContext() { loseExt = loseExt || gl.getExtension('WEBGL_lose_context'); loseExt?.loseContext(); },
      restoreContext() { loseExt?.restoreContext(); },
      get info() {
        return { buildMs, probeMs, estMs, deferMs, uploadMs, compileMs, warmMs, warmSteps: warmLog.slice(), firstFrameMs, triangles, lod: tier.lod, tier: tier.name, shadow: tier.shadow, msaa: tier.msaa,
          pr: S.pr, prCap: tier.prCap, ladder: tier.ladder, step: governor.step, ema: governor.ema, drawEma: governor.drawEma, prLog: governor.log, gpu, drawingBuffer: comp.size, calls: S.calls,
          scene: S.scene, layer: S.layer, t: S.t, liveMs: S.liveMs, boost: S.boost, flicks: S.flicks.slice(), frames: S.frames, outlineMeshes: kun.outlineMeshes.length };
      },
      renderer, camera, scene, kun, palette: PALETTE,
    },
  };
  return stage;
}
