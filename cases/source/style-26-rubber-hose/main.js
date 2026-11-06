// main.js — page entry: render(t) = scene → film post. ?mode=frames draws the model sheet.
import * as T from './toon.js';
import { makeFilm, post } from './film.js';
import { DUR, SHOTS, H } from './timeline.js';
const cv = document.getElementById('c');
T.init(cv);
await document.fonts.ready;
for (const f of ['104px "ZCOOL QingKe HuangYou"', '104px "ZCOOL KuaiLe"', '52px Limelight']) await document.fonts.load(f, '起床啦！剧终THE END');
const S = await import('./scenes.js');
const F = makeFilm(cv); S.initScenes(F.sg);
const cuts = SHOTS.map(s => Math.round(s[0] * 24)).filter(f => f > 0);
window.DUR = DUR;
window.render = t => {
  t = Math.min(Math.max(0, t), DUR - 1e-4);
  S.renderScene(t);
  const f = Math.round(t * 24), jump = cuts.includes(f) ? 3 : 0;
  post(F, t, { jump });
};
window.TEXTS = t => [...S.wordsBox(t), ...S.endBoxes(t)];
const { buildEvents } = await import('./events.js');
window.EV = buildEvents();
window.READY = true;
