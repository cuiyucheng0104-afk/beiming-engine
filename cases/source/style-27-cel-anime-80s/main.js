// 追电车的夏天 —— 80 年代赛璐璐动画风格样片
import { canvas, W, H } from './cel.js';
import { makePost } from '/core/post/crt.js';
import { skyPlate, seaPlate, landPlate } from './bg.js';
import { SHOT_FN, TITLE } from './shots.js';
import { DUR, END_F, shotAt, CUES, SHOTS, bf, df, FC, F20, FPS, FPB } from './timeline.js';

const qs = new URLSearchParams(location.search);
const [sc, g] = canvas(W, H), [gc, e] = canvas(W, H);
const post = makePost(document.getElementById('gl'));
await document.fonts.load('900 60px NSC', '追电车的夏天'); await document.fonts.load('700 30px NSC', '海岸线');
await document.fonts.load('italic 900 40px Kanit', 'CHASING THE SUMMER TRAM 305');
const TEST = qs.get('test'), tm = TEST ? await import('./test.js') : null;

// —— 背景板（加载时画一次）——
const A = { END_F };
A.sky_gold = skyPlate('gold', 3800, 1000, 3, { horizon: 910, sun: [1450, 690] });
A.sea_gold = seaPlate('gold', 3600, 700, 60, 5, 1400);
A.land_gold = landPlate('gold', 4400, 1200, 7);
A.sky_sunset = skyPlate('sunset', 3800, 1000, 3, { horizon: 910, sun: [1830, 870] });
A.sea_sunset = seaPlate('sunset', 3600, 700, 60, 5, 2050);
A.land_sunset = landPlate('sunset', 4400, 1200, 7);
A.sky_tall = skyPlate('gold', 2800, 2700, 9, { horizon: 2600, sun: [640, 520], clouds: [[.55, .985, .42, .2], [.86, .975, .26, .14], [.2, .74, .22, .07], [.78, .6, .3, .1], [.62, .4, .2, .05], [.12, .5, .14, .04], [.9, .3, .16, .05]] });
A.sky_back = skyPlate('gold', 2400, 1400, 11, { horizon: 1320, sun: [760, 420], clouds: [[.7, .9, .4, .45], [.15, .95, .25, .25]] });

const RAW = { bloom: 0, halo: 0, soft: 0, flick: 0, lift: 0, contrast: 0, fade: 0, sat: 1, tint: [1, 1, 1], scan: 0, grille: 0, bleed: 1, rshift: 0, glow: 0, corner: 0, noiseA: 0, power: 1, track: 0, expo: 1 };
function render(t) {
  for (const x of [g, e]) { x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; x.filter = 'none'; }
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H); e.fillStyle = '#000'; e.fillRect(0, 0, W, H);
  const f = Math.round(t * FPS);
  let over = {};
  if (tm) tm.test(g, e, t, TEST);
  else { const [name] = shotAt(t); over = SHOT_FN[qs.get('shot') || name]({ t, f, g, e, A }) || {}; }
  post.render(sc, gc, f, null, qs.get('raw') || tm ? RAW : { bloom: .9, halo: .24, ...over });
}

// —— 声音事件（mix.py 读 events.json）——
function events() {
  const ev = [], s = fr => +(fr / FPS).toFixed(4), add = (type, fr, o = {}) => ev.push({ type, t: s(fr), f: fr, ...o });
  add('bed_s1', 0, { d: s(bf(8)) });
  add('freewheel', 0, { d: s(bf(8)) });
  add('bell', CUES.bellOff.f, { v: .55, pan: -.8, far: 1 });
  add('tram', CUES.tramIn.f - 6, { d: s(bf(8) - bf(7) + 6), v: .35, pan: -.6 });
  add('cut', CUES.cutSide.f, { v: .5 });
  add('tram', CUES.cutSide.f, { d: s(bf(12) - bf(8)), v: .9, pan: -.2, sweep: 1 });
  add('railclack', CUES.cutSide.f, { d: s(bf(12) - bf(8)) });
  add('pedal', CUES.cutSide.f, { d: s(bf(16) - bf(8)), rate0: 1.6, rate1: 2.4, at: s(bf(11) - bf(8)) });
  add('wind', CUES.cutSide.f, { d: s(F20 - bf(8)), v0: .35, v1: 1.0 });
  add('cloth', CUES.lookBack.f, { v: .7 });
  add('creak', CUES.standUp.f, { v: .8 });
  add('whoosh', CUES.cutBust.f - 4, { v: .7, d: .35 });
  add('whoosh', CUES.cutEyes.f - 3, { v: .55, d: .25 });
  add('glint', CUES.narrow.f, { v: .7 });
  add('impact', CUES.hatOff.f, { v: .9 });
  add('gust', CUES.hatOff.f, { v: 1.0, d: s(F20 - bf(16)) });
  add('flutter', CUES.hatOff.f + 2, { d: s(F20 - bf(16) - 2) });
  add('choke', CUES.freeze.f, {});
  add('catch', CUES.catch.f, { v: 1.0 });
  add('impact', CUES.catch.f, { v: 1.0, big: 1 });
  add('bed_s7', CUES.catch.f, { d: s(df(6) - FC) });
  for (const k of ['band1', 'band2', 'band3']) add('band', CUES[k].f, { v: .65 });
  add('hatgrab', CUES.smile.f - Math.round(.5 * FPB), { v: .5 });
  add('tapethunk', CUES.cutSunset.f, { v: .8 });
  add('bed_s8', CUES.cutSunset.f, { d: s(END_F - df(6)) });
  add('tram', CUES.cutSunset.f, { d: s(END_F - df(6)), v: .28, pan: .5, far: 1 });
  add('titlehit', CUES.title.f, { v: .9 });
  add('brake', CUES.stop.f - 7, { v: .5, d: s(7) });          // 轻捏刹车（尖细的刹车皮声，落在停车那一拍上收住）
  add('scuff', CUES.stop.f, { v: .7 });                         // 鞋底点地
  add('bell', CUES.bellFar1.f, { v: .4, pan: .6, far: 1 });
  add('bell', CUES.bellFar2.f, { v: .32, pan: .6, far: 1 });
  add('glint', CUES.glint.f, { v: .5 });
  return ev.sort((a, b) => a.t - b.t);
}
window.EV = events();
window.CUES = CUES;
// 画面里的文字（readcheck）：标题、拉丁副标题（电车行先牌是移动中的场景陈设，不计）
window.TEXTS = t => {
  const f = Math.round(t * FPS); if (f < df(7)) return [];
  return [{ id: 'title', text: TITLE.text, x0: TITLE.x - 520, y0: TITLE.y - 90, x1: TITLE.x + 520, y1: TITLE.y + 90 },
    { id: 'sub', text: TITLE.sub, x0: TITLE.x - 420, y0: TITLE.y + 100, x1: TITLE.x + 420, y1: TITLE.y + 156 }];
};
window.render = render; window.DUR = DUR;
render(parseFloat(qs.get('t') ?? '1'));
window.READY = true;
