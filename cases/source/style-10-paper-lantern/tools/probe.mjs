// 画面探针：在连续时间上二分查找每个视觉事件的真实起点（不受帧率量化影响），写 out/visual_cues.json
// 用法（在 $LIB 下）：node <film>/tools/probe.mjs <film>
import fs from 'fs'; import path from 'path';
const LIB = process.env.LIB || '@@LEMO_ROOT@@';
const { openDemo, closeServer } = await import(path.join(LIB, 'core/render/page.mjs'));
const dir = path.resolve(process.argv[2]);
const { browser, page } = await openDemo(dir, { w: 1920, h: 1080, q: 'ssaa=1' });
const ev = JSON.parse(fs.readFileSync(path.join(dir, 'events.json'))).ev;
const T = ty => ev.filter(e => e.type === ty).map(e => e.t);
const probe = t => page.evaluate(t => window.PROBE(t), t);
async function onset(pred, a, b) {   // 区间内第一次 pred 为真的时刻（a 处为假、b 处为真）
  if (pred(await probe(a)) || !pred(await probe(b))) return null;
  for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (pred(await probe(m))) b = m; else a = m; }
  return b;
}
const W = (t, f, name) => ({ name, expect: t, f });
const jobs = [
  W(T('click')[0], p => p.moon > 1e-12, 'lamp_click'),
  ...T('layer').map((t, i) => W(t, p => p.layers[i] > 1e-12, 'layer' + i)),
  W(T('whistle_far')[0], p => p.leg === 1 && p.xf >= -.09, 'train_emerge_far'),
  W(T('hop')[0], p => p.leg === 2, 'hop_layer2'),
  W(T('hop')[1], p => p.leg === 3, 'hop_layer3'),
  W(T('tunnel_in')[0], p => p.tunnel === 1, 'enter_tunnel'),
  ...T('win').map((t, i) => W(t, p => p.wins[i] > 1e-12, 'window' + i)),
  W(T('tunnel_out')[0], p => p.leg === 3 && p.xf >= .06, 'exit_tunnel'),
  W(T('stop')[0], p => p.leg === 3 && p.spd < 1e-9, 'train_stop'),
  W(T('house')[0], p => p.house > 1e-12, 'house_window'),
  W(T('door')[0], p => p.door < 1 - 1e-13, 'door_open'),
  W(T('arms')[0], p => p.arm > 1e-12, 'arms_open'),
  W(T('strip')[0], p => p.strip > 1e-13, 'title_grow'),
  W(T('seal')[0], p => p.seal === 1, 'seal'),
];
const out = [];
for (const j of jobs) {
  const a = j.name === 'train_stop' ? j.expect - .5 : j.expect - .3, b = j.expect + .3;
  const got = await onset(j.f, a, b);
  out.push({ name: j.name, expect: j.expect, got, dev_ms: got == null ? null : +((got - j.expect) * 1000).toFixed(2) });
}
fs.writeFileSync(path.join(dir, 'out/visual_cues.json'), JSON.stringify(out, null, 1));
console.log('visual cues', out.length);
await browser.close(); closeServer();
