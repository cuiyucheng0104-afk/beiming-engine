// Cue check: every visual hit (found by scanning the rendered page frame by frame through window.PROBE)
// against its music cue (out/cues.json, written by mix.py) and the onset actually heard in out/music.wav.
// Run from the library root: node <project>/tools/cuecheck.mjs <project>
import fs from 'fs'; import path from 'path';
const LIB = process.env.LIB || process.cwd();
const { openDemo, closeServer } = await import(path.join(LIB, 'core/render/page.mjs'));
const dir = path.resolve(process.argv[2]), FPS = 24;
const { browser, page } = await openDemo(dir, {});
const frames = await page.evaluate(FPS => { const out = []; for (let f = 0; f <= Math.round(window.DUR * FPS); f++) out.push(window.PROBE(f / FPS)); return out; }, FPS);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'events.json'))).ev.find(e => e.type === 'meta');
await browser.close(); closeServer();
const B = meta.beat, T = Object.fromEntries(Object.entries(meta.beats).map(([k, v]) => [k, v * B]));
const first = (pred, from = 0) => { for (let f = from; f < frames.length; f++) if (pred(frames[f], f)) return f / FPS; return NaN; };
const argmax = (fn, a, z) => { let bf = -1, bv = -Infinity; for (let f = Math.ceil(a * FPS); f <= Math.floor(z * FPS); f++) { const v = fn(frames[f]); if (v > bv) { bv = v; bf = f; } } return bf / FPS; };
const V = {
  key: first(p => p.rev.key >= 1), sky: first(p => p.rev.sky >= 1), water: first(p => p.rev.water >= 1), wood: first(p => p.rev.wood >= 1), red: first(p => p.rev.red >= 1),
  gust: first(p => p.gust >= .5), tug: first(p => p.inv < 0), tear: first(p => p.held !== 'woman'), breakout: first(p => p.breakY <= .01),
  v1: first(p => p.seal[0] >= .55), bounce: argmax(p => p.bounceY, T.v1, T.s2a), v2: first(p => p.seal[1] >= .55), splash: argmax(p => p.held === 'free' ? -p.umb[1] : -1e9, T.v2 + .1, T.s3a),
  v3: first(p => Math.hypot(p.cam[0] - (6600 + 960), p.cam[1] - 540) < .5), v3seal: first(p => p.seal[2] >= .55),
  ma: first(p => p.frozen), maEnd: first((p, f) => f > T.ma * FPS && !p.frozen), reach: first(p => p.handL[1] <= -120 + 1e-3),
  catch: first(p => p.held === 'child' && p.catchDist < .5), clear: first(p => p.clear >= 1), seal: first(p => p.seal[3] >= .55),
};
// camera landings on views 1 and 2 must coincide with their seals
const camLand = { v1: first(p => Math.hypot(p.cam[0] - (2200 + 960), p.cam[1] - 540) < .5), v2: first(p => Math.hypot(p.cam[0] - (4400 + 960), p.cam[1] - 540) < .5) };
const MUS = { maEnd: 'shaku' };
const cues = JSON.parse(fs.readFileSync(path.join(dir, 'out/cues.json')));
// onset detection on the cue's own instrument stem: strongest rise of a 3 ms envelope within ±60 ms of the cue
const stems = {};
function stem(name) {
  if (stems[name]) return stems[name];
  const wav = fs.readFileSync(path.join(dir, `out/stem_${name}.wav`)); let off = 12;
  while (wav.toString('ascii', off, off + 4) !== 'data') off += 8 + wav.readUInt32LE(off + 4);
  return stems[name] = { wav, d: off + 8, n: (wav.length - off - 8) / 8 };
}
function onset(t, name) {
  const { wav, d, n } = stem(name), sample = i => Math.abs(wav.readFloatLE(d + i * 8)) + Math.abs(wav.readFloatLE(d + i * 8 + 4));
  const SR = 48000, w = 144, a = Math.max(0, Math.round((t - .06) * SR)), z = Math.min(n - 1, Math.round((t + .06) * SR));
  const env = []; for (let i = a - w; i <= z; i += 24) { let s = 0; for (let k = 0; k < w; k++) s += sample(Math.max(0, i + k)); env.push([i, s / w]); }
  let best = -1, bt = t; for (let j = 1; j < env.length; j++) { const dd = env[j][1] - env[j - 1][1]; if (dd > best) { best = dd; bt = (env[j][0] + w) / SR; } }
  return bt;
}
let worst = 0, rows = [];
for (const [k, vt] of Object.entries(V)) {
  const beatT = T[k] ?? NaN, name = MUS[k] || k, c = cues.find(c => c.name === name), mt = c ? c.t : NaN;
  const dv = (vt - beatT) * 1000, dm = (mt - vt) * 1000, on = c && k !== 'ma' ? (onset(mt, c.stem) - vt) * 1000 : NaN;
  worst = Math.max(worst, Math.abs(dv), Math.abs(dm));
  rows.push(`${k.padEnd(9)} beat ${String(+(T[k] / B).toFixed(3)).padStart(6)}  grid ${beatT.toFixed(3)}s  picture ${vt.toFixed(3)}s (${dv >= 0 ? '+' : ''}${dv.toFixed(0)} ms)  music '${name}' ${isNaN(mt) ? '—' : mt.toFixed(3) + 's'} (${isNaN(dm) ? '—' : (dm >= 0 ? '+' : '') + dm.toFixed(0) + ' ms'})  heard onset ${isNaN(on) ? '—' : (on >= 0 ? '+' : '') + on.toFixed(0) + ' ms'}`);
}
for (const k of ['v1', 'v2']) { const d = (camLand[k] - T[k]) * 1000; worst = Math.max(worst, Math.abs(d)); rows.push(`${('cam-' + k).padEnd(9)} camera lands ${camLand[k].toFixed(3)}s (${d >= 0 ? '+' : ''}${d.toFixed(0)} ms vs grid)`); }
console.log(rows.join('\n'));
console.log(`\nworst picture/music offset: ${worst.toFixed(1)} ms`);
process.exit(worst > 0.5 ? 1 : 0);
