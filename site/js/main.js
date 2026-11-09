// 北冥作品站 · 页面编排（shell）
//
// 负责：开场（天空从地平线晕开 → 毛笔按笔顺写“北冥” → 文字上浮）、动态载入舞台并调 Stage API（契约第 2 节）、
//       海报到实时画面的交叉淡入与实时读数（可暂停）、首屏原地放映样片、引擎拆层的固定滚动叙事（视口太矮或太横时退回静态版）、
//       主题与导航、作品区初始化（契约第 4 节）、减少动态与无 WebGL 的降级（DESIGN 第 5 节）。
// 舞台 ./stage.js 与作品区 ./works.js 由别的角色实现：都用动态 import + try/catch，缺失或失败时页面照样完整
// （海报 + 静帧 + 无脚本也能看的作品标记）。GSAP 用 UMD 全局（vendor/gsap/*.min.js，defer 先于本模块执行）。

const html = document.documentElement;
const RM = html.classList.contains('rm') || matchMedia('(prefers-reduced-motion: reduce)').matches;
const { gsap, ScrollTrigger, Flip } = window;
const HAS_GSAP = !!(gsap && ScrollTrigger);
const MOTION = !RM && HAS_GSAP;
if (HAS_GSAP) {
  gsap.registerPlugin(...[ScrollTrigger, Flip].filter(Boolean));
  ScrollTrigger.config({ ignoreMobileResize: true });
}

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = t => { t = clamp(t); return t * t * (3 - 2 * t); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const warn = (msg, e) => console.warn(`[北冥] ${msg}`, e ?? '');

// ───────────────────────── 拆层叙事的时间表（固定滚动进度 q：0..1） ─────────────────────────
// 固定滚动的长度：桌面 5 屏，触屏 4.5 屏（触控板、手指甩几下就能走完；投资人只给半分钟到两分钟）
const pinScreens = () => (matchMedia('(pointer: coarse)').matches ? 4.5 : 5);
// 能走固定滚动的视口：够高，并且是横着的宽屏（左文右鲲）或竖屏（上鲲下文，与舞台 rig.js 的竖构图判断一致）。
// 手机横屏、放大 200% 这类又矮又横的视口走静态版（五张静帧在文档流里依次排开，不会被裁）。
// 另外每一步的文字都要在固定版的面板里装得下（pinnedFits），装不下也走静态版；视口变化时自动切换
const PIN_QUERY = '(min-height: 600px) and (min-width: 900px), (min-height: 600px) and (max-aspect-ratio: 1/1)';
const STEPS = ['intro', 'form', 'shade', 'look', 'stage', 'time', 'rest'];
// 每一步文字出现的位置：相邻两层交叉过渡的正中再提前 0.012（新字要等旧字淡出才进来），文字与着色器里的层同时到位
const STEP_AT = [0, 0.058, 0.248, 0.408, 0.568, 0.728, 0.878];
// 画面层（Stage.setLayer，0 形 / 1 光 / 2 笔 / 3 景 / 4 时）的关键点：先从 4 快速退回 0，再一层层画回去，
// 相邻两层之间留 0.05 的交叉过渡（着色器按小数混合）
const LAYER_KEYS = [[0, 4], [0.035, 4], [0.105, 0], [0.235, 0], [0.285, 1], [0.395, 1], [0.445, 2],
  [0.555, 2], [0.605, 3], [0.715, 3], [0.765, 4], [1, 4]];
// 九字轨按引擎原序（形 光 景 笔 人 界 时 声 片）：每一步点亮哪些（lit）、哪些是当前（on）
const ALL9 = ['form', 'shade', 'stage', 'look', 'paint', 'overlay', 'time', 'audio', 'render'];
const RAIL = {
  intro: [[], []],
  form: [['form'], ['form']],
  shade: [['form', 'shade'], ['shade']],
  look: [['form', 'shade', 'look'], ['look']],
  stage: [['form', 'shade', 'look', 'stage'], ['stage']],
  time: [['form', 'shade', 'look', 'stage', 'time'], ['time']],
  rest: [ALL9, ['paint', 'overlay', 'audio', 'render']],
};
function layerAt(q) {
  for (let i = 1; i < LAYER_KEYS.length; i++) {
    const [q1, v1] = LAYER_KEYS[i];
    if (q <= q1) {
      const [q0, v0] = LAYER_KEYS[i - 1];
      return v0 + (v1 - v0) * smooth((q - q0) / (q1 - q0 || 1));
    }
  }
  return 4;
}
const stepAt = q => { let i = 0; while (i + 1 < STEP_AT.length && q >= STEP_AT[i + 1]) i++; return i; };

// ───────────────────────── 开场的时间 ─────────────────────────
const INTRO_TEXT_AT = 1640;     // 开场时间线里首屏文字全部不透明的时刻（毫秒；见 intro() 的时间表）
const INTRO_DEADLINE = 2200;    // 首屏文字最晚在这之前出齐（门禁 S7 是 2.5 秒，留出余量）
const BRUSH_WAIT = 160;         // 来得早时，开演前最多等毛笔字形预计算这么久：算完再晕开天空，晕开时不卡

// ───────────────────────── 状态 ─────────────────────────
const S = {
  stage: null, live: false, playing: undefined,
  scene: 'hero', heroP: 0, engineQ: 0, layer: 4, step: 0,
  inRange: true, filmOpen: false, works: null,
  userPaused: false, greeted: false,
  geo: { heroH: 1, heroCopyTop: 1e9, engineTop: 1e9, engineBottom: 1e9, worksTop: 1e9, methodTop: 1e9 },
};
const el = {
  stage: $('#stage'), canvas: $('#stage-canvas'), poster: $('.stage-poster'),
  nav: $('#nav'), hero: $('#hero'), heroCopy: $('.hero-copy'), engine: $('#engine'), pin: $('#engine-pin'),
  works: $('#works'), method: $('#method'), dusk: $('.engine-dusk'),
  live: $('#hero-live'), liveState: $('#live-state'), toggle: $('#live-toggle'), glyphs: $('.hero-glyphs'),
};
const themeMeta = $('meta[name="theme-color"]');
let pinST = null;
let filmShut = null;
let resolveTitle;
const titleDone = new Promise(r => { resolveTitle = r; });

function boot() {
  clearTimeout(window.__bmIntro);
  // 毛笔模块与开场并行（已在 <head> 里 modulepreload）
  const brushP = loadBrush().catch(e => { warn('毛笔标题模块没有载入，保留文字', e); return null; });
  safely('导航', setupNav);
  safely('样片放映', setupFilm);
  safely('锚点', setupAnchors);
  safely('实时画面开关', setupLiveToggle);
  if (MOTION) safely('拆层滚动', setupEngine);
  safely('开场', () => intro(brushP).catch(e => { warn('开场出错，直接成稿', e); introSkip(brushP); }));
  measure();
  onScroll();
  window.addEventListener('scroll', requestScrollUpdate, { passive: true });
  window.addEventListener('resize', onResize, { passive: true });
  document.addEventListener('visibilitychange', updatePlay);
  if (HAS_GSAP) ScrollTrigger.addEventListener('refresh', () => { measure(); onScroll(); queueEngineMode(); });
  document.fonts?.ready.then(() => { if (HAS_GSAP) ScrollTrigger.refresh(); else measure(); });
  bootWorks();
  bootStage();
}

function safely(name, fn) {
  try { return fn(); } catch (e) { warn(`${name}初始化失败，退回静态版`, e); }
}

// ───────────────────────── 开场 ─────────────────────────
async function loadBrush() {
  if (!el.glyphs) return null;
  const { createBrushTitle } = await import('./brush-title.js');
  return createBrushTitle(el.glyphs, { reducedMotion: RM });
}

// 不演开场，直接成稿（减少动态、没有 GSAP、保底计时器已经撤掉初始态、或者来得太晚）
function introSkip(brushP) {
  html.classList.remove('intro', 'blooming');
  el.stage?.style.removeProperty('--bloom');
  brushP.then(brush => (brush ? brush.ready.then(ok => ok && brush.finish()) : null)).finally(resolveTitle);
}

async function intro(brushP) {
  if (!MOTION || !html.classList.contains('intro')) return introSkip(brushP);
  // 来得早：先让毛笔字形算完再开演（最多等 BRUSH_WAIT 毫秒），天空晕开时主线程是空的
  if (performance.now() < INTRO_DEADLINE - INTRO_TEXT_AT - BRUSH_WAIT) {
    await Promise.race([brushP.then(b => b?.ready), wait(BRUSH_WAIT)]);
  }
  // 来得晚（网速慢，main.js 晚到）：按剩下的时间压缩整段开场，首屏文字仍在 INTRO_DEADLINE 前出齐；压缩超过 3 倍就不演了
  const pace = Math.max(1, INTRO_TEXT_AT / Math.max(1, INTRO_DEADLINE - performance.now()));
  if (pace > 3 || !html.classList.contains('intro')) return introSkip(brushP);

  const copy = $$('.hero-copy > :not(.hero-title)');
  const [eyebrow, ...rest] = copy;
  // 交接：先用行内样式定住初始态，再撤掉 intro 类，不闪
  gsap.set(rest, { autoAlpha: 0, y: 16 });
  gsap.set(eyebrow, { autoAlpha: 0, y: 8 });
  gsap.set(el.nav, { autoAlpha: 0 });
  gsap.set(el.glyphs, { opacity: 0 });
  el.stage.style.setProperty('--bloom', '0');
  html.classList.add('blooming');
  html.classList.remove('intro');

  const tl = gsap.timeline({ defaults: { ease: 'expo.out' } });
  tl.timeScale(pace);
  // 0–0.55s：纸色底上，天空从地平线往上晕开（地平线那团暖光等天空晕开后再淡入，见 sections.css）
  tl.to(el.stage, { '--bloom': 1, duration: 0.55, ease: 'power2.out', onComplete: () => {
    html.classList.remove('blooming'); el.stage.style.removeProperty('--bloom');
  } }, 0);
  tl.to(el.nav, { autoAlpha: 1, duration: 0.8, ease: 'power2.out', clearProps: 'opacity,visibility' }, 0.25);
  tl.to(eyebrow, { autoAlpha: 1, y: 0, duration: 0.8, clearProps: 'opacity,visibility,transform' }, 0.2);
  // 0.3–1.5s：毛笔按笔顺写出“北冥”（字形没备好就等，最迟到 1.4 秒；再晚就直接显示文字，不再写）
  tl.add(() => {
    let settled = false;
    const showText = () => { gsap.to(el.glyphs, { opacity: 1, duration: 0.7 / pace, ease: 'power2.out' }); resolveTitle(); };
    const giveUp = setTimeout(() => {
      if (settled) return;
      settled = true; brushP.then(b => b?.destroy()); showText();
    }, 1100 / pace);
    brushP.then(brush => (brush ? brush.ready.then(ok => [brush, ok]) : [null, false])).then(([brush, ok]) => {
      if (settled) return;
      settled = true; clearTimeout(giveUp);
      if (!ok) { brush?.destroy(); showText(); return; }
      gsap.set(el.glyphs, { opacity: 1 });             // DOM 字由 .is-brushed 设成透明，留着给选中与读屏
      brush.play(1.2 / pace).then(resolveTitle);
    });
  }, 0.3);
  // 1.0s 起：主句、读数、副句、按钮依次上浮（expo.out 前段就走完：最后一个约在 1.64 秒全不透明，即 INTRO_TEXT_AT）
  tl.to(rest, { autoAlpha: 1, y: 0, duration: 0.6, stagger: 0.08, clearProps: 'opacity,visibility,transform' }, 1.0);
}

// ───────────────────────── 舞台（实时引擎） ─────────────────────────
const LIVE_TEXT = {
  poster: '引擎渲染的静帧',
  loading: '实时画面准备中',
  reduced: '引擎渲染的静帧（已按系统设置减少动态）',
  nowebgl: '引擎渲染的静帧（这台设备不支持实时画面）',
  saveData: '引擎渲染的静帧（省流量模式）',
  slow: '引擎渲染的静帧（这台设备跑实时画面太吃力，已停下）',
  paused: '已暂停 · 引擎渲染的静帧',
};
let fpsNode = null, triNode = null, lastStats = null;

function setLiveState(state) {
  if (state !== 'live' && state !== 'loading') useStills();      // 没有实时画面：拆层改用五张静帧
  if (!el.live) return;
  el.live.dataset.state = state;
  if (state !== 'live') { fpsNode = triNode = null; if (el.liveState) el.liveState.textContent = LIVE_TEXT[state] ?? LIVE_TEXT.poster; }
  renderLive();
}
// 读数与暂停按钮：只有实时画面在跑时才有按钮；暂停时读数写明“已暂停”，点不再脉冲
function renderLive() {
  if (!el.live || !el.liveState) return;
  const live = el.live.dataset.state === 'live';
  const paused = live && S.userPaused;
  if (el.toggle) {
    el.toggle.hidden = !live;
    const label = $('.live-toggle-label', el.toggle);
    if (label) label.textContent = paused ? '继续' : '暂停';
  }
  el.live.classList.toggle('is-paused', paused);
  if (!live) return;
  if (paused) { fpsNode = triNode = null; el.liveState.textContent = LIVE_TEXT.paused; return; }
  if (!fpsNode) {
    if (!lastStats) { el.liveState.textContent = '实时渲染中'; return; }   // 刚继续、帧率还没到手：先不写空着的数字
    el.liveState.textContent = '';
    fpsNode = document.createElement('span'); fpsNode.className = 'num';
    triNode = document.createElement('span'); triNode.className = 'num';
    el.liveState.append('实时渲染中 · ', fpsNode, ' fps · ', triNode, ' 三角形');
    paintStats(lastStats);
  }
}
// 实时读数：画面接管、且第一份帧率到手之后才换成“实时渲染中”（不显示空着的数字）；
// 访客之前按过暂停（刷新后从 sessionStorage 读回）时，画面一接管就换成“已暂停”，并露出“继续”
function showLiveStats() {
  if (!S.live || !el.live || el.live.dataset.state === 'live') return;
  if (!lastStats && !S.userPaused) return;
  setLiveState('live');
}
function onStats(s) {
  if (!s) return;
  lastStats = s;
  if (el.live?.dataset.state !== 'live') { showLiveStats(); return; }
  if (fpsNode) paintStats(s); else if (!S.userPaused) renderLive();
}
function paintStats(s) {
  if (Number.isFinite(s.fps)) fpsNode.textContent = String(Math.round(s.fps));
  if (Number.isFinite(s.triangles)) triNode.textContent = Math.round(s.triangles).toLocaleString('en-US');
}

// 暂停 / 继续实时画面（WCAG 2.2.2）：状态记在 sessionStorage，同一个标签页里刷新也保持
const PAUSE_KEY = 'beiming:live-paused';
function setupLiveToggle() {
  if (!el.toggle) return;
  try { S.userPaused = sessionStorage.getItem(PAUSE_KEY) === '1'; } catch { /* 隐私模式等：不记 */ }
  el.toggle.addEventListener('click', () => {
    S.userPaused = !S.userPaused;
    try { if (S.userPaused) sessionStorage.setItem(PAUSE_KEY, '1'); else sessionStorage.removeItem(PAUSE_KEY); } catch { /* 不记也行 */ }
    renderLive();
    updatePlay();
  });
}

// 舞台的运行时变量写在 #stage 上（只有它的子树要重算样式）；值没变就不写
const stageVars = {};
function setStageVar(name, v) {
  const s = v.toFixed(3);
  if (stageVars[name] === s || !el.stage) return;
  stageVars[name] = s;
  el.stage.style.setProperty(name, s);
}

// 放出拆层静帧（CSS 里动态模式默认不显示、也不下载）
function useStills() { html.classList.add('use-stills'); }

async function bootStage() {
  if (RM) return setLiveState('reduced');
  if (!MOTION || !el.canvas) return useStills();
  if (navigator.connection?.saveData) return setLiveState('saveData');
  setLiveState('loading');
  // 先让海报与开场占住带宽和主线程：海报到了（最多等 1.2 秒）再去取 three.js 与舞台
  await Promise.race([imageReady(el.poster), wait(1200)]);
  let mod;
  try { mod = await import('./stage.js'); } catch (e) { warn('舞台脚本没有载入，保持海报', e); return setLiveState('poster'); }
  if (typeof mod?.createStage !== 'function') { warn('stage.js 没有导出 createStage，保持海报'); return setLiveState('poster'); }
  // 构建鲲会占主线程：等“北冥”写完再建（最多等 2.6 秒），期间海报一直在
  await Promise.race([titleDone, wait(2600)]);
  let stage = null;
  try {
    stage = await mod.createStage(el.canvas, { reducedMotion: false, quality: 'auto', onStats });
  } catch (e) { warn('舞台初始化失败，保持海报', e); }
  if (!stage) { html.classList.add('no-stage'); return setLiveState('nowebgl'); }
  S.stage = stage;
  applyStage();
  updatePlay();
  bindPointer();
  try { await stage.firstFrame; } catch (e) {
    warn('第一帧没有画出，保持海报', e);
    try { stage.dispose(); } catch { /* 已经坏了 */ }
    S.stage = null;
    return setLiveState('poster');
  }
  // 舞台在画布上派发 stage:lost：WebGL 上下文丢失（reason 'context'，之后可能恢复），或这台设备降到最低档仍太慢、
  // 舞台已自行销毁（reason 'slow'，不会再恢复）。两种都把海报接回来；恢复后再淡入实时画面
  el.canvas.addEventListener('stage:lost', e => {
    const slow = e.detail?.reason === 'slow';
    S.live = false;
    gsap.killTweensOf(el.stage, '--live');
    html.classList.remove('is-live');
    setStageVar('--live', 0);
    if (slow) { S.stage = null; S.playing = undefined; html.classList.remove('stage-paused'); }
    setLiveState(slow ? 'slow' : 'poster');
  });
  el.canvas.addEventListener('stage:restored', () => { if (!S.live) goLive(); });
  goLive();
}

function goLive() {
  S.live = true;
  const plates = eng ? eng.plates.filter(Boolean) : [];
  // 海报 → 实时画面：两者构图逐像素一致，交叉淡入看不出跳变；淡完之后鲲“醒过来”（greet）
  gsap.to(el.stage, { '--live': 1, duration: 0.9, ease: 'power2.inOut', overwrite: 'auto', onComplete: () => {
    stageVars['--live'] = '1.000';
    html.classList.add('is-live');
    if (plates.length) gsap.set(plates, { clearProps: 'opacity' });
    greet();
  } });
  if (pinST && plates.length) gsap.to(plates, { opacity: 0, duration: 0.6, overwrite: 'auto' });
  showLiveStats();
  updatePlay();
}

// 实时画面接上之后的一下“活过来”：鲲的目光先被引向右上，再转回来看着访客；镜头跟着有一点真实的视差
// （背上的仙山与鱼身错开），这是海报做不到的。读数的点同时跳一下。桌面上做完再交还给真实鼠标，手机同样执行
let pointerHold = false, realPointer = null;
function greet() {
  if (S.greeted || !S.stage || S.scene !== 'hero' || S.userPaused || document.hidden) return;
  S.greeted = true;
  pointerHold = true;
  const p = { x: 0, y: 0 };
  const push = () => { try { S.stage?.setPointer(p.x, p.y); } catch { /* 舞台不支持就算了 */ } };
  if (el.live) {
    el.live.classList.add('is-blip');
    setTimeout(() => el.live.classList.remove('is-blip'), 1000);
  }
  gsap.timeline({
    onUpdate: push,
    onComplete: () => {
      pointerHold = false;
      if (realPointer) { try { S.stage?.setPointer(realPointer[0], realPointer[1]); } catch { /* 同上 */ } }
    },
  })
    .to(p, { x: 0.62, y: 0.32, duration: 0.6, ease: 'power2.inOut' })
    .to(p, { x: 0, y: 0, duration: 1.2, ease: 'expo.out' }, '+=0.1');
}

function applyStage() {
  const st = S.stage;
  if (!st) return;
  try {
    if (S.scene === 'layers') { st.setScene('layers', S.engineQ); st.setLayer(S.layer); }
    else if (S.scene === 'hero') { st.setScene('hero', S.heroP); st.setLayer(4); }
    else st.setScene('idle', 0);
  } catch (e) { warn('Stage 调用出错', e); }
}

function updatePlay() {
  const st = S.stage;
  if (!st) return;
  const userHold = S.userPaused && S.live;              // 访客按了暂停（实时画面接上之后才生效：第一帧要先画出来）
  const filmHold = S.filmOpen && S.scene === 'hero';    // 首屏放映样片时把 GPU 让给视频；滚离首屏就不再算
  const want = !document.hidden && S.inRange && !userHold && !filmHold;
  html.classList.toggle('stage-paused', !want);
  if (want === S.playing) return;
  S.playing = want;
  try { want ? st.play() : st.pause(); } catch (e) { warn('Stage 播放开关出错', e); }
}

function bindPointer() {
  if (!matchMedia('(pointer: fine)').matches) return;
  let nx = 0, ny = 0, queued = false;
  const push = () => { queued = false; if (pointerHold) return; try { S.stage?.setPointer(nx, ny); } catch { /* 舞台不支持就算了 */ } };
  window.addEventListener('pointermove', e => {
    nx = clamp(e.clientX / innerWidth * 2 - 1, -1, 1);
    ny = clamp(1 - e.clientY / innerHeight * 2, -1, 1);             // 向上为正（与 three.js 的相机上方向一致）
    realPointer = [nx, ny];
    if (!queued) { queued = true; requestAnimationFrame(push); }
  }, { passive: true });
  html.addEventListener('pointerleave', () => {
    nx = 0; ny = 0; realPointer = [0, 0];
    if (!queued) { queued = true; requestAnimationFrame(push); }
  });
}

function imageReady(img) {
  if (!img) return Promise.resolve();
  if (img.complete) return Promise.resolve();
  return new Promise(r => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); });
}

// ───────────────────────── 引擎拆层：固定滚动叙事（装不下就用静态版） ─────────────────────────
let eng = null;               // 拆层的节点，setupEngine 收集一次
let engineTween = null;
let pinMQ = null;

function setupEngine() {
  if (!el.pin) return;
  const steps = STEPS.map(k => $(`.step[data-step="${k}"]`, el.pin));
  if (steps.some(s => !s)) throw new Error('拆层标记不完整');
  eng = {
    steps,
    texts: steps.map(s => $('.step-text', s)),
    plates: [0, 1, 2, 3, 4].map(i => $(`.step-layer[data-layer="${i}"] .step-plate`, el.pin)),
    rail: $$('.rail li', el.pin),
    mark: $('.engine-lede em', el.pin),
  };
  pinMQ = matchMedia(PIN_QUERY);
  if (pinMQ.addEventListener) pinMQ.addEventListener('change', queueEngineMode); else pinMQ.addListener?.(queueEngineMode);
  syncEngineMode();
}

// 固定版的文字面板是绝对定位的：哪一步装不下，多出来的部分就永远滚不到。临时套上固定版的版式量一遍
// （量的时候关掉过渡，量完先回到原样式再恢复过渡，免得触发一闪），每一步都装得下才走固定滚动
function pinnedFits() {
  const E = el.engine, had = E.classList.contains('is-pinned');
  E.classList.add('is-measuring');
  if (!had) E.classList.add('is-pinned');
  let ok = true;
  try {
    for (const t of eng.texts) {
      const box = t.getBoundingClientRect();
      let top = Infinity, bottom = -Infinity;
      for (const c of t.children) {
        const r = c.getBoundingClientRect();
        if (!r.height) continue;
        top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom);
      }
      if (top < box.top - 1 || bottom > box.bottom + 1) { ok = false; break; }
    }
  } finally {
    if (!had) E.classList.remove('is-pinned');
    void E.offsetWidth;
    E.classList.remove('is-measuring');
  }
  return ok;
}

// 按视口决定固定版还是静态版；变了返回 true（调用方要 ScrollTrigger.refresh）
function syncEngineMode() {
  if (!eng) return false;
  const want = !!pinMQ?.matches && pinnedFits();
  if (want === !!engineTween) { if (!want) useStills(); return false; }
  try { if (want) buildPin(); else dropPin(); } catch (e) {
    warn('固定滚动建不起来，退回静态版', e);
    try { dropPin(); } catch { /* 已经是静态版 */ }
  }
  return true;
}

let modeQueued = false;
function queueEngineMode() {
  if (modeQueued || !eng) return;
  modeQueued = true;
  requestAnimationFrame(() => {
    modeQueued = false;
    if (syncEngineMode() && HAS_GSAP) ScrollTrigger.refresh();
  });
}

function buildPin() {
  const { steps, texts } = eng;
  el.engine.classList.add('is-pinned');
  gsap.set(texts, { opacity: 0, y: 0 });
  gsap.set(texts[0], { opacity: 1 });
  steps.forEach((s, k) => s.classList.toggle('is-current', k === 0));
  S.step = 0;
  setRail('intro');
  const proxy = { q: 0 };
  engineTween = gsap.to(proxy, {
    q: 1,
    ease: 'none',
    onUpdate: () => renderEngine(proxy.q),
    scrollTrigger: {
      id: 'engine-pin',
      trigger: el.pin,
      start: 'top top',
      end: () => `+=${Math.round(innerHeight * pinScreens())}`,
      pin: true,
      scrub: 0.6,                       // 画面与文字跟手但不生硬：滚动停下后 0.6 秒追平
      anticipatePin: 1,
      invalidateOnRefresh: true,
    },
  });
  pinST = engineTween.scrollTrigger;
  renderEngine(0);
}

// 退回静态版：撤掉固定（pin-spacer 一并拿掉）、清掉行内样式，五张静帧放出来
function dropPin() {
  const { steps, texts, plates, rail, mark } = eng;
  if (engineTween) {
    try { engineTween.scrollTrigger?.kill(); } catch { /* 已经没了 */ }
    engineTween.kill();
  }
  engineTween = null; pinST = null;
  gsap.killTweensOf(texts);
  gsap.set(texts, { clearProps: 'opacity,transform' });
  steps.forEach(s => s.classList.remove('is-current'));
  plates.forEach(p => { if (p) p.style.opacity = ''; });
  mark?.style.removeProperty('--mark');
  rail.forEach(li => li.classList.remove('is-lit', 'is-on'));
  el.engine.classList.remove('is-pinned');
  S.layer = 4; S.step = 0; S.engineQ = 0;
  useStills();
  applyStage();
}

function renderEngine(q) {
  S.engineQ = q;
  S.layer = layerAt(q);
  const i = stepAt(q);
  if (i !== S.step) setStep(i);
  // “拆开这条鲲”的窗灯底线：随鲲退回素模一起划过去
  if (eng.mark) eng.mark.style.setProperty('--mark', `${Math.round(clamp((4 - S.layer) / 4) * 100)}%`);
  // 舞台没就绪：五张静帧按层交叉淡入淡出（和着色器里的层过渡同一条曲线）
  if (!S.live) eng.plates.forEach((p, k) => { if (p) p.style.opacity = clamp(1 - Math.abs(S.layer - k)).toFixed(3); });
  applyStage();
  updateShade();
  updateNavTheme(window.scrollY);       // 只换配色；收起 / 出现只看真实滚动（onScroll），不然这里会把滚动方向吃掉
}

function setStep(i) {
  const prev = S.step;
  S.step = i;
  const dir = i > prev ? 1 : -1;
  const texts = eng.texts;
  eng.steps.forEach((s, k) => s.classList.toggle('is-current', k === i));
  // 先出后进，不叠印：旧字 0.18 秒快速淡出（power2.out 一开始就掉得快），新字等它走完再进来。
  // overwrite: true：快速滚过几步时，还在延迟里没开始的淡入也一并取消
  texts.forEach((t, k) => {
    if (k === i) return;
    if (k === prev) gsap.to(t, { opacity: 0, y: -14 * dir, duration: 0.18, ease: 'power2.out', overwrite: true });
    else if (gsap.getProperty(t, 'opacity') > 0 || gsap.isTweening(t)) gsap.to(t, { opacity: 0, duration: 0.12, overwrite: true });
  });
  gsap.fromTo(texts[i], { opacity: 0, y: 18 * dir }, { opacity: 1, y: 0, duration: 0.6, ease: 'expo.out', delay: 0.18, overwrite: true });
  setRail(STEPS[i]);
}

function setRail(key) {
  const [lit, on] = RAIL[key] || RAIL.intro;
  eng.rail.forEach(li => {
    li.classList.toggle('is-lit', lit.includes(li.dataset.key));
    li.classList.toggle('is-on', on.includes(li.dataset.key));
  });
}

// ───────────────────────── 滚动：场景、黄昏淡出、舞台开关、导航 ─────────────────────────
function measure() {
  const top = n => (n ? n.getBoundingClientRect().top + window.scrollY : 1e9);
  S.geo.heroH = el.hero?.offsetHeight || innerHeight;
  S.geo.heroCopyTop = el.heroCopy ? top(el.heroCopy) : S.geo.heroH * 0.5;
  S.geo.engineTop = top(el.engine);
  S.geo.engineBottom = el.engine ? S.geo.engineTop + el.engine.offsetHeight : 1e9;
  S.geo.worksTop = top(el.works);
  S.geo.methodTop = top(el.method);
  S.geo.duskH = el.dusk?.offsetHeight || 0;
  S.geo.navH = el.nav?.offsetHeight || 56;
}

let scrollQueued = false;
function requestScrollUpdate() {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => { scrollQueued = false; onScroll(); });
}

let dusk = 1;
function onScroll() {
  const y = window.scrollY, vh = innerHeight, g = S.geo;
  S.heroP = clamp(y / Math.max(1, g.heroH));
  if (pinST) {
    // 固定版：引擎篇章的上沿过了视口 55% 就把镜头交给“拆层”（舞台在参数空间里平滑过渡）
    S.inRange = y < pinST.end + vh;
    S.scene = !S.inRange ? 'idle' : (y >= g.engineTop - vh * 0.55 ? 'layers' : 'hero');
  } else {
    // 静态版：引擎篇章是不透明的纸面，首屏一滚走，舞台就被盖住了
    S.inRange = y < g.engineTop;
    S.scene = S.inRange ? 'hero' : 'idle';
  }
  // 黄昏天空与海报：引擎篇章从视口底部升到 20% 高度时淡成纸色
  dusk = 1 - clamp((y - (g.engineTop - vh)) / (vh * 0.8));
  if (!S.live && y > g.engineTop - vh * 0.6) useStills();          // 引擎篇章升进视口过半，实时画面还没接上：先用静帧
  setStageVar('--dusk', dusk);
  updateShade();
  // 开着样片往下滚走了：收起（焦点在片子里才把它送回按钮），舞台恢复
  if (S.filmOpen && S.heroP > 0.6) filmShut?.({ restoreFocus: false });
  applyStage();
  updatePlay();
  updateNav(y);
}

// 画面顶部那层压导航浅色字的夜色：首屏跟着黄昏走；拆层里天空在画布里铺满时也要
function updateShade() {
  const sky = S.scene === 'layers' && S.live ? clamp(S.layer - 2) : 0;
  setStageVar('--navshade', Math.max(dusk, sky));
}

let resizeTimer = 0;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!HAS_GSAP) { measure(); onScroll(); }
    try { S.stage?.resize(); } catch { /* 舞台自己会处理 */ }
  }, 150);
}

// ───────────────────────── 导航：随篇章换色、往下滚收起 ─────────────────────────
const THEME_COLOR = { sky: '#4F5BBF', dusk: '#17183A', sheet: '#F3EAD9', 'sheet-sky': '#4F5BBF', paper: '#F3EAD9', night: '#17183A' };
let navTheme = 'sky', navSky = false, lastY = 0, navLinks = {};

function setupNav() {
  if (!el.nav) return;
  for (const a of $$('.nav-links a[href^="#"]', el.nav)) navLinks[a.getAttribute('href').slice(1)] = a;
}

function updateNav(y) {
  if (!el.nav) return;
  updateNavTheme(y);
  const g = S.geo, probe = y + (g.navH || 56) / 2;
  const cur = probe >= g.methodTop ? 'method' : probe >= g.worksTop ? 'works' : probe >= g.engineTop ? 'engine' : null;
  for (const [id, a] of Object.entries(navLinks)) {
    if (id === cur) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
  }
  // 往下滚收起、往上滚出现（减少动态时一直显示）
  if (!RM) {
    const dy = y - lastY;
    if (y < g.heroH * 0.25 || dy < -6) el.nav.classList.remove('is-tucked');
    else if (dy > 6) el.nav.classList.add('is-tucked');
  }
  lastY = y;
}

function updateNavTheme(y) {
  if (!el.nav) return;
  const g = S.geo, navH = g.navH || 56, probe = y + navH / 2;
  let theme;
  // 首屏：页顶透明；导航一压到首屏文字（往回滚到首屏中段时最常见）就换夜色实底，不和文字叠在一起
  if (probe < g.engineTop) theme = y > g.heroCopyTop - navH - 8 ? 'dusk' : 'sky';
  // 固定拆层：纸页就是左边的底，导航不铺底色（固定期间文字面板在导航下方，不会叠字）；
  // 固定一结束，纸页连同文字往上滚走，从这里起换夜色实底，接着入夜
  else if (pinST) theme = y <= pinST.end + 2 ? 'sheet' : 'night';
  else theme = probe < g.worksTop - g.duskH * 0.5 ? 'paper' : 'night';
  const sky = theme === 'sheet' && S.live && S.layer >= 2.5;    // 天空铺满：右边的链接换成近白字
  if (theme !== navTheme || sky !== navSky) {
    navTheme = theme; navSky = sky;
    el.nav.dataset.nav = theme;
    el.nav.toggleAttribute('data-sky', sky);
    themeMeta?.setAttribute('content', THEME_COLOR[sky ? 'sheet-sky' : theme]);
  }
}

// ───────────────────────── 首屏原地放映《北冥》样片（不是模态框） ─────────────────────────
function setupFilm() {
  const btn = $('#film-open'), fig = $('#hero-film'), video = $('#film-video'), close = $('#film-close');
  if (!btn || !fig || !video) return;
  const SRC = video.getAttribute('src');
  let resumeAt = 0;
  btn.setAttribute('role', 'button');
  btn.setAttribute('aria-controls', 'hero-film');
  btn.setAttribute('aria-expanded', 'false');

  // 收起后不再下载剩下的部分（样片约 11.6 MB）：还没下完就记下播放位置、撤掉 src，浏览器随即断开连接
  const stopDownload = () => {
    const b = video.buffered, end = b.length ? b.end(b.length - 1) : 0;
    if (!video.getAttribute('src') || (video.duration && end >= video.duration - 0.25)) return;
    resumeAt = video.currentTime || 0;
    video.removeAttribute('src');
    try { video.load(); } catch { /* 没关系 */ }
  };

  const open = () => {
    if (S.filmOpen) return;
    S.filmOpen = true;
    fig.hidden = false;
    html.classList.add('film-open');
    btn.setAttribute('aria-expanded', 'true');
    if (!video.getAttribute('src') && SRC) {          // 上次收起时停了下载：接回来，从停下的地方接着放
      video.setAttribute('src', SRC);
      const at = resumeAt;
      if (at > 0) video.addEventListener('loadedmetadata', () => { try { video.currentTime = at; } catch { /* 从头放也行 */ } }, { once: true });
    }
    video.preload = 'auto';
    video.play()?.catch(() => { /* 浏览器拦了自动播放：控件还在，用户自己点 */ });
    if (MOTION) {
      gsap.fromTo(fig, { clipPath: 'inset(0% 0% 100% 0%)', y: 10 },
        { clipPath: 'inset(0% 0% 0% 0%)', y: 0, duration: 0.75, ease: 'expo.out', overwrite: true, clearProps: 'clipPath,transform' });
    }
    video.focus({ preventScroll: true });
    updatePlay();
  };
  // restoreFocus：按“收起”、Esc 时把焦点还给按钮；滚走自动收起时只在焦点本来就在片子里时才送回去（不抢焦点）
  const shut = ({ restoreFocus = true } = {}) => {
    if (!S.filmOpen) return;
    S.filmOpen = false;
    const focusInside = fig.contains(document.activeElement);
    video.pause();
    stopDownload();
    btn.setAttribute('aria-expanded', 'false');
    html.classList.remove('film-open');
    const done = () => { fig.hidden = true; if (HAS_GSAP) gsap.set(fig, { clearProps: 'clipPath,transform' }); };
    if (MOTION) gsap.to(fig, { clipPath: 'inset(0% 0% 100% 0%)', duration: 0.36, ease: 'power2.in', overwrite: true, onComplete: done });
    else done();
    if (restoreFocus || focusInside) btn.focus({ preventScroll: true });
    updatePlay();
  };
  filmShut = shut;

  btn.addEventListener('click', e => { e.preventDefault(); if (S.filmOpen) shut(); else open(); });
  btn.addEventListener('keydown', e => {                       // 链接升级成按钮：空格也要能按
    if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); if (S.filmOpen) shut(); else open(); }
  });
  close?.addEventListener('click', () => shut());
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !S.filmOpen) return;
    const inHero = el.hero?.contains(document.activeElement) || document.activeElement === document.body;
    if (inHero && S.heroP < 0.9) { e.preventDefault(); shut(); }
  });
}

// ───────────────────────── 页内锚点：平滑滚动，焦点跟过去 ─────────────────────────
function setupAnchors() {
  document.addEventListener('click', e => {
    const a = e.target.closest?.('a[href^="#"]');
    if (!a || a.id === 'film-open' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const id = decodeURIComponent(a.getAttribute('href').slice(1));
    const target = id && document.getElementById(id);
    if (!target) return;
    e.preventDefault();
    // 自定义平滑滚动不会自动读 scroll-padding-top / scroll-margin-top（给固定导航留位），这里手动扣掉，与原生锚点跳转一致
    const pad = (parseFloat(getComputedStyle(html).scrollPaddingTop) || 0) + (parseFloat(getComputedStyle(target).scrollMarginTop) || 0);
    const top = id === 'hero' || id === 'main' ? 0 : target.getBoundingClientRect().top + window.scrollY - pad;
    window.scrollTo({ top, behavior: RM ? 'auto' : 'smooth' });
    if (id !== 'main') history.pushState(null, '', `#${id}`);
    const focusTarget = id === 'hero' ? $('#main') : target;
    if (!focusTarget.hasAttribute('tabindex')) focusTarget.setAttribute('tabindex', '-1');
    focusTarget.focus({ preventScroll: true });
  });
}

// ───────────────────────── 作品区（works 角色实现） ─────────────────────────
async function bootWorks() {
  if (!el.works) return;
  try {
    const mod = await import('./works.js');
    if (typeof mod.initWorks === 'function') {
      S.works = mod.initWorks(el.works, { gsap, ScrollTrigger, Flip, reducedMotion: RM || !HAS_GSAP });
    }
  } catch (e) { warn('作品区脚本没有载入，保留静态作品列表', e); }
  if (HAS_GSAP) ScrollTrigger.refresh(); else measure();
}

// 模块里的 let / const 都声明完了再启动（函数声明会提升，变量不会）
boot();
