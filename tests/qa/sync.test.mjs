// qa sync：起音检测的精度（合成信号，纯函数）与命令行判定（声音对齐 / 晚 3 帧 / 早半帧）。
// 容差按 routes/directing/craft/animation.md §5.7：声音晚 0–1 帧可以、早不超过 0.25 帧；口型类可晚 2 帧。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { haveFfmpeg, tmp, cleanup, clip, qa, check, writeJson, TEST_PROFILES } from './helpers.mjs';
import { findOnset } from '../../tools/qa/lib/audio.mjs';

const SR = 48000;
// 合成：底噪 + 可选 100 Hz 垫底 + 在 at 秒起的一声（freq 正弦、attack 起音、len 长度、amp 幅度）
function synth({ dur = 3, noise = 0.001, pad = 0, hits = [] }) {
  const x = new Float32Array(Math.round(dur * SR));
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32 - 0.5; };
  for (let i = 0; i < x.length; i++) x[i] = noise * rnd() + pad * Math.sin(2 * Math.PI * 100 * i / SR);
  for (const h of hits) {
    const s0 = Math.round(h.at * SR), n = Math.round((h.len ?? 0.08) * SR), a = Math.max(1, Math.round((h.attack ?? 0.001) * SR));
    for (let i = 0; i < n && s0 + i < x.length; i++) {
      const env = Math.min(1, i / a) * Math.exp(-i / (n / 3));
      x[s0 + i] += (h.amp ?? 0.3) * env * Math.sin(2 * Math.PI * (h.freq ?? 2000) * i / SR);
    }
  }
  return x;
}

test('起音精度：清脆的点击、软起的短音，误差都在 ±1.5 ms 内', () => {
  for (const [at, freq, attack] of [[1.0, 3000, 0.0005], [1.2345, 800, 0.003], [2.5, 220, 0.002]]) {
    const x = synth({ hits: [{ at, freq, attack }] });
    const on = findOnset(x, SR, at + 0.01, {});
    assert.ok(on, `${at}s 的 ${freq} Hz 没检出`);
    assert.ok(Math.abs(on.t - at) <= 0.0015, `${freq} Hz：检出 ${on.t}，应为 ${at}（差 ${((on.t - at) * 1000).toFixed(2)} ms）`);
  }
});

test('低频很满的混音里，弱的高频提示音靠分频带也能检出', () => {
  const at = 1.5;
  const x = synth({ pad: 0.4, hits: [{ at, freq: 1760, amp: 0.03, attack: 0.002, len: 0.15 }] });
  const on = findOnset(x, SR, at, {});
  assert.ok(on, '没检出');
  assert.notEqual(on.band, '全频带', '全频带里被 100 Hz 垫底盖住，应当是在分频带里检出的');
  assert.ok(Math.abs(on.t - at) <= 0.0025, `差 ${((on.t - at) * 1000).toFixed(2)} ms`);
});

test('相邻两声：按中点分窗后各取各的；不分窗时强的一下也不会抢走近处够响的那一下', () => {
  const x = synth({ hits: [{ at: 1.0, amp: 0.5, len: 0.03 }, { at: 1.08, amp: 0.25, len: 0.03, freq: 1500 }] });
  const narrow = findOnset(x, SR, 1.08, { early: 0.04, late: 0.2 });
  assert.ok(narrow && Math.abs(narrow.t - 1.08) <= 0.0015, JSON.stringify(narrow));
  const wide = findOnset(x, SR, 1.08, { early: 0.15, late: 0.2 });
  assert.ok(wide && Math.abs(wide.t - 1.08) <= 0.0015, JSON.stringify(wide));
  const first = findOnset(x, SR, 1.0, { early: 0.15, late: 0.04 });
  assert.ok(first && Math.abs(first.t - 1.0) <= 0.0015, JSON.stringify(first));
});

test('只有底噪：不报假起音', () => {
  const x = synth({ noise: 0.0001 });
  assert.equal(findOnset(x, SR, 1.5, {}), null);
});

// ── 命令行：成片里在 1.0 / 2.0 / 3.125 秒各有一声，事件帧写在 24 / 48 / 72 帧 ──
const skip = haveFfmpeg ? false : '没有 FFmpeg ≥ 7（D09），跳过';
let dir, file;
after(cleanup);
before(() => {
  if (skip) return;
  dir = tmp();
  const expr = "0.4*sin(2*PI*2000*t)*(between(t,1,1.03)+between(t,2,2.03)+between(t,3.125,3.155))+0.002*sin(2*PI*90*t)";
  file = clip(path.join(dir, 'clicks.mp4'), { size: '640x360', audio: `aevalsrc='${expr}':s=48000:d=4` });
});
const film = (events, extra = {}) => ({
  schemaVersion: 2, id: 'qa-sync', title: '同步夹具', route: 'c',
  output: { profile: 't-360p24', width: 640, height: 360, fps: 24, frameCount: 96 },
  shots: [{ id: 'S1', in: 0, out: 96 }], events, aigc: { contains: false }, ...extra,
});
const run = events => qa(['sync', file, '--film', writeJson(path.join(dir, `film-${Math.random().toString(36).slice(2)}.json`), film(events)), '--profile', 't-360p24', '--profiles-file', TEST_PROFILES]);

test('事件与声音对齐：sync.events 通过，偏差在 0–2 ms', { skip }, () => {
  const r = run([{ id: 'a', frame: 24, audio: 'click' }, { id: 'b', frame: 48, audio: 'click' }]);
  assert.equal(r.code, 0, r.stderr);
  const rows = check(r.env, 'sync.events').evidence.events;
  for (const e of rows) assert.ok(e.deltaMs >= -1 && e.deltaMs <= 3, JSON.stringify(e));
});

test('声音晚 3 帧（125 ms）：sync.events 不通过并指出事件', { skip }, () => {
  const r = run([{ id: 'a', frame: 24, audio: 'click' }, { id: 'late', frame: 72, audio: 'click' }]);
  assert.equal(r.code, 4);
  const c = check(r.env, 'sync.events');
  assert.equal(c.status, 'fail');
  assert.deepEqual(c.findings.filter(f => f.status === 'fail').map(f => f.target), ['late']);
});

test('口型类（sync: "lip"）也只放宽到 2 帧：晚 3 帧照样不通过；写 sync: "soft" 只记注意', { skip }, () => {
  const lip = run([{ id: 'lip', frame: 72, audio: 'vo', sync: 'lip' }]);
  assert.equal(check(lip.env, 'sync.events').status, 'fail');
  const soft = run([{ id: 'soft', frame: 72, audio: 'vo', sync: 'soft' }]);
  assert.equal(check(soft.env, 'sync.events').status, 'warn');
  assert.equal(soft.code, 0);
});

test('声音早于结果帧：事件写在第 25 帧（声音早 41.7 ms），不通过', { skip }, () => {
  const r = run([{ id: 'early', frame: 25, audio: 'click' }]);
  assert.equal(check(r.env, 'sync.events').status, 'fail');
  assert.match(check(r.env, 'sync.events').findings[0].message, /早/);
});
