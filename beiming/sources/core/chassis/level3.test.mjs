// 对拍阶梯第 3 级（level3.mjs）的测试。纯逻辑部分任何机器都跑；端到端部分要参考包（标准答案机的产物，不在仓库里）
// 与编好的渲染程序：BEIMING_CORE_LADDER_ROOT 指参考包根目录，没设、或没有编好的程序又没设 BEIMING_CHASSIS_E2E=1，就跳过。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { THRESHOLDS } from '../../../verify/floorgate.mjs';
import { OUT, sourceKey } from './build.mjs';
import { ENV_NEGATIVE, MATCH, NEGATIVE, SEEDS, ballReadings, level3Packs, runLevel3 } from './level3.mjs';

const ROOT = process.env.BEIMING_CORE_LADDER_ROOT;
const E2E = process.env.BEIMING_CHASSIS_E2E === '1';

test('设置：每边种子数照阈值文件；对上 Cycles 开能量补偿、弹射上限照参考包；负对照关能量补偿', () => {
  assert.equal(SEEDS.length, THRESHOLDS.welch.seeds);
  assert.deepEqual(MATCH({ bounces: { max: 8, diffuse: 4, glossy: 4, transmission: 8 } }), { energyCompensation: 1, maxBounces: 9, maxDiffuseBounces: 5, maxGlossyBounces: 5, maxTransmissionBounces: 9 });
  assert.deepEqual(NEGATIVE.override, { energyCompensation: 0 });
  // 环境那条负对照的注入在内核源码里恰好有一处
  for (const i of ENV_NEGATIVE.inject) assert.equal(fs.readFileSync(path.join(OUT, '..', '..', 'beiming', 'sources', 'core', i.file), 'utf8').split(i.from).length, 2, i.from);
});

test('覆盖表：只取第 3 级，按场景包归组；同一包指向不同参考包时拒收', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'level3-cov-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pt = (id, pack, entity, ref = 'sha256:a') => ({ id, entity, params: { x: id }, scenePackDir: `scene-packs/${pack}`, frame: 0, size: [8, 4], ref });
  const write = (points) => fs.writeFileSync(path.join(root, 'coverage.json'), JSON.stringify({ points }));
  write([pt('l3/a/1', 'p1', 'b1'), pt('l3/a/2', 'p1', 'b2'), pt('l3/b/1', 'p2', 'c1', 'sha256:b'), pt('l4/x', 'p3', 'd1')]);
  const g = level3Packs(root);
  assert.deepEqual(g.map((x) => [x.pack, x.ref, x.balls.map((b) => b.entity)]), [['p1', 'sha256:a', ['b1', 'b2']], ['p2', 'sha256:b', ['c1']]]);
  write([pt('l3/a/1', 'p1', 'b1'), pt('l3/a/2', 'p1', 'b2', 'sha256:z')]);
  assert.throws(() => level3Packs(root), /指向不同的参考包/);
  fs.rmSync(path.join(root, 'coverage.json'));
  assert.throws(() => level3Packs(root), (e) => e.missing && /coverage\.json/.test(e.message));
});

test('逐球读数：按物体编号、只取覆盖率为 1 的像素；相对差与标准误照核心种子间的散布算', () => {
  // 2×2 的图：编号 1 占左两格（右下那格覆盖率 0.5 不算），编号 2 占右上
  const w = 2, h = 2;
  const id = Uint32Array.from([1, 2, 1, 1]), coverage = Float32Array.from([1, 1, 1, 0.5]);
  const gray = (vals) => Float32Array.from(vals.flatMap((v) => [v, v, v]));
  const converged = { w, h, id, coverage, rgb: gray([1, 4, 1, 100]) };
  const cores = [gray([1.1, 4, 1.1, 0]), gray([0.9, 4, 0.9, 0])];
  const [a, b] = ballReadings(['ball_a', 'ball_b'], [{ entity: 'ball_a' }, { entity: 'ball_b' }], { converged }, cores);
  assert.equal(a.pixels, 2);
  assert.ok(Math.abs(a.core - 1) < 1e-6 && Math.abs(a.rel) < 1e-6);
  assert.ok(Math.abs(Math.abs(a.z) - 0) < 1e-3);
  assert.equal(b.pixels, 1);
  assert.equal(b.rel, 0);
  assert.throws(() => ballReadings(['ball_a'], [{ entity: 'nope' }], { converged }, cores), /一个整像素都没有/);
});

const built = () => fs.existsSync(path.join(OUT, 'bin', `core-render-${sourceKey([])}${process.platform === 'win32' ? '.exe' : ''}`));

test('端到端：第 3 级六包过两道门，负对照判得出', { timeout: 7_200_000 }, async (t) => {
  if (!ROOT) { t.skip('没设 BEIMING_CORE_LADDER_ROOT（参考包由标准答案机出，不在仓库里）'); return; }
  // 不设 E2E、又没有编好的程序时不在这里现编（CI 上从头编要好几分钟，编完才发现没有显卡）
  if (!E2E && !built()) { t.skip('没有编好的渲染程序（设 BEIMING_CHASSIS_E2E=1 现编）'); return; }
  let rep;
  try {
    rep = await runLevel3({ root: ROOT, log: (s) => t.diagnostic(s) });
  } catch (e) {
    if (e.missing && !E2E) { t.skip(`缺：${e.missing}`); return; }
    throw e;
  }
  t.diagnostic(`显卡：${rep.adapter}`);
  assert.equal(rep.rows.length, 6);
  for (const r of rep.rows) {
    t.diagnostic(`${r.pack}: HDR-FLIP ${r.floor.value}（门 ${r.floor.threshold}），Welch ${r.welch.significantRatio}`);
    assert.equal(r.floor.status, 'pass', `${r.pack} 的 HDR-FLIP ${r.floor.value} 超过门 ${r.floor.threshold}`);
    assert.ok(r.welch.pass, `${r.pack} 的 Welch 显著比例 ${r.welch.significantRatio}、p 值直方图${r.welch.flat ? '平' : '不平'}`);
  }
  assert.ok(rep.negative?.caught, '负对照（关能量补偿）两道门都过了，门判不出来');
  assert.ok(rep.envNegative?.caught, '负对照（常量世界开回环境的光源采样）两道门都过了，门判不出来');
  assert.ok(rep.ok);
});
