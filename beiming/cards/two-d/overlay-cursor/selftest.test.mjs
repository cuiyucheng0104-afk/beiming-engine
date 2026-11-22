// overlay.cursor 的自测：两次点击的小点击表上看位置、下压、波纹、事件条目和叠出来的像素。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { create } from './comp.mjs';

const CLICKS = [{ id: 'open', frame: 24, x: 0.25, y: 0.4 }, { id: 'send', frame: 60, x: 0.6, y: 0.55 }];
const DEFAULTS = { clicks: CLICKS, cutDelayFrames: 2, moveFrames: 18, pressFrames: 4, rippleFrames: 10, sizeFrac: 0.012, rippleFrac: 0.05, startX: 0.5, startY: 0.5, ink: '#FFFFFF', audio: 'click' };
const cursor = (params = {}, ctx = {}) => create({ size: [1280, 720], ...ctx }, { ...DEFAULTS, ...params });
const moved = (c, a, b) => Math.hypot(c.at(b).x - c.at(a).x, c.at(b).y - c.at(a).y);

test('overlay.cursor：光标正好在点击帧到位，之前停在上一个位置；出发和到位那一帧的位移都小于 1 像素', () => {
  const c = cursor().object;
  assert.deepEqual([c.at(0).x, c.at(0).y, c.at(6).x], [640, 360, 640]);
  assert.deepEqual([c.at(24).x, c.at(24).y, c.at(30).x, c.at(42).y], [320, 288, 320, 288]);
  assert.deepEqual([c.at(60).x, Math.round(c.at(60).y * 1e9) / 1e9, c.at(500).x], [768, 396, 768]);
  for (const [a, b] of [[6, 7], [23, 24], [42, 43], [59, 60]]) assert.ok(moved(c, a, b) > 0 && moved(c, a, b) < 1, `第 ${a} 到 ${b} 帧动了 ${moved(c, a, b)} 像素`);
  assert.ok(moved(c, 50, 51) > 20, '半路上走得快');
});

test('overlay.cursor：点击帧起 4 帧下压、10 帧波纹，过了就恢复', () => {
  const c = cursor().object;
  assert.deepEqual([23, 24, 27, 28].map((f) => c.at(f).pressed), [false, true, true, false]);
  assert.deepEqual([c.at(23).scale, c.at(24).scale, c.at(26).scale, c.at(28).scale], [1, 0.75, 0.875, 1]);
  assert.deepEqual([c.at(23).ripple, c.at(34).ripple], [null, null]);
  assert.deepEqual(c.at(24).ripple, { radius: 0, alpha: 0.6 });
  assert.ok(c.at(29).ripple.radius > c.at(25).ripple.radius && c.at(33).ripple.radius < 36 && c.at(33).ripple.alpha < c.at(25).ripple.alpha);
});

test('overlay.cursor：每次点击交一条命名条目和一条晚 2 帧的切点条目，按帧号再按 id 排', () => {
  const c = cursor().object;
  assert.deepEqual(c.pairs, [{ id: 'open', clickFrame: 24, cutFrame: 26 }, { id: 'send', clickFrame: 60, cutFrame: 62 }]);
  assert.deepEqual(c.events, [
    { id: 'open', frame: 24, sub: 0, kind: 'named', from: 'film', audio: 'click', sync: 'onset' },
    { id: 'cut.26', frame: 26, sub: 0, kind: 'cut', from: 'film' },
    { id: 'send', frame: 60, sub: 0, kind: 'named', from: 'film', audio: 'click', sync: 'onset' },
    { id: 'cut.62', frame: 62, sub: 0, kind: 'cut', from: 'film' },
  ]);
  // 点击和上一次的切点同帧时，id 小的在前
  assert.deepEqual(cursor({ clicks: [CLICKS[0], { ...CLICKS[1], frame: 26 }] }).object.events.map((e) => e.id), ['open', 'cut.26', 'send', 'cut.28']);
  assert.deepEqual(cursor({ cutDelayFrames: 0 }).object.events.map((e) => e.id), ['cut.24', 'open', 'cut.60', 'send']);
});

test('overlay.cursor：往全黑的画面上叠，亮起来的像素都在交回的包围盒里；直通透明度按「上压下」算', () => {
  const c = cursor().object;
  for (const f of [0, 24, 27, 30, 50]) {
    const rgba = new Uint8ClampedArray(1280 * 720 * 4), [x0, y0, x1, y1] = c.draw(f, rgba);
    let lit = 0;
    for (let i = 0; i < 1280 * 720; i++) {
      if (!rgba[i * 4 + 3]) continue;
      lit++;
      const x = i % 1280, y = Math.floor(i / 1280);
      assert.ok(x + 1 > x0 && x < x1 && y + 1 > y0 && y < y1, `第 ${f} 帧 (${x}, ${y}) 在包围盒外`);
    }
    assert.ok(lit > 100, `第 ${f} 帧画了 ${lit} 个像素`);
  }
  const at = (x, y) => (y * 1280 + x) * 4, clear = new Uint8ClampedArray(1280 * 720 * 4), gray = new Uint8ClampedArray(1280 * 720 * 4).fill(100);
  gray.forEach((_, i) => { if (i % 4 === 3) gray[i] = 255; });
  c.draw(0, clear);
  c.draw(0, gray);
  // 光标正中：透明底上是墨色、透明度 0.9；不透明的灰底上是 255 × 0.9 + 100 × 0.1
  assert.deepEqual([...clear.subarray(at(640, 360), at(640, 360) + 4)], [255, 255, 255, 230]);
  assert.deepEqual([...gray.subarray(at(640, 360), at(640, 360) + 4)], [240, 240, 240, 255]);
  assert.deepEqual([...gray.subarray(at(700, 360), at(700, 360) + 4)], [100, 100, 100, 255]);
});

test('overlay.cursor：meta(f) 的 f 是镜头局部帧号，非首镜头要加上镜头起始帧；每帧都是闭式的，乱序求结果相同', () => {
  const whole = cursor(), shot = cursor({}, { shot: { id: 's02', in: 20, frames: 60 } });
  assert.deepEqual(shot.meta(4), whole.meta(24));
  assert.deepEqual(shot.meta(4), { readings: { x: 320, y: 288, pressed: 1, ripple: 0 } });
  assert.deepEqual(whole.meta(4), { readings: { x: 640, y: 360, pressed: 0, ripple: 0 } });
  const forward = Array.from({ length: 80 }, (_, f) => whole.object.at(f)), again = cursor().object;
  for (const f of [79, 3, 60, 24, 41, 0]) assert.deepEqual(again.at(f), forward[f]);
});

test('overlay.cursor：点击表不按时间先后、两次点击同帧、id 重复或写法不对、墨色写法不对、缓冲大小不对都报错；没有点击就停在起点', () => {
  const bad = (params) => assert.throws(() => cursor(params), { name: 'RangeError', code: 'contract.bad-value' });
  bad({ clicks: [CLICKS[1], CLICKS[0]] });
  bad({ clicks: [CLICKS[0], { ...CLICKS[1], frame: 24 }] });
  bad({ clicks: [CLICKS[0], { ...CLICKS[1], id: 'open' }] });
  bad({ clicks: [{ ...CLICKS[0], id: 'cut.26' }] });
  bad({ clicks: [{ ...CLICKS[0], frame: 1.5 }] });
  bad({ ink: 'white' });
  assert.throws(() => cursor().object.draw(0, new Uint8ClampedArray(16)), { code: 'contract.bad-value' });
  const still = cursor({ clicks: [] }).object;
  assert.deepEqual([still.events, still.pairs, still.at(99).x, still.at(99).pressed], [[], [], 640, false]);
});
