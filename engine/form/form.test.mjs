// engine/form 的回归测试（Node，不需要 GPU）：node --test engine/form/form.test.mjs
// 着色器真正编译、GPU 与 JS 镜像对位的验证在 engine/look/gpu.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as BEND from './bend.js';
import { flowerHead } from './props.js';
import { loftRings } from './loft.js';
import { poseEyes } from './eye.js';
import { instanced } from './scatter.js';

const FORMS = {
  pitchWave: ['T', 'Amp', 'Wave', 'Omega', 'HalfL'],
  pitchYawWave: ['T', 'Amp', 'AmpZ', 'Wave', 'Omega', 'HalfL', 'PhZ'],
  pitchYawLinearWave: ['T', 'Amp', 'AmpZ', 'Wave', 'Omega', 'HalfL', 'PhZ'],
  frameWave: ['T', 'AmpY', 'AmpZ', 'Wave', 'Omega', 'HalfL', 'PhY'],
};
const VAL = { T: .7, Amp: .35, AmpY: .35, AmpZ: .3, Wave: 1, Omega: 2, HalfL: 1, PhZ: .5, PhY: .3 };
const uniforms = (name, p) => { const u = 'u' + p[0].toUpperCase() + p.slice(1), U = {}; for (const k of FORMS[name]) U[u + k] = { value: VAL[k] }; return U; };
// 统计 GLSL 里函数 <名> 的定义次数（返回类型 + 名字 + 左括号）
const defs = (src, fn) => (src.match(new RegExp(`\\b(?:vec3|vec2|vec4|float|mat4|void)\\s+${fn}\\s*\\(`, 'g')) || []).length;

test('R34 四种弯曲形式的 rigid 模式都带 BendRigid 定义（材质钩子与 ID 图钩子），JS 镜像也有 rigid', () => {
  for (const name of Object.keys(FORMS)) {
    const p = 'r34' + name.length, f = BEND[name](p), U = uniforms(name, p);
    const h = f.modeHooks(U, { mode: 'rigid' });
    assert.ok(h.vertexBegin.includes(`${p}BendRigid(`), `${name} 用到了 BendRigid`);
    assert.equal(defs(h.vertexPars, `${p}BendRigid`), 1, `${name} 材质钩子里有且只有一份 BendRigid`);
    assert.equal(defs(h.outlineVertex.head, `${p}BendRigid`), 1, `${name} ID 图钩子里有 BendRigid`);
    const js = f.js(U);
    assert.equal(typeof js.rigid, 'function', `${name} 的 JS 镜像有 rigid`);
    // 刚体弯在轴位置 ax 处、点就在轴上（v.x = 0）时，与逐顶点弯曲结果一致（线性近似那种只在一阶上一致）
    for (const x of [-.6, .2]) {
      const q = new THREE.Vector3(x, .15, .1), r = js.rigid(q, x, VAL.T, new THREE.Vector3());
      if (js.point && name !== 'pitchYawLinearWave') { const pt = js.point(q, VAL.T, new THREE.Vector3()); assert.ok(r.distanceTo(pt) < 1e-12, `${name} rigid 与 point 在轴上重合`); }
      if (name === 'pitchWave') { const [dy, th] = js.bend(x, VAL.T); assert.ok(Math.abs(r.x - (x - .15 * Math.sin(th))) < 1e-12 && Math.abs(r.y - (dy + .15 * Math.cos(th))) < 1e-12); }
    }
    // 其它模式的着色器不带 rigid 专用函数（frameWave 一直写在 funcs 里）
    const v = f.modeHooks(U, { mode: 'vertex' });
    assert.equal(defs(v.vertexPars, `${p}BendRigid`), name === 'frameWave' ? 1 : 0);
  }
});

test('R36 同一材质两套弯曲：instanceMatrix 先 #undef 再重定义（不会宏重定义），逐层复合', () => {
  const a = BEND.pitchWave('aa').inst, b = BEND.pitchWave('bb').inst;
  for (const [s, p] of [[a, 'aa'], [b, 'bb']]) {
    const lines = s.split('\n').map(l => l.trim());
    const iDef = lines.indexOf(`#define instanceMatrix ${p}IM`), iUndef = lines.indexOf('#undef instanceMatrix'), iGet = lines.findIndex(l => l.startsWith(`mat4 ${p}GetIM()`));
    assert.ok(iGet >= 0 && iUndef > iGet && iDef > iUndef, `${p}：GetIM 在前、#undef 再 #define`);
    assert.equal(lines[iUndef - 1], '#ifdef instanceMatrix');
  }
});

test('R36 preBend / extraNormal 末尾不带换行也能让预处理指令落在行首；bend:false 不丢', () => {
  const f = BEND.pitchWave('cc');
  const h = f.hooks({ preBend: 'transformed.x += 1.0;', extraNormal: 'objectNormal = objectNormal;' });
  for (const k of ['vertexBegin', 'vertexNormal']) for (const line of h[k].split('\n')) if (line.includes('#')) assert.match(line, /^\s*#/, `${k}：「${line}」`);
  const nb = f.hooks({ bend: false, preBend: 'transformed.y += 0.3;', extraNormal: 'objectNormal = normalize( objectNormal );' });
  assert.ok(nb.vertexBegin.includes('transformed.y += 0.3;'), 'bend:false 时 preBend 保留');
  assert.ok(nb.vertexNormal.includes('normalize( objectNormal )'), 'bend:false 时 extraNormal 保留');
  // 原有调用的输出逐字不变（正片 src/kun.js 的写法）
  assert.deepEqual(f.hooks({ bend: false, extraPars: 'varying vec3 vLocal;\n', extraBegin: 'vLocal = position;' }), { vertexPars: 'varying vec3 vLocal;\n', vertexBegin: 'vLocal = position;' });
  assert.deepEqual(f.hooks({ bend: false }), {});
  const keep = f.hooks({ extraPars: 'varying vec3 vLocal;\n', extraBegin: 'vLocal = position;' });
  assert.equal(keep.vertexBegin, 'vLocal = position;\n#ifndef USE_INSTANCING\ntransformed = ccBendPos( transformed );\n#endif');
});

test('R38 flowerHead：花盘带 attrs 再加短柱、花苞，合并成功且属性补齐', () => {
  const disc = { rings: 3, segs: 12, lobes: 5, base: .4, amp: .6, sharp: 1, height: r => .3 + .2 * r * r, attrs: { aHeart: r => 1 - r } };
  const g = flowerHead({ disc, stalk: { r0: .2, r1: .3, h: .4, y: .2 }, bud: { r: .15, y: .45 } });
  assert.ok(g && g.attributes.aHeart, '返回几何体且带 aHeart');
  assert.equal(g.attributes.aHeart.count, g.attributes.position.count);
  // 短柱和花苞取花心（r = 0）的值
  const nDisc = (disc.rings) * disc.segs * 6, v = g.attributes.aHeart.array;
  for (let i = nDisc; i < v.length; i++) assert.equal(v[i], 1);
  // 不给 y：短柱底在 0，花苞在花心高度
  const g2 = flowerHead({ disc: { ...disc, attrs: {} }, stalk: { r0: .2, r1: .3, h: .4 }, bud: { r: .1 } });
  const p = g2.attributes.position.array; for (let i = 0; i < p.length; i++) assert.ok(Number.isFinite(p[i]), '没有 NaN 顶点');
});

test('R38 loftRings：声明了 attrs 而封口不给（或缺）同名属性时不崩，取那一环的平均值；给错分量数报错', () => {
  const rings = [0, 1, 2].map(x => [0, 1, 2, 3].map(k => new THREE.Vector3(x, Math.cos(k), Math.sin(k))));
  const data = []; for (let j = 0; j < 3; j++) for (let k = 0; k < 4; k++) data.push(j * 10 + k, 1);
  const g = loftRings(rings, { startCap: { p: new THREE.Vector3(-.5, 0, 0) }, endCap: { p: new THREE.Vector3(2.5, 0, 0), attr: {} }, attrs: { aX: { data, size: 2 } } });
  const a = g.attributes.aX.array, n = a.length / 2;
  assert.equal(n, 14);
  assert.deepEqual([a[(n - 2) * 2], a[(n - 2) * 2 + 1]], [1.5, 1]);    // 起始封口：第 0 环 (0..3) 的平均
  assert.deepEqual([a[(n - 1) * 2], a[(n - 1) * 2 + 1]], [21.5, 1]);   // 末端封口：第 2 环 (20..23) 的平均
  const one = loftRings(rings, { startCap: { p: new THREE.Vector3(), attr: { aY: 7 } }, attrs: { aY: { data: new Array(12).fill(0), size: 1 } } });
  assert.equal(one.attributes.aY.array.at(-1), 7, '单分量可以直接写数');
  assert.throws(() => loftRings(rings, { startCap: { p: new THREE.Vector3(), attr: { aX: [1] } }, attrs: { aX: { data, size: 2 } } }), /aX/);
});

test('R38 poseEyes：眼睛带 frame、不给 catches 时不崩，眼睑平面照常更新', () => {
  const mk = () => {
    const group = new THREE.Group(), ball = new THREE.Object3D(), lidU = new THREE.Object3D(), lidL = new THREE.Object3D();
    group.add(ball, lidU, lidL);
    return { side: 1, group, ball, lidU, lidL, frame: { catch1: new THREE.Vector4(9, 9, 9, 9), catch2: new THREE.Vector4(), lidU: new THREE.Vector3(), lidL: new THREE.Vector3() } };
  };
  const root = new THREE.Group(), e = mk(); root.add(e.group);
  poseEyes([e], .5, null, root, { lidU: [0, 1], lidL: [0, -1] });
  poseEyes([e], .5, new THREE.Vector3(0, 0, 10), root, { lidU: [0, 1], lidL: [0, -1], catches: () => null });
  assert.deepEqual(e.frame.catch1.toArray(), [9, 9, 9, 9], '没给高光就不动');
  assert.ok(Math.abs(e.frame.lidU.length() - 1) < 1e-9, '眼睑平面照常更新');
});

test('R41 instanced：数组颜色按 sRGB 解释；共用的临时颜色不把上一个实例 / 上一次调用的颜色带下去', () => {
  const geo = new THREE.BoxGeometry(), mat = new THREE.MeshBasicMaterial(), m = new THREE.Matrix4();
  instanced(geo, mat, [{ m, c: '#00ff00' }], 'warm');
  const mesh = instanced(geo, mat, [{ m, c: [1, 0, 0] }, { m, c: [0, 0, 1] }, { m, c: '#808080' }], 'arr');
  const hex = (im, i) => { const c = new THREE.Color(); im.getColorAt(i, c); return c.getHexString(); };   // r170 的 getColorAt 不返回值
  assert.equal(hex(mesh, 0), 'ff0000');
  assert.equal(hex(mesh, 1), '0000ff');
  assert.equal(hex(mesh, 2), '808080');
  assert.equal(hex(instanced(geo, mat, [{ m, c: [0.8, 0.5, 0.3] }], 'srgb'), 0), new THREE.Color().setRGB(.8, .5, .3, THREE.SRGBColorSpace).getHexString());
  assert.throws(() => instanced(geo, mat, [{ m, c: { r: 1, g: 0, b: 0 } }], 'bad'), /颜色/);
});
