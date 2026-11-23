// O5 单测（Red -> Green）：observe/curves（读 tracks/0.1 与 meta/0.1 回退，不渲染）与 observe/telemetry（1/8 分辨率亮度平面 kinematics + 闪烁 + 音频起音帧差）
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeTracks } from '../kernel/eval/tracks.mjs';
import * as observe from './index.mjs';
import { estimateTokens, withinBudget } from './query.mjs';
import full from '../kernel/contracts/meta/examples/full.json' with { type: 'json' };

// 以仓库的 meta/0.1 完整样例为底，只换帧号与实体，保证元数据过契约校验
function makeValidMeta(frame, bbox2d, visible = 1) {
  return {
    ...structuredClone(full),
    frame,
    shotFrame: frame,
    entities: [{ id: 1, name: 'hero_card', class: 'card2d', role: 'hero', bbox2d, visible, pxArea: ((bbox2d[2] - bbox2d[0]) * (bbox2d[3] - bbox2d[1])) / (1920 * 1080) }],
    texts: [],
    events: [],
    lights: [],
  };
}

test('O5-1 curves: 从 tracks/0.1 二进制准确识别合成曲线的峰值、零平台、单调段与缓动类型，且 <= 600 token', () => {
  assert.equal(typeof observe.curves, 'function', 'observe 应导出 curves');

  // 49 帧合成标量曲线：0..10 零平台(0) -> 10..24 加速上升到峰值 1.0 (f=24) -> 24..38 单调下降到 0.2 -> 38..48 平台(0.2)
  const samples = [];
  for (let f = 0; f <= 48; f++) {
    if (f <= 10) samples.push(0);
    else if (f <= 24) {
      const u = (f - 10) / 14;
      samples.push(u * u); // ease-in 上升至 1.0
    } else if (f <= 38) {
      const u = (f - 24) / 14;
      samples.push(1 - 0.8 * u); // 线性下降至 0.2
    } else {
      samples.push(0.2);
    }
  }
  const vecSamples = samples.map((v, f) => [f * 0.1, v, 0]);
  const encoded = encodeTracks({
    'hero.lift': { type: 'scalar', samples },
    'hero.pos': { type: 'vec3', samples: vecSamples },
  }, { shot: 's01', fps: 24 });

  const res = observe.curves(encoded, { track: 'hero.lift', range: [0, 48] });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(Array.isArray(res.peaks) && res.peaks.some((p) => p.frame === 24 && Math.abs(p.value - 1.0) < 1e-3), '应在 f=24 检出峰值 1.0');
  assert.ok(
    Array.isArray(res.zeroPlateaus) && res.zeroPlateaus.some((z) => z[0] <= 1 && z[1] >= 9),
    '应检出 0..10 的零平台',
  );
  assert.ok(
    Array.isArray(res.monotonicSegments)
      && res.monotonicSegments.some((s) => s.dir === 'up' && s.start <= 11 && s.end === 24)
      && res.monotonicSegments.some((s) => s.dir === 'down' && s.start === 24 && s.end >= 37),
    '应检出上升段与下降段',
  );

  // 单独测试缓动分类：ease-in、ease-out、linear
  const easeInSamples = Array.from({ length: 25 }, (_, i) => (i / 24) ** 2.4);
  const easeOutSamples = Array.from({ length: 25 }, (_, i) => 1 - (1 - i / 24) ** 2.4);
  const linearSamples = Array.from({ length: 25 }, (_, i) => i / 24);
  const encEase = encodeTracks({
    'm.in': { type: 'scalar', samples: easeInSamples },
    'm.out': { type: 'scalar', samples: easeOutSamples },
    'm.lin': { type: 'scalar', samples: linearSamples },
  });
  assert.equal(observe.curves(encEase, { track: 'm.in' }).easing, 'ease-in');
  assert.equal(observe.curves(encEase, { track: 'm.out' }).easing, 'ease-out');
  assert.equal(observe.curves(encEase, { track: 'm.lin' }).easing, 'linear');

  // vec3 speed 量与超多波动下的 600 token 预算守卫
  const noisy = Array.from({ length: 300 }, (_, i) => Math.sin(i * 0.7) * (1 + (i % 5) * 0.1));
  const encNoisy = encodeTracks({ 'osc.val': { type: 'scalar', samples: noisy } });
  const noisyRes = observe.curves(encNoisy, { track: 'osc.val' });
  assert.equal(noisyRes.ok, true);
  const json = JSON.stringify(noisyRes);
  assert.ok(withinBudget(json, 600), `curves 预算超限：tokens=${estimateTokens(json)}, len=${json.length}`);
});

test('O5-2 curves: 无轨道实体回退读 meta/0.1 屏幕轨迹，非法输入返回 { ok: false } 不抛异常', () => {
  const metas = Array.from({ length: 21 }, (_, f) => {
    const cx = 200 + f * 40;
    return makeValidMeta(f, [cx - 50, 400, cx + 50, 600]);
  });
  const emptyTracks = encodeTracks({});
  const res = observe.curves({ tracks: emptyTracks, metas }, { entity: 'hero_card', quantity: 'screenX', range: [0, 20] });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.source, 'meta');
  assert.equal(res.easing, 'linear');
  assert.ok(res.monotonicSegments.some((s) => s.dir === 'up' && s.start === 0 && s.end === 20));
  assert.ok(withinBudget(JSON.stringify(res), 600));

  const bad = observe.curves(null, { track: 'missing' });
  assert.equal(bad.ok, false);
  assert.equal(typeof bad.error?.code, 'string');
});

test('O5-3 telemetry: 1/8 分辨率亮度平面准确分离硬切、静止段、横向运动重心与已知闪烁序列，且 <= 600 token', () => {
  assert.equal(typeof observe.telemetry, 'function', 'observe 应导出 telemetry');

  const w = 64;
  const h = 36;
  const frames = [];
  // 0..7: 静止暗底 (Y=32)
  // 8..19: 亮块从左向右匀速扫过（横向重心从负到正）
  // 20: 硬切跳变到全亮场景 (Y=210)
  // 21..26: 静止亮底 (Y=210)
  // 27..36: 已知高频闪烁序列（Y 在 45 与 215 之间逐帧交替翻转）
  for (let f = 0; f < 37; f++) {
    const plane = new Uint8Array(w * h);
    if (f <= 7) {
      plane.fill(32);
    } else if (f <= 19) {
      plane.fill(32);
      const u = (f - 8) / 11;
      const xCenter = Math.round(6 + u * (w - 13));
      for (let y = 8; y < 28; y++) {
        for (let x = Math.max(0, xCenter - 5); x <= Math.min(w - 1, xCenter + 5); x++) {
          plane[y * w + x] = 220;
        }
      }
    } else if (f <= 26) {
      plane.fill(210);
    } else {
      plane.fill((f - 27) % 2 === 0 ? 45 : 215);
    }
    frames.push(plane);
  }

  const res = observe.telemetry(
    {
      width: w,
      height: h,
      fps: 24,
      rangeMode: 'tv',
      frames,
      audio: {
        loudnessLufs: -14.1,
        truePeakDbtp: -1.3,
        events: [{ id: 'cut_flash', frame: 20 }],
        onsets: [{ frame: 20.5 }],
      },
    },
    { range: [0, 36] },
  );

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(Array.isArray(res.detectedCuts) && res.detectedCuts.includes(20), `应检出第 20 帧硬切，实测: ${JSON.stringify(res.detectedCuts)}`);
  assert.ok(
    Array.isArray(res.holdSpans) && res.holdSpans.some((s) => s[0] <= 2 && s[1] >= 7),
    `应检出前段静止区间，实测: ${JSON.stringify(res.holdSpans)}`,
  );
  assert.ok(res.motionPan.start < -0.15 && res.motionPan.end > 0.15, `横向运动重心应由左移到右，实测: ${JSON.stringify(res.motionPan)}`);
  assert.equal(res.flicker.detected, true, '已知逐帧交替闪烁序列必须被检出');
  assert.ok(res.flicker.spans.some((s) => s[0] <= 29 && s[1] >= 35), `闪烁区间应覆盖 27..36，实测: ${JSON.stringify(res.flicker)}`);
  assert.ok(res.audio && Math.abs(res.audio.loudnessLufs - (-14.1)) < 1e-3 && Math.abs(res.audio.maxOnsetFrameDelta - 0.5) < 1e-3);

  const json = JSON.stringify(res);
  assert.ok(withinBudget(json, 600), `telemetry 预算超限：tokens=${estimateTokens(json)}, len=${json.length}`);

  // 也支持直接吃 PR 15 生成的 kinematics.json 对象
  const kinRes = observe.telemetry({
    kinematics: {
      fps: 24,
      dur: 1.0,
      sampleSize: [240, 135],
      detectedCuts: [12],
      tracks: {
        screen: {
          luma: Array.from({ length: 24 }, (_, i) => (i >= 16 ? (i % 2 === 0 ? 0.1 : 0.9) : 0.2)),
          contrast: new Array(24).fill(0.3),
          motion: Array.from({ length: 24 }, (_, i) => (i < 6 ? 0 : 0.4)),
          x: Array.from({ length: 24 }, (_, i) => -0.5 + i / 24),
          cut: Array.from({ length: 24 }, (_, i) => (i === 12 ? 1 : 0)),
          hold: Array.from({ length: 24 }, (_, i) => (i > 0 && i < 6 ? 1 : 0)),
        },
      },
    },
  });
  assert.equal(kinRes.ok, true);
  assert.ok(kinRes.detectedCuts.includes(12));
  assert.equal(kinRes.flicker.detected, true);
  assert.ok(withinBudget(JSON.stringify(kinRes), 600));
});

test('O5-4 curves: step / hold / ease-in-out / oscillating、vec3 speed、范围与非法入参', () => {
  const one = (samples, req = { track: 't' }, type = 'scalar') => observe.curves(encodeTracks({ t: { type, samples } }), req);
  assert.equal(one(new Array(30).fill(0.5)).easing, 'hold');
  assert.equal(one(Array.from({ length: 30 }, (_, i) => (i < 15 ? 0 : 1))).easing, 'step');
  const smooth = (u) => u * u * (3 - 2 * u);
  assert.equal(one(Array.from({ length: 31 }, (_, i) => smooth(i / 30))).easing, 'ease-in-out');
  const osc = one(Array.from({ length: 60 }, (_, i) => Math.sin(i / 4)));
  assert.equal(osc.easing, 'oscillating');
  assert.ok(osc.peaks.length >= 3);

  // vec3 速度：匀速直线是 linear 以外的常量，speed 全等 → 无单调段
  const line = one(Array.from({ length: 20 }, (_, i) => [i * 0.2, 0, 0]), { track: 't', quantity: 'speed' }, 'vec3');
  assert.equal(line.ok, true);
  assert.ok(Math.abs(line.max.value - 0.2) < 1e-6 && Math.abs(line.min.value - 0.2) < 1e-6);
  assert.equal(line.easing, 'hold');

  // range 只取一段
  const ranged = one(Array.from({ length: 30 }, (_, i) => i), { track: 't', range: [5, 9] });
  assert.equal(ranged.samples, 5);
  assert.equal(ranged.first, 5);

  // 非法入参一律结构化错误
  for (const [input, req] of [
    [undefined, { track: 't' }], [encodeTracks({}), {}], [encodeTracks({}), { track: 'x' }],
    [encodeTracks({ t: { type: 'scalar', samples: [1, 2] } }), { track: 't', range: [3, 1] }],
    [encodeTracks({ t: { type: 'vec3', samples: [[1, 2, 3], [2, 3, 4]] } }), { track: 't', quantity: 'nope' }],
    [{ indexJson: '{', bin: new Uint8Array(0) }, { track: 't' }],
  ]) {
    const r = observe.curves(input, req);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error.code, 'usage.bad-argument');
  }
});

test('O5-5 curves: 1 万帧高频噪声序列化后 <= 600 token 并标记 truncated', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const res = observe.curves(encodeTracks({ n: { type: 'scalar', samples: Array.from({ length: 10000 }, () => rnd() * 2 - 1) } }), { track: 'n' });
  assert.equal(res.ok, true);
  assert.equal(res.truncated, true);
  const json = JSON.stringify(res);
  assert.ok(withinBudget(json, 600), `tokens=${estimateTokens(json)}`);
});

const plane = (w, h, fill) => new Uint8Array(w * h).fill(fill);

test('O5-6 telemetry: 单帧硬切不误报闪烁，1000 帧高频噪声 <= 600 token，非法入参不抛异常', () => {
  const w = 32, h = 18;
  const cutOnly = Array.from({ length: 30 }, (_, f) => plane(w, h, f < 15 ? 40 : 200));
  const r = observe.telemetry({ width: w, height: h, frames: cutOnly });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.detectedCuts, [15]);
  assert.equal(r.flicker.detected, false);
  assert.deepEqual(r.flicker.spans, []);

  let seed = 3;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const noisy = Array.from({ length: 1000 }, () => Uint8Array.from({ length: w * h }, () => 16 + Math.floor(rnd() * 219)));
  const nr = observe.telemetry({ width: w, height: h, frames: noisy, audio: { loudnessLufs: -20, truePeakDbtp: -3,
    events: Array.from({ length: 300 }, (_, i) => i), onsets: Array.from({ length: 300 }, (_, i) => i + (i % 7)) } });
  assert.equal(nr.ok, true, JSON.stringify(nr));
  const json = JSON.stringify(nr);
  assert.ok(withinBudget(json, 600), `tokens=${estimateTokens(json)}`);

  // full / linear 范围：纯黑到纯白的硬切，亮度归一化到 0..1
  const full8 = observe.telemetry({ width: w, height: h, rangeMode: 'full', frames: [plane(w, h, 0), plane(w, h, 0), plane(w, h, 255), plane(w, h, 255)] });
  assert.equal(full8.luma.min, 0);
  assert.equal(full8.luma.max, 1);
  const lin = observe.telemetry({ width: w, height: h, frames: [new Float32Array(w * h), new Float32Array(w * h).fill(1)] });
  assert.equal(lin.ok, true);
  assert.equal(lin.luma.max, 1);

  for (const bad of [
    undefined, {}, { width: 0, height: 4, frames: [] }, { width: 2, height: 2, frames: [] },
    { width: 2, height: 2, frames: [new Uint8Array(3)] }, { width: 2, height: 2, frames: [plane(2, 2, 1)], rangeMode: 'bt2020' },
    { width: 2, height: 2, frames: [plane(2, 2, 1)], audio: { events: [1] } },
    { width: 2, height: 2, frames: [plane(2, 2, 1)], fps: -1 },
    { kinematics: { tracks: {} } }, { videoPath: '' },
  ]) {
    const e = observe.telemetry(bad);
    assert.equal(e.ok, false, JSON.stringify(bad));
    assert.equal(e.error.code, 'usage.bad-argument');
  }
  assert.equal(observe.telemetry({ width: 2, height: 2, frames: [plane(2, 2, 1)] }, { range: [0, 5] }).ok, false);
});

test('O5-7 telemetry: 视频文件经 ffmpeg 抽 1/8 亮度平面（本机无 ffmpeg 则跳过）', (t) => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('本机没有 ffmpeg');
  const dir = mkdtempSync(join(tmpdir(), 'o5-tele-'));
  try {
    const file = join(dir, 'two.mkv');
    const make = spawnSync('ffmpeg', ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x303030:s=320x180:r=24:d=0.5', '-f', 'lavfi', '-i', 'color=c=0xe0e0e0:s=320x180:r=24:d=0.5',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-c:v', 'ffv1', file]);
    assert.equal(make.status, 0, String(make.stderr));
    const r = observe.telemetry({ videoPath: file, fps: 24 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.source, 'video');
    assert.deepEqual(r.detectedCuts, [12]);
    assert.ok(r.size[0] <= 40 && r.size[0] >= 32, JSON.stringify(r.size));
    assert.ok(r.luma.min < 0.25 && r.luma.max > 0.7, JSON.stringify(r.luma));
    assert.ok(withinBudget(JSON.stringify(r), 600));
    const gone = observe.telemetry({ videoPath: join(dir, 'missing.mkv') });
    assert.equal(gone.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
