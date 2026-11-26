// 逐帧推进十帧：一个 10 帧的场景包（scenepack.mjs 的 movingPack，板与相机每帧都挪），core-render render-pack 按帧号 0 到 9
// 连续渲，再打乱次序渲一遍。场景包每帧状态表第 k 行就是镜头局部帧号 k、sub = 0 这一时刻的状态（场景包契约 5.2 与第 6 节）。
// 这份测试自己断言三件事，都由测试工具从产物量：编号层逐像素对第 j 行状态的解析编号图（照场景规格自己求交），恰好第 k 行
// 对得上；板内部的覆盖率全是 1（颜色样本在板内部打到的都是辅助样本那块板）；同一帧两种出帧次序的状态摘要相同。
// 时间核对记录（time-check/0.1）只写 evaluations：f、sub、mode 是测试工具请求的，digest 是它对产物自己算的，交给时间键
// 契约的 T1。frames[] 不写：它的 f、samples、aux 来历是「旁观」，要夹具镜头代码里的观测点，核心帧源没有镜头代码、也就没有
// 这样的观测点（时间键契约 3.6：没有观测点时那一项不出现）。所以 T4、T5、T8、T9 这里不判，原来改 frames[] 的三个负对照
// （帧号写成全片帧号、采样挪到半帧、辅助样本挪到半帧）也跟着删了。留下的负对照：摘要改掉 T1 要拒；相邻两行状态的编号图分得开。
// 要渲染程序与显卡：BEIMING_CHASSIS_E2E=1 时现编、渲不出来算失败；否则只用编好的那份，没有或渲不出来就跳过。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { checks } from '../../../kernel/contracts/time/check.mjs';
import { loadContracts } from '../../../kernel/contracts/validate.mjs';
import { OUT, PRESETS, buildRenderer, sourceKey } from './build.mjs';
import { camera, f32s, hit, objects } from './moving.mjs';
import { movingPack, translate, writePack } from './scenepack.mjs';

const E2E = process.env.BEIMING_CHASSIS_E2E === '1';
const EXE = process.platform === 'win32' ? '.exe' : '';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-advance-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const [W, H, COUNT, START, SPP] = [96, 54, 10, 100, 4];
const SPEC = { board: k => translate(0.12 * k - 0.5, 0.03 * k, 0), camera: k => translate(0.02 * k, 0, 3) };

function renderer(t) {
  if (E2E) return buildRenderer().bin;
  const bin = path.join(OUT, 'bin', `core-render-${sourceKey([])}${EXE}`);
  if (fs.existsSync(bin)) return bin;
  t.skip('没有编好的渲染程序（设 BEIMING_CHASSIS_E2E=1 现编）');
  return null;
}

let n = 0;
function render(bin, pack, frame) {
  const out = path.join(TMP, `r${n++}`);
  const env = { ...process.env };
  delete env.THREERT_MERGED;
  const r = spawnSync(bin, ['render-pack', pack, '--frame', String(frame), '-o', path.join(out, 'out.png'), '--spp', String(SPP), '--width', String(W), '--height', String(H), '--no-denoise', '--passes', out, '--presets', PRESETS], { encoding: 'utf8', env, maxBuffer: 1 << 26 });
  if (r.status !== 0) return { error: r.stderr.trim().split('\n').at(-1) };
  const read = f => fs.readFileSync(path.join(out, f));
  const b = read('objectId.u32'), c = read('objectId.coverage.f32');
  // 状态摘要：辅助四层与颜色层的字节一起
  const digest = createHash('sha256');
  for (const f of ['color.f32', 'depth.f32', 'objectId.u32', 'normal.f32', 'motion.f32']) digest.update(read(f));
  return { id: new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4), coverage: new Float32Array(c.buffer, c.byteOffset, c.byteLength / 4), digest: digest.digest('hex') };
}

/** 第 j 行状态的解析编号图：离板边 1.5 厘米以内的像素不算（null） */
const expected = j => {
  const c = camera(f32s(SPEC.camera(j)), W, H);
  return Array.from({ length: W * H }, (_, p) => hit(c, objects(SPEC, j), p % W, Math.floor(p / W), 0.015)?.id ?? null);
};
const MAPS = Array.from({ length: COUNT }, (_, j) => expected(j));
const mismatches = (got, map) => map.reduce((s, id, p) => s + (id !== null && got.id[p] !== id ? 1 : 0), 0);

test(`逐帧推进 ${COUNT} 帧：编号层恰好对上状态表第 k 行，板内部覆盖率全 1，两种出帧次序摘要相同；时间核对记录只判 T1，负对照不过`, async (t) => {
  const bin = renderer(t);
  if (!bin) return;
  const pack = path.join(TMP, 'pack');
  writePack(pack, movingPack({ count: COUNT, ...SPEC }));
  const shot = { id: 's02', start: START, frames: COUNT, seed: 0, shutterAngleDeg: 0 };
  const evaluations = [], digests = {};
  const order = { sequential: [...Array(COUNT).keys()], shuffled: [7, 2, 9, 0, 5, 3, 8, 1, 6, 4] };
  for (const [mode, ks] of Object.entries(order)) {
    for (const k of ks) {
      const r = render(bin, pack, k);
      if (r.error) {
        if (!E2E) { t.skip(`渲不出来（多半是没有显卡）：${r.error}`); return; }
        assert.fail(r.error);
      }
      // 量：哪一行状态的编号图和编号层对得上
      const rows = MAPS.map((map, j) => [j, mismatches(r, map)]).filter(([, m]) => m === 0).map(([j]) => j);
      assert.deepEqual(rows, [k], `第 ${k} 帧（${mode}）对得上的状态行是 ${rows}`);
      // 板内部（解析编号是板、四邻也是板）的覆盖率全是 1
      const map = MAPS[k];
      const inner = map.map((id, p) => id === 1 && [p - 1, p + 1, p - W, p + W].every(q => map[q] === 1)).reduce((a, ok, p) => (ok ? [...a, p] : a), []);
      assert.ok(inner.length > 200 && inner.every(p => r.coverage[p] === 1), `第 ${k} 帧板内部 ${inner.length} 个像素的覆盖率不全是 1`);
      (digests[k] ??= {})[mode] = r.digest;
      evaluations.push({ shot: shot.id, f: k, sub: 0, mode, digest: r.digest });
    }
  }
  for (let k = 0; k < COUNT; k++) assert.equal(digests[k].shuffled, digests[k].sequential, `第 ${k} 帧两种出帧次序的状态摘要不同`);
  const rec = { format: 'time-check/0.1', fps: '24/1', shots: [{ id: 's01', start: 0, frames: START, seed: 0, shutterAngleDeg: 0 }, shot], evaluations };
  const { validate } = await loadContracts();
  assert.deepEqual(validate(rec), { contract: 'time', schemaErrors: [], violations: {} });

  // 负对照：摘要改掉一项，T1 要拒
  const bad = structuredClone(rec);
  bad.evaluations[0].digest = '0'.repeat(64);
  assert.ok(checks.T1(bad).length > 0, 'T1 没拒摘要不同');
  // 负对照：每一帧和相邻一行状态都对不上（量法分得出差一帧）
  for (let k = 0; k + 1 < COUNT; k++) assert.ok(mismatches({ id: Uint32Array.from(MAPS[k], x => x ?? 0) }, MAPS[k + 1]) > 0, `第 ${k}、${k + 1} 行的编号图分不开`);
});
