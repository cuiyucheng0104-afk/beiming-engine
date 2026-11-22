// V18 单测（Red -> Green）：双样本 Welch t 检验、Benjamini-Hochberg 多重比较校正、p 值直方图平坦性与 1.01 倍微偏检出
import assert from 'node:assert/strict';
import test from 'node:test';
import * as verify from './index.mjs';

// 确定性 Mulberry32 + Box-Muller 高斯噪声生成器，供可复现蒙特卡洛测试使用
function makeRng(seed) {
  let s = seed >>> 0;
  const nextU = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    normal(mean = 0, std = 1) {
      const u1 = Math.max(1e-12, nextU());
      const u2 = nextU();
      return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    },
  };
}

function renderNoisyGroup(k, width, height, baseSeed, scale = 1.0, noiseStd = 0.015) {
  const frames = [];
  for (let i = 0; i < k; i++) {
    const rng = makeRng(baseSeed + i * 7919);
    const data = new Float32Array(width * height * 3);
    for (let p = 0; p < width * height; p++) {
      const trueVal = (0.5 + 0.3 * ((p % width) / width)) * scale;
      data[p * 3] = Math.max(0, rng.normal(trueVal, noiseStd));
      data[p * 3 + 1] = Math.max(0, rng.normal(trueVal, noiseStd));
      data[p * 3 + 2] = Math.max(0, rng.normal(trueVal, noiseStd));
    }
    frames.push({ width, height, data, channels: 3 });
  }
  return frames;
}

test('V18-1 同一渲染器换种子两组 (K=16)：BH 显著像素比例不超过显著性水平，p 值直方图平坦', () => {
  assert.equal(typeof verify.welchTest, 'function', 'verify 应导出 welchTest');

  const groupA = renderNoisyGroup(16, 64, 64, 1000, 1.0, 0.02);
  const groupB = renderNoisyGroup(16, 64, 64, 50000, 1.0, 0.02);

  const resPx = verify.welchTest(groupA, groupB, { alpha: 0.05, blockSize: 1 });
  assert.ok(resPx.significantRatio <= 0.05, `零假设下 BH 显著比例应 <= 0.05，实得 ${resPx.significantRatio}`);
  assert.equal(resPx.pHistogram.flat, true, `零假设下 p 值直方图应平坦，实得 ${JSON.stringify(resPx.pHistogram)}`);
  assert.equal(resPx.pass, true);
  assert.equal(resPx.biasMap.length, 64 * 64);
  assert.equal(resPx.pHistogram.counts.reduce((sum, n) => sum + n, 0), 64 * 64);

  // rawSignificantRatio 从 pMap 独立数一遍核对
  const n = resPx.testedUnits;
  const low = resPx.pMap.reduce((count, p) => count + (p <= 0.05 ? 1 : 0), 0);
  assert.ok(low > 0);
  assert.equal(resPx.rawSignificantRatio, low / n);
  // 平坦性的名义率按 K 留余量：K=16 时是 alpha 的 1 + 0.5/15 倍
  const rate = resPx.pHistogram.effectiveAlpha;
  assert.ok(Math.abs(rate - 0.05 * (1 + 0.5 / 15)) < 1e-15, `effectiveAlpha=${rate}`);
  // lowTailP 是 p <= alpha 的单元数对 Binomial(n, effectiveAlpha) 的单侧精确尾概率，用逐项求和对照
  let pmf = (1 - rate) ** n;
  let tail = low === 0 ? pmf : 0;
  for (let i = 0; i < n; i++) {
    pmf *= (n - i) / (i + 1) * (rate / (1 - rate));
    if (i + 1 >= low) tail += pmf;
  }
  assert.ok(Math.abs(resPx.pHistogram.lowTailP - tail) < 1e-9, `${resPx.pHistogram.lowTailP} 对 ${tail}`);

  // 两边是同一批样本：p 全堆在 1，这是检验没有分辨力，不是偏差，不判不过
  const self = verify.welchTest(groupA, groupA);
  assert.deepEqual([self.significantCount, self.rawSignificantRatio, self.pHistogram.counts[19], self.pass], [0, 0, 64 * 64, true]);

  const resBlock = verify.welchTest(groupA, groupB, { alpha: 0.05, blockSize: 8 });
  assert.deepEqual(resBlock.gridSize, [8, 8]);
  assert.ok(resBlock.significantRatio <= 0.05);
  assert.equal(resBlock.pass, true);
});

test('V18-2 一边亮度乘 1.01（+1% 微偏，K=16）：在低采样噪声下被 Welch + BH 可靠检出', () => {
  const groupA = renderNoisyGroup(16, 64, 64, 2000, 1.0, 0.012);
  const groupB = renderNoisyGroup(16, 64, 64, 90000, 1.01, 0.012);

  // 逐像素与 8x8 块均应检出 1.01 倍整体亮度偏移
  const resBlock = verify.welchTest(groupA, groupB, { alpha: 0.05, blockSize: 8 });
  assert.equal(resBlock.pass, false, '亮度乘 1.01 必须判不过');
  assert.ok(resBlock.significantRatio > 0.5, `8x8 块应大面积显著，实得 ${resBlock.significantRatio}`);

  const resPx = verify.welchTest(groupA, groupB, { alpha: 0.05, blockSize: 1 });
  assert.equal(resPx.pass, false, '逐像素检验对 1.01 倍偏移也必须判不过');
  assert.equal(resPx.pHistogram.flat, false, '有偏分布的 p 值直方图不应平坦');
  assert.ok(resPx.significantCount > 0);
  // 偏差位置图给出方向和量级：A 比 B 暗约 1%（均值 0.65 的 1%）
  const meanBias = resBlock.biasMap.reduce((sum, v) => sum + v, 0) / resBlock.biasMap.length;
  assert.ok(Math.abs(meanBias + 0.0065) < 0.001, `平均偏差应约为 -0.0065，实得 ${meanBias}`);
});

test('V18-3 双侧 p 值对照 Student t 闭式与临界值表，含非整数自由度', () => {
  const p = verify.studentTwoSidedP;
  for (const t of [1e-9, 0.1, 0.7, 2, 12.706204736174694, 500, 1e8]) {
    const closed = {
      1: 1 - 2 / Math.PI * Math.atan(t),
      2: 1 - t / Math.sqrt(2 + t * t),
      3: 1 - 2 / Math.PI * (Math.atan(t / Math.sqrt(3)) + (t / Math.sqrt(3)) / (1 + t * t / 3)),
    };
    for (const [df, expected] of Object.entries(closed)) {
      // 闭式本身在 p 极小时有相消误差，所以大 t 只按绝对误差比
      assert.ok(Math.abs(p(t, Number(df)) - expected) < 1e-12, `t=${t} df=${df}: ${p(t, Number(df))} 对 ${expected}`);
      assert.equal(p(-t, Number(df)), p(t, Number(df)));
    }
  }
  // 尾部用渐近式查相对精度：df=1 时 p -> 2/(pi t)
  assert.ok(Math.abs(p(1e8, 1) / (2 / (Math.PI * 1e8)) - 1) < 1e-12);
  // 临界值表（双侧）
  for (const [t, df, expected] of [[2.2281388519649385, 10, 0.05], [2.946712883338615, 15, 0.01], [2.0422724563012373, 30, 0.05], [1.959963984540054, 1e9, 0.05]]) {
    assert.ok(Math.abs(p(t, df) - expected) < 1e-7, `t=${t} df=${df}: ${p(t, df)}`);
  }
  // 非整数自由度夹在相邻整数自由度之间（自由度越大尾部越薄）
  assert.ok(p(2.1, 15) > p(2.1, 15.5) && p(2.1, 15.5) > p(2.1, 16));
  assert.equal(p(0, 7), 1);
  assert.equal(p(Infinity, 7), 0);
  assert.throws(() => p(NaN, 7), /welch/);
});

test('V18-4 Benjamini-Hochberg：调整后 p 值、步升判定与输入校验', () => {
  const res = verify.benjaminiHochberg([0.9, 0.001, 0.041, 0.008, 0.039], 0.05);
  const expected = [0.9, 0.005, 0.05125, 0.02, 0.05125];
  res.qValues.forEach((q, i) => assert.ok(Math.abs(q - expected[i]) < 1e-12, `q[${i}]=${q}`));
  assert.deepEqual([...res.significant], [0, 1, 0, 1, 0]);
  assert.equal(res.significantCount, 2);
  // 步升：最小的 p 自己过不了 alpha/m，但全体过得了 alpha
  assert.equal(verify.benjaminiHochberg([0.03, 0.03, 0.03, 0.03], 0.05).significantCount, 4);
  assert.equal(verify.benjaminiHochberg([], 0.05).significantCount, 0);
  assert.throws(() => verify.benjaminiHochberg([0.5, NaN]), /p 值须在/);
  assert.throws(() => verify.benjaminiHochberg([0.5], 1), /alpha/);
});

test('V18-5 大片无噪背景加局部带噪前景：确定性单元单列，不进校正和直方图', () => {
  const width = 32, height = 32;
  const group = (baseSeed, background = 0) => Array.from({ length: 16 }, (_, i) => {
    const rng = makeRng(baseSeed + i * 104729);
    const data = new Float32Array(width * height).fill(background);
    for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) data[y * width + x] = rng.normal(0.4, 0.05);
    return { width, height, data };
  });
  const same = verify.welchTest(group(11), group(77777));
  assert.equal(same.deterministicUnits, 32 * 32 - 16 * 16);
  assert.equal(same.testedUnits, 16 * 16);
  assert.equal(same.pHistogram.counts.reduce((sum, n) => sum + n, 0), 16 * 16);
  assert.equal(same.pHistogram.flat, true, JSON.stringify(same.pHistogram));
  assert.equal(same.pass, true);

  // 背景两边都无噪声但差一个常数：p 为 0，全部检出
  const shifted = verify.welchTest(group(11), group(77777, 0.001));
  assert.equal(shifted.deterministicUnits, 0);
  assert.ok(shifted.significantCount >= 32 * 32 - 16 * 16);
  assert.equal(shifted.pMap[0], 0);
  assert.equal(shifted.significantMask[0], 1);
  assert.equal(shifted.pass, false);

  // 全图无噪且相等：没有可检验的单元，判过
  const flatFrames = Array.from({ length: 2 }, () => ({ width: 4, height: 4, data: new Float32Array(16).fill(0.25) }));
  const constant = verify.welchTest(flatFrames, flatFrames);
  assert.deepEqual([constant.testedUnits, constant.significantRatio, constant.pass], [0, 0, true]);

  // 只有一边有噪声：自由度退化为有噪一边的 K-1，p 与单样本 t 检验一致
  const noisy = [0.1, 0.3, 0.2, 0.6].map(v => ({ width: 1, height: 1, data: Float32Array.of(v) }));
  const fixed = [0.2, 0.2, 0.2, 0.2].map(v => ({ width: 1, height: 1, data: Float32Array.of(v) }));
  const values = noisy.map(f => f.data[0]);
  const mean = values.reduce((s, v) => s + v, 0) / 4;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / 3;
  const oneSided = verify.welchTest(noisy, fixed);
  const expected = verify.studentTwoSidedP((mean - fixed[0].data[0]) / Math.sqrt(variance / 4), 3);
  assert.ok(Math.abs(oneSided.pMap[0] - expected) < 1e-12);
  assert.deepEqual([oneSided.kA, oneSided.kB], [4, 4]);
});

test('V18-6 EXR 字节、路径与帧对象三种输入结果一致；尾块按实际像素数平均', async () => {
  const { writeExr } = await import('./exr/exr.mjs');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const width = 20, height = 12;
  const framesA = renderNoisyGroup(4, width, height, 31);
  const framesB = renderNoisyGroup(4, width, height, 4242, 1.2);
  const toExr = (frame, prefix) => writeExr({ width, height, compression: 2, channels: {
    ...Object.fromEntries(['R', 'G', 'B'].map((c, k) => [prefix + c, Float32Array.from({ length: width * height }, (_, p) => frame.data[p * 3 + k])])),
    ...(prefix && Object.fromEntries(['R', 'G', 'B'].map((c, k) => [c, Float32Array.from({ length: width * height }, (_, p) => frame.data[p * 3 + k] * 3)]))),
    'depth.Z': new Float32Array(width * height).fill(7),
    'objectId.id': new Uint32Array(width * height),
  } });
  const reference = verify.welchTest(framesA, framesB, { blockSize: 8 });
  assert.deepEqual(reference.gridSize, [3, 2]);
  assert.equal(reference.biasMap.length, 6);
  // 右下尾块是 4x4 像素：偏差应等于这 16 个像素亮度均值之差
  const lumaMean = frames => frames.reduce((sum, f) => {
    let acc = 0;
    for (let y = 8; y < 12; y++) for (let x = 16; x < 20; x++) {
      const p = (y * width + x) * 3;
      acc += 0.2126 * f.data[p] + 0.7152 * f.data[p + 1] + 0.0722 * f.data[p + 2];
    }
    return sum + acc / 16;
  }, 0) / frames.length;
  assert.ok(Math.abs(reference.biasMap[5] - (lumaMean(framesA) - lumaMean(framesB))) < 1e-12);

  const dir = mkdtempSync(join(tmpdir(), 'welch-'));
  try {
    const paths = framesB.map((frame, i) => {
      const file = join(dir, `b${i}.exr`);
      writeFileSync(file, toExr(frame, ''));
      return file;
    });
    // A 边同时带 color.R/G/B 和数值乘了 3 的裸 R/G/B：结果与帧对象一致，说明取的是 color.*
    const viaExr = verify.welchTest(framesA.map(f => toExr(f, 'color.')), paths, { blockSize: 8 });
    assert.deepEqual([...viaExr.pMap], [...reference.pMap]);
    assert.deepEqual([...viaExr.biasMap], [...reference.biasMap]);
  } finally {
    rmSync(dir, { recursive: true });
  }

  // 按通道序号检验：只动红色时，红通道检出而蓝通道不受影响
  const red = renderNoisyGroup(16, 16, 16, 5);
  const redder = renderNoisyGroup(16, 16, 16, 5).map(f => ({ ...f, data: f.data.map((v, i) => (i % 3 === 0 ? v * 1.1 : v)) }));
  assert.equal(verify.welchTest(red, redder, { channel: 0 }).significantRatio, 1);
  assert.equal(verify.welchTest(red, redder, { channel: 2 }).significantCount, 0);
});

test('V18-7 非法输入一律抛错', () => {
  const frame = (width = 2, height = 2, fill = 0.5) => ({ width, height, data: new Float32Array(width * height).fill(fill) });
  const pair = [frame(), frame()];
  assert.throws(() => verify.welchTest([frame()], pair), /至少要 2 个/);
  assert.throws(() => verify.welchTest(pair, 'not-a-group'), /至少要 2 个/);
  assert.throws(() => verify.welchTest(pair, [frame(), frame(3, 2)]), /尺寸不一致/);
  assert.throws(() => verify.welchTest(pair, [frame(), frame(2, 3)]), /尺寸不一致/);
  assert.throws(() => verify.welchTest(pair, [frame(), frame(2, 2, NaN)]), /非有限值/);
  assert.throws(() => verify.welchTest(pair, [frame(), frame(2, 2, Infinity)]), /非有限值/);
  assert.throws(() => verify.welchTest(pair, [frame(), { width: 2, height: 2, data: new Float32Array(5) }]), /数据长度/);
  assert.throws(() => verify.welchTest(pair, [frame(), { width: 2, height: 2, channels: 3, data: new Float32Array(4) }]), /数据长度/);
  assert.throws(() => verify.welchTest(pair, [frame(), { width: 0, height: 2, data: new Float32Array(0) }]), /无效尺寸/);
  assert.throws(() => verify.welchTest(pair, [frame(), null]), /样本须为/);
  assert.throws(() => verify.welchTest(pair, pair, { channel: 1 }), /无效通道/);
  for (const options of [{ alpha: 0 }, { alpha: 1 }, { alpha: NaN }, { histogramAlpha: 2 }, { blockSize: 0 }, { blockSize: 1.5 }, { bins: 0 }]) {
    assert.throws(() => verify.welchTest(pair, pair, options), /welch/, JSON.stringify(options));
  }
  assert.throws(() => verify.welchTest(pair, [frame(), Buffer.from('not an exr file')]), /EXR/);
  assert.throws(() => verify.welchTest(pair, [frame(), { width: 2, height: 2, channels: { 'normal.X': new Float32Array(4), 'normal.Y': new Float32Array(4) } }]), /EXR 须含/);
});

test('V18-8 两边种子数不等抛 RangeError；大自由度切正态渐近', () => {
  const f = v => ({ width: 2, height: 2, channels: 1, data: new Float32Array([v, v + 0.1, v + 0.2, v + 0.3]) });
  assert.throws(() => verify.welchTest([f(1), f(1.1), f(0.9), f(1.05)], [f(1), f(1.1), f(0.9)]), RangeError);
  for (const df of [1.0000001e7, 1e12, 1e15, Infinity]) {
    const p = verify.studentTwoSidedP(1.959963984540054, df);
    assert.ok(Math.abs(p - 0.05) < 1e-8, `df=${df}: ${p}`);
  }
  // 正态尾部对照 erfc 的已知值（相对误差）
  for (const [x, expected] of [[0.5, 0.4795001221869535], [1, 0.15729920705028513], [3, 2.209049699858544e-5], [5, 1.5374597944280349e-12]]) {
    assert.ok(Math.abs(verify.studentTwoSidedP(x * Math.SQRT2, Infinity) / expected - 1) < 1e-12, `erfc(${x})`);
  }
  assert.equal(verify.studentTwoSidedP(0, Infinity), 1);
  for (const [t, df] of [[null, 7], [undefined, 7], ['2', 7], [2, '7'], [2, null], [2, undefined], [2, 0], [2, NaN]]) {
    assert.throws(() => verify.studentTwoSidedP(t, df), /welch/, `t=${t} df=${df}`);
  }
});

// 每个像素一个单元：A 边第 i 个种子取 base[i] + shift[x]，B 边取 base[i]；shift 为 null 的单元两边恒为 0.5（无噪声）。
function shiftedGroups(base, shifts) {
  const side = sign => base.map(b => ({ width: shifts.length, height: 1, data: Float32Array.from(shifts, d => (d === null ? 0.5 : b + sign * d)) }));
  return [side(1), side(0)];
}

test('V18-9 pass 的两个条件各自独立起作用；比例的分母是 testedUnits', () => {
  // 三成单元 p 约 0.04：BH 一个都不拒（第 30 小的 p 要过 0.015），但小 p 明显堆高，平坦性不过
  const piled = verify.welchTest(...shiftedGroups([0, 1, 2, 3], Array.from({ length: 100 }, (_, x) => (x < 30 ? 2.375 : 0.125))));
  assert.ok(piled.pMap[0] > 0.015 && piled.pMap[0] < 0.05 && piled.pMap[99] > 0.5, `${piled.pMap[0]} ${piled.pMap[99]}`);
  assert.equal(piled.pMap.reduce((count, p) => count + (p <= 0.05 ? 1 : 0), 0), 30);
  assert.equal(piled.rawSignificantRatio, 0.3);
  assert.deepEqual([piled.significantCount, piled.significantRatio, piled.pHistogram.flat, piled.pass], [0, 0, false, false]);

  // 十个带噪单元里一个强偏，另有六个无噪单元：平坦性过，BH 比例 1/10 超过 alpha，判不过
  const strong = verify.welchTest(...shiftedGroups([0, 1, 2, 3], [64, ...new Array(9).fill(0.125), ...new Array(6).fill(null)]));
  assert.deepEqual([strong.totalUnits, strong.testedUnits, strong.deterministicUnits, strong.significantCount], [16, 10, 6, 1]);
  assert.ok(strong.testedUnits < strong.totalUnits);
  assert.equal(strong.significantRatio, strong.significantCount / strong.testedUnits);
  assert.equal(strong.rawSignificantRatio, 1 / 10);
  assert.deepEqual([strong.pHistogram.flat, strong.pass], [true, false]);
  assert.deepEqual([...strong.significantMask], [1, ...new Array(15).fill(0)]);
});

test('V18-10 直方图分桶向下取整；BH 贴线判显著', () => {
  // K=2 且两边方差相等时自由度恰为 2，p 有闭式 1 - t / sqrt(2 + t^2)；t = sqrt(2) 时 p = 1 - sqrt(1/2)，约 0.2929
  const res = verify.welchTest(...shiftedGroups([0, 1], [1, 0]));
  assert.ok(Math.abs(res.pMap[0] - (1 - Math.SQRT1_2)) < 1e-12, `p=${res.pMap[0]}`);
  assert.equal(res.pMap[1], 1);
  assert.deepEqual([res.pHistogram.counts[5], res.pHistogram.counts[19], res.pHistogram.counts[6]], [1, 1, 0]);
  assert.equal(verify.welchTest(...shiftedGroups([0, 1], [1, 0]), { bins: 10 }).pHistogram.counts[2], 1);

  const edge = verify.benjaminiHochberg([0.25, 0.5], 0.5);
  assert.deepEqual([[...edge.qValues], [...edge.significant], edge.significantCount], [[0.5, 0.5], [1, 1], 2]);
});

test('V18-11 通道选择不猜、两边形态一致、参数类型校验', () => {
  const plane = fill => new Float32Array(4).fill(fill);
  const exr = (names, fill) => ({ width: 2, height: 2, channels: Object.fromEntries(names.map((name, i) => [name, plane(fill + i)])) });
  const normals = ['normal.X', 'normal.Y', 'normal.Z'];
  // 恰好三个浮点通道但不是颜色：不当成 RGB
  assert.throws(() => verify.welchTest([exr(normals, 0), exr(normals, 1)], [exr(normals, 0), exr(normals, 1)]), /EXR 须含/);
  // 显式给通道名就能检
  const named = verify.welchTest([exr(normals, 0), exr(normals, 2)], [exr(normals, 0), exr(normals, 1)], { channel: 'normal.Y' });
  assert.equal(named.biasMap[0], 0.5);
  assert.throws(() => verify.welchTest([exr(normals, 0), exr(normals, 1)], [exr(normals, 0), exr(normals, 1)], { channel: 'depth.Z' }), /没有浮点通道/);
  // 一边三通道取亮度、一边单通道：不比
  const rgb = { width: 2, height: 2, channels: 3, data: new Float32Array(12).fill(0.5) };
  const mono = { width: 2, height: 2, data: plane(0.5) };
  assert.throws(() => verify.welchTest([rgb, rgb], [mono, mono]), /通道形态/);
  assert.throws(() => verify.welchTest([exr(['R', 'G', 'B'], 0), exr(['R', 'G', 'B'], 0)], [exr(['depth.Z'], 0), exr(['depth.Z'], 0)]), /通道形态/);

  const pair = [mono, mono];
  for (const options of [null, [], 'fast', 5, new Map(), { alpha: '0.05' }, { alpha: null }, { alpha: Infinity }, { histogramAlpha: '0.001' }, { bins: 10001 }, { bins: '20' }, { blockSize: '8' }]) {
    assert.throws(() => verify.welchTest(pair, pair, options), /welch/, JSON.stringify(options));
  }
  assert.equal(verify.welchTest(pair, pair, { bins: 10000 }).pHistogram.counts.length, 10000);
  assert.equal(verify.welchTest(pair, pair, Object.create(null)).pass, true);

  for (const pValues of [[0.5, null], ['0.5'], [0.5, Infinity], [undefined], '0.5', null, { length: 1, 0: 0.5 }]) {
    assert.throws(() => verify.benjaminiHochberg(pValues), /welch/, JSON.stringify(pValues));
  }
  assert.throws(() => verify.benjaminiHochberg([0.5], '0.5'), /alpha/);
  assert.equal(verify.benjaminiHochberg(Float64Array.of(0.001, 0.9)).significantCount, 1);
});

test('V18-12 拒绝含空洞的稀疏数组（种子组、p 值、帧 data）', () => {
  const f = (v) => ({ width: 1, height: 1, channels: 1, data: new Float32Array([v]) });
  const sparse = new Array(2);
  sparse[1] = f(1);
  assert.throws(() => verify.welchTest(sparse, [f(1), f(2)]), TypeError);
  assert.throws(() => verify.welchTest([f(1), f(2)], sparse), TypeError);
  // eslint-disable-next-line no-sparse-arrays
  assert.throws(() => verify.benjaminiHochberg([0.01, , 0.5]), TypeError);
  const holed = { width: 2, height: 1, channels: 1, data: new Array(2) };
  holed.data[0] = 1;
  assert.throws(() => verify.welchTest([holed, f(1)], [f(1), f(2)]), TypeError);
});

test('V18-13 raw 计数在 p === alpha 处是闭区间（杀 M39）', () => {
  const f = (v) => ({ width: 1, height: 1, channels: 1, data: new Float32Array([v]) });
  // 均值 0 对 2、方差各 2：t = -sqrt(2)，自由度 2，p = 1 - 1/sqrt(2)。
  const a = [f(-1), f(1)];
  const b = [f(1), f(3)];
  const probe = verify.welchTest(a, b);
  const p0 = probe.pMap[0];
  assert.ok(Math.abs(p0 - (1 - Math.SQRT1_2)) < 1e-12);
  assert.ok(Math.abs(verify.studentTwoSidedP(Math.SQRT2, 2) - p0) < 1e-12);
  assert.equal(probe.rawSignificantRatio, 0);
  assert.equal(probe.pass, true);
  const boundary = verify.welchTest(a, b, { alpha: p0 });
  assert.equal(boundary.rawSignificantRatio, 1);
  assert.equal(boundary.pass, false);
});

test('V18-14 空洞检查先于长度检查，全部帧先校验完再统计', () => {
  const f = v => ({ width: 2, height: 1, channels: 1, data: new Float32Array([v, v]) });
  const pair = [f(1), f(2)];
  // 单槽稀疏数组：不能落到「至少要 2 个」的普通 Error
  assert.throws(() => verify.welchTest(new Array(1), pair), TypeError);
  assert.throws(() => verify.welchTest(pair, new Array(1)), TypeError);
  assert.throws(() => verify.benjaminiHochberg(new Array(1)), TypeError);
  // data 又有空洞又长度不对：空洞优先
  const sparse = new Array(3);
  sparse[0] = 1;
  assert.throws(() => verify.welchTest([f(1), { width: 2, height: 1, channels: 1, data: sparse }], pair), TypeError);
  // B 组第一帧尺寸就对不上，但最后一帧含空洞：全部帧先解析，所以先报空洞
  const holey = [1, 1];
  delete holey[1];
  const wide = { width: 3, height: 1, channels: 1, data: new Float32Array(3) };
  assert.throws(() => verify.welchTest(pair, [wide, { width: 2, height: 1, channels: 1, data: holey }]), TypeError);
});

test('V18-15 G_REV-R4 原始样本严格为有限 number（拒 null/字符串/未选通道 NaN）且防恶意 getter 篡改帧列表', () => {
  const f = (v) => ({ width: 2, height: 1, channels: 1, data: new Float32Array([v, v]) });
  const pair0 = [f(0), f(0)];
  const pair1 = [f(1), f(1)];
  // 1) 普通数组含 null 或字符串、或 data 本身是字符串
  assert.throws(() => verify.welchTest(pair0, [f(0), { width: 2, height: 1, channels: 1, data: [0, null] }]), TypeError);
  assert.throws(() => verify.welchTest(pair1, [f(1), { width: 2, height: 1, channels: 1, data: [1, '1'] }]), TypeError);
  assert.throws(() => verify.welchTest(pair1, [f(1), { width: 2, height: 1, channels: 1, data: '11' }]), TypeError);
  // 2) 未参与聚合的其他通道含 NaN / Infinity 也在预校验拒绝
  const rgbA = () => ({ width: 1, height: 1, channels: 3, data: new Float32Array([1, 2, 3]) });
  const rgbBadG = { width: 1, height: 1, channels: 3, data: new Float32Array([1, NaN, 3]) };
  assert.throws(() => verify.welchTest([rgbA(), rgbA()], [rgbA(), rgbBadG], { channel: 0 }), RangeError);
  const rgbaA = () => ({ width: 1, height: 1, channels: 4, data: new Float32Array([1, 1, 1, 1]) });
  const rgbaBadAlpha = { width: 1, height: 1, channels: 4, data: new Float32Array([1, 1, 1, Infinity]) };
  assert.throws(() => verify.welchTest([rgbaA(), rgbaA()], [rgbaA(), rgbaBadAlpha]), RangeError);
  // 3) 恶意 getter 在读取第 0 帧时删掉 B[1] 或缩短 B 长度
  // eslint-disable-next-line no-sparse-arrays
  const mutB = [, f(0)];
  Object.defineProperty(mutB, 0, {
    enumerable: true,
    configurable: true,
    get() {
      delete mutB[1];
      return f(0);
    },
  });
  assert.throws(() => verify.welchTest(pair0, mutB), TypeError);
  // 读取第 0 帧时往组里多塞一帧：长度变了也拒绝
  const growB = [null, f(0)];
  Object.defineProperty(growB, 0, { enumerable: true, get() { growB.push(f(0)); return f(0); } });
  assert.throws(() => verify.welchTest(pair0, growB), RangeError);
  // 4) 帧、data 元素、p 值各只读一次：第二次读会变值的 getter 骗不到统计
  let reads = 0;
  const once = (list, i, value) => Object.defineProperty(list, i, { enumerable: true, get() { reads++; return value; } });
  const frames = once([null, f(3)], 0, f(1));
  const data = once([null, 1], 0, 1);
  const clean = verify.welchTest(frames, once([null, { width: 2, height: 1, channels: 1, data }], 0, f(1)));
  assert.equal(reads, 3);
  assert.deepEqual([...clean.biasMap], [1, 1]);
  reads = 0;
  assert.equal(verify.benjaminiHochberg(once([null, 0.5], 0, 0.01)).significantCount, 1);
  assert.equal(reads, 1);
  // EXR 形态的通道属性也只读一次（只有 R 时它会先按 RGB 探一次、再按唯一通道用一次）
  reads = 0;
  const exr = () => ({ width: 2, height: 1, channels: Object.defineProperty({}, 'R', { enumerable: true, get() { reads++; return new Float32Array(2); } }) });
  assert.equal(verify.welchTest([exr(), exr()], pair0).deterministicUnits, 2);
  assert.equal(reads, 2);
  // DataView 有 byteLength 没有元素，不能当 data
  assert.throws(() => verify.welchTest(pair0, [f(0), { width: 2, height: 1, channels: 1, data: new DataView(new ArrayBuffer(2)) }]), TypeError);
});

test('V18-16 G_REV-R5 杀灭 M33（EXR 选中通道含 Infinity 在统计前抛 RangeError）且防跨阶段 getter 篡改已复制种子组', async () => {
  const { writeExr } = await import('./exr/exr.mjs');
  const okExr = writeExr({
    width: 2, height: 1, compression: 2,
    channels: { R: new Float32Array([0.2, 0.4]), 'depth.Z': new Float32Array([5, 6]) },
  });
  const infExr = writeExr({
    width: 2, height: 1, compression: 2,
    channels: { R: new Float32Array([0.2, 0.4]), 'depth.Z': new Float32Array([5, Infinity]) },
  });
  assert.throws(() => verify.welchTest([okExr, okExr], [okExr, infExr], { channel: 'depth.Z' }), RangeError);

  const f = (v) => ({ width: 2, height: 1, channels: 1, data: new Float32Array([v, v + 0.5]) });
  // 1) 入口时 A 有 3 帧、B 有 4 帧，读取 A[0] 时把 B 缩成 3 帧：必须在统计前抛 RangeError
  const b4 = [f(1), f(2), f(3), f(99)];
  const a3 = [null, f(1), f(2)];
  Object.defineProperty(a3, 0, { enumerable: true, get() { b4.length = 3; return f(1); } });
  assert.throws(() => verify.welchTest(a3, b4), RangeError);

  // 2) 初始 3 对 3，A 末帧 data getter 把已复制的 B 缩至 2 帧：必须在统计前拒绝
  const bShrink = [f(1), f(2), f(3)];
  const aLate = [f(1), f(2), { width: 2, height: 1, channels: 1 }];
  Object.defineProperty(aLate[2], 'data', { enumerable: true, get() { bShrink.length = 2; return new Float32Array([3, 3.5]); } });
  assert.throws(() => verify.welchTest(aLate, bShrink), RangeError);

  // 2b) 入口 3 对 4，A[0] 把 B 缩成 3 帧，A 末帧 data getter 再补回 4 帧：种子数按入口长度判，仍抛 RangeError
  const bBack = [f(1), f(2), f(3), f(99)];
  const aBack = [null, f(2), { width: 2, height: 1, channels: 1 }];
  Object.defineProperty(aBack, 0, { enumerable: true, get() { bBack.length = 3; return f(1); } });
  Object.defineProperty(aBack[2], 'data', { enumerable: true, get() { bBack.push(f(99)); return new Float32Array([3, 3.5]); } });
  assert.throws(() => verify.welchTest(aBack, bBack), RangeError);

  // 3) 初始 3 对 3，A 末帧像素 getter 删除 B[1]：必须在统计前抛 TypeError
  const bHole = [f(1), f(2), f(3)];
  const pixArr = [null, 3.5];
  Object.defineProperty(pixArr, 0, { enumerable: true, get() { delete bHole[1]; return 3; } });
  assert.throws(() => verify.welchTest([f(1), f(2), { width: 2, height: 1, channels: 1, data: pixArr }], bHole), TypeError);
});

test('V18-17 G_REV-R6 入口等 K (3 对 3) 下读取 A[0] 把 B 缩至 2 再在平面阶段补回 3 帧，快照长度与入口不一致必须在统计前拒绝', () => {
  const f = (v) => ({ width: 2, height: 1, channels: 1, data: new Float32Array([v, v + 0.5]) });
  let readsB = 0;
  const b3 = Object.defineProperty([null, f(2), f(NaN)], 0, { enumerable: true, configurable: true, get() { readsB++; return f(1); } });
  const a3 = [null, f(2), { width: 2, height: 1, channels: 1 }];
  Object.defineProperty(a3, 0, { enumerable: true, get() { b3.length = 2; return f(1); } });
  Object.defineProperty(a3[2], 'data', { enumerable: true, get() { b3.push(f(3)); return new Float32Array([3, 3.5]); } });
  assert.throws(() => verify.welchTest(a3, b3), RangeError);
  assert.equal(b3.length, 2); // 在平面阶段之前就拒了，补回 3 帧的 data getter 没机会跑
  assert.equal(readsB, 0); // 而且是在读 B 的任何一帧之前

  // A[0] 把 B 清空：读 B 之前就按入口长度拒（RangeError），不落到「第 0 项是空洞」的 TypeError
  const bGone = [f(1), f(2)];
  const aWipe = [null, f(2)];
  Object.defineProperty(aWipe, 0, { enumerable: true, get() { bGone.length = 0; return f(1); } });
  assert.throws(() => verify.welchTest(aWipe, bGone), RangeError);

  // 平面阶段内改短又补回：A[0] 的 data getter 把 B 缩成 2 帧、A[1] 的再补回 3 帧，每帧解析完都复查，当场拒
  const bFlip = [f(1), f(2), f(3)];
  const lazy = (effect, v) => Object.defineProperty({ width: 2, height: 1, channels: 1 }, 'data', {
    enumerable: true, get() { effect(); return new Float32Array([v, v + 0.5]); },
  });
  const aFlip = [lazy(() => { bFlip.length = 2; }, 1), lazy(() => { bFlip.push(f(3)); }, 2), f(3)];
  assert.throws(() => verify.welchTest(aFlip, bFlip), RangeError);
  assert.equal(bFlip.length, 2);

  // 帧的 data 普通数组读到一半被自己的 getter 加长：没有种子组复查兜底，靠快照自己的读后检查拒
  const dataGrow = [null, 1.5];
  Object.defineProperty(dataGrow, 0, { enumerable: true, get() { dataGrow.push(9); return 1; } });
  assert.throws(() => verify.welchTest([f(1), f(2)], [f(1), { width: 2, height: 1, channels: 1, data: dataGrow }]), RangeError);

  // 读 B[0] 时删掉已拍完快照的 A[1]：解析任何帧之前就抛 TypeError，轮不到 A[0] 的「无效尺寸」普通 Error
  const aCut = [{ width: 0, height: 1, channels: 1, data: new Float32Array(0) }, f(2)];
  const bCut = [null, f(2)];
  Object.defineProperty(bCut, 0, { enumerable: true, get() { delete aCut[1]; return f(1); } });
  assert.throws(() => verify.welchTest(aCut, bCut), TypeError);
});

test('V18-18 G_REV-R7 调用入口首行即锁死原始整数 K（防 options.alpha getter 提前缩组与 Proxy 非数值 length）', () => {
  const f = (v) => ({ width: 2, height: 1, channels: 1, data: new Float32Array([v, v + 0.5]) });
  // 1) 调用时 3 对 4，options.alpha getter 把 B 缩至 3：仍必须按调用入口 3 对 4 抛 RangeError
  const b4 = [f(1), f(2), f(3), f(NaN)];
  const opts = Object.defineProperty({}, 'alpha', {
    enumerable: true,
    get() { b4.length = 3; return 0.05; },
  });
  assert.throws(() => verify.welchTest([f(1), f(2), f(3)], b4, opts), RangeError);

  // 2) Array Proxy 让 .length 返回包装对象欺骗 === 比较：首行检查原始安全整数 length，直接抛 TypeError
  let cur = 3;
  const fakeLen = { valueOf() { return cur; } };
  const makeProxy = (arr, n) => new Proxy(arr, {
    get(target, prop, receiver) {
      if (prop === 'length') { cur = n; return fakeLen; }
      return Reflect.get(target, prop, receiver);
    },
  });
  assert.throws(() => verify.welchTest(makeProxy([f(0), f(1), f(2)], 3), makeProxy([f(1), f(3)], 2)), TypeError);

  // 3) length 须是原始非负安全整数：负数、小数、超安全整数、字符串、包装对象都按同一条理由拒（种子组、p 值、帧 data 同理）
  const lengthIs = (arr, length) => new Proxy(arr, { get: (t, p, r) => (p === 'length' ? length : Reflect.get(t, p, r)) });
  const badLength = { name: 'TypeError', message: /length 须为非负安全整数/ };
  for (const length of [-1, 2.5, 2 ** 53, '3', new Number(3)]) {
    assert.throws(() => verify.welchTest(lengthIs([f(0), f(1), f(2)], length), [f(1), f(2), f(3)]), badLength);
    assert.throws(() => verify.welchTest([f(1), f(2), f(3)], lengthIs([f(0), f(1), f(2)], length)), badLength);
  }
  assert.throws(() => verify.benjaminiHochberg(lengthIs([0.1, 0.2], { valueOf: () => 2 })), badLength);
  assert.throws(() => verify.welchTest([{ width: 2, height: 1, data: lengthIs([1, 2], { valueOf: () => 2 }) }, f(1)], [f(1), f(2)]), badLength);

  // 4) 读完 options 立即复查：等 K 的 3 对 3 里 options getter 把 B 缩成 2 帧、A[0] 的 getter 再补回 3 帧，拍快照前就得拒
  const bSwap = [f(1), f(2), f(3)];
  const aRestore = [null, f(2), f(3)];
  Object.defineProperty(aRestore, 0, { enumerable: true, get() { bSwap.push(f(9)); return f(1); } });
  const shrink = Object.defineProperty({}, 'blockSize', { enumerable: true, get() { bSwap.length = 2; return 1; } });
  assert.throws(() => verify.welchTest(aRestore, bSwap, shrink), RangeError);
  assert.equal(bSwap.length, 2, 'A[0] 的 getter 不该被读到');

  // 5) 正常输入不受影响：kA、kB 都等于入口种子数
  const ok = verify.welchTest([f(1), f(2), f(3)], [f(1), f(2), f(3)]);
  assert.deepEqual([ok.kA, ok.kB], [3, 3]);
});

test('V18-19 G_REV-R9 稠密种子组不足 2 统一抛 RangeError，且 options 连续属性 getter 先缩组后补回时仍被拦截', () => {
  const f = (v) => ({ width: 2, height: 1, channels: 1, data: new Float32Array([v, v + 0.5]) });
  // 1) 稠密 0/0、1/1、1/2、2/1 一律抛 RangeError；单槽稀疏 new Array(1) 仍优先抛 TypeError
  for (const [a, b] of [[[], []], [[f(1)], [f(1)]], [[f(1)], [f(1), f(2)]], [[f(1), f(2)], [f(1)]]]) {
    assert.throws(() => verify.welchTest(a, b), RangeError);
  }
  assert.throws(() => verify.welchTest(new Array(1), [f(1), f(2)]), TypeError);

  // 2) options.alpha 把 B（含末帧 NaN）从 3 缩到 2，options.blockSize 再 push 有限帧补回 3：必须在快照与逐配置读取复查中抛 RangeError
  const b3 = [f(1), f(2), f(NaN)];
  const opts = {};
  Object.defineProperty(opts, 'alpha', { enumerable: true, get() { b3.length = 2; return 0.05; } });
  Object.defineProperty(opts, 'blockSize', { enumerable: true, get() { b3.push(f(3)); return 1; } });
  assert.throws(() => verify.welchTest([f(1), f(2), f(3)], b3, opts), RangeError);
  assert.equal(b3.length, 2, '读完 alpha 就该拒，blockSize 的 getter 不该被读到');

  // 3) 不改长度、原地把 B 的 NaN 末帧换成有限帧：options 的 getter 换、A[0] 的 getter 换，都按入口槽位判，当场拒
  const swapped = { name: 'RangeError', message: /被换了/ };
  const bOpt = [f(1), f(2), f(NaN)];
  const swapOpt = Object.defineProperty({}, 'alpha', { enumerable: true, get() { bOpt[2] = f(3); return 0.05; } });
  assert.throws(() => verify.welchTest([f(1), f(2), f(3)], bOpt, swapOpt), swapped);
  const bElem = [f(1), f(2), f(NaN)];
  const aSwap = Object.defineProperty([null, f(2), f(3)], 0, { enumerable: true, get() { bElem[2] = f(3); return f(1); } });
  assert.throws(() => verify.welchTest(aSwap, bElem), swapped);

  // 4) B[0] 的 getter 把 B[2] 临时换成「读一次就还原」的 getter：读完后槽位与入口一模一样，统计仍须用入口的 NaN 帧
  const nanFrame = f(NaN);
  const bTemp = [null, f(2), nanFrame];
  Object.defineProperty(bTemp, 0, {
    enumerable: true,
    get() {
      Object.defineProperty(bTemp, 2, {
        configurable: true,
        get() {
          Object.defineProperty(bTemp, 2, { value: nanFrame, writable: true, enumerable: true, configurable: true });
          return f(3);
        },
      });
      return f(1);
    },
  });
  assert.throws(() => verify.welchTest([f(1), f(2), f(3)], bTemp), RangeError);

  // 5) 正常的 getter 槽位不受影响：只读一次，数据槽位不经 getter
  let reads = 0;
  const lazyA = Object.defineProperty([null, f(2), f(3)], 0, { enumerable: true, get() { reads++; return f(1); } });
  assert.equal(verify.welchTest(lazyA, [f(1), f(2), f(3)]).kA, 3);
  assert.equal(reads, 1);
});
