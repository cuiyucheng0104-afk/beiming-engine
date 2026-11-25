// fx.post-state 自测：确定性后期状态结构体、多事件叠加、乱序抽帧逐位一致、边界归零与 schema 校验。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dataValidators } from '../../sweep-schema.mjs';
import { scanCardLeaks, validateCard } from '../../validate-card.mjs';
import { evaluate, evaluatePostState } from './index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('fx.post-state：card.json 与 schema.json 通过 validateCard、scanCardLeaks 与 dataValidators', () => {
  const raw = readFileSync(join(HERE, 'card.json'), 'utf8');
  assert.deepEqual(scanCardLeaks(raw), []);
  const card = JSON.parse(raw);
  assert.deepEqual(validateCard(card), { ok: true, schemaErrors: [], violations: {}, leaks: [] });
  assert.equal(card.id, 'fx.post-state');
  assert.equal(card.kind, 'time');
  assert.deepEqual(card.livesIn, ['data']);
  const validators = dataValidators(card);
  assert.equal(validators.length, 1);
  assert.equal(validators[0][1](card.params.events.default), true);
});

test('fx.post-state：输出完整结构体并在无事件与边界时刻精确归零', () => {
  const inputs = { fps: '60/1', shot: { in: 0 } };
  const params = {
    exposure: 1.0,
    bloom: 0.06,
    ao: 0.9,
    shaft: 1.0,
    god: 0.55,
    ca: 0.006,
    vignette: 0.42,
    fadeInSec: 2.0,
    fadeOutStartSec: 8.0,
    durationSec: 10.0,
    events: [],
  };
  const t0 = evaluate(inputs, params, 0, 0).postState;
  assert.equal(t0.fade, 0, 't=0 处于淡入起点，fade 应为 0');
  assert.equal(t0.flash, 0);
  assert.equal(t0.lens.fringe, 0);
  assert.equal(t0.lens.kick, 0);
  assert.equal(t0.lens.ring.strength, 0);

  const mid = evaluate(inputs, params, 300, 0).postState; // t = 5s
  assert.equal(mid.fade, 1);
  assert.equal(mid.exposure, 1.0);
  assert.equal(mid.bloom, 0.06);
  assert.equal(mid.ao, 0.9);
  assert.equal(mid.shaft, 1.0);
  assert.equal(mid.god, 0.55);
  assert.equal(mid.ca, 0.006);
  assert.equal(mid.vignette, 0.42);

  const end = evaluate(inputs, params, 600, 0).postState; // t = 10s
  assert.equal(end.fade, 0, 't=durationSec 时淡出归零');
});

test('fx.post-state：多事件（pulse/strike/window/hit/ring/dusk）叠加与乱序抽帧逐位一致', () => {
  const inputs = { fps: '60/1', shot: { in: 0 } };
  const params = {
    exposure: 1.0,
    bloom: 0.06,
    ao: 0.9,
    shaft: 1.0,
    god: 0.55,
    ca: 0.006,
    vignette: 0.42,
    fadeInSec: 0.5,
    fadeOutStartSec: 9.0,
    durationSec: 10.0,
    events: [
      { kind: 'pulse', at: 2.0, attack: 0.04, release: 0.3, flash: 1.0, exposure: 0.25, bloom: 0.08, shake: 0.8, kick: 1.0, preDip: 0.28 },
      { kind: 'strike', at: 4.0, tau: 0.07, restrikeDelay: 0.11, restrikeGain: 0.6, restrikeTau: 0.05, window: 0.7, flash: 0.5, shake: 0.25, fringe: 0.4 },
      { kind: 'window', at: 5.0, end: 7.0, attack: 0.3, release: 0.2, exposure: 0.12, bloom: 0.05, shake: 0.22, flickerHz: 7, flickerBase: 0.6, flickerAmp: 0.4 },
      { kind: 'hit', at: 2.0, amp: 1.0 },
      { kind: 'ring', at: 2.0, duration: 1.0, center: [0.5, 0.5], radius0: 0.05, radiusMax: 0.65, rate: 3.0, strength: 0.02, decay: 0.25, attack: 0.03, widthMin: 0.02, widthFactor: 0.12, squash: 0.85, angleDeg: 15 },
      { kind: 'dusk', at: 8.0, end: 9.5, targetScale: 0.3 },
    ],
  };

  // 事件前预暗 dip (t = 1.98s, 帧 118.8)
  const dip = evaluatePostState(1.98, params);
  assert.ok(dip.exposure < 0.8, `闪光前一帧应有对比预暗: ${dip.exposure}`);

  // 撞击峰值 (t = 2.04s)
  const hit = evaluatePostState(2.04, params);
  assert.ok(hit.flash > 0.9, `pulse 闪光应激活: ${hit.flash}`);
  assert.ok(hit.lens.kick > 0.9, `kick 应激活: ${hit.lens.kick}`);
  assert.ok(hit.lens.fringe > 0.7, `hit fringe 应激活: ${hit.lens.fringe}`);
  assert.ok(hit.lens.ring.strength > 0.01, `shock ring 应激活: ${hit.lens.ring.strength}`);

  // 闪电二次回闪 (t = 4.12s)
  const strike2 = evaluatePostState(4.12, params);
  assert.ok(strike2.flash > 0.3, `二次回闪应叠加: ${strike2.flash}`);

  // 窗口内抖动持续激活 (t = 6.0s)
  const winMid = evaluatePostState(6.0, params);
  assert.ok(winMid.bloom > 0.10 && winMid.shake > 0.1, `窗口应抬升 bloom 与 shake`);

  // 暮光压暗 (t = 9.5s)
  const dusk = evaluatePostState(9.5, params);
  assert.ok(Math.abs(dusk.exposure - 0.3) < 1e-6, `dusk 结束后曝光应落到 0.3: ${dusk.exposure}`);

  // 乱序抽帧逐位一致
  const frames = [0, 119, 122, 247, 360, 570, 122, 0, 360, 247];
  const ref = new Map();
  for (const f of [0, 119, 122, 247, 360, 570]) {
    ref.set(f, JSON.stringify(evaluate(inputs, params, f, 0.25)));
  }
  for (const f of frames) {
    assert.equal(JSON.stringify(evaluate(inputs, params, f, 0.25)), ref.get(f));
  }
});

test('fx.post-state：非法参数抛 usage.bad-argument', () => {
  assert.throws(() => evaluatePostState(NaN, {}), { code: 'usage.bad-argument' });
  assert.throws(() => evaluate({ fps: '0/1', shot: { in: 0 } }, {}, 0, 0), { code: 'usage.bad-argument' });
  assert.throws(() => evaluatePostState(1, { events: [{ kind: 'unknown', at: 1 }] }), { code: 'usage.bad-argument' });
});
