// O6 单测（Red -> Green）：observe/compare（<=500 token 差值表）与 observe/align（切点对齐、1.009 拉伸比求解、7 参数相机拟合 <=500 token）及 O5 二阶收敛
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('O6-8 G_REV-R1 compare 加固：热图不覆盖输入、小图 SSIM、亮度容差未舍入判定、未知键报错、存活变异', () => {
  const dir = mkdtempSync(join(tmpdir(), 'o6-rev-'));
  try {
    const w = 32, h = 18;
    const pA = join(dir, 'a.png');
    const pB = join(dir, 'b.png');
    writeFileSync(pA, observe.encodePng({ width: w, height: h, rgb: new Uint8Array(w * h * 3).fill(51) }));
    writeFileSync(pB, observe.encodePng({ width: w, height: h, rgb: new Uint8Array(w * h * 3).fill(153) }));
    const bytesA = readFileSync(pA);
    const bytesB = readFileSync(pB);
    const link = join(dir, 'link.png');
    symlinkSync(pA, link);
    // [P1-1] 热图目标与任一输入同文件（含软链与 heatmapOut 别名）时报错，原 PNG 一个字节都不改
    for (const opts of [{ heatmapPath: pA }, { heatmapPath: pB }, { heatmapOut: pB }, { heatmapPath: link }]) {
      const bad = observe.compare(pA, pB, opts);
      assert.equal(bad.ok, false, JSON.stringify(bad));
      assert.equal(bad.error.code, 'usage.bad-argument');
    }
    assert.deepEqual(readFileSync(pA), bytesA);
    assert.deepEqual(readFileSync(pB), bytesB);
    // 已知差图热图像素为红色高亮而非暗灰（杀灭 diffHeatmap(a, a) 变异）
    const hm = join(dir, 'heat.png');
    assert.equal(observe.compare(pA, pB, { heatmapPath: hm }).ok, true);
    const heat = observe.decodePng(readFileSync(hm));
    assert.equal(heat.rgb[0], 255);

    // [P1-2] 4x4 全黑对全白：SSIM 接近 0，ssimMin 0.99 下判不过
    const black = { width: 4, height: 4, rgb: new Uint8Array(48) };
    const white = { width: 4, height: 4, rgb: new Uint8Array(48).fill(255) };
    const small = observe.compare(black, white, { tolerance: { ssimMin: 0.99 } });
    assert.equal(small.ok, true, JSON.stringify(small));
    assert.equal(small.pass, false);
    assert.ok(small.rows.find((row) => row.metric === 'ssim').value < 0.01);

    // [P2-1] 灰度 1->2 与 2->3 同为 1/255，判定必须一致
    const gray = (v) => ({ width: 8, height: 8, rgb: new Uint8Array(192).fill(v) });
    for (const tol of [1 / 255, 0.0039]) {
      const p12 = observe.compare(gray(1), gray(2), { tolerance: { maxLumaP50Diff: tol }, metrics: ['lumaP50'] });
      const p23 = observe.compare(gray(2), gray(3), { tolerance: { maxLumaP50Diff: tol }, metrics: ['lumaP50'] });
      assert.equal(p12.rows[0].pass, p23.rows[0].pass, `tol=${tol}: ${JSON.stringify([p12.rows, p23.rows])}`);
      assert.equal(p12.rows[0].pass, tol === 1 / 255);
    }

    // [P2-2] 拼错的容差键与未知指标名报错，不静默放行
    for (const opts of [{ tolerance: { maxDif: 1 } }, { metrics: ['psr'] }]) {
      const bad = observe.compare(gray(1), gray(2), opts);
      assert.equal(bad.ok, false, JSON.stringify(bad));
      assert.equal(bad.error.code, 'usage.bad-argument');
    }

    // 存活变异 4：一半像素差 2 级、四分之一差 3 级 -> fracAbove1 = 0.75，fracAbove2 = 0.25
    const n = 32 * 32;
    const base = new Uint8Array(n * 3).fill(100);
    const mixed = new Uint8Array(n * 3).fill(100);
    for (let i = 0; i < n; i++) {
      const d = i < n / 2 ? 2 : i < (3 * n) / 4 ? 3 : 0;
      mixed.fill(100 + d, i * 3, i * 3 + 3);
    }
    const frac = observe.compare({ width: 32, height: 32, rgb: base }, { width: 32, height: 32, rgb: mixed }, { tolerance: { maxFracAbove1: 0.5, maxFracAbove2: 0.5 } });
    const f1 = frac.rows.find((row) => row.metric === 'fracAbove1');
    const f2 = frac.rows.find((row) => row.metric === 'fracAbove2');
    assert.equal(f1.value, 0.75);
    assert.equal(f2.value, 0.25);
    assert.equal(f1.pass, false);
    assert.equal(f2.pass, true);
    assert.equal(frac.pass, false);

    // 存活变异 5：seamDeltaE 超限判不过；非均匀图 p95 与 p05 不等
    const seam = observe.compare(pA, pB, { tolerance: { maxSeamDeltaE: 1 } });
    assert.equal(seam.pass, false);
    assert.equal(seam.rows.find((row) => row.metric === 'seamDeltaE').pass, false);
    const ramp = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) ramp.fill(Math.round((i / (n - 1)) * 255), i * 3, i * 3 + 3);
    const rr = observe.compare({ width: 32, height: 32, rgb: ramp }, { width: 32, height: 32, rgb: base });
    const p05 = rr.rows.find((row) => row.metric === 'lumaP05');
    const p95 = rr.rows.find((row) => row.metric === 'lumaP95');
    assert.notEqual(p05.a, p95.a);
    assert.ok(p95.a > 0.9 && p05.a < 0.1, JSON.stringify([p05, p95]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 用调用方拿到的 world（相机到世界）与 proj 独立复算重投影 RMSE
function reprojectRmse(points, world, proj, [W, H]) {
  let sse = 0;
  for (const { world: p, screen } of points) {
    const d = [p[0] - world[12], p[1] - world[13], p[2] - world[14]];
    const c = [0, 1, 2].map((k) => world[k * 4] * d[0] + world[k * 4 + 1] * d[1] + world[k * 4 + 2] * d[2]);
    const clip = [0, 1, 3].map((row) => proj[row] * c[0] + proj[4 + row] * c[1] + proj[8 + row] * c[2] + proj[12 + row]);
    const u = (clip[0] / clip[2] * 0.5 + 0.5) * W;
    const v = (0.5 - clip[1] / clip[2] * 0.5) * H;
    sse += (u - screen[0]) ** 2 + (v - screen[1]) ** 2;
  }
  return Math.sqrt(sse / points.length);
}

function synthCamera(worldPts, pos, target, fovY, [W, H]) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
  const z = norm(sub(pos, target));
  const x = norm(cross([0, 1, 0], z));
  const y = cross(z, x);
  const f = 1 / Math.tan((fovY * Math.PI) / 360);
  return worldPts.map((p) => {
    const d = sub(p, pos);
    const cz = dot(d, z);
    return { world: p, screen: [((dot(d, x) * f * H / W) / -cz * 0.5 + 0.5) * W, (0.5 - (dot(d, y) * f) / -cz * 0.5) * H] };
  });
}

test('O6-9 G_REV-R1 align 加固：相机矩阵全精度复算、远裁剪面防溢出、退化与收敛判定、切点边界与计数、弱相关', () => {
  // [P1-3] 1e-4 尺度 8 点：用返回的 world/proj 独立复算 RMSE < 0.5 px，far = 1e308 时 proj 全有限
  const size = [1920, 1080];
  const s = 1e-4;
  const cube = [[-1, 0, -1], [1, 0.2, -1], [-1, 1.4, 1], [1, 1.2, 1], [0, 0.6, 0], [-0.5, 0.3, 1], [0.6, 1, -0.7], [0.2, 0.1, 0.8]].map((p) => p.map((v) => v * s));
  const tinyPts = synthCamera(cube, [1.8 * s * 2, 1.2 * s * 2, 3.4 * s * 2], [0, 0.6 * s, 0], 38, size);
  const tiny = observe.align({ camera: { points: tinyPts, size, initial: { near: 1e-6, far: 1e308 } } });
  assert.equal(tiny.ok, true, JSON.stringify(tiny));
  assert.ok(tiny.camera.proj.every(Number.isFinite), JSON.stringify(tiny.camera.proj));
  const rm = reprojectRmse(tinyPts, tiny.camera.world, tiny.camera.proj, size);
  assert.ok(rm < 0.5, `复算 RMSE ${rm}，返回 ${JSON.stringify(tiny.camera)}`);
  assert.ok(Math.abs(rm - tiny.camera.rmsePx) < 1e-3, `rmsePx 须由返回矩阵复算：${rm} vs ${tiny.camera.rmsePx}`);
  assert.equal(tiny.camera.converged, true);
  assert.equal(tiny.camera.degenerate, false);
  assert.ok(withinBudget(JSON.stringify(tiny), 500));

  // 四点共线 -> degenerate；正对平面 -> degenerate
  const line = [[0, 0, 0], [0.2, 0, 0], [0.5, 0, 0], [1, 0, 0]];
  const lineRes = observe.align({ camera: { points: synthCamera(line, [0.5, 0.5, 3], [0.5, 0, 0], 40, size), size } });
  assert.equal(lineRes.ok, true, JSON.stringify(lineRes));
  assert.equal(lineRes.camera.degenerate, true);
  const plane = [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0], [0.3, 0.2, 0], [-0.4, 0.5, 0]];
  const planeRes = observe.align({ camera: { points: synthCamera(plane, [0, 0, 4], [0, 0, 0], 40, size), size } });
  assert.equal(planeRes.ok, true, JSON.stringify(planeRes));
  assert.equal(planeRes.camera.degenerate, true);

  // 高残差（屏幕点被打乱）-> converged: false
  const good = synthCamera(cube.map((p) => p.map((v) => v / s)), [3.6, 2.4, 6.8], [0, 0.6, 0], 38, size);
  const shuffled = good.map((p, i) => ({ world: p.world, screen: good[(i + 3) % good.length].screen }));
  const hi = observe.align({ camera: { points: shuffled, size } });
  assert.equal(hi.ok, true, JSON.stringify(hi));
  assert.ok(hi.camera.rmsePx > 1, JSON.stringify(hi.camera));
  assert.equal(hi.camera.converged, false);

  // 存活变异 6：帧差恰等于 maxDeltaFrames 时配对，delta = actual - ref 带符号
  const edge = observe.align({ cuts: { reference: [10, 50], actual: [7, 53], maxDeltaFrames: 3 } });
  assert.deepEqual(edge.cuts.pairs, [{ ref: 10, actual: 7, delta: -3 }, { ref: 50, actual: 53, delta: 3 }]);
  assert.equal(edge.cuts.missedCount, 0);
  assert.equal(edge.cuts.extraCount, 0);

  // [P2-4] 截断时 truncated: true 且保留截断前总数
  const lost = observe.align({ cuts: { reference: Array.from({ length: 300 }, (_, i) => i * 10), actual: Array.from({ length: 250 }, (_, i) => i * 10 + 5) } });
  assert.equal(lost.ok, true);
  assert.equal(lost.truncated, true);
  assert.equal(lost.cuts.missedCount, 300);
  assert.equal(lost.cuts.extraCount, 250);
  assert.ok(withinBudget(JSON.stringify(lost), 500));

  // 存活变异 7：相关系数落在 0.2..0.4 的弱相关包络 -> reliable: false
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const trackEnvelope = Array.from({ length: 300 }, () => rnd());
  const filmEnvelope = Array.from({ length: 340 }, (_, j) => (j >= 20 && j < 320 ? 0.3 * trackEnvelope[j - 20] : 0) + rnd());
  const weak = observe.align({ stretch: { filmEnvelope, trackEnvelope, stretchRange: [1, 1], maxOffsetSec: 1 } });
  assert.equal(weak.ok, true, JSON.stringify(weak));
  assert.ok(weak.stretch.corr >= 0.2 && weak.stretch.corr <= 0.4, JSON.stringify(weak.stretch));
  assert.equal(weak.stretch.reliable, false);
});

test('O6-10 G_REV-R1 curves：省略 shot 时按全片帧号 frame 查询', () => {
  const mk = (frame, shotFrame, cx) => ({
    ...structuredClone(full), shot: 's02', frame, shotFrame,
    entities: [{ id: 1, name: 'hero_card', class: 'card2d', role: 'hero', bbox2d: [cx - 50, 400, cx + 50, 600], visible: 1, pxArea: (100 * 200) / (1920 * 1080) }],
    texts: [], events: [], lights: [],
  });
  const metas = Array.from({ length: 11 }, (_, i) => mk(100 + i, i, 300 + i * 50));
  const res = observe.curves({ tracks: encodeTracks({}), metas }, { entity: 'hero_card', quantity: 'screenX', range: [100, 101] });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.range, [100, 101]);
});
