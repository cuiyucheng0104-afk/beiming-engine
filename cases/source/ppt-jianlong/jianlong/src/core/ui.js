// 2D 叠层组件（画在 overlay canvas 上，终合成时盖在画面之上）：镜片框、界面元素、标题字、闪回版式、印章。
// 所有出现在画面上的字都经过 text()：查白名单（不在白名单直接抛错，渲染工具会停），并登记给 window.TEXTS 做阅读时长检查。
import { clamp, seg, eo, eio, ss, hash } from '/core/lib.js';
export const C = { ink: '#16171b', paper: '#ede5cd', red: '#c4332b', yel: '#dfa443', grn: '#3DFFB0', grnA: a => `rgba(61,255,176,${a})`, inkA: a => `rgba(22,23,27,${a})`, paperA: a => `rgba(237,229,205,${a})` };
export const FONT = { serif: w => `"JLSerif${w}"`, sans: '"JLSans"' };

export function createUI(ctx, allow) {
  const W = 1920, H = 1080;
  let texts = [];
  const begin = () => { texts = []; };
  function check(s) {
    const t = s.replace(/\s+/g, ' ').trim(); if (!t) return;
    if (!allow.has(t) && ![...allow].some(a => a.includes(t))) throw new Error(`画面文字不在白名单（规范 §4）：「${t}」`);
  }
  // 画一段字，登记 TEXTS（full = 这条字的完整内容，打字动画中途也报完整内容）
  function text(s, x, y, o = {}) {
    check(o.full ?? s);
    const size = o.size ?? 32, font = o.font ?? FONT.serif(700);
    ctx.save(); ctx.font = `${size}px ${font}`; ctx.textAlign = o.align ?? 'left'; ctx.textBaseline = o.base ?? 'alphabetic';
    ctx.globalAlpha *= o.alpha ?? 1; ctx.fillStyle = o.color ?? C.paper;
    if (o.letter) ctx.letterSpacing = o.letter + 'px';
    if (o.blur) ctx.filter = `blur(${o.blur}px)`;
    ctx.fillText(s, x, y);
    const m = ctx.measureText(o.full ?? s), w = m.width;
    const x0 = (o.align === 'center') ? x - w / 2 : (o.align === 'right') ? x - w : x;
    if (o.id && (o.alpha ?? 1) > 0.5) texts.push({ id: o.id, text: o.full ?? s, x0, y0: y - size, x1: x0 + w, y1: y + size * 0.25 });
    ctx.restore(); return w;
  }
  // 逐笔描出一条折线/路径：pts 屏幕坐标，k 0..1
  function stroke(pts, k, o = {}) {
    if (k <= 0) return; let L = 0; const seglen = [];
    for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seglen.push(d); L += d; }
    let left = L * clamp(k);
    ctx.save(); ctx.strokeStyle = o.color ?? C.grn; ctx.lineWidth = o.w ?? 2; ctx.globalAlpha *= o.alpha ?? 1; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (o.glow) { ctx.shadowColor = C.grnA(0.6); ctx.shadowBlur = o.glow; }
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length && left > 0; i++) {
      const d = seglen[i - 1], f = Math.min(1, left / d);
      ctx.lineTo(pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f); left -= d;
    }
    ctx.stroke(); ctx.restore();
  }
  const rrPts = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  // —— 镜片框 ——
  let darkCache = null;
  function darkMask() {
    if (darkCache) return darkCache;
    const c = new OffscreenCanvas(W, H), x = c.getContext('2d');
    x.fillStyle = C.ink; x.fillRect(0, 0, W, H);
    x.globalCompositeOperation = 'destination-out'; x.filter = 'blur(40px)';
    x.beginPath(); x.roundRect(60, 50, W - 120, H - 100, 90); x.fill();
    return (darkCache = c);
  }
  // o.k 框线描出进度；o.dark 框外压暗(默认 .84)；o.corners 角标进度；o.alpha 整体
  function lens(o = {}) {
    const k = o.k ?? 1, a = o.alpha ?? 1; if (a <= 0) return;
    ctx.save(); ctx.globalAlpha = a * (o.dark ?? 0.84) * clamp(o.darkK ?? k * 1.5); ctx.drawImage(darkMask(), 0, 0); ctx.restore();
    ctx.save(); ctx.globalAlpha = a;
    // 圆角框线：用虚线长度做描出
    ctx.strokeStyle = C.grnA(0.55); ctx.lineWidth = 2;
    const per = 2 * (W - 120 + H - 100) - (8 - 2 * Math.PI) * 90;
    ctx.setLineDash([per * clamp(k), per * (1 - clamp(k)) + 0.01]); ctx.lineDashOffset = -per * 0.08;   // 周期 = 周长，描满时首尾相接（原写法 k=1 时左上缺 8%）
    ctx.beginPath(); ctx.roundRect(60, 50, W - 120, H - 100, 90); ctx.stroke(); ctx.setLineDash([]);
    const ck = o.corners ?? clamp((k - 0.6) / 0.4);
    if (ck > 0) for (const [x, y, sx, sy] of [[110, 100, 1, 1], [W - 110, 100, -1, 1], [110, H - 100, 1, -1], [W - 110, H - 100, -1, -1]]) {
      const L = 60 * eo(ck), off = (1 - eo(ck)) * 26;
      stroke([[x + sx * (L - off), y - sy * off], [x - sx * off, y - sy * off], [x - sx * off, y + sy * (L - off)]], 1, { w: 3, color: C.grn });
    }
    ctx.restore();
  }
  // —— 标签：框描出 → 字逐个打出 ——（ev 来自 sfx 清单：{t, text, cps}，与打字声同源）
  function label(ev, lt, x, y, o = {}) {
    const s = ev.text, size = o.size ?? 28, cps = ev.cps ?? 12, padX = 14, padY = 10;
    const tBox = o.boxDur ?? 0.25, t = lt - ev.t; if (t < 0) return null;
    const out = o.out != null ? clamp(1 - (lt - o.out) / 0.25) : 1; if (out <= 0) return null;
    ctx.save(); ctx.font = `${size}px ${FONT.sans}`; const w = ctx.measureText(s).width; ctx.restore();
    const x0 = x, y0 = y - size - padY, x1 = x + w + padX * 2, y1 = y + padY * 0.8;
    ctx.save(); ctx.globalAlpha = out;
    ctx.fillStyle = C.inkA(0.55 * clamp(t / tBox)); ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    stroke(rrPts(x0, y0, x1, y1), t / tBox, { w: 1.6 });
    if (o.leader) stroke([o.leader, [x0, (y0 + y1) / 2]], t / tBox, { w: 1.4, alpha: 0.8 });
    const n = Math.floor(Math.max(0, t - tBox) * cps), shown = [...s].slice(0, n).join('');
    if (shown) text(shown, x0 + padX, y, { size, font: FONT.sans, color: C.grn, full: s, id: o.id ?? 'lab_' + s, alpha: n >= [...s].length ? out : 0.4 });
    ctx.restore();
    return { x0, y0, x1, y1, done: n >= [...s].length };
  }
  // 扫描角框：box 屏幕坐标，k 0..1 从外收拢到位
  function corners(box, k, o = {}) {
    if (k <= 0) return; const [x0, y0, x1, y1] = box, e = eo(k), g = (1 - e) * 60, L = o.len ?? 34;
    ctx.save(); ctx.globalAlpha = (o.alpha ?? 1) * clamp(k * 3);
    for (const [x, y, sx, sy] of [[x0 - g, y0 - g, 1, 1], [x1 + g, y0 - g, -1, 1], [x0 - g, y1 + g, 1, -1], [x1 + g, y1 + g, -1, -1]])
      stroke([[x + sx * L, y], [x, y], [x, y + sy * L]], 1, { w: o.w ?? 2.5 });
    ctx.restore();
  }
  // 录音波形：level(t) 0..1（用 api.voLevel 接旁白真实响度，或自造）
  function wave(x, y, w, h, t, level, o = {}) {
    const bars = o.bars ?? 36, bw = w / bars; ctx.save(); ctx.fillStyle = C.grn; ctx.globalAlpha = o.alpha ?? 1;
    for (let i = 0; i < bars; i++) {
      const tt = t - (bars - 1 - i) / 30, v = clamp(level(tt)) * (0.55 + 0.45 * hash(i * 7.1 + Math.floor(tt * 30)));
      const bh = Math.max(2, v * h); ctx.fillRect(x + i * bw + bw * 0.2, y + (h - bh) / 2, bw * 0.6, bh);
    }
    ctx.restore();
  }
  function progress(x, y, w, p, o = {}) {
    ctx.save(); ctx.globalAlpha = o.alpha ?? 1; ctx.fillStyle = C.grnA(0.25); ctx.fillRect(x, y - 2, w, 4);
    ctx.fillStyle = C.grn; ctx.fillRect(x, y - 2, w * clamp(p), 4); ctx.beginPath(); ctx.arc(x + w * clamp(p), y, 6, 0, 7); ctx.fill(); ctx.restore();
  }
  function dot(x, y, r, a = 1) { ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = C.grn; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); ctx.restore(); }
  // 刀刻式出字：从左到右切开（k 0..1），可带墨底板
  function cutText(s, x, y, k, o = {}) {
    if (k <= 0) return; const size = o.size ?? 120;
    ctx.save(); ctx.font = `${size}px ${o.font ?? FONT.serif(900)}`; const w = ctx.measureText(s).width;
    const x0 = o.align === 'center' ? x - w / 2 : x;
    ctx.beginPath(); const edge = x0 - 10 + (w + 20) * eio(clamp(k));
    ctx.moveTo(x0 - 20, y - size * 1.1); ctx.lineTo(edge + 8, y - size * 1.1);
    for (let i = 0; i <= 8; i++) ctx.lineTo(edge + (hash(i * 3.7 + s.length) - 0.5) * 14, y - size * 1.1 + i * size * 1.4 / 8);
    ctx.lineTo(x0 - 20, y + size * 0.3); ctx.closePath(); ctx.clip();
    text(s, x0, y, { size, font: o.font ?? FONT.serif(900), color: o.color ?? C.paper, id: o.id, alpha: o.alpha ?? 1, letter: o.letter });
    ctx.restore();
  }
  // 宣纸上的墨字落下：先洇（模糊、略大、淡），再收紧成实字
  function inkChar(s, x, y, k, o = {}) {
    if (k <= 0) return; const size = o.size ?? 150, e = eo(clamp(k)), sc = 1 + (1 - e) * 0.18;
    ctx.save(); ctx.translate(x, y); ctx.scale(sc, sc);
    text(s, 0, 0, { size, font: o.font ?? FONT.serif(900), color: C.ink, alpha: (o.alpha ?? 1) * clamp(k * 2.5), blur: (1 - e) * 10, id: o.id, align: o.align ?? 'center' });
    ctx.restore();
  }
  // 竖排小标题（每字一行），k 逐字显现
  function vText(s, x, y, k, o = {}) {
    const size = o.size ?? 40, chars = [...s], n = chars.length; let yy = y;
    for (let i = 0; i < n; i++) {
      const a = clamp(k * n - i);
      if (a > 0) text(chars[i], x, yy, { size, font: o.font ?? FONT.serif(700), color: o.color ?? C.ink, align: 'center', alpha: a, full: s, id: a >= 1 && i === n - 1 ? o.id : undefined });
      yy += size * 1.12;
    }
    return yy;
  }
  // 朱红印章「闪」：压下（k 0..1：下压 → 落定，带一点墨边不匀）
  function seal(x, y, size, k, o = {}) {
    if (k <= 0) return; check('闪');
    const e = k < 0.6 ? eo(k / 0.6) : 1, sc = 1.35 - 0.35 * e;
    ctx.save(); ctx.translate(x, y); ctx.scale(sc, sc); ctx.globalAlpha = (o.alpha ?? 1) * clamp(k / 0.35);
    ctx.fillStyle = C.red; ctx.beginPath(); ctx.roundRect(-size / 2, -size / 2, size, size, size * 0.08); ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 40; i++) { ctx.globalAlpha = 0.5; ctx.fillRect(-size / 2 + hash(i * 1.3) * size, -size / 2 + hash(i * 2.9) * size, 2 + hash(i) * 3, 1.5); }
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = (o.alpha ?? 1) * clamp(k / 0.35);
    ctx.font = `${size * 0.72}px ${FONT.serif(900)}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = C.paper; ctx.fillText('闪', 0, size * 0.04);
    ctx.restore();
    if (o.id && k >= 1) texts.push({ id: o.id, text: '闪', x0: x - size / 2, y0: y - size / 2, x1: x + size / 2, y1: y + size / 2 });
  }
  // 闪回段统一版式：右上大字 + 竖排小标题 + 朱红「闪」印。k = {char, title, seal} 各自 0..1
  function flashTitle(ch, title, k, o = {}) {
    const x = o.x ?? 1735, y = o.y ?? 225;
    inkChar(ch, x, y, k.char ?? 0, { size: 150, id: 'big_' + ch });
    const yEnd = vText(title, x, y + 80, k.title ?? 0, { size: 40, id: 'title_' + title });
    seal(x, yEnd + 24, 44, k.seal ?? 0, { id: 'seal_' + ch });
  }
  return { begin, texts: () => texts, check, text, stroke, rrPts, lens, label, corners, wave, progress, dot, cutText, inkChar, vText, seal, flashTitle, ctx };
}
