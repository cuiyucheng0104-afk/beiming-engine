// 《概念样片》画面：宣纸上三笔山——主峰浓墨"一笔成山"、收笔飞白；次峰重墨；远山淡墨湿笔晕开——
// 山腰与山脚的云把墨"提"走（露出纸白），片名竖排题在右上的留白里，最后钤一方白文朱印。
// Canvas 2D；只依赖 engine/ 与本目录的 paper.js / brush.js / seal.js / type.js；所有时刻来自 timeline.js（它读 film.json）。
//   setup(canvas) → 报告 { layout, scale, fonts }  生成纸、笔画几何、山体的染、印；选字体并检查缺字
//   render(t)                                    画时刻 t（确定性：不读时钟、不留上一帧的状态，任意帧可单独、乱序重渲）
//   TEXTS(t)                                     画面上的字：[{ id, text, box:[x,y,w,h], x0,y0,x1,y1, alpha, font, missing }]（屏幕像素）
//   scene()                                      给 timeline.buildEvents：声像（按画面位置）与题字字数
//   toScreen(x, y, z)                            设计坐标 → 屏幕像素（画、量字、声像共用这一个函数）
// 工艺取舍（模版示范的几条，改之前先读同目录 README.md 的"工艺对照"）：
//   时钟   笔画与题字一拍二（拍号取整数帧 hold(f, 2)）；镜头缓推、云的漂移一拍一平滑——相机与纸永不量化
//   构图   横屏设计 1920×1080、竖屏设计 1080×1920 各一套，按画幅自动选；留白约七成；主体在左下，题名与印在右上，对角平衡
//   墨色   墨分五色（焦 浓 重 淡 清）；每笔先画成不透明的"覆盖"，再按浓淡合成到墨层；墨层用纸齿掏出纤维后 multiply 到纸上
//   颜色   朱红只给印，全片唯一的颜色
import { clamp, seg, ss } from '../../engine/core/math.js';
import { frameOf, hold } from '../../engine/core/clock.js';
import { canvasFor } from '../../engine/paint/canvas.js';
import { makePaper, PAPER_RGB } from './paper.js';
import { prepareStroke, drawStroke, makeMass, drawMass } from './brush.js';
import { makeSeal } from './seal.js';
import { pickFont } from './type.js';
import { FPS, DUR, F as CUEF, BEATF, ACT } from './timeline.js';

export const TITLE = '概念样片';
export const SEAL_TEXT = '北冥';                       // 印文：换成自己的落款（1–4 字），字体里要有这些字
// 字体表 [族名, 地址, 字重]：main.js 全部加载；片名与印文按顺序取第一个"字都有"的字体。
// 自己的字体子集放进作品目录（如 ./fonts/title.woff2）插到最前面，许可文件一并放进作品目录。
export const FONTS = [
  ['BM Title', '../../fonts/MaShanZheng-400.woff2', '400'],   // 马善政毛笔楷书（OFL）；仓库子集只有"北""冥"两字
  ['BM Sans', '../../fonts/NotoSansSC-var.woff2', '100 900'], // 思源黑体子集（OFL）；约 60 字
];
const TITLE_FAMILIES = ['BM Title', 'BM Sans'], SEAL_FAMILIES = ['BM Title', 'BM Sans'];

const INK = '#1b1916', VERMILION = [176, 46, 34];
const TONE = { jiao: 0.95, nong: 0.9, zhong: 0.56, dan: 0.3, qing: 0.16 };   // 墨分五色：焦 浓 重 淡 清
const MASSES = ['s3', 's2', 's1'];                                           // 染的顺序：远 → 近（近处的墨压在远处之上）
const STROKES = ['s3', 's2', 's1', 'w1', 'w2'];                              // 笔的顺序：远山、次峰、主峰、两道水纹

// ———— 构图（设计坐标）。改构图只改这里；笔的字段见 brush.js 开头 ————
const MAIN = {   // 主峰：从左脚起笔，上坡中速，山头转折处顿一下，下坡越走越快、越枯，飞白收笔
  width: 32, entry: 34, exit: 120, tone: TONE.nong, seed: 11, lanes: 20, bleed: 1.6,
  pressure: [[0, 0.92], [0.06, 0.66], [0.26, 0.54], [0.39, 0.4], [0.44, 0.74], [0.5, 0.6], [0.7, 0.72], [0.86, 0.48], [1, 0.2]],
  dry: [[0, 0], [0.16, 0.02], [0.28, 0.16], [0.36, 0.06], [0.42, 0.18], [0.5, 0.05], [0.68, 0.22], [0.86, 0.55], [1, 0.92]],
};
const SECOND = {
  width: 21, entry: 60, start: 'tip', exit: 80, tone: TONE.zhong, seed: 23, lanes: 16, bleed: 1.8,
  pressure: [[0, 0.8], [0.12, 0.62], [0.38, 0.5], [0.46, 0.85], [0.55, 0.58], [0.82, 0.66], [1, 0.25]],
  dry: [[0, 0], [0.5, 0.06], [0.8, 0.36], [1, 0.7]],
};
const FAR = {    // 远山：淡墨湿笔，几乎不枯；合成时垫一层晕开的墨（wet），远处不要硬边
  width: 24, entry: 70, start: 'tip', exit: 70, tone: TONE.dan, seed: 37, lanes: 14, wet: 6,
  pressure: [[0, 0.5], [0.2, 0.8], [0.55, 0.72], [1, 0.3]],
};
const WATER = {  // 水纹：清墨枯笔，快速一掠（水即留白，几笔带出水面）
  width: 6, entry: 24, start: 'tip', exit: 40, tone: TONE.qing * 1.4, lanes: 8, streak: 40,
  pressure: [[0, 0.7], [0.3, 1], [1, 0.3]], dry: [[0, 0.25], [0.5, 0.5], [1, 0.9]],
};
// bleed：宣纸吃墨，合成时垫一层很小的晕（设计像素），笔边是"渗"出去的；wet：湿笔晕开的半径
const LAYOUTS = {
  landscape: {
    size: [1920, 1080], focus: [1040, 520], push: 0.035,
    strokes: {
      s1: { ...MAIN, pts: [[152, 770], [236, 690], [312, 604], [380, 500], [438, 410], [484, 352], [507, 326], [516, 318], [528, 323],
        [560, 352], [616, 392], [680, 420], [748, 452], [826, 504], [910, 560], [998, 616], [1088, 668], [1166, 706]] },
      s2: { ...SECOND, pts: [[962, 594], [1006, 558], [1046, 534], [1066, 525], [1082, 527], [1150, 548], [1232, 584], [1322, 628],
        [1410, 670], [1484, 702]] },   // 从主峰右坡后面"冒出来"：起点落在主峰脊线上，两条脊线不交叉
      s3: { ...FAR, pts: [[1132, 534], [1186, 506], [1256, 478], [1330, 452], [1380, 440], [1400, 438], [1424, 441], [1480, 458], [1550, 488],
        [1604, 514], [1636, 532]] },   // 远山也从次峰脊线后面起笔；右端早早收住，给题名与印留出空
      w1: { ...WATER, seed: 51, pts: [[1188, 866], [1262, 861], [1344, 862], [1426, 867]] },
      w2: { ...WATER, seed: 53, width: 5, pts: [[1296, 904], [1356, 901], [1428, 903]] },
    },
    masses: { s1: { base: 790, tone: 0.32, band: 0.09 }, s2: { base: 770, tone: 0.2, band: 0.12 }, s3: { base: 640, tone: 0.12, band: 0.16 } },
    // 云：几团压扁的椭圆把墨"提"走（destination-out）。腰云横过主峰，脚下的雾把山脚化开；只往右漂一点
    mist: [{ x: 360, y: 606, rx: 250, ry: 40, a: 0.78 }, { x: 610, y: 628, rx: 230, ry: 34, a: 0.7 }, { x: 860, y: 650, rx: 220, ry: 30, a: 0.62 },
      { x: 300, y: 790, rx: 420, ry: 70, a: 0.72 }, { x: 900, y: 772, rx: 470, ry: 60, a: 0.66 }, { x: 1420, y: 740, rx: 420, ry: 56, a: 0.6 }],
    drift: 28,
    title: { x: 1742, y: 160, size: 96, gap: 1.12, maxY: 560, hx: 1700, hy: 930, hsize: 72, hmax: 980 },
    seal: { size: 74, gap: 0.5 },
  },
  portrait: {
    size: [1080, 1920], focus: [560, 1020], push: 0.035,
    strokes: {
      s1: { ...MAIN, pts: [[48, 1562], [112, 1452], [176, 1334], [234, 1206], [282, 1080], [322, 970], [356, 900], [372, 874], [384, 868],
        [404, 880], [456, 930], [520, 996], [596, 1070], [688, 1150], [784, 1226], [878, 1296], [966, 1360], [1034, 1404]] },
      s2: { ...SECOND, pts: [[556, 1574], [628, 1500], [700, 1452], [744, 1432], [760, 1428], [778, 1431], [852, 1452], [932, 1490], [1006, 1530], [1064, 1562]] },
      s3: { ...FAR, pts: [[548, 902], [610, 856], [676, 820], [724, 802], [740, 798], [760, 801], [826, 822], [900, 858], [972, 898], [1032, 936]] },
      w1: { ...WATER, seed: 51, pts: [[560, 1716], [632, 1711], [712, 1712], [790, 1717]] },
      w2: { ...WATER, seed: 53, width: 5, pts: [[650, 1756], [708, 1753], [776, 1755]] },
    },
    masses: { s1: { base: 1600, tone: 0.32, band: 0.07 }, s2: { base: 1630, tone: 0.2, band: 0.12 }, s3: { base: 1000, tone: 0.12, band: 0.16 } },
    mist: [{ x: 250, y: 1230, rx: 210, ry: 40, a: 0.78 }, { x: 470, y: 1262, rx: 200, ry: 34, a: 0.7 }, { x: 700, y: 1296, rx: 190, ry: 30, a: 0.62 },
      { x: 300, y: 1610, rx: 420, ry: 80, a: 0.72 }, { x: 860, y: 1600, rx: 400, ry: 70, a: 0.66 }],
    drift: 18,
    title: { x: 900, y: 200, size: 100, gap: 1.12, maxY: 690, hx: 1000, hy: 1760, hsize: 66, hmax: 860 },
    seal: { size: 76, gap: 0.5 },
  },
};

const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿！-～·]+$/u;

let g, W, H, S, L, O, F, paper, tooth, strokes, masses, seal, title, report;

export function setup(canvas) {
  W = canvas.width = innerWidth; H = canvas.height = innerHeight;
  g = canvas.getContext('2d');
  const name = W >= H ? 'landscape' : 'portrait';
  L = LAYOUTS[name];
  const [DW, DH] = L.size;
  S = Math.min(W / DW, H / DH);
  O = [(W - S * DW) / 2, (H - S * DH) / 2];
  F = [O[0] + S * L.focus[0], O[1] + S * L.focus[1]];
  ({ paper, tooth } = makePaper({ w: W, h: H, s: S, seed: 17 }));
  strokes = {}; masses = {};
  for (const k of STROKES) strokes[k] = prepareStroke(L.strokes[k]);
  for (const k of MASSES) masses[k] = makeMass(strokes[k], { ...L.masses[k], px: S * (1 + L.push), seed: 90 + k.charCodeAt(1) });
  // 片名：中日文且不超过 8 个字就竖排（题在留白里），否则横排（右对齐到水面那块留白）
  const t = L.title, chars = [...TITLE];
  const pick = pickFont(TITLE, TITLE_FAMILIES), sealPick = pickFont(SEAL_TEXT, SEAL_FAMILIES);
  const vertical = CJK.test(TITLE) && chars.length <= 8;
  title = { chars, vertical, family: pick.family, missing: pick.missing };
  if (vertical) {
    title.size = Math.min(t.size, (t.maxY - t.y) / (chars.length * t.gap));
    title.cells = chars.map((ch, i) => ({ ch, x: t.x, y: t.y + title.size * (0.5 + i * t.gap) }));
    title.bottom = t.y + title.size * ((chars.length - 1) * t.gap + 1);
    title.sealAt = [t.x, title.bottom + L.seal.gap * title.size + L.seal.size / 2];
  } else {
    const m = document.createElement('canvas').getContext('2d');
    m.font = `400 ${t.hsize}px "${pick.family}", serif`;
    const w = m.measureText(TITLE).width;
    title.size = w > t.hmax ? t.hsize * t.hmax / w : t.hsize;
    title.width = Math.min(w, t.hmax);
    title.cells = [{ ch: TITLE, x: t.hx - title.width / 2, y: t.hy - title.size * 0.35 }];
    title.sealAt = [t.hx + 0.45 * title.size + L.seal.size / 2, t.hy - title.size * 0.35];
  }
  seal = makeSeal({ text: SEAL_TEXT, family: sealPick.family, px: Math.round(L.seal.size * S * (1 + L.push)), seed: 23, rgb: VERMILION });
  report = { layout: name, scale: +S.toFixed(4), fonts: { title: { family: pick.family, missing: pick.missing }, seal: { family: sealPick.family, missing: sealPick.missing } } };
  return report;
}

// ———— 相机：缓推（一拍一，不量化），绕 focus 放大；纸与墨都锚定在世界上 ————
const zoom = t => 1 + L.push * (0.3 * clamp(t / DUR) + 0.7 * ss(clamp(t / DUR)));
const worldM = z => [S * z, 0, 0, S * z, F[0] + (O[0] - F[0]) * z, F[1] + (O[1] - F[1]) * z];
const paperM = z => [z, 0, 0, z, F[0] * (1 - z), F[1] * (1 - z)];
export const toScreen = (x, y, z) => [F[0] + (O[0] + S * x - F[0]) * z, F[1] + (O[1] + S * y - F[1]) * z];

function layer(key) {
  const c = canvasFor(key, W, H), x = c.getContext('2d');
  x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1; x.filter = 'none';
  x.clearRect(0, 0, W, H);
  return x;
}
// 笔走到哪：进入时间窗就先按下整个笔头（第一帧就有东西：钩子），之后缓入缓出，拍点上写完
const strokeP = (k, fq) => (fq < ACT[k].f0 ? 0 : Math.max(0.7 * (L.strokes[k].entry || 0) / strokes[k].L, ss(seg(fq, ACT[k].f0, ACT[k].f1))));

export function render(t) {
  // 时间只在这里换算一次：f 是整数帧，fq 是一拍二量化后的帧（画笔、题字、印用它），镜头与云用连续的 t
  const f = frameOf(t, FPS), beat2 = hold(f, 2), fq = beat2 * 2, z = zoom(t);
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.filter = 'none';
  g.fillStyle = `rgb(${PAPER_RGB.join(',')})`; g.fillRect(0, 0, W, H);
  g.setTransform(...paperM(z)); g.drawImage(paper, 0, 0);

  // 墨层 = 山体的染（纸齿更重）+ 三笔 + 云（提墨）+ 题字，最后整体过一遍纸齿，multiply 到纸上
  const ig = layer('c.ink'), wg = layer('c.wash');
  wg.setTransform(...worldM(z));
  for (const k of MASSES) drawMass(wg, masses[k], seg(fq, ACT[k].f1 - 0.25 * BEATF, ACT[k].f1 + BEATF));
  wg.setTransform(...paperM(z)); wg.globalCompositeOperation = 'destination-out'; wg.globalAlpha = 0.5; wg.drawImage(tooth, 0, 0);
  ig.drawImage(wg.canvas, 0, 0);
  for (const k of STROKES) {
    const p = strokeP(k, fq);
    if (p <= 0) continue;
    const sg = layer('c.stroke'), sp = L.strokes[k];
    sg.setTransform(...worldM(z));
    drawStroke(sg, strokes[k], p, { boil: beat2, color: INK });
    // 宣纸吃墨：湿笔（远山）垫一层大晕，其余笔垫一层很小的晕，笔边是"渗"出去的，不是刀切的
    const halo = sp.wet || sp.bleed || 0;
    if (halo) { ig.filter = `blur(${(halo * S * z).toFixed(2)}px)`; ig.globalAlpha = sp.tone * (sp.wet ? 0.5 : 0.32); ig.drawImage(sg.canvas, 0, 0); ig.filter = 'none'; }
    ig.globalAlpha = sp.tone; ig.drawImage(sg.canvas, 0, 0); ig.globalAlpha = 1;
  }
  liftMist(ig, t, z);
  drawTitle(ig, fq, z);
  ig.setTransform(...paperM(z)); ig.globalCompositeOperation = 'destination-out'; ig.globalAlpha = 0.2; ig.drawImage(tooth, 0, 0);

  g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'multiply'; g.drawImage(ig.canvas, 0, 0);
  g.globalCompositeOperation = 'source-over';
  drawSeal(g, fq, z);
}

// 云：远山落定后两拍里漫开（一拍一平滑，属于大气，不是笔画），之后一直往右漂一点
function liftMist(ig, t, z) {
  const m = ss(seg(t * FPS, ACT.mist.f0, ACT.mist.f1));
  if (m <= 0) return;
  const dx = L.drift * clamp((t - ACT.mist.t0) / Math.max(1e-6, DUR - ACT.mist.t0));
  ig.save(); ig.setTransform(...worldM(z)); ig.globalCompositeOperation = 'destination-out';
  for (const [i, e] of L.mist.entries()) {
    const k = ss(clamp(m * 1.3 - (i % 3) * 0.12));
    if (k <= 0) continue;
    const gr = ig.createRadialGradient(0, 0, 0, 0, 0, 1);
    gr.addColorStop(0, `rgba(0,0,0,${(e.a * k).toFixed(3)})`); gr.addColorStop(0.5, `rgba(0,0,0,${(e.a * 0.7 * k).toFixed(3)})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
    ig.save(); ig.translate(e.x + dx * (1 + (i % 3) * 0.25), e.y); ig.scale(e.rx * (0.4 + 0.6 * k), e.ry * (0.75 + 0.25 * k)); ig.fillStyle = gr;
    ig.beginPath(); ig.arc(0, 0, 1, 0, Math.PI * 2); ig.fill(); ig.restore();
  }
  ig.restore();
}

// 题字：每个字从上往下"浸"出来（前沿是一道柔边），刚落下时湿、带一点晕，四分之一秒里收干
function charWindow(i) {
  const n = title.chars.length, a = ACT.title, d = (a.f1 - a.f0) / (title.vertical ? n : 1);
  return title.vertical ? [a.f0 + i * d, a.f0 + (i + 1) * d] : [a.f0, a.f1];
}
function drawTitle(ig, fq, z) {
  for (const [i, c] of title.cells.entries()) {
    const [c0, c1] = charWindow(i), p = ss(seg(fq, c0, c1));
    if (p <= 0) continue;
    const px = title.size * S * z, [sx, sy] = toScreen(c.x, c.y, z);
    const cw = Math.ceil(title.vertical ? px * 1.4 : title.width * S * z + px * 0.6), ch = Math.ceil(px * 1.4);
    const cell = canvasFor('c.char', cw, ch), cg = cell.getContext('2d');
    cg.setTransform(1, 0, 0, 1, 0, 0); cg.globalCompositeOperation = 'source-over'; cg.globalAlpha = 1; cg.filter = 'none';
    cg.clearRect(0, 0, cw, ch);
    cg.font = `400 ${px.toFixed(2)}px "${title.family}", serif`; cg.textAlign = 'center'; cg.textBaseline = 'middle'; cg.fillStyle = INK;
    cg.fillText(c.ch, cw / 2, ch / 2);
    if (p < 1) {
      const e = 0.25 * ch, front = -e + (ch + 2 * e) * p, gr = cg.createLinearGradient(0, front - e, 0, front + e);
      gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      cg.globalCompositeOperation = 'destination-in'; cg.fillStyle = gr; cg.fillRect(0, 0, cw, ch);
    }
    const wet = 1 - ss(seg(fq, c1, c1 + 0.25 * FPS));
    ig.save(); ig.setTransform(1, 0, 0, 1, 0, 0); ig.globalCompositeOperation = 'source-over';
    if (wet > 0) { ig.filter = `blur(${(0.035 * px).toFixed(2)}px)`; ig.globalAlpha = 0.35 * wet; ig.drawImage(cell, sx - cw / 2, sy - ch / 2); ig.filter = 'none'; }
    ig.globalAlpha = TONE.jiao; ig.drawImage(cell, sx - cw / 2, sy - ch / 2);
    ig.restore();
  }
}

// 钤印：拍点前半拍，印面的影子从模糊到清楚地落下（预备）；拍点那一帧印定（结果帧），之后印泥吃进纸里、略淡一点
function drawSeal(gx, fq, z) {
  const [cx, cy] = title.sealAt, size = L.seal.size;
  const [sx, sy] = toScreen(cx, cy, z), k = S * z, a = ACT.seal;
  if (fq >= a.f0 && fq < a.f1) {
    const u = seg(fq, a.f0, a.f1), r = size * k * (1.18 - 0.16 * u) / 2;
    gx.save(); gx.setTransform(1, 0, 0, 1, 0, 0); gx.globalCompositeOperation = 'multiply';
    gx.filter = `blur(${((14 - 10 * u) * k).toFixed(2)}px)`; gx.fillStyle = `rgba(120,108,92,${(0.12 + 0.16 * u).toFixed(3)})`;
    gx.fillRect(sx - r, sy - r, 2 * r, 2 * r); gx.restore();
  }
  if (fq < CUEF.seal) return;
  const absorb = 0.96 - 0.07 * ss(seg(fq, CUEF.seal, CUEF.seal + 1.5 * BEATF));
  const d = seal.size * z / (1 + L.push);          // 印按最大推近倍数生成，这里缩回当前倍数（只缩不放，不糊）
  gx.save(); gx.setTransform(1, 0, 0, 1, 0, 0); gx.translate(sx, sy); gx.rotate(-0.035);
  gx.globalCompositeOperation = 'multiply'; gx.globalAlpha = absorb; gx.drawImage(seal.cv, -d / 2, -d / 2, d, d);
  gx.restore();
}

export function TEXTS(t) {
  const fq = hold(frameOf(t, FPS), 2) * 2, z = zoom(t), out = [];
  const ps = title.cells.map((_, i) => ss(seg(fq, ...charWindow(i))));
  if (ps.some(p => p > 0)) {
    const px = title.size, c0 = title.cells[0], c1 = title.cells.at(-1);
    const box = title.vertical ? [c0.x - px / 2, c0.y - px / 2, c1.x + px / 2, c1.y + px / 2]
      : [c0.x - title.width / 2, c0.y - px * 0.6, c0.x + title.width / 2, c0.y + px * 0.6];
    out.push(textBox('title', TITLE, box, z, ps.reduce((a, b) => a + b, 0) / ps.length, title.family, title.missing));
  }
  if (fq >= CUEF.seal) {
    const [cx, cy] = title.sealAt, h = L.seal.size / 2;
    out.push(textBox('seal', SEAL_TEXT, [cx - h, cy - h, cx + h, cy + h], z, 1, report.fonts.seal.family, report.fonts.seal.missing));
  }
  return out;
}
function textBox(id, text, [ax, ay, bx, by], z, alpha, font, missing) {
  const [x0, y0] = toScreen(ax, ay, z), [x1, y1] = toScreen(bx, by, z);
  const r = { id, text, x0: Math.floor(x0), y0: Math.floor(y0), x1: Math.ceil(x1), y1: Math.ceil(y1), alpha: +alpha.toFixed(3), font, missing };
  r.box = [r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0];
  return r;
}

// 声像：按画面位置换成 −0.8..0.8；u 是这一笔从起点（0）到终点（1）
export function scene() {
  const DW = L.size[0], pan = x => +(clamp((x / DW) * 2 - 1, -1, 1) * 0.8).toFixed(3);
  return {
    chars: title.vertical ? title.chars.length : 1,
    pan: (name, u) => {
      if (L.strokes[name]) { const p = L.strokes[name].pts; return pan(p[0][0] + (p.at(-1)[0] - p[0][0]) * u); }
      if (name === 'seal') return pan(title.sealAt[0]);
      return pan(title.cells[Math.min(title.cells.length - 1, Math.floor(u * title.cells.length))].x);
    },
  };
}
