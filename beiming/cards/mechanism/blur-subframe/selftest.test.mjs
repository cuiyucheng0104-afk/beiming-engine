import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accumulateLinear,
  create,
  measureCutGhosting,
  renderSubframeBlur,
  subframeTimes,
} from './index.mjs';

test('blur.subframe 自测：切点后首帧（f = shot.in）严格钳制快门窗口，跨镜头重影能量为 0；未钳制负对照产生 50% 重影', () => {
  const shotB = { in: 48, frames: 48 }; // 镜头 B 从第 48 帧切入，区间 [48, 96)
  const pixelCount = 16;

  // 模拟多镜头时间线渲染器：t < 48 属于上一镜头 A（高亮红色特征），t >= 48 属于当前镜头 B（冷蓝特征）
  const prevShotFrame = new Float32Array(pixelCount * 4);
  const currShotFrame = new Float32Array(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) {
    prevShotFrame[i * 4] = 12.0; // 镜头 A：HDR 高亮红
    prevShotFrame[i * 4 + 1] = 0.0;
    prevShotFrame[i * 4 + 2] = 0.0;
    prevShotFrame[i * 4 + 3] = 1.0;

    currShotFrame[i * 4] = 0.0;
    currShotFrame[i * 4 + 1] = 0.5;
    currShotFrame[i * 4 + 2] = 2.4; // 镜头 B：线性蓝
    currShotFrame[i * 4 + 3] = 1.0;
  }

  const renderTimeline = (t) => (t < shotB.in ? prevShotFrame : currShotFrame);

  // 1. 开启镜头边界钳制（默认 clampToShot: true）：切点后首帧 f = 48 绝不采样 t < 48
  const clamped = renderSubframeBlur(48, shotB, renderTimeline, {
    shutterAngleDeg: 180,
    samples: 8,
    alignment: 'centered',
    clampToShot: true,
  });

  assert.equal(clamped.outOfShotCount, 0, '钳制后不得有任何子帧落出当前镜头');
  for (const s of clamped.schedule) {
    assert.ok(s.t >= 48 && s.t < 96, `子帧时刻 ${s.t} 必须落在 [48, 96) 内`);
  }

  const clampedGhost = measureCutGhosting(clamped.rgba, prevShotFrame, currShotFrame);
  assert.equal(clampedGhost.ghostRatio, 0, '切点后首帧上一镜头重影占比必须严格为 0');
  assert.equal(clampedGhost.maxGhostDelta, 0, '切点后首帧与纯净当前镜头的线性最大偏差必须为 0');

  // 2. 镜头尾帧（f = 95）同样不得越过 shotOut = 96 采样下一镜头
  const tailSched = subframeTimes(95, shotB, {
    shutterAngleDeg: 360,
    samples: 8,
    alignment: 'forward',
    clampToShot: true,
  });
  for (const s of tailSched) {
    assert.ok(s.t >= 48 && s.t < 96, `镜头尾帧子帧时刻 ${s.t} 不得越过 shotOut=96`);
  }

  // 3. 负对照（clampToShot: false）：居中快门在 f = 48 有一半子帧落进 t < 48，产生 50% 跨镜头重影
  const unclamped = renderSubframeBlur(48, shotB, renderTimeline, {
    shutterAngleDeg: 180,
    samples: 8,
    alignment: 'centered',
    clampToShot: false,
  });
  assert.equal(unclamped.outOfShotCount, 4, '未钳制居中快门应有 4 个子帧落入上一镜头');
  const unclampedGhost = measureCutGhosting(unclamped.rgba, prevShotFrame, currShotFrame);
  assert.ok(Math.abs(unclampedGhost.ghostRatio - 0.5) < 1e-6, `负对照应测出 0.5 重影占比，实际 ${unclampedGhost.ghostRatio}`);
  assert.ok(unclampedGhost.maxGhostDelta > 5.0, '负对照应测出显著跨镜头重影残差');
});

test('blur.subframe 自测：场景线性光空间 HDR 能量守恒与 L2 纯函数门（顺序 / 逆序 / 单帧一致）', () => {
  // 8 个像素的扫描线，8 个子帧中一个 HDR 亮度为 16.0 的高光点依次扫过第 i 个像素
  const subframes = Array.from({ length: 8 }, (_, s) => {
    const buf = new Float32Array(8 * 4);
    buf[s * 4] = 16.0;
    buf[s * 4 + 3] = 1.0;
    return buf;
  });

  const acc = accumulateLinear(subframes);
  let totalEnergy = 0;
  for (let p = 0; p < 8; p++) {
    assert.equal(acc[p * 4], 2.0, `第 ${p} 个像素在线性光平均后应为 16 / 8 = 2.0`);
    totalEnergy += acc[p * 4];
  }
  assert.equal(totalEnergy, 16.0, '线性光运动模糊前后总辐射能量必须守恒');

  const handle = create(
    { shot: { in: 24, frames: 48 } },
    { shutterAngleDeg: 180, samples: 8, clampToShot: true },
  );

  const testFrames = [24, 25, 36, 60, 71];
  const forward = testFrames.map((f) => handle.apply(f, 0));
  const reversed = [...testFrames].reverse().map((f) => handle.apply(f, 0)).reverse();
  const single = handle.apply(36, 0);

  assert.deepEqual(forward, reversed);
  assert.deepEqual(single, forward[2]);
  assert.equal(handle.meta(24).readings.outOfShotSamples, 0);
});

test('blur.subframe 自测：零陷阱拦截 Proxy、getter、稀疏数组与 NaN', () => {
  let traps = 0;
  const proxyShot = new Proxy({ in: 0, frames: 24 }, {
    get() {
      traps++;
      return 0;
    },
  });
  assert.throws(() => subframeTimes(0, proxyShot), (err) => err?.code === 'usage.bad-argument');

  const getterParams = {};
  Object.defineProperty(getterParams, 'samples', {
    enumerable: true,
    get() {
      traps++;
      return 8;
    },
  });
  assert.throws(() => create({}, getterParams), (err) => err?.code === 'usage.bad-argument');

  const badBuf = new Float32Array([1, 0, Number.NaN, 1]);
  assert.throws(() => accumulateLinear([badBuf]), (err) => err?.code === 'usage.bad-argument');

  assert.equal(traps, 0);
});
