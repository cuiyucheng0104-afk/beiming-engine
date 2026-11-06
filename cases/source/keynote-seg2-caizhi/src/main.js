// 片段二「材料变奏」：render(t) 确定性逐帧绘制。时间与布局全部来自 ../timeline.js。
import { DUR, BEAT, b, camX, L, CUE, SCRAPS, events } from '../timeline.js';
import { clamp, lerp, seg, ss, eo, eio, ei, vnoise, mulberry } from '/core/lib.js';
import { makeComp } from './comp.js';
import { arrival, makeMasker, diffuse } from './reveal.js';
import { cv, loadImg, mirrored, tileX, neutralGrain, clothTile, tile2 } from './assets.js';
import { column, pressChar, smallText, smallBox } from './glyph.js';
import { sealText, sealRosette, VERM } from './seal.js';
import { buildBorder, drawBorder, speckles } from './mural.js';
import { windowRoute, holePath, drawCut, flapCanvases, drawFlap, drawScissors, scrapShape } from './papercut.js';

const Q = new URLSearchParams(location.search);
const out = document.getElementById('c');
const comp = makeComp(out);
const base = cv(1920, 1080), wet = cv(1920, 1080), dry = cv(1920, 1080);
const G = base.getContext('2d'), WG = wet.getContext('2d'), DG = dry.getContext('2d');
const LI = { wet: WG, dry: DG };
const SW = 1920, SH = 1080;

// ---------- 加载 ----------
const M = 'material/';
const [I_xkd, I_mudi, I_jsl, I_tsq, I_hl, I_aft, I_paper, I_mural, I_red, I_silk] = await Promise.all(
  ['xkd', 'mudi', 'jiuselu', 'tianshu', 'hailuo', 'afanti', 'xuanzhi', 'bihua', 'hongzhi', 'lingjuan'].map(n => loadImg(M + n + '.png')));
await document.fonts.load('100px MaShanZheng', '水墨壁画纸偶1960');
await document.fonts.load('500 30px NotoSerifSC', '疏密、停顿与声音色彩与纹样木偶动画《》小蝌蚪找妈妈牧笛九色鹿天书奇谭金色的海螺阿凡提的故事');

const T_paper = mirrored(I_paper, 'rgb(255,252,246)');
const T_mural = mirrored(I_mural);
const T_red = mirrored(I_red, 'rgb(238,236,236)');
const T_cloth = clothTile(1024, 7);
const GR_paper = neutralGrain(I_paper, 1200, 720, 5, 4);
const GR_mural = neutralGrain(I_mural, 1200, 720, 6, 1.6);
const GR_cloth = neutralGrain(T_cloth, 1024, 720, 4, 1.4);

// ---------- 元件几何与显影场 ----------
const X = L.xkd, xb = X.border, XO = { w: X.w + xb * 2, h: X.h + xb * 2 };
const xkdLocalRipple = [L.ripple.x - (X.cx - XO.w / 2), L.ripple.y - (X.cy - XO.h / 2)];
const F_xkd = arrival({ w: XO.w, h: XO.h, cell: 4, seed: 11, seeds: [[...xkdLocalRipple, 0], [XO.w * .2, XO.h * .42, .25], [XO.w * .55, XO.h * .8, .4]], grain: .012 });
const MK_xkdI = makeMasker(F_xkd, { wdt: .03, bandW: .03, bandA: .5 });
const MK_xkdM = makeMasker(F_xkd, { wdt: .05, bandW: .02, bandA: 0 });

const MD = L.mudi, mdB = 22, mdTian = 118, mdDi = 64;
const MDO = { w: MD.w + mdB * 2, h: mdTian + mdB * 2 + MD.h + mdDi };
const F_mudi = arrival({ w: MD.w, h: MD.h, cell: 4, seed: 23, seeds: [[MD.w * .15, 0, 0], [MD.w * .5, 0, .08], [MD.w * .85, 0, .03], [MD.w * .62, MD.h * .1, .1]], aniso: [.7, 1.5], grain: .012 });
const MK_mudi = makeMasker(F_mudi, { wdt: .03, bandW: .03, bandA: .5 });

const J = L.jsl, JO = { w: J.w + J.band * 2, h: J.h + J.band * 2 };
const B_jsl = buildBorder(JO.w, JO.h, J.band, 'vine', 3);
const F_jsl = arrival({ w: J.w, h: J.h, cell: 4, seed: 31, seeds: [[J.w * .95, J.h * .5, 0], [J.w * .5, J.h * .15, .2], [J.w * .5, J.h * .85, .2]], grain: .04, fib: 2.2 });
const MK_jsl = makeMasker(F_jsl, { wdt: .025, bandW: .035, bandA: .7 });
const SP_jsl = speckles(JO.w, JO.h, 5);

const TS = L.tsq, TO = { w: TS.w + TS.band * 2, h: TS.h + TS.band * 2 };
const B_tsq = buildBorder(TO.w, TO.h, TS.band, 'cloud', 7);
const F_tsq = arrival({ w: TS.w, h: TS.h, cell: 4, seed: 41, seeds: [[TS.w * .98, TS.h * .5, 0], [TS.w * .6, TS.h * .1, .15], [TS.w * .6, TS.h * .9, .15]], grain: .04, fib: 2.2 });
const MK_tsq = makeMasker(F_tsq, { wdt: .025, bandW: .035, bandA: .7 });
const SP_tsq = speckles(TO.w, TO.h, 9);

const WN = L.win, WR = windowRoute(WN.w / 2 + 22, WN.h / 2 + 22);
const FL = flapCanvases(WR, T_red);

// 布幕显影场（世界区域，围绕油灯）
const LP = L.lamp, CL = { x0: LP.x - 2600, y0: 0, w: 4200, h: 1080, cell: 10 };
const F_cloth = arrival({ w: CL.w / 4, h: CL.h / 4, cell: 3, seed: 53, seeds: [[(LP.x - CL.x0) / 4, LP.y / 4, 0]], grain: .01, fib: 4 });
const MK_cloth = makeMasker(F_cloth, { wdt: .035, bandW: .03, bandA: .9 });

const A = L.aft;
// 壁画边界遮罩（世界 x：xEarth-120 … xPaper+80）
const MU = L.mural, MUx0 = MU.xEarth - 160, MUw = MU.xPaper - MU.xEarth + 260;
// 土色"渗"进纸：世界空间的渗透顺序场 v（越靠左越早），随 b15.2→b18 的进度推进；颗粒化边缘
const MUS = 2, MUgw = Math.ceil(MUw / MUS), MUgh = Math.ceil(SH / MUS), MU_v = new Float32Array(MUgw * MUgh);
const MU_mask = cv(MUgw, MUgh), MU_g = MU_mask.getContext('2d'), MU_I = MU_g.createImageData(MUgw, MUgh);
{
  const F = await import('./reveal.js');
  const ar = F.arrival({ w: MUw, h: SH, cell: 8, seed: 61, seeds: Array.from({ length: 28 }, (_, i) => [0, i * 40, 0]), aniso: [1.25, .8], grain: 0 });
  for (let y = 0; y < MUgh; y++) for (let x = 0; x < MUgw; x++) {
    const X2 = x * MUS, Y2 = y * MUS;
    MU_v[y * MUgw + x] = ar.A[Math.min(ar.h - 1, Y2) * ar.w + Math.min(ar.w - 1, X2)] + .05 * (vnoise(X2 * .37 + Y2 * .11) - .5) + .04 * (vnoise(X2 * .05 + Y2 * .9) - .5);
  }
}
let MU_last = -1;
function muralMask(t) {
  const k = eo(seg(t, B(MU.soak[0]), B(MU.soak[1])));
  const th = .3 + .56 * k;          // 阈值：开始时只有左半边是土，b18 时整条带都是土
  if (th === MU_last) return MU_mask; MU_last = th;
  const d = MU_I.data;
  for (let i = 0, q = 3; i < MU_v.length; i++, q += 4) { const e = (th - MU_v[i]) / .13; d[q] = e <= 0 ? 0 : e >= 1 ? 255 : e * 255; }
  MU_g.putImageData(MU_I, 0, 0); return MU_mask;
}

// 印章
const S1960 = sealText(['19', '60'], 108, 5);
const SROS = sealRosette(112, 11);

// ---------- 小工具 ----------
const sx = (wx, cam) => wx - cam;
const onScreen = (x0, x1) => x1 > -40 && x0 < SW + 40;
const scratch = {};
const tmp = (k, w, h) => { let c = scratch[k]; if (!c || c.width !== Math.ceil(w) || c.height !== Math.ceil(h)) c = scratch[k] = cv(w, h); const g = c.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.filter = 'none'; g.clearRect(0, 0, c.width, c.height); return [c, g]; };
const B = n => b(n);
const flick = t => 1 + .028 * (vnoise(t * 7.3) - .5) * 2 + .012 * Math.sin(t * 31.7) + .01 * Math.sin(t * 13.1 + 1);

function drawSeal(g, S, x, y, tHit, t, op = 'multiply') {
  if (t < tHit - .1) return;
  const u = clamp((t - (tHit - .1)) / .1), sc = 1 + .35 * (1 - ei(u)) + .006 * clamp((t - tHit) / .6);
  g.save(); g.globalCompositeOperation = op; g.globalAlpha = clamp(u * 1.4);
  g.translate(x, y); g.scale(sc, sc); g.drawImage(S.c, -S.c.width / 2, -S.c.height / 2); g.restore();
}

// 一个显影的 IP 图：局部画布里画图 + 中性纹理（≤12%），再用遮罩显影
function revealImage(key, img, w, h, mask, grain, grainA = .1) {
  const [c, g] = tmp(key, w, h);
  g.drawImage(img, 0, 0, w, h);
  if (grain && grainA > 0) { g.globalCompositeOperation = 'overlay'; g.globalAlpha = grainA; g.drawImage(grain, 0, 0, w, h, 0, 0, w, h); g.globalAlpha = 1; }
  if (mask) { g.globalCompositeOperation = 'destination-in'; g.drawImage(mask, 0, 0, w, h); }
  g.globalCompositeOperation = 'source-over';
  return c;
}
// 擦掉图上的墨（墨只在前沿出现，原图不被墨盖住）
function eraseInk(mask, x, y, w, h) {
  for (const g of [WG, DG]) { g.save(); g.globalCompositeOperation = 'destination-out'; g.drawImage(mask, x, y, w, h); g.restore(); }
}

// ---------- 文字登记（readcheck） ----------
let TXT = [];
const reg = (id, text, box) => TXT.push({ id, text, x0: box[0], y0: box[1], x1: box[2], y1: box[3] });

// ================= render =================
const CAMT = Q.has('camT') ? +Q.get('camT') : null;   // 检查用：冻结镜头，只看事件本身的变化
function render(t) {
  const cam = camX(CAMT ?? t);
  TXT = [];
  G.setTransform(1, 0, 0, 1, 0, 0); G.globalAlpha = 1; G.globalCompositeOperation = 'source-over'; G.filter = 'none';
  for (const g of [WG, DG]) { g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.filter = 'none'; g.clearRect(0, 0, SW, SH); }
  let zoom = 1, zc = [SW / 2, SH / 2];

  // 1 纸
  tileX(G, T_paper, cam);

  // 2 壁画土墙（世界空间渐变）
  const mx0 = sx(MUx0, cam);
  if (mx0 >= SW) tileX(G, T_mural, cam);
  else if (mx0 + MUw > 0 || true) {
    const [mc, mg] = tmp('mural', SW, SH);
    tileX(mg, T_mural, cam);
    const [ac, ag] = tmp('muralA', SW, SH);
    ag.fillStyle = '#000'; if (mx0 > 0) ag.fillRect(0, 0, Math.min(SW, mx0 + 1), SH);
    if (mx0 + MUw > 0) { ag.imageSmoothingEnabled = true; ag.drawImage(muralMask(t), mx0, 0, MUgw * MUS, MUgh * MUS); }
    mg.globalCompositeOperation = 'destination-in'; mg.drawImage(ac, 0, 0); mg.globalCompositeOperation = 'source-over';
    G.drawImage(mc, 0, 0);
  }

  // ---------------- A7 水墨 ----------------
  // 水纹（湿墨，开放的环）
  {
    const rx = sx(L.ripple.x, cam), ry = L.ripple.y;
    if (t >= 0 && rx > -400 && rx < SW + 400) {
      const age0 = t - B(CUE.drop);
      // 墨点
      WG.save(); WG.fillStyle = '#000';
      const dr = 4 + 7 * eo(clamp(age0 / .45)), da = .55 * (1 - .75 * clamp(age0 / 3));
      WG.globalAlpha = da; WG.beginPath(); WG.ellipse(rx, ry, dr, dr * .92, 0, 0, 7); WG.fill(); WG.restore();
      const rings = [0, .38, .9, 1.6];
      rings.forEach((d0, i) => {
        const age = age0 - d0; if (age <= 0) return;
        const r = 9 + 250 * Math.sqrt(age / 6.5) * (1 - .12 * i), a = .42 * Math.pow(clamp(1 - age / (6.8 - i * .6)), 1.4) * (1 - .18 * i);
        if (a <= .004) return;
        WG.save(); WG.strokeStyle = '#000'; WG.lineCap = 'round'; WG.lineWidth = Math.max(.8, 2.6 - age * .25);
        const nseg = 9;
        for (let k = 0; k < nseg; k++) {
          const a0 = k / nseg * Math.PI * 2 + i * .7 + vnoise(i * 9 + k) * .4, span = (Math.PI * 2 / nseg) * (.35 + .5 * vnoise(i * 13 + k * 3.1));
          WG.globalAlpha = a * (.5 + .5 * vnoise(k * 2.3 + i)); WG.beginPath(); WG.ellipse(rx, ry, r, r * .96, 0, a0, a0 + span); WG.stroke();
        }
        WG.restore();
      });
    }
  }

  // 小蝌蚪找妈妈：横披
  {
    const ox = sx(X.cx - XO.w / 2, cam), oy = X.cy - XO.h / 2;
    if (onScreen(ox, ox + XO.w) && t >= B(4)) {
      const pm = diffuse(seg(t, B(4), B(5.5)), 1.08), pi = diffuse(seg(t, B(4.15), B(CUE.xkdBloom[1])), 1.1);
      const mm = MK_xkdM(pm).mask;
      const [lc, lg] = tmp('xkdM', XO.w, XO.h);
      lg.drawImage(I_silk, 200, 200, XO.w, XO.h, 0, 0, XO.w, XO.h);
      lg.strokeStyle = 'rgba(110,88,60,.55)'; lg.lineWidth = 1.2; lg.strokeRect(.6, .6, XO.w - 1.2, XO.h - 1.2); lg.strokeRect(xb - 1.5, xb - 1.5, X.w + 3, X.h + 3);
      lg.globalCompositeOperation = 'destination-in'; lg.drawImage(mm, 0, 0); lg.globalCompositeOperation = 'source-over';
      G.save(); G.globalCompositeOperation = 'multiply'; G.drawImage(lc, ox, oy); G.restore();   // 绫绢吃进纸里
      const { mask, band } = MK_xkdI(pi);
      // 遮罩取画芯部分
      const [mc2, mg2] = tmp('xkdIM', X.w, X.h); mg2.drawImage(mask, -xb, -xb);
      const im = revealImage('xkdI', I_xkd, X.w, X.h, mc2, GR_paper, .1);
      G.drawImage(im, ox + xb, oy + xb);
      eraseInk(mc2, ox + xb, oy + xb, X.w, X.h);
      if (pi < 1.2) { WG.save(); WG.beginPath(); WG.rect(ox + xb, oy + xb, X.w, X.h); WG.clip(); WG.globalAlpha = .9; WG.drawImage(band, ox, oy); WG.restore(); }
    }
    if (t >= B(CUE.xkdLabel)) {
      const lx = sx(X.cx - XO.w / 2, cam), ly = X.cy + XO.h / 2 + 40, k = seg(t, B(CUE.xkdLabel), B(CUE.xkdLabel) + .45);
      smallText(G, '《小蝌蚪找妈妈》', 26, lx, ly, k); reg('l_xkd', '《小蝌蚪找妈妈》', smallBox('《小蝌蚪找妈妈》', 26, lx, ly));
    }
  }
  // 朱印「1960」（横披右下）
  {
    const x = sx(X.cx + XO.w / 2 + 92, cam), y = X.cy + 150;
    if (t >= B(CUE.seal1960) - .1 && x > -100 && x < SW + 100) {
      drawSeal(G, S1960, x, y, B(CUE.seal1960), t);
      reg('seal1960', '1960', [x - 54, y - 54, x + 54, y + 54]);
      if (t >= B(4)) { const d = t - B(4); zoom = 1 + .009 * Math.exp(-d / .045); zc = [x, y]; }
    }
  }
  // 竖排「水墨」+ 小字
  {
    const x = sx(L.shuimo.x, cam);
    if (x > -150 && x < SW + 150) {
      const p1 = seg(t, B(CUE.shui[0]), B(CUE.shui[1])), p2 = seg(t, B(CUE.mo[0]), B(CUE.mo[1]));
      column(LI, '水墨', L.shuimo.size, x, L.shuimo.y, [p1, p2], { wet: .45 });
      if (p1 > 0) reg('shuimo', '水墨', [x - 62, L.shuimo.y, x + 62, L.shuimo.y + 2 * L.shuimo.size * 1.06]);
      const nx = sx(L.shuimoNote.x, cam), k = seg(t, B(CUE.shuimoNote), B(CUE.shuimoNote) + .5);
      smallText(G, '疏密、停顿与声音', 30, nx, L.shuimoNote.y, k, { vertical: true });
      if (k > 0) reg('shuimoNote', '疏密、停顿与声音', smallBox('疏密、停顿与声音', 30, nx, L.shuimoNote.y, { vertical: true }));
    }
  }
  // 牧笛：立轴
  {
    const cx = sx(MD.cx, cam), mw = MDO.w, top = MD.top;
    if (t >= B(CUE.mudiUnroll[0]) && onScreen(cx - mw, cx + mw)) {
      const u = seg(t, B(CUE.mudiUnroll[0]), B(CUE.mudiUnroll[1]));
      const finalY = top + MDO.h, startY = top + 26;
      let ry = lerp(startY, finalY, eio(u));
      if (t > B(CUE.mudiUnroll[1])) { const d = t - B(CUE.mudiUnroll[1]); ry = finalY - 7 * Math.exp(-d * 7) * Math.sin(d * 26); }
      const x0 = cx - mw / 2;
      // 挂绳与天杆
      DG.save(); DG.strokeStyle = 'rgba(0,0,0,.55)'; DG.lineWidth = 1.4; DG.beginPath(); DG.moveTo(x0 + 18, top); DG.lineTo(cx, top - 62); DG.lineTo(x0 + mw - 18, top); DG.stroke();
      DG.globalAlpha = .7; DG.beginPath(); DG.arc(cx, top - 64, 3.2, 0, 7); DG.fillStyle = '#000'; DG.fill(); DG.restore();
      // 投影
      G.save(); G.globalAlpha = .2; G.filter = 'blur(10px)'; G.fillStyle = '#3a2a18'; G.fillRect(x0 + 8, top + 8, mw, ry - top); G.restore();
      // 绫绢
      const [sc, sg] = tmp('mudiM', mw, MDO.h + 4);
      sg.drawImage(I_silk, 900, 300, mw, MDO.h, 0, 0, mw, MDO.h);
      sg.globalCompositeOperation = 'multiply'; sg.fillStyle = 'rgb(214,200,176)'; sg.fillRect(0, 0, mw, mdTian); sg.fillRect(0, MDO.h - mdDi, mw, mdDi); sg.globalCompositeOperation = 'source-over';
      sg.strokeStyle = 'rgba(110,88,60,.5)'; sg.lineWidth = 1.2; sg.strokeRect(mdB - 1.5, mdTian + mdB - 1.5, MD.w + 3, MD.h + 3);
      sg.strokeStyle = 'rgba(110,88,60,.35)'; sg.beginPath(); sg.moveTo(0, mdTian); sg.lineTo(mw, mdTian); sg.moveTo(0, MDO.h - mdDi); sg.lineTo(mw, MDO.h - mdDi); sg.stroke();
      // 画芯显影
      if (t >= B(CUE.mudiBloom[0])) {
        const p = diffuse(seg(t, B(CUE.mudiBloom[0]), B(CUE.mudiBloom[1])), 1.1);
        const { mask, band } = MK_mudi(p);
        const im = revealImage('mudiI', I_mudi, MD.w, MD.h, mask, GR_paper, .1);
        sg.drawImage(im, mdB, mdTian + mdB);
        if (p < 1.2) { WG.save(); WG.globalAlpha = .9; WG.drawImage(band, x0 + mdB, top + mdTian + mdB); WG.restore(); }
      }
      // 只显示卷轴以上部分
      G.save(); G.beginPath(); G.rect(x0 - 2, top, mw + 4, ry - top); G.clip(); G.drawImage(sc, x0, top); G.restore();
      // 天杆
      G.fillStyle = '#4a3322'; G.fillRect(x0 - 6, top - 4, mw + 12, 8);
      // 地杆（卷轴）
      const rg = G.createLinearGradient(0, ry - 12, 0, ry + 12); rg.addColorStop(0, '#5a3d27'); rg.addColorStop(.45, '#8a6443'); rg.addColorStop(1, '#2e1f14');
      G.fillStyle = rg; G.fillRect(x0 - 4, ry - 11, mw + 8, 22);
      G.fillStyle = '#2a1a10'; G.fillRect(x0 - 22, ry - 9, 18, 18); G.fillRect(x0 + mw + 4, ry - 9, 18, 18);
      G.fillStyle = 'rgba(255,230,190,.25)'; G.fillRect(x0 - 4, ry - 6, mw + 8, 3);
    }
    if (t >= B(CUE.mudiLabel)) {
      const k = seg(t, B(CUE.mudiLabel), B(CUE.mudiLabel) + .45), ly = MD.top + MDO.h + 52;
      smallText(G, '《牧笛》', 26, cx, ly, k, { align: 'center' }); reg('l_mudi', '《牧笛》', smallBox('《牧笛》', 26, cx, ly, { align: 'center' }));
    }
  }

  // ---------------- A8 壁画 ----------------
  {
    const x = sx(L.bihua.x, cam);
    if (x > -150 && x < SW + 150) {
      const p1 = seg(t, B(CUE.bi[0]), B(CUE.bi[1])), p2 = seg(t, B(CUE.hua[0]), B(CUE.hua[1]));
      column(LI, '壁画', L.bihua.size, x, L.bihua.y, [p1, p2], { wet: .4 });
      if (p1 > 0) reg('bihua', '壁画', [x - 62, L.bihua.y, x + 62, L.bihua.y + 2 * L.bihua.size * 1.06]);
      const nx = sx(L.bihuaNote.x, cam), k = seg(t, B(CUE.bihuaNote), B(CUE.bihuaNote) + .5);
      smallText(G, '色彩与纹样', 30, nx, L.bihuaNote.y, k, { vertical: true, color: '#4a3a2c' });
      if (k > 0) reg('bihuaNote', '色彩与纹样', smallBox('色彩与纹样', 30, nx, L.bihuaNote.y, { vertical: true }));
    }
  }
  const muralFrame = (key, Fr, OO, Bd, grow, colorB, bloom, MK, img, SP, label, labelT) => {
    const ox = sx(Fr.cx - OO.w / 2, cam), oy = Fr.cy - OO.h / 2;
    if (!onScreen(ox, ox + OO.w) || t < B(grow[0])) return;
    const n = grow.length, seglen = Bd.path.L / n;
    let front = 0;
    for (let i = 0; i < n; i++) front += seglen * eo(seg(t, B(grow[i]), B(grow[i] + .8)));
    const [lc, lg] = tmp(key, OO.w, OO.h);
    // 画芯处的凹槽（浅暗）
    if (t >= B(bloom[0])) {
      const p = diffuse(seg(t, B(bloom[0]), B(bloom[1])), 1.1);
      const { mask, band } = MK(p);
      const im = revealImage(key + 'I', img, Fr.w, Fr.h, mask, GR_mural, .1);
      lg.drawImage(im, Fr.band, Fr.band);
      if (p < 1.2) { const [bc, bg] = tmp(key + 'B', Fr.w, Fr.h); bg.drawImage(band, 0, 0); bg.globalCompositeOperation = 'source-in'; bg.fillStyle = 'rgb(92,58,30)'; bg.fillRect(0, 0, Fr.w, Fr.h); lg.drawImage(bc, Fr.band, Fr.band); }
      lg.strokeStyle = `rgba(56,34,20,${.8 * clamp(p)})`; lg.lineWidth = 1.6; lg.strokeRect(Fr.band - .5, Fr.band - .5, Fr.w + 1, Fr.h + 1);
    }
    const colorAt = e => { const j = Math.min(n - 1, Math.floor(e.s / seglen)); return eo(seg(t, B(colorB[j]), B(colorB[j]) + .2)); };
    drawBorder(lg, Bd, front, colorAt, SP);
    G.drawImage(lc, ox, oy);
    if (t >= B(labelT)) {
      const k = seg(t, B(labelT), B(labelT) + .45), lx = ox + OO.w / 2, ly = oy + OO.h + 36;
      smallText(G, label, 26, lx, ly, k, { align: 'center', color: '#4a3a2c' }); reg('l_' + key, label, smallBox(label, 26, lx, ly, { align: 'center' }));
    }
  };
  muralFrame('jsl', J, JO, B_jsl, CUE.jslGrow, CUE.jslColor, CUE.jslBloom, MK_jsl, I_jsl, SP_jsl, '《九色鹿》', CUE.jslLabel);
  muralFrame('tsq', TS, TO, B_tsq, CUE.tsqGrow, CUE.tsqColor, CUE.tsqBloom, MK_tsq, I_tsq, SP_tsq, '《天书奇谭》', CUE.tsqLabel);

  // ---------------- A9 纸 ----------------
  const xs = L.xseal, SHT = L.sheet;
  const wcx = sx(WN.cx, cam), wcy = WN.cy;
  let sheetOn = false;
  if (t >= B(CUE.xseal) - .1 && t < B(CUE.expand[0])) {
    const x = sx(xs.x, cam);
    drawSeal(G, SROS, x, xs.y, B(CUE.xseal), t, 'source-over');
    if (t >= B(CUE.xseal)) { const d = t - B(CUE.xseal); zoom = 1 + .007 * Math.exp(-d / .045); zc = [x, xs.y]; }
  }
  if (t >= B(CUE.expand[0])) {
    sheetOn = true;
    const u = eio(seg(t, B(CUE.expand[0]), B(CUE.expand[1])));
    const px = xs.x, py = xs.y, h0 = xs.size / 2;
    const gi = (d0, d1) => d0 * Math.pow(d1 / d0, u);
    const r = { x0: px - gi(h0, px - SHT.x0), x1: px + gi(h0, SHT.x1 - px), y0: py - gi(h0, py - SHT.y0), y1: py + gi(h0, SHT.y1 - py) };
    const X0 = sx(r.x0, cam), X1 = sx(r.x1, cam);
    // 纸下投影
    if (u < 1) { G.save(); G.globalAlpha = .35; G.filter = 'blur(14px)'; G.fillStyle = '#2a0c06'; G.fillRect(X0 + 10, r.y0 + 14, X1 - X0, r.y1 - r.y0); G.restore(); }
    const path = new Path2D();
    const N = 24, wob = (i, s) => (vnoise(i * 1.7 + s) - .5) * 6;
    path.moveTo(X0, r.y0);
    for (let i = 1; i <= N; i++) path.lineTo(lerp(X0, X1, i / N), r.y0 + wob(i, 1));
    for (let i = 1; i <= N; i++) path.lineTo(X1 + wob(i, 2), lerp(r.y0, r.y1, i / N));
    for (let i = 1; i <= N; i++) path.lineTo(lerp(X1, X0, i / N), r.y1 + wob(i, 3));
    for (let i = 1; i <= N; i++) path.lineTo(X0 + wob(i, 4), lerp(r.y1, r.y0, i / N));
    path.closePath();
    const opened = t >= B(CUE.open);
    // 窗洞里：深色衬底 + 金色的海螺
    if (opened) {
      G.save(); G.beginPath(); holePath(G, WR, wcx, wcy); G.clip();
      G.fillStyle = '#2b1d16'; G.fillRect(wcx - WR.hw - 4, wcy - WR.hh - 60, WR.hw * 2 + 8, WR.hh * 2 + 70);
      const im = revealImage('hlI', I_hl, WN.w, WN.h, null, null, 0);
      G.drawImage(im, wcx - WN.w / 2, wcy - WN.h / 2);
      G.restore();
    }
    G.save();
    if (opened) { const p2 = new Path2D(path); holePath(p2, WR, wcx, wcy); G.clip(p2, 'evenodd'); } else G.clip(path);
    tileX(G, T_red, cam, 0, SW, 0, SH);
    if (u < 1) {   // 印 → 纸：朱红与团花逐渐退去
      const k = clamp(1 - u * 1.7);
      if (k > 0) {
        G.globalAlpha = k; G.fillStyle = `rgb(${VERM.join(',')})`; G.fillRect(X0, r.y0, X1 - X0, r.y1 - r.y0);
        G.save(); G.translate(sx(px, cam), py); const s = (r.x1 - r.x0) / xs.size; G.scale(s, (r.y1 - r.y0) / xs.size);
        G.drawImage(SROS.c, -SROS.c.width / 2, -SROS.c.height / 2); G.restore(); G.globalAlpha = 1;
      }
    }
    // 折痕（团花留下的）
    const ck = clamp((u - .5) * 2) * .08;
    if (ck > 0) {
      G.save(); G.translate(wcx, wcy);
      for (const a of [0, Math.PI / 4, Math.PI / 2, Math.PI * 3 / 4]) {
        G.rotate(a); G.globalAlpha = ck; G.strokeStyle = 'rgba(255,200,190,1)'; G.lineWidth = 1.2; G.beginPath(); G.moveTo(-900, 0); G.lineTo(900, 0); G.stroke();
        G.strokeStyle = 'rgba(60,0,0,1)'; G.beginPath(); G.moveTo(-900, 1.5); G.lineTo(900, 1.5); G.stroke(); G.rotate(-a);
      }
      G.restore();
    }
    G.restore();
    // 纸上不应留下前面段落的墨
    for (const g of [WG, DG]) { g.save(); g.globalCompositeOperation = 'destination-out'; g.fill(path); g.restore(); }
    // 窗洞内阴影（纸厚）
    if (opened) { G.save(); G.beginPath(); holePath(G, WR, wcx, wcy); G.clip(); G.lineWidth = 16; G.strokeStyle = 'rgba(0,0,0,.35)'; G.filter = 'blur(6px)'; G.beginPath(); holePath(G, WR, wcx + 5, wcy + 6); G.stroke(); G.restore(); }
    // 剪缝
    const snips = CUE.snips.map(B), q = B(.25);
    let sFront = 0, open = 0, kIdx = -1;
    for (let k = 0; k < 20; k++) {
      const t1 = snips[k], t0 = t1 - q;
      if (t >= t1) sFront = WR.L * (k + 1) / 20;
      else if (t >= t0) { const ph = (t - t0) / q; sFront = WR.L * (k + eo(seg(ph, .45, 1))) / 20; open = ph < .45 ? Math.sin(ph / .45 * Math.PI / 2) : 1 - eo(seg(ph, .45, 1)); kIdx = k; break; }
    }
    if (t >= B(28) && !opened) drawCut(G, WR, wcx, wcy, sFront, 'rgba(70,4,4,.9)', 1.7);
    if (t >= B(CUE.loosen) && !opened) { // 剪完，窗扇微微翘起
      const lk = ss(seg(t, B(CUE.loosen), B(CUE.loosen) + .25));
      G.save(); G.globalAlpha = .3 * lk; G.lineWidth = 3; drawCut(G, WR, wcx + 2, wcy + 3, WR.L, 'rgba(20,0,0,1)', 3); G.restore();
    }
    // 窗扇
    if (opened) {
      const ph = seg(t, B(CUE.open), B(CUE.open) + .3), th = Math.PI * eo(ph);
      drawFlap(G, FL, WR, wcx, wcy, th, .14 * ph);
    }
    // 碎纸
    for (const S of SCRAPS) {
      if (t < S.tSnip) continue;
      const p0 = WR.at(WR.L * (S.k + .5) / 20), a = seg(t, S.tSnip, S.tLand), e = eo(a), h = Math.sin(Math.PI * a);
      const x = wcx + p0.x - p0.ty * 6 + S.dx * e, y = wcy + p0.y + p0.tx * 6 + S.dy * e;
      const backSide = S.flip && a > .5;
      G.save(); G.translate(x + 3 + 12 * h, y + 4 + 14 * h); G.rotate(S.rot * e); G.scale(1 + .3 * h, 1 + .3 * h);
      G.globalAlpha = .25 + .1 * (1 - h); G.filter = `blur(${(1 + 4 * h).toFixed(1)}px)`; scrapShape(G, S.size, S.seed); G.fillStyle = '#300'; G.fill(); G.restore();
      G.save(); G.translate(x, y); G.rotate(S.rot * e); G.scale((1 + .3 * h) * (S.flip ? Math.cos(Math.PI * a) || .05 : 1), 1 + .3 * h);
      scrapShape(G, S.size, S.seed); G.fillStyle = backSide ? '#e46a5c' : '#d42a22'; G.fill(); G.strokeStyle = 'rgba(90,0,0,.5)'; G.lineWidth = .8; G.stroke(); G.restore();
    }
    // 剪刀
    if (t >= B(27.8) && t < B(33.6)) {
      const lift = t < B(28) ? 1 - ss(seg(t, B(27.8), B(28))) : t > B(33) ? ss(seg(t, B(33), B(33.6))) : 0;
      const p = WR.at(Math.min(sFront, WR.L - .1));
      drawScissors(G, wcx + p.x - lift * 40, wcy + p.y - lift * 120, p.tx, p.ty, open, lift);
    }
    // 竖排「纸」（墨书于红纸）+ 片名
    const zx = sx(L.zhi.x, cam);
    if (zx > -150 && zx < SW + 150) {
      const p1 = seg(t, B(CUE.zhi[0]), B(CUE.zhi[1]));
      column(LI, '纸', L.zhi.size, zx, L.zhi.y, [p1], { wet: .35 });
      if (p1 > 0) reg('zhi', '纸', [zx - 68, L.zhi.y, zx + 68, L.zhi.y + L.zhi.size * 1.06]);
    }
    if (t >= B(CUE.hailuoLabel) && opened) {
      const k = seg(t, B(CUE.hailuoLabel), B(CUE.hailuoLabel) + .45), ly = wcy + WR.hh + 52;
      smallText(G, '《金色的海螺》', 26, wcx, ly, k, { align: 'center', color: '#f4e2c6' }); reg('l_hl', '《金色的海螺》', smallBox('《金色的海螺》', 26, wcx, ly, { align: 'center' }));
    }
  }

  // ---------------- A10 偶：灯在纸后亮起 ----------------
  if (t >= B(CUE.match)) {
    const lx = sx(LP.x, cam), ly = LP.y, tl = B(CUE.lamp);
    let I = 0;
    if (t < tl) { const a = seg(t, B(CUE.match), tl); I = .05 + .05 * a + .03 * Math.sin(t * 61); }
    else I = 1 + .45 * Math.exp(-(t - tl) / .16);
    I *= flick(t);
    const tw = t - B(CUE.last);
    let wob = 0, dip = 0;
    if (tw > 0) { wob = 16 * Math.exp(-tw * 2.4) * Math.sin(tw * 2 * Math.PI * 3.1); dip = .2 * Math.exp(-tw * 3.5); }
    I *= 1 - dip;
    const amb = t < tl ? 1 : 1 - .52 * ss(seg(t, tl, tl + 1.2));
    const hx = lx + wob, hy = ly - 4 * Math.abs(wob) / 16;
    // 光场
    const [lc, lg] = tmp('light', SW, SH);
    lg.fillStyle = '#000'; lg.fillRect(0, 0, SW, SH);
    lg.globalCompositeOperation = 'lighter';
    const lobe = (r, a, col) => { const gr = lg.createRadialGradient(hx, hy, 0, hx, hy, r); gr.addColorStop(0, `rgba(${col},${a})`); gr.addColorStop(.3, `rgba(${col},${a * .85})`); gr.addColorStop(.6, `rgba(${col},${a * .5})`); gr.addColorStop(1, `rgba(${col},${a * .12})`); lg.fillStyle = gr; lg.fillRect(0, 0, SW, SH); };
    lobe(1900, clamp(.92 * I), '255,192,124');
    lobe(150, clamp(.3 * I), '255,240,210');
    lg.globalCompositeOperation = 'source-over';
    // 红纸背光
    const [rc, rg] = tmp('redBL', SW, SH);
    tileX(rg, T_red, cam); rg.globalCompositeOperation = 'multiply'; rg.drawImage(lc, 0, 0);
    // 窗洞不透光（窗里是画）
    rg.globalCompositeOperation = 'destination-out'; rg.beginPath(); holePath(rg, WR, wcx, wcy); rg.fill(); rg.globalCompositeOperation = 'source-over';
    // 布幕
    const pc = t < B(CUE.cloth[0]) ? 0 : diffuse(seg(t, B(CUE.cloth[0]), B(CUE.cloth[1])), 1.12);
    // 暗下来的正面光
    G.save(); G.globalCompositeOperation = 'multiply'; const av = Math.round(255 * amb); G.fillStyle = `rgb(${av},${Math.round(av * .97)},${Math.round(av * .94)})`; G.fillRect(0, 0, SW, SH); G.restore();
    G.save(); G.globalCompositeOperation = 'lighter'; G.globalAlpha = .9; G.drawImage(rc, 0, 0); G.restore();
    // 剪缝透光
    if (sheetOn) { G.save(); G.globalCompositeOperation = 'lighter'; G.globalAlpha = clamp(I * .8); drawCut(G, WR, wcx, wcy, WR.L, 'rgba(255,170,90,1)', 1.6); G.restore(); }
    if (pc > 0) {
      const { mask, band } = MK_cloth(pc);
      const [cc, cg] = tmp('cloth', SW, SH);
      tile2(cg, T_cloth, cam, 0, 0, SW, SH);
      const [ccl, ccg] = tmp('clothL', SW, SH); ccg.drawImage(cc, 0, 0); ccg.globalCompositeOperation = 'multiply'; ccg.drawImage(lc, 0, 0);
      cg.globalCompositeOperation = 'multiply'; cg.fillStyle = `rgb(${Math.round(255 * amb * .3)},${Math.round(255 * amb * .28)},${Math.round(255 * amb * .26)})`; cg.fillRect(0, 0, SW, SH);
      cg.globalCompositeOperation = 'lighter'; cg.drawImage(ccl, 0, 0); cg.globalAlpha = .22; cg.drawImage(ccl, 0, 0); cg.globalAlpha = 1;
      // 暖色晕影（往棕色，不往灰）
      cg.globalCompositeOperation = 'multiply'; const vg = cg.createRadialGradient(hx, hy, 500, hx, hy, 1900); vg.addColorStop(0, 'rgb(255,255,255)'); vg.addColorStop(1, 'rgb(170,122,84)'); cg.fillStyle = vg; cg.fillRect(0, 0, SW, SH);
      cg.globalCompositeOperation = 'destination-in';
      const mX = sx(CL.x0, cam);
      const [mk, mkg] = tmp('clothMask', SW, SH); mkg.imageSmoothingEnabled = true; mkg.drawImage(mask, mX, 0, CL.w, CL.h);
      if (sheetOn) { mkg.globalCompositeOperation = 'destination-out'; mkg.beginPath(); holePath(mkg, WR, wcx, wcy); mkg.fill(); }
      cg.drawImage(mk, 0, 0); cg.globalCompositeOperation = 'source-over';
      G.drawImage(cc, 0, 0);
      // 前沿：光把纸"泡"开的一圈亮边
      if (pc < 1.2) { const [bc, bg] = tmp('clothB', SW, SH); bg.drawImage(band, mX, 0, CL.w, CL.h); bg.globalCompositeOperation = 'source-in'; bg.fillStyle = 'rgba(255,150,70,1)'; bg.fillRect(0, 0, SW, SH); G.save(); G.globalCompositeOperation = 'lighter'; G.globalAlpha = .55 * clamp(I); G.drawImage(bc, 0, 0); G.restore(); }
    }
    // 阿凡提的故事：透过布幕压上来
    const ax = sx(A.cx - A.w / 2, cam), ay = A.cy - A.h / 2;
    if (t >= B(CUE.aftOn[0]) && onScreen(ax, ax + A.w)) {
      const k = eo(seg(t, B(CUE.aftOn[0]), B(CUE.aftOn[1])));
      const [ac, ag] = tmp('aft', A.w, A.h);
      ag.drawImage(I_aft, 0, 0, A.w, A.h);
      // 中性明暗：灯光衰减 1.0→0.85 + 闪烁（不改色）
      ag.globalCompositeOperation = 'multiply';
      const fl = clamp(flick(t) * (1 - dip * .5), .9, 1.05), gr = ag.createRadialGradient(hx - ax, hy - ay, 0, hx - ax, hy - ay, 900);
      const v0 = Math.round(255 * Math.min(1, fl)), v1 = Math.round(255 * .85 * Math.min(1, fl));
      gr.addColorStop(0, `rgb(${v0},${v0},${v0})`); gr.addColorStop(1, `rgb(${v1},${v1},${v1})`); ag.fillStyle = gr; ag.fillRect(0, 0, A.w, A.h);
      ag.globalCompositeOperation = 'overlay'; ag.globalAlpha = .1; ag.drawImage(GR_cloth, 0, 0, A.w, A.h, 0, 0, A.w, A.h); ag.globalAlpha = 1; ag.globalCompositeOperation = 'source-over';
      G.save(); G.globalAlpha = k; const bl = 16 * (1 - k); if (bl > .3) G.filter = `blur(${bl.toFixed(1)}px)`;
      const s = 1 + .05 * (1 - k); G.translate(ax + A.w / 2, ay + A.h / 2); G.scale(s, s); G.drawImage(ac, -A.w / 2, -A.h / 2); G.restore();
      if (k >= 1) { G.strokeStyle = 'rgba(60,35,18,.35)'; G.lineWidth = 1.2; G.strokeRect(ax - .5, ay - .5, A.w + 1, A.h + 1); }
      eraseInk(ac, ax, ay, A.w, A.h);
    }
    // 灯焰：透过布看到的一团亮
    if (I > .02) {
      G.save(); G.globalCompositeOperation = 'lighter';
      const bl = G.createRadialGradient(hx, hy, 0, hx, hy, 260); bl.addColorStop(0, `rgba(255,214,150,${clamp(.2 * I)})`); bl.addColorStop(1, 'rgba(255,170,90,0)'); G.fillStyle = bl; G.fillRect(hx - 260, hy - 260, 520, 520);
      G.translate(hx, hy + 10); G.rotate(wob * .014); G.scale(.42, 1);
      const fg = G.createRadialGradient(0, 14, 0, 0, 0, 54); fg.addColorStop(0, `rgba(255,250,232,${clamp(.7 * I)})`); fg.addColorStop(.45, `rgba(255,210,140,${clamp(.32 * I)})`); fg.addColorStop(1, 'rgba(255,160,80,0)');
      G.fillStyle = fg; G.beginPath(); G.arc(0, 0, 54, 0, 7); G.fill(); G.restore();
    }
    // 「偶」：深色影子压上幕布；小字与片名
    const ox2 = sx(L.ou.x, cam);
    if (t >= B(CUE.ou) - .35) {
      const k = eo(seg(t, B(CUE.ou) - .35, B(CUE.ou)));
      pressChar(DG, '偶', L.ou.size, ox2, L.ou.y + L.ou.size * .55, k, '#000', .92);
      pressChar(WG, '偶', L.ou.size, ox2, L.ou.y + L.ou.size * .55, k, '#000', .3);
      reg('ou', '偶', [ox2 - 66, L.ou.y, ox2 + 66, L.ou.y + L.ou.size * 1.1]);
    }
    if (t >= B(CUE.ouNote)) {
      const nx = sx(L.ouNote.x, cam), k = seg(t, B(CUE.ouNote), B(CUE.ouNote) + .45);
      smallText(G, '木偶动画', 30, nx, L.ouNote.y, k, { vertical: true, color: '#3b2a1e' });
      reg('ouNote', '木偶动画', smallBox('木偶动画', 30, nx, L.ouNote.y, { vertical: true }));
      const lx = ax + A.w / 2, lyy = A.cy + A.h / 2 + 40;
      smallText(G, '《阿凡提的故事》', 26, lx, lyy, k, { align: 'center', color: '#3b2a1e' });
      reg('l_aft', '《阿凡提的故事》', smallBox('《阿凡提的故事》', 26, lx, lyy, { align: 'center' }));
    }
  }

  comp(base, wet, dry, { camx: cam, zoom, zc, warm: 0, vig: .12 });
}

window.DUR = DUR;
window.EV = events();
window.TEXTS = t => { render(t); return TXT.filter(x => x.x1 > 0 && x.x0 < SW); };
window.render = render;
if (Q.has('t')) render(+Q.get('t'));
window.READY = true;
