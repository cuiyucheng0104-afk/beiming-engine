import assert from 'node:assert/strict';
import test from 'node:test';
import { shutterSubs } from '../../../kernel/eval/time.mjs';
import {
  accumulateLinear,
  create,
  measureCutGhosting,
  renderSubframeBlur,
  subframeTimes,
} from './index.mjs';

test('blur.subframe 自测：切点后首帧（f = shot.in）严格钳制快门窗口，跨镜头重影能量为 0；未钳制负对照产生 50% 重影', () => {
  const shotB = { in: 31, frames: 4 }; // 镜头 B 从第 31 帧切入，区间 [31, 35)
  const prevShotFrame = new Float32Array([1, 0, 0, 1]); // 前镜：纯红
  const currShotFrame = new Float32Array([0, 0, 1, 1]); // 本镜：纯蓝
  const renderTimeline = (t) => (t < shotB.in ? prevShotFrame : currShotFrame);

  // 1. 开启镜头边界钳制（默认 clampToShot: true）：切点后首帧 f = 31 全部 8 个子帧均在镜头内，输出严格为 [0, 0, 1, 1]
  const clamped = renderSubframeBlur(31, shotB, renderTimeline, {
    shutterAngleDeg: 180,
    samples: 8,
    clampToShot: true,
  });

  assert.equal(clamped.outOfShotCount, 0, '钳制后不得有任何子帧落出当前镜头');
  for (const s of clamped.schedule) {
    assert.ok(s.t >= 31 && s.t < 35, `子帧时刻 ${s.t} 必须落在 [31, 35) 内`);
  }
  assert.deepEqual([...clamped.rgba], [0, 0, 1, 1]);
  const clampedGhost = measureCutGhosting(clamped.rgba, prevShotFrame, currShotFrame);
  assert.equal(clampedGhost.ghostRatio, 0);
  assert.equal(clampedGhost.maxGhostDelta, 0);

  // 2. 负对照（clampToShot: false）：4 个子帧采到前镜，输出 [0.5, 0, 0.5, 1]，红通道平方能量为 0.25
  const unclamped = renderSubframeBlur(31, shotB, renderTimeline, {
    shutterAngleDeg: 180,
    samples: 8,
    clampToShot: false,
  });
  assert.equal(unclamped.outOfShotCount, 4, '关闭钳制后应有 4 个子帧落入上一镜头');
  assert.deepEqual([...unclamped.rgba], [0.5, 0, 0.5, 1]);
  assert.equal(unclamped.rgba[0] ** 2, 0.25);
  const unclampedGhost = measureCutGhosting(unclamped.rgba, prevShotFrame, currShotFrame);
  assert.ok(Math.abs(unclampedGhost.ghostRatio - 0.5) < 1e-6);

  // 3. 镜头尾帧（f = 34）同样不得越过 shotOut = 35
  const tailSched = subframeTimes(34, shotB, {
    shutterAngleDeg: 360,
    samples: 8,
    clampToShot: true,
  });
  for (const s of tailSched) {
    assert.ok(s.t >= 31 && s.t < 35, `镜头尾帧子帧时刻 ${s.t} 不得越过 shotOut=35`);
  }
});

test('blur.subframe 自测：真实页面宿主上下文接入、局部首帧 apply(0, 0) 换算、复用同一读回缓冲与 shutterSubs 默认快门对齐', () => {
  // 1. 内部第 32 帧、180°、两采样及单采样的默认时刻严格对齐 T5/T14 shutterSubs
  const subs = shutterSubs(180, 2);
  const sched32 = subframeTimes(32, { in: 31, frames: 4 }, { shutterAngleDeg: 180, samples: 2 });
  assert.deepEqual(sched32.map((s) => s.sub), subs);
  assert.deepEqual(sched32.map((s) => s.t), [32.125, 32.375]);
  const sched32Single = subframeTimes(32, { in: 31, frames: 4 }, { shutterAngleDeg: 180, samples: 1 });
  assert.deepEqual(sched32Single.map((s) => s.sub), shutterSubs(180, 1));
  assert.deepEqual(sched32Single.map((s) => s.t), [32.25]);

  // 2. 真实页面宿主完整 ctx（含 ctx.tracks.apply、cards.use、rng 等）及局部首帧 apply(0, 0) -> 全片第 31 帧
  const hostCtx = {
    tracks: { apply() {} },
    cards: { use() {} },
    params: {},
    seed: 42,
    rng: () => () => 0.5,
    assets: { load() {} },
    anchor() {},
    tokens: {},
    size: [1280, 720],
    fps: '24/1',
    frames: 4,
    shot: Object.freeze({ id: 'shot-2', in: 31, frames: 4 }),
    events: Object.freeze({}),
    THREE: {},
    renderer: {},
  };
  const handle = create(hostCtx, { shutterAngleDeg: 180, samples: 2 });
  const app0 = handle.apply(0, 0);
  assert.equal(app0.frame, 0);
  assert.equal(app0.filmFrame, 31);
  assert.equal(app0.minTime, 31.125);
  assert.equal(app0.maxTime, 31.375);
  assert.equal(handle.meta(0).readings.subframeSamples, 2);

  // 3. 复用同一 Float32Array 读回缓冲依次交黑 [0,0,0,1]、白 [1,1,1,1] 两帧，应在下次回调前消费当前样本并得到 [0.5,0.5,0.5,1]
  const sharedReadback = new Float32Array(4);
  let callIndex = 0;
  const renderedShared = handle.object.renderFrame(1, () => {
    const v = callIndex++ === 0 ? 0 : 1;
    sharedReadback[0] = v;
    sharedReadback[1] = v;
    sharedReadback[2] = v;
    sharedReadback[3] = 1;
    return sharedReadback;
  });
  assert.deepEqual([...renderedShared.rgba], [0.5, 0.5, 0.5, 1]);
});

test('blur.subframe 自测：场景线性光空间 HDR 能量守恒、L2 纯函数门与非法参数拒绝', () => {
  const subframes = Array.from({ length: 8 }, (_, s) => {
    const buf = new Float32Array(8 * 4);
    buf[s * 4] = 16.0;
    buf[s * 4 + 3] = 1.0;
    return buf;
  });

  const acc = accumulateLinear(subframes);
  let totalEnergy = 0;
  for (let p = 0; p < 8; p++) {
    assert.equal(acc[p * 4], 2.0);
    totalEnergy += acc[p * 4];
  }
  assert.equal(totalEnergy, 16.0);

  const handle = create(
    { shot: { in: 24, frames: 48 } },
    { shutterAngleDeg: 180, samples: 8, clampToShot: true },
  );

  const localFrames = [0, 1, 12, 36, 47];
  const forward = localFrames.map((f) => handle.apply(f, 0));
  const reversed = [...localFrames].reverse().map((f) => handle.apply(f, 0)).reverse();
  const single = handle.apply(12, 0);

  assert.deepEqual(forward, reversed);
  assert.deepEqual(single, forward[2]);
  assert.equal(handle.meta(0).readings.outOfShotSamples, 0);

  const badBuf = new Float32Array([1, 0, Number.NaN, 1]);
  assert.throws(() => accumulateLinear([badBuf]), (err) => err?.code === 'usage.bad-argument');
  assert.throws(() => subframeTimes(0, { in: 0, frames: 24 }, { shutterAngleDeg: 400 }), (err) => err?.code === 'usage.bad-argument');
  assert.throws(() => subframeTimes(0, { in: 0, frames: 24 }, { samples: 0 }), (err) => err?.code === 'usage.bad-argument');
});
