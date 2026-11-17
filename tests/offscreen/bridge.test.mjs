// 几何桥（engine/offscreen/bridge.mjs）：engine/form 的造型（three r170）拷进 r187 后属性、索引、包围盒不变。缺可选依赖时跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { geometry } from '../../engine/offscreen/bridge.mjs';
import { spire, mesa } from '../../engine/form/rock.js';
import { boatHull } from '../../engine/form/props.js';
import { pineTree } from '../../engine/form/plants.js';
import { mulberry } from '../../engine/core/math.js';

test('spire / mesa / pineTree / boatHull：拷进 r187 后属性、索引与包围盒都不变', async t => {
  let THREE;
  try { ({ THREE } = await (await import('../../engine/offscreen/load.mjs')).loadGpu()); }
  catch (e) { if (String(e.code).startsWith('env.')) return t.skip(`离屏依赖不可用：${e.message}`); throw e; }
  const R = mulberry(7);
  const cases = {
    spire: spire(R, 132, 18, { steps: 4 }),
    mesa: mesa(R, { cx: 0, cz: 0, rx: 30, rz: 20, yTop: () => 10, yBot: () => -4 }),
    pineTree: pineTree(3),
    boatHull: boatHull(14, 3.2, 1.4),
  };
  for (const [name, g] of Object.entries(cases)) {
    const h = geometry(THREE, g);
    assert.ok(h instanceof THREE.BufferGeometry, name);
    assert.deepEqual(Object.keys(h.attributes).sort(), Object.keys(g.attributes).sort(), `${name}：属性名`);
    for (const k of Object.keys(g.attributes)) assert.equal(h.attributes[k].array, g.attributes[k].array, `${name}.${k}：共用同一块数组`);
    assert.equal(!!h.index, !!g.index, `${name}：索引`);
    g.computeBoundingBox(); h.computeBoundingBox();
    assert.deepEqual(h.boundingBox.min.toArray(), g.boundingBox.min.toArray(), `${name}：包围盒`);
    assert.equal(h.userData, g.userData);
  }
});
