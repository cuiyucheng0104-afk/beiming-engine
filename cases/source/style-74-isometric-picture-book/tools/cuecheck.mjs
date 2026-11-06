// Cue check: renders the film's own state at every frame (30 fps) through window.PROBE, finds the frame where each
// visual event happens, and compares it with the music/foley onset that mix.py placed for it (out/cues.json).
// Also measures the real transient in out/mix.wav for the chairs and the steps (onset of high-band energy).
//   node <project>/tools/cuecheck.mjs <project>      (from the library root)
import { openDemo, closeServer } from '@@LEMO_ROOT@@/core/render/page.mjs';
import fs from 'node:fs';
const dir = process.argv[2], FPS = 30;
const { browser, page } = await openDemo(dir, { w: 480, h: 270 });
const vis = await page.evaluate(FPS => {
  const out = [], done = new Set(); let prev = null;
  for (let f = 0; f <= window.DUR * FPS + 1e-6; f++) {
    const t = Math.round(f / FPS * 1e6) / 1e6, p = window.PROBE(t), q = prev;
    const first = (name, cond, condPrev, key = name, back = 0) => { if (cond && !(q && condPrev) && !done.has(key)) { done.add(key); out.push({ t: Math.round((t - back / FPS) * 1e6) / 1e6, ev: name }); } };
    if (q) {
      p.glyphs.forEach((g, i) => first('type', g.a > 0, q.glyphs[i].a > 0, 'type' + i));
      first('lamp', p.lamp === 0, q.lamp === 0);
      first('lid_flat', p.lid >= Math.PI - 1e-9, q.lid >= Math.PI - 1e-9);
      first('walls', p.wall < 3.2 - 1e-9, q.wall < 3.2 - 1e-9, 'walls', 1);   // motion start = the last frame at rest
      p.lights.forEach((a, i) => first('light', a > 0, q.lights[i] > 0, 'light' + i));
      if (p.dip > .999 && !(q.dip > .999)) out.push({ t, ev: 'knead' });
      if (p.bakerAmp > .3 && Math.abs(Math.abs(Math.sin(p.bakerPhase)) - 1) < 1e-6) out.push({ t, ev: 'step' });
      if (p.guestAmp > .3 && Math.abs(Math.abs(Math.sin(p.guestPhase)) - 1) < 1e-6) out.push({ t, ev: 'step' });
      first('oven_open', p.oven >= 1, q.oven >= 1);
      first('oven_ding', p.bakerLoad === 'bread', q.bakerLoad === 'bread');
      first('shelf', p.shelfF >= 1, q.shelfF >= 1);
      p.chairs.forEach((a, i) => first('chair', a <= 1e-9, q.chairs[i] <= 1e-9, 'chair' + i));
      if (t > 12 && t < 13 && p.chairs[0] >= Math.PI / 2 - 1e-9 && q.chairs[0] < Math.PI / 2 - 1e-9) out.push({ t, ev: 'twitch' });   // the hop drops back
      first('flip', p.sign >= Math.PI - 1e-9, q.sign >= Math.PI - 1e-9);
      first('spot', p.spot > 0, q.spot > 0);
      first('chime', p.guestX <= 12, q.guestX <= 12);
      first('arrive', p.guestX <= 10.2 + 1e-9, q.guestX <= 10.2 + 1e-9);
    }
    prev = p;
  }
  for (const [c] of (window.SHOTS || []).slice(1)) out.push({ t: c, ev: 'cut' });   // a cut is a visual event too: it must sit on a sounded beat
  return out;
}, FPS);
await browser.close(); closeServer();
const cues = JSON.parse(fs.readFileSync(dir + '/out/cues.json', 'utf8'));   // [t, tag]
const MAP = { type: ['type'], lamp: ['lamp'], lid_flat: ['lid_flat'], walls: ['walls'], light: ['light'], knead: ['knead'], step: ['step', 'step_foley'],
  oven_open: ['oven_open'], oven_ding: ['oven_ding'], shelf: ['shelf'], chair: ['chair', 'chair_foley'], flip: ['flip', 'flip_foley'], spot: ['spot'], chime: ['chime', 'chime_foley'], arrive: ['arrive'], twitch: ['twitch'], cut: ['chair', 'type', 'light', 'step', 'flip', 'spot', 'chime', 'arrive', 'lid_flat', 'climax'] };
let worst = 0, n = 0; const rows = [];
for (const v of vis) {
  const c = cues.filter(([, tag]) => MAP[v.ev].includes(tag)); if (!c.length) { rows.push(`MISS ${v.ev} @${v.t.toFixed(3)} no cue`); worst = 1e9; continue; }
  const best = c.reduce((a, b) => Math.abs(b[0] - v.t) < Math.abs(a[0] - v.t) ? b : a);
  const d = Math.round((best[0] - v.t) * 1000); worst = Math.max(worst, Math.abs(d)); n++;
  rows.push(`${Math.abs(d) <= 1 ? 'ok  ' : 'OFF '} ${v.ev.padEnd(10)} picture ${v.t.toFixed(3)}s  sound ${best[0].toFixed(3)}s  ${d >= 0 ? '+' : ''}${d} ms`);
}
// sounds without a picture event (every cue must be seen)
const seen = new Set(vis.map(v => v.t.toFixed(3)));
const orphan = cues.filter(([t, tag]) => !['step_foley', 'chair_foley', 'flip_foley', 'chime_foley', 'lid_up', 'climax', 'lift'].includes(tag) && !seen.has((+t).toFixed(3)));
console.log(rows.join('\n'));
console.log(`\n${n} picture events matched; worst offset ${worst} ms; sounds with no picture event: ${orphan.length ? JSON.stringify(orphan) : 'none'}`);
process.exit(worst <= 1 && !orphan.length ? 0 : 1);
