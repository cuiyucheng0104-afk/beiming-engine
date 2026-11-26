// 几何与场景图桥（engine/offscreen/bridge.mjs）：engine/form 的造型与 films/beiming-10s/src/kun_peng.js 的复杂角色（three r170）拷进 r187 后，
// 属性（含 InstancedBufferAttribute）、索引、包围盒、CPU 顶点形变、实例矩阵与手动矩阵（matrixAutoUpdate=false）同步不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE170 from 'three';
import { geometry, mirrorObject } from '../../engine/offscreen/bridge.mjs';
import { spire, mesa } from '../../engine/form/rock.js';
import { boatHull } from '../../engine/form/props.js';
import { pineTree } from '../../engine/form/plants.js';
import { mulberry } from '../../engine/core/math.js';
import { createKun } from '../../films/beiming-10s/src/kun_peng.js';
import { PENG_DEFAULTS } from '../../films/beiming-10s/src/toon_peng.js';

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

test('mirrorObject：桥接 films/beiming-10s/src/kun_peng.js 角色树（InstancedBufferAttribute、CPU 形变网格、实例矩阵、matrixAutoUpdate=false 眼丘）并按帧同步', async t => {
  let gpu, createHost;
  try {
    gpu = await (await import('../../engine/offscreen/load.mjs')).loadGpu();
    ({ createHost } = await import('../../engine/offscreen/host.mjs'));
    (await createHost({ gpu, width: 64, height: 64 })).dispose();
  } catch (e) { if (String(e.code).startsWith('env.')) return t.skip(`离屏出片不可用：${e.message}`); throw e; }

  const { THREE, TSL } = gpu;
  const { toonKind, makeToonShared, useR170Shadow } = await import('../../engine/offscreen/tsl/toon.js');
  const { muralLayer } = await import('../../engine/offscreen/tsl/surface.js');
  const { createLook } = await import('../../engine/offscreen/tsl/look.js');

  const kun = createKun({ lod: 0.35, seed: 20261103 });
  const shared = makeToonShared({ THREE, TSL });
  const pengKind = toonKind({ THREE, TSL }, { name: 'peng', shared, firstId: 501, skyStepUniform: true, layers: [muralLayer] });

  // 把 kun_peng 羽片材质（含 aCard/aFA/aFB/aFC 逐实例属性与 muralLayer）和其余部件桥接到 TSL 卡通材质
  const matCache = new Map();
  const mapMaterial = (m170, srcMesh) => {
    let m = matCache.get(m170);
    if (!m) {
      const o = m170.userData?.toonOpts || {};
      const isFeather = !!srcMesh.geometry.attributes.aFA;
      m = pengKind.make({
        ...PENG_DEFAULTS,
        color: o.color ?? '#2C5C9C',
        side: o.side === THREE170.DoubleSide ? THREE.DoubleSide : THREE.FrontSide,
        rest: !!o.rest && !!srcMesh.geometry.attributes.aRest,
        muralAmt: o.muralAmt ?? 0.7, muralScale: o.muralScale ?? 0.1,
        outlineW: o.outlineW ?? 0.8,
        tsl: isFeather ? {
          fragmentAlbedo: c => {
            const { attribute, smoothstep, mix, step, min, abs, max, fwidth, float, vec3 } = TSL;
            const vCard = attribute('aCard', 'vec2');
            const vFA = attribute('aFA', 'vec4'), vFB = attribute('aFB', 'vec4'), vFC = attribute('aFC', 'vec4');
            const u = vCard.x, vn = vCard.y, av = abs(vn), f = vFA.w;
            const nz = c.noise.noise(vec3(u.mul(4), vn.mul(1.2), c.inst.mul(0.37).add(vFC.w.mul(11))));
            const tt = smoothstep(vFB.w.sub(0.16), vFB.w.add(0.16), u.add(nz.mul(0.08)).sub(av.mul(0.05)));
            const col = mix(vFA.xyz, vFB.xyz, tt).mul(float(0.94).add(step(0, vn).mul(0.09).mul(f))).toVar();
            const ed = min(float(1).sub(av), float(1).sub(u).mul(2.4)), fe = max(fwidth(ed), 1e-4);
            col.assign(mix(col, vFC.xyz, float(1).sub(smoothstep(float(0.12).sub(fe), float(0.12).add(fe), ed.add(nz.mul(0.03)))).mul(mix(0.9, 0.6, f))));
            c.diffuse.assign(col);
            c.muralP.assign(vec3(u.mul(3), vn.mul(0.8), c.inst.mul(1.7).add(vFC.w)).mul(8));
          },
        } : undefined,
      });
      matCache.set(m170, m);
    }
    return m;
  };

  const mir = mirrorObject(THREE, kun.group, { mapMaterial });

  // 1) 结构与 InstancedBufferAttribute 核对
  let featherCount = 0;
  for (const [src, dst] of mir.pairs) {
    if (src.isInstancedMesh && src.geometry.attributes.aFA) {
      featherCount++;
      assert.ok(dst.isInstancedMesh, src.name);
      assert.equal(dst.geometry.attributes.aFA.isInstancedBufferAttribute, true, `${src.name}.aFA 应保留 InstancedBufferAttribute`);
      assert.equal(dst.instanceMatrix.array, src.instanceMatrix.array, `${src.name} 共用 instanceMatrix 数组`);
    }
    if (src.name === 'kun-eye-R') assert.equal(dst.matrixAutoUpdate, false, '眼丘保留 matrixAutoUpdate=false');
  }
  assert.ok(featherCount >= 4, `应桥接多层实例化羽毛网格（实际 ${featherCount}）`);

  // 2) 推进姿态：CPU 形变顶点、火焰实例矩阵、眼丘手动矩阵与翅膀层级旋转全部同步，并在 Dawn + createLook 下渲出不同帧
  const W = 240, H = 135;
  const host = await createHost({ gpu, width: W, height: H });
  const look = createLook({ THREE, TSL, renderer: host.renderer }, { width: W, height: H, ss: 1 });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1e2240);
  const sun = useR170Shadow(TSL, new THREE.DirectionalLight(0xffffff, 2));
  sun.position.set(-300, 400, 500);
  scene.add(sun, mir.root);
  const camera = new THREE.PerspectiveCamera(35, W / H, 10, 4000);
  camera.position.set(220, 140, 620); camera.lookAt(20, 10, 0);
  const post = host.pipeline(look.output);

  const bodyDst = mir.map.get(kun.group.getObjectByName('kun-body'));
  const v0 = bodyDst.geometry.attributes.position.version;

  try {
    const f0 = await host.renderFrame({
      render() { kun.setPose(0); mir.sync(); look.render(scene, camera, { t: 0, fog: { color: '#9ab4dc', density: 0.0004, start: 200, max: 0.6 } }); post.render(); },
    }, 0);
    const f1 = await host.renderFrame({
      render() { kun.setPose(1.1); mir.sync(); look.render(scene, camera, { t: 1.1, fog: { color: '#9ab4dc', density: 0.0004, start: 200, max: 0.6 } }); post.render(); },
    }, 1);
    assert.ok(bodyDst.geometry.attributes.position.version > v0, 'setPose 后 sync() 应触发 r187 顶点缓冲更新');
    assert.ok(!Buffer.from(f0).equals(Buffer.from(f1)), '两帧鲲鹏振翅画面应随 setPose + sync() 改变');
  } finally {
    look.dispose();
    for (const m of matCache.values()) m.dispose();
    host.dispose();
  }
});
