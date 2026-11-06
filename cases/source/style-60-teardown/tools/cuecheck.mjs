// 拍点核对：从运动函数（src/motion.js，与画面同一份代码）逐毫秒找出每个视觉事件真正发生的时刻，
// 与 mix.py 写出的声音起点（out/score.json）和 120 BPM 的十六分音符网格比较。目标 0 ms。
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TL = await import(path.join(HERE, 'src/timeline.js'));
const MO = await import(path.join(HERE, 'src/motion.js'));
const { DIMS } = await import(path.join(HERE, 'src/dims.js'));
const { T, UP, LAND, BEAT } = TL;
const score = JSON.parse(fs.readFileSync(path.join(HERE, 'out/score.json')));
const cues = score.cues;
const first = (a, b, f) => { for (let i = Math.round(a * 1000); i <= Math.round(b * 1000); i++) { const t = i / 1000; if (f(t)) return t; } return NaN; };
const STEP = Math.PI * 2 / DIMS.cam.teeth;
const vis = [];
// 按钮到底（咔）、锁定（哒）
for (const [ka, da, p] of [[T.ka1, T.da1, T.press1], [T.ka2, T.da2, T.press2]]) {
  vis.push(['ka', first(p, p + 1, t => MO.mech(t)[0] <= -DIMS.plunger.stroke + 1e-9)]);
  vis.push(['da', first(ka, ka + 1, t => MO.mech(t)[1] >= 1)]);
}
for (const k of TL.PARTS) vis.push(['lift-' + k, first(UP[k] - .5, UP[k] + .5, t => MO.partState(k, t + .001).ex > 0)]);   // 运动起点 = 最后一个静止时刻
for (const k of TL.PARTS) vis.push(['land-' + k, first(LAND[k] - .5, LAND[k] + .5, t => t > LAND[k] - TL.DOWNDUR && MO.partState(k, t).ex === 0)]);
const base = MO.camAngle(13.5);
T.teeth.forEach((tt, n) => vis.push(['tooth' + n, first(13.5, 16.5, t => MO.camAngle(t) >= base + (n + 1) * STEP - 1e-9)]));
T.labels.forEach((t, n) => vis.push(['label' + n, t]));   // overlay 在 T.labels 开始画引线（同一个数）
T.dims.forEach((t, n) => vis.push(['dim' + n, t]));
vis.push(['stab', T.stab], ['pull', T.pull]);
let worst = 0, rows = [];
const used = new Set();
for (const [name, tv] of vis) {
  const cand = cues.map((c, i) => [c, i]).filter(([c, i]) => c[1] === name && !used.has(i)).sort((a, b) => Math.abs(a[0][0] - tv) - Math.abs(b[0][0] - tv))[0];
  if (!cand) { rows.push(`${name.padEnd(14)} 视觉 ${tv.toFixed(3)}  无声音 cue ✗`); worst = Infinity; continue; }
  used.add(cand[1]);
  const ts = cand[0][0], d = Math.round((ts - tv) * 1000), grid = Math.round(Math.abs(tv / (BEAT / 4) - Math.round(tv / (BEAT / 4))) * BEAT / 4 * 1000), fr = Math.abs(tv * 24 - Math.round(tv * 24)) < 1e-6;
  worst = Math.max(worst, Math.abs(d), grid);
  rows.push(`${name.padEnd(14)} 视觉 ${tv.toFixed(3)}  声音 ${ts.toFixed(3)}  偏差 ${String(d).padStart(3)} ms  离十六分网格 ${grid} ms  整帧 ${fr ? '是' : '否'}  拍号 b${(tv / BEAT).toFixed(2)}`);
}
console.log(rows.join('\n'));
console.log(`共 ${vis.length} 个视觉事件，最大偏差 ${worst} ms`);
process.exit(worst === 0 ? 0 : 1);
