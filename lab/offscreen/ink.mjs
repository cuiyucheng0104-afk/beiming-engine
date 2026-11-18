// 离屏出片 · 演示作品：北冥 A 风格的最小代表（三档卡通着色 + 反向外壳墨线 + 纸纹与暗角后期），全部按帧号确定。
// 作品模块契约（docs/offscreen/README.md 2.1）：build({ THREE, TSL, renderer, width, height, fps, pipeline }) → { render(f), dispose() }
// 不 import three：THREE、TSL 由宿主注入（仓库里的 three 是 r170，作品要 r187）。出片：npm run offscreen -- render lab/offscreen/ink.mjs --out <文件.mp4>
// 预览：lab/offscreen/index.html?work=/lab/offscreen/ink.mjs
export function build({ THREE, TSL, width: W, height: H, fps = 24, pipeline }) {
  const { pass, uniform, vec2, vec4, float, mix, smoothstep, hash, screenUV, screenCoordinate, length, floor, Fn, positionLocal, normalLocal } = TSL;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe8dfcc);
  const cam = new THREE.PerspectiveCamera(35, W / H, 0.1, 100);
  cam.position.set(0, 0.9, 5.2);
  cam.lookAt(0, 0.2, 0);

  // 三档色阶：卡通材质按 N·L 查这张 4×1 的表（最近邻，不插值）
  const ramp = new THREE.DataTexture(new Uint8Array([70, 120, 200, 255]), 4, 1, THREE.RedFormat);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
  ramp.needsUpdate = true;
  const knot = new THREE.TorusKnotGeometry(0.8, 0.28, 256, 32);
  const body = new THREE.Mesh(knot, new THREE.MeshToonMaterial({ color: 0x2f6f8f, gradientMap: ramp }));
  // 反向外壳墨线：沿法线外扩、只画背面
  const inkMat = new THREE.MeshBasicNodeMaterial({ color: 0x1b1a17, side: THREE.BackSide });
  inkMat.positionNode = positionLocal.add(normalLocal.mul(0.025));
  const ink = new THREE.Mesh(knot, inkMat);
  const disc = new THREE.CircleGeometry(2.4, 96);
  const ground = new THREE.Mesh(disc, new THREE.MeshToonMaterial({ color: 0xcdbf9f, gradientMap: ramp }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.25;
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
  sun.position.set(2, 4, 2);
  scene.add(body, ink, ground, new THREE.AmbientLight(0xffffff, 0.35), sun);

  // 后期：纸纹（按像素坐标取哈希，一拍二沸腾）+ 暗角
  const boil = uniform(0);
  const scenePass = pass(scene, cam);
  const paper = Fn(() => {
    const px = floor(screenCoordinate.xy);
    const n = hash(px.x.add(px.y.mul(4096)).add(boil.mul(7919)));
    const c = scenePass.rgb.add(n.sub(0.5).mul(0.06));
    const v = smoothstep(float(0.95), float(0.35), length(screenUV.sub(vec2(0.5))));
    return vec4(mix(c.mul(0.82), c, v), 1);
  })();
  const post = pipeline(paper);

  return {
    render(f) {
      body.rotation.set(0.3, (f / fps) * 0.6, 0);
      ink.rotation.copy(body.rotation);
      boil.value = Math.floor(f / 2);   // 一拍二
      post.render();
    },
    dispose() {
      knot.dispose(); disc.dispose(); ramp.dispose();
      body.material.dispose(); inkMat.dispose(); ground.material.dispose();
    },
  };
}
