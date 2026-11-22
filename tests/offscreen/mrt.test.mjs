// WP2.2：ss=1/msaa=0 的主场景 MRT 与双遍 ID 必须逐字节相同；先回退/无墨线后切 MRT 不失配；自定义 fragmentNode 不触发 GPU fault；阴影嵌套遍/BundleGroup/wireframe/非等价渲染状态全覆盖。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadGpu } from '../../engine/offscreen/load.mjs';
import { createHost } from '../../engine/offscreen/host.mjs';
import { createIdPass } from '../../engine/offscreen/tsl/idpass.js';
import { createInk } from '../../engine/offscreen/tsl/ink.js';
import { createLook } from '../../engine/offscreen/tsl/look.js';
import { createGpuTimer, attachGpuTimer, detachGpuTimer } from '../../engine/offscreen/gputimer.mjs';
import { toonKind, useR170Shadow } from '../../engine/offscreen/tsl/toon.js';

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

test('MRT InstancedMesh：逐实例连续 ID 与双遍逐字节相同', async t => {
  if (why) return t.skip(`离屏出片不可用：${why}`);
  const { THREE, TSL } = gpu, { renderer } = host;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x304050);
  const camera = new THREE.PerspectiveCamera(35, W / H, 0.1, 100);
  camera.position.set(0, 0, 12); camera.lookAt(0, 0, 0);
  const kind = toonKind({ THREE, TSL }, { name: 'mrt-inst' });
  const mat = kind.make({ color: '#7D78B8' });
  const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), mat, 3);
  const m = new THREE.Matrix4();
  [-2.2, 0, 2.2].forEach((x, i) => { m.makeTranslation(x, 0, 0); inst.setMatrixAt(i, m); });
  inst.instanceMatrix.needsUpdate = true;
  kind.bind(inst, mat, { outline: true });
  scene.add(inst);
  const pass = createIdPass({ THREE, TSL, renderer }), mrt = target(2), ids = target(1);
  try {
    const prepared = pass.renderMrt(scene, camera, mrt);
    assert.ok(prepared, 'InstancedMesh + toonKind 应走 MRT');
    pass.render(scene, camera, ids);
    const mrtId = await bytes(renderer, mrt, 1), refId = await bytes(renderer, ids);
    assert.ok(mrtId.some(x => x !== 0), 'InstancedMesh MRT ID 非零');
    assert.ok(mrtId.equals(refId), 'InstancedMesh MRT ID 与双遍逐字节相同');
  } finally {
    pass.dispose();
    for (const rt of [mrt, ids]) { rt.dispose(); rt.depthTexture.dispose(); }
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

test('B1：先回退 / 先 lineOn=false 再切 MRT，着色器缓存不失配，ID 非零且全序列与双遍逐字节相同', async t => {
  if (why) return t.skip(`离屏出片不可用：${why}`);
  const { THREE, TSL } = gpu, { renderer } = host;

  // 1) createIdPass 直接切态：先单附件渲染（模拟无墨线/回退）→ 再 MRT → 再单附件 → 再 MRT
  {
    const { scene, camera } = world();
    const pass = createIdPass({ THREE, TSL, renderer }), single = target(1), mrt = target(2), ids = target(1);
    try {
      renderer.setRenderTarget(single); renderer.clear(true, true, true); renderer.render(scene, camera);
      const prepared1 = pass.renderMrt(scene, camera, mrt);
      assert.ok(prepared1, '先单附件后再 MRT 应生效');
      const mrtId1 = await bytes(renderer, mrt, 1);
      assert.ok(mrtId1.some(x => x !== 0), '先单附件后切 MRT，ID 附件不得全零');
      pass.render(scene, camera, ids);
      const refId = await bytes(renderer, ids);
      assert.ok(mrtId1.equals(refId), '先单附件后切 MRT，ID 与双遍逐字节相同');

      // 再回退单附件，再切回 MRT
      renderer.setRenderTarget(single); renderer.clear(true, true, true); renderer.render(scene, camera);
      const prepared2 = pass.renderMrt(scene, camera, mrt);
      assert.ok(prepared2);
      assert.ok((await bytes(renderer, mrt, 1)).equals(refId), '再切回 MRT 后 ID 仍逐字节相同');
    } finally {
      pass.dispose();
      for (const rt of [single, mrt, ids]) { rt.dispose(); rt.depthTexture.dispose(); }
    }
  }

  // 2) 完整 createLook 帧序列 [0,1,2,3]：outline.opacity = 0 → 1 → 0 → 1，与双遍基线逐字节对拍
  {
    const runSeq = async (forceFallback) => {
      const { scene, camera } = world();
      if (forceFallback) {
        // 用不可见/无贡献的 noId 透明占位（colorWrite=false）强制走双遍，但不改变任何颜色或深度像素
        const dummy = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), new THREE.MeshBasicNodeMaterial({ colorWrite: false, depthWrite: false }));
        dummy.userData.noId = true;
        dummy.position.set(0, 0, -50);
        scene.add(dummy);
      }
      const look = createLook({ THREE, TSL, renderer }, { width: W, height: H, ss: 1, msaa: 0 });
      const outRt = new THREE.RenderTarget(W, H, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace });
      const post = host.pipeline(look.output);
      const frames = [];
      try {
        const opacities = [0, 1, 0, 1];
        for (let f = 0; f < opacities.length; f++) {
          look.render(scene, camera, { t: f / 24, outline: { opacity: opacities[f] } });
          renderer.setRenderTarget(outRt);
          post.render();
          frames.push(await bytes(renderer, outRt));
        }
      } finally {
        renderer.setRenderTarget(null);
        look.dispose(); outRt.dispose();
      }
      return frames;
    };
    const mrtFrames = await runSeq(false);
    const refFrames = await runSeq(true);
    assert.ok(!mrtFrames[0].equals(mrtFrames[1]), '第 1 帧开启墨线后画面必须与第 0 帧不同（墨线未丢失）');
    for (let f = 0; f < refFrames.length; f++) {
      assert.ok(mrtFrames[f].equals(refFrames[f]), `帧序列第 ${f} 帧（outline.opacity=${f % 2}）与双遍逐字节相同`);
    }
  }
});

test('B2：ss=1/msaa=0 下自定义 fragmentNode 材质走单附件回退，不触发 GPUDevice fault 且颜色正确', async t => {
  if (why) return t.skip(`离屏出片不可用：${why}`);
  const { THREE, TSL } = gpu, { renderer } = host;
  const makeScene = () => {
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x203040);
    const camera = new THREE.PerspectiveCamera(35, W / H, 0.1, 100);
    camera.position.set(0, 0, 8); camera.lookAt(0, 0, 0);
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.fragmentNode = TSL.vec4(1, 0, 0, 1);
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat);
    box.userData.outline = true;
    scene.add(box);
    return { scene, camera };
  };
  const { scene, camera } = makeScene();
  const look = createLook({ THREE, TSL, renderer }, { width: W, height: H, ss: 1, msaa: 0 });
  const refTarget = new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(W, H, THREE.FloatType) });
  const outRt = new THREE.RenderTarget(W, H, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace });
  const post = host.pipeline(look.output);
  try {
    // 分别测 lineOn=false 与 lineOn=true
    for (const opacity of [0, 1]) {
      look.render(scene, camera, { t: 0, outline: { opacity }, kuwahara: false, paper: false, bloom: false, vignette: 0, grain: 0 });
      renderer.setRenderTarget(outRt);
      post.render();
      const px = await bytes(renderer, outRt);
      assert.equal(host.isFaulted(), false, `fragmentNode 材质在 opacity=${opacity} 下不得触发 GPU fault`);
      // 画面中心是纯红方块
      const ci = (Math.floor(H / 2) * W + Math.floor(W / 2)) * 4;
      assert.ok(px[ci] > 200 && px[ci + 1] < 20 && px[ci + 2] < 20, `opacity=${opacity} 中心应为红色，实得 [${px[ci]},${px[ci + 1]},${px[ci + 2]}]`);
    }
    // 对照纯单附件渲染（opacity=0、关闭全部后期，与单独建 ss=2 的 look 一致）
    const refLook = createLook({ THREE, TSL, renderer }, { width: W, height: H, ss: 2, msaa: 0 });
    const refPost = host.pipeline(refLook.output);
    try {
      look.render(scene, camera, { t: 0, outline: false, kuwahara: false, paper: false, bloom: false, vignette: 0, grain: 0 });
      renderer.setRenderTarget(outRt); post.render();
      const px1 = await bytes(renderer, outRt);
      refLook.render(scene, camera, { t: 0, outline: false, kuwahara: false, paper: false, bloom: false, vignette: 0, grain: 0 });
      renderer.setRenderTarget(outRt); refPost.render();
      const px2 = await bytes(renderer, outRt);
      assert.ok(px1.equals(px2), 'ss=1 单附件路径输出应与 ss=2 逐字节相同');
    } finally { refLook.dispose(); }
  } finally {
    renderer.setRenderTarget(null);
    look.dispose(); refTarget.dispose(); refTarget.depthTexture.dispose(); outRt.dispose();
  }
});

test('S1：depthTest=false / 非默认 depthFunc / clippingPlanes / polygonOffset / 非 NormalBlending 一律回退双遍且输出逐字节一致', async t => {
  if (why) return t.skip(`离屏出片不可用：${why}`);
  const { THREE, TSL } = gpu, { renderer } = host;

  // 1) 五种非等价渲染状态均必须被 canMrt 拒绝回退
  for (const variant of ['depthTest', 'depthFunc', 'clippingPlanes', 'polygonOffset', 'blending']) {
    const { scene, camera, meshes } = world(), pass = createIdPass({ THREE, TSL, renderer }), mrt = target(2);
    try {
      const m = meshes[0].material;
      if (variant === 'depthTest') m.depthTest = false;
      else if (variant === 'depthFunc') m.depthFunc = THREE.AlwaysDepth;
      else if (variant === 'clippingPlanes') m.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)];
      else if (variant === 'polygonOffset') m.polygonOffset = true;
      else if (variant === 'blending') m.blending = THREE.AdditiveBlending;
      assert.equal(pass.renderMrt(scene, camera, mrt), null, `${variant} 与双遍不等价，必须回退`);
    } finally {
      pass.dispose(); mrt.dispose(); mrt.depthTexture.dispose();
    }
  }

  // 2) 重叠 toon 方块：后方方块 depthTest=false，经 createLook(ss=1, msaa=0) 输出必须与双遍 ID 逐字节一致
  {
    const makeOverlap = () => {
      const scene = new THREE.Scene(); scene.background = new THREE.Color(0x304050);
      const camera = new THREE.PerspectiveCamera(35, W / H, 0.1, 100);
      camera.position.set(0, 0, 10); camera.lookAt(0, 0, 0);
      const kind = toonKind({ THREE, TSL }, { name: 'mrt-depth-test' });
      const frontMat = kind.make({ color: '#7D78B8' });
      const backMat = kind.make({ color: '#C87858' });
      backMat.depthTest = false;
      const front = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 1), frontMat);
      kind.bind(front, frontMat, { outline: true }); front.position.set(0, 0, 1); scene.add(front);
      const back = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1), backMat);
      kind.bind(back, backMat, { outline: true }); back.position.set(0.3, 0.2, -1); scene.add(back);
      return { scene, camera };
    };
    const { scene, camera } = makeOverlap();
    const pass = createIdPass({ THREE, TSL, renderer }), mrt = target(2), ids = target(1);
    const ink = createInk({ THREE, TSL, renderer }, { width: W, height: H });
    const look = createLook({ THREE, TSL, renderer }, { width: W, height: H, ss: 1, msaa: 0 });
    const outRt = new THREE.RenderTarget(W, H, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace });
    const post = host.pipeline(look.output);
    try {
      assert.equal(pass.renderMrt(scene, camera, mrt), null, 'depthTest=false 必须回退');
      look.render(scene, camera, { t: 0, outline: { opacity: 1 } });
      renderer.setRenderTarget(outRt); post.render();
      const got = await bytes(renderer, outRt);
      // 强制加入 noId 占位对比（同样走双遍），确认回退结果完全一致
      const dummy = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), new THREE.MeshBasicNodeMaterial({ colorWrite: false, depthWrite: false }));
      dummy.userData.noId = true; dummy.position.set(0, 0, -50); scene.add(dummy);
      look.render(scene, camera, { t: 0, outline: { opacity: 1 } });
      renderer.setRenderTarget(outRt); post.render();
      const ref = await bytes(renderer, outRt);
      assert.ok(got.equals(ref), 'depthTest=false 重叠场景经回退后输出逐字节一致');
    } finally {
      renderer.setRenderTarget(null);
      ink.dispose(); look.dispose(); pass.dispose();
      mrt.dispose(); mrt.depthTexture.dispose(); ids.dispose(); ids.depthTexture.dispose(); outRt.dispose();
    }
  }
});

test('B4：shadowMap + DirectionalLight.castShadow 多帧动画，嵌套阴影遍不污染 MRT ID，逐帧与双遍逐字节一致', async t => {
  if (why) return t.skip(`离屏出片不可用：${why}`);
  const { THREE, TSL } = gpu, { renderer } = host;
  const prevShadow = renderer.shadowMap.enabled, prevType = renderer.shadowMap.type;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;

  const makeShadowScene = () => {
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x304050);
    const camera = new THREE.PerspectiveCamera(35, W / H, 0.1, 100);
    camera.position.set(0, 3.5, 9); camera.lookAt(0, 0.5, 0);
    const sun = useR170Shadow(TSL, new THREE.DirectionalLight(0xffffff, 2.2));
    sun.position.set(4, 7, 5); sun.castShadow = true;
    sun.shadow.mapSize.set(256, 256);
    sun.shadow.camera.left = -5; sun.shadow.camera.right = 5;
    sun.shadow.camera.top = 5; sun.shadow.camera.bottom = -5;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 25;
    scene.add(sun);
    const kind = toonKind({ THREE, TSL }, { name: 'mrt-shadow-b4' });
    const boxMat = kind.make({ color: '#7D78B8' }), floorMat = kind.make({ color: '#9EA8B8' });
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.8, 1.8), boxMat);
    box.position.set(0, 1.1, 0); box.castShadow = true; box.receiveShadow = true;
    kind.bind(box, boxMat, { outline: true }); scene.add(box);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), floorMat);
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
    kind.bind(floor, floorMat, { outline: true }); scene.add(floor);
    return { scene, camera, box, floor };
  };

  const { scene, camera, box } = makeShadowScene();
  const userBefore = function () {};
  box.onBeforeRender = userBefore;
  const pass = createIdPass({ THREE, TSL, renderer }), mrt = target(2), color = target(1), ids = target(1);
  const look = createLook({ THREE, TSL, renderer }, { width: W, height: H, ss: 1, msaa: 0 });
  const outRt = new THREE.RenderTarget(W, H, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace });
  const post = host.pipeline(look.output);
  const dummy = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), new THREE.MeshBasicNodeMaterial({ colorWrite: false, depthWrite: false }));
  dummy.userData.noId = true; dummy.position.set(0, 0, -50);
  try {
    for (let f = 0; f < 3; f++) {
      box.rotation.y = f * 0.45; box.rotation.x = f * 0.2;
      const prepared = pass.renderMrt(scene, camera, mrt);
      assert.ok(prepared && Number.isFinite(prepared.maxWidth), `第 ${f} 帧应走 MRT 路径`);
      assert.equal(box.onBeforeRender, userBefore, 'renderMrt 不应改写用户 onBeforeRender');

      renderer.setRenderTarget(color); renderer.clear(true, true, true); renderer.render(scene, camera);
      pass.render(scene, camera, ids);
      const mrtId = await bytes(renderer, mrt, 1), refId = await bytes(renderer, ids);
      assert.ok(mrtId.some(x => x !== 0), `第 ${f} 帧阴影场景 MRT ID 不得被嵌套阴影遍清零`);
      assert.ok(mrtId.equals(refId), `第 ${f} 帧阴影场景 MRT ID 应与双遍逐字节相同`);
      assert.ok((await bytes(renderer, mrt, 0)).equals(await bytes(renderer, color)), `第 ${f} 帧阴影场景 MRT 主颜色应逐字节相同`);

      // 端到端 createLook(ss=1, msaa=0)：验证确实走 MRT（ink:ids=0）且成图与双遍逐字节相同
      const timer = createGpuTimer(host.device);
      attachGpuTimer(renderer, timer); timer.mark('pre');
      look.render(scene, camera, { t: f / 24, outline: { opacity: 1 }, kuwahara: false, paper: false, bloom: false, vignette: 0, grain: 0 });
      timer.end(); detachGpuTimer(renderer);
      const timing = await timer.read(); timer.dispose();
      assert.equal(timing.spans.find(s => s.label === 'ink:ids')?.ms, 0, `第 ${f} 帧 createLook 应命中 MRT（ink:ids=0）`);
      renderer.setRenderTarget(outRt); post.render();
      const got = await bytes(renderer, outRt);

      // 强制退回双遍（加屏幕外 noId 占位物体）对拍
      scene.add(dummy);
      look.render(scene, camera, { t: f / 24, outline: { opacity: 1 }, kuwahara: false, paper: false, bloom: false, vignette: 0, grain: 0 });
      scene.remove(dummy);
      renderer.setRenderTarget(outRt); post.render();
      const ref = await bytes(renderer, outRt);
      assert.ok(got.equals(ref), `第 ${f} 帧阴影场景 createLook MRT 输出应与双遍逐字节相同`);
    }
  } finally {
    detachGpuTimer(renderer);
    renderer.setRenderTarget(null);
    renderer.shadowMap.enabled = prevShadow; renderer.shadowMap.type = prevType;
    look.dispose(); pass.dispose();
    mrt.dispose(); mrt.depthTexture.dispose(); color.dispose(); color.depthTexture.dispose();
    ids.dispose(); ids.depthTexture.dispose(); outRt.dispose();
  }
});

test('S3：wireframe=true 回退双遍，避免线框 ID 与实心双遍 ID 失配', async t => {
  if (why) return t.skip(`离屏出片不可用：${why}`);
  const { THREE, TSL } = gpu, { renderer } = host;
  const { scene, camera, meshes } = world();
  meshes[0].material.wireframe = true;
  const pass = createIdPass({ THREE, TSL, renderer }), mrt = target(2);
  const look = createLook({ THREE, TSL, renderer }, { width: W, height: H, ss: 1, msaa: 0 });
  const outRt = new THREE.RenderTarget(W, H, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace });
  const post = host.pipeline(look.output);
  try {
    assert.equal(pass.renderMrt(scene, camera, mrt), null, 'wireframe=true 必须被 canMrt 拒绝回退双遍');
    look.render(scene, camera, { t: 0, outline: { opacity: 1 }, kuwahara: false, paper: false, bloom: false, vignette: 0, grain: 0 });
    renderer.setRenderTarget(outRt); post.render();
    const got = await bytes(renderer, outRt);
    const dummy = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), new THREE.MeshBasicNodeMaterial({ colorWrite: false, depthWrite: false }));
    dummy.userData.noId = true; dummy.position.set(0, 0, -50); scene.add(dummy);
    look.render(scene, camera, { t: 0, outline: { opacity: 1 }, kuwahara: false, paper: false, bloom: false, vignette: 0, grain: 0 });
    renderer.setRenderTarget(outRt); post.render();
    const ref = await bytes(renderer, outRt);
    assert.ok(got.equals(ref), 'wireframe=true 回退输出与强制双遍逐字节一致');
  } finally {
    renderer.setRenderTarget(null);
    look.dispose(); pass.dispose(); mrt.dispose(); mrt.depthTexture.dispose(); outRt.dispose();
  }
});

test('N6：BundleGroup 静态场景连续两帧 MRT 均刷新 ID，不丢失墨线且两帧逐字节一致', async t => {
  if (why) return t.skip(`离屏出片不可用：${why}`);
  const { THREE, TSL } = gpu, { renderer } = host;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x304050);
  const camera = new THREE.PerspectiveCamera(35, W / H, 0.1, 100);
  camera.position.set(0, 0, 10); camera.lookAt(0, 0, 0);
  const kind = toonKind({ THREE, TSL }, { name: 'mrt-bundle-n6' });
  const shared = kind.make({ color: '#7D78B8' });
  const bundle = new THREE.BundleGroup();
  for (const x of [-1.6, 1.6]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), shared);
    m.position.set(x, 0, 0); kind.bind(m, shared, { outline: true }); bundle.add(m);
  }
  scene.add(bundle);
  const pass = createIdPass({ THREE, TSL, renderer }), mrt = target(2), ids = target(1);
  const look = createLook({ THREE, TSL, renderer }, { width: W, height: H, ss: 1, msaa: 0 });
  const outRt = new THREE.RenderTarget(W, H, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace });
  const post = host.pipeline(look.output);
  try {
    pass.render(scene, camera, ids);
    const refId = await bytes(renderer, ids);
    assert.ok(refId.some(x => x !== 0), '参考 ID 非空');

    const idFrames = [], lookFrames = [];
    for (let f = 0; f < 2; f++) {
      assert.ok(pass.renderMrt(scene, camera, mrt), `BundleGroup 第 ${f} 帧应走 MRT`);
      const idBytes = await bytes(renderer, mrt, 1);
      assert.ok(idBytes.some(x => x !== 0), `BundleGroup 第 ${f} 帧 ID 不应为零`);
      assert.ok(idBytes.equals(refId), `BundleGroup 第 ${f} 帧 MRT ID 应与双遍逐字节相同`);
      idFrames.push(idBytes);

      look.render(scene, camera, { t: 0, outline: { opacity: 1 }, kuwahara: false, paper: false, bloom: false, vignette: 0, grain: 0 });
      renderer.setRenderTarget(outRt); post.render();
      lookFrames.push(await bytes(renderer, outRt));
    }
    assert.ok(idFrames[0].equals(idFrames[1]), 'BundleGroup 连续两帧 ID 逐字节相同');
    assert.ok(lookFrames[0].equals(lookFrames[1]), 'BundleGroup 连续两帧成图逐字节相同');
    look.render(scene, camera, { t: 0, outline: { opacity: 0 }, kuwahara: false, paper: false, bloom: false, vignette: 0, grain: 0 });
    renderer.setRenderTarget(outRt); post.render();
    assert.ok(!lookFrames[1].equals(await bytes(renderer, outRt)), 'BundleGroup 第 2 帧确实绘出墨线（与 opacity=0 不同）');
  } finally {
    renderer.setRenderTarget(null);
    look.dispose(); pass.dispose(); mrt.dispose(); mrt.depthTexture.dispose();
    ids.dispose(); ids.depthTexture.dispose(); outRt.dispose();
  }
});
