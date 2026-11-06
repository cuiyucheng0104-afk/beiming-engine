// 雨层、字幕条、水墨过渡（对 P.draw 的封装）
import { clamp, seg, eo, ei, eio, ss, hash } from '/core/lib.js';
import { C, FONT } from './ui.js';

// —— 雨：两到三层纸色雨线，近层快且粗，有视差 ——
// o: { amt 0..1 总量, layers 2|3, wind 斜率(x/y), speed 倍数, shiftX/shiftY 相机视差（=当前 cam.sx/sy，近层跟得多）,
//      clip: [[x,y]…] 屏幕多边形（只在里面下雨，室内镜头给窗外区域）, alpha }
export function rain(ctx, t, o = {}) {
  const amt = o.amt ?? 1; if (amt <= 0) return;
  const L = o.layers ?? 3, wind = o.wind ?? 0.22, sp = o.speed ?? 1, W = 1920, H = 1080;
  ctx.save();
  if (o.clip) { ctx.beginPath(); o.clip.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.clip(); }
  const LAY = [{ z: 0.3, n: 260, v: 900, len: 16, w: 1, a: 0.28 }, { z: 0.6, n: 150, v: 1500, len: 30, w: 1.4, a: 0.42 }, { z: 1.0, n: 70, v: 2300, len: 58, w: 2.4, a: 0.55 }].slice(3 - L);
  for (const [li, l] of LAY.entries()) {
    const n = Math.round(l.n * amt); ctx.strokeStyle = C.paperA(l.a * (o.alpha ?? 1)); ctx.lineWidth = l.w; ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const s = i * 13.7 + li * 101.3, vy = l.v * sp * (0.85 + 0.3 * hash(s + 2)), len = l.len * (0.7 + 0.6 * hash(s + 3));
      const span = H + len + 40, y = ((hash(s + 1) * span + t * vy) % span) - len - 20;
      const x = ((hash(s) * (W + 200) + y * wind - (o.shiftX ?? 0) * l.z) % (W + 200) + W + 200) % (W + 200) - 100;
      ctx.moveTo(x, y + (o.shiftY ?? 0) * l.z * 0.2); ctx.lineTo(x + len * wind, y + len + (o.shiftY ?? 0) * l.z * 0.2);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// —— 字幕条：现在段 = 墨色半透明条 + 纸色宋体；闪回段 = 宣纸色条 + 墨色宋体。底部 5% 安全区内 ——
export function subtitles(ctx, T, cues, hidden, styleOverride) {
  for (const c of cues) {
    if (T < c.t0 - 0.12 || T > c.t1 + 0.12 || hidden.has(c.id)) continue;
    const a = clamp((T - (c.t0 - 0.12)) / 0.12) * clamp(((c.t1 + 0.12) - T) / 0.12);
    const st = styleOverride ?? c.style, size = 36;
    ctx.save(); ctx.font = `${size}px ${FONT.serif(500)}`; ctx.letterSpacing = '2px';
    const w = ctx.measureText(c.text).width, cx = 960, yb = 1080 * 0.95 - 8, h = 60;
    ctx.globalAlpha = a;
    ctx.fillStyle = st === 'flash' ? C.paperA(0.88) : C.inkA(0.8);
    ctx.fillRect(cx - w / 2 - 34, yb - h, w + 68, h);
    if (st === 'flash') { ctx.strokeStyle = C.inkA(0.25); ctx.lineWidth = 1; ctx.strokeRect(cx - w / 2 - 34 + 0.5, yb - h + 0.5, w + 67, h - 1); }
    ctx.fillStyle = st === 'flash' ? C.ink : C.paper; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(c.text, cx, yb - h / 2 + 2);
    ctx.restore();
  }
}

// —— 水墨过渡（都锚在图坐标上，墨跟着画走）——
export function createInk(P) {
  return {
    // ① 刻线褪成宣纸：k 0→1，边缘先化开、中心最后，化开处带墨晕边。底下要先 clear 成纸色
    // 遮罩规则：噪声 n（加径向偏置）> 进度 p 的地方可见；p 从低往高走 = 逐渐消失
    fadeToPaper(id, cam, k, o = {}) {
      P.draw(id, cam, { mask: { p: -0.55 + 1.9 * ss(k), scale: o.scale ?? 170, soft: 0.06, seed: o.seed ?? 3, radial: o.radial ?? -0.9, center: o.center, rim: 0.9 }, alpha: o.alpha });
    },
    // ② 墨洇轮廓：白纸上按目标图的暗部洇出模糊墨块。k 0→1 墨从少到多
    bloom(id, cam, k, o = {}) {
      if (k <= 0) return;
      P.draw(id, cam, { blob: { mix: 1, lod: o.lod ?? 5.2, th: 0.74 - 0.18 * eo(k), soft: 0.07 }, mask: { p: 1.25 - 1.7 * eo(k), scale: 260, soft: 0.12, seed: o.seed ?? 5, radial: -0.5, center: o.center }, alpha: o.alpha });
    },
    // ③ 显影：墨块散开、原画完整显出。k 0→1；同一张图在 bloom(k=1) 之后接着用
    develop(id, cam, k, o = {}) {
      const e = eio(clamp(k));
      P.draw(id, cam, { lod: 3.2 * (1 - e), blob: { mix: 1 - e, lod: 5.2 - 1.5 * e, th: 0.56, soft: 0.07 + 0.2 * e }, alpha: o.alpha });
    },
    // ④ 水墨退去刻线回来：先画 to（刻线图），再盖 from（水墨图），from 被墨洞吃掉，洞口带墨晕
    recede(fromId, fromCam, toId, toCam, k, o = {}) {
      P.draw(toId, toCam, { alpha: clamp(k * 3) });
      P.draw(fromId, fromCam, { mask: { p: -0.6 + 2.2 * eio(k), scale: o.scale ?? 120, soft: 0.05, seed: o.seed ?? 9, radial: o.radial ?? 0.7, center: o.center, rim: 1.0 } });
    },
  };
}

// —— 穿越幕（段与段之间不硬切时用）：kind = 'fog' 雾（横向纸色刻痕 + 纸色漫开）| 'rain' 雨帘 | 'ink' 墨 | 'paper' 白纸
// k 0..1：出段时 0→1，入段时 1→0（两边用同一种 kind，交接帧 k=1 两边一致）。纸/墨整屏铺满的时间要 < 0.5 s（风格规定）
export function veil(ctx, t, kind, k, o = {}) {
  if (k <= 0) return; const W = 1920, H = 1080;
  ctx.save();
  if (kind === 'fog' || kind === 'paper') {
    const n = Math.round(420 * k);
    ctx.strokeStyle = C.paper; ctx.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const y = hash(i * 1.7) * H, len = 40 + 260 * hash(i * 2.3), x = ((hash(i * 3.1) * (W + 400) + t * (60 + 140 * hash(i)) * (o.dir ?? 1)) % (W + 400)) - 200;
      ctx.lineWidth = 1 + 5 * hash(i * 4.9) * k; ctx.globalAlpha = 0.5 + 0.5 * hash(i * 5.3);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + len, y + (hash(i * 6.1) - 0.5) * 4); ctx.stroke();
    }
    ctx.globalAlpha = kind === 'paper' ? ss(k) : ss(seg(k, 0.55, 1)); ctx.fillStyle = C.paper; ctx.fillRect(0, 0, W, H);
  } else if (kind === 'rain') {
    rain(ctx, t, { amt: 1 + 3 * k, layers: 3, speed: 1 + k, wind: o.wind ?? 0.22, shiftX: o.shiftX, alpha: 1 });
    ctx.globalAlpha = 0.85 * ss(seg(k, 0.6, 1)); ctx.fillStyle = C.ink; ctx.fillRect(0, 0, W, H);
  } else if (kind === 'ink') {
    ctx.globalAlpha = ss(k); ctx.fillStyle = C.ink; ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();
}
