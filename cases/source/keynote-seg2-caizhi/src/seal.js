// 朱红方印：不规则印面 + 印泥残缺/斑点；白文（文字镂空露纸）。
// sealText：Ma Shan Zheng 反白；sealRosette：肖形印，印文是一朵八瓣团花（无文字）。
import { cv } from './assets.js';
import { vnoise, mulberry } from '/core/lib.js';

export const VERM = [190, 58, 46];                    // #BE3A2E
export const VERM_MUL = [201, 62, 53];               // multiply 到宣纸上后 ≈ #BE3A2E

function face(g, S, seed, color) {
  const jit = S * .02; g.beginPath();
  const N = 36;
  for (let i = 0; i < N; i++) {
    const t = i / N * 4, side = Math.floor(t), u = t - side;
    let px, py; if (side === 0) { px = u * S; py = 0; } else if (side === 1) { px = S; py = u * S; } else if (side === 2) { px = S - u * S; py = S; } else { px = 0; py = S - u * S; }
    px += (vnoise(seed + i * 1.3) - .5) * jit * 2; py += (vnoise(seed + 40 + i * 1.3) - .5) * jit * 2;
    i ? g.lineTo(px, py) : g.moveTo(px, py);
  }
  g.closePath(); g.fillStyle = `rgb(${color.join(',')})`; g.fill();
}
function wear(g, S, seed) {   // 印泥不匀：白点、边缘缺口、少量纹理
  const R = mulberry(seed * 31 + 7);
  g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000';
  for (let i = 0; i < 110; i++) { const a = R() * S, b = R() * S, r = S * (.003 + .011 * R() * R()); g.globalAlpha = .4 + .6 * R(); g.beginPath(); g.arc(a, b, r, 0, 7); g.fill(); }
  for (let i = 0; i < 9; i++) {  // 边缘残缺
    const side = Math.floor(R() * 4), u = R(), r = S * (.015 + .03 * R());
    const p = [[u * S, 0], [S, u * S], [u * S, S], [0, u * S]][side];
    g.globalAlpha = .9; g.beginPath(); g.ellipse(p[0], p[1], r * 1.6, r, R() * 3, 0, 7); g.fill();
  }
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
}

export function sealText(lines, S, seed = 5, color = VERM_MUL) {
  const pad = S * .1, c = cv(S + pad * 2, S + pad * 2), g = c.getContext('2d');
  g.translate(pad, pad); face(g, S, seed, color);
  g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000';
  const n = lines.length, fs = S * .44;
  g.font = `${fs}px MaShanZheng`; g.textAlign = 'center'; g.textBaseline = 'middle';
  lines.forEach((ln, i) => {
    const y = S * (n === 1 ? .5 : .29 + .42 * i);
    g.save(); g.translate(S / 2, y); g.scale(1.08, 1); g.fillText(ln, 0, fs * .03); g.restore();
  });
  // 内边框（白文印常见的细边）
  g.lineWidth = S * .028; g.strokeStyle = '#000'; g.strokeRect(S * .07, S * .07, S * .86, S * .86);
  g.globalCompositeOperation = 'source-over';
  wear(g, S, seed);
  return { c, pad, S };
}

// 团花路径（8 瓣，D4 对称）：供肖形印与窗扇花样共用
export function rosettePath(g, cx, cy, R, o = {}) {
  const petals = o.petals ?? 8;
  g.beginPath();
  for (let k = 0; k < petals; k++) {   // 花瓣（两条弧）
    const a = k / petals * Math.PI * 2, a1 = a - Math.PI / petals * .62, a2 = a + Math.PI / petals * .62;
    g.moveTo(cx + Math.cos(a) * R * .3, cy + Math.sin(a) * R * .3);
    g.quadraticCurveTo(cx + Math.cos(a1) * R * 1.05, cy + Math.sin(a1) * R * 1.05, cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    g.quadraticCurveTo(cx + Math.cos(a2) * R * 1.05, cy + Math.sin(a2) * R * 1.05, cx + Math.cos(a) * R * .3, cy + Math.sin(a) * R * .3);
  }
  g.moveTo(cx + R * .22, cy); g.arc(cx, cy, R * .22, 0, Math.PI * 2);
}

export function sealRosette(S, seed = 11, color = VERM) {
  const pad = S * .1, c = cv(S + pad * 2, S + pad * 2), g = c.getContext('2d');
  g.translate(pad, pad); face(g, S, seed, color);
  g.globalCompositeOperation = 'destination-out'; g.strokeStyle = '#000'; g.lineCap = 'round'; g.lineJoin = 'round';
  g.lineWidth = S * .035; rosettePath(g, S / 2, S / 2, S * .36); g.stroke();
  g.lineWidth = S * .028; g.strokeRect(S * .07, S * .07, S * .86, S * .86);
  g.globalCompositeOperation = 'source-over';
  wear(g, S, seed);
  return { c, pad, S };
}
