// 字幕新闻 ·《会用工具的海獭》— 1920×1080, 30 fps, 19.5 s
// render(t) 是时间的纯函数：先用占位同步画一遍（TEXTS 立即有效），再加载缺的图重画。无 Math.random / Date.now。
const TLD = window.TL; // 来自 timeline.js
const W = 1920, H = 1080, FPS = TLD.fps, DUR = TLD.dur;
const cv = document.getElementById('out'), ctx = cv.getContext('2d');

// ---------- helpers ----------
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const seg = (t, a, b) => clamp((t - a) / (b - a));
const eo = t => 1 - Math.pow(1 - clamp(t), 3);
const ei = t => Math.pow(clamp(t), 3);
const eio = t => { t = clamp(t); return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
const back = (t, s = 1.6) => { t = clamp(t) - 1; return 1 + t * t * ((s + 1) * t + s); };

// ---------- palette, type, layout ----------
const C = { bg: '#0E0E0C', panel: '#151512', ink: '#F7F5EF', honey: '#FFC21A', loss: '#FF4A3D', grey: '#8D8B83', dim: 'rgba(247,245,239,.78)', desk: '#22211D' };
const F = { zh9: "'SC9'", zh5: "'SC5'", n8: "'IT8','SC9'", n5: "'IT5','SC5'" };
const CAP = { x: 120, zhY: 948, zh: 88, enY: 1014, en: 33 };
const GRADE = 'contrast(1.07) saturate(0.92) brightness(0.98)';
const H2 = TLD.hits;
let TX = [];

// ---------- loading ----------
const DIMS = { hook: [2240, 1260], bite: [2240, 1260], wean: [2692, 1260], mompup: [2150, 1209], raft: [4752, 2557], fig45: [1630, 2709], doc33: [1856, 2535], doc35: [1859, 2539], v1: [1920, 1080], v2: [2688, 1512] };
const LOADED = new Map(), NEED = new Set(), PH = new Map();
function keyOf(src) { const m = src.match(/(?:fr\/([a-z0-9]+)_|img\/([a-z0-9]+)\.)/) || []; return m[1] || m[2]; }
function getImg(src) {
  const im = LOADED.get(src); if (im) return im; NEED.add(src);
  if (!PH.has(src)) { const [w, h] = DIMS[keyOf(src)] || [W, H]; PH.set(src, { width: w, height: h, ph: true }); }
  return PH.get(src);
}
function load(src) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => im.decode().then(() => res(im), () => res(im)); im.onerror = () => rej(new Error('missing ' + src)); im.src = src; })
    .then(im => { LOADED.set(src, im); if (src.includes('/fr/') && LOADED.size > 60) for (const k of LOADED.keys()) if (k.includes('/fr/')) { LOADED.delete(k); break; } });
}
const img = n => getImg(`assets/img/${n}.jpg`);
const frame = (fr, n, t, a) => getImg(`assets/fr/${fr}_${String(clamp(Math.floor((t - a) * FPS + 1e-6) + 1, 1, n)).padStart(3, '0')}.jpg`);
function di(im, ...a) { if (!im.ph) ctx.drawImage(im, ...a); }

// ---------- drawing basics ----------
function text(s, x, y, font, color, align = 'left', base = 'alphabetic') { ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = base; ctx.fillText(s, x, y); }
function tw(s, font) { ctx.font = font; return ctx.measureText(s).width; }
function warm(a = 0.06) { ctx.save(); ctx.globalCompositeOperation = 'soft-light'; ctx.fillStyle = `rgba(255,170,70,${a})`; ctx.fillRect(0, 0, W, H); ctx.restore(); }
// 一个“相机”：图像坐标 (px,py) 放到屏幕 (sx,sy)，比例 s（像素→屏幕），并夹住不露边。返回 world→screen 映射。
function cam(im, s, px, py, sx = W / 2, sy = H / 2) {
  const dw = im.width * s, dh = im.height * s;
  const dx = clamp(sx - px * s, W - dw, 0), dy = clamp(sy - py * s, H - dh, 0);
  return { dx, dy, s, X: x => dx + x * s, Y: y => dy + y * s };
}
function drawCam(im, c, filt = GRADE) { ctx.filter = filt; di(im, c.dx, c.dy, im.width * c.s, im.height * c.s); ctx.filter = 'none'; warm(); }
function shade(top = 560, a = .84) {
  const g = ctx.createLinearGradient(0, top, 0, H); g.addColorStop(0, 'rgba(14,14,12,0)'); g.addColorStop(.55, `rgba(14,14,12,${a * .7})`); g.addColorStop(1, `rgba(14,14,12,${a})`);
  ctx.fillStyle = g; ctx.fillRect(0, top, W, H - top);
  const r = ctx.createRadialGradient(0, H, 0, 0, H, 1100); r.addColorStop(0, 'rgba(14,14,12,.45)'); r.addColorStop(1, 'rgba(14,14,12,0)'); ctx.fillStyle = r; ctx.fillRect(0, 0, W, H);
}
function topShade() { const g = ctx.createLinearGradient(0, 0, 0, 200); g.addColorStop(0, 'rgba(14,14,12,.55)'); g.addColorStop(1, 'rgba(14,14,12,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, 200); }
function veil() { shade(); topShade(); }
function flash(t, t0, dur = 2 / 30) { if (t < t0 || t >= t0 + dur + 1 / 30) return; const k = seg(t, t0, t0 + dur + 1 / 30); ctx.fillStyle = `rgba(255,255,255,${(1 - k) * .92})`; ctx.fillRect(0, 0, W, H); }
function num(s, x, y, size, color, align = 'left') {
  const f = `800 ${size}px ${F.n8}`; ctx.font = f; const cw = ctx.measureText('0').width;
  const wOf = ch => /[0-9]/.test(ch) ? cw : ctx.measureText(ch).width;
  let total = 0; for (const ch of s) total += wOf(ch);
  let cx = align === 'right' ? x - total : align === 'center' ? x - total / 2 : x;
  ctx.fillStyle = color; ctx.textBaseline = 'alphabetic';
  for (const ch of s) { const w = wOf(ch); ctx.textAlign = 'center'; ctx.fillText(ch, cx + w / 2, y); cx += w; }
  return total;
}
// 频道角标（虚构频道“潮汐速报”）
function bug(t) {
  const k = eo(seg(t, H2.bug, H2.bug + .2)); if (k <= 0) return;
  ctx.save(); ctx.globalAlpha = k; const x = 96 - (1 - k) * 40, y = 52;
  ctx.fillStyle = C.honey; ctx.fillRect(x, y, 132, 46); text('潮汐速报', x + 66, y + 33, `900 26px ${F.zh9}`, C.bg, 'center');
  ctx.fillStyle = 'rgba(14,14,12,.62)'; ctx.fillRect(x + 132, y, 250, 46);
  text('海獭', x + 148, y + 33, `900 26px ${F.zh9}`, C.ink); text('SEA OTTERS', x + 214, y + 31, `800 17px ${F.n8}`, C.honey);
  ctx.restore();
  TX.push({ id: 'bug', text: '潮汐速报 海獭', x0: 96, y0: y, x1: 96 + 382, y1: y + 46 });
}
function sourceTag(t, t0, label) {
  const k = eo(seg(t, t0, t0 + .2)); if (k <= 0) return; ctx.save(); ctx.globalAlpha = k; const x = 96 - (1 - k) * 40, y = 108;
  const w1 = tw('来源', `900 22px ${F.zh9}`) + 20, w2 = tw(label, `500 21px ${F.n5}`) + 22;
  ctx.fillStyle = 'rgba(14,14,12,.55)'; ctx.fillRect(x - 24, 36, Math.max(382, w1 + w2) + 48, 124);
  ctx.fillStyle = C.ink; ctx.fillRect(x, y, w1, 36); text('来源', x + 10, y + 26, `900 22px ${F.zh9}`, C.bg);
  ctx.fillStyle = 'rgba(14,14,12,.82)'; ctx.fillRect(x + w1, y, w2, 36); text(label, x + w1 + 11, y + 25, `500 21px ${F.n5}`, C.ink); ctx.restore();
}
function credit(s) {
  if (!s) return; const f = `500 19px ${F.zh5}`; const w = tw(s, f);
  ctx.fillStyle = 'rgba(14,14,12,.5)'; ctx.fillRect(W - 72 - w - 16, 54, w + 16, 30); text(s, W - 80, 75, f, 'rgba(247,245,239,.86)', 'right');
}

// ---------- 字幕卡：中文一行按块砸入，一个黄色关键词；英文一行 ----------
function chunkW(p, size) { let w = 0; for (const q of p.split(/(\{[^}]+\})/).filter(Boolean)) { const hot = q[0] === '{'; w += tw(hot ? q.slice(1, -1) : q, `900 ${size}px ${F.zh9}`) + (hot ? 24 : 0); } return w; }
function capCard(c, t) {
  if (t < c.t0 || t >= c.t1) return;
  const size = CAP.zh, parts = c.zh.split('|'); let cx = CAP.x; const y = CAP.zhY;
  parts.forEach((p, i) => {
    const t0 = c.t0 + i * TLD.chunk, k = seg(t, t0, t0 + .13); if (t < t0) { cx += chunkW(p, size) + size * .05; return; }
    const sc = lerp(1.3, 1, back(k, 1.6));
    ctx.save(); ctx.translate(cx, y); ctx.scale(sc, sc); ctx.globalAlpha = clamp(k * 3 + .25);
    let x = 0;
    for (const q of p.split(/(\{[^}]+\})/).filter(Boolean)) {
      const hot = q[0] === '{', s = hot ? q.slice(1, -1) : q, f = `900 ${size}px ${F.zh9}`, w = tw(s, f);
      const th = c.hotAt ?? t0 + 2 / 30;
      const pk = hot ? (c.hotAt ? eo(seg(t, th, th + .12)) : 1) : 0;   // 延后上色的关键词：黄块擦入时才把字距撑开
      if (hot) { const wk = eo(seg(t, th, th + .12)); ctx.fillStyle = C.honey; ctx.fillRect(x, -size * .9, (w + 24 * pk) * wk, size * 1.1); }
      if (!hot || t < th) { ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 20; ctx.shadowOffsetY = 4; }
      const hotInk = hot && seg(t, th, th + .12) > .5;
      text(s, x + 12 * pk, 0, f, hotInk ? C.bg : C.ink); ctx.shadowColor = 'transparent'; x += w + 24 * pk;
    }
    ctx.restore(); cx += chunkW(p, size) + size * .05;
  });
  const ke = eo(seg(t, c.t0 + .1, c.t0 + .28));
  ctx.save(); ctx.globalAlpha = ke; ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 12;
  text(c.en, CAP.x, CAP.enY + (1 - ke) * 10, `500 ${CAP.en}px ${F.n5}`, C.ink); ctx.restore();
  const full = c.zh.replace(/[|{}]/g, '');
  TX.push({ id: 'zh' + c.t0, text: full, x0: CAP.x - 20, y0: y - 100, x1: CAP.x + 20 + parts.reduce((a, p) => a + chunkW(p, size) + size * .05, 0), y1: y + 30 });
  TX.push({ id: 'en' + c.t0, text: c.en, x0: CAP.x, y0: CAP.enY - 34, x1: CAP.x + tw(c.en, `500 ${CAP.en}px ${F.n5}`), y1: CAP.enY + 10 });
}

// ---------- 纸页：白纸放在暗桌上（220 dpi：1 pt = 3.0556 px），荧光笔按 pdftotext -bbox 坐标 ----------
const PT = 220 / 72;
function paper(t, name, z, fx, fy, sx, sy, rot, marks, ox = 0) {
  const im = img(name);
  ctx.fillStyle = C.desk; ctx.fillRect(0, 0, W, H);
  ctx.save(); ctx.translate(sx + ox, sy); ctx.rotate(rot); ctx.scale(z, z); ctx.translate(-fx * PT, -fy * PT);
  ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 50 / z; ctx.shadowOffsetY = 18 / z;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, im.width, im.height); ctx.shadowColor = 'transparent';
  ctx.filter = 'contrast(1.06) sepia(0.06) brightness(0.93)'; di(im, 0, 0); ctx.filter = 'none';
  for (const m of marks) {   // [start, x0, y0, x1, y1, dur] in pt
    const k = eo(seg(t, m[0], m[0] + (m[5] || .25))); if (k <= 0) continue;
    ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = 'rgba(255,200,30,.9)';
    ctx.fillRect(m[1] * PT - 8, m[2] * PT - 5, (m[3] - m[1]) * PT * k + 16, (m[4] - m[2]) * PT + 10); ctx.globalCompositeOperation = 'source-over';
  }
  const mt = ctx.getTransform();
  ctx.restore(); warm(.04);
  const v = ctx.createRadialGradient(W * .5, H * .42, 320, W * .5, H * .42, 1250); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.58)'); ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
  return (xp, yp) => [mt.a * xp * PT + mt.c * yp * PT + mt.e, mt.b * xp * PT + mt.d * yp * PT + mt.f];
}
function streaks(k) { if (k <= 0 || k >= 1) return; ctx.fillStyle = `rgba(255,194,26,${(1 - k) * .55})`; for (let i = 0; i < 6; i++) ctx.fillRect(W - (1 - k) * 900 - i * 110, 150 + i * 150, 620 * (1 - k), 3); }

// ---------- shots ----------
function shotHook(s, t) {   // 第 4 帧钩子：举起蛤蜊的特写，冲击推近 + 白闪
  const im = img('hook'), s0 = W / im.width;
  const kp = eo(seg(t, H2.hook, H2.hook + .3)), z = lerp(1.0, 1.14, kp) + .02 * seg(t, H2.hook + .3, s.b);
  const c = cam(im, s0 * z, lerp(.5, .46, kp) * im.width, lerp(.5, .40, kp) * im.height); drawCam(im, c); veil();
  const g = ctx.createLinearGradient(0, 0, 1100, 0); g.addColorStop(0, `rgba(14,14,12,${.6 * kp})`); g.addColorStop(1, 'rgba(14,14,12,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, 1100, H);
}
// 第 4 帧数字钩子：80% 黄块落下并 0.45 s 滚到终值，然后单位词“鲍鱼壳”、主语“带砸痕”；1.0 起缩成左上角数据条留到 4.0（8.5 在文件上回读这个数）
const HK = { L: 120, y: 700, nf: 250 };
function hookNum(t) {
  if (t < H2.hook || t >= H2.chipOut) return;
  const out = eio(seg(t, H2.chip, H2.chip + .22));
  if (out < 1) {
    ctx.save(); ctx.globalAlpha = 1 - out; ctx.translate(lerp(0, -260, out), lerp(0, -420, out));
    const k = seg(t, H2.hook, H2.hook + .13), roll = Math.round(80 * eo(seg(t, H2.hook - 1 / 30, H2.hook + .45)));
    const cw = tw('0', `800 ${HK.nf}px ${F.n8}`), wn = cw * 2 + tw('%', `800 ${HK.nf}px ${F.n8}`);
    ctx.save(); ctx.translate(HK.L, HK.y); const sc = lerp(1.45, 1, back(k, 1.4)) * (t >= H2.hook + .45 ? lerp(1.08, 1, eo(seg(t, H2.hook + .45, H2.hook + .6))) : 1); ctx.scale(sc, sc); ctx.globalAlpha *= clamp(k * 3 + .85);   // 第 4 帧就要看得见
    ctx.fillStyle = C.honey; ctx.fillRect(-26, -212, wn + 52, 262);
    num(roll + '%', wn / 2, 0, HK.nf, C.bg, 'center'); ctx.restore();
    const kk = seg(t, H2.hookKicker, H2.hookKicker + .13);
    if (t >= H2.hookKicker) { ctx.save(); ctx.translate(HK.L, HK.y - 250); const s1 = lerp(1.3, 1, back(kk, 1.6)); ctx.scale(s1, s1); ctx.globalAlpha *= clamp(kk * 3 + .25); ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 22; text('鲍鱼壳', 0, 0, `900 96px ${F.zh9}`, C.ink); ctx.restore(); }
    const kw = seg(t, H2.hookWord, H2.hookWord + .13);
    if (t >= H2.hookWord) { ctx.save(); ctx.translate(HK.L + wn + 70, HK.y - 12); const s2 = lerp(1.3, 1, back(kw, 1.6)); ctx.scale(s2, s2); ctx.globalAlpha *= clamp(kw * 3 + .25); ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 22; text('带砸痕', 0, 0, `900 120px ${F.zh9}`, C.ink); ctx.restore(); }
    ctx.restore();
  }
  const kc = eo(seg(t, H2.chip + .08, H2.chip + .28));
  if (kc > 0) {
    ctx.save(); ctx.globalAlpha = kc; const x = 96 - (1 - kc) * 40, y = 108;
    const wn = tw('80%', `800 27px ${F.n8}`) + 22, wl = tw('鲍鱼壳带砸痕', `900 22px ${F.zh9}`) + 22;
    ctx.fillStyle = 'rgba(14,14,12,.55)'; ctx.fillRect(x - 24, 36, Math.max(382, wn + wl) + 48, 124);
    ctx.fillStyle = C.honey; ctx.fillRect(x, y, wn, 38); num('80%', x + 11, y + 29, 27, C.bg);
    ctx.fillStyle = 'rgba(14,14,12,.85)'; ctx.fillRect(x + wn, y, wl, 38); text('鲍鱼壳带砸痕', x + wn + 11, y + 28, `900 22px ${F.zh9}`, C.ink);
    ctx.restore();
  }
  const big = out < .5;
  TX.push({ id: 'hook', text: '80%鲍鱼壳带砸痕', x0: big ? HK.L - 40 : 72, y0: big ? HK.y - 360 : 100, x1: big ? 1200 : 560, y1: big ? HK.y + 60 : 150 });
}
function shotBite(s, t) {   // 用牙咬：缓推 + 微移
  const im = img('bite'), s0 = W / im.width, u = eio(seg(t, s.a, s.b));
  const c = cam(im, s0 * lerp(1.0, 1.06, u), lerp(.47, .52, u) * im.width, lerp(.46, .44, u) * im.height); drawCam(im, c); veil();
}
function shotRaft(s, t) {   // 一群海獭仰面漂着（胸口朝天）：切入冲击推近 + 跟随横摇，照片 ≤ 1:1，三只占画面高度约 45%
  const im = img('raft'), u = eio(seg(t, s.a, s.b)), kp = eo(seg(t, s.a, s.a + .3));
  const z = lerp(.86, .95, kp) + .05 * seg(t, s.a + .3, s.b);
  const c = cam(im, z, lerp(1960, 2200, u), lerp(1960, 1900, u)); drawCam(im, c); veil();
}
// Kenyon 1969 图 45（档案印刷品，≤2.5×）：纸页上推近到胸口，画圈 + “砧板”标签
const FIG = { px: 432, py: 548, r: 122 };   // 胸口上那块石头（图注：a rock resting on his chest）在 300 dpi 页面上的位置
function shotFig(s, t) {
  const im = img('fig45');
  const kp = eo(seg(t, H2.punch, H2.punch + .3));
  const z = lerp(.78, .975, kp) + .012 * seg(t, H2.punch + .3, s.b);          // 页面像素 → 屏幕；.975 ≈ 原始网屏 2.5×
  const px = lerp(820, FIG.px + 160, kp), py = lerp(700, FIG.py + 40, kp);
  const sx = lerp(W * .52, W * .5, kp), sy = lerp(H * .45, H * .44, kp), rot = -.014;
  ctx.fillStyle = C.desk; ctx.fillRect(0, 0, W, H);
  ctx.save(); ctx.translate(sx, sy); ctx.rotate(rot); ctx.scale(z, z); ctx.translate(-px, -py);
  ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 60; ctx.shadowOffsetY = 20; ctx.fillStyle = '#F2EEE4'; ctx.fillRect(0, 0, im.width, im.height); ctx.shadowColor = 'transparent';
  ctx.filter = 'grayscale(1) sepia(0.18) contrast(1.08)'; di(im, 0, 0); ctx.filter = 'none';
  // 画圈（在纸面坐标里画，跟着推近走）
  const kr = seg(t, H2.circle, H2.circle + .3);
  if (kr > 0) { ctx.strokeStyle = C.honey; ctx.lineWidth = 7 / z; ctx.beginPath(); ctx.arc(FIG.px, FIG.py, FIG.r, -Math.PI * .6, -Math.PI * .6 + Math.PI * 2 * eo(kr)); ctx.stroke(); }
  // 标签锚点（屏幕）
  const m = ctx.getTransform(); const ax = m.a * (FIG.px + FIG.r * .72) + m.c * (FIG.py - FIG.r * .72) + m.e, ay = m.b * (FIG.px + FIG.r * .72) + m.d * (FIG.py - FIG.r * .72) + m.f;
  const cxs = m.a * FIG.px + m.c * FIG.py + m.e, cys = m.b * FIG.px + m.d * FIG.py + m.f;
  ctx.restore(); warm(.04);
  const v = ctx.createRadialGradient(W * .5, H * .42, 320, W * .5, H * .42, 1250); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.5)'); ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
  veil();
  // 2× 局部放大插图：同一张图、同一块石头，放大到当前画面比例的 2 倍
  const ki = eo(seg(t, H2.inset, H2.inset + .3));
  if (ki > 0) {
    const B = { x: 1262, y: 290, w: 540, h: 500 }, bx0 = B.x + B.w / 2, by0 = B.y + B.h / 2;
    ctx.save(); ctx.globalAlpha = clamp(ki * 2); ctx.strokeStyle = C.honey; ctx.lineWidth = 4; ctx.setLineDash([10, 8]);
    ctx.beginPath(); ctx.moveTo(cxs + FIG.r * z * .95, cys + 20); ctx.lineTo(lerp(cxs, B.x, ki), lerp(cys, by0, ki)); ctx.stroke(); ctx.restore();
    ctx.save(); ctx.translate(bx0, by0); const sc = lerp(.55, 1, back(ki, 1.3)); ctx.scale(sc, sc); ctx.globalAlpha = clamp(ki * 2);
    ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 40; ctx.fillStyle = '#F2EEE4'; ctx.fillRect(-B.w / 2, -B.h / 2, B.w, B.h); ctx.shadowColor = 'transparent';
    ctx.save(); ctx.beginPath(); ctx.rect(-B.w / 2, -B.h / 2, B.w, B.h); ctx.clip(); ctx.rotate(rot); ctx.scale(z * 2, z * 2); ctx.translate(-FIG.px, -FIG.py + 10);
    ctx.filter = 'grayscale(1) sepia(0.18) contrast(1.12)'; di(im, 0, 0); ctx.filter = 'none';
    ctx.strokeStyle = C.honey; ctx.lineWidth = 6 / (z * 2); ctx.beginPath(); ctx.arc(FIG.px, FIG.py, FIG.r, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    ctx.strokeStyle = C.honey; ctx.lineWidth = 6; ctx.strokeRect(-B.w / 2, -B.h / 2, B.w, B.h);
    ctx.fillStyle = C.honey; ctx.fillRect(B.w / 2 - 92, -B.h / 2, 92, 54); num('2×', B.w / 2 - 46, -B.h / 2 + 41, 34, C.bg, 'center');
    ctx.restore();
    TX.push({ id: 'inset2x', text: '2×', x0: B.x + B.w - 92, y0: B.y, x1: B.x + B.w, y1: B.y + 54 });
  }
  const kl = eo(seg(t, H2.label, H2.label + .2));
  if (kl > 0) {
    const bx = ax + 150, by = ay - 120;
    ctx.save(); ctx.globalAlpha = kl; ctx.strokeStyle = C.honey; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(lerp(ax, bx, kl), lerp(ay, by, kl)); ctx.lineTo(bx + 230 * kl, by); ctx.stroke();
    const sc = lerp(1.3, 1, back(seg(t, H2.label, H2.label + .13))); ctx.translate(bx, by - 14); ctx.scale(sc, sc);
    ctx.fillStyle = C.honey; ctx.fillRect(0, -92, 250, 92); text('石头', 22, -22, `900 70px ${F.zh9}`, C.bg);
    ctx.fillStyle = 'rgba(14,14,12,.82)'; ctx.fillRect(0, 2, 250, 44); text('rock', 14, 34, `800 28px ${F.n8}`, C.honey); text('= anvil', 88, 33, `500 24px ${F.n5}`, C.ink);
    ctx.restore();
    TX.push({ id: 'anvil', text: '石头', x0: bx - 10, y0: by - 120, x1: bx + 270, y1: by + 40 });
  }
}
function shotDoc33(s, t) {   // 文件说了：划线 → 开头那块 80% 飞回来，贴着划线句，引线指过去，9.0 落定盖章
  const kin = eo(seg(t, H2.cardIn, H2.paper)), ox = (1 - kin) * W;
  const z = lerp(1.18, 1.27, eio(seg(t, H2.paper, s.b)));
  const L = 279.6, M = [[H2.mark33[0], 302.2, L, 527.0, 288.6], [H2.mark33[1], 302.1, 292.0, 526.6, 301.0], [H2.mark33[2], 302.1, 303.5, 485.0, 313.5]];
  const P = paper(t, 'doc33', z, 415, 296, W * .41, H * .47, -.012, M, ox);
  streaks(kin); veil();
  const tp = H2.numPop;
  if (t >= tp) {
    const [ax, ay] = P(527.0, 296.5), BX = 1545, BY = ay + 8;           // 引线锚点：划线句右端；黄块与它同高
    const kf = eo(seg(t, tp, tp + .3)), done = t >= H2.stamp, ks = seg(t, H2.stamp, H2.stamp + .15);
    const kl = eio(seg(t, tp + .2, H2.stamp));
    if (kl > 0) { ctx.save(); ctx.strokeStyle = C.honey; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(BX - 230, BY - 55); ctx.lineTo(lerp(BX - 230, ax + 14, kl), lerp(BY - 55, ay, kl)); ctx.stroke();
      if (kl >= 1) { ctx.fillStyle = C.honey; ctx.beginPath(); ctx.arc(ax + 14, ay, 9, 0, Math.PI * 2); ctx.fill(); } ctx.restore(); }
    const x = lerp(150, BX, kf), y = lerp(127, BY, kf), sc0 = lerp(.17, 1, kf);
    ctx.save(); ctx.translate(x, y); ctx.rotate(lerp(0, -.03, kf)); const sc = sc0 * (done ? lerp(1.12, 1, eo(ks)) : 1); ctx.scale(sc, sc);
    ctx.fillStyle = done ? C.honey : 'rgba(14,14,12,.9)'; ctx.fillRect(-230, -150, 460, 190);
    if (!done) { ctx.strokeStyle = C.honey; ctx.lineWidth = 5; ctx.strokeRect(-230, -150, 460, 190); }
    num('80%', 0, 10, 160, done ? C.bg : C.honey, 'center');
    ctx.restore();
    TX.push({ id: 'num80', text: '80%', x0: Math.max(0, x - 240 * sc), y0: Math.max(0, y - 160 * sc), x1: Math.min(W, x + 240 * sc), y1: Math.min(H, y + 50 * sc) });
  }
  sourceTag(t, H2.paper, s.src.replace('美国内政部 ', 'USFWS ').replace('生物报告', 'Biological Report'));
}
// 断奶期母子：加速横移 → 定格 + 问句
const WEAN = { cx: 1300, cy: 440, bw: 1300, bh: 640 };   // 两个头部的框（图像像素）
function shotWean(s, t) {
  const im = img('wean'), s0 = H / im.height, tf = H2.freeze;
  const u = ei(seg(t, s.a, tf)), z0 = lerp(1.0, 1.06, u);
  const kn = eo(seg(t, H2.nudge, H2.nudge + .25));
  const kp = eo(seg(t, tf, tf + .25)), z = t < tf ? z0 : z0 * (lerp(1, 1.12, kp) + .05 * seg(t, tf + .25, s.b) + .04 * kn);
  const px = t < tf ? lerp(.36, .47, u) * im.width : .47 * im.width, py = lerp(.48, .45, t < tf ? u : 1) * im.height;
  const sat = t < tf ? 1 : lerp(1, .45, kp);
  const c = cam(im, s0 * z, lerp(px, WEAN.cx, t < tf ? 0 : kp * .5), py); drawCam(im, c, `${GRADE} saturate(${sat})`); veil();
  if (t >= tf) {
    const kb = eo(seg(t, H2.brackets, H2.brackets + .2));
    const tight = lerp(1, .88, kn), cx = c.X(WEAN.cx), cy = c.Y(WEAN.cy), bw = lerp(WEAN.bw * c.s * 1.25, WEAN.bw * c.s, kb) * tight, bh = lerp(WEAN.bh * c.s * 1.25, WEAN.bh * c.s, kb) * tight, L = 54;
    ctx.save(); ctx.globalAlpha = kb; ctx.strokeStyle = C.honey; ctx.lineWidth = 7;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const x = cx + sx * bw / 2, y = cy + sy * bh / 2; ctx.beginPath(); ctx.moveTo(x, y - sy * L); ctx.lineTo(x, y); ctx.lineTo(x - sx * L, y); ctx.stroke(); }
    ctx.restore();
    ctx.save(); ctx.globalAlpha = kb; ctx.fillStyle = 'rgba(14,14,12,.72)'; ctx.fillRect(W - 300, 100, 220, 44);
    ctx.save(); ctx.globalAlpha *= Math.floor((t - tf) / TLD.beat) % 2 ? .3 : 1; ctx.fillStyle = C.honey; ctx.fillRect(W - 284, 112, 8, 20); ctx.fillRect(W - 270, 112, 8, 20); ctx.restore();
    num('00:11:00', W - 96, 132, 26, C.ink, 'right'); ctx.restore();
  }
  flash(t, tf);
}
function shotDoc35(s, t) {   // 答案也在文件里：女儿的砸法和妈妈一样
  const z = lerp(1.1, 1.2, eio(seg(t, s.a, s.b)));
  const M = [[H2.mark35[0], 307.0, 530.7, 433.8, 539.8], [H2.mark35[1], 347.9, 543.2, 410.1, 552.2]];
  paper(t, 'doc35', z, 370, 535, W * .47, H * .45, .01, M);
  veil(); sourceTag(t, s.a, s.src.replace('美国内政部 ', 'USFWS ').replace('生物报告', 'Biological Report'));
  flash(t, H2.answer);
}
function shotMomPup(s, t) {   // 幼崽躺在妈妈胸口（视频截帧，≤1.5×）
  const im = img('mompup'), s0 = W / im.width, u = eio(seg(t, s.a, s.b));
  const c = cam(im, s0 * lerp(1.0, 1.12, u), lerp(.47, .52, u) * im.width, lerp(.52, .55, u) * im.height); drawCam(im, c); veil();
}
function shotRaftOut(s, t) {   // 结尾：先给中景（1:1，一对海獭占 ~1/3 高），再拉远到整片海獭群，都仰面漂着
  const im = img('raft'), u = eio(seg(t, s.a + .25, s.b - .05)), zmin = Math.max(W / im.width, H / im.height) * 1.002;
  const z = Math.exp(lerp(Math.log(1.0), Math.log(zmin), u));
  const c = cam(im, z, lerp(RO.px, im.width / 2, u), lerp(RO.py, im.height / 2, u)); drawCam(im, c); veil();
}
const RO = { px: 1400, py: 690 };

const DRAW = { hook: shotHook, bite: shotBite, raft: shotRaft, fig: shotFig, doc33: shotDoc33, wean: shotWean, doc35: shotDoc35, mompup: shotMomPup, raftout: shotRaftOut };
const shotAt = t => TLD.shots.find(s => t >= s.a && t < s.b) || TLD.shots[TLD.shots.length - 1];
function draw(t) {
  TX = []; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.filter = 'none'; ctx.globalAlpha = 1;
  let s = shotAt(t);
  // 纸页滑入：从 cardIn 起在上一镜之上滑入（避免空白首帧）
  if (t >= H2.cardIn && t < H2.paper) { shotFig(TLD.shots[3], t); s = TLD.shots[4]; }
  DRAW[s.k](s, t);
  credit(s.cr);
  for (const c of TLD.caps) capCard(c, t);
  hookNum(t);
  bug(t);
}

window.DUR = DUR;
async function render(t) {
  NEED.clear(); draw(t);
  if (NEED.size) { await Promise.all([...NEED].map(load)); NEED.clear(); draw(t); }
}
window.render = render;
window.TEXTS = () => TX;
function buildEV() {
  const ev = [];
  TLD.shots.forEach(s => ev.push({ t: s.a, type: 'cut', k: s.k }));
  TLD.caps.forEach(c => c.zh.split('|').forEach((p, i) => {
    const t0 = +(c.t0 + i * TLD.chunk).toFixed(4); ev.push({ t: t0, type: c.quiet ? 'type' : 'slam' });
    if (p.includes('{')) ev.push({ t: +(c.hotAt ?? t0 + 2 / 30).toFixed(4), type: c.hotAt ? 'nudge' : 'wipe' });
  }));
  ev.push({ t: H2.hook, type: 'hook' }, { t: H2.hook, type: 'rattle', d: .45 }, { t: H2.hookKicker, type: 'slam' }, { t: H2.hookWord, type: 'slam' },
    { t: H2.chip, type: 'fly' }, { t: H2.inset, type: 'inset' }, { t: H2.numPop, type: 'fly' }, { t: H2.bug, type: 'tick' }, { t: H2.punch, type: 'punch' }, { t: H2.circle, type: 'marker', d: .3 }, { t: H2.label, type: 'pop' },
    { t: H2.cardIn, type: 'whoosh' }, { t: H2.paper, type: 'paper' }, ...H2.mark33.map(t => ({ t, type: 'marker', d: .25 })),
    { t: H2.numPop, type: 'pop' }, { t: H2.numPop + .2, type: 'marker', d: H2.stamp - H2.numPop - .2 }, { t: H2.stamp, type: 'stamp' },
    { t: H2.freeze, type: 'shutter' }, { t: H2.brackets, type: 'brackets' }, { t: H2.answer, type: 'answer' }, ...H2.mark35.map(t => ({ t, type: 'marker', d: .25 })),
    { t: H2.pullout, type: 'pullout' });
  return ev.sort((a, b) => a.t - b.t);
}
window.EV = buildEV();
(async () => {
  await Promise.all([[900, 'SC9'], [500, 'SC5'], [800, 'IT8'], [500, 'IT5']].map(([w, f]) => document.fonts.load(`${w} 40px ${f}`)));
  await Promise.all(['hook', 'bite', 'raft', 'fig45', 'doc33', 'doc35', 'wean', 'mompup'].map(n => load(`assets/img/${n}.jpg`)));
  await render(0); window.READY = true;
})();
