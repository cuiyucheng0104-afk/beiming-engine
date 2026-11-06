// Cue check: steps through every frame of the page, finds the frame where each visual event actually happens
// (window.PROBE reports what the frame shows), and compares it with the music/foley onset placed in out/cues.json
// and with the transient measured in the final mix. Run from the library root:
//   node <film>/tools/cuecheck.mjs <film>
import fs from 'fs'; import path from 'path';
const film = path.resolve(process.argv[2] || '.');
const LIB = process.env.LIB || '@@LEMO_ROOT@@';
const { openDemo, closeServer } = await import(path.join(LIB, 'core/render/page.mjs'));
const TL = JSON.parse(fs.readFileSync(path.join(film, 'timeline.json'), 'utf8'));
const cues = JSON.parse(fs.readFileSync(path.join(film, 'out/cues.json'), 'utf8'));
const FPS = TL.FPS, NF = Math.round(TL.DUR * FPS);
const { browser, page } = await openDemo(film);
const P = [];
for (let f = 0; f < NF; f++) P.push(await page.evaluate(t => window.PROBE(t), f / FPS));
await browser.close(); closeServer();

// visual events: the first frame where the state changes
const vis = [];
const first = (name, test) => { for (let f = 1; f < NF; f++) if (test(P[f], P[f - 1])) { vis.push({ name, f }); return; } vis.push({ name, f: null }); };
const every = (name, test) => { for (let f = 1; f < NF; f++) if (test(P[f], P[f - 1])) vis.push({ name, f }); };
first('plateIn', (a, b) => a.cyanIn && !b.cyanIn);
first('title', (a, b) => a.title && !b.title);
every('cut', (a, b) => a.shot !== b.shot);
every('step', (a, b) => a.shot === 'run' && (a.step ?? 0) !== (b.step ?? 0) || (a.shot === 'run' && b.shot !== 'run'));
first('violet', (a, b) => a.violet && !b.violet);
first('entry', (a, b) => a.splash && !b.splash);
every('drop', (a, b) => (a.drops ?? 0) > (b.drops ?? 0));
every('ring', (a, b) => (a.rings ?? 0) > (b.rings ?? 0));
first('headUp', (a, b) => a.head && !b.head);
first('plateOut', (a, b) => a.cyanOut && !b.cyanOut);
first('final', (a, b) => a.arm && !b.arm);

// which audio cue each visual event must land on
const want = { plateIn: ['plateIn', 'kick'], title: ['title', 'rim'], cut: ['cut', 'step', 'takeoff', 'crash', 'freeze', 'splash', 'ring'], step: ['step'],
  violet: ['violet', 'violetFoley'], entry: ['entry', 'splash'], drop: ['drop', 'kalimba'], ring: ['ring'], headUp: ['headUp'], plateOut: ['plateOut'], final: ['finalFoley', 'chord', 'kick'] };
// measured transients in the final mix (high-passed energy, 1 ms hop)
let onsets = null;
const wav = path.join(film, 'out/onsets.json');
if (fs.existsSync(wav)) onsets = JSON.parse(fs.readFileSync(wav, 'utf8'));
let worst = 0, worstA = 0, bad = 0; const aDev = [];
const rows = [];
for (const v of vis) {
  if (v.f === null) { rows.push(`${v.name.padEnd(9)} NOT SEEN`); bad++; continue; }
  const tv = v.f / FPS, tags = want[v.name] || [v.name];
  const c = cues.filter(c => tags.includes(c.tag)).sort((a, b) => Math.abs(a.t - tv) - Math.abs(b.t - tv))[0];
  const dms = c ? (tv - c.t) * 1000 : NaN;
  let am = '';
  if (onsets) { const o = onsets.filter(x => Math.abs(x - tv) < .06).sort((a, b) => Math.abs(a - tv) - Math.abs(b - tv))[0];
    if (o !== undefined) { const d = (o - tv) * 1000; worstA = Math.max(worstA, Math.abs(d)); aDev.push(Math.abs(d)); am = `  mix transient ${d >= 0 ? '+' : ''}${d.toFixed(1)} ms`; } else am = '  mix transient: none within 60 ms'; }
  if (!(Math.abs(dms) < 1)) bad++;
  worst = Math.max(worst, isNaN(dms) ? 999 : Math.abs(dms));
  rows.push(`${v.name.padEnd(9)} frame ${String(v.f).padStart(3)}  t=${tv.toFixed(4)}  cue ${c ? c.tag : '—'} @ ${c ? c.t.toFixed(4) : '—'}  Δ ${isNaN(dms) ? '—' : dms.toFixed(2) + ' ms'}${am}`);
}
console.log(rows.join('\n'));
console.log(`\n${vis.length} visual events, worst visual↔cue offset ${worst.toFixed(2)} ms` + (onsets ? `, mix transients: median ${(aDev.sort((a, b) => a - b)[aDev.length >> 1] || 0).toFixed(1)} ms over ${aDev.length} matched (nearest transient within 60 ms; a soft or masked sound can match a neighbour)` : '') + `, ${bad} off-grid`);
fs.writeFileSync(path.join(film, 'out/cuecheck.txt'), rows.join('\n') + '\n');
process.exit(bad ? 1 : 0);
