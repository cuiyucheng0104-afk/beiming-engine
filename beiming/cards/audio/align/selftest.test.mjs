// audio.align 的自测：自己合成一段带低频重击的配乐，对到 30 秒的正片上，再从对完的声音里把重击量回来。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { create } from './comp.mjs';

const RATE = 48000, FRAMES = 720;
const DEFAULTS = { stretchMin: 0.97, stretchMax: 1.03, splice: false, crossfadeMs: 40, lowHz: 120, hitFloor: 0.3 };
const card = (params = {}) => create({ fps: '24/1' }, { ...DEFAULTS, ...params }).object;
/** 大数组不交给 deepEqual：不等时它要把两边整个打印出来 */
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const within = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} 应在 ${b} ± ${tol}`);
const refused = (fn) => assert.throws(fn, { name: 'RangeError', code: 'usage.bad-argument' });

/** 26 秒的配乐：十下不等距的低频重击（55 赫兹往下扫的衰减正弦），首尾两下相隔 20 ÷ 1.009 秒；垫 440 赫兹的长音和每四分之一秒一下的高频短音 */
const GAP = 20 / 1.009, FIRST = 1.52 / 1.009;
const HITS = [0, 0.11, 0.2, 0.33, 0.41, 0.52, 0.6, 0.74, 0.86, 1].map((u) => FIRST + u * GAP);
function track() {
  const x = new Float32Array(26 * RATE);
  for (const t of HITS) {
    let phase = 0;
    for (let i = 0, s = Math.round(t * RATE); i < 0.25 * RATE; i++) {
      phase += (2 * Math.PI * (48 + 110 * Math.exp(-i / 1440))) / RATE;
      x[s + i] += 0.8 * Math.sin(phase) * Math.exp(-i / 2880);
    }
  }
  for (let i = 0; i < x.length; i++) x[i] += 0.03 * Math.sin((2 * Math.PI * 440 * i) / RATE);
  for (let k = 0; k < 104; k++) for (let i = 0, s = Math.round((0.07 + k / 4) * RATE); i < 480; i++) x[s + i] += 0.2 * Math.sin((2 * Math.PI * 6000 * i) / RATE) * Math.exp(-i / 100);
  return x;
}
const SRC = track();

test('audio.align：hits 只认低频重击，十下都找到，离真值不到 3 毫秒；高频短音和长音不算', () => {
  const found = card().hits([SRC]);
  assert.equal(found.length, HITS.length);
  found.forEach((t, i) => within(t, HITS[i], 0.003));
  assert.deepEqual(card().hits([SRC.map(() => 0)]), []);
});

test('audio.align：首尾两下重击对到第 96 和第 576 帧：拉伸比 1.009，偏移 2.48 秒，对完量回来两下都离目标帧不到 1 帧', () => {
  const c = card(), out = c.align([SRC], { frames: FRAMES, anchors: [{ frame: 96, hit: 0 }, { frame: 576, hit: -1 }] });
  within(out.stretch, 1.009, 0.0005);
  within(out.offsetSec, 2.48, 0.005);
  assert.equal(out.splice, null);
  assert.deepEqual(out.channels.map((ch) => ch.length), [FRAMES * 2000, FRAMES * 2000]);
  assert.ok(same(out.channels[0], out.channels[1]));
  const landed = c.hits(out.channels).map((t) => t * 24);
  assert.equal(landed.length, HITS.length);
  within(landed[0], 96, 1);
  within(landed.at(-1), 576, 1);
  // 配乐盖不到的开头是静音
  assert.ok(out.channels[0].subarray(0, 2.4 * RATE).every((v) => v === 0));
});

test('audio.align：一个锚点只平移；不给锚点时照 stretch 和 offsetSec 直接做；拉伸比 1、偏移 0 时原样照抄', () => {
  const c = card(), one = c.align([SRC], { frames: FRAMES, anchors: [{ frame: 600, sourceSec: HITS.at(-1) }] });
  assert.equal(one.stretch, 1);
  within(one.offsetSec, 25 - HITS.at(-1), 1e-9);
  within(c.hits(one.channels).at(-1) * 24, 600, 1);
  const copy = c.align([SRC], { frames: FRAMES });
  assert.ok(same(copy.channels[0].subarray(0, SRC.length), SRC));
  const slow = c.align([SRC], { frames: FRAMES, stretch: 1.03, offsetSec: 1 });
  within(c.hits(slow.channels)[0], 1 + 1.03 * HITS[0], 0.003);
});

test('audio.align：要的拉伸比出了 [0.97, 1.03] 就报错，不悄悄变速；正好在界上的收', () => {
  const c = card();
  refused(() => c.align([SRC], { frames: FRAMES, anchors: [{ frame: 96, hit: 0 }, { frame: 596, hit: -1 }] }));
  refused(() => c.align([SRC], { frames: FRAMES, anchors: [{ frame: 96, hit: 0 }, { frame: 556, hit: -1 }] }));
  refused(() => c.align([SRC], { frames: FRAMES, stretch: 1.031 }));
  refused(() => c.align([SRC], { frames: FRAMES, stretch: 0.969 }));
  assert.equal(c.align([SRC], { frames: FRAMES, stretch: 1.03 }).stretch, 1.03);
  assert.equal(c.align([SRC], { frames: FRAMES, stretch: 0.97 }).stretch, 0.97);
  // 范围只能收窄，不能放宽
  refused(() => card({ stretchMax: 1.05 }));
  refused(() => card({ stretchMin: 0.9 }));
  refused(() => card({ stretchMin: 0.99, stretchMax: 1.005 }).align([SRC], { frames: FRAMES, anchors: [{ frame: 96, hit: 0 }, { frame: 576, hit: -1 }] }));
});

test('audio.align：开了 splice，出界的就剪接一次：剪掉或者重放一段，拉伸比回到 1 附近，首尾重击照样落在目标帧上', () => {
  const c = card({ splice: true });
  for (const [frame, count] of [[496, 9], [616, 11]]) {
    const out = c.align([SRC], { frames: FRAMES, anchors: [{ frame: 96, hit: 0 }, { frame, hit: -1 }] });
    within(out.stretch, 1, 0.002);
    assert.equal(out.splice.crossfadeMs, 40);
    assert.equal(Math.sign(out.splice.resumeSec - out.splice.cutSec), frame < 576 ? 1 : -1);
    const landed = c.hits(out.channels).map((t) => t * 24);
    within(landed[0], 96, 1);
    within(landed.at(-1), frame, 1);
    assert.equal(landed.length, count, '剪接的那一段里有一下重击，跟着少一下或者多一下');
  }
  // 在界内的不剪
  assert.equal(c.align([SRC], { frames: FRAMES, anchors: [{ frame: 96, hit: 0 }, { frame: 576, hit: -1 }] }).splice, null);
  // 两个锚点挨得太近，一次剪接凑不出来
  refused(() => c.align([SRC], { frames: FRAMES, anchors: [{ frame: 96, hit: 0 }, { frame: 97, hit: 1 }] }));
});

test('audio.align：同样的输入做两遍逐个样本相同；两个声道各对各的', () => {
  const run = () => card({ splice: true }).align([SRC, SRC.map((v) => -v / 2)], { frames: FRAMES, anchors: [{ frame: 96, hit: 0 }, { frame: 496, hit: -1 }] });
  const a = run(), b = run();
  assert.deepEqual([a.stretch, a.offsetSec, a.splice, a.anchors], [b.stretch, b.offsetSec, b.splice, b.anchors]);
  assert.ok(same(a.channels[0], b.channels[0]) && same(a.channels[1], b.channels[1]));
  assert.ok(same(a.channels[1], a.channels[0].map((v) => -v / 2)));
});

test('audio.align：锚点太多、帧号出了正片、没有那一下重击、锚点先后反了、声道不对、没给总帧数都报错', () => {
  const c = card();
  refused(() => c.align([SRC], { frames: FRAMES, anchors: [] }));
  refused(() => c.align([SRC], { frames: FRAMES, anchors: [{ frame: 1, hit: 0 }, { frame: 2, hit: 1 }, { frame: 3, hit: 2 }] }));
  refused(() => c.align([SRC], { frames: FRAMES, anchors: [{ frame: 720, hit: 0 }] }));
  refused(() => c.align([SRC], { frames: FRAMES, anchors: [{ frame: 96, hit: 10 }] }));
  refused(() => c.align([SRC], { frames: FRAMES, anchors: [{ frame: 96, sourceSec: 27 }] }));
  refused(() => c.align([SRC], { frames: FRAMES, anchors: [{ frame: 576, hit: 0 }, { frame: 96, hit: -1 }] }));
  refused(() => c.align([SRC, SRC.subarray(1)], { frames: FRAMES }));
  refused(() => c.align([SRC], {}));
});
