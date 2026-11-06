// 色指定：白天（午后）为标准色，按时段自动换算；肤色每套手指定（避免乘法把脸染粉）
// 主角唯一强调色：草帽上的薄荷绿丝带（在午后、夕阳、逆光三套里都跳出来）
import { hex } from './cel.js';

export const BASE = {
  skin: { f: '#ffdcc8', s: '#e8a896', h: '#fff4ec', l: '#6a3428' },
  blush: '#ff9c92',
  hair: { f: '#5b3333', s: '#391e26', h: '#a8705e', l: '#34183a' },
  lash: '#1e0e1a',
  eye: { f: '#a0602c', s: '#5c2c16', h: '#ffcf86', l: '#2a1008' },
  white_eye: '#fffaf4',
  mouth: '#a8434a',
  dress: { f: '#f7f5f0', s: '#b8bcd8', h: '#ffffff', l: '#4b4f78' },
  collar: { f: '#2c3c80', s: '#1b2554', h: '#5a72c4', l: '#0e1434' },
  straw: { f: '#f3d68c', s: '#c99c50', h: '#fff2c4', l: '#6c4818' },
  ribbon: { f: '#1fd6c2', s: '#0f9a8e', h: '#a6fbef', l: '#0a4842' },
  frame: { f: '#ec5a4c', s: '#b0333a', h: '#ffb0a0', l: '#55141c' },   // 自行车：番茄红车架（与丝带互补）
  chrome: { f: '#e2e8f2', s: '#6c7694', h: '#ffffff', l: '#2c3452' },
  tire: { f: '#2a2a34', s: '#17171e', h: '#5a5c74', l: '#09090d' },
  dark: { f: '#33354a', s: '#1c1e2a', h: '#585c78', l: '#0a0b12' },
  basket: { f: '#d9b47a', s: '#a37c46', h: '#f6e0b0', l: '#5a3c14' },
  sock: { f: '#ffffff', s: '#c4c8de', l: '#555a80' },
  shoe: { f: '#f2f2f6', s: '#a8acc4', h: '#ffffff', l: '#3a3e5c' },
  shoeStripe: '#e8483e',
  tramTop: { f: '#f4e8c6', s: '#c4b08a', h: '#fffaea', l: '#4e3e24' },
  tramLow: { f: '#2f7350', s: '#1c4a34', h: '#5fae84', l: '#0c2418' },
  tramWin: { f: '#2c4a62', s: '#1a2e40', h: '#9ad8f0', l: '#0c1824' },
  white: { f: '#f3f6fc', s: '#a9b3cd', h: '#ffffff', l: '#39456a' },
  magenta: { f: '#ff4fa8', s: '#b8327a', l: '#5c1238' },
};

const mul = (c, m) => { const v = hex(c); return '#' + v.map((x, i) => Math.max(0, Math.min(255, Math.round(x * m[i]))).toString(16).padStart(2, '0')).join(''); };

export const LIGHTS = {
  day: { lit: [1, 1, 1], shade: [1, 1, 1], line: [1, 1, 1] },
  gold: { lit: [1.03, .95, .86], shade: [.9, .8, .88], line: [1, .9, .9] },        // 午后偏暖（S2–S5）
  sunset: { lit: [1.06, .8, .66], shade: [.78, .54, .7], line: [1, .72, .8] },      // 夕阳（S8）
  backlit: { lit: [.52, .38, .56], shade: [.3, .2, .38], line: [.42, .26, .5] },  // 逆光剪影（S6、S7）
};
export function palette(name) {
  const L = LIGHTS[name], out = {};
  for (const [k, v] of Object.entries(BASE)) {
    if (typeof v === 'string') { out[k] = mul(v, L.lit); continue; }
    out[k] = {};
    for (const [kk, c] of Object.entries(v)) out[k][kk] = mul(c, kk === 's' ? L.shade : kk === 'l' ? L.line : L.lit);
  }
  return out;
}
export const PAL = { day: palette('day'), gold: palette('gold'), sunset: palette('sunset'), backlit: palette('backlit') };
// 肤色每套手指定
Object.assign(PAL.gold.skin, { f: '#ffd8bf', s: '#e39c88', h: '#fff1e2' });
Object.assign(PAL.sunset.skin, { f: '#f6c0a0', s: '#b9788a', h: '#ffe2c8', l: '#5a2a2a' });
Object.assign(PAL.sunset.dress, { f: '#e6d0ec', s: '#9c78a8', h: '#fff2fa', l: '#4a2a58' });   // 夕阳下白裙偏冷的淡紫（乘出来会和肤色撞成一个颜色，远景里看不出穿着衣服）
Object.assign(PAL.backlit.skin, { f: '#dcae98', s: '#a87482', h: '#ffd2ac', l: '#5a2c38' });   // 逆光肤色：白天肤色压暗约 18% 再偏暖（同一个人，只是背着光；不能变成棕色）
PAL.backlit.hair.h = '#5a3a5a';
PAL.backlit.blush = '#c06a70'; PAL.backlit.white_eye = '#d8c4cc'; PAL.backlit.eye = { f: '#86502a', s: '#4a2416', h: '#ffbe78', l: '#22100a' };
// 丝带在逆光里依然保持一点饱和（强调色规则）
PAL.backlit.ribbon = { f: '#13a898', s: '#0a6a62', h: '#7ff0e0', l: '#06302c' };
PAL.sunset.ribbon = { f: '#22d0b8', s: '#12907e', h: '#a8f8ea', l: '#0a423a' };
export const RIM = '#ffb468';   // 逆光暖色轮廓光
