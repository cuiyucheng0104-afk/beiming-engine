// 对拍阶梯第 4 级（level4.mjs）的测试。纯逻辑部分任何机器都跑；端到端部分要参考包（标准答案机的产物，不在仓库里）与编好的渲染程序：
// BEIMING_CORE_LADDER_ROOT 指参考包根目录，没设、或没有编好的程序又没设 BEIMING_CHASSIS_E2E=1，就跳过（不在这里现编）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { OUT, sourceKey } from './build.mjs';
import { CONTROL, ENERGY, NEGATIVES, energyRatio, groupSumError, level4Points, linkScenePack, runLevel4 } from './level4.mjs';
import { writePack } from './scenepack.mjs';

const ROOT = process.env.BEIMING_CORE_LADDER_ROOT;
const E2E = process.env.BEIMING_CHASSIS_E2E === '1';

test('取值点：按（场景包, 帧）归组，只判 l4/a 与 l4/b；对照包按参考包清单认出来；同一组指向不同参考包时拒收', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'level4-cov-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pt = (id, pack, frame, ref) => ({ id, params: {}, scenePackDir: `scene-packs/${pack}`, frame, size: [8, 4], ref });
  const write = (points) => fs.writeFileSync(path.join(root, 'coverage.json'), JSON.stringify({ points }));
  write([pt('l4/a/r/k/i0', 'h', 0, 'sha256:a'), pt('l4/a/r/k/i45', 'h', 1, 'sha256:b'), pt('l4/b/point', 'p', 0, 'sha256:c'), pt('l4/c/link', 'l4-link', 0, 'sha256:d'), pt('l3/x', 'q', 0, 'sha256:e')]);
  fs.mkdirSync(path.join(root, 'refs', 'sha256:f'), { recursive: true });
  fs.writeFileSync(path.join(root, 'refs', 'sha256:f', 'ref.json'), JSON.stringify({ ref: `oracle/${CONTROL}/f0000/physical/x` }));
  fs.mkdirSync(path.join(root, 'scene-packs', CONTROL), { recursive: true });
  const g = level4Points(root);
  assert.deepEqual(g.map((x) => [x.pack, x.frame, x.ref, x.judged]), [['h', 0, 'sha256:a', true], ['h', 1, 'sha256:b', true], ['p', 0, 'sha256:c', true], ['l4-link', 0, 'sha256:d', false], [CONTROL, 0, 'sha256:f', false]]);
  write([pt('l4/a/1', 'h', 0, 'sha256:a'), pt('l4/a/2', 'h', 0, 'sha256:z')]);
  assert.throws(() => level4Points(root), /指向不同的参考包/);
});

test('能量比与灯组自检：整帧和之比；灯组之和对 color 的最大相对差（两边都是 0 记 0）', () => {
  const conv = Float32Array.from([1, 2, 3, 4]);
  assert.ok(Math.abs(energyRatio([Float32Array.from([1, 2, 3, 4]), Float32Array.from([1.1, 2, 3, 4])], conv) - (10 + 10.1) / 2 / 10) < 1e-6);
  assert.equal(energyRatio([conv], new Float32Array(4)), null);
  assert.deepEqual(ENERGY, [0.97, 1.03]);
  const layers = { color: Float32Array.from([1, 0, 2]), 'lightgroup:a': Float32Array.from([0.5, 0, 2]), 'lightgroup:b': Float32Array.from([0.5, 0, 0]) };
  assert.equal(groupSumError(layers), 0);
  layers['lightgroup:b'][2] = 2e-5;
  assert.ok(Math.abs(groupSumError(layers) - 1e-5) < 1e-9);
});

test('内核侧的链接场景：写出的包过读入器能读的写法，灯只链接到另一个物体；负对照的注入各改一处', () => {
  const spec = linkScenePack();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'level4-link-'));
  try {
    const files = writePack(dir, spec);
    assert.deepEqual(files.map((f) => f.path), ['frames/camera.f32', 'frames/instances.f32', 'frames/lights.f32', 'geometry.glb', 'instances.u32', 'pack.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(spec.manifest.lights[0].link, ['other']);
  assert.deepEqual(spec.manifest.world.color, [0, 0, 0]);
  assert.equal(NEGATIVES.length, 3);
  for (const n of NEGATIVES) for (const i of n.inject) assert.ok(fs.readFileSync(path.join(OUT, '..', '..', 'beiming', 'sources', 'core', i.file), 'utf8').split(i.from).length === 2, `${n.name}：${i.file} 里要恰好有一处「${i.from}」`);
});

const built = () => fs.existsSync(path.join(OUT, 'bin', `core-render-${sourceKey([])}${process.platform === 'win32' ? '.exe' : ''}`));

test('端到端：l4/a 与 l4/b 逐通道过两道门，能量比在范围里，自检与链接过，负对照判得出', { timeout: 14_400_000 }, async (t) => {
  if (!ROOT) { t.skip('没设 BEIMING_CORE_LADDER_ROOT（参考包由标准答案机出，不在仓库里）'); return; }
  if (!E2E && !built()) { t.skip('没有编好的渲染程序（设 BEIMING_CHASSIS_E2E=1 现编）'); return; }
  let rep;
  try {
    rep = await runLevel4({ root: ROOT, log: (s) => t.diagnostic(s) });
  } catch (e) {
    if (e.missing && !E2E) { t.skip(`缺：${e.missing}`); return; }
    throw e;
  }
  for (const r of rep.rows) {
    t.diagnostic(`${r.pack}#${r.frame}: ${r.channels.map((c) => `${c.name} ${c.floor.status}/${c.welch.pass} ${c.energy ?? ''}`).join('；')}`);
    if (r.judged) assert.ok(r.gatesOk, `${r.pack} 第 ${r.frame} 帧两道门不过`);
    assert.ok(r.energyOk, `${r.pack} 第 ${r.frame} 帧有灯组的能量比出了 [${ENERGY}]`);
    assert.ok(r.selfOk, `${r.pack} 第 ${r.frame} 帧灯组之和对 color 差 ${r.selfCheck}`);
  }
  assert.ok(rep.link.constructed.ok, `链接场景里被排除的灯的灯组最大 ${rep.link.constructed.keyMax}`);
  for (const n of rep.negatives) assert.ok(n.caught, `负对照 ${n.name} 判不出`);
  assert.ok(rep.ok);
});
