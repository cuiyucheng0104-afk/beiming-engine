// 侧锋大笔（一笔成山用）：中心线是 x 的函数 y = yc(x)，按像素算一次缓存成两张图（干层：笔身全墨；湿层：向下渗的墨晕）。
// 不是一组平行线：笔压曲线（藏锋入、中段重、出锋尖）× 墨重的一侧（上侧焦墨、下侧淡）× 40 多根随机间距的鬃毛，
// 墨量沿笔迹递减，前段是实墨，后段按长尺度噪声断开成飞白；笔边用噪声咬出毛边。
import { vn2 } from './land.js';
import { clamp, lerp, mulberry } from '/core/lib.js';

const sstep = (a, b, x) => { const u = clamp((x - a) / (b - a)); return u * u * (3 - 2 * u); };

// yc：中心线；xs → xe：行笔方向（可从右往左）；o.w(x, u)：笔宽（世界单位，u = 0..1 行笔进度）
export function graphStroke(yc, xs, xe, o = {}) {
  const k = o.k ?? 1.25, dir = Math.sign(xe - xs), xa = Math.min(xs, xe) - 60, xb = Math.max(xs, xe) + 60;
  // 弧长参数
  const N = Math.ceil((xb - xa) / 2), acc = new Float32Array(N + 1);
  const X = i => xa + i * 2;
  for (let i = 1; i <= N; i++) acc[i] = acc[i - 1] + Math.hypot(2, yc(X(i)) - yc(X(i - 1)));
  const sOf = x => { const i = clamp((x - xa) / 2, 0, N - 1e-6), j = Math.floor(i), f = i - j; return lerp(acc[j], acc[Math.min(N, j + 1)], f); };
  const s0 = sOf(xs), s1 = sOf(xe), L = Math.abs(s1 - s0);
  const uAt = x => dir > 0 ? clamp((sOf(x) - s0) / L) : clamp((s0 - sOf(x)) / L);
  const R = mulberry(o.seed ?? 11), seed = (o.seed ?? 11) * 7.3;
  // 鬃毛：随机间距（不是等距平行线）
  const NB = o.nb ?? 54, br = [];
  for (let j = 0; j < NB; j++) br.push({ v: R() * 2.1 - 1.05, hw: .01 + R() * .04 * R(), a: .6 + R() * .4, ph: R() * 900, gs: 50 + R() * 190, load: .75 + R() * .35 });
  const pressure = (u, x) => {
    const inn = (.52 + .48 * sstep(0, .16, u)) * (1 + .22 * Math.exp(-Math.pow((u - .01) / .014, 2)));   // 藏锋：起笔先顿一个圆头，提笔变细，再按下去走中段   // 藏锋：起笔先顿一个圆头，再提
    const out = u > .8 ? Math.pow(clamp((1 - u) / .2), .75) : 1;                                                  // 出锋：收尖
    return inn * Math.max(.04, out) * (o.w ? o.w(x, u) : 60) * (1 + .16 * (vn2(u * 9 + seed, 3) - .5));
  };
  const y0 = (o.ymin ?? 0), y1 = (o.ymax ?? 1080);
  const W = Math.ceil((xb - xa) * k), H = Math.ceil((y1 - y0) * k);
  const mkc = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
  const dryC = mkc(), wetC = mkc();
  const dI = dryC.getContext('2d').createImageData(W, H), wI = wetC.getContext('2d').createImageData(W, H);
  const xLo = Math.min(xs, xe), xHi = Math.max(xs, xe);
  for (let px = 0; px < W; px++) {
    const x = xa + (px + .5) / k;
    // 起笔圆头 / 收笔尖之外不画
    const xin = clamp(x, xLo, xHi), u = uAt(xin);
    const beyond = Math.abs(x - xin);
    const slope = (yc(x + 2) - yc(x - 2)) / 4, cs = 1 / Math.sqrt(1 + slope * slope);
    const w = pressure(u, xin), hw = w / 2, yC = yc(x);
    // 起笔端（u≈0 那头）是圆头，可越出 xs 一个半宽；收笔端不越出
    const atStart = (dir < 0 ? x > xHi : x < xLo);
    if (beyond > 0 && (!atStart || beyond > hw)) continue;
    const capK = beyond > 0 ? Math.sqrt(Math.max(0, 1 - Math.pow(beyond / hw, 2))) : 1;
    const span = (hw * 1.5) / cs + 6;
    const ja = Math.max(0, Math.floor((yC - span - y0) * k)), jb = Math.min(H - 1, Math.ceil((yC + span - y0) * k));
    // 沿笔的墨量：前段饱满，后段枯
    const load = clamp(1.12 - 1.05 * Math.pow(u, 1.35));
    const sl = sOf(xin);
    const edgeN = (vn2(x * .03 + seed, 1.3) - .5) * .16 + (vn2(x * .12, 7.1 + seed) - .5) * .05;
    for (let py = ja; py <= jb; py++) {
      const y = y0 + (py + .5) / k, d = (y - yC) * cs, v = d / (hw * capK || 1e-3);   // v<0 上侧（墨重）
      const av = Math.abs(v), side = clamp((v + 1) / 2);
      // 干层：笔身
      let D = 0;
      if (av < 1.08) {
        const edge = 1 - sstep(.9 + edgeN, 1.04 + edgeN, av);
        const tone = lerp(.98, .3, Math.pow(side, 1.35));                                  // 侧锋：上侧焦墨、下侧淡
        // 枯笔程度：沿笔递增（前段饱墨、尾段干），下侧（淡墨一侧）先干，长尺度噪声让它成片地出现
        const dryness = clamp(-.4 + 1.3 * Math.pow(u, 1.6) + .5 * side * side + (vn2(sl * .004 + seed, 5.5) - .5) * .5);
        // 飞白：鬃毛之间露出纸白的细缝，缝在墨尽处出现、按长尺度噪声断续（不是等距平行线）
        let gap = 0;
        if (dryness > .02) for (let j = 0; j < NB; j++) {
          const b = br[j], dv = Math.abs(v - b.v); if (dv > b.hw * 2) continue;
          const pres = (vn2(b.ph + sl / b.gs, b.ph * .1) - .5) * 1.5 + (vn2(b.ph * 1.7 + sl / (b.gs * .2), 3) - .5) * .5 + dryness * .95 - .72;
          if (pres <= 0) continue;
          gap = Math.max(gap, b.a * clamp(pres * 3.5) * (1 - sstep(b.hw * .45, b.hw * 2, dv)));
        }
        // 笔里的墨色起伏（大块、不顺笔走的斑，避免成条）
        const mott = 1 + (vn2(x * .006 + seed, y * .006) - .5) * .16 + (vn2(x * .03, y * .03 + seed) - .5) * .08;
        const eb = edge * (1 - sstep(.55, 1, dryness) * sstep(.75, 1, av) * .8);    // 干处笔边也破
        D = eb * tone * mott * (1 - gap * (.55 + .45 * dryness)) * (1 - .18 * dryness);
        // 起笔顿处更重
        D *= 1 + .12 * Math.exp(-Math.pow(u / .03, 2));
      }
      // 湿层：笔下侧的墨晕（向山体渗开），上侧只有一线
      let Wt = 0;
      if (av < 1.5) {
        const wn = (vn2(x * .008 + seed, 2.7) - .5) * .5;
        // 只在笔下沿外侧渗一圈（笔身里不叠湿墨，否则侧锋的浓淡被糊成一片黑）
        const fall = v > 0 ? sstep(.55, .95, v) * (1 - sstep(1.0, 1.5 + wn, v)) : .35 * sstep(.8, 1, av) * (1 - sstep(1, 1.1, av));
        Wt = fall * (.26 + .14 * load) * (.75 + .5 * vn2(x * .02 + 3, y * .03));
      }
      const ii = (py * W + px) * 4 + 3;
      dI.data[ii] = clamp(D) * 255; wI.data[ii] = clamp(Wt) * 255;
    }
  }
  dryC.getContext('2d').putImageData(dI, 0, 0);
  // 湿层先柔化：合成器的渗化是有限个采样点，硬边会被复制成一圈圈平行细线
  { const tmp = mkc(); tmp.getContext('2d').putImageData(wI, 0, 0); const c = wetC.getContext('2d'); c.filter = `blur(${(o.wetBlur ?? 7) * k}px)`; c.drawImage(tmp, 0, 0); c.filter = 'none'; }
  // 行笔到进度 p 时笔锋所在的 x
  const headX = p => { if (p <= 0) return xs; if (p >= 1) return xe; let lo = xLo, hi = xHi; for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; (uAt(m) < p) === (dir < 0) ? (hi = m) : (lo = m); } return (lo + hi) / 2; };
  return { dry: dryC, wet: wetC, xa, y0, k, W, H, headX, pressure, uAt, yc, dir };
}

// 画到进度 p：已走过的部分 + 笔锋处一个圆头（笔肚）
export function drawGraphStroke(L, S, p, am = 1) {
  if (p <= 0) return;
  const hx = S.headX(p), u = S.uAt(hx), hw = S.pressure(u, hx) / 2;
  for (const key of ['dry', 'wet']) {
    const c = L[key]; c.save();
    if (p < 1) {
      c.beginPath();
      if (S.dir < 0) c.rect(hx, -1e4, 2e4, 2e4); else c.rect(-1e4, -1e4, hx + 1e4, 2e4);
      c.ellipse(hx, S.yc(hx), hw * 1.05, hw * 1.15, 0, 0, Math.PI * 2);
      c.clip();
    }
    c.globalAlpha = am * (key === 'wet' ? 1 : 1);
    c.drawImage(S[key], S.xa, S.y0, S.W / S.k, S.H / S.k);
    c.restore();
  }
}
