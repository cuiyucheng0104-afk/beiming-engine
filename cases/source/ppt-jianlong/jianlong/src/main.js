// 《见龙》页面入口：时间线 → 分段模块 → 画面（WebGL 图版 + 2D 叠层）→ 终合成。
// 地址参数：?seg=S03 只渲染该段（DUR = 段长，t=0 对应段首）；?from=a&to=b 渲染全片的一个时间窗。
import { createGL, INK, PAPER, normCam, camLerp } from './core/gl.js';
import { createPlates } from './core/plates.js';
import { createUI, C } from './core/ui.js';
import { rain, subtitles, createInk, veil } from './core/fx.js';
import * as lib from '/core/lib.js';

const q = new URLSearchParams(location.search);
const J = async (u, fb) => { const r = await fetch(u); if (!r.ok) { if (fb !== undefined) return fb; throw new Error('缺文件 ' + u); } return r.json(); };
const TL = await J('/@film/data/timeline.json');
const CUES = await J('/@film/data/subs.json');
const VOENV = await J('/@film/data/vo_env.json');
const WORDS = await J('/@film/data/words.json');
const WL = await J('/@film/data/whitelist.json');
const SEGS = TL.segments;
const allow = new Set([...WL.all, ...CUES.map(c => c.text)]);

// 时间窗
const segArg = q.get('seg');
const S0 = segArg ? SEGS.find(s => s.seg === segArg) : null;
if (segArg && !S0) throw new Error('没有这一段：' + segArg);
const T0 = S0 ? S0.start : +(q.get('from') ?? 0), T1 = S0 ? S0.end : +(q.get('to') ?? TL.total);
window.DUR = +(T1 - T0).toFixed(4);

// 分段模块 + 音效清单
const MOD = {}, SFX = {};
const need = SEGS.filter(s => s.end > T0 - 1e-6 && s.start < T1 + 1e-6);
const needIdx = new Set(need.map(s => SEGS.indexOf(s)));
for (const i of [...needIdx]) if (i > 0) needIdx.add(i - 1);    // 上一段（交接用 exit）
for (const i of [...needIdx].sort((a, b) => a - b)) {
  const s = SEGS[i];
  MOD[s.seg] = await import(`/@film/src/segs/${s.seg}.js`);
  SFX[s.seg] = await J(`/@film/sfx/${s.seg}.json`, { events: [] });
}
window.EV = [];
for (const s of need) for (const e of SFX[s.seg].events || []) {
  const T = s.start + e.t; if (T >= T0 - 1e-6 && T < T1) window.EV.push({ ...e, t: +(T - T0).toFixed(4), seg: s.seg });
}
window.EV.sort((a, b) => a.t - b.t);

// 画布
const cv = document.getElementById('c'), G = createGL(cv);
const ov = new OffscreenCanvas(1920, 1080), octx = ov.getContext('2d');
const P = createPlates(G), ui = createUI(octx, allow), ink = createInk(P);
const paperTex = G.upload(await createImageBitmap(await (await fetch('/@film/assets/paper.jpg')).blob()), false);

// 预载：本次要渲染的分段所用图版 + 上一段 exit 的图版
const uses = new Set();
for (const s of need) for (const u of MOD[s.seg].uses || []) uses.add(u);
for (const i of needIdx) { const ex = exitOf(SEGS[i].seg); if (ex && ex.plate) uses.add(ex.plate); }
await Promise.all([...uses].map(id => P.load(id)));
for (const f of ['JLSerif500', 'JLSerif700', 'JLSerif900', 'JLSans']) await document.fonts.load(`40px ${f}`, '见龙');
await document.fonts.ready;

function exitOf(id) { const m = MOD[id]; if (!m || !m.exit) return null; return typeof m.exit === 'function' ? m.exit() : m.exit; }

// 旁白响度（全片时间 → 0..1），给录音波形
function voLevel(T) {
  for (const s of SEGS) { const v = s.vo; if (!v) continue;
    const k = Math.floor((T - v.start) * 30), a = VOENV[v.id]; if (a && k >= 0 && k < a.length) return a[k]; }
  return 0;
}

let lastTexts = [];
function renderAt(T) {
  const s = SEGS.find(x => T >= x.start && T < x.end) || SEGS[SEGS.length - 1];
  const kind = /^S1[2-7]$/.test(s.seg) ? 'flash' : 'present';
  const post = { blur: 0, glitch: 0, print: 1, paper: 1, vig: 0.12 };
  const hidden = new Set(); let subStyle = null; let clear = kind === 'flash' ? PAPER : INK;
  octx.setTransform(1, 0, 0, 1, 0, 0); octx.clearRect(0, 0, 1920, 1080); octx.globalAlpha = 1; octx.filter = 'none';
  ui.begin();
  const lt = T - s.start, i = SEGS.indexOf(s);
  const evs = SFX[s.seg].events || [];
  const api = {
    T, lt, dur: s.end - s.start, seg: s, kind, lib,
    P, ui, ink, C, ctx: octx, post,
    clear: c => { clear = c === 'paper' ? PAPER : c === 'ink' ? INK : c; G.beginScene(clear); },
    cue: id => { const e = evs.find(e => e.id === id); if (!e) throw new Error(`${s.seg}: sfx 清单里没有 id=${id} 的事件`); return e; },
    cues: type => evs.filter(e => !type || e.type === type),
    prevExit: () => i > 0 ? exitOf(SEGS[i - 1].seg) : null,
    rain: o => rain(octx, T, o),
    veil: (kind, k, o) => veil(octx, T, kind, k, o),
    voLevel: (t = T) => voLevel(t),
    hideSub: id => hidden.add(id),
    subStyle: st => { subStyle = st; },
    vo: s.vo, cam: normCam, camLerp,
    // 本段旁白逐字时间：[{w, t0, t1}]，t 为段内时间（秒）；标点也在内
    words: () => s.vo ? (WORDS[s.vo.id] || []).map(([w, a, b]) => ({ w, t0: s.vo.start - s.start + a, t1: s.vo.start - s.start + b })) : [],
  };
  G.beginScene(clear);
  MOD[s.seg].render(lt, api);
  subtitles(octx, T, CUES, hidden, subStyle);
  G.finish(paperTex, ov, post, T);
  lastTexts = ui.texts();
}
window.render = t => renderAt(T0 + t);
window.TEXTS = t => { renderAt(T0 + t); return lastTexts; };
window.SEGINFO = { T0, T1, segs: need.map(s => s.seg) };
window.READY = true;
