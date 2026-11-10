// 《{{TITLE}}》画面：宣纸上三笔山——主峰浓墨"一笔成山"、收笔飞白；次峰重墨；远山淡墨湿笔晕开——
// 山腰与山脚的云把墨"提"走（露出纸白），片名竖排题在右上的留白里，最后钤一方白文朱印。
// Canvas 2D；只依赖 engine/、本目录的 paper.js / brush.js / seal.js / type.js 与 C 路线的片名字体（routes/c-style/fonts/）；
// 所有时刻来自 timeline.js（它读 film.json）。
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
import { prepareStroke, reveal, drawStroke, makeMass, drawMass } from './brush.js';
import { makeSeal } from './seal.js';
import { pickFont } from './type.js';
import { FPS, DUR, F as CUEF, BEATF, ACT } from './timeline.js';

export const TITLE = '{{TITLE}}';
export const SEAL_TEXT = '北冥';                       // 印文：换成自己的落款（1–4 字），字体里要有这些字
// 字体表（type.js 的 registerFonts）：片名与印文按顺序取第一个"字都有"的字体，所以作品自己的字体插到最前面就优先用。
//   { family, manifest }  分片字体：只下载片名、印文用得到的那几片
//   { family, src }       一个字体文件：作品自己的 OFL 子集放进作品目录（如 ./fonts/title.woff2），许可文件一并放进去
export const FONTS = [
  { family: 'BM Brush', manifest: '../../routes/c-style/fonts/fonts.json' },   // 马善政毛笔楷书全部 7015 字（简体，OFL），见那个目录的 README
];
const TITLE_FAMILIES = FONTS.map(f => f.family), SEAL_FAMILIES = TITLE_FAMILIES;

const INK = '#1b1916', VERMILION = [176, 46, 34];
const TONE = { jiao: 0.95, nong: 0.9, zhong: 0.56, dan: 0.3, qing: 0.16 };   // 墨分五色：焦 浓 重 淡 清
const MASSES = ['s3', 's2', 's1'];                                           // 染的顺序：远 → 近（近处的墨压在远处之上）
const STROKES = ['s3', 's2', 's1', 'w1', 'w2'];                              // 笔的顺序：远山、次峰、主峰、两道水纹

// ———— 构图（设计坐标）。改构图只改这里；笔的字段见 brush.js 开头 ————
// 笔压（pressure）决定粗细，也决定快慢：brush.js 让按得重的地方走得慢、提起来的地方一掠而过，转折处再顿一下。
// 所以下面的笔压曲线就是这一笔的"节奏"：粗细差拉开到三倍以上，远看才不是一根等宽线。
const MAIN = {   // 主峰"一笔成山"：左脚藏锋按下 → 提笔快速上坡（最细、略枯）→ 峰顶顿笔转折 → 侧锋铺开下坡 → 越走越枯，飞白出锋
  width: 38, entry: 40, exit: 150, tone: TONE.nong, seed: 11, lanes: 22, bleed: 1.6,
  pressure: [[0, 1], [0.04, 0.82], [0.12, 0.48], [0.27, 0.3], [0.37, 0.4], [0.42, 0.95], [0.46, 0.72], [0.56, 0.9], [0.7, 0.76], [0.86, 0.5], [1, 0.16]],
  dry: [[0, 0], [0.16, 0.06], [0.27, 0.26], [0.36, 0.08], [0.43, 0], [0.56, 0.1], [0.7, 0.3], [0.86, 0.62], [1, 0.95]],
};
const SECOND = { // 次峰：从主峰右坡后面露锋"冒出来"，峰顶顿一下，收笔略枯
  width: 25, entry: 60, start: 'tip', exit: 90, tone: TONE.zhong, seed: 23, lanes: 18, bleed: 1.8,
  pressure: [[0, 0.62], [0.1, 0.74], [0.3, 0.4], [0.42, 0.92], [0.5, 0.6], [0.76, 0.7], [1, 0.2]],
  dry: [[0, 0], [0.32, 0.12], [0.45, 0.02], [0.8, 0.4], [1, 0.75]],
};
const FAR = {    // 远山：淡墨湿笔，几乎不枯；合成时垫一层晕开的墨（wet），远处不要硬边
  width: 27, entry: 70, start: 'tip', exit: 80, tone: TONE.dan, seed: 37, lanes: 14, wet: 6,
  pressure: [[0, 0.45], [0.24, 0.86], [0.5, 0.66], [0.72, 0.8], [1, 0.3]],
};
const WATER = {  // 水纹：清墨枯笔，快速一掠（水即留白，三笔带出水面，一笔比一笔短）
  width: 9, entry: 30, start: 'tip', exit: 60, tone: TONE.qing * 1.9, lanes: 9, streak: 60, turn: 0,
  pressure: [[0, 0.6], [0.25, 1], [0.6, 0.7], [1, 0.25]], dry: [[0, 0.08], [0.4, 0.22], [0.75, 0.6], [1, 0.92]],
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
      w1: { ...WATER, seed: 51, pts: [[1090, 846], [1190, 840], [1300, 839], [1410, 843], [1480, 847]] },
      w2: { ...WATER, seed: 53, width: 7, pts: [[1220, 884], [1300, 880], [1384, 881], [1430, 884]] },
    },
    masses: { s1: { base: 790, tone: 0.32, band: 0.09 }, s2: { base: 770, tone: 0.2, band: 0.12 }, s3: { base: 640, tone: 0.12, band: 0.16 } },
    // 云：几团压扁的椭圆把墨"提"走（destination-out）。腰云横过主峰，脚下的雾把山脚化开；只往右漂一点
    mist: [{ x: 360, y: 606, rx: 250, ry: 40, a: 0.78 }, { x: 610, y: 628, rx: 230, ry: 34, a: 0.7 }, { x: 860, y: 650, rx: 220, ry: 30, a: 0.62 },
      { x: 300, y: 790, rx: 420, ry: 70, a: 0.72 }, { x: 900, y: 772, rx: 470, ry: 60, a: 0.66 }, { x: 1420, y: 740, rx: 420, ry: 56, a: 0.6 }],
    drift: 28,
    // 题名：竖排时 x 是字的中心线、y 是第一个字的上沿；横排（非中日文或超过 8 个字）时题名与印作为一组右对齐到 hx、中线在 hy。
    // 位置按"推到最近时仍在图文安全区内"定（16:9 每边 5%）：缓推会把右上角的字往外推约 3.5%
    title: { x: 1742, y: 160, size: 96, gap: 1.12, maxY: 560, hx: 1780, hy: 930, hsize: 72, hmax: 980 },
    seal: { size: 74, gap: 0.5 },
  },
  // 竖屏（9:16 社媒）：不是横屏裁切，另排一套。平台界面压住右侧约 12%、底部约 18%（QA 的竖屏安全区），
  // 所以山整体上提，底部留给纸与雾（平台字幕落在这里也不挡主体）；题名放大、收进右上的安全区，印在题名下方
  portrait: {
    size: [1080, 1920], focus: [560, 870], push: 0.035,
    strokes: {
      s1: { ...MAIN, pts: [[48, 1412], [112, 1302], [176, 1184], [234, 1056], [282, 930], [322, 820], [356, 750], [372, 724], [384, 718],
        [404, 730], [456, 780], [520, 846], [596, 920], [688, 1000], [784, 1076], [878, 1146], [966, 1210], [1034, 1254]] },
      s2: { ...SECOND, pts: [[556, 1424], [628, 1350], [700, 1302], [744, 1282], [760, 1278], [778, 1281], [852, 1302], [932, 1340], [1006, 1380], [1064, 1412]] },
      s3: { ...FAR, pts: [[548, 862], [610, 816], [676, 780], [724, 762], [740, 758], [760, 761], [826, 782], [900, 818], [972, 858], [1032, 896]] },   // 远山压低，离印至少一个印的高度，不相切
      w1: { ...WATER, seed: 51, pts: [[520, 1564], [612, 1558], [712, 1558], [812, 1563]] },
      w2: { ...WATER, seed: 53, width: 7, pts: [[640, 1606], [712, 1602], [790, 1604]] },
    },
    masses: { s1: { base: 1450, tone: 0.32, band: 0.07 }, s2: { base: 1480, tone: 0.2, band: 0.12 }, s3: { base: 960, tone: 0.12, band: 0.16 } },
    mist: [{ x: 250, y: 1080, rx: 210, ry: 40, a: 0.78 }, { x: 470, y: 1112, rx: 200, ry: 34, a: 0.7 }, { x: 700, y: 1146, rx: 190, ry: 30, a: 0.62 },
      { x: 300, y: 1460, rx: 420, ry: 80, a: 0.72 }, { x: 860, y: 1450, rx: 400, ry: 70, a: 0.66 }],
    drift: 18,
    title: { x: 800, y: 240, size: 120, gap: 1.12, maxY: 640, hx: 900, hy: 330, hsize: 72, hmax: 780 },
    seal: { size: 84, gap: 0.5 },
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
    // 横排：题名与印作为一组右对齐到 hx（印在题名右边），太长就整体缩字号，不越出 hmax
    const m = document.createElement('canvas').getContext('2d');
    m.font = `400 ${t.hsize}px "${pick.family}", serif`;
    const w = m.measureText(TITLE).width, room = L.seal.size + 0.4 * t.hsize, max = t.hmax - room;
    title.size = w > max ? t.hsize * max / w : t.hsize;
    title.width = Math.min(w, max);
    title.cells = [{ ch: TITLE, x: t.hx - room - title.width / 2, y: t.hy }];
    title.sealAt = [t.hx - L.seal.size / 2, t.hy];
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
// 笔走到哪：时间窗里过去的比例交给 brush.reveal 换成弧长——进入时间窗就先按下笔头（第一帧就有东西：钩子），
// 之后按这一笔自己的快慢走（粗处慢、细处快、转折处顿），拍点那一帧正好写完
const strokeP = (k, fq) => (fq < ACT[k].f0 ? 0 : reveal(strokes[k], seg(fq, ACT[k].f0, ACT[k].f1)));

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
    gx.filter = `blur(${((13 - 10 * u) * k).toFixed(2)}px)`; gx.fillStyle = `rgba(132,92,74,${(0.05 + 0.15 * u * u).toFixed(3)})`;
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
