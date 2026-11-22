// WP2.2：ss=1/msaa=0 的主场景 MRT 与双遍 ID 必须逐字节相同；soft 与自定义顶点位移自动回退。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadGpu } from '../../engine/offscreen/load.mjs';
import { createHost } from '../../engine/offscreen/host.mjs';
import { createIdPass } from '../../engine/offscreen/tsl/idpass.js';
import { createInk } from '../../engine/offscreen/tsl/ink.js';
import { createGpuTimer, attachGpuTimer, detachGpuTimer } from '../../engine/offscreen/gputimer.mjs';
import { toonKind } from '../../engine/offscreen/tsl/toon.js';

const W = 128, H = 72;
let gpu = null, host = null, why = null;
before(async () => {
  try { gpu = await loadGpu(); host = await createHost({ gpu, width: W, height: H }); }
  catch (e) { if (!e.code?.startsWith('env.')) throw e; why = String(e.message).split('\n')[0]; }
});
after(() => host?.dispose());

function world() {
  const { THREE } = gpu, scene = new THREE.Scene(), kind = toonKind({ THREE, TSL: gpu.TSL }, { name: 'mrt-test' });
  scene.background = new THREE.Color(0x304050);
  const camera = new THREE.PerspectiveCamera(35, W / H, 0.1, 100);
  camera.position.set(0, 0, 12); camera.lookAt(0, 0, 0);
  const meshes = [], shared = kind.make({ color: '#7D78B8' });
  for (const [x, z, outline] of [[-2.4, 0, true], [0, -0.5, true], [2.4, 0.5, false]]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), shared);
    kind.bind(mesh, mesh.material, { outline }); mesh.position.set(x, 0, z); scene.add(mesh); meshes.push(mesh);
  }
  return { scene, camera, meshes };
}
function target(count = 1) {
  const { THREE } = gpu;
  const t = new THREE.RenderTarget(W, H, { count, type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(W, H, THREE.FloatType) });
  if (count === 2) {
    t.textures[0].name = 'output'; t.textures[1].name = 'inkId';
    t.textures[1].minFilter = t.textures[1].magFilter = THREE.NearestFilter;
  }
  return t;
}
const bytes = async (renderer, t, index = 0) => {
  const px = await renderer.readRenderTargetPixelsAsync(t, 0, 0, W, H, index);
  return Buffer.from(px.buffer, px.byteOffset, px.byteLength);
};

test('MRT 主场景颜色、ID 与后续边缘/笔画对双遍逐字节相同，并还原材质与 renderer MRT 状态', async t => {
  if (why) return t.skip(`离屏出片不可用：${why}`);
  const { THREE, TSL } = gpu, { renderer } = host, { scene, camera } = world();
  const pass = createIdPass({ THREE, TSL, renderer }), mrt = target(2), color = target(), ids = target();
  const ink = createInk({ THREE, TSL, renderer }, { width: W, height: H });
  const P = { width: 2.5, wobble: 1, boilHold: 2, warp: 60, pressure: 0.2, breakup: 0, inner: 0.6, silhouette: 0.12, depthThreshold: 0.03, near: 4, far: 80, farScale: 0.6, opacity: 1 };
  try {
    const beforeMrt = renderer.getMRT(), prepared = pass.renderMrt(scene, camera, mrt);
    assert.ok(prepared && Number.isFinite(prepared.maxWidth), '全不透明 toonKind 场景应走 MRT');
    assert.equal(renderer.getMRT(), beforeMrt);
    assert.ok(scene.children.every(o => !o.isMesh || o.material.mrtNode === null));

    renderer.setRenderTarget(color); renderer.clear(true, true, true); renderer.render(scene, camera);
    const maxWidth = pass.render(scene, camera, ids);
    assert.equal(prepared.maxWidth, maxWidth);
    assert.ok((await bytes(renderer, mrt, 0)).equals(await bytes(renderer, color)), '主颜色逐字节相同');
    const mrtIdBytes = await bytes(renderer, mrt, 1), refIdBytes = await bytes(renderer, ids);
    assert.ok(mrtIdBytes.some(x => x !== 0), 'MRT 确实写入了非空 ID');
    assert.ok(mrtIdBytes.equals(refIdBytes), 'ID 逐字节相同');

    const timer = createGpuTimer(host.device);
    attachGpuTimer(renderer, timer); timer.mark('pre');
    ink.render({ scene, camera, p: P, t: 0, k: 1, ss: 1, fps: 24, ids: prepared });
    timer.end(); detachGpuTimer(renderer);
    const timing = await timer.read(); timer.dispose();
    assert.equal(timing.spans.find(s => s.label === 'ink:ids')?.ms, 0, 'MRT 后 ink:ids 显式为 0');
    const edgeMrt = await bytes(renderer, ink.edge), lineMrt = await bytes(renderer, ink.line);
    ink.render({ scene, camera, p: P, t: 0, k: 1, ss: 1, fps: 24 });
    assert.ok(edgeMrt.equals(await bytes(renderer, ink.edge)), '边缘逐字节相同（共用深度一致）');
    assert.ok(lineMrt.equals(await bytes(renderer, ink.line)), '笔画逐字节相同');
  } finally {
    ink.dispose(); pass.dispose();
    for (const t of [mrt, color, ids]) { t.dispose(); t.depthTexture.dispose(); }
  }
});

test('soft/own 遮挡、自定义 outlineVertex 与非 toon 材质不走 MRT，原双遍仍可渲染', async t => {
  if (why) return t.skip(`离屏出片不可用：${why}`);
  const { THREE, TSL } = gpu, { renderer } = host;
  for (const kind of ['soft', 'own', 'outlineVertex', 'basic']) {
    const { scene, camera, meshes } = world(), pass = createIdPass({ THREE, TSL, renderer }), mrt = target(2), ids = target();
    try {
      if (kind === 'soft' || kind === 'own') {
        const veil = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.MeshBasicNodeMaterial({ transparent: kind === 'soft', opacity: kind === 'soft' ? 0.5 : 1 }));
        if (kind === 'own') veil.userData.outlineOccluder = 'own';
        veil.position.z = 3; scene.add(veil);
      } else if (kind === 'outlineVertex') {
        meshes[0].userData.outlineVertex = { tsl: TSL.positionLocal };
      } else {
        meshes[0].material = new THREE.MeshBasicNodeMaterial();
      }
      assert.equal(pass.renderMrt(scene, camera, mrt), null, `${kind} 应回退`);
      pass.render(scene, camera, ids);
      const px = await bytes(renderer, ids);
      assert.ok(px.some(x => x !== 0), `${kind} 回退双遍确实画出了 ID（长度 ${px.length}，非零字节 ${px.filter(x => x !== 0).length}）`);
    } finally {
      pass.dispose(); mrt.dispose(); mrt.depthTexture.dispose(); ids.dispose(); ids.depthTexture.dispose();
    }
  }
});
