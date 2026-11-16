// 北冥作品站 · 作品区交互（works 角色）
//
//   export function initWorks(root, { gsap, ScrollTrigger, Flip, reducedMotion }) → { destroy() }
//
// 作品区标记由 tools/build-showcase.py 在构建时生成，没有 JS 也完整可用：海报直接链到预览视频。
// 这里只做增强：
//   · 画风家族筛选：Flip 重排接触印样，后面的分组与注一起滑到新位置，相纸跟着伸缩
//   · 悬停或键盘聚焦 180 ms 后才加载预览，静音循环；离开就停。减少动态、省流量、触屏都不自动播
//   · 点击在原地展开放映台：有声、带控件；焦点落在片名上，Esc 或「收起」关闭，焦点回到原来那一格；
//     正在放映的那一格用窗灯金的油性笔圈出来
//   · 进入视口时 ScrollTrigger.batch 分批淡入
//   · 胶片条左右翻看；键盘 Tab 到半露的格子时把它滚进来
// GSAP 没加载成功时交互照常，只是没有动画。调用方（main.js）负责 gsap.registerPlugin(ScrollTrigger, Flip)，
// 并最好在建完上方篇章的 ScrollTrigger（拆层 pin）之后再调用 initWorks，保证刷新顺序自上而下。

const HOVER_DELAY = 180;     // ms：悬停多久才开始加载预览
const NAV_SPACE = 88;        // px：把放映台滚进视口时，给顶部固定导航留的空间
const ACTION = '原地放映';    // 接管后作品链接读屏名的最后一段（构建时写的是「预览视频」：没有 JS 时链接直接打开视频）
const SVG_NS = 'http://www.w3.org/2000/svg';

// 标记顺序：题注 → 视频 → 收起 → 链接。打开时焦点放在片名上（Esc 在这里有效）；
// Tab 进播放器控件，Chromium 的原生控件会吞掉 Esc，所以「收起」紧跟视频，从控件 Tab 一次就到。视觉位置由 CSS 网格区域决定。
const SCREEN_HTML = `
  <div class="wk-screen-meta">
    <p class="wk-screen-kicker"><span class="wk-screen-n"></span><span class="wk-screen-group"></span></p>
    <h4 class="wk-screen-title" id="works-screen-title" tabindex="-1"></h4>
    <p class="wk-screen-facts"><span class="wk-screen-style"></span><span aria-hidden="true">·</span><span class="wk-screen-dur"></span></p>
    <p class="wk-screen-blurb"></p>
  </div>
  <div class="wk-screen-media">
    <video class="wk-screen-video" controls playsinline preload="metadata" data-flip-id="wk-poster"></video>
  </div>
  <button type="button" class="wk-screen-close">收起<span class="wk-sr">放映台</span><span class="wk-key" aria-hidden="true">Esc</span></button>
  <div class="wk-screen-foot">
    <a class="wk-screen-case" target="_blank" rel="noopener">案例卡<span class="wk-sr">（新标签页）</span></a>
    <a class="wk-screen-source" target="_blank" rel="noopener">归档源码<span class="wk-sr">（新标签页）</span></a>
  </div>`;

// 油性笔圈：沿格子外 5px 顺时针一圈，四角圆、边略歪，收笔越过起笔一点。按格子 id 定种子，同一格每次圈得一样
function markPath(w, h, seedText) {
  let s = 2166136261;
  for (const ch of seedText) s = Math.imul(s ^ ch.charCodeAt(0), 16777619) >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const j = (a) => (rnd() * 2 - 1) * a;
  const o = 5;
  const L = -o, T = -o, R = w + o, B = h + o;
  const r = Math.max(6, Math.min(14, h * 0.1));
  const pts = [
    [L + r * 1.8 + j(2), T + j(1.2)],
    [w * 0.5 + j(w * 0.04), T - 1 + j(1.5)],
    [R - r + j(1.5), T + j(1.2)],
    [R + j(1.2), T + r + j(1.5)],
    [R + 1 + j(1.5), h * 0.5 + j(h * 0.05)],
    [R + j(1.2), B - r + j(1.5)],
    [R - r + j(1.5), B + j(1.2)],
    [w * 0.5 + j(w * 0.04), B + 1 + j(1.5)],
    [L + r + j(1.5), B + j(1.2)],
    [L + j(1.2), B - r + j(1.5)],
    [L - 1 + j(1.5), h * 0.5 + j(h * 0.05)],
    [L + j(1.2), T + r * 1.1 + j(1.5)],
    [L + r * 0.9 + j(1.5), T - 1.5 + j(1)],
    [L + r * 3.4 + j(3), T + 1.2 + j(1)],
  ];
  const f = (v) => v.toFixed(1);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {        // Catmull-Rom 过点，换成三次贝塞尔
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)}`
      + ` ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

export function initWorks(root, options = {}) {
  const box = root && root.querySelector('[data-works]');
  if (!box) return { destroy() {} };

  const { gsap = null, ScrollTrigger = null, Flip = null } = options;
  const reducedMotion = Boolean(options.reducedMotion);
  const motion = Boolean(gsap) && !reducedMotion;          // 是否做动画
  const canFlip = motion && Boolean(Flip);
  if (gsap && ScrollTrigger) gsap.registerPlugin(ScrollTrigger);
  if (gsap && Flip) gsap.registerPlugin(Flip);

  const disposers = [];
  const listen = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    disposers.push(() => target.removeEventListener(type, fn, opts));
  };

  const frames = Array.from(box.querySelectorAll('.wk-frame'));
  const sheet = box.querySelector('[data-sheet]');
  const sheetFrames = sheet ? Array.from(sheet.querySelectorAll('.wk-frame')) : [];
  const linkOf = (frame) => frame.querySelector('.wk-link');
  const saveData = Boolean(navigator.connection && navigator.connection.saveData);
  const hoverMQ = window.matchMedia('(hover: hover) and (pointer: fine)');
  const scrollBehavior = reducedMotion ? 'auto' : 'smooth';

  box.classList.add('is-enhanced');
  for (const frame of frames) {
    const link = linkOf(frame);
    link.setAttribute('aria-expanded', 'false');
    const label = link.getAttribute('aria-label');
    if (label) {
      link.dataset.label = label;
      link.setAttribute('aria-label', label.replace(/，[^，]*$/, `，${ACTION}`));
    }
  }
  const setExpanded = (frame, on) => {
    const link = linkOf(frame);
    link.setAttribute('aria-expanded', String(on));
    if (on) link.setAttribute('aria-controls', 'works-screen');
    else link.removeAttribute('aria-controls');
  };

  // ───────────── 相纸：印样变高变矮时跟着格子一起伸缩 ─────────────
  // 返回此刻看到的相纸高度（上一段伸缩可能还没走完）
  function paperState() {
    if (!sheet) return 0;
    const s = Number.parseFloat(sheet.style.getPropertyValue('--wk-paper-s')) || 1;
    return sheet.offsetHeight * s;
  }
  function paperFrom(h0, duration, ease) {
    if (!sheet || !motion || !h0) return;
    const h1 = sheet.offsetHeight;
    if (!h1 || Math.abs(h1 - h0) < 2) return;
    gsap.fromTo(sheet, { '--wk-paper-s': h0 / h1 }, {
      '--wk-paper-s': 1, duration, ease, overwrite: 'auto',
      onComplete: () => sheet.style.removeProperty('--wk-paper-s'),
    });
  }

  // ───────────── 放映台 ─────────────
  const screen = document.createElement('section');
  screen.className = 'wk-screen';
  screen.id = 'works-screen';
  screen.setAttribute('aria-labelledby', 'works-screen-title');
  screen.innerHTML = SCREEN_HTML;
  const $ = (sel) => screen.querySelector(sel);
  const video = $('.wk-screen-video');
  const meta = $('.wk-screen-meta');
  const titleEl = $('.wk-screen-title');
  const closeBtn = $('.wk-screen-close');
  const foot = $('.wk-screen-foot');
  const sheetHost = document.createElement('li');
  sheetHost.className = 'wk-screen-row';
  const stripHosts = new Map();

  let current = null;          // 正在放映的那一格
  let currentHost = null;
  let pendingClose = null;     // 收起动画还没结束时的收尾函数
  let quietFocus = null;       // 收起后焦点还回来的那一格：这一次聚焦不触发悬停预览
  let screenSeen = false;      // 放映台出现在视口里过（之后离开视口才自动暂停）

  const groupTitle = (frame) => {
    const h = frame.closest('.wk-group')?.querySelector('.wk-group-title');
    return h && h.firstChild ? h.firstChild.textContent.trim() : '';
  };

  function hostFor(frame) {
    if (sheet && sheet.contains(frame)) return sheetHost;
    const group = frame.closest('.wk-group');
    let host = stripHosts.get(group);
    if (!host) {
      host = document.createElement(group.classList.contains('wk-group--films') ? 'li' : 'div');
      host.className = 'wk-screen-row' + (group.classList.contains('wk-group--films') ? '' : ' wk-screen-row--strip');
      stripHosts.set(group, host);
    }
    return host;
  }

  // 同一行最后一格（跳过筛掉的格子与放映台本身）
  function rowEnd(frame) {
    const top = frame.offsetTop;
    let end = frame;
    for (let n = frame.nextElementSibling; n; n = n.nextElementSibling) {
      if (n.classList.contains('wk-screen-row') || n.hidden) continue;
      if (n.offsetTop !== top) break;
      end = n;
    }
    return end;
  }

  function placeHost(frame, host) {
    if (host === sheetHost || frame.closest('.wk-group--films')) {
      const end = rowEnd(frame);
      if (end.nextElementSibling !== host) end.after(host);
    } else {
      const strip = frame.closest('.wk-group').querySelector('.wk-strip');
      if (strip.nextElementSibling !== host) strip.after(host);
    }
    if (screen.parentNode !== host) host.appendChild(screen);
  }

  // 放映台出现/消失时会被推开的东西：同组里这一行之后的格子，以及后面的分组与注
  function followers(frame) {
    const list = [];
    if (sheet && sheet.contains(frame)) {
      const end = rowEnd(frame);
      for (let n = end.nextElementSibling; n; n = n.nextElementSibling) {
        if (n !== sheetHost && !n.hidden) list.push(n);
      }
    }
    const group = frame.closest('.wk-group');
    for (let g = group.nextElementSibling; g; g = g.nextElementSibling) list.push(g);
    const vh = window.innerHeight;
    return list.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > -80 && r.top < vh * 1.6;
    });
  }

  function fill(frame) {
    const link = linkOf(frame);
    const img = frame.querySelector('.wk-pic img');
    const title = frame.querySelector('.wk-name').textContent.trim();
    $('.wk-screen-n').textContent = frame.dataset.n || '';
    $('.wk-screen-group').textContent = groupTitle(frame);
    titleEl.textContent = title;
    $('.wk-screen-style').textContent = frame.querySelector('.wk-style').textContent.trim();
    $('.wk-screen-dur').textContent = frame.querySelector('.wk-dur').textContent.trim();
    $('.wk-screen-blurb').textContent = img ? img.alt : '';
    $('.wk-screen-case').hidden = !frame.dataset.case;
    $('.wk-screen-case').href = frame.dataset.case || '#';
    $('.wk-screen-source').hidden = !frame.dataset.source;
    $('.wk-screen-source').href = frame.dataset.source || '#';
    video.poster = img ? img.currentSrc || img.src : '';
    video.src = frame.dataset.preview || link.href;
    video.title = `《${title}》`;
  }

  // ───────────── 油性笔圈 ─────────────
  const mark = document.createElementNS(SVG_NS, 'svg');
  mark.setAttribute('class', 'wk-mark');
  mark.setAttribute('aria-hidden', 'true');
  mark.setAttribute('focusable', 'false');
  mark.setAttribute('preserveAspectRatio', 'none');
  const markLine = document.createElementNS(SVG_NS, 'path');
  markLine.setAttribute('pathLength', '1');
  mark.appendChild(markLine);
  let markHost = null;
  let markTween = null;
  const markRO = 'ResizeObserver' in window ? new ResizeObserver(() => drawMark()) : null;

  function drawMark() {
    if (!markHost || !current) return;
    const w = markHost.clientWidth;
    const h = markHost.clientHeight;
    if (!w || !h) return;
    mark.setAttribute('viewBox', `0 0 ${w} ${h}`);
    markLine.setAttribute('d', markPath(w, h, current.dataset.id || current.dataset.n || ''));
  }

  function attachMark(frame) {
    detachMark();
    markHost = frame.querySelector('.wk-film') || frame;     // 胶片条只圈画面，印样圈整格
    markHost.appendChild(mark);
    drawMark();
    if (markRO) markRO.observe(markHost);
    if (motion) {
      // 像笔落下去顺着圈一圈：虚线偏移从整圈收到 0
      markLine.style.strokeDasharray = '1 2';
      const p = { v: 1.01 };
      markLine.style.strokeDashoffset = String(p.v);
      markTween = gsap.to(p, {
        v: 0, duration: 0.6, delay: 0.12, ease: 'power2.inOut',
        onUpdate: () => { markLine.style.strokeDashoffset = String(p.v); },
        onComplete: () => { markLine.style.strokeDasharray = ''; markLine.style.strokeDashoffset = ''; markTween = null; },
      });
    }
  }

  function detachMark() {
    if (markTween) { markTween.kill(); markTween = null; }
    markLine.style.strokeDasharray = '';
    markLine.style.strokeDashoffset = '';
    if (markRO) markRO.disconnect();
    mark.remove();
    markHost = null;
  }

  // 把元素滚进视口；返回是否起了一段平滑滚动
  function reveal(el) {
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight;
    let dy = 0;
    if (r.height > vh - NAV_SPACE || r.top < NAV_SPACE) dy = r.top - NAV_SPACE;
    else if (r.bottom > vh - 16) dy = r.bottom - vh + 24;
    if (Math.abs(dy) <= 1) return false;
    window.scrollTo({ top: window.scrollY + dy, behavior: scrollBehavior });
    return scrollBehavior === 'smooth';
  }

  // ScrollTrigger.refresh() 会把页面滚到顶再滚回来量位置，正在进行的平滑滚动会被它打断（停在半路）：
  // 起了平滑滚动时等它滚完再刷新
  const SETTLE = 1000;
  function refreshTriggers(wait = 120) {
    if (!ScrollTrigger) return;
    clearTimeout(refreshTriggers.t);
    refreshTriggers.t = setTimeout(() => ScrollTrigger.refresh(), wait);
  }

  function open(frame) {
    if (!frame) return;
    if (pendingClose) pendingClose();
    if (current === frame) { close(); return; }
    stopHover();
    revealFrames(frames, true);

    const host = hostFor(frame);
    const sameSpot = Boolean(current) && host === currentHost &&
      (host !== sheetHost || rowEnd(frame) === rowEnd(current));
    if (current && !sameSpot) closeNow();
    if (current) {
      current.classList.remove('is-current');
      setExpanded(current, false);
    }

    const img = frame.querySelector('.wk-pic img');
    let state = null;
    let moving = [];
    if (canFlip && !sameSpot) {
      moving = followers(frame);
      if (img) img.dataset.flipId = 'wk-poster';
      state = Flip.getState(img ? [img, ...moving] : moving);
    }
    const h0 = host === sheetHost && !sameSpot ? paperState() : 0;

    video.pause();
    fill(frame);
    placeHost(frame, host);
    current = frame;
    currentHost = host;
    screenSeen = false;
    frame.classList.add('is-current');
    setExpanded(frame, true);
    attachMark(frame);

    if (state) {
      Flip.from(state, {
        targets: [video, ...moving],
        duration: 0.72,
        ease: 'expo.out',
        scale: true,
        zIndex: 5,
        onComplete: () => {
          if (img) delete img.dataset.flipId;
          gsap.set(video, { clearProps: 'transform,zIndex' });
        },
      });
      paperFrom(h0, 0.72, 'expo.out');
      gsap.fromTo([meta, closeBtn, foot], { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.6, delay: 0.12, stagger: 0.04, ease: 'power4.out', clearProps: 'opacity,transform' });
    } else if (motion && sameSpot) {
      gsap.fromTo(screen, { opacity: 0.35 }, { opacity: 1, duration: 0.32, ease: 'power4.out', clearProps: 'opacity' });
    }

    const playing = video.play();
    if (playing) playing.catch(() => {});
    titleEl.focus({ preventScroll: true });
    refreshTriggers(SETTLE);
    requestAnimationFrame(() => { if (!reveal(screen)) refreshTriggers(); });
  }

  function detach() {
    video.pause();
    video.removeAttribute('src');
    video.removeAttribute('poster');
    video.load();
    if (currentHost) currentHost.remove();
  }

  // 立即收起（换到别的行时用，不还焦点）
  function closeNow() {
    if (!current) return;
    current.classList.remove('is-current');
    setExpanded(current, false);
    detachMark();
    detach();
    current = null;
    currentHost = null;
  }

  function close({ restoreFocus = true } = {}) {
    if (pendingClose) pendingClose();
    if (!current) return;
    const frame = current;
    const link = linkOf(frame);
    const focusInside = screen.contains(document.activeElement);
    frame.classList.remove('is-current');
    setExpanded(frame, false);
    detachMark();
    video.pause();

    let scrolling = false;
    const finish = () => {
      pendingClose = null;
      const moving = canFlip ? followers(frame) : [];
      const state = moving.length ? Flip.getState(moving) : null;
      const h0 = currentHost === sheetHost ? paperState() : 0;
      detach();
      currentHost = null;
      if (gsap) gsap.set(screen, { clearProps: 'opacity' });
      if (state) {
        Flip.from(state, { duration: 0.5, ease: 'power4.out', scale: true });
        paperFrom(h0, 0.5, 'power4.out');
      }
      refreshTriggers(scrolling ? SETTLE : 120);
    };
    current = null;
    if (restoreFocus && (focusInside || document.activeElement === document.body)) {
      quietFocus = link;
      link.focus({ preventScroll: true });
      quietFocus = null;
      const r = link.getBoundingClientRect();
      if (r.top < NAV_SPACE || r.bottom > window.innerHeight) {
        link.scrollIntoView({ block: 'nearest', behavior: scrollBehavior });
        scrolling = scrollBehavior === 'smooth';
      }
    }
    if (motion) {
      const tween = gsap.to(screen, { opacity: 0, duration: 0.18, ease: 'power2.out', onComplete: finish });
      pendingClose = () => { tween.kill(); finish(); };
    } else {
      finish();
    }
  }

  listen(box, 'click', (e) => {
    const link = e.target.closest('.wk-link');
    if (!link || !box.contains(link)) return;
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    open(link.closest('.wk-frame'));
  });
  listen(closeBtn, 'click', () => close());
  listen(document, 'keydown', (e) => {
    if (e.key === 'Escape' && current && !e.defaultPrevented) close();
  });
  // 焦点在片名上时，空格暂停 / 继续（以前焦点在视频上，空格就是暂停键，这里保留这个习惯）
  listen(titleEl, 'keydown', (e) => {
    if (e.key !== ' ' || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    if (e.repeat) return;
    if (video.paused) { const p = video.play(); if (p) p.catch(() => {}); } else video.pause();
  });

  // 放映台被滚出视口就暂停（只在它出现过之后）
  const screenIO = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) screenSeen = true;
      else if (screenSeen && !video.paused) video.pause();
    }
  }) : null;
  if (screenIO) screenIO.observe(screen);

  // 窗口变宽变窄时，一行的格数会变：把放映台挪到新的行尾
  const sheetRO = sheet && 'ResizeObserver' in window ? new ResizeObserver(() => {
    if (current && currentHost === sheetHost) placeHost(current, sheetHost);
  }) : null;
  if (sheetRO) sheetRO.observe(sheet);

  // ───────────── 悬停预览 ─────────────
  let hoverTimer = 0;
  let hover = null;            // { frame, v }

  function armHover(frame, viaFocus = false) {
    if (reducedMotion || saveData) return;
    if (!viaFocus && !hoverMQ.matches) return;
    if (frame === current) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => startHover(frame), HOVER_DELAY);
  }

  function disarmHover(frame) {
    clearTimeout(hoverTimer);
    if (hover && hover.frame === frame) stopHover();
  }

  function startHover(frame) {
    stopHover();
    if (frame === current) return;
    const pic = frame.querySelector('.wk-pic');
    const img = pic.querySelector('img');
    const v = document.createElement('video');
    v.className = 'wk-hover';
    v.muted = true;
    v.defaultMuted = true;
    v.loop = true;
    v.playsInline = true;
    v.preload = 'metadata';
    v.setAttribute('muted', '');
    v.setAttribute('playsinline', '');
    v.setAttribute('aria-hidden', 'true');
    v.tabIndex = -1;
    v.disablePictureInPicture = true;
    if (frame.dataset.hover) {
      // 构建时剪好的悬停短循环：从海报那一帧开始、几百 KB，不用为几秒悬停下载整部预览
      v.src = frame.dataset.hover;
    } else {
      // 从海报那一帧起播（媒体片段 #t=）：海报到视频无缝衔接
      const start = Number.parseFloat(frame.dataset.start) || 0;
      v.src = start > 0 ? `${frame.dataset.preview}#t=${start}` : frame.dataset.preview;
    }
    if (img) img.after(v); else pic.prepend(v);           // 盖在海报上，编号与画风名仍在最上层
    const h = { frame, v };
    hover = h;
    v.addEventListener('playing', () => { if (hover === h) frame.classList.add('is-previewing'); }, { once: true });
    const p = v.play();
    if (p) p.catch(() => {});
  }

  function stopHover() {
    clearTimeout(hoverTimer);
    if (!hover) return;
    const { frame, v } = hover;
    hover = null;
    frame.classList.remove('is-previewing');
    const drop = () => { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); };
    if (reducedMotion) drop(); else setTimeout(drop, 320);
  }

  for (const frame of frames) {
    const link = linkOf(frame);
    listen(link, 'pointerenter', (e) => { if (e.pointerType !== 'touch') armHover(frame); });
    listen(link, 'pointerleave', () => disarmHover(frame));
    listen(link, 'focus', () => { if (link !== quietFocus && link.matches(':focus-visible')) armHover(frame, true); });
    listen(link, 'blur', () => disarmHover(frame));
  }
  listen(document, 'visibilitychange', () => { if (document.hidden) stopHover(); });

  // ───────────── 画风家族筛选 ─────────────
  const filter = box.querySelector('.wk-filter');
  const status = box.querySelector('[data-filter-status]');
  const chips = filter ? Array.from(filter.querySelectorAll('.wk-chip')) : [];
  let family = 'all';
  if (filter && sheetFrames.length) {
    filter.hidden = false;
    for (const chip of chips) {
      listen(chip, 'click', () => applyFamily(chip.dataset.family, chip));
    }
  }

  function applyFamily(key, chip, { instant = false } = {}) {
    if (key === family) return;
    const url = new URL(location.href);
    if (key === 'all') url.searchParams.delete('f'); else url.searchParams.set('f', key);
    history.replaceState(history.state, '', url);
    if (current && currentHost === sheetHost) closeNow();
    stopHover();
    revealFrames(frames, true);
    // 印样后面的分组与注也交给 Flip：和格子一起滑到新位置，不先跳过去
    const after = canFlip ? Array.from(box.querySelectorAll('.wk-group--strip, .wk-note')) : [];
    const state = canFlip && !instant ? Flip.getState([...sheetFrames, ...after]) : null;
    const h0 = instant ? 0 : paperState();
    let shown = 0;
    for (const frame of sheetFrames) {
      const on = key === 'all' || frame.dataset.family === key;
      frame.hidden = !on;
      if (on) shown += 1;
    }
    for (const c of chips) c.setAttribute('aria-pressed', String(c === chip));
    family = key;
    if (status) {
      const name = chip.firstChild ? chip.firstChild.textContent.trim() : '';
      status.textContent = `${name}：${shown} 部`;
    }
    if (state) {
      Flip.from(state, {
        targets: [...sheetFrames, ...after],
        duration: 0.6,
        ease: 'power4.out',
        scale: true,
        absoluteOnLeave: true,
        onEnter: (els) => gsap.fromTo(els, { opacity: 0, scale: 0.94 }, { opacity: 1, scale: 1, duration: 0.45, delay: 0.12, ease: 'power4.out' }),
        onLeave: (els) => gsap.to(els, { opacity: 0, scale: 0.94, duration: 0.22, ease: 'power2.in' }),
        onComplete: refreshTriggers,
      });
      paperFrom(h0, 0.6, 'power4.out');
    } else {
      refreshTriggers();
    }
  }

  // ───────────── 胶片条左右翻看 ─────────────
  const stripROs = [];
  for (const group of box.querySelectorAll('.wk-group--strip')) {
    const track = group.querySelector('[data-track]');
    const nav = group.querySelector('.wk-strip-nav');
    if (!track) continue;
    // 键盘 Tab 到只露出一半的格子：浏览器不会自己滚，这里把它滚到条的起点
    listen(track, 'focusin', (e) => {
      const f = e.target.closest && e.target.closest('.wk-frame');
      if (!f || !track.contains(f)) return;
      const r = f.getBoundingClientRect();
      const tr = track.getBoundingClientRect();
      if (r.right <= tr.right - 8 && r.left >= tr.left + 8) return;
      const pad = Number.parseFloat(getComputedStyle(track).scrollPaddingLeft) || 0;
      track.scrollTo({ left: track.scrollLeft + (r.left - tr.left) - pad, behavior: scrollBehavior });
    });
    if (!nav) continue;
    const [prev, next] = nav.querySelectorAll('.wk-strip-btn');
    const step = () => {
      const first = track.querySelector('.wk-frame');
      const w = first ? first.getBoundingClientRect().width : track.clientWidth * 0.8;
      return Math.max(w, Math.floor(track.clientWidth / w) * w - w);
    };
    const update = () => {
      const max = track.scrollWidth - track.clientWidth - 2;
      nav.hidden = max <= 0;
      prev.setAttribute('aria-disabled', String(track.scrollLeft <= 2));
      next.setAttribute('aria-disabled', String(track.scrollLeft >= max));
    };
    const go = (dir) => {
      const btn = dir < 0 ? prev : next;
      if (btn.getAttribute('aria-disabled') === 'true') return;
      track.scrollBy({ left: dir * step(), behavior: scrollBehavior });
    };
    listen(prev, 'click', () => go(-1));
    listen(next, 'click', () => go(1));
    listen(track, 'scroll', update, { passive: true });
    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(update);
      ro.observe(track);
      stripROs.push(ro);
    }
    update();
  }

  // ───────────── 入场：分批淡入 ─────────────
  const pending = new Set();
  let batch = [];
  // instant：筛选、开放映台之前要立刻落定，免得入场补间和 Flip 抢同一个 transform
  function revealFrames(list, instant = false) {
    const todo = list.filter((el) => pending.has(el));
    if (!todo.length) return;
    for (const el of todo) pending.delete(el);
    if (!gsap) return;
    if (instant) gsap.set(todo, { clearProps: 'opacity,transform' });
    else gsap.to(todo, { opacity: 1, y: 0, duration: 0.8, ease: 'expo.out', stagger: 0.04, overwrite: true, clearProps: 'opacity,transform' });
  }
  if (motion && ScrollTrigger) {
    // 只动 opacity 与 y：用 visibility 隐藏会让键盘跳过还没淡入的格子
    for (const frame of frames) pending.add(frame);
    gsap.set(frames, { opacity: 0, y: 24 });
    const onBatch = (els) => revealFrames(els);
    batch = ScrollTrigger.batch(frames, {
      start: 'top 94%',
      interval: 0.1,
      batchMax: 12,
      onEnter: onBatch,
      onEnterBack: onBatch,
      onLeave: onBatch,
    });
    // 直接带锚点进来时，视口上方与视口里的格子立即补上
    requestAnimationFrame(() => {
      const vh = window.innerHeight;
      revealFrames(frames.filter((f) => f.getBoundingClientRect().top < vh));
    });
    listen(box, 'focusin', (e) => {
      const frame = e.target.closest && e.target.closest('.wk-frame');
      if (frame) revealFrames([frame]);
    });
  }

  // 筛选写在地址栏 ?f=家族（锚点 #works 不动）：刷新、分享、代理直接打开某一家族都能还原。
  // 放在最后：applyFamily 用到上面各段的状态（入场队列等），提前调会撞上 const 的暂时性死区
  if (filter && sheetFrames.length) {
    const initial = chips.find((c) => c.dataset.family === new URLSearchParams(location.search).get('f'));
    if (initial && initial.dataset.family !== 'all') applyFamily(initial.dataset.family, initial, { instant: true });
  }

  function destroy() {
    if (pendingClose) pendingClose();
    closeNow();
    stopHover();
    for (const t of batch) t.kill();
    batch = [];
    for (const off of disposers) off();
    disposers.length = 0;
    if (screenIO) screenIO.disconnect();
    if (sheetRO) sheetRO.disconnect();
    if (markRO) markRO.disconnect();
    for (const ro of stripROs) ro.disconnect();
    if (gsap) gsap.set(frames, { clearProps: 'opacity,transform' });
    if (sheet) sheet.style.removeProperty('--wk-paper-s');
    for (const frame of sheetFrames) frame.hidden = false;
    for (const c of chips) c.setAttribute('aria-pressed', String(c.dataset.family === 'all'));
    if (filter) filter.hidden = true;
    for (const nav of box.querySelectorAll('.wk-strip-nav')) nav.hidden = true;
    for (const frame of frames) {
      const link = linkOf(frame);
      link.removeAttribute('aria-controls');
      link.removeAttribute('aria-expanded');
      if (link.dataset.label) {
        link.setAttribute('aria-label', link.dataset.label);
        delete link.dataset.label;
      }
    }
    box.classList.remove('is-enhanced');
  }

  return { destroy };
}
