// 喷枪背景：加载时画一次（颜色板 + 发光板成对），之后只平移。两套色指定：gold（午后）与 sunset（夕阳）
import { canvas, rng, rgba, mix, airbrush, vgrad, TAU, poly, path } from './cel.js';

export const MODES = {
  gold: {
    sky: [[0, '#2f63c8'], [.35, '#4f8de0'], [.62, '#8fc2ec'], [.82, '#f2d9b8'], [1, '#ffc79a']],
    cloudLit: '#fff8ee', cloudMid: '#f4e2d6', cloudSh: '#a8a6d2', cloudUnder: '#ffcfa6',
    sun: [430, 360], sunCol: '#fff4d0', glow: '#ffd28a',
    sea: [[0, '#9fc4dc'], [.12, '#4f8cc4'], [.5, '#2a5ea8'], [1, '#1d4688']], glint: '#fff2cc',
    island: '#7d9cc4', hill: '#3f8a5a', hillSh: '#2a5e48', hillLit: '#86c070', tree: '#2c6a46',
    wall: '#cdbfa8', wallSh: '#8e8296', road: '#7c7682', roadLit: '#9a929a', line: '#f2efe6', ballast: '#8a7c74', rail: '#c8ccd8',
    grass: '#5a9a4a', grassSh: '#2f6a3e', grassLit: '#a8d070', pole: '#5a5468', wire: '#3a3446',
    house: ['#e86a5a', '#4a78c8', '#e8e2d2', '#f0b04a'], win: '#3c4a6a', winLit: '#ffd98a', lit: 0,
  },
  sunset: {
    sky: [[0, '#3a2a7a'], [.3, '#7a3e9a'], [.55, '#e0607a'], [.78, '#ff9a5a'], [1, '#ffd27a']],
    cloudLit: '#ffc69a', cloudMid: '#e88a8a', cloudSh: '#6a4a8a', cloudUnder: '#ffb070',
    sun: [520, 548], sunCol: '#fff0b0', glow: '#ff9a4a',
    sea: [[0, '#f0a080'], [.1, '#a85a8a'], [.5, '#5a3a7a'], [1, '#2e2252']], glint: '#ffd890',
    island: '#7a4a7a', hill: '#4a3a6a', hillSh: '#2e2446', hillLit: '#c87a7a', tree: '#33284e',
    wall: '#c08a8a', wallSh: '#6a4a6a', road: '#5a4a62', roadLit: '#8a6a7a', line: '#f0d0c0', ballast: '#6a4e5e', rail: '#ffc0a0',
    grass: '#5a5a5a', grassSh: '#33304a', grassLit: '#c08a6a', pole: '#3a2e4a', wire: '#2a2038',
    house: ['#c85a5a', '#5a5a9a', '#d8b8b0', '#e09060'], win: '#3a2e4a', winLit: '#ffc070', lit: 1,
  },
};

// 积雨云：画在自己的离屏画布上（平底只切云本身）；每团用径向渐变（向光面亮、底部阴影），高处先画、低处叠上 → 菜花状层次；喷枪模糊
function cumulus(g, x, y, w, h, M, R, sunX) {
  const pad = 140, CW = Math.ceil(w + pad * 2), CH = Math.ceil(h + pad * 2);
  const [cv, c] = canvas(CW, CH), ox = x - w / 2 - pad, oy = y - h - pad;
  const dir = Math.sign(sunX - x) || -1, puffs = [];
  const n = Math.round(w / 9 + h / 12);
  for (let i = 0; i < n; i++) {
    const u = R(), prof = Math.pow(Math.sin(Math.PI * u), .6);
    const v = Math.pow(R(), .8);
    const r = (14 + R() * 46) * (.55 + prof * .8) * (1 - v * .35);
    const px = (u - .5) * w * (1 - v * .45), py = -v * h * prof * .92 - r * .3;
    puffs.push([px + w / 2 + pad, py + h + pad, r]);
  }
  puffs.sort((a, b) => a[1] - b[1]);
  // 实心云体（避免团与团之间透出天空）
  c.filter = 'blur(3px)'; c.fillStyle = M.cloudMid;
  for (const [px, py, r] of puffs) { c.beginPath(); c.arc(px, py + r * .25, r * 1.05, 0, TAU); c.fill(); }
  c.filter = 'blur(1.4px)';
  for (const [px, py, r] of puffs) {
    const gx = px + dir * r * .3, gy = py - r * .4;
    const gr = c.createRadialGradient(gx, gy, r * .1, px, py, r);
    gr.addColorStop(0, M.cloudLit); gr.addColorStop(.62, M.cloudLit); gr.addColorStop(.9, mix(M.cloudLit, M.cloudMid, .7)); gr.addColorStop(1, rgba(M.cloudMid, 0));
    c.fillStyle = gr; c.beginPath(); c.arc(px, py, r, 0, TAU); c.fill();
  }
  c.filter = 'blur(10px)';
  c.globalCompositeOperation = 'source-atop';
  // 底部整体压暗 + 暖色反光下沿
  const sh = c.createLinearGradient(0, pad, 0, h + pad); sh.addColorStop(0, rgba(M.cloudSh, 0)); sh.addColorStop(.55, rgba(M.cloudSh, .3)); sh.addColorStop(1, rgba(M.cloudSh, .75));
  c.fillStyle = sh; c.fillRect(0, 0, CW, CH);
  c.fillStyle = rgba(M.cloudUnder, .5); c.beginPath(); c.ellipse(w / 2 + pad, h + pad - 4, w * .45, 26, 0, 0, TAU); c.fill();
  c.globalCompositeOperation = 'destination-out'; c.filter = 'blur(3px)'; c.fillStyle = '#000'; c.fillRect(0, h + pad + 6, CW, CH);
  g.drawImage(cv, ox, oy);
}

// —— 天空板 ——
export function skyPlate(mode, PW, PH, seed = 3, o = {}) {
  const M = MODES[mode], [c, g] = canvas(PW, PH), [ec, e] = canvas(PW, PH), R = rng(seed);
  e.fillStyle = '#000'; e.fillRect(0, 0, PW, PH);
  const hz = o.horizon ?? PH;
  vgrad(g, 0, 0, PW, hz, M.sky);
  if (hz < PH) { g.fillStyle = M.sky[M.sky.length - 1][1]; g.fillRect(0, hz, PW, PH - hz); }
  const [sx, sy] = o.sun || M.sun;
  // 太阳光晕（颜色板 + 发光板）
  airbrush(g, sx, sy, 520, 420, M.glow, .55, 1);
  airbrush(g, sx, sy, 200, 200, '#ffffff', .5, 1);
  airbrush(e, sx, sy, 380, 300, M.glow, .45, 1);
  // 高空卷云丝
  g.save(); g.filter = 'blur(5px)';
  for (let i = 0; i < 26; i++) { const yy = R() * hz * .45, xx = R() * PW, L = 200 + R() * 500; g.fillStyle = rgba(M.cloudLit, .18 + R() * .2); g.beginPath(); g.ellipse(xx, yy, L, 6 + R() * 10, -.04, 0, TAU); g.fill(); }
  g.restore();
  // 积雨云（几座大的 + 远处一排低的）
  for (const [fx, fy, fw, fh] of (o.clouds || [[.66, .93, .3, .72], [.88, .95, .14, .3], [.3, .97, .12, .16]])) cumulus(g, PW * fx, hz * fy, PW * fw, hz * fh, M, R, sx);
  for (let i = 0; i < 9; i++) cumulus(g, R() * PW, hz - 2 - R() * 10, 140 + R() * 220, 36 + R() * 40, M, R, sx);
  // 太阳本体
  g.fillStyle = M.sunCol; g.beginPath(); g.arc(sx, sy, 46, 0, TAU); g.fill();
  e.fillStyle = M.sunCol; e.beginPath(); e.arc(sx, sy, 50, 0, TAU); e.fill();
  airbrush(e, sx, sy, 160, 160, '#ffffff', .6, 1);
  return { c, e: ec, W: PW, H: PH };
}

// —— 海 + 远岛 ——
export function seaPlate(mode, PW, PH, hz, seed = 5, sunX = 430) {
  const M = MODES[mode], [c, g] = canvas(PW, PH), [ec, e] = canvas(PW, PH), R = rng(seed);
  e.fillStyle = '#000'; e.fillRect(0, 0, PW, PH);
  vgrad(g, 0, hz, PW, PH - hz, M.sea);
  // 远岛
  g.save(); g.filter = 'blur(1.5px)';
  for (const [x0, w, h] of [[PW * .18, 380, 34], [PW * .5, 220, 22], [PW * .7, 520, 46]]) {
    g.fillStyle = M.island; g.beginPath(); g.moveTo(x0, hz + 1);
    for (let k = 0; k <= 12; k++) { const u = k / 12; g.lineTo(x0 + u * w, hz - Math.sin(Math.PI * u) ** .8 * h * (.8 + R() * .3)); }
    g.lineTo(x0 + w, hz + 1); g.fill();
  }
  g.restore();
  // 海平线亮线
  g.fillStyle = rgba('#ffffff', .55); g.fillRect(0, hz - 1, PW, 2);
  // 浪纹：越近越粗
  for (let i = 0; i < 520; i++) {
    const v = R(), y = hz + 4 + v * v * (PH - hz), x = R() * PW, L = 20 + v * 160, th = .8 + v * 3;
    g.fillStyle = rgba(i % 3 ? '#ffffff' : mix(M.sea[2][1], '#000000', .3), (i % 3 ? .16 : .25) * (1 - v * .3));
    g.fillRect(x, y, L, th);
  }
  // 太阳下的反光碎金
  for (let i = 0; i < 260; i++) {
    const v = R(), y = hz + 2 + v * v * (PH - hz), spread = 30 + v * 260, x = sunX + (R() - .5) * spread * 2, L = 8 + v * 70, th = 1 + v * 3;
    const a = .5 + R() * .5;
    g.fillStyle = rgba(M.glint, a); g.fillRect(x - L / 2, y, L, th);
    e.fillStyle = rgba(M.glint, a * .7); e.fillRect(x - L / 2, y, L, th);
  }
  return { c, e: ec, W: PW, H: PH };
}

// —— 陆地：岬角山丘 + 海堤 + 轨道 + 公路 + 草 ——（y 为板内坐标）
export const LAND = { wall: 720, rail: 760, road0: 792, road1: 905 };
export function landPlate(mode, PW, PH, seed = 7) {
  const M = MODES[mode], [c, g] = canvas(PW, PH), [ec, e] = canvas(PW, PH), R = rng(seed);
  e.fillStyle = '#000'; e.fillRect(0, 0, PW, PH);
  // 右端岬角（绿山 + 房子 + 灯塔）
  const hx = PW * .74;
  const hillP = [[hx - 200, LAND.wall + 4]];
  for (let k = 0; k <= 24; k++) { const u = k / 24; hillP.push([hx + u * (PW - hx + 100), LAND.wall - Math.pow(Math.sin(Math.min(1, u * 1.5) * Math.PI / 2), 1.3) * 330 - Math.sin(u * 20) * 8]); }
  hillP.push([PW + 100, LAND.wall + 4]);
  g.fillStyle = M.hill; g.beginPath(); hillP.forEach((p, i) => g[i ? 'lineTo' : 'moveTo'](p[0], p[1])); g.fill();
  g.save(); g.clip(); g.filter = 'blur(10px)';
  airbrush(g, hx + 200, LAND.wall - 200, 420, 160, M.hillLit, .55, 1);
  g.fillStyle = rgba(M.hillSh, .7); g.fillRect(hx - 200, LAND.wall - 60, PW, 80);
  g.restore();
  // 树丛
  for (let i = 0; i < 60; i++) {
    const u = R(), x = hx - 100 + u * (PW - hx + 100), top = LAND.wall - Math.pow(Math.sin(Math.min(1, ((x - hx) / (PW - hx + 100)) * 1.5) * Math.PI / 2), 1.3) * 330;
    const y = top + 10 + R() * (LAND.wall - top - 20), r = 14 + R() * 26;
    g.fillStyle = M.tree; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    g.fillStyle = rgba(M.hillLit, .5); g.beginPath(); g.arc(x - r * .3, y - r * .35, r * .5, 0, TAU); g.fill();
  }
  // 房子
  for (let i = 0; i < 9; i++) {
    const x = hx + 80 + i * 95 + R() * 30, y = LAND.wall - 30 - i * 26 - R() * 30, w = 54 + R() * 30, h = 34 + R() * 16;
    g.fillStyle = mix(M.house[2], '#000000', .05); g.fillRect(x, y - h, w, h);
    g.fillStyle = mix(M.house[2], M.wallSh, .4); g.fillRect(x + w * .7, y - h, w * .3, h);
    g.fillStyle = M.house[i % 2 ? 0 : 1]; g.beginPath(); g.moveTo(x - 6, y - h); g.lineTo(x + w / 2, y - h - 22); g.lineTo(x + w + 6, y - h); g.fill();
    for (let k = 0; k < 2; k++) {
      const lit = M.lit && R() < .8; g.fillStyle = lit ? M.winLit : M.win; g.fillRect(x + 8 + k * 22, y - h + 10, 12, 12);
      if (lit) { e.fillStyle = rgba(M.winLit, .8); e.fillRect(x + 6 + k * 22, y - h + 8, 16, 16); }
    }
  }
  // 灯塔
  const lx = PW - 300, ly = LAND.wall - 330;
  g.fillStyle = '#f4f0ea'; g.beginPath(); g.moveTo(lx - 16, ly); g.lineTo(lx + 16, ly); g.lineTo(lx + 11, ly - 110); g.lineTo(lx - 11, ly - 110); g.fill();
  g.fillStyle = mix('#f4f0ea', M.wallSh, .45); g.fillRect(lx + 4, ly - 110, 10, 110);
  g.fillStyle = '#d8584a'; g.fillRect(lx - 14, ly - 60, 28, 12);
  g.fillStyle = M.lit ? '#fff4c0' : '#9ab0c8'; g.fillRect(lx - 9, ly - 128, 18, 16);
  g.fillStyle = '#d8584a'; g.beginPath(); g.moveTo(lx - 13, ly - 128); g.lineTo(lx, ly - 142); g.lineTo(lx + 13, ly - 128); g.fill();
  if (M.lit) airbrush(e, lx, ly - 120, 60, 60, '#fff0b0', .9, 1);
  // 海堤
  vgrad(g, 0, LAND.wall - 18, PW, 36, [[0, mix(M.wall, '#ffffff', .25)], [.3, M.wall], [1, M.wallSh]]);
  g.fillStyle = rgba('#000000', .2); for (let x = 0; x < PW; x += 180) g.fillRect(x, LAND.wall - 18, 3, 36);
  // 轨道：道砟 + 两根轨
  vgrad(g, 0, LAND.wall + 18, PW, LAND.road0 - LAND.wall - 18, [[0, mix(M.ballast, '#000000', .2)], [1, M.ballast]]);
  for (let i = 0; i < 900; i++) { g.fillStyle = rgba(R() < .5 ? '#ffffff' : '#000000', .12); g.fillRect(R() * PW, LAND.wall + 20 + R() * (LAND.road0 - LAND.wall - 24), 3, 2); }
  for (let x = 0; x < PW; x += 26) { g.fillStyle = mix(M.ballast, '#3a2a2a', .5); g.fillRect(x, LAND.rail - 8, 12, 26); }
  for (const yy of [LAND.rail - 4, LAND.rail + 12]) { g.fillStyle = M.rail; g.fillRect(0, yy, PW, 4); g.fillStyle = rgba('#000000', .35); g.fillRect(0, yy + 4, PW, 2); }
  // 公路
  vgrad(g, 0, LAND.road0, PW, LAND.road1 - LAND.road0, [[0, M.roadLit], [.4, M.road], [1, mix(M.road, '#000000', .25)]]);
  g.fillStyle = M.line; g.fillRect(0, LAND.road0 + 6, PW, 4);
  for (let x = 0; x < PW; x += 120) g.fillRect(x, (LAND.road0 + LAND.road1) / 2 + 20, 60, 4);
  // 路边草
  vgrad(g, 0, LAND.road1, PW, PH - LAND.road1, [[0, M.grassLit], [.25, M.grass], [1, M.grassSh]]);
  for (let i = 0; i < 1400; i++) {
    const x = R() * PW, y = LAND.road1 + 6 + R() * (PH - LAND.road1), h = 10 + R() * 30;
    g.strokeStyle = rgba(R() < .5 ? M.grassSh : M.grassLit, .6); g.lineWidth = 2; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (R() - .5) * 10, y - h); g.stroke();
  }
  return { c, e: ec, W: PW, H: PH };
}

// 电线杆 + 架空线（每帧画，跟着陆地层走）
export function poles(g, M, x0, PW, top, base, step = 340, lw = 1) {
  g.save();
  g.strokeStyle = M.wire; g.lineWidth = 2 * lw;
  for (const dy of [0, 18]) { g.beginPath(); for (let x = x0 % step - step; x < PW + step; x += step) { g.moveTo(x, top + 30 + dy); g.quadraticCurveTo(x + step / 2, top + 48 + dy, x + step, top + 30 + dy); } g.stroke(); }
  for (let x = x0 % step - step; x < PW + step; x += step) {
    g.fillStyle = M.pole; g.fillRect(x - 6 * lw, top, 12 * lw, base - top);
    g.fillStyle = rgba('#ffffff', .25); g.fillRect(x - 6 * lw, top, 3 * lw, base - top);
    g.fillStyle = M.pole; g.fillRect(x - 6 * lw, top + 24, 60 * lw, 8 * lw);
  }
  g.restore();
}
