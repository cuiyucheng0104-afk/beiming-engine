// 起无头、静音的浏览器实渲：帧源不许把清屏值留给下一次 render；什么都没打到的像素各层写约定的值；层引用对得上层文件。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startSource } from '../../host/page/host.mjs';
import { shotInput } from '../../kernel/eval/input.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../kernel/conformance/fixtures');
const film = JSON.parse(await readFile(join(FIXTURES, 'film.json'), 'utf8'));

/** 同一帧渲三次：这个会话的第一次 render、中间夹一次带辅助层的、再渲一次。交回各次的结果和读层文件的函数 */
async function firstAndLater(t, shotId) {
  let source;
  // 这台机器起不了浏览器（比如只跑单元测试的 CI 没装）时跳过，不算失败
  try { source = await startSource(); } catch (e) { t.skip(`起不了浏览器：${String(e.message).split('\n')[0]}`); return null; }
  const workspace = await mkdtemp(join(tmpdir(), 'beiming-three-'));
  try {
    const session = await source.open(shotInput(film, shotId), { lock: null, tier: 'final', workspace, filmDir: FIXTURES });
    const first = await session.render(24, {}, ['color']);
    const withAux = await session.render(24, {}, ['color', 'depth', 'objectId', 'normal']);
    const later = await session.render(24, {}, ['color']);
    const layers = {};
    for (const [name, ref] of Object.entries({ first: first.layers.color, later: later.layers.color, ...withAux.layers })) {
      const bytes = await readFile(join(workspace, ref.file));
      assert.equal(ref.hash, `sha256:${createHash('sha256').update(bytes).digest('hex')}`, name);
      assert.equal(bytes.length, ref.shape[0] * ref.shape[1] * ref.shape[2] * 4, name);
      layers[name] = name === 'objectId' ? new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4) : new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
    }
    await session.close();
    return { first, withAux, later, layers };
  } finally {
    await source.stop();
    await rm(workspace, { recursive: true, force: true });
  }
}

test('不设背景的镜头：同一帧先渲和后渲颜色层逐位相同，背景清成 (0, 0, 0, 0)；什么都没打到的像素编号 0、深度 1e10、法线 (0, 0, 0)', async (t) => {
  const r = await firstAndLater(t, 's02');
  if (!r) return;
  const { first, withAux, later, layers } = r;
  assert.equal(later.layers.color.hash, first.layers.color.hash);
  assert.equal(withAux.layers.color.hash, first.layers.color.hash);
  assert.equal(first.meta.hash.color, first.layers.color.hash);
  // 这个镜头的条目顶层写的帧源留作对照，出帧的是 renderer 对象里写的
  assert.deepEqual([first.meta.source.id, first.meta.source.renderer, first.meta.source.host], ['core', 'three', 'page']);
  assert.deepEqual(first.layers.color.shape, [360, 640, 4]);
  assert.deepEqual([...layers.first.subarray(0, 4)], [0, 0, 0, 0]);
  assert.deepEqual([layers.objectId[0], layers.depth[0], ...layers.normal.subarray(0, 3)], [0, 1e10, 0, 0, 0]);
  // 画面正中是方块：这是场景参考镜头，场景画进 RGBA16F 目标（04 §4.1），读回的是规格里的 0.18 两边的半浮点数之一
  // （1474 或 1475 个 2 的 −13 次方，往哪边舍看显卡后端），不是 0.18 取单精度
  const center = 180 * 640 + 320;
  assert.ok([1474, 1475].includes(layers.first[center * 4] * 2 ** 13), `方块的颜色 ${layers.first[center * 4]}`);
  assert.ok(layers.objectId[center] > 0 && layers.depth[center] < 10 && layers.normal[center * 3 + 2] === 1);
});

test('设了背景色的镜头：背景是背景色、透明度 1，先渲后渲也相同', async (t) => {
  const r = await firstAndLater(t, 's01');
  if (!r) return;
  assert.equal(r.later.layers.color.hash, r.first.layers.color.hash);
  assert.deepEqual([...r.layers.first.subarray(0, 4)], [0, 0, 0, 1]);
});
