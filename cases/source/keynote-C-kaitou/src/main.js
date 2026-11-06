// 方案 C《打开》20 秒开头：入口。render(t) 是 t 的纯函数（逐帧可独立渲染）。
import { DUR, T, events, LABEL } from './timeline.js';
import { layout, drawCover, coverTexts, coverState, W as CW_, H as CH_ } from './cover.js';
import { makeStage } from './stage.js';

const M = '/@film/material/';
const load = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('image ' + src)); i.src = src; });

await Promise.all([document.fonts.load('800 200px Inter', '1960254778912'), document.fonts.load('700 200px NSC', '上美影IP全景' + LABEL)]);
const IMG = {};
const list = { wukong: 'P02_孙悟空_大闹天宫海报.png', heimao: 'P02_黑猫警长_海报.png', hulu: 'P02_葫芦兄弟_海报.png', still: 'P05_孙悟空_大闹天宫剧照.png', cloth: '书封布面.png' };
await Promise.all(Object.entries(list).map(async ([k, f]) => { IMG[k] = await load(M + encodeURI(f)); }));

const S2 = 2;                                        // 书封画布 2 倍（3840×2160），与 2× 超采样对齐
const coverC = document.createElement('canvas'); coverC.width = CW_ * S2; coverC.height = CH_ * S2;
const cx = coverC.getContext('2d');
layout(cx);
drawCover(cx, 0, S2);
const S = await makeStage(IMG, coverC);

const COVER_STATIC = T.title[2] + .3;               // 之后版面不再变化
let lastCoverT = null;
window.DUR = DUR;
window.EV = events();
window.render = t => {
  const ct = Math.min(t, COVER_STATIC);
  if (ct !== lastCoverT) { drawCover(cx, ct, S2); S.coverTex.needsUpdate = true; lastCoverT = ct; }
  S.update(t); S.render();
};
// 画面上每段文字的框（readcheck）
window.TEXTS = t => {
  S.update(t);
  const out = [];
  if (t < T.open) {
    for (const b of coverTexts(Math.min(t, COVER_STATIC))) {
      if (t < T.lamp) { out.push(b); continue; }
      const pts = [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]].map(([u, v]) => { const p = S.coverToWorld(u, v); return S.project(p.x, p.y, p.z); });
      out.push({ id: b.id, text: b.text, x0: Math.min(...pts.map(p => p[0])), y0: Math.min(...pts.map(p => p[1])), x1: Math.max(...pts.map(p => p[0])), y1: Math.max(...pts.map(p => p[1])) });
    }
  }
  if (t >= T.typing[0]) {
    const pts = S.labelBox();
    out.push({ id: 'label', text: LABEL, x0: Math.min(...pts.map(p => p[0])), y0: Math.min(...pts.map(p => p[1])), x1: Math.max(...pts.map(p => p[0])), y1: Math.max(...pts.map(p => p[1])) });
  }
  return out;
};
window.PROBE = t => { S.update(t); const pts = S.labelBox(); const lbox = [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
  return { ...coverState(t), ...JSON.parse(JSON.stringify(S.state)), lbox }; };
window.S3 = S;   // 调试/几何检查句柄（tools/geo.mjs）
window.READY = true;
