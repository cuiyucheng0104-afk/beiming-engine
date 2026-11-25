import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCardRegistry, resolveParams, scanCardLeaks, validateCard } from './index.mjs';
import { dataValidators } from './sweep-schema.mjs';
import { evaluate as evalImpulse } from './motion/impulse/index.mjs';
import { evaluate as evalSwim } from './motion/swim/index.mjs';
import { evaluate as evalRollBank, measureMaxTwistJumpDeg } from './motion/roll-bank/index.mjs';
import { compileRail, evaluate as evalSweepBody, sweepSpineAt } from './motion/sweep-body/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const T19_CARDS = [
  ['motion.impulse', 'motion/impulse'],
  ['motion.swim', 'motion/swim'],
  ['motion.roll-bank', 'motion/roll-bank'],
  ['motion.sweep-body', 'motion/sweep-body'],
];

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a) => Math.hypot(a[0], a[1], a[2]);
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function twistStepsDeg(nodes) {
  const steps = [];
  for (let i = 1; i < nodes.length; i++) {
    const t = nodes[i].tan;
    const n = nodes[i].nor;
    const p = nodes[i - 1].nor;
    const d = dot3(p, t);
    let px = p[0] - t[0] * d;
    let py = p[1] - t[1] * d;
    let pz = p[2] - t[2] * d;
    const pl = Math.hypot(px, py, pz);
    if (pl < 1e-9) {
      steps.push(0);
      continue;
    }
    px /= pl;
    py /= pl;
    pz /= pl;
    const cx = py * n[2] - pz * n[1];
    const cy = pz * n[0] - px * n[2];
    const cz = px * n[1] - py * n[0];
    const sinA = cx * t[0] + cy * t[1] + cz * t[2];
    const cosA = px * n[0] + py * n[1] + pz * n[2];
    steps.push((Math.atan2(sinA, cosA) * 180) / Math.PI);
  }
  return steps;
}

function compareTrajectories(refFrames, candFrames) {
  let sumSq = 0;
  let count = 0;
  let maxDisp = 0;
  let maxExcessTwistDeg = 0;
  for (let f = 0; f < refFrames.length; f++) {
    const rNodes = refFrames[f].nodes;
    const cNodes = candFrames[f].nodes;
    assert.equal(rNodes.length, cNodes.length);
    for (let i = 0; i < rNodes.length; i++) {
      const dx = cNodes[i].pos[0] - rNodes[i].pos[0];
      const dy = cNodes[i].pos[1] - rNodes[i].pos[1];
      const dz = cNodes[i].pos[2] - rNodes[i].pos[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      sumSq += d2;
      count += 1;
      maxDisp = Math.max(maxDisp, Math.sqrt(d2));
    }
    const rTwist = twistStepsDeg(rNodes);
    const cTwist = twistStepsDeg(cNodes);
    for (let i = 0; i < rTwist.length; i++) {
      maxExcessTwistDeg = Math.max(maxExcessTwistDeg, Math.abs(cTwist[i] - rTwist[i]));
    }
  }
  return {
    rmseM: Math.sqrt(sumSq / count),
    maxDispM: maxDisp,
    maxExcessTwistDeg,
  };
}

for (const [id, dir] of T19_CARDS) {
  test(`T19 ${id} 过 card/0.1 校验、零泄露扫描、注册表与参数 schema 校验`, () => {
    const root = join(HERE, dir);
    const card = readJson(join(root, 'card.json'));
    assert.equal(card.id, id);
    assert.equal(card.kind, 'motion');
    assert.equal(card.visibleToAgent, true);
    assert.deepEqual(card.livesIn, ['data']);
    assert.equal(card.impl.length, 1);
    assert.equal(card.impl[0].livesIn, 'data');
    assert.equal(card.impl[0].shape, 'evaluate');
    assert.equal(card.impl[0].entry, `cards/${dir}/index.mjs`);
    assert.equal(card.impl[0].selftest, `cards/${dir}/selftest.test.mjs`);
    assert.ok(['reproduced', 'measured'].includes(card.status[0].level));
    assert.deepEqual(card.exams, [`cal:${id}`]);
    assert.ok(existsSync(join(dirname(HERE), card.impl[0].entry)));
    assert.ok(existsSync(join(dirname(HERE), card.impl[0].selftest)));

    assert.deepEqual(validateCard(card), { ok: true, schemaErrors: [], violations: {}, leaks: [] });

    for (const name of readdirSync(root)) {
      const content = readFileSync(join(root, name), 'utf8');
      assert.deepEqual(scanCardLeaks(content), [], `${id}/${name}`);
    }
    assert.deepEqual(scanCardLeaks(readFileSync(import.meta.filename, 'utf8')), []);

    const registry = createCardRegistry([card], { allowReproduced: true });
    assert.equal(registry.getCard(`${id}@1`).id, id);
    assert.ok(registry.searchCards({ kind: 'motion' }).some((row) => row.id === id));

    const resolved = resolveParams(card, {});
    const validators = dataValidators(card);
    assert.ok(validators.length >= 1, `${id} 应有至少一个受 schema.json 约束的数据参数`);
    for (const [key, validate] of validators) {
      assert.ok(validate(resolved[key]), `${id}.${key}: ${JSON.stringify(validate.errors)}`);
      assert.equal(validate({ unexpectedField: 1 }), false, `${id}.${key} 应拒绝未知字段`);
    }
  });

  test(`T19 ${id} 独立离线自测全部通过`, () => {
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(HERE, dir, 'selftest.test.mjs')], {
      env,
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.match(run.stdout, /pass [1-9]/);
  });
}

test('T19 四张卡纯函数乱序抽帧逐位一致', () => {
  const cards = Object.fromEntries(T19_CARDS.map(([id, dir]) => [id, readJson(join(HERE, dir, 'card.json'))]));
  const evaluators = [
    ['motion.impulse', evalImpulse],
    ['motion.swim', evalSwim],
    ['motion.roll-bank', evalRollBank],
    ['motion.sweep-body', evalSweepBody],
  ];
  const frames = [0, 18, 45, 90, 144];
  for (const [id, fn] of evaluators) {
    const params = resolveParams(cards[id], {});
    const ctx = { fps: 60 };
    const baseline = frames.map((f) => fn(ctx, params, f, 0.25));
    for (const idx of [4, 2, 0, 3, 1]) {
      assert.deepEqual(fn(ctx, params, frames[idx], 0.25), baseline[idx], `${id} 乱序抽帧不一致`);
    }
  }
});

test('T19 合成长轨迹：标架正交、相邻扭转跳变 < 0.5 deg，且清空脉冲与游动波置零负对照双双必红', () => {
  // Construct a smooth 3D serpentine + climbing helical trajectory (~800 m)
  const controlPoints = [];
  for (let i = 0; i <= 40; i++) {
    const u = i / 40;
    const th = u * Math.PI * 5;
    const r = 28 + 8 * Math.sin(u * Math.PI * 3);
    const y = 15 + 70 * u + 12 * Math.sin(u * Math.PI * 4);
    controlPoints.push([r * Math.cos(th), y, r * Math.sin(th)]);
  }
  const impulses = [
    {
      t0: 3.0,
      duration: 2.2,
      dir: [-0.35, -0.85, 0.38],
      amp: 9.5,
      reach: 22,
      whip: 55,
      tailFade: 0.3,
      envelope: 'smooth-window',
      riseStart: 3.05,
      riseEnd: 3.45,
      fallStart: 4.5,
      fallEnd: 5.1,
    },
    {
      t0: 6.0,
      duration: 1.8,
      dir: [0.8, 0.45, -0.35],
      amp: 7.2,
      reach: 30,
      whip: 80,
      tailFade: 0.3,
      envelope: 'attack-decay',
      attackStart: 6.0,
      attack: 0.16,
      release: 0.42,
    },
  ];
  const bodyLength = 120;
  const segments = 240;
  const sampleArclengths = Array.from({ length: 121 }, (_, i) => i);

  const rail = compileRail(
    {
      controlPoints,
      timeKeys: [[0, 0], [8, 10], [16, 20], [24, 30], [32, 40]],
      timeKeyMode: 'cpIndex',
      arcLengthDivisions: 6000,
      railSampleSpacing: 0.25,
    },
    { bodyLength, segments },
  );

  // Verify base rail parallel transport & frame smoothness without discontinuities
  const sampleTimes = [];
  for (let f = 180; f <= 540; f += 6) sampleTimes.push(f / 60); // 3.0s .. 9.0s (61 frames)

  const evalAll = (opts) => sampleTimes.map((t) => sweepSpineAt(rail, t, {
    bodyLength,
    segments,
    sampleArclengths,
    ...opts,
  }));

  const stdFrames = evalAll({ swimAmplitude: 1, swimCalm: 1, swimStir: 0.5, impulses });
  const noImpulseFrames = evalAll({ swimAmplitude: 1, swimCalm: 1, swimStir: 0.5, impulses: [] });
  const noSwimFrames = evalAll({ swimAmplitude: 0, swimCalm: 0, swimStir: 0, impulses });

  // Verify orthonormal frames and pure parallel-transport adjacent twist jump (< 0.5 deg)
  const ptRail = compileRail(
    {
      controlPoints,
      timeKeys: [[0, 0], [8, 10], [16, 20], [24, 30], [32, 40]],
      timeKeyMode: 'cpIndex',
      arcLengthDivisions: 6000,
      railSampleSpacing: 0.25,
    },
    { bodyLength, segments, frameMode: 'parallel-transport' },
  );
  const railOnlyFrames = sampleTimes.map((t) => sweepSpineAt(ptRail, t, {
    bodyLength,
    segments,
    sampleArclengths,
    swimAmplitude: 0,
    swimCalm: 0,
    swimStir: 0,
    bankGain: 0,
    impulses: [],
  }));
  let maxRailTwistStep = 0;
  for (const frame of railOnlyFrames) {
    for (const node of frame.nodes) {
      assert.ok(Math.abs(norm3(node.tan) - 1) < 1e-6);
      assert.ok(Math.abs(norm3(node.nor) - 1) < 1e-6);
      assert.ok(Math.abs(norm3(node.bin) - 1) < 1e-6);
      assert.ok(Math.abs(dot3(node.tan, node.nor)) < 1e-6);
      assert.ok(Math.abs(dot3(cross3(node.tan, node.nor), node.bin) - 1) < 1e-6);
    }
    maxRailTwistStep = Math.max(
      maxRailTwistStep,
      measureMaxTwistJumpDeg(frame.nodes.map((n) => ({ tangent: n.tan, normal: n.nor, binormal: n.bin }))),
    );
  }
  assert.ok(maxRailTwistStep < 0.5, `纯轨道平行输运相邻弧长最大扭转跳变应 < 0.5 deg，实测 ${maxRailTwistStep}`);

  // Also verify orthonormal frames on full std frames (rail-up + roll-bank + swim + impulses)
  for (const frame of stdFrames) {
    for (const node of frame.nodes) {
      assert.ok(Math.abs(norm3(node.tan) - 1) < 1e-6);
      assert.ok(Math.abs(norm3(node.nor) - 1) < 1e-6);
      assert.ok(Math.abs(norm3(node.bin) - 1) < 1e-6);
      assert.ok(Math.abs(dot3(node.tan, node.nor)) < 1e-6);
      assert.ok(Math.abs(dot3(cross3(node.tan, node.nor), node.bin) - 1) < 1e-6);
    }
  }

  // Positive control: self-parity is identically 0
  const selfDiff = compareTrajectories(stdFrames, evalAll({ swimAmplitude: 1, swimCalm: 1, swimStir: 0.5, impulses }));
  assert.equal(selfDiff.rmseM, 0);
  assert.equal(selfDiff.maxExcessTwistDeg, 0);

  // Negative control 1: clearing impulse events MUST exceed 0.01 m RMSE AND 0.5 deg twist diff
  const noImpDiff = compareTrajectories(stdFrames, noImpulseFrames);
  assert.ok(noImpDiff.rmseM > 0.1, `清空推力脉冲负对照位置 RMSE 应远超 0.01 m，实测 ${noImpDiff.rmseM} m`);
  assert.ok(noImpDiff.maxExcessTwistDeg > 0.5, `清空推力脉冲负对照扭转跳变差应超 0.5 deg，实测 ${noImpDiff.maxExcessTwistDeg} deg`);

  // Negative control 2: zeroing swim wave MUST exceed 0.01 m RMSE AND 0.5 deg twist diff
  const noSwimDiff = compareTrajectories(stdFrames, noSwimFrames);
  assert.ok(noSwimDiff.rmseM > 0.1, `游动波置零负对照位置 RMSE 应远超 0.01 m，实测 ${noSwimDiff.rmseM} m`);
  assert.ok(noSwimDiff.maxExcessTwistDeg > 0.5, `游动波置零负对照扭转跳变差应超 0.5 deg，实测 ${noSwimDiff.maxExcessTwistDeg} deg`);
});
