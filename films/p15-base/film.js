// 《概念样片》画面：Canvas 2D，宣纸底 + 三笔墨线（一拍二抖动）+ 片名 + 朱印。只依赖 engine/，不依赖 three.js。
// 所有时刻来自 timeline.js；render(t) 不读时钟、不留上一帧的状态，任意帧可单独重渲。
import { clamp, seg, eo, ss, mulberry } from '../../engine/core/math.js';
import { tick } from '../../engine/core/clock.js';
import { createNoise2D } from '../../engine/core/noise.js';
import { createInk } from '../../engine/paint/ink.js';
import { washTexture, washOver } from '../../engine/paint/wash.js';
import { fontSpec, rgba, measure } from '../../engine/overlay/text.js';
import { T, BEAT } from './timeline.js';

export const TITLE = '概念样片';
const PAPER = '#f2ebdb', INK = '#1d1b1a', SEAL = [178, 38, 30];
const FONT = ['BM Sans'];                    // 片名字体（main.js 加载）；子集里没有的字回落到系统无衬线
const STROKE_D = 0.4;                        // 每笔书写时长（秒）

// 三笔远山：设计坐标 1920 × 1080，确定性的折线（种子固定）
const R = mulberry(7);
const HILLS = [[160, 650, 90], [500, 570, 140], [840, 670, 80]].map(([x0, y0, amp], i) => {
  const pts = [], w = 760 + i * 120, ph = R() * 6;
  for (let k = 0; k <= 90; k++) {
    const u = k / 90;
    pts.push([x0 + u * w, y0 - amp * Math.sin(Math.PI * u) * (0.75 + 0.25 * Math.sin(u * 9 + ph))]);
  }
  return pts;
});

let g, W, H, S, ink, wash;
export function setup(canvas) {
  W = canvas.width = innerWidth; H = canvas.height = innerHeight; S = H / 1080;
  g = canvas.getContext('2d');
  ink = createInk(createNoise2D(mulberry(11)));
  wash = washTexture({ blotch: createNoise2D(mulberry(3)), grain: createNoise2D(mulberry(5)), light: [255, 250, 236], dark: [196, 182, 150] });
}

const X = x => W / 2 + (x - 960) * S, Y = y => H / 2 + (y - 540) * S;
function titleLayout() {
  const font = fontSpec(600, 96 * S, FONT), m = measure(TITLE, font, 8 * S);
  return { font, x: W / 2 - m.w / 2, y: Y(880), w: m.w, asc: m.asc, desc: m.desc };
}

export function render(t) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = PAPER; g.fillRect(0, 0, W, H);
  washOver(g, wash, 0.55);

  // 墨线：笔尖在一拍二（12 fps）上前进，抖动也一拍二换形
  const step = tick(t, 12), tq = step / 12;
  ['s1', 's2', 's3'].forEach((k, i) => {
    const p = eo(seg(tq, T[k], T[k] + STROKE_D));
    if (p <= 0) return;
    const pts = HILLS[i], n = Math.max(3, Math.round(pts.length * p));
    ink.line(g, pts.slice(0, n).map(([x, y]) => [X(x), Y(y)]), { px: v => v * S * 1.6, step, seed: i + 1, color: INK, size: 6 + i * 1.5, alpha: 0.92 });
  });

  // 片名：节拍点上落定（略微下沉 + 淡入）
  const a = ss(seg(t, T.title - BEAT * 0.5, T.title));
  if (a > 0) {
    const L = titleLayout();
    g.save(); g.font = L.font; g.textBaseline = 'alphabetic'; if ('letterSpacing' in g) g.letterSpacing = `${8 * S}px`;
    g.fillStyle = rgba([29, 27, 26], a); g.fillText(TITLE, L.x, L.y + (1 - a) * 14 * S); g.restore();
  }

  // 朱印：钤下的一帧最重，之后略回弹
  if (t >= T.seal) {
    const u = clamp((t - T.seal) / 0.12), s = 1.25 - 0.25 * eo(u), L = titleLayout(), side = 84 * S * s;
    const cx = L.x + L.w + 70 * S, cy = L.y - L.asc / 2;
    g.save(); g.translate(cx, cy); g.rotate(-0.06);
    g.fillStyle = rgba(SEAL, 0.9); g.fillRect(-side / 2, -side / 2, side, side);
    g.strokeStyle = rgba([250, 240, 228], 0.85); g.lineWidth = 5 * S;
    g.strokeRect(-side / 2 + 10 * S, -side / 2 + 10 * S, side - 20 * S, side - 20 * S);
    g.restore();
  }
}

// 画面上的字（给检查工具读）：{ id, text, x0, y0, x1, y1 }
export function TEXTS(t) {
  if (t < T.title - BEAT * 0.5) return [];
  const L = titleLayout();
  return [{ id: 'title', text: TITLE, x0: Math.floor(L.x), y0: Math.floor(L.y - L.asc), x1: Math.ceil(L.x + L.w), y1: Math.ceil(L.y + L.desc) }];
}
