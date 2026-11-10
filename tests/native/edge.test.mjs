// B 路线底板边缘策略（engine/native/edge.mjs）：参数校验、表达式结构；本机有 FFmpeg 时实际烘一张小图，
// 核对截断边的 alpha 被削弱、对边与 RGB 不变（直通 alpha、透明区填色的约定不被破坏）；
// 例片云堤烘圆形收边后，用 QA 门（tools/qa/lib/plate-edges.mjs）的找边检测核对不再有直线淡出（QA-B-001 的回归）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyEdge, checkCrop, checkEdge, edgeExpr, imageFilter } from '../../engine/native/edge.mjs';
import { EXIT } from '../../engine/native/cli.mjs';

test('checkEdge：字段、范围、至少一条边', () => {
  assert.doesNotThrow(() => checkEdge({ left: 0.1, jitter: 0.5, lobes: 4, seed: 2 }));
  for (const bad of [null, [], { left: 0.6 }, { nope: 1 }, { jitter: 0.5 }, { left: 0.1, jitter: 2 }, { left: -0.1 }]) {
    assert.throws(() => checkEdge(bad), e => e.exitCode === EXIT.CONTRACT, JSON.stringify(bad));
  }
});

test('edgeExpr：只给声明的边乘软边因子，alpha 以原值为底', () => {
  const e = edgeExpr({ left: 0.1, bottom: 0.2, jitter: 0.5, lobes: 3, seed: 1 });
  assert.ok(e.startsWith('alpha(X,Y)*'));
  assert.equal((e.match(/st\(0,/g) || []).length, 2);
  assert.ok(e.includes('X/W') && e.includes('(H-1-Y)/H'));
  assert.ok(!e.includes('(W-1-X)/W'), '没声明右边就不动右边');
  assert.notEqual(edgeExpr({ left: 0.1, seed: 1 }), edgeExpr({ left: 0.1, seed: 2 }), 'seed 换一组相位');
});

const hasFFmpeg = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-version'], { timeout: 10000 }).status === 0;

test('applyEdge：截断边 alpha 变小，对边与颜色不变', { skip: !hasFFmpeg && '本机没有 FFmpeg' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bne-edge-'));
  try {
    const ff = process.env.FFMPEG || 'ffmpeg';
    const src = join(dir, 'src.png'), out = join(dir, 'out.png');
    assert.equal(spawnSync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x8040c0:s=200x100,format=rgba', '-frames:v', '1', src], { timeout: 30000 }).status, 0);
    await applyEdge(src, out, { left: 0.2, jitter: 0.3, lobes: 3, seed: 1 });
    const raw = spawnSync(ff, ['-v', 'error', '-i', out, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { timeout: 30000, maxBuffer: 1 << 24 }).stdout;
    const px = (x, y) => raw.subarray((y * 200 + x) * 4, (y * 200 + x) * 4 + 4);
    assert.equal(px(0, 50)[3], 0, '最左一列透明');
    assert.equal(px(199, 50)[3], 255, '右边不动');
    assert.ok(px(10, 50)[3] < 255 && px(10, 50)[3] < px(60, 50)[3] + 1, '越靠截断边越透明');
    assert.deepEqual([...px(0, 50).subarray(0, 3)], [0x80, 0x40, 0xc0], '透明区 RGB 保留（直通 alpha）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('round：圆形收边让淡出起点沿边按抛物线往里收；round = 0 与旧写法逐字相同', () => {
  const plain = { left: 0.1, jitter: 0.5, lobes: 3, seed: 1 };
  assert.equal(edgeExpr({ ...plain, round: 0 }), edgeExpr(plain), 'round = 0 不改表达式（已有素材的哈希不变）');
  const r = edgeExpr({ ...plain, round: 1, center: 0.4 });
  assert.match(r, /pow\(\(Y\/H-0\.400000\)\/0\.600000,2\)/, '离 center 的距离按较远一侧归一');
  assert.throws(() => checkEdge({ left: 0.1, round: 1.5 }), e => e.exitCode === EXIT.CONTRACT);
  assert.throws(() => checkEdge({ left: 0.1, lobes: 0 }), e => e.exitCode === EXIT.CONTRACT);
  assert.throws(() => checkCrop([0.5, 0, 0.6, 1]), e => e.exitCode === EXIT.CONTRACT, '裁出原图');
  assert.doesNotThrow(() => checkCrop([0, 0.1, 0.4, 0.8]));
  assert.equal(imageFilter({ crop: [0, 0, 0.5, 1], flip: true }), 'format=rgba,crop=w=trunc(iw*0.500000/2)*2:h=trunc(ih*1.000000/2)*2:x=trunc(iw*0.000000):y=trunc(ih*0.000000),hflip');
});

test('例片的云堤（QA-B-001）：烘过圆形收边后，QA 门的找边检测不再报直线淡出', { skip: !hasFFmpeg && '本机没有 FFmpeg' }, async () => {
  const { analyzePlate } = await import('../../tools/qa/lib/plate-edges.mjs');
  const film = JSON.parse(readFileSync(new URL('../../examples/raea/film.json', import.meta.url), 'utf8'));
  const im = film.native.images.find(i => i.to === 'clouds_back.png');
  assert.ok(im.edge?.round >= 0.5 && im.edge.left >= 0.15 && im.edge.right >= 0.15, '云堤两端要烘圆形收边');
  const src = fileURLToPath(new URL('../../assets/plates/clouds_back.png', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'bne-bank-'));
  try {
    const before = await analyzePlate(src);
    assert.deepEqual(before.edges.filter(e => e.kind === 'straight-fade').map(e => e.side).sort(), ['left', 'right'], '原图两端是直线淡出（台账 QA-B-001 的证据）');
    const out = join(dir, 'bank.png');
    await applyEdge(src, out, im.edge);
    const after = await analyzePlate(out);
    assert.deepEqual(after.edges, [], `收边后不应再有直线边：${JSON.stringify(after.edges)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
