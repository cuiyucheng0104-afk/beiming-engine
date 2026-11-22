// O6 单测（Red -> Green）：observe/compare（<=500 token 差值表）与 observe/align（切点对齐、1.009 拉伸比求解、7 参数相机拟合 <=500 token）及 O5 二阶收敛
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeTracks } from '../kernel/eval/tracks.mjs';
import full from '../kernel/contracts/meta/examples/full.json' with { type: 'json' };
import * as observe from './index.mjs';
import { estimateTokens, withinBudget } from './query.mjs';

test('O6-1 compare: 两张已知差图的 PSNR/SSIM/色差/颗粒/亮度分位差值表与容差判定准确，且 <= 500 token', () => {
  assert.equal(typeof observe.compare, 'function', 'observe 应导出 compare');
  assert.equal('runFfmpeg' in observe, false, 'observe 顶层不应暴露内部辅助函数 runFfmpeg');

  const w = 32;
  const h = 32;
  const rgbA = new Uint8Array(w * h * 3);
  const rgbB = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const x = i % w;
    const y = Math.floor(i / w);
    const base = x < 16 ? 60 : 180;
    rgbA[i * 3] = base;
    rgbA[i * 3 + 1] = y < 16 ? 80 : 160;
    rgbA[i * 3 + 2] = 100;
    // B 图每个通道恒差 +4 级 -> MSE = 16 -> PSNR = 10*log10(65025/16) = 36.0896 dB，maxDiff = 4，fracAbove2 = 1
    rgbB[i * 3] = base + 4;
    rgbB[i * 3 + 1] = rgbA[i * 3 + 1] + 4;
    rgbB[i * 3 + 2] = 104;
  }

  const sameRes = observe.compare({ width: w, height: h, rgb: rgbA }, { width: w, height: h, rgb: rgbA });
  assert.equal(sameRes.ok, true);
  assert.equal(sameRes.identical, true);
  assert.equal(sameRes.pass, true);

  const diffRes = observe.compare(
    { width: w, height: h, rgb: rgbA },
    { width: w, height: h, rgb: rgbB },
    { tolerance: { psnrMin: 35, maxDiff: 5, ssimMin: 0.95 } },
  );
  assert.equal(diffRes.ok, true, JSON.stringify(diffRes));
  assert.equal(diffRes.identical, false);
  assert.equal(diffRes.pass, true);
  const psnrRow = diffRes.rows.find((r) => r.metric === 'psnr');
  const maxDiffRow = diffRes.rows.find((r) => r.metric === 'maxDiff');
  assert.ok(psnrRow && Math.abs(psnrRow.value - 36.09) < 0.05, `PSNR 期望约 36.09，实得 ${JSON.stringify(psnrRow)}`);
  assert.equal(maxDiffRow?.value, 4);

  const failRes = observe.compare(
    { width: w, height: h, rgb: rgbA },
    { width: w, height: h, rgb: rgbB },
    { tolerance: { psnrMin: 42 } },
  );
  assert.equal(failRes.ok, true);
  assert.equal(failRes.pass, false);

  const json = JSON.stringify(diffRes);
  assert.ok(withinBudget(json, 500), `compare 预算超限：tokens=${estimateTokens(json)}`);
});

test('O6-2 align: 05-1 参考包络精确读出拉伸比 1.009 与偏移 5.48s，切点对齐准确，且 <= 500 token', () => {
  assert.equal(typeof observe.align, 'function', 'observe 应导出 align');

  // 构造 20ms 步长（50 Hz）的非周期脉冲包络：track 长 12 秒（600 点），成片将它放慢 1.009 倍并从 5.48 秒（第 274 点）切入
  const stepSec = 0.02;
  const trackLen = 600;
  const trackEnvelope = new Array(trackLen).fill(0.05);
  const beatIndices = [15, 58, 113, 179, 241, 312, 389, 455, 523, 577];
  for (const idx of beatIndices) {
    for (let d = -4; d <= 4; d++) {
      if (idx + d >= 0 && idx + d < trackLen) {
        trackEnvelope[idx + d] += Math.exp(-(d * d) / 4) * (1 + (idx % 3) * 0.3);
      }
    }
  }

  const trueStretch = 1.009;
  const trueOffsetIdx = 274; // 5.48 s
  const filmLen = 1100; // 22 s
  const filmEnvelope = new Array(filmLen).fill(0.05);
  for (let j = trueOffsetIdx; j < filmLen; j++) {
    const k = (j - trueOffsetIdx) / trueStretch;
    const k0 = Math.floor(k);
    if (k0 + 1 < trackLen) {
      const frac = k - k0;
      filmEnvelope[j] = trackEnvelope[k0] * (1 - frac) + trackEnvelope[k0 + 1] * frac;
    }
  }

  const res = observe.align({
    cuts: { reference: [24, 72, 120, 180], actual: [24, 74, 180, 210], maxDeltaFrames: 3 },
    stretch: { filmEnvelope, trackEnvelope, stepSec, fps: 24, stretchRange: [0.99, 1.03], stretchStep: 0.001, maxOffsetSec: 8.0 },
  });

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.stretch.stretch, 1.009, `拉伸比应精确读出 1.009，实得 ${JSON.stringify(res.stretch)}`);
  assert.ok(Math.abs(res.stretch.offsetSec - 5.48) <= 0.021, `偏移应约 5.48s，实得 ${res.stretch.offsetSec}`);
  assert.equal(res.stretch.reliable, true);
  assert.deepEqual(res.cuts.missed, [120]);
  assert.deepEqual(res.cuts.extra, [210]);

  const json = JSON.stringify(res);
  assert.ok(withinBudget(json, 500), `align 预算超限：tokens=${estimateTokens(json)}`);
});

test('O6-3 align: 7 参数最小二乘相机拟合（pos[3] + rot[3] + fovY）对非共面三维点重投影误差 < 0.5 px', () => {
  const width = 1920;
  const height = 1080;
  const aspect = width / height;
  const truePos = [1.8, 1.2, 3.4];
  const trueTarget = [0.0, 0.3, 0.0];
  const trueFovY = 32.0;

  // 右手系 lookAt 构造真值相机投影
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };

  const zAxis = norm(sub(truePos, trueTarget)); // 相机 +Z 朝后（视线为 -Z）
  const xAxis = norm(cross([0, 1, 0], zAxis));
  const yAxis = cross(zAxis, xAxis);
  const f = 1 / Math.tan((trueFovY * Math.PI) / 360);

  const worldPts = [
    [-0.4, 0.0, -0.3],
    [0.45, 0.0, -0.25],
    [-0.35, 0.65, 0.2],
    [0.4, 0.6, 0.3],
    [0.0, 0.3, 0.0],
    [-0.2, 0.15, 0.45],
    [0.25, 0.45, -0.4],
  ];
  const points = worldPts.map((w) => {
    const d = sub(w, truePos);
    const cx = dot(d, xAxis);
    const cy = dot(d, yAxis);
    const cz = dot(d, zAxis); // 视线前方 cz < 0
    const ndcX = (cx * (f / aspect)) / -cz;
    const ndcY = (cy * f) / -cz;
    return {
      world: w,
      screen: [(ndcX * 0.5 + 0.5) * width, (0.5 - ndcY * 0.5) * height],
    };
  });

  const res = observe.align({
    camera: { points, size: [width, height] },
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(res.camera.rmsePx < 0.5, `7 参数相机拟合重投影 RMSE 应 < 0.5 px，实得 ${JSON.stringify(res.camera)}`);
  assert.ok(Math.hypot(res.camera.pos[0] - truePos[0], res.camera.pos[1] - truePos[1], res.camera.pos[2] - truePos[2]) < 0.05);
  assert.ok(Math.abs(res.camera.fovY - trueFovY) < 1.0);
  assert.ok(withinBudget(JSON.stringify(res), 500));
});

test('O6-4 compare: PNG 路径、差异热图、亮度分位差、尺寸不匹配与非法输入', () => {
  const dir = mkdtempSync(join(tmpdir(), 'o6-cmp-'));
  try {
    const w = 32, h = 18;
    const rgbA = new Uint8Array(w * h * 3).fill(51); // luma = 51/255 = 0.2
    const rgbB = new Uint8Array(w * h * 3).fill(153); // luma = 153/255 = 0.6
    const pA = join(dir, 'a.png');
    const pB = join(dir, 'b.png');
    const hm = join(dir, 'sub', 'heat.png');
    writeFileSync(pA, observe.encodePng({ width: w, height: h, rgb: rgbA }));
    writeFileSync(pB, observe.encodePng({ width: w, height: h, rgb: rgbB }));

    const r = observe.compare(pA, pB, { heatmapPath: hm, tolerance: { maxLumaP50Diff: 0.5 } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.pass, true);
    assert.equal(existsSync(hm), true);
    const decodedHm = observe.decodePng(readFileSync(hm));
    assert.deepEqual([decodedHm.width, decodedHm.height], [w, h]);
    const p50 = r.rows.find((row) => row.metric === 'lumaP50');
    assert.ok(p50 && Math.abs(p50.a - 0.2) < 1e-3 && Math.abs(p50.b - 0.6) < 1e-3 && Math.abs(p50.diff - 0.4) < 1e-3);
    assert.ok(withinBudget(JSON.stringify(r), 500));

    // 尺寸不匹配
    const mismatch = observe.compare(
      { width: 8, height: 8, rgb: new Uint8Array(8 * 8 * 3) },
      { width: 10, height: 8, rgb: new Uint8Array(10 * 8 * 3) },
    );
    assert.equal(mismatch.ok, true);
    assert.equal(mismatch.sizeMismatch, true);
    assert.equal(mismatch.pass, false);
    assert.ok(withinBudget(JSON.stringify(mismatch), 500));

    // 非法入参返回 usage.bad-argument，不抛异常
    for (const [a, b, opts] of [
      [null, pB, {}],
      [pA, { width: 4, height: 4, rgb: new Uint16Array(4 * 4 * 3) }, {}],
      [pA, pB, { tolerance: { psnrMin: -1 } }],
      [pA, pB, { heatmapGain: 0 }],
    ]) {
      const bad = observe.compare(a, b, opts);
      assert.equal(bad.ok, false, JSON.stringify(bad));
      assert.equal(bad.error.code, 'usage.bad-argument');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('O6-5 align: 构图对位、不可靠包络、200 切点预算守卫、相机矩阵 M15 口径与非法入参', () => {
  // 构图包围盒对位
  const comp = observe.align({
    composition: { reference: [100, 100, 300, 300], actual: [200, 100, 400, 300], size: [1000, 500] },
  });
  assert.equal(comp.ok, true, JSON.stringify(comp));
  assert.deepEqual(comp.composition.centerShiftPx, [100, 0]);
  assert.deepEqual(comp.composition.centerShiftNorm, [0.1, 0]);
  assert.equal(comp.composition.areaRatio, 1);
  // 交集 100x200 = 20000，并集 40000+40000-20000 = 60000 -> IoU = 1/3
  assert.ok(Math.abs(comp.composition.iou - 1 / 3) < 1e-3);

  // 不相关（常量）包络 -> reliable: false
  const flat = observe.align({
    stretch: { filmEnvelope: new Array(200).fill(0.2), trackEnvelope: new Array(100).fill(0.2) },
  });
  assert.equal(flat.ok, true);
  assert.equal(flat.stretch.reliable, false);

  // 200 个切点仍严格压在 <= 500 token 内
  const manyRef = Array.from({ length: 200 }, (_, i) => i * 10);
  const manyAct = manyRef.map((f) => f + 1);
  const many = observe.align({ cuts: { reference: manyRef, actual: manyAct, maxDeltaFrames: 2 } });
  assert.equal(many.ok, true);
  assert.equal(many.truncated, true);
  assert.equal(many.cuts.meanAbsDelta, 1);
  assert.ok(withinBudget(JSON.stringify(many), 500), `tokens=${estimateTokens(JSON.stringify(many))}`);

  // 相机 < 4 点报 usage.bad-argument；合法 6 点校验 proj 满足 meta/0.1 M15 算式
  const few = observe.align({
    camera: {
      points: [
        { world: [0, 0, 0], screen: [960, 540] },
        { world: [1, 0, 0], screen: [1100, 540] },
        { world: [0, 1, 0], screen: [960, 400] },
      ],
      size: [1920, 1080],
    },
  });
  assert.equal(few.ok, false);
  assert.equal(few.error.code, 'usage.bad-argument');

  // 校验 proj 矩阵 M15：proj[5] === 1/tan(fovY/2), proj[0] === proj[5]*h/w
  const w = 1280, h = 720, fovY = 45, near = 0.2, far = 500;
  const f = 1 / Math.tan((fovY * Math.PI) / 360);
  const truePos = [-1.5, 0.9, 2.8];
  const pts = [[-0.5, 0, -0.3], [0.5, 0, -0.2], [-0.4, 0.7, 0.3], [0.4, 0.6, 0.2], [0, 0.2, 0.5], [0.2, 0.4, -0.4]];
  const z = (() => { const d = [truePos[0], truePos[1] - 0.3, truePos[2]]; const l = Math.hypot(...d); return d.map((v) => v / l); })();
  const x = (() => { const c = [z[2], 0, -z[0]]; const l = Math.hypot(...c); return c.map((v) => v / l); })();
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const camPts = pts.map((pw) => {
    const d = [pw[0] - truePos[0], pw[1] - truePos[1], pw[2] - truePos[2]];
    const cx = d[0] * x[0] + d[1] * x[1] + d[2] * x[2];
    const cy = d[0] * y[0] + d[1] * y[1] + d[2] * y[2];
    const cz = d[0] * z[0] + d[1] * z[1] + d[2] * z[2];
    return { world: pw, screen: [((cx * (f * h / w)) / -cz * 0.5 + 0.5) * w, (0.5 - (cy * f) / -cz * 0.5) * h] };
  });
  const camRes = observe.align({ camera: { points: camPts, size: [w, h], initial: { near, far } } });
  assert.equal(camRes.ok, true, JSON.stringify(camRes));
  assert.ok(camRes.camera.rmsePx < 0.5);
  const fExp = 1 / Math.tan((camRes.camera.fovY * Math.PI) / 360);
  assert.ok(Math.abs(camRes.camera.proj[5] - fExp) / Math.abs(fExp) < 1e-12);
  assert.ok(Math.abs(camRes.camera.proj[0] - camRes.camera.proj[5] * (h / w)) / Math.abs(camRes.camera.proj[0]) < 1e-12);
  assert.ok(Math.abs(camRes.camera.proj[10] - (-(far + near) / (far - near))) < 1e-12);
  assert.ok(Math.abs(camRes.camera.proj[14] - ((-2 * far * near) / (far - near))) < 1e-12);
  assert.ok(withinBudget(JSON.stringify(camRes), 500));

  for (const bad of [null, {}, { cuts: { reference: [-1], actual: [] } }, { stretch: { filmEnvelope: [1], trackEnvelope: [1] } }]) {
    const r = observe.align(bad);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'usage.bad-argument');
  }
});

test('O6-6 compare & align: 经 ffmpeg 对比视频帧与提取音频 20ms 包络（无 ffmpeg 跳过）', (t) => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('本机没有 ffmpeg');
  const dir = mkdtempSync(join(tmpdir(), 'o6-media-'));
  try {
    const v1 = join(dir, 'v1.mkv');
    const v2 = join(dir, 'v2.mkv');
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x404040:s=64x36:r=24:d=0.5', '-c:v', 'ffv1', v1]).status, 0);
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x444444:s=64x36:r=24:d=0.5', '-c:v', 'ffv1', v2]).status, 0);
    const vr = observe.compare({ video: v1, frame: 3, fps: 24 }, { video: v2, frame: 3, fps: 24 });
    assert.equal(vr.ok, true, JSON.stringify(vr));
    assert.equal(vr.rows.find((row) => row.metric === 'maxDiff')?.value, 4);
    assert.ok(withinBudget(JSON.stringify(vr), 500));

    // 合成带脉冲包络的 WAV：track 长 8s，film 前置 1.0s 静音并将 track 精确按 1.01 倍放慢
    const trackWav = join(dir, 'track.wav');
    const filmWav = join(dir, 'film.wav');
    const expr = 'sin(2*PI*440*t)*(between(t,0.3,0.42)+0.8*between(t,1.5,1.62)+1.2*between(t,2.9,3.02)+0.9*between(t,4.4,4.52)+1.1*between(t,6.1,6.22)+1.0*between(t,7.4,7.52))';
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=24000:d=8`, trackWav]).status, 0);
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', trackWav, '-af', 'asetrate=24000/1.01,aresample=24000,adelay=1000:all=1,apad=pad_dur=1', filmWav]).status, 0);
    const ar = observe.align({
      stretch: { filmPath: filmWav, trackPath: trackWav, stepSec: 0.02, stretchRange: [0.99, 1.03], stretchStep: 0.001, maxOffsetSec: 2.5 },
    });
    assert.equal(ar.ok, true, JSON.stringify(ar));
    assert.equal(ar.stretch.reliable, true);
    assert.ok(Math.abs(ar.stretch.offsetSec - 1.0) <= 0.04, `偏移应约 1.0s，实得 ${JSON.stringify(ar.stretch)}`);
    assert.ok(Math.abs(ar.stretch.stretch - 1.01) <= 0.002, `拉伸比应约 1.01，实得 ${JSON.stringify(ar.stretch)}`);
    assert.ok(withinBudget(JSON.stringify(ar), 500));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('O6-7 O5 二阶加固: telemetry 15 万帧不爆栈 + 隔帧频闪检出 + curves meta 按 shot/shotFrame 对齐', () => {
  // 150,000 帧 kinematics 不触发 RangeError: Maximum call stack size exceeded
  const N = 150_000;
  const luma = new Array(N).fill(0.3);
  const contrast = new Array(N).fill(0.2);
  const motion = new Array(N).fill(0.1);
  const x = new Array(N).fill(0);
  const cut = new Array(N).fill(0);
  const hold = new Array(N).fill(0);
  luma[10] = 0.8;
  const big = observe.telemetry({
    kinematics: { fps: 24, sampleSize: [160, 90], tracks: { screen: { luma, contrast, motion, x, cut, hold } } },
  });
  assert.equal(big.ok, true, JSON.stringify(big));
  assert.equal(big.frames, N);
  assert.equal(big.luma.max, 0.8);
  assert.ok(withinBudget(JSON.stringify(big), 600));

  // 隔帧频闪（两帧亮两帧暗）被检出
  const stride2 = Array.from({ length: 24 }, (_, f) => (f >= 6 && f <= 19 ? (Math.floor((f - 6) / 2) % 2 === 0 ? 0.1 : 0.9) : 0.3));
  const flk = observe.telemetry({
    kinematics: {
      fps: 24,
      tracks: { screen: { luma: stride2, contrast: new Array(24).fill(0.2), motion: new Array(24).fill(0.2), x: new Array(24).fill(0), cut: new Array(24).fill(0), hold: new Array(24).fill(0) } },
    },
  });
  assert.equal(flk.ok, true);
  assert.equal(flk.flicker.detected, true, `隔帧频闪应被检出：${JSON.stringify(flk.flicker)}`);

  // curves meta/0.1 回退按 shot 过滤并用 shotFrame 对齐局部帧号
  const mkMeta = (shot, frame, shotFrame, cx) => ({
    ...structuredClone(full),
    shot,
    frame,
    shotFrame,
    entities: [{ id: 1, name: 'hero_card', class: 'card2d', role: 'hero', bbox2d: [cx - 50, 400, cx + 50, 600], visible: 1, pxArea: (100 * 200) / (1920 * 1080) }],
    texts: [],
    events: [],
    lights: [],
  });
  const metas = [
    ...Array.from({ length: 5 }, (_, i) => mkMeta('s01', i, i, 200)),
    ...Array.from({ length: 11 }, (_, i) => mkMeta('s02', 100 + i, i, 300 + i * 50)),
  ];
  const curRes = observe.curves({ tracks: encodeTracks({}), metas }, { entity: 'hero_card', shot: 's02', quantity: 'screenX', range: [0, 10] });
  assert.equal(curRes.ok, true, JSON.stringify(curRes));
  assert.equal(curRes.source, 'meta');
  assert.deepEqual(curRes.range, [0, 10]);
  assert.equal(curRes.easing, 'linear');
  assert.ok(withinBudget(JSON.stringify(curRes), 600));
});
