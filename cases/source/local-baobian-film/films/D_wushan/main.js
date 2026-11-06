// 《豹变》D 雾山 · 入口：加载、分镜调度、每帧合成
// 页面约定：window.DUR = 30；window.render(t) 是 t 的纯函数；资源、字体、着色器全部就绪后 window.READY = true
import * as THREE from 'three';
import { createLook } from '../_lib/look.js';
import { createPost } from './lib/post.js';
import { loadManifest } from './lib/data.js';
import { interiorTex } from './lib/sprite.js';
import { seg, ss, ss5, eo, ei, clamp, lerp } from './lib/util.js';
import { buildCliff } from './shots/cliff.js';
import { buildRoom } from './shots/room.js';
import { buildMarket } from './shots/market.js';
import { buildMacro } from './shots/macro.js';
import { buildSky } from './shots/sky.js';
import { buildScroll } from './shots/scroll.js';
import { drawInk, inkHead, INK } from './shots/ink.js';

const W = innerWidth, H = innerHeight, K = H / 1040;
// 调试开关（只用于自检，不影响确定性）：?dbg=nofog,nosheet,...
const DBG = new Set((new URLSearchParams(location.search).get('dbg') || '').split(',').filter(Boolean));
const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1); renderer.setSize(W, H);
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const look = createLook(renderer, W, H, { ss: 2, paperUrl: null });
const post = createPost(renderer, W, H);
const rtOpt = { type: THREE.UnsignedByteType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
const rtLook = new THREE.WebGLRenderTarget(W, H, rtOpt);
const rtA = new THREE.WebGLRenderTarget(W, H, rtOpt), rtB = new THREE.WebGLRenderTarget(W, H, rtOpt);
const rtM = new THREE.WebGLRenderTarget(W, H, rtOpt);   // 化开时豹的遮罩（豹不参与化开）

// ── 2D 叠加层（look 之后）──
const ovCv = document.createElement('canvas'); ovCv.width = W; ovCv.height = H;
// 返修 1：叠加层用 CPU 画布（willReadFrequently）。GPU 加速的 2D 画布在上传成贴图时可能拿到上一次没冲刷的快照，
//   预热时画过的甩墨会残留到后面的镜头里（#10 开头实测到过）；CPU 画布上传的永远是当前内容
const ov = ovCv.getContext('2d', { willReadFrequently: true });
const ovTex = new THREE.CanvasTexture(ovCv); ovTex.colorSpace = THREE.NoColorSpace; ovTex.premultiplyAlpha = true;
ovTex.minFilter = THREE.LinearFilter; ovTex.generateMipmaps = false;
let ovUsed = false;
const OV = { ctx: ov, W, H, K, X: x => (x - 960) * K + W / 2, Y: y => y * K, use() { ovUsed = true; return ov; } };

// ── 贴图（按原值采样，着色器里自己做 sRGB → 线性）──
const loader = new THREE.TextureLoader();
async function loadTex(name) {
  const t = await loader.loadAsync(`./assets/${name}.png`);
  t.colorSpace = THREE.NoColorSpace; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true; t.anisotropy = 8;
  return t;
}
const NAMES = { pano: 'nanshan_pano', leoSit: 'leopard_sit', leoLeap: 'leopard_leap', leoHead: 'leopard_head', luSit: 'luwei_sit', luDesk: 'luwei_desk',
  handsDesk: 'hands_desk', handsSide: 'hands_side', vendor: 'hand_vendor', mask: 'mask_gold', desk: 'desk_top', market: 'market_bg', book: 'book_spread', deer: 'deer', peaks: 'peaks_qinglu',
  // 返修 4（w3）：手绘卡片
  goldSea: 'gold_sea', clouds: 'cloud_masses', ribbons: 'cloud_ribbons', ridges: 'ridges_dark', rocksFg: 'rocks_fg03', cliffP: 'cliff_platform03',
  inkStroke: 'ink_stroke', ledge: 'ledge_dusk', meadow: 'meadow_ridge03', panoA: 'nanshan_pano_rgba', leoBack: 'leopard_back' };
const tex = {};
await Promise.all(Object.entries(NAMES).map(async ([k, n]) => { tex[k] = await loadTex(n); }));
tex.leoSitIn = interiorTex(tex.leoSit.image, 42);
tex.leoLeapIn = interiorTex(tex.leoLeap.image, 16);
tex.leoHeadIn = interiorTex(tex.leoHead.image, 60);
const M = await loadManifest();

// ── 字体（题字：志莽行书；书页：马善政楷书）──
const fZM = new FontFace('ZMX', 'url(/fonts/ZhiMangXing-baobian.woff2)');
const fMS = new FontFace('MSZ', 'url(/fonts/MaShanZheng-baobian.woff2)');
await Promise.all([fZM.load(), fMS.load()]);
document.fonts.add(fZM); document.fonts.add(fMS);
await document.fonts.ready;
// 题字字模：8 个字一行，R = 清晰字形，G = 模糊（洇边）
const TXT = '君子豹变其文蔚也';
const txtTex = (() => {
  const S = 256, cv = document.createElement('canvas'); cv.width = S * 8; cv.height = S;
  const g = cv.getContext('2d');
  const draw = blur => {
    const c2 = document.createElement('canvas'); c2.width = S * 8; c2.height = S; const h = c2.getContext('2d');
    h.fillStyle = '#000'; h.fillRect(0, 0, S * 8, S); h.filter = blur ? `blur(${blur}px)` : 'none';
    h.fillStyle = '#fff'; h.font = `${S * .86}px ZMX`; h.textAlign = 'center'; h.textBaseline = 'middle';
    [...TXT].forEach((ch, i) => h.fillText(ch, S * (i + .5), S * .53));
    return h.getImageData(0, 0, S * 8, S).data;
  };
  const a = draw(0), b = draw(16);
  const img = g.createImageData(S * 8, S);
  for (let i = 0; i < a.length; i += 4) { img.data[i] = a[i]; img.data[i + 1] = b[i]; img.data[i + 2] = 0; img.data[i + 3] = 255; }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.NoColorSpace; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
  return t;
})();

// 纸纹（返修 1）：自己生成一张可平铺的纸纹，只有色调起伏（大块斑驳 + 极淡的纤维 + 细颗粒），没有 look 默认纸纹里那层浮雕明暗
const paperTex = (() => {
  const N = 1024, cv = document.createElement('canvas'); cv.width = cv.height = N; const g = cv.getContext('2d');
  const img = g.createImageData(N, N), d = img.data;
  const hh = (x, y, s) => { let h = (x * 374761393 + y * 668265263 + s * 2246822519) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
  const vn = (x, y, P, s) => { const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = hh(((xi % P) + P) % P, ((yi % P) + P) % P, s), b = hh(((xi + 1) % P + P) % P, ((yi % P) + P) % P, s), c = hh(((xi % P) + P) % P, ((yi + 1) % P + P) % P, s), e = hh(((xi + 1) % P + P) % P, ((yi + 1) % P + P) % P, s);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + e) * ux * uy; };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N;
    const mott = vn(u * 5, v * 5, 5, 1) * .5 + vn(u * 11, v * 11, 11, 2) * .3 + vn(u * 26, v * 26, 26, 3) * .2;
    // 返修 3（v2-08）：纤维不再全是竖向（原来 u×128、v×12，长卷 0.12 强度下读成一排竖条纹，像底板被拉伸），改成横竖交织、更淡
    const fib = vn(u * 64, v * 32, 64, 4) * .4 + vn(u * 32, v * 128, 32, 5) * .3 + vn(u * 160, v * 96, 160, 6) * .3;
    const grain = hh(x, y, 9);
    const val = .5 + (mott - .5) * .55 + (fib - .5) * .08 + (grain - .5) * .05;
    const k = (y * N + x) * 4; d[k] = d[k + 1] = d[k + 2] = Math.max(0, Math.min(255, val * 255)); d[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
})();

const ctx = { W, H, K, tex, M, OV, renderer, DBG };
const cliff = buildCliff(ctx), room = buildRoom(ctx), market = buildMarket(ctx), macro = buildMacro(ctx), sky = buildSky(ctx), scroll = buildScroll(ctx);

// ── 分镜（DESIGN 4.0，按帧，互不重叠，合计 720 帧）──
// 返修 1：起跳放进 #13 的机位里，#14 冲破第三层云后多给 12 帧金色云海（#14 到 f558），#15 从 f559 起
// 返修 2：#13 到 f522（f517 起是侧面低机位的起跳，踩全曲第二强低频起音硬切），#14 从 f523 起
const SHOTS = [[1, 0, 83], [2, 84, 118], [3, 119, 179], [4, 180, 253], [5, 254, 269], [6, 270, 289], [7, 290, 309], [8, 310, 333], [9, 334, 347],
  [10, 348, 398], [11, 399, 431], [12, 432, 493], [13, 494, 522], [14, 523, 558], [15, 559, 635], [16, 636, 651], [17, 652, 719]];
const shotOf = f => { for (const s of SHOTS) if (f >= s[1] && f <= s[2]) return s[0]; return 17; };

// 一个镜头画到 target：场景更新 → look → 镜头后期 →（叠加层）
function renderShot(S, t, f, shot, target) {
  S.update(t, f, shot);
  const lp = S.look(t, f, shot);
  if (DBG.has('nofog')) lp.fog = null;
  if (DBG.has('nokuw')) lp.kuwahara = null; if (DBG.has('nool')) lp.outline = null; if (DBG.has('nopaper')) lp.paper = null;
  if (lp.paper) lp.paper = { ...lp.paper, tex: paperTex, mid: .5, scale: Math.max(1, K * 1.2) };
  look.render(S.scene, S.camera, { ...lp, t, target: rtLook });
  post.post(rtLook.texture, look.targets.scene.depthTexture, S.camera, S.post(t, f, shot), target);
  if (S.overlay && !DBG.has('noov')) S.overlay(t, f, shot);
}

// T2 星芒包络（切点 f652）
const STAR = [[644, 0], [646, .2], [648, .45], [650, .75], [652, 1], [654, .75], [657, .4], [660, .15], [663, 0]];
const starEnv = fr => { if (fr <= 644 || fr >= 663) return 0; for (let i = 1; i < STAR.length; i++) if (fr <= STAR[i][0]) { const [a, va] = STAR[i - 1], [b, vb] = STAR[i]; return lerp(va, vb, (fr - a) / (b - a)); } return 0; };
// 题字：右列「君子豹变」x = 1660，左列「其文蔚也」x = 1560，首字顶 y = 210，字号 84·K、字距 94·K
// 返修 1：右列 f682 起（28.43 秒低频起音），每字 6 帧显全、间隔 2 帧（f694 写完）；左列 f690 起（f702 写完）；整句完整停到 f710
const CHAR_F = [682, 684, 686, 688, 690, 692, 694, 696];

window.DUR = 30;
window.render = t => {
  t = clamp(t, 0, 30);
  const f = Math.min(719, Math.round(t * 24)), fr = t * 24;
  const shot = shotOf(f);
  ov.setTransform(1, 0, 0, 1, 0, 0); ov.clearRect(0, 0, W, H); ovUsed = false;
  const fin = { uMode: 0 };
  let useB = false;
  if (shot === 1 || shot === 17 || (shot === 2 && f < 100)) renderShot(room, t, f, shot, rtA);
  else if (shot === 2 || shot === 3 || shot === 4 || shot === 12) renderShot(cliff, t, f, shot, rtA);
  else if (shot === 5) {
    // 墨甩划像：A = 雾崖（#04 延续），B = 集市；笔身画在叠加层
    if (fr < 266.5) {
      renderShot(cliff, t, f, 4, rtA); renderShot(market, t, f, 5, rtB); useB = true;
      fin.uMode = 1; fin.uWipe = [INK.P0[0], INK.P0[1], INK.ang, inkHead(fr)]; fin.uWipe2 = [520, 300, 260, 260]; fin.uWipeAll = ss(seg(fr, 256, 262.5)); fin.uWipeTR = 1.35 * ss(seg(fr, 255, 257.5));
    } else renderShot(market, t, f, 5, rtA);
    drawInk(OV, fr);
    fin.uInkAng = INK.ang;
    if (fr >= 257.5) fin.uOvDiss = (.12 + .9 * ss(seg(fr, 257.5, 266.5))) * 1.05;   // f258 起就开始退墨（不再整笔停 5 帧）
  }
  else if (shot >= 6 && shot <= 8) renderShot(market, t, f, shot, rtA);
  else if (shot === 9) {
    // 面具眼孔：A = 集市，B = 眼孔里实时渲染的雾崖（#10 的相机路径）
    renderShot(market, t, f, 9, rtA);
    const h = market.st.hole;
    renderShot(macro, t, f, 9, rtB); useB = true;
    fin.uMode = 2; fin.uHole = [h.cx, h.cy, h.a, h.b]; fin.uHoleTilt = h.tilt; fin.uHoleOn = 1; fin.uHoleRim = 1 - seg(fr, 344, 347);
  }
  else if (shot === 10 || shot === 11) renderShot(macro, t, f, shot, rtA);
  else if (shot === 13 || shot === 14 || shot === 16) renderShot(sky, t, f, shot, rtA);
  else if (shot === 15) {
    // 化开：f594–f614 匀速推进（自右向左，顺着手卷的读法），单帧面积增量不超过约 6%
    if (fr < 594) renderShot(sky, t, f, 15, rtA);
    else if (fr < 614.5) {
      renderShot(sky, t, f, 15, rtA); renderShot(scroll, t, f, 15, rtB); useB = true; fin.uMode = 3; fin.uTau = lerp(-.02, 1.02, seg(fr, 594, 614));
      scroll.maskRender(renderer, rtM); fin.uLeoM = 1;
    }
    else renderShot(scroll, t, f, 15, rtA);
    fin.uBorder = ss(seg(fr, 600, 614));
  }
  // 尾迹环斑（#14、#15，画在最上层，不参与化开）
  //   #14：挂在世界里的墨点（尾根处落下），投影到屏幕
  //   #15：在尾根处落下，随即被甩到身后（屏幕上向右漂，和长卷同一个口径），排成一道先下凹再上扬的弧（半径约 900·K）；
  //        七枚大斑由近到远、由大到小，两枚之间撒 5 颗小墨点；刚落时带金光，24–60 帧后褪成纯墨
  let tr = [];
  if (shot === 14) tr = sky.trail(t, f, 14).map(p => [p.x, p.y, p.R, p.seed, p.gold, p.dot ? 1 : 0]);
  if (shot === 15) {
    const TF = [526, 538, 550, 565, 580, 596, 612];
    const L = scroll.leoAt(fr);                    // 豹的屏幕位置与身长（三维段与长卷段同一口径）
    const sc = L.len / 600;
    const drift = q => fr < 612 ? (fr - q) * 10.8 : (612 - Math.min(q, 612)) * 10.8 * 1 + (fr - Math.max(q, 612)) * 9.6;
    const at = q => { const dx = drift(q); const x = L.x + 175 * sc + dx;
      // 返修 2（story-18）：尾迹排成一道清楚的弧——从尾根先往下凹（最深约 150 px），到远端再扬起来，比尾根还高一点
      const u = Math.min(1.25, dx / 1050); return [x, L.y + 26 * sc + 150 * Math.sin(Math.PI * Math.min(1, u)) - 120 * ss(seg(u, .75, 1.25))]; };
    TF.forEach((q, k) => {
      if (fr < q) return;
      const [x, y] = at(q), age = fr - q;
      const R = (30 - 2.6 * k) * Math.max(.55, sc) * (1 + .12 * (1 - ss(age / 7)));   // 由大到小（第一枚最大）
      tr.push([x, y, R, 20 + k * 7, .65 * (1 - ss(seg(age, 0, 7))), 0]);   // 返修 3（v2-09）：落下时外缘一线金，0.3 秒内褪成纯墨
      if (k > 0) for (let j = 1; j <= 2; j++) {
        const q2 = lerp(TF[k - 1], q, j / 3); if (fr < q2) continue;
        const [x2, y2] = at(q2);
        tr.push([x2, y2 + ((j * 13) % 5 - 2) * 3, (2.5 + (j * 7 % 3)) * Math.max(.55, sc), 50 + k * 9 + j, 0, 1]);
      }
    });
  }
  if (tr.length) {
    const vis = tr.filter(p => p[0] > -100 && p[0] < 2100 && p[1] > -100 && p[1] < 1140).slice(0, 48);
    fin.uTrailN = vis.length; fin.uTrail = vis.map(p => [p[0], p[1], p[2], p[3]]); fin.uTrailB = vis.map(p => [p[4], p[5]]);
  }
  // 星芒 G：S1 f66 半尺寸（落在右镜圈上）；T2 跨切点 f644–f663
  if (fr >= 63 && fr <= 70) { fin.uStar = [1236, 438, fr <= 66 ? .5 * seg(fr, 63, 66) : .5 * (1 - seg(fr, 66, 70))]; fin.uStarS = .5; }
  const se = starEnv(fr);
  if (se > 0) { fin.uStar = [1236, 438, se]; fin.uStarS = 1; if (fr >= 652) fin.uStarHalo = [1, .96, .84];
    // 返修 2（story-16）：切点前 f649–f651 豹眼上先起一团暖晕（闪光在切点前就到七成），切点后镜片那边的白晕收小 30%，两边对称
    const g = Math.max(0, 1 - Math.abs(fr - 652) / 3.5); fin.uStarGlow = g * (fr >= 652 ? .35 : .38); }
  if (fr >= 652 && fr < 655) fin.uExpo = 1 + .25 * (1 - seg(fr, 652, 655));
  // 淡入（f0–f9 从墨黑）
  if (fr < 9.5) fin.uFadeBlack = 1 - eo(fr / 9.5);
  // 返修 3（self-01 / story-06②③）：五爻横带。f92.5–f96.5 从页面上的五画接手、滑到保持位；跨过 f99 的纤维闪（切点两边同一组横带）；
  //   f100–f110 俯冲时从中线往上下分开（越下越近、越粗）；f110–f118 拉平时落到 #03 的五层（初九暗岩沿 / 六二雾带 / 九三山脊 / 九四雾带 / 九五天际线），
  //   九五在天际线上闪 2 帧金边（爻成山），横带随之淡掉，交给场景里的五层
  if (shot === 2 && fr >= 92 && fr < 119) {
    const HOLD = [780, 672, 566, 462, 360], TH = [62, 58, 54, 50, 46], FIN = [962, 548, 432, 376, 300], FTH = [70, 38, 16, 24, 10];
    const scr = cliff.st.yaoScr;   // 拉平时贴着场景里那五层的屏幕位置走（九五就是底板的天际线）
    const take = ss(seg(fr, 92.5, 96.5)), spread = ss(seg(fr, 100, 110)), land = ss(seg(fr, 110, 118));
    const bars = room.st.bars;
    fin.uYaoOn = 1; fin.uYaoT = t; fin.uYaoX1 = lerp(2080, 1700, ss(seg(fr, 103, 110))); fin.uYaoGap = [lerp(960, 510, land), lerp(lerp(96, 150, spread), 180, land)];
    fin.uYao = [0, 1, 2, 3, 4].map(k => {
      let y, th;
      if (fr < 99.5) { const b = bars ? bars[k] : { y: HOLD[k], th: TH[k] }; y = lerp(b.y, HOLD[k], take); th = lerp(b.th, TH[k], take); }
      else { const ys = 540 + (HOLD[k] - 540) * (1 + 1.6 * spread); const yt = scr && fr >= 109 ? scr[k] : FIN[k]; y = lerp(ys, yt, land); th = lerp(TH[k] * (1 + .7 * spread), FTH[k], land); }
      const a = (fr < 99.5 ? take : 1) * (1 - .45 * ss(seg(fr, 103, 110))) * (1 - ss(seg(fr, 113.5, k === 4 ? 119 : 118.5)));
      const gold = k === 4 ? Math.max(0, 1 - Math.abs(fr - 116.5) / 1.6) : 0;   // 九五落到天际线上时闪 2 帧金边（爻成山）
      return [y, th, k === 4 ? Math.max(a, gold * .9) : a, gold];
    });
  }
  // T1 换景：纸纤维闪 f99 0.9、f100 0.5、f101 0
  if (fr >= 98.5 && fr < 101.5) fin.uFiber = fr < 99.5 ? .9 : fr < 100.5 ? .5 : 0;
  // 题字（逐字洇出）+ 柔光；片尾 f710–f719 淡到纸白，题字晚 3 帧才淡出
  //   题字整体上移到亮窗区（首字顶 y = 52），深墨压亮窗
  if (fr >= 680) {
    fin.uTxtOn = 1; fin.uGlowOn = ss(seg(fr, 678, 688));
    fin.uChar = CHAR_F.map((c0, i) => { const col = i < 4 ? 1660 : 1560, row = i % 4; return [col, 52 + row * 94, 84, ss(seg(fr, c0, c0 + 6))]; });
    fin.uCharBlur = CHAR_F.map(c0 => 1 - ss(seg(fr, c0, c0 + 6)));
    fin.uTxtA = 1 - ss(seg(fr, 713, 719.5));
  }
  if (fr >= 710) fin.uFadePaper = ei(seg(fr, 710, 719));
  if (ovUsed) ovTex.needsUpdate = true;
  fin.uOvOn = ovUsed ? 1 : 0;
  post.final(rtA.texture, useB ? rtB.texture : null, ovTex, txtTex, fin, fin.uLeoM ? rtM.texture : null);
};

// 着色器预热：每个镜头渲一帧
for (const t of [1, 3.9, 4.3, 6, 9, 10.7, 11.6, 12.5, 13.2, 14.0, 15.2, 17.2, 19.5, 20.8, 22, 24, 25, 26, 26.9, 28.6]) { try { window.render(t); } catch (e) { console.error('预热 t=' + t + ' ' + (e.stack || e).toString().replace(/\n/g, ' | ').slice(0, 280)); throw e; } }
window.render(0);
await look.ready;
window.READY = true;
