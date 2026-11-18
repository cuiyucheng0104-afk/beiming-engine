import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadContracts } from '../../kernel/contracts/validate.mjs';
import { caps, VERSION } from './caps.mjs';
import { planRender, SourceError } from './plan.mjs';

const CAPS = caps();
const SHOT = { shutter: { angleDeg: 180, samples: 4 }, tiers: { final: { samples: 1, scale: 1 } } };
const plan = (opts, want, shot = SHOT, tier = 'final') => planRender(CAPS, shot, [640, 360], tier, opts, want);
const code = (c) => (e) => e instanceof SourceError && e.code === c;

test('能力声明过契约的校验，版本就是装着的那个 three', async () => {
  const { validate } = await loadContracts();
  const v = validate(CAPS);
  assert.deepEqual([v.schemaErrors, v.violations], [[], {}]);
  assert.deepEqual(caps(), CAPS);
  const pkg = JSON.parse(readFileSync(new URL('../../../node_modules/three-webgpu/package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, VERSION);
});

test('要了没声明过的输出就报错，不少交', () => {
  assert.throws(() => plan({}, ['color', 'motion']), code('contract.unsupported-output'));
  assert.throws(() => plan({}, ['color', 'lightgroup:key']), code('contract.unsupported-output'));
  // 同时踩中快门矛盾时，报的是没声明过的输出
  assert.throws(() => plan({ shutter: { angleDeg: 0, samples: 4 } }, ['color', 'motion']), code('contract.unsupported-output'));
});

test('生效的快门：这次调用给了用它的，没给用镜头条目的；快门角 0 配多个采样报错', () => {
  assert.deepEqual(plan({}, ['color']).subs, [0.0625, 0.1875, 0.3125, 0.4375]);
  const own = plan({ shutter: { angleDeg: 90, samples: 1 } }, ['color']);
  assert.deepEqual([own.angleDeg, own.shutterSamples, own.subs], [90, 1, [0.125]]);
  assert.deepEqual(plan({}, ['color'], {}).subs, [0]);
  assert.throws(() => plan({ shutter: { angleDeg: 0, samples: 2 } }, ['color', 'meta']), code('contract.shutter-conflict'));
});

test('没要颜色层就不出像素；辅助层只在要了的时候出', () => {
  assert.deepEqual(plan({}, ['meta', 'depth']).layers, []);
  assert.equal(plan({}, ['meta', 'depth']).aux, false);
  assert.deepEqual(plan({}, ['color', 'meta', 'objectId']).layers, ['color', 'objectId']);
  assert.equal(plan({}, ['color', 'meta']).aux, false);
  assert.equal(plan({}, ['color', 'normal']).aux, true);
});

test('尺寸和每像素采样数：档位、镜头条目、这次调用依次覆盖', () => {
  assert.deepEqual(plan({}, ['color']).size, [640, 360]);
  assert.deepEqual(plan({}, ['color'], { shutter: SHOT.shutter }, 'draft').size, [320, 180]);
  assert.deepEqual(plan({ scale: 0.25 }, ['color']).size, [160, 90]);
  assert.throws(() => plan({ samples: 4 }, ['color']), SourceError);
  assert.throws(() => plan({ scale: 2 }, ['color']), RangeError);
});

test('辅助层画不了的对象：看得见的点、线、精灵；网格和藏起来的不算', async () => {
  const THREE = await import('three-webgpu');
  const { unrenderableInAux } = await import('./source.js');
  const scene = new THREE.Scene(), group = new THREE.Group(), hidden = new THREE.Group();
  const sprite = new THREE.Sprite(), points = new THREE.Points(), line = new THREE.Line();
  hidden.visible = false;
  hidden.add(new THREE.Sprite());
  group.add(points);
  scene.add(new THREE.Mesh(), sprite, group, line, hidden);
  assert.deepEqual(unrenderableInAux(scene), [sprite, points, line]);
  scene.remove(sprite, group, line);
  assert.deepEqual(unrenderableInAux(scene), []);
});
