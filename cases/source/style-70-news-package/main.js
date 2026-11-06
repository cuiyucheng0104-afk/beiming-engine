// 《本周天气》WX 24 · 电视新闻包装风格样片（示意节目）
// Canvas 2D，确定性 render(t)。所有时间取自 timeline.js（window.TL）。无旁白、无字幕、无滚动字幕；标题条从第一条到结尾始终在。
const { B, K, WIPE, DUR } = window.TL;
const W = 1920, H = 1080;
const cv = document.getElementById('out'); const ctx = cv.getContext('2d');

const C = {
  ink: '#121417', ink2: '#1B1E23', ink3: '#22262C', line: '#454B55',
  lemon: '#F2CF1D', lemonL: '#F8DE4A', lemonD: '#D8B30C', gold: '#D4B064',
  paper: '#F4F1E8', olive: '#6E5A1E', white: '#FFFFFF', grey: '#C9CCD2', grey2: '#7D838D',
};
const F = {
  sc9: s => `900 ${s}px SansSC`, sc7: s => `700 ${s}px SansSC`,
  b8: s => `800 ${s}px Barlow`, b6: s => `600 ${s}px Barlow`, b6i: s => `italic 600 ${s}px Barlow`, mono: s => `500 ${s}px Plex`,
};

// —— 工具 ——
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const seg = (t, a, b) => clamp((t - a) / (b - a));
const lerp = (a, b, k) => a + (b - a) * k;
const eo = x => 1 - Math.pow(1 - x, 3);
const ei = x => x * x * x;
const eio = x => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
const back = (x, s = 1.70158) => 1 + (s + 1) * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2);
function hash(n) { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
// 落点动画：在 [end-d, end] 内 0→1，end 正好是拍点
const land = (t, k, d = .25) => seg(t, B(k) - d, B(k));

const IM = {};
function loadImg(src) { return new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(src); i.src = src; }); }

// —— 文字登记（readcheck 用）——
let TX = [];
function text(s, x, y, font, color, align = 'left', ls = 0, id = null) {
  ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
  ctx.letterSpacing = ls + 'px'; ctx.fillText(s, x, y);
  const w = ctx.measureText(s).width; ctx.letterSpacing = '0px';
  if (id && ctx.globalAlpha > .5) {
    const m = ctx.getTransform(); const x0 = align === 'left' ? x : align === 'right' ? x - w : x - w / 2; const fs = parseInt(font.match(/(\d+)px/)[1]);
    const p0 = m.transformPoint({ x: x0, y: y - fs }), p1 = m.transformPoint({ x: x0 + w, y: y + 8 });
    TX.push({ id, text: s, x0: Math.min(p0.x, p1.x), y0: Math.min(p0.y, p1.y), x1: Math.max(p0.x, p1.x), y1: Math.max(p0.y, p1.y) });
  }
  return w;
}
function tw(s, font, ls = 0) { ctx.font = font; ctx.letterSpacing = ls + 'px'; const w = ctx.measureText(s).width; ctx.letterSpacing = '0px'; return w; }
// 中文 + 英文一行（标签）
function bi(cn, en, x, y, fcn, fen, ccn, cen, gap = 12, id = null) { const w1 = text(cn, x, y, fcn, ccn, 'left', 0, id); return w1 + gap + text(en, x + w1 + gap, y, fen, cen, 'left', 2); }

// —— 画面层：卫星图（统一 duotone 已在 tools/prep.py 完成）——
// 唯一的 world→screen：图像比例坐标 (u,v) → 屏幕。cam = {img, au, av, sx, sy, s, rot}：锚点 (au,av) 落在屏幕 (sx,sy)
function P(cam, u, v) {
  const dx = (u - cam.au) * cam.img.width * cam.s, dy = (v - cam.av) * cam.img.height * cam.s;
  const c = Math.cos(cam.rot), s = Math.sin(cam.rot);
  return [cam.sx + dx * c - dy * s, cam.sy + dx * s + dy * c];
}
function drawPlate(cam) {
  ctx.save(); ctx.translate(cam.sx, cam.sy); ctx.rotate(cam.rot); ctx.scale(cam.s, cam.s);
  ctx.drawImage(cam.img, -cam.au * cam.img.width, -cam.av * cam.img.height); ctx.restore();
}
function eyebrowBox(x, y, w) { ctx.fillStyle = 'rgba(18,20,23,.82)'; ctx.fillRect(x, y - 34, w, 48); ctx.fillStyle = C.gold; ctx.fillRect(x, y - 34, 5, 48); }
function vignette(a = .52) {
  const g = ctx.createRadialGradient(W / 2, H / 2, H * .35, W / 2, H / 2, H * .95);
  g.addColorStop(0, 'rgba(8,9,11,0)'); g.addColorStop(1, `rgba(8,9,11,${a})`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}
const GR = [];
function makeGrain() {
  for (let k = 0; k < 6; k++) {
    const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
    const d = g.createImageData(256, 256);
    for (let i = 0; i < d.data.length; i += 4) { const v = 128 + (hash(i * .37 + k * 9.1) + hash(i * .11 + k) - 1) * 150; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
    g.putImageData(d, 0, 0); GR.push(c);
  }
}
function grain(t, a = .07) {
  const f = Math.floor(t * 24), c = GR[f % GR.length];
  ctx.save(); ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = a;
  const ox = -Math.floor(hash(f) * 256), oy = -Math.floor(hash(f + 7) * 256);
  for (let x = ox; x < W; x += 256) for (let y = oy; y < H; y += 256) ctx.drawImage(c, x, y);
  ctx.restore();
}

// —— 品牌板（片头 = 角标 = 片尾同一个对象）——
function plate(cx, cy, s, glint = -1, drop = [1, 1, 1, 1]) {
  const w = 520 * s, h = 180 * s, k = h * .28;
  ctx.save(); ctx.translate(cx, cy);
  const path = new Path2D(); path.moveTo(-w / 2 + k, -h / 2); path.lineTo(w / 2 + k, -h / 2); path.lineTo(w / 2 - k, h / 2); path.lineTo(-w / 2 - k, h / 2); path.closePath();
  const g = ctx.createLinearGradient(0, -h / 2, 0, h / 2); g.addColorStop(0, C.lemonL); g.addColorStop(1, C.lemonD);
  ctx.fillStyle = g; ctx.fill(path);
  ctx.save(); ctx.clip(path);
  const gx = -w / 2 - k;
  ctx.fillStyle = C.ink; ctx.beginPath(); ctx.moveTo(gx + 2 * k, -h / 2); ctx.lineTo(gx + 2 * k + w * .085, -h / 2); ctx.lineTo(gx + w * .085, h / 2); ctx.lineTo(gx, h / 2); ctx.fill();
  ctx.fillStyle = C.gold; ctx.beginPath(); ctx.moveTo(gx + 2 * k + w * .085, -h / 2); ctx.lineTo(gx + 2 * k + w * .11, -h / 2); ctx.lineTo(gx + w * .11, h / 2); ctx.lineTo(gx + w * .085, h / 2); ctx.fill();
  ctx.font = F.b8(h * .8); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.letterSpacing = '0px';
  let x = -w * .24;
  ['W', 'X', '2', '4'].forEach((L, i) => {
    const d = drop[i]; const yy = h * .29 + (1 - eo(d)) * -h * 1.1;
    if (d > 0) { ctx.save(); ctx.globalAlpha *= clamp(d * 3); ctx.fillStyle = C.ink; ctx.fillText(L, x, yy); ctx.restore(); }
    x += ctx.measureText(L).width + (i === 1 ? h * .1 : -h * .01);
  });
  if (glint >= 0 && glint <= 1) {
    const gx2 = lerp(-w, w, glint); const gg = ctx.createLinearGradient(gx2 - 80 * s, 0, gx2 + 80 * s, 0);
    gg.addColorStop(0, 'rgba(255,255,255,0)'); gg.addColorStop(.5, 'rgba(255,255,255,.65)'); gg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gg; ctx.fillRect(-w, -h, w * 2, h * 2);
  }
  ctx.restore(); ctx.restore();
}
function bug(t) {
  if (t < B(K.bugLand)) return;
  const gl = seg(t, B(K.end) - .1, B(K.end) + .35);
  ctx.globalAlpha = .96; plate(1739, 86, .327, gl > 0 && gl < 1 ? gl : -1);
  text('WEATHER', 1652, 96, F.b8(26), C.white, 'right', 3); ctx.globalAlpha = 1;
}

// ============ 包装层：标题条 / 来源行 / 角标（每个画面各画各的，随画面走）============
const STRAP = [
  { a: B(K.wipeTyphoon), fa: B(K.strapIn), tab: ['台风', 'TYPHOON'], cn: '超强台风 GONI 增强至 5 级', en: 'SUPER TYPHOON GONI REACHES CATEGORY 5' },
  { a: B(K.cutCold), tab: ['寒潮', 'COLD WAVE'], cn: '冷空气过海 云街绵延逾 644 公里', en: 'COLD AIR STREAMS OVER THE SEA OF JAPAN' },
  { a: B(K.cutAurora), tab: ['极光', 'AURORA'], cn: '国际空间站俯瞰绿红极光', en: 'GREEN AND RED AURORA SEEN FROM THE ISS' },
  { a: B(K.wipeBoard), tab: ['寒潮 · 续', 'COLD WAVE · FOLLOW-UP'], cn: '寒潮后续 前后气温翻牌（示意）', en: 'COLD SNAP FOLLOW-UP · BEFORE AND AFTER · SCHEMATIC' },
];
function strapWords(S, x0, by, bw, bh, dy, alpha, idOn) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(0, dy);
  text(S.cn, x0 + 44, by + 58, F.sc9(50), C.ink, 'left', 0, idOn ? 'strap' : null);
  text(S.en, x0 + 46, by + 92, F.b6(27), C.olive, 'left', 1.5, idOn ? 'strape' : null);
  ctx.restore();
}
function strap(t) {
  if (t < STRAP[0].a) return;
  let i = 0; for (let j = 0; j < STRAP.length; j++) if (t >= STRAP[j].a - (STRAP[j].flip ? .32 : 0)) i = j;
  const S = STRAP[i];
  const x0 = 96, ty = 856, by = 904, bh = 104, bw = 1250;
  const ent = 1;   // 标题条随台风画面一起被色带擦入（包装层跟着画面走），k13.5 分类标签闪白
  ctx.save();
  const vw = bw * ent;
  ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(x0 + 8, by + 8, vw, bh);
  ctx.fillStyle = C.paper; ctx.fillRect(x0, by, vw, bh);
  ctx.fillStyle = C.lemon; ctx.fillRect(x0, by, 14, bh);
  if (ent > .98) {
    ctx.fillStyle = C.ink; ctx.fillRect(x0 + bw, by, 120, bh); ctx.fillStyle = C.lemon; ctx.fillRect(x0 + bw, by, 120, 6);
    text('WX24', x0 + bw + 60, by + 68, F.b8(40), C.lemon, 'center', 1);
  }
  ctx.save(); ctx.beginPath(); ctx.rect(x0 + 14, by, vw - 14, bh); ctx.clip();
  if (S.flip && t < S.a) {             // 竖向翻字：新词从下方上来，旧词向上离开，0.32 s，落在拍点
    const p = eio(seg(t, S.a - .32, S.a));
    strapWords(STRAP[i - 1], x0, by, bw, bh, -p * bh, 1 - p * .6, p < .5);
    strapWords(S, x0, by, bw, bh, (1 - p) * bh, 1, p >= .5);
  } else strapWords(S, x0, by, bw, bh, 0, 1, true);
  ctx.restore();
  // 分类标签：换类别时闪白
  const tab = (S.flip && t < S.a) ? STRAP[i - 1].tab : S.tab;
  const tabW = 40 + tw(tab[0], F.sc9(30)) + 14 + tw(tab[1], F.b8(30), 2);
  const fa = S.fa ?? S.a, fl = t < fa ? 0 : 1 - seg(t, fa, fa + .18);
  ctx.fillStyle = C.lemon; ctx.fillRect(x0, ty, tabW * clamp(ent * 1.4), by - ty);
  if (fl > 0 && fl < 1) { ctx.fillStyle = `rgba(255,255,255,${fl})`; ctx.fillRect(x0, ty, tabW, by - ty); }
  if (ent > .7) { const w1 = text(tab[0], x0 + 20, ty + 37, F.sc9(30), C.ink, 'left', 0, 'tab'); text(tab[1], x0 + 20 + w1 + 14, ty + 37, F.b8(30), C.ink, 'left', 2); }
  ctx.restore();
}
function source(lines) {
  if (!lines) return;
  ctx.save(); ctx.globalAlpha = .75; text(lines[0], 1836, 950, F.mono(13), C.paper, 'right', .5); text(lines[1], 1836, 978, F.sc7(16), C.paper, 'right', .5); ctx.restore();
}
function cornerTag(tag, t, a, wiped) {
  if (!tag) return;
  const k = wiped ? 1 : eo(seg(t, a, a + .2));           // 硬切：0.2 s 竖向翻入；擦入：随画面一起被色带带进来
  if (k <= 0) return;
  const x = 96, y = 56, h = 64, w = 330;
  ctx.save(); ctx.translate(0, y + h / 2); ctx.scale(1, k); ctx.translate(0, -(y + h / 2));
  ctx.fillStyle = 'rgba(18,20,23,.84)'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = C.gold; ctx.fillRect(x, y, 8, h);
  text(tag[0], x + 26, y + 27, F.mono(17), C.gold, 'left', 2, 'tag');
  text(tag[1], x + 26, y + 54, F.sc7(20), C.white, 'left', 0, 'tagc');
  ctx.restore();
}

// ============ 背景 ============
function studioBg(t) {
  ctx.fillStyle = C.ink; ctx.fillRect(0, 0, W, H);
  const rg = ctx.createRadialGradient(1300, 380, 60, 1300, 380, 1100); rg.addColorStop(0, 'rgba(242,207,29,.14)'); rg.addColorStop(1, 'rgba(242,207,29,0)');
  ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 7; i++) {
    const x = ((i * 380 + t * (30 + i * 6)) % 2600) - 400, w = 40 + hash(i) * 120;
    ctx.fillStyle = `rgba(242,207,29,${.022 + hash(i + 9) * .032})`;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + w, 0); ctx.lineTo(x + w - 500, H); ctx.lineTo(x - 500, H); ctx.fill();
  }
  ctx.fillStyle = 'rgba(244,241,232,.05)';
  for (let x = 40 - (t * 12) % 48; x < W; x += 48) for (let y = 24; y < H; y += 48) ctx.fillRect(x, y, 2, 2);
}

// ============ 1 片头 sting ============
function shotSting(t) {
  studioBg(t);
  [[0, .26, 22, -60], [.06, .32, 8, 40]].forEach(([a, b, h, dy]) => {
    const k = seg(t, a, b); if (k <= 0 || k >= 1) return;
    ctx.save(); ctx.translate(960, 440 + dy); ctx.rotate(-.14);
    const x = lerp(-1250, 1900, eio(k)); ctx.fillStyle = C.lemon; ctx.fillRect(x - 700, -h / 2, 1400, h); ctx.restore();
  });
  // 字标与日期行（从中线展开，落在 k2）
  const wa = land(t, K.wordmark, .25), wo = 1;   // 字标留到色带把它擦走
  if (wa > 0 && wo > 0) {
    ctx.save(); ctx.globalAlpha = wo; ctx.beginPath(); ctx.rect(960 - 620 * eo(wa), 600, 1240 * eo(wa), 200); ctx.clip();
    const w1 = tw('本周天气', F.sc9(76)), w2 = tw("THIS WEEK'S WEATHER", F.b6i(40), 2), x0 = 960 - (w1 + 26 + w2) / 2;
    text('本周天气', x0, 690, F.sc9(76), C.white, 'left', 0, 'wm'); text("THIS WEEK'S WEATHER", x0 + w1 + 26, 688, F.b6i(40), C.lemon, 'left', 2);
    text('WX 24 · WEEK 44 · SAMPLE BULLETIN · 示意节目', 960, 748, F.mono(22), C.gold, 'center', 3);
    ctx.restore();
  }
}
function stingPlate(t) {
  if (t >= B(K.bugLand)) return;
  const tl = B(K.slam), p = seg(t, .09, tl);
  if (p <= 0) return;
  const fly = eio(seg(t, B(K.fly), B(K.bugLand)));
  const after = Math.max(0, t - tl);
  const bounce = t > tl ? 1 - .07 * Math.exp(-after * 9) * Math.cos(after * 38) : 1;
  const s0 = 1.45 * lerp(2.4, 1, p * p) * bounce;
  const shake = t > tl && t < tl + .32 ? 16 * (1 - seg(t, tl, tl + .32)) : 0;
  const cx = lerp(960, 1739, fly) + Math.sin(t * 90) * shake, cy = lerp(440, 86, fly) + Math.cos(t * 77) * shake * .6;
  const s = lerp(s0, .327, fly);
  const drop = K.letters.map(k => land(t, k, .12));
  ctx.save(); ctx.translate(cx, cy); ctx.rotate((1 - p) * -.14 * (1 - fly)); ctx.translate(-cx, -cy);
  ctx.globalAlpha = clamp(p * 4);
  const g = seg(t, B(K.glint) - .2, B(K.glint) + .1);
  plate(cx, cy, s, g > 0 && g < 1 ? g : -1, drop);
  ctx.restore();
  const r = seg(t, tl, tl + .4);
  if (r > 0 && r < 1) { ctx.strokeStyle = `rgba(242,207,29,${1 - r})`; ctx.lineWidth = 8 * (1 - r) + 1; ctx.beginPath(); ctx.ellipse(960, 440, 380 + r * 760, 140 + r * 320, 0, 0, Math.PI * 2); ctx.stroke(); }
}

// ============ 2 串联单（开场 / 回顾两次用同一个对象）============
const ROWS = [
  ['01', ['台风', 'TYPHOON'], '超强台风 GONI 增强至 5 级', 'SUPER TYPHOON GONI · CATEGORY 5', '2020-10-30'],
  ['02', ['寒潮', 'COLD WAVE'], '冷空气过海 云街逾 644 公里', 'COLD AIR SPAWNS CLOUD STREETS', '2021-12-22'],
  ['03', ['极光', 'AURORA'], '空间站俯瞰绿红极光', 'AURORA SEEN FROM THE ISS', '2024-11-09'],
];
function tickMark(cx, cy, k) {
  const s = back(k, 2.6);
  ctx.save(); ctx.translate(cx, cy); ctx.scale(s, s);
  ctx.fillStyle = C.lemon; ctx.beginPath(); ctx.arc(0, 0, 30, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = C.ink; ctx.lineWidth = 7; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(-13, 1); ctx.lineTo(-3, 11); ctx.lineTo(15, -10); ctx.stroke(); ctx.restore();
}
// mode: 'open' | 'r1'（第一行打勾）| 'r2'（第三行打勾、第二行 NEXT）
function rundown(t, mode) {
  studioBg(t);
  const open = mode === 'open';
  const a0 = open ? B(K.wipeRundown) - WIPE : mode === 'r1' ? B(K.wipeRecap1) - WIPE : B(K.wipeRecap2) - WIPE;
  const zs = open ? lerp(1.0, 1.06, eio(seg(t, a0, B(K.wipeTyphoon)))) : lerp(1.035, 1.0, eo(seg(t, a0, a0 + 1.2)));
  ctx.save(); ctx.translate(960, 470); ctx.scale(zs, zs); ctx.translate(-960, -470);
  const m = (a, b) => open ? eo(seg(t, a, b)) : 1;
  // 左栏：日期块（在色带下就开始进场）
  const x = 120, ta = m(a0, a0 + .25);
  const tabTxt = ['本周天气', 'THIS WEEK'];
  const tabW = 40 + tw(tabTxt[0], F.sc9(30)) + 14 + tw(tabTxt[1], F.b8(30), 2);
  ctx.fillStyle = C.lemon; ctx.fillRect(x, 200, tabW * ta, 50);
  if (ta > .9) { const w1 = text(tabTxt[0], x + 20, 238, F.sc9(30), C.ink, 'left', 0, 'rtab'); text(tabTxt[1], x + 20 + w1 + 14, 238, F.b8(30), C.ink, 'left', 2); }
  const r = (y, h, k, fn) => { if (k <= 0) return; ctx.save(); ctx.beginPath(); ctx.rect(0, y - h, 760, h + 30); ctx.clip(); ctx.translate(0, (1 - k) * (h + 30)); fn(); ctx.restore(); };
  // 周数：k10 计数落定
  const wkN = open ? Math.round(lerp(38, 44, eo(seg(t, B(K.wk) - .4, B(K.wk))))) : 44;
  r(470, 200, m(a0 + .1, a0 + .4), () => text(String(wkN), x - 8, 470, F.b8(230), C.white, 'left', 2, wkN === 44 ? 'rwk' : null));
  r(400, 80, m(a0 + .2, a0 + .5), () => text('WEEK', x + 270, 400, F.b8(84), C.lemon, 'left', 4, 'rwkl'));
  r(470, 60, m(a0 + .25, a0 + .55), () => text('2026', x + 270, 470, F.b8(64), C.grey, 'left', 4));
  ctx.globalAlpha = m(a0 + .4, a0 + .7); text('第 44 周 · 示意节目 SAMPLE', x, 528, F.mono(22), C.gold, 'left', 3, 'rsub'); ctx.globalAlpha = 1;
  r(626, 64, m(a0 + .5, a0 + .8), () => text('本周三条天气', x, 626, F.sc9(56), C.white, 'left', 2, 'rtt'));
  ctx.globalAlpha = m(a0 + .6, a0 + .9); text('3 STORIES · FILE IMAGERY FROM NASA', x + 2, 668, F.b6(26), C.grey, 'left', 3); ctx.globalAlpha = 1;
  // 右栏：三行
  const X0 = 780, RW = 1044, RH = 140;
  ROWS.forEach(([n, cat, cn, en, d], i) => {
    const y = 230 + i * 160;
    const k = open ? land(t, K.rows[i], .25) : 1; if (k <= 0) return;
    const sy = open ? back(k, 2.0) : 1;
    let al = 1;
    if (open) al = 1 - .42 * eo(seg(t, B(K.dim) - .2, B(K.dim))) * (i > 0 ? 1 : 0);
    if (mode === 'r2') al = i === 0 ? .6 : 1 - .4 * eo(seg(t, B(K.next2) - .2, B(K.next2)));   // 追加条进来时，已播三行压暗
    ctx.save(); ctx.globalAlpha = al; ctx.translate(0, y); ctx.scale(1, Math.max(.02, sy)); ctx.translate(0, -y);
    ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(X0 + 10, y + 10, RW, RH);
    ctx.fillStyle = C.ink2; ctx.fillRect(X0, y, RW, RH);
    ctx.fillStyle = C.lemon; ctx.fillRect(X0, y, 130, RH);
    text(n, X0 + 65, y + 100, F.b8(84), C.ink, 'center', 0);
    // 分类标签
    const cw = 24 + tw(cat[0], F.sc9(22)) + 10 + tw(cat[1], F.b8(22), 2);
    ctx.strokeStyle = C.gold; ctx.lineWidth = 2; ctx.strokeRect(X0 + 160, y + 18, cw, 36);
    bi(cat[0], cat[1], X0 + 172, y + 44, F.sc9(22), F.b8(22), C.gold, C.gold, 10);
    text(d, X0 + RW - 26, y + 44, F.mono(18), C.grey2, 'right', 2);
    text(cn, X0 + 160, y + 100, F.sc9(38), C.white, 'left', 0, 'row' + i);
    text(en, X0 + 162, y + 128, F.b6(21), C.gold, 'left', 1.5);
    const sw = open ? seg(t, B(K.rows[i]), B(K.rows[i]) + .4) : 0;
    if (sw > 0 && sw < 1) { const gx = X0 + 130 + (RW - 130) * eio(sw); const g = ctx.createLinearGradient(gx - 160, 0, gx, 0); g.addColorStop(0, 'rgba(242,207,29,0)'); g.addColorStop(1, 'rgba(242,207,29,.28)'); ctx.fillStyle = g; ctx.fillRect(Math.max(X0 + 130, gx - 160), y, Math.min(160, gx - X0 - 130), RH); }
    // 打勾
    const tk = i === 0 && mode !== 'open' ? (mode === 'r1' ? land(t, K.tick1, .16) : 1) : i > 0 && mode === 'r2' ? land(t, K.tick3, .16) : 0;
    if (tk > 0) tickMark(X0 + RW - 70, y + 92, tk);
    ctx.restore();
  });
  // NEXT 框：开场在第一行（k9 框出，k11 NEXT 标签），回顾在第二行（k30）
  const nxt = (row, kf, kl) => {
    const y = 230 + row * 160, hl = land(t, kf, .2);
    if (hl <= 0) return;
    ctx.save(); ctx.strokeStyle = C.lemon; ctx.lineWidth = 5; ctx.globalAlpha = .65 + .35 * Math.cos((t - B(kf)) * Math.PI * 4);
    ctx.strokeRect(X0 - 5, y - 5, (RW + 10) * eo(hl), RH + 10); ctx.restore();
    const nl = land(t, kl, .16);
    if (nl > 0) {
      const s = back(nl, 2.4); ctx.save(); ctx.translate(X0 + RW - 100, y - 4); ctx.scale(s, s);
      ctx.fillStyle = C.lemon; ctx.fillRect(-92, -20, 184, 40);
      bi('下一条', 'NEXT', -80, 10, F.sc9(22), F.b8(24), C.ink, C.ink, 8); ctx.restore();
    }
  };
  if (open) nxt(0, K.hl, K.next1);
  if (mode === 'r2') insertRow(t, X0, RW);
  ctx.restore();
}

// 回顾时串联单插入的追加条：寒潮后续（k30 翻入 + NEXT）
function insertRow(t, X0, RW) {
  const k = land(t, K.next2, .22); if (k <= 0) return;
  const y = 712, RH = 96, sy = back(k, 2.0);
  ctx.save(); ctx.translate(0, y); ctx.scale(1, Math.max(.02, sy)); ctx.translate(0, -y);
  ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(X0 + 10, y + 10, RW, RH);
  ctx.fillStyle = C.ink2; ctx.fillRect(X0, y, RW, RH);
  ctx.fillStyle = C.gold; ctx.fillRect(X0, y, 130, RH);
  text('02+', X0 + 65, y + 66, F.b8(56), C.ink, 'center', 0);
  const cw = 24 + tw('追加', F.sc9(22)) + 10 + tw('UPDATE', F.b8(22), 2);
  ctx.fillStyle = C.lemon; ctx.fillRect(X0 + 160, y + 14, cw, 32);
  bi('追加', 'UPDATE', X0 + 172, y + 38, F.sc9(22), F.b8(22), C.ink, C.ink, 10);
  text('寒潮后续 · 前后气温（示意）', X0 + 160 + cw + 20, y + 42, F.sc9(30), C.white, 'left', 0, 'row3');
  text('COLD WAVE FOLLOW-UP · BEFORE / AFTER', X0 + 162, y + 82, F.b6(21), C.gold, 'left', 1.5);
  ctx.restore();
  // NEXT 框 + 标签（与开场第一行同一个对象）
  ctx.save(); ctx.strokeStyle = C.lemon; ctx.lineWidth = 5; ctx.globalAlpha = .65 + .35 * Math.cos((t - B(K.next2)) * Math.PI * 4);
  ctx.strokeRect(X0 - 5, y - 5, (RW + 10) * eo(k), RH + 10); ctx.restore();
  const s = back(k, 2.4); ctx.save(); ctx.translate(X0 + RW - 110, y + RH / 2); ctx.scale(s, s);
  ctx.fillStyle = C.lemon; ctx.fillRect(-92, -20, 184, 40);
  bi('下一条', 'NEXT', -80, 10, F.sc9(22), F.b8(24), C.ink, C.ink, 8); ctx.restore();
}

// ============ 3 台风卫星图 ============
const TY = { au: .30, av: .57 };
function camTyphoon(t) {
  const a = B(K.wipeTyphoon) - WIPE, b = B(K.cutSpec), k = eio(seg(t, a, b));
  return { img: IM.goni, au: TY.au, av: TY.av, sx: lerp(700, 740, k), sy: lerp(480, 455, k), s: lerp(.70, .96, k), rot: lerp(-.026, 0, k) };
}
function shotTyphoon(t) {
  ctx.fillStyle = C.ink; ctx.fillRect(0, 0, W, H);
  const cam = camTyphoon(t); drawPlate(cam);
  const g = ctx.createLinearGradient(W, 0, 700, 0); g.addColorStop(0, 'rgba(14,16,19,.9)'); g.addColorStop(.6, 'rgba(14,16,19,.5)'); g.addColorStop(1, 'rgba(14,16,19,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  vignette(.52); grain(t);
  // 环流中心：声纳圈 + 十字，跟着 world→screen 走
  const [ex, ey] = P(cam, TY.au, TY.av);
  const sn = seg(t, B(K.sonar) - .12, B(K.sonar));
  if (sn > 0) {
    ctx.save(); ctx.strokeStyle = C.lemon; ctx.lineWidth = 3;
    const c = 60 * eo(sn);
    ctx.beginPath(); ctx.moveTo(ex - c - 26, ey); ctx.lineTo(ex - 26, ey); ctx.moveTo(ex + 26, ey); ctx.lineTo(ex + c + 26, ey);
    ctx.moveTo(ex, ey - c - 26); ctx.lineTo(ex, ey - 26); ctx.moveTo(ex, ey + 26); ctx.lineTo(ex, ey + c + 26); ctx.stroke();
    ctx.beginPath(); ctx.arc(ex, ey, 26, 0, Math.PI * 2); ctx.stroke();
    for (let j = 0; j < 3; j++) { const r = seg(t, B(K.sonar) + j * .22, B(K.sonar) + j * .22 + .9); if (r > 0 && r < 1) { ctx.globalAlpha = 1 - r; ctx.beginPath(); ctx.arc(ex, ey, 30 + r * 300, 0, Math.PI * 2); ctx.stroke(); } }
    ctx.globalAlpha = eo(sn);
    ctx.fillStyle = 'rgba(18,20,23,.8)'; ctx.fillRect(ex + 44, ey - 92, 238, 40);
    bi('环流中心', 'CENTRE', ex + 56, ey - 63, F.sc7(22), F.mono(18), C.white, C.lemon, 10, 'eye');
    ctx.restore();
  }
  // 右侧大字
  const x = 1150;
  const ey0 = B(K.eyebrow), full = 'NASA AQUA · MODIS · 2020-10-30';
  const n = Math.floor(seg(t, ey0 - .25, ey0) * full.length);
  if (n > 0) text(full.slice(0, n), x, 300, F.mono(24), C.gold, 'left', 3, n === full.length ? 'tye' : null);
  const k1 = land(t, K.name, .25);
  if (k1 > 0) {
    ctx.save(); ctx.beginPath(); ctx.rect(x - 10, 320, 800, 330); ctx.clip();
    const dy = (1 - eo(k1)) * 330;
    text('超强台风', x, 400 + dy, F.sc9(64), C.white, 'left', 4, 'tyc');
    text('GONI', x - 8, 610 + dy, F.b8(250), C.white, 'left', 6, 'tyn');
    ctx.restore();
  }
  ctx.globalAlpha = land(t, K.name + .5, .2); text('SUPER TYPHOON · PHILIPPINE SEA', x, 668, F.b6(32), C.lemon, 'left', 3); ctx.globalAlpha = 1;
}

// ============ 4 规格卡 ============
const SS = [[1, 119], [2, 154], [3, 178], [4, 209], [5, 252]];   // 萨菲尔-辛普森各级下限 km/h（NOAA NHC）
function shotSpec(t) {
  studioBg(t);
  const a = B(K.cutSpec), b = B(K.wipeRecap1);
  const k = eio(seg(t, a, b));
  ctx.save(); ctx.translate(lerp(110, -90, k), 0);                       // 横移跟拍
  const zs = lerp(1.0, 1.035, k); ctx.translate(960, 460); ctx.scale(zs, zs); ctx.translate(-960, -460);
  const x0 = 150;
  text('NASA GSFC · 2020-10-30 · 15:00 UTC', x0, 196, F.mono(22), C.gold, 'left', 3, 'sp0');
  const kt = land(t, K.title, .25);
  ctx.save(); ctx.beginPath(); ctx.rect(x0 - 10, 210, 1100, 150); ctx.clip();
  const dy = (1 - eo(kt)) * 150;
  if (kt > 0) { const w1 = text('1 分钟持续风速', x0, 290 + dy, F.sc9(72), C.white, 'left', 2, 'sp1'); text('1-MIN SUSTAINED WIND', x0 + w1 + 28, 288 + dy, F.b6(34), C.gold, 'left', 3); }
  ctx.restore();
  // 比例条：同一刻度 0–300 km/h → 1000 px
  const SC = v => x0 + v / 300 * 1000;
  ctx.globalAlpha = .55; ctx.fillStyle = C.line;
  [0, 100, 200, 300].forEach(v => { ctx.fillRect(SC(v), 690, 2, 14); text(String(v), SC(v), 730, F.mono(16), C.grey, 'center', 1); });
  ctx.fillRect(x0, 690, 1000, 2); text('KM/H', SC(300) + 40, 730, F.mono(16), C.grey, 'left', 1); ctx.globalAlpha = 1;
  // A：GONI 290
  const ga = eo(seg(t, B(K.title), B(K.bar)));
  bi('GONI 超强台风', 'GONI', x0, 418, F.sc7(26), F.b8(26), C.white, C.grey, 12);
  ctx.fillStyle = C.ink3; ctx.fillRect(x0, 430, 1000, 96);
  ctx.fillStyle = C.lemon; ctx.fillRect(x0, 430, (SC(290) - x0) * ga, 96);
  const v = Math.round(290 * ga);
  const gs = seg(t, B(K.chip) - .05, B(K.chip) + .35);   // k22：290 条扫光
  if (gs > 0 && gs < 1) { const gx = x0 + (SC(290) - x0) * eio(gs); const gg = ctx.createLinearGradient(gx - 140, 0, gx + 20, 0); gg.addColorStop(0, 'rgba(255,255,255,0)'); gg.addColorStop(1, 'rgba(255,255,255,.55)'); ctx.fillStyle = gg; ctx.fillRect(Math.max(x0, gx - 140), 430, Math.min(160, gx - x0), 96); }
  if (ga > .05) { const vx = Math.max(x0 + 200, SC(290 * ga) - 22); const w2 = tw(' km/h', F.b6(30)); text(String(v), vx - w2, 506, F.b8(80), C.ink, 'right', 1, ga >= 1 ? 'sp2' : null); text(' km/h', vx, 504, F.b6(30), C.ink, 'right'); }
  // B：5 级下限 252
  const gb = eo(seg(t, B(K.title), B(K.thr)));
  bi('5 级下限', 'CAT 5 THRESHOLD', x0, 586, F.sc7(26), F.b8(26), C.white, C.grey, 12);
  ctx.fillStyle = C.ink3; ctx.fillRect(x0, 598, 1000, 64);
  ctx.fillStyle = C.paper; ctx.fillRect(x0, 598, (SC(252) - x0) * gb, 64);
  if (gb > .3) text(String(Math.round(252 * gb)), SC(252 * gb) - 18, 647, F.b8(48), C.ink, 'right', 1, gb >= 1 ? 'sp3' : null);
  // 门槛虚线（金）
  const th = land(t, K.thr, .25);
  if (th > 0) { ctx.save(); ctx.strokeStyle = C.gold; ctx.lineWidth = 4; ctx.setLineDash([12, 9]); ctx.beginPath(); ctx.moveTo(SC(252), 392); ctx.lineTo(SC(252), 392 + 300 * eo(th)); ctx.stroke(); ctx.restore(); }
  // +15% 徽章
  const bd = land(t, K.badge, .16);
  if (bd > 0) {
    const s = back(bd, 2.2); ctx.save(); ctx.translate(SC(271), 370); ctx.scale(s, s);
    ctx.fillStyle = C.gold; ctx.fillRect(-88, -52, 176, 62);
    text('+15%', 0, -6, F.b8(52), C.ink, 'center', 1, 'sp4'); ctx.restore();
    ctx.globalAlpha = eo(bd); bi('高于 5 级下限', 'ABOVE CAT 5', SC(271) - 380, 362, F.sc7(24), F.b8(24), C.gold, C.gold, 10); ctx.globalAlpha = 1;
  }
  // 右组：萨菲尔-辛普森五格逐格点亮，括号到总值
  const rx = 1300;
  bi('萨菲尔-辛普森风级', 'SAFFIR-SIMPSON', rx, 396, F.sc7(26), F.b8(24), C.white, C.grey, 12);
  SS.forEach(([c, lo], i) => {
    const cx = rx + i * 100, kk = i < 4 ? land(t, K.cells[i], .1) : land(t, K.stamp1, .1);
    ctx.fillStyle = C.ink3; ctx.fillRect(cx, 430, 88, 140);
    if (kk > 0) { ctx.fillStyle = i === 4 ? C.lemon : C.lemonD; ctx.globalAlpha = .55 + .45 * (i / 4); ctx.fillRect(cx, 430 + 140 * (1 - eo(kk)), 88, 140 * eo(kk)); ctx.globalAlpha = 1; }
    text(String(c), cx + 44, 530, F.b8(76), kk > .5 ? C.ink : C.grey2, 'center');
    text(lo + '+', cx + 44, 600, F.mono(16), C.grey, 'center', 1);
  });
  const br = land(t, K.stamp1, .2);
  if (br > 0) {
    ctx.save(); ctx.strokeStyle = C.lemon; ctx.lineWidth = 4; const w = 488 * eo(br);
    ctx.beginPath(); ctx.moveTo(rx, 618); ctx.lineTo(rx, 634); ctx.lineTo(rx + w, 634); ctx.lineTo(rx + w, 618); ctx.moveTo(rx + 244, 634); ctx.lineTo(rx + 244, 650); ctx.stroke(); ctx.restore();
    ctx.globalAlpha = eo(br); bi('最高一级', '≥ 252 KM/H', rx + 150, 690, F.sc9(30), F.b8(32), C.white, C.lemon, 12, 'sp5'); ctx.globalAlpha = 1;
  }
  // 情境标签
  const ch = land(t, K.chipIn, .2);
  if (ch > 0) {
    ctx.save(); ctx.translate((1 - eo(ch)) * 140, 0); ctx.globalAlpha = eo(ch);
    ctx.fillStyle = C.ink2; ctx.fillRect(rx, 740, 500, 60); ctx.fillStyle = C.gold; ctx.fillRect(rx, 740, 8, 60);
    bi('2020 年最强风暴', 'STRONGEST OF 2020', rx + 26, 780, F.sc9(26), F.b8(24), C.white, C.gold, 12, 'sp6'); ctx.restore();
  }
  // 中心气压（k21.5 遮罩推上，推的同时 1013 → 905 计数）
  const pr = land(t, K.press, .3);
  if (pr > 0) {
    const py = 764, ph = 58, pw = 1000;
    ctx.save(); ctx.beginPath(); ctx.rect(x0 - 4, py - 4, pw + 8, ph + 8); ctx.clip(); ctx.translate(0, (1 - eo(pr)) * (ph + 8));
    ctx.fillStyle = C.ink2; ctx.fillRect(x0, py, pw, ph); ctx.fillStyle = C.gold; ctx.fillRect(x0, py, 8, ph);
    const w1 = bi('最低中心气压', 'MIN. CENTRAL PRESSURE', x0 + 26, py + 40, F.sc7(26), F.b8(24), C.white, C.grey, 12, 'sp7');
    const pv = Math.round(lerp(1013, 905, eo(pr)));
    const wv = text(String(pv), x0 + 26 + w1 + 30, py + 48, F.b8(56), C.lemon, 'left', 1, pr >= 1 ? 'sp8' : null);
    text('hPa', x0 + 26 + w1 + 30 + wv + 10, py + 46, F.b6(28), C.lemon, 'left', 1);
    text('JMA · 生命史最低', x0 + pw - 22, py + 38, F.sc7(20), C.grey, 'right', 0);
    ctx.restore();
  }
  // 印章：5 级（从 1.9× 落下 0.16 s + 扩散椭圆）
  const st = land(t, K.stamp1, .16);
  if (st > 0) stamp(1560, 280, ['5 级', 'CAT 5'], st, t - B(K.stamp1), -.13, 'ink');
  ctx.restore();
}
function stamp(cx, cy, words, k, after, rot, kind) {
  const s = 1 + .9 * (1 - eo(k));
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot); ctx.scale(s, s); ctx.globalAlpha = clamp(k * 3);
  const w1 = tw(words[0], F.sc9(54)), w2 = tw(words[1], F.b8(56), 3), w = w1 + w2 + 22 + 64;
  if (kind === 'ink') {
    ctx.fillStyle = C.ink; ctx.fillRect(-w / 2, -50, w, 100);
    ctx.strokeStyle = C.lemon; ctx.lineWidth = 4; ctx.strokeRect(-w / 2 + 7, -43, w - 14, 86); ctx.lineWidth = 2; ctx.strokeRect(-w / 2 + 14, -36, w - 28, 72);
    text(words[0], -w / 2 + 32, 20, F.sc9(54), C.lemon, 'left', 0, 'stamp'); text(words[1], -w / 2 + 32 + w1 + 22, 21, F.b8(56), C.lemon, 'left', 3);
  } else {
    ctx.fillStyle = C.lemon; ctx.fillRect(-w / 2, -50, w, 100);
    text(words[0], -w / 2 + 32, 20, F.sc9(54), C.ink, 'left', 0, 'stamp'); text(words[1], -w / 2 + 32 + w1 + 22, 21, F.b8(56), C.ink, 'left', 3);
  }
  ctx.restore();
  const r = seg(after, 0, .45);
  if (k >= 1 && r < 1) { ctx.save(); ctx.strokeStyle = `rgba(242,207,29,${.8 * (1 - r)})`; ctx.lineWidth = 5 * (1 - r) + 1; ctx.beginPath(); ctx.ellipse(cx, cy, 200 + r * 260, 70 + r * 110, rot, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); }
}

// ============ 6 寒潮：日本海云街（快速下摇）============
function camCold(t) {
  const a = B(K.cutCold), k = eo(seg(t, a, a + 1));
  return { img: IM.cold, au: .45, av: lerp(.30, .44, k), sx: 960, sy: 540, s: lerp(.62, .66, k), rot: 0 };
}
function shotCold(t) {
  ctx.fillStyle = C.ink; ctx.fillRect(0, 0, W, H);
  const cam = camCold(t); drawPlate(cam);
  const g = ctx.createLinearGradient(W, 0, 760, 0); g.addColorStop(0, 'rgba(14,16,19,.92)'); g.addColorStop(.55, 'rgba(14,16,19,.6)'); g.addColorStop(1, 'rgba(14,16,19,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  vignette(.5); grain(t);
  eyebrowBox(1160, 250, 640); text('NASA TERRA · MODIS · 2021-12-22', 1180, 250, F.mono(24), C.gold, 'left', 3, 'ce');
  // 测距线沿云街拉出，k26 落定
  const m = land(t, K.measure, .3);
  const [ax, ay] = P(cam, .25, .27), [bx0, by0] = P(cam, .62, .56);
  if (m > 0) {
    const bx = lerp(ax, bx0, eo(m)), by = lerp(ay, by0, eo(m));
    ctx.save(); ctx.strokeStyle = C.lemon; ctx.lineWidth = 5; ctx.setLineDash([18, 10]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = C.lemon; ctx.beginPath(); ctx.arc(ax, ay, 9, 0, Math.PI * 2); ctx.fill();
    if (m >= 1) { ctx.beginPath(); ctx.arc(bx, by, 9, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }
  const lb = land(t, K.measure, .16);
  if (lb > 0) {
    const s = back(lb, 2.2); ctx.save(); ctx.translate(1180, 420); ctx.scale(s, s);
    text('> 644', 0, 0, F.b8(170), C.white, 'left', 2, 'c644'); const w = tw('> 644', F.b8(170), 2);
    text('公里', w + 20, -70, F.sc9(48), C.lemon, 'left', 0); text('KM', w + 20, -10, F.b8(48), C.lemon, 'left', 3);
    text('云街绵延 CLOUD STREETS', 4, 60, F.sc7(30), C.grey, 'left', 1);
    ctx.restore();
  }
}

// ============ 7 极光：空间站视角（横摇）============
function camAurora(t) {
  const a = B(K.cutAurora), k = eio(seg(t, a, a + 1));
  return { img: IM.aurora, au: lerp(.60, .42, k), av: .5, sx: 960, sy: 540, s: lerp(.70, .72, k), rot: lerp(.012, 0, k) };
}
function shotAurora(t) {
  ctx.fillStyle = C.ink; ctx.fillRect(0, 0, W, H);
  const cam = camAurora(t); drawPlate(cam);
  const g = ctx.createLinearGradient(W, 0, 1000, 0); g.addColorStop(0, 'rgba(14,16,19,.8)'); g.addColorStop(1, 'rgba(14,16,19,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  vignette(.45); grain(t);
  eyebrowBox(1130, 250, 680); text('NASA JSC · ISS072E147641 · 2024-11-09', 1150, 250, F.mono(22), C.gold, 'left', 2, 'ae');
  const lb = land(t, K.label, .16);
  if (lb > 0) {
    const s = back(lb, 2.2); ctx.save(); ctx.translate(1150, 640); ctx.scale(s, s);
    text('415', 0, 0, F.b8(190), C.white, 'left', 2, 'a415'); const w = tw('415', F.b8(190), 2);
    text('公里', w + 20, -86, F.sc9(48), C.lemon, 'left', 0); text('KM', w + 20, -24, F.b8(48), C.lemon, 'left', 3);
    text('空间站轨道高度 ISS ALTITUDE', 4, 60, F.sc7(30), C.grey, 'left', 1);
    ctx.restore();
  }
}

// ============ 9 翻牌板：寒潮前后（示意）============
const FLAP = {
  rows: [['最高', 'HIGH', ['+', '1', '6', '°'], ['−', '0', '3', '°']], ['最低', 'LOW', ['+', '0', '7', '°'], ['−', '1', '2', '°']]],
  cyc: '+−0123456789',
};
// 翻牌：从 from 起，每个 32 分音符翻一次（中间字符确定性生成），在 settle 落到 to
function flapSeq(from, to, settle, seed) {
  const t0 = B(K.flip) - 1 / 24, stp = window.TL.SPB / 4;
  const n = Math.round((settle - B(K.flip)) / stp);
  const seq = [from]; for (let j = 1; j < n; j++) seq.push(FLAP.cyc[Math.floor(hash(seed * 31 + j) * FLAP.cyc.length)]); seq.push(to);
  return { seq, t0, stp };
}
function flipTile(x, y, w, h, t, from, to, settle, seed) {
  const half = (s, top, sc = 1) => {
    ctx.save(); ctx.beginPath(); ctx.rect(x, top ? y : y + h / 2, w, h / 2); ctx.clip();
    ctx.translate(0, y + h / 2); ctx.scale(1, sc); ctx.translate(0, -(y + h / 2));
    ctx.fillStyle = top ? '#2B3038' : '#262A31'; ctx.fillRect(x, y, w, h);
    text(s, x + w / 2, y + h * .78 - (s === '−' || s === '+' ? 24 : 0), F.b8(118), C.white, 'center');
    ctx.restore();
  };
  if (from === to) { half(to, true); half(to, false); }
  else {
    const { seq, t0, stp } = flapSeq(from, to, settle, seed);
    if (t < t0) { half(from, true); half(from, false); }
    else if (t >= settle) { half(to, true); half(to, false); }
    else {
      const j = Math.min(seq.length - 2, Math.floor((t - t0) / stp)), p = clamp((t - t0 - j * stp) / (stp * .75));
      const A = seq[j], Bn = seq[j + 1];
      half(Bn, true); half(A, false);
      if (p < .5) half(A, true, 1 - p * 2); else half(Bn, false, (p - .5) * 2);
    }
  }
  ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(x, y + h / 2 - 1.5, w, 3);
}
function shotBoard(t) {
  studioBg(t);
  const a = B(K.wipeBoard) - WIPE, hit = B(K.flip) - 1 / 24;   // 冲击提前一帧起动，拍点那一帧已是最大变化
  // 镜头：静默中慢推 → 击中时猛拉回 + 震屏 → 缓推
  let zs;
  if (t < hit) zs = lerp(1.0, 1.075, eio(seg(t, a, hit)));
  else { const p = seg(t, hit, hit + .22), q = seg(t, hit + .22, hit + .9); zs = t < hit + .22 ? lerp(1.075, .965, eo(p)) : lerp(.965, 1.0, eio(q)); zs += .025 * eio(seg(t, hit + .9, DUR)); }
  const bt = B(K.button); if (t >= bt - 1 / 24) { const u = t - (bt - 1 / 24); zs += .03 * Math.exp(-u * 7) * Math.min(1, u * 24) - .012 * eo(seg(t, bt, DUR)); }   // 收束：一记小推冲击后回落
  const sh = t >= hit && t < hit + .45 ? 18 * (1 - seg(t, hit, hit + .45)) : 0;
  const tr = t >= B(K.tremble) && t < hit ? 2.5 * seg(t, B(K.tremble), hit) : 0;
  // 击中：背景冲击环
  const r = seg(t, hit, hit + .55);
  if (r > 0 && r < 1) { ctx.strokeStyle = `rgba(242,207,29,${.9 * (1 - r)})`; ctx.lineWidth = 10 * (1 - r) + 1; ctx.beginPath(); ctx.ellipse(800, 470, 500 + r * 900, 260 + r * 420, 0, 0, Math.PI * 2); ctx.stroke(); }
  ctx.save(); ctx.translate(Math.sin(t * 83) * sh, Math.cos(t * 71) * sh * .7);
  ctx.translate(820, 470); ctx.scale(zs, zs); ctx.translate(-820, -470);
  // 卡片
  const cx0 = 130, cy0 = 160, cw = 1300, chh = 610;
  ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(cx0 + 18, cy0 + 22, cw, chh);
  ctx.fillStyle = C.ink2; ctx.fillRect(cx0, cy0, cw, chh); ctx.fillStyle = C.lemon; ctx.fillRect(cx0, cy0, cw, 6);
  text('SCHEMATIC · 示意 · BEFORE / AFTER', cx0 + 50, cy0 + 60, F.mono(22), C.gold, 'left', 3, 'b0');
  const w1 = text('寒潮前后 气温', cx0 + 50, cy0 + 140, F.sc9(64), C.white, 'left', 2, 'b1');
  text('TEMPERATURE · BEFORE → AFTER', cx0 + 50 + w1 + 28, cy0 + 136, F.b6(30), C.gold, 'left', 3);
  // 前/后 标签：小翻牌
  const after = t >= hit;
  ctx.fillStyle = after ? C.lemon : C.ink3; ctx.fillRect(cx0 + cw - 260, cy0 + 30, 210, 50);
  const blink = !after && t >= B(K.wipeBoard) ? (Math.floor((t - B(K.wipeBoard)) * 4) % 2 === 0 ? 1 : .6) : 1;
  ctx.globalAlpha = blink; bi(after ? '后' : '前', after ? 'AFTER' : 'BEFORE', cx0 + cw - 240, cy0 + 66, F.sc9(28), F.b8(30), after ? C.ink : C.white, after ? C.ink : C.grey, 12, 'bstate'); ctx.globalAlpha = 1;
  ctx.fillStyle = C.line; ctx.fillRect(cx0 + 50, cy0 + 172, cw - 100, 2);
  FLAP.rows.forEach(([cn, en, from, to], ri) => {
    const y = cy0 + 210 + ri * 172;
    text(cn, cx0 + 50, y + 76, F.sc9(50), C.white, 'left', 0, 'bl' + ri); text(en, cx0 + 52, y + 116, F.b6(28), C.grey, 'left', 3);
    from.forEach((f, c) => {
      const jx = tr ? Math.sin(t * 97 + c * 2 + ri) * tr : 0;
      const settle = c < 3 ? B(K.settle[c]) : hit;
      flipTile(cx0 + 280 + c * 234 + jx, y, 220, 140, t, f, to[c], settle, ri * 7 + c + 1);
    });
  });
  doneStrip(t, cx0 + 50, cy0 + 546, cw - 100);
  ctx.restore();
  // 右侧：ΔT −19°（k34 砸出）
  const dk = land(t, K.delta, .14);
  if (dk > 0) {
    const s = 1 + .7 * (1 - eo(dk)); ctx.save(); ctx.translate(1660, 470); ctx.scale(s, s); ctx.globalAlpha = clamp(dk * 3);
    text('ΔT', 0, -150, F.b8(56), C.gold, 'center', 4);
    text('−19°', 0, 60, F.b8(250), C.lemon, 'center', 0, 'bdt');
    bi('降温', 'DROP', -78, 130, F.sc9(40), F.b8(40), C.white, C.grey, 14);
    const ru = land(t, K.rule, .25); if (ru > 0) { ctx.fillStyle = C.gold; ctx.fillRect(-150, 150, 300 * eo(ru), 6); }
    ctx.restore();
  }
  // 印章（k35）
  const st = land(t, K.stamp2, .16);
  if (st > 0) stamp(1640, 720, ['骤降', 'PLUNGE'], st, t - B(K.stamp2), -.12, 'lemon');
  // 收束光带（k38）
  const gl = seg(t, B(K.button) - .05, B(K.button) + .45);
  if (gl > 0 && gl < 1) { const gx = lerp(-300, W + 300, eio(gl)); const g = ctx.createLinearGradient(gx - 220, 0, gx + 220, 0); g.addColorStop(0, 'rgba(248,222,74,0)'); g.addColorStop(.5, 'rgba(248,222,74,.22)'); g.addColorStop(1, 'rgba(248,222,74,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); }
}

// 收束条：串联单缩成一行「本周三条 · 已播完」，k37 推入，三格逐个打勾，k38 三格同时亮成柠檬黄
function doneStrip(t, x, y, w) {
  const k = land(t, K.end, .25); if (k <= 0) return;
  const h = 52;
  ctx.save(); ctx.beginPath(); ctx.rect(x, y - 4, w * eo(k), h + 8); ctx.clip();
  const tabW = 24 + tw('本周三条 已播完', F.sc9(26)) + 12 + tw('3 STORIES · DONE', F.b8(24), 2) + 24;
  ctx.fillStyle = C.lemon; ctx.fillRect(x, y, tabW, h);
  bi('本周三条 已播完', '3 STORIES · DONE', x + 24, y + 36, F.sc9(26), F.b8(24), C.ink, C.ink, 12, 'done');
  const items = [['01', '台风'], ['02', '寒潮'], ['03', '极光']], bw = (w - tabW - 16 * 3) / 3;
  const on = t >= B(K.button) ? 1 : 0;
  items.forEach(([n, cn], i) => {
    const bx = x + tabW + 16 + i * (bw + 16);
    ctx.fillStyle = on > 0 ? C.lemon : C.ink3; ctx.fillRect(bx, y, bw, h);
    const fl = 1 - seg(t, B(K.button), B(K.button) + .2);
    if (on > 0 && fl > 0) { ctx.fillStyle = `rgba(255,255,255,${fl})`; ctx.fillRect(bx, y, bw, h); }
    const ink = on > 0 ? C.ink : C.white;
    text(n, bx + 20, y + 38, F.b8(32), on > 0 ? C.ink : C.lemon, 'left', 1);
    text(cn, bx + 74, y + 37, F.sc9(26), ink, 'left', 0);
    const tk = land(t, K.doneTicks[i], .12);
    if (tk > 0) { ctx.save(); ctx.translate(bx + bw - 34, y + h / 2); ctx.scale(.62, .62); tickMark(0, 0, tk); ctx.restore(); }
  });
  ctx.restore();
}

// ============ 合成 ============
// 每个画面 = 镜头 + 它自己的包装层（角标、来源行、标题条），包装层按 tov 时刻的状态画
const SRC = {
  ty: ['SOURCE: NASA GSFC · AQUA MODIS', '来源：美国航天局 · Aqua 卫星 MODIS'],
  spec: ['SOURCE: NASA GSFC · NOAA NHC · JMA', '来源：美国航天局 · 美国国家飓风中心 · 日本气象厅'],
  cold: ['SOURCE: NASA GSFC · TERRA MODIS', '来源：美国航天局 · Terra 卫星 MODIS'],
  aur: ['SOURCE: NASA JSC · ISS072E147641', '来源：美国航天局 约翰逊航天中心'],
  run: ['WX 24 · SAMPLE BULLETIN', '示意节目 · 影像均为公有领域'],
  board: ['SCHEMATIC · ILLUSTRATIVE VALUES', '示意图 · 数值仅为示意'],
};
const TAG = { file20: ['FILE · 2020-10-30', '资料图像 · 非本周拍摄'], file21: ['FILE · 2021-12-22', '资料图像 · 非本周拍摄'],
  file24: ['FILE · 2024-11-09', '资料图像 · 非本周拍摄'], schem: ['SCHEMATIC', '示意图 · 数值为示意'] };
const SC_ = [
  { a: B(K.wipeRundown), fn: t => rundown(t, 'open'), src: null, tag: null },
  { a: B(K.wipeTyphoon), fn: shotTyphoon, src: SRC.ty, tag: TAG.file20 },
  { a: B(K.cutSpec), fn: shotSpec, src: SRC.spec, tag: null },
  { a: B(K.wipeRecap1), fn: t => rundown(t, 'r1'), src: SRC.run, tag: null },
  { a: B(K.cutCold), fn: shotCold, src: SRC.cold, tag: TAG.file21 },
  { a: B(K.cutAurora), fn: shotAurora, src: SRC.aur, tag: TAG.file24 },
  { a: B(K.wipeRecap2), fn: t => rundown(t, 'r2'), src: SRC.run, tag: null },
  { a: B(K.wipeBoard), fn: shotBoard, src: SRC.board, tag: TAG.schem },
];
const WIPES = [K.wipeRundown, K.wipeTyphoon, K.wipeRecap1, K.wipeRecap2, K.wipeBoard].map(k => [B(k) - WIPE, B(k)]);
const WIPED = new Set([K.wipeRundown, K.wipeTyphoon, K.wipeRecap1, K.wipeRecap2, K.wipeBoard].map(B));
function layer(sc, t, tov) { sc.fn(t); cornerTag(sc.tag, tov, sc.a, WIPED.has(sc.a)); source(sc.src); strap(tov); }
const STING = { a: 0, fn: shotSting, src: null, tag: null };
function wipeBand(bx) { ctx.fillStyle = C.lemon; ctx.fillRect(bx - 84, 0, 84, H); ctx.fillStyle = C.ink; ctx.fillRect(bx, 0, 5, H); ctx.fillStyle = C.gold; ctx.fillRect(bx + 5, 0, 14, H); }
function wipe(t, a, b, oldSc, newSc) {
  const bx = lerp(-140, W + 140, eio(seg(t, a, b)));
  const n0 = TX.length; layer(newSc, t, b + .001); const NEW = TX.splice(n0);
  ctx.save(); ctx.beginPath(); ctx.rect(bx, 0, W + 400, H); ctx.clip(); layer(oldSc, t, a - .001); ctx.restore();
  const OLD = TX.splice(n0); TX.push(...(seg(t, a, b) < .5 ? OLD : NEW));
  wipeBand(bx);
}
function scene(t) {
  const w = WIPES.find(([a, b]) => t >= a && t < b);
  if (w) {
    const i = SC_.findIndex(s => Math.abs(s.a - w[1]) < 1e-6);
    wipe(t, w[0], w[1], i === 0 ? STING : SC_[i - 1], SC_[i]);
  } else if (t < SC_[0].a) layer(STING, t, t);
  else { let sc = SC_[0]; for (const s of SC_) if (t >= s.a) sc = s; layer(sc, t, t); }
  stingPlate(t);
}
function render(t) {
  TX = [];
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.filter = 'none';
  scene(t);
  bug(t);
}

// ============ 声音与卡点事件（events.mjs → events.json → mix.py / cuecheck.py）============
// k = 拍号（落在网格上的事件），cue = 是否参与卡点核对
const EV = [{ t: 0, type: 'meta', bpm: window.TL.BPM, t0: window.TL.T0, fps: window.TL.FPS }];
const E = (type, k, extra = {}) => EV.push({ t: B(k), type, k, cue: true, ...extra });
const Et = (type, t, extra = {}) => EV.push({ t: Math.round(t * 10000) / 10000, type, ...extra });
Et('swish', 0); Et('swish', .06, { v: .7 });
E('slam', K.slam); K.letters.forEach((k, i) => E('letter', k, { i }));
E('wordmark', K.wordmark); E('glint', K.glint);
Et('whoosh', B(K.fly), { d: .5 }); E('bugland', K.bugLand);
[K.wipeRundown, K.wipeTyphoon, K.wipeRecap1, K.wipeRecap2, K.wipeBoard].forEach(k => { Et('whoosh', B(k) - WIPE, { d: WIPE + .05 }); E('wipe', k, { last: k === K.wipeBoard }); });
K.rows.forEach((k, i) => E('row', k, { i }));
E('hl', K.hl); E('count', K.wk); E('next', K.next1); E('dim', K.dim);
E('strapin', K.strapIn);
for (let j = 0; j < 30; j++) Et('key', B(K.eyebrow) - .25 + j * (.25 / 30));
E('typed', K.eyebrow); E('name', K.name); E('sonar', K.sonar);
E('cut', K.cutSpec); E('title', K.title); E('thr', K.thr);
for (let j = 0; j < 6; j++) E('roll', K.title + j * .25);
E('bar', K.bar); E('badge', K.badge); K.cells.forEach((k, i) => E('cell', k, { i }));
E('stamp', K.stamp1); E('chip', K.chipIn); E('sweep', K.chip);
for (let j = 0; j < 6; j++) Et('presstick', B(K.press) - .3 + j * .05);
E('press', K.press);
E('tick', K.tick1, { i: 0 });
E('cut', K.cutCold); E('measure', K.measure);
E('cut', K.cutAurora); E('label', K.label);
E('tick', K.tick3, { i: 2, double: true }); E('next', K.next2); E('insert', K.next2);
E('flip', K.flip);
// 翻牌连响：每个 32 分音符一声，直到各列落定
for (let j = 0; ; j++) { const k = K.flip + j * .25; if (k > K.settle[2] + 1e-9) break; E('flap', k, { n: K.settle.filter(s => s >= k - 1e-9).length * 2 }); }
K.settle.forEach((k, i) => E('settle', k, { i }));
E('delta', K.delta); E('stamp2', K.stamp2); E('rule', K.rule); E('end', K.end);
K.doneTicks.forEach((k, i) => E('donetick', k, { i })); E('button', K.button);
// 环境床
Et('bed', 0, { name: 'room', t1: DUR });
Et('bed', B(K.wipeTyphoon) - WIPE, { name: 'storm', t1: B(K.cutSpec) });
Et('bed', B(K.cutSpec), { name: 'ticks', t1: B(K.wipeRecap1) });
Et('bed', B(K.cutCold), { name: 'wind', t1: B(K.cutAurora) });
Et('bed', B(K.cutAurora), { name: 'hiss', t1: B(K.wipeRecap2) });

window.DUR = DUR; window.EV = EV; window.render = render; window.TEXTS = t => { render(t); return TX; };
(async () => {
  makeGrain();
  const names = ['goni', 'cold', 'aurora'];
  const imgs = await Promise.all(names.map(n => loadImg(`assets/${n}_g.jpg`)));
  names.forEach((n, i) => IM[n] = imgs[i]);
  await Promise.all([F.sc9(40), F.sc7(40), F.b8(40), F.b6(40), F.b6i(40), F.mono(40)].map(f => document.fonts.load(f, '本周 Aa')));
  render(0); window.READY = true;
})();
