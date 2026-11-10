// 北冥作品站 · 首屏毛笔标题“北冥”：用引擎自己的写字代码（engine/overlay/brush.js）按笔顺一笔一笔写出来，收笔带飞白。
//
// 骨架 SKEL 与飞白 DRY 拷自 src/hud.js 第 284–309 行（《北冥》片尾片名用的同一份手标骨架，em 单位，原点在字的中心），
// 只拷这两张表，不把整个 hud.js（显示层、字体加载、时间表）拉进站点。改骨架时两处一起改。
// 字形用 fonts/MaShanZheng-400.woff2（马善政毛笔楷书，SIL OFL 1.1，只含“北冥”两个字的子集）；
// 取不到时退回 css/fonts.css 里的 "Ma Shan Zheng"；都没有就不接管，页面上的文字照常显示。
//
//   createBrushTitle(el, opts) → controller | null
//     el      放字的元素（.hero-glyphs，里面就是“北冥”两个字，无脚本时直接显示）
//     opts    { reducedMotion }
//   controller = {
//     ready   Promise<boolean>   字体载好、字形预计算完（false = 放弃接管，保持 DOM 文字）
//     play(duration = 1.2)       开始书写（秒）；返回写完时 resolve 的 Promise。时长不同只改书写速度，不重算字形
//     finish()                   直接画成写完的样子（减少动态、或开场被跳过时用）
//     destroy()
//   }
// 墨色取 h1 的文字颜色（--ink）：近白字压在首屏薰衣草色的天空上只有约 2.7:1，墨色约 4.6:1，也更像题在画上的款。
// 预计算（距离变换 + 每个像素投影到笔画骨架）是这里最重的一步：两个字分两次算，中间让出主线程，
// 开场天空晕开时不会被一整块长任务卡住。先按 1 倍分辨率算第一个字，顺便量这台设备算得多快：
// 够快（两个字按高分辨率算也不到约 120 毫秒）就按屏幕像素比（最高 1.5 倍）重算；慢的设备就停在 1 倍。
import { buildBrushGlyph, paintBrushGlyph } from '@engine/overlay/brush.js';

const SKEL = {
  '北': [
    [[-0.172, -0.289], [-0.176, -0.167], [-0.189, 0.0], [-0.197, 0.167], [-0.198, 0.344]],                     // 竖
    [[-0.328, -0.109], [-0.278, -0.080], [-0.222, -0.056]],                                                     // 横
    [[-0.428, 0.267], [-0.322, 0.172], [-0.222, 0.056], [-0.144, -0.011], [-0.069, -0.080]],                    // 提
    [[0.250, -0.256], [0.189, -0.178], [0.122, -0.100], [0.044, 0.011], [-0.033, 0.111], [-0.098, 0.178]],      // 撇
    [[0.031, -0.344], [0.028, -0.167], [0.024, 0.056], [0.044, 0.211], [0.111, 0.300], [0.233, 0.342],
     [0.344, 0.333], [0.411, 0.278], [0.428, 0.189], [0.420, 0.100]],                                           // 竖弯钩
  ],
  '冥': [
    [[-0.267, -0.361], [-0.294, -0.278], [-0.324, -0.200], [-0.337, -0.139]],                                   // 点（冖）
    [[-0.239, -0.353], [-0.111, -0.376], [0.056, -0.380], [0.233, -0.364], [0.333, -0.331], [0.353, -0.294],
     [0.300, -0.264], [0.217, -0.247], [0.172, -0.236]],                                                        // 横钩（冖）
    [[-0.139, -0.239], [-0.136, -0.111], [-0.133, -0.022], [-0.131, 0.050]],                                    // 竖（日）
    [[-0.117, -0.239], [-0.022, -0.258], [0.089, -0.253], [0.156, -0.228], [0.131, -0.111], [0.128, -0.011], [0.109, 0.050]], // 横折（日）
    [[-0.111, -0.139], [-0.044, -0.156], [0.024, -0.153]],                                                      // 横（日）
    [[-0.106, -0.011], [-0.022, -0.017], [0.056, -0.006]],                                                      // 横（日）
    [[-0.076, 0.047], [-0.033, 0.083], [0.013, 0.117]],                                                         // 点（六）
    [[-0.250, 0.191], [-0.144, 0.169], [0.011, 0.156], [0.167, 0.144], [0.267, 0.158]],                         // 横（六）
    [[-0.076, 0.250], [-0.144, 0.333], [-0.222, 0.409], [-0.291, 0.458]],                                       // 撇（六）
    [[0.091, 0.272], [0.156, 0.333], [0.217, 0.400], [0.258, 0.444]],                                           // 点（六）
  ],
};
// 每一笔的飞白强度（0 = 不露白），按笔顺；只给收笔快的笔画（提、撇、长横、钩）
const DRY = { '北': [0, 0, 0.7, 0.6, 0.45], '冥': [0, 0.4, 0, 0.25, 0, 0, 0, 0.5, 0.7, 0.35] };

// 片中“北”“冥”的书写区间是 [9.0, 9.34] 与 [9.38, 9.80]：按同样的比例换算到站点的书写时长
const SPAN_RATIO = [[0, 0.34 / 0.8], [0.38 / 0.8, 1]];
const FAMILY = 'BM Brush Title';
const FONT_URL = new URL('../fonts/MaShanZheng-400.woff2', import.meta.url).href;
// 预计算的字形分辨率上限（相对 CSS 像素）：飞白的柔边本来就软，再高只是更慢
const SCALE_CAP = 1.5;
// 1 倍分辨率算第一个字超过这么久（毫秒），就算慢设备：高分辨率约是它的 2.25 倍，两个字会超过约 120 毫秒
const PROBE_MS = 26;
// 让出主线程一下（有空闲回调就等空闲，最多等 60 毫秒）
const yieldToMain = () => new Promise(r => (window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 60 }) : setTimeout(r, 0)));

let fontPromise = null;
function loadFont() {
  fontPromise ??= (async () => {
    try {
      // 子集文件里就只有“北冥”两个字：载入成功即可用
      const face = new FontFace(FAMILY, `url(${FONT_URL}) format("woff2")`, { weight: '400', display: 'block' });
      await withTimeout(face.load(), 2500);
      document.fonts.add(face);
      return `"${FAMILY}"`;
    } catch { /* 退回构建器生成的字体子集 */ }
    try {
      // fonts.load 只返回按 unicode-range 真正覆盖这两个字、并已载入的字体；空数组 = 没有
      const faces = await withTimeout(document.fonts.load('400 64px "Ma Shan Zheng"', '北冥'), 2500);
      if (faces && faces.length) return '"Ma Shan Zheng"';
    } catch { /* 没有毛笔字体 */ }
    return null;
  })();
  return fontPromise;
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

// 任意 CSS 颜色 → [r, g, b]（oklch 之类的现代写法也行：交给画布去解析）
function cssRGB(css) {
  const c = document.createElement('canvas'); c.width = c.height = 1;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.fillStyle = '#2A2D52'; x.fillStyle = css; x.fillRect(0, 0, 1, 1);
  const d = x.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}

export function createBrushTitle(el, { reducedMotion = false } = {}) {
  if (!el || typeof FontFace === 'undefined') return null;
  const chars = [...(el.textContent || '').trim()];
  if (!chars.length || !chars.every(ch => SKEL[ch])) return null;
  const host = el.parentElement;                       // h1：画布放在它里面，与文字同一个定位上下文
  const cv = document.createElement('canvas');
  cv.className = 'hero-brush';
  cv.setAttribute('aria-hidden', 'true');
  const ctx = cv.getContext('2d');

  let family = null, glyphs = [], geo = null, rgb = [42, 45, 82];
  let t0 = 0, raf = 0, state = 'idle', destroyed = false, done = null;
  const duration = 1.2;            // 字形里记的书写时间表按这个时长算；play(d) 用 speed = duration / d 换算，不重算字形
  let speed = 1, scaleCap = SCALE_CAP;

  // 量版式：每个字的中心（相对 h1），字号，画布范围（四周留出飞白与字形外溢的余量）
  function measure(cap = scaleCap) {
    const hostBox = host.getBoundingClientRect();
    const fs = parseFloat(getComputedStyle(el).fontSize) || 160;
    const node = el.firstChild;
    const range = document.createRange();
    const centers = chars.map((ch, i) => {
      range.setStart(node, i); range.setEnd(node, i + 1);
      const r = range.getBoundingClientRect();
      return [r.left + r.width / 2 - hostBox.left, r.top + r.height / 2 - hostBox.top];
    });
    const pad = fs * 0.16;
    const xs = centers.map(c => c[0]), ys = centers.map(c => c[1]);
    const box = {
      x: Math.min(...xs) - fs * 0.56 - pad, y: Math.min(...ys) - fs * 0.56 - pad,
      w: Math.max(...xs) - Math.min(...xs) + fs * 1.12 + 2 * pad, h: Math.max(...ys) - Math.min(...ys) + fs * 1.12 + 2 * pad,
    };
    const k = Math.min(window.devicePixelRatio || 1, cap);
    return { fs, centers, box, k, key: [fs, k, ...centers.flat().map(v => v.toFixed(1))].join('|') };
  }

  function glyphAt(i, F) {
    const ch = chars[i];
    return buildBrushGlyph(ch, {
      font: `400 ${F}px ${family}`, size: F, strokes: SKEL[ch],
      span: SPAN_RATIO[i] ? [SPAN_RATIO[i][0] * duration, SPAN_RATIO[i][1] * duration] : [0, duration],
      dry: DRY[ch] || [],
    });
  }
  function place() {
    cv.width = Math.ceil(geo.box.w * geo.k); cv.height = Math.ceil(geo.box.h * geo.k);
    Object.assign(cv.style, { left: `${geo.box.x}px`, top: `${geo.box.y}px`, width: `${geo.box.w}px`, height: `${geo.box.h}px` });
  }
  // 同步重算（窗口尺寸变了才用）
  function build() {
    geo = measure();
    const F = Math.max(8, Math.round(geo.fs * geo.k));
    glyphs = chars.map((_, i) => glyphAt(i, F));
    place();
  }
  // 首次预计算：一个字一段，中间让出主线程；第一段兼做测速（见文件头）
  async function buildChunked() {
    let g = measure(1), F = Math.max(8, Math.round(g.fs * g.k));
    const t = performance.now();
    let out = [glyphAt(0, F)];
    const slow = performance.now() - t > PROBE_MS;
    scaleCap = slow ? 1 : SCALE_CAP;
    const hi = measure();
    if (hi.k > g.k + 0.01) {                       // 够快、屏幕又是高像素比：按高分辨率重算第一个字
      await yieldToMain();
      if (destroyed) return false;
      g = hi; F = Math.max(8, Math.round(g.fs * g.k));
      out = [glyphAt(0, F)];
    }
    for (let i = 1; i < chars.length; i++) {
      await yieldToMain();
      if (destroyed) return false;
      out.push(glyphAt(i, F));
    }
    geo = g; glyphs = out;
    place();
    return true;
  }

  function paint(t) {
    ctx.clearRect(0, 0, cv.width, cv.height);
    glyphs.forEach((g, i) => {
      if (!paintBrushGlyph(g, t, { edge: 0.035, rgb })) return;
      const [cx, cy] = geo.centers[i];
      ctx.drawImage(g.out, Math.round((cx - geo.box.x) * geo.k - g.size / 2), Math.round((cy - geo.box.y) * geo.k - g.size / 2));
    });
  }

  function frame(now) {
    if (destroyed) return;
    const t = (now - t0) / 1000 * speed;
    paint(t);
    if (t < duration + 0.05) raf = requestAnimationFrame(frame);
    else { state = 'done'; done?.(); }
  }

  let resizeTimer = 0;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (destroyed || state === 'idle') return;
      const m = measure();
      if (geo && m.key === geo.key) return;
      build();
      paint(state === 'done' ? 1e3 : (performance.now() - t0) / 1000 * speed);
    }, 160);
  }

  const ready = (async () => {
    family = await loadFont();
    if (!family || destroyed) return false;
    rgb = cssRGB(getComputedStyle(host).color);
    // 让 DOM 里的（透明）文字也用同一个字体，选中、缩放时的位置与画布一致
    el.style.fontFamily = `${family}, var(--font-brush)`;
    host.appendChild(cv);
    try {
      if (!(await buildChunked())) { cv.remove(); el.style.fontFamily = ''; return false; }
    } catch (e) { cv.remove(); el.style.fontFamily = ''; console.warn('[北冥] 毛笔标题预计算失败，保留文字', e); return false; }
    window.addEventListener('resize', onResize, { passive: true });
    return true;
  })();

  return {
    ready,
    play(d = 1.2) {
      return ready.then(ok => new Promise(resolve => {
        if (!ok || destroyed) return resolve(false);
        speed = d > 0.05 ? duration / d : 1;
        host.classList.add('is-brushed');
        if (reducedMotion) { state = 'done'; paint(1e3); return resolve(true); }
        state = 'writing'; done = () => resolve(true);
        t0 = performance.now();
        cancelAnimationFrame(raf); raf = requestAnimationFrame(frame);
      }));
    },
    finish() {
      return ready.then(ok => {
        if (!ok || destroyed) return false;
        cancelAnimationFrame(raf);
        host.classList.add('is-brushed');
        state = 'done'; paint(1e3); done?.();
        return true;
      });
    },
    destroy() {
      destroyed = true; cancelAnimationFrame(raf); clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
      cv.remove(); host.classList.remove('is-brushed'); el.style.fontFamily = '';
    },
  };
}
