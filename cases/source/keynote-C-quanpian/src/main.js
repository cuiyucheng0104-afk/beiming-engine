// 方案 C《打开》全片 180 s：入口。render(t) 是 t 的纯函数（逐帧可独立渲染）。
// 0–20 s：开头原工程（cover.js + stage.js）原样渲染；20 s 起：共用层（shared/world.js）+ 五个章节模块（chapters/*.js）。
// URL 参数：?seg=ch2 | ch3.ink | 20:30  只渲染这一段（DUR = 段长，render(t) 画的是 t + 段起点）；?ss=1 降低超采样（快速预览）
import { DUR, T, events, LABEL, KAITOU_DUR, CH, CHAPTERS, BOOK, KEY, partRange } from './timeline.js';
import { layout, drawCover, coverTexts, coverState, W as CW_, H as CH_ } from './cover.js';
import { makeStage } from './stage.js';
import { makeWorld } from './shared/world.js';
import { allChars } from './shared/texts.js';

const M = '/@film/material/';
const load = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('image ' + src)); i.src = src; });

const ALL = allChars();
await Promise.all([document.fonts.load('800 200px Inter', '1960254778912'), document.fonts.load('700 200px NSC', '上美影IP全景' + LABEL),
  document.fonts.load('700 200px SC', ALL), document.fonts.load('500 200px SCM', ALL),
  ...[500, 700, 800].map(w => document.fonts.load(`${w} 200px InterF`, 'AZaz09.|'))]);
const IMG = {};
const list = { wukong: 'P02_孙悟空_大闹天宫海报.png', heimao: 'P02_黑猫警长_海报.png', hulu: 'P02_葫芦兄弟_海报.png', still: 'P05_孙悟空_大闹天宫剧照.png', cloth: '书封布面.png' };
await Promise.all(Object.entries(list).map(async ([k, f]) => { IMG[k] = await load(M + encodeURI(f)); }));

const S2 = 2;                                        // 书封画布 2 倍（3840×2160），与 2× 超采样对齐
const coverC = document.createElement('canvas'); coverC.width = CW_ * S2; coverC.height = CH_ * S2;
const cx = coverC.getContext('2d');
layout(cx);
drawCover(cx, 0, S2);
const S = await makeStage(IMG, coverC);
// 视口不是 1920×1080 时（--size 960x540 低成本预览），画布按视口缩放显示；内部分辨率不变
{ const el = S.renderer.domElement; el.style.width = innerWidth + 'px'; el.style.height = innerHeight + 'px'; }

const COVER_STATIC = T.title[2] + .3;               // 之后版面不再变化
let lastCoverT = null;
// 封面叠印（第七章合书后出现的封面字）：ctx.book.setCoverOverlay(from, (x, t, S2) => {...})
let overlay = null;
const Wd = await makeWorld(S, {});
Wd.ctx.book.coverCanvas = coverC;
Wd.ctx.book.setCoverOverlay = (from, fn) => { overlay = { from, fn }; };
await Wd.load(CHAPTERS);

function drawCoverAt(t) {
  if (overlay && t >= overlay.from) {
    const key = 'ov' + t;
    if (key !== lastCoverT) { drawCover(cx, COVER_STATIC, S2); overlay.fn(cx, t, S2); S.coverTex.needsUpdate = true; lastCoverT = key; }
    return;
  }
  const ct = Math.min(t, COVER_STATIC);
  if (ct !== lastCoverT) { drawCover(cx, ct, S2); S.coverTex.needsUpdate = true; lastCoverT = ct; }
}
function frame(t) { drawCoverAt(t); Wd.update(t); S.render(); }

// —— 分段渲染 ——
function segRange() {
  const q = new URLSearchParams(location.search).get('seg');
  if (!q || q === 'all') return [0, DUR];
  let m = /^([\d.]+):([\d.]+)$/.exec(q); if (m) return [+m[1], +m[2]];
  m = /^(ch\d+)(?:\.(\w+))?$/.exec(q);
  if (m && CH[m[1]]) return m[2] ? partRange(m[1], m[2]) : CH[m[1]].range;
  throw new Error(`seg=${q} 认不出：用 ch2 / ch2.b / 20:30`);
}
const [SEG0, SEG1] = segRange();
window.SEG = [SEG0, SEG1];
window.DUR = +(SEG1 - SEG0).toFixed(6);

// —— 事件：开头原表（chap:'ch1'）+ 共用（翻页、合书、台灯）+ 各章 events() ——
const evK = events().map(e => ({ ...e, chap: 'ch1' }));   // 注意：开头的打字事件自带 ch 字段（= 那个字），章节归属用 chap
window.EV = [...evK, ...Wd.sharedEvents(), ...Wd.chapterEvents()].sort((a, b) => a.t - b.t);   // 稳定排序：开头事件的相对次序不变
window.render = tt => frame(tt + SEG0);

// 画面上每段文字的框（readcheck / tools/textcheck.mjs）。t 是全片时间（分段模式也一样）
const LABEL_GONE = +(KEY.ch2.label + .36).toFixed(4);   // 开头的纸条标签：第二章在 20.5 s 用 0.36 s 把它扣倒，之后画面上看不到这句字
window.TEXTS = t => {
  Wd.update(t);
  const out = [];
  if (t < T.open) {
    for (const b of coverTexts(Math.min(t, COVER_STATIC))) {
      if (t < T.lamp) { out.push(b); continue; }
      const pts = [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]].map(([u, v]) => { const p = S.coverToWorld(u, v); return S.project(p.x, p.y, p.z); });
      out.push({ id: b.id, text: b.text, x0: Math.min(...pts.map(p => p[0])), y0: Math.min(...pts.map(p => p[1])), x1: Math.max(...pts.map(p => p[0])), y1: Math.max(...pts.map(p => p[1])) });
    }
  }
  if (t >= T.typing[0] && t < LABEL_GONE) {
    const pts = S.labelBox();
    out.push({ id: 'label', text: LABEL, x0: Math.min(...pts.map(p => p[0])), y0: Math.min(...pts.map(p => p[1])), x1: Math.max(...pts.map(p => p[0])), y1: Math.max(...pts.map(p => p[1])) });
  }
  return out.concat(Wd.chapterTexts(t));
};
// 开头的逐帧状态（tools/probe.mjs，0–20 s，与开头工程相同）
window.PROBE = t => { S.update(t); const pts = S.labelBox(); const lbox = [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
  return { ...coverState(t), ...JSON.parse(JSON.stringify(S.state)), lbox }; };
// 全片状态（书页角度、台灯、各章 probe()）：tools/cuecheck.py 用来核对翻页落在哪一帧
window.PROBE2 = t => { Wd.update(t); return Wd.probe(t); };
window.S3 = S; window.WORLD = Wd;   // 调试/几何检查句柄（tools/geo.mjs）
window.READY = true;
