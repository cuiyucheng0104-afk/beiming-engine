// timeline → out/timeline.json for the score, the mixer and the cue check
import fs from 'fs';
const m = await import('../timeline.js');
const S = [];
for (let i = 0; i <= Math.round(m.DUR * 100); i++) {
  const t = i / 100, cam = m.camera(t), p = m.bikePose(t), [sx] = m.toScreen(cam, p.x, p.y);
  S.push([+t.toFixed(2), +((sx - 960) / 960).toFixed(3), +m.bikeV(t).toFixed(1), +p.s.toFixed(3)]);
}
const out = { BPM: m.BPM, BEAT: m.BEAT, BAR: m.BAR, T: m.T, HIT: m.HIT, DUR: m.DUR, GRID: m.knifeGrid(), SCRAPES: m.SCRAPES, EV: m.events(), BIKE: S };
fs.mkdirSync(new URL('../out/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../out/timeline.json', import.meta.url), JSON.stringify(out));
console.log('timeline.json', Object.keys(out.T).length, 'hits,', out.GRID.length, 'knife beats');
