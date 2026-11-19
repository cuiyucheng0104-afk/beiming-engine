import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadContracts } from '../../kernel/contracts/validate.mjs';
import { caps, VERSION } from './caps.mjs';
import { planOpen, planRender, SourceError } from './plan.mjs';

const CAPS = caps();
const SHOT = { shutter: { angleDeg: 180, samples: 4 }, tiers: { final: { samples: 1, scale: 1 } } };
const plan = (opts, want, shot = SHOT, tier = 'final', locked) => planRender(CAPS, shot, [640, 360], tier, opts, want, locked);
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
  // 哪里都没写子帧采样数：开着快门用能力声明的默认值，不开取 1；锁文件里记了就用锁里的，这次调用给了还是用这次的
  assert.equal(plan({}, ['color'], { shutter: { angleDeg: 180 } }).shutterSamples, CAPS.motionBlur.samples);
  assert.equal(plan({}, ['color'], { shutter: { angleDeg: 180 } }, 'final', { shutterSamples: 3 }).shutterSamples, 3);
  assert.equal(plan({ shutter: { angleDeg: 90, samples: 2 } }, ['color'], SHOT, 'final', { shutterSamples: 3 }).shutterSamples, 2);
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
  // 镜头条目没写档位的值时用能力声明里这个档位的
  assert.deepEqual([plan({}, ['color'], {}).size, plan({}, ['color'], {}).pixelSamples], [[640, 360], CAPS.final.samples]);
  assert.throws(() => plan({ samples: 4 }, ['color']), code('contract.unsupported-option'));
  for (const bad of [{ scale: 2 }, { scale: 0 }, { samples: 0 }, { shutter: { angleDeg: 400, samples: 1 } }, { shutter: { angleDeg: 90, samples: 0 } }]) assert.throws(() => plan(bad, ['color']), code('usage.bad-argument'), JSON.stringify(bad));
  assert.throws(() => plan({}, ['color', 'color']), code('usage.bad-argument'));
  assert.throws(() => plan({}, 'color'), code('usage.bad-argument'));
});

test('装载之前：没有锁文件时种子必须写在镜头条目里，用了卡或资产必须报错；宿主或作者模式不在能力声明里先报这一条；带 renderer 对象时看它里面的那一套', async () => {
  const input = (patch = {}, more = {}) => ({ film: 'f_x', output: { size: [640, 360], fps: '24/1' }, shot: { id: 's01', in: 0, out: 10, source: 'three', host: 'page', mode: 'native-code', entry: 'a.js', colorRef: 'scene', seed: 7, ...patch }, ...more });
  const env = { lock: null, tier: 'final' }, lock = { seeds: { film: 1, s01: 9 }, shots: { s01: { shutterSamples: 5 } } };
  // 卡实例照片子描述的写法：as、use、params 三个都写
  const CARD = { as: 'probe', use: 'probe.card@1', params: {} }, OVERLAY = { id: 'tag', shot: 's01', anchor: 'screen', pos: [0.5, 0.5], text: 'x', in: 0, out: 5 };
  const { validate } = await loadContracts();
  for (const probe of [input({ cards: [CARD] }), input({}, { overlays: [OVERLAY] })]) assert.deepEqual(validate(probe, 'source', 'shot-input.schema.json').schemaErrors, []);
  assert.deepEqual(planOpen(CAPS, input(), env), { seed: 7 });
  assert.deepEqual(planOpen(CAPS, input({ cards: [], assets: {} }), env), { seed: 7 });
  assert.deepEqual(planOpen(CAPS, input(), { ...env, lock }), { seed: 9, shutterSamples: 5 });
  assert.throws(() => planOpen(CAPS, input({ seed: undefined }), env), code('env.lock-required'));
  assert.throws(() => planOpen(CAPS, input({ cards: [CARD] }), env), code('env.lock-required'));
  assert.throws(() => planOpen(CAPS, input({ assets: { kit: 'asset:kit@1' } }), env), code('env.lock-required'));
  assert.throws(() => planOpen(CAPS, input({ mode: 'cards-data' }), env), code('contract.unsupported-mode'));
  assert.throws(() => planOpen(CAPS, input({ host: 'cycles', seed: undefined }), env), code('contract.unsupported-mode'));
  assert.throws(() => planOpen(CAPS, input({ source: 'blender' }), env), code('usage.bad-argument'));
  // 全片的资产表和镜头条目的一样算「用了资产」；空的不算
  assert.throws(() => planOpen(CAPS, input({}, { assets: { vo: 'asset:vo@1' } }), env), code('env.lock-required'));
  assert.deepEqual(planOpen(CAPS, input({}, { assets: {}, overlays: [], events: { events: [] } }), env), { seed: 7 });
  // 叠加层、带着锁文件来的卡和资产都装不了：报装不了的那个码，不装作没看见；没写种子时先报没有锁文件的那个码，宿主不在能力声明里时先报那一条
  assert.throws(() => planOpen(CAPS, input({}, { overlays: [OVERLAY] }), env), code('contract.unsupported-input'));
  assert.throws(() => planOpen(CAPS, input({}, { overlays: [OVERLAY] }), { ...env, lock }), code('contract.unsupported-input'));
  assert.throws(() => planOpen(CAPS, input({ cards: [CARD] }), { ...env, lock }), code('contract.unsupported-input'));
  assert.throws(() => planOpen(CAPS, input({}, { assets: { vo: 'asset:vo@1' } }), { ...env, lock }), code('contract.unsupported-input'));
  assert.throws(() => planOpen(CAPS, input({ seed: undefined }, { overlays: [OVERLAY] }), env), code('env.lock-required'));
  assert.throws(() => planOpen(CAPS, input({ host: 'cycles', cards: [CARD] }), { ...env, lock }), code('contract.unsupported-mode'));
  // 顶层那一套留作对照：出帧的是 renderer 里写的 three，就装得了；renderer 里的宿主不在能力声明里就装不了
  const core = { source: 'core', host: 'offscreen', mode: 'cards-data', entry: undefined };
  assert.deepEqual(planOpen(CAPS, input({ ...core, renderer: { source: 'three', host: 'page', mode: 'native-code', entry: 'a.js' } }), env), { seed: 7 });
  assert.throws(() => planOpen(CAPS, input({ renderer: { source: 'three', host: 'offscreen', mode: 'native-code', entry: 'a.js' } }), env), code('contract.unsupported-mode'));
  assert.throws(() => planOpen(CAPS, input({ renderer: { source: 'core', host: 'offscreen', mode: 'cards-data' } }), env), code('usage.bad-argument'));
  assert.throws(() => planOpen(CAPS, input(), { lock: null, tier: 'preview' }), code('usage.bad-argument'));
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
