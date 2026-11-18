// 起无头、静音的浏览器实渲：帧源不许把清屏值留给下一次 render。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openHost } from '../../host/page/host.mjs';

const FILM = new URL('../../kernel/conformance/fixtures/film.json', import.meta.url).pathname;
const pixel0 = (r) => [...new Float32Array(new Uint8Array(Buffer.from(r.layers.color.base64, 'base64')).buffer, 0, 4)];

/** 同一帧渲三次：这个渲染器的第一次 render、中间夹一次带辅助层的、再渲一次 */
async function firstAndLater(t, shotId) {
  let host;
  // 这台机器起不了浏览器（比如只跑单元测试的 CI 没装）时跳过，不算失败
  try { host = await openHost({ filmPath: FILM, shotId, tier: 'final' }); } catch (e) { t.skip(`起不了浏览器：${String(e.message).split('\n')[0]}`); return null; }
  try {
    await host.openSession();
    const first = await host.render(24, {}, ['color']);
    const withAux = await host.render(24, {}, ['color', 'depth', 'objectId', 'normal']);
    const later = await host.render(24, {}, ['color']);
    return { first, withAux, later };
  } finally {
    await host.close();
  }
}

test('不设背景的镜头：同一帧先渲和后渲颜色层逐位相同，背景清成 (0, 0, 0, 0)', async (t) => {
  const r = await firstAndLater(t, 's02');
  if (!r) return;
  const { first, withAux, later } = r;
  assert.match(first.meta.hash.color, /^sha256:[0-9a-f]{64}$/);
  assert.equal(later.meta.hash.color, first.meta.hash.color);
  assert.equal(withAux.meta.hash.color, first.meta.hash.color);
  assert.equal(later.layers.color.base64, first.layers.color.base64);
  assert.deepEqual(pixel0(first), [0, 0, 0, 0]);
});

test('设了背景色的镜头：背景是背景色、透明度 1，先渲后渲也相同', async (t) => {
  const r = await firstAndLater(t, 's01');
  if (!r) return;
  const { first, later } = r;
  assert.equal(later.meta.hash.color, first.meta.hash.color);
  assert.deepEqual(pixel0(first), [0, 0, 0, 1]);
});
