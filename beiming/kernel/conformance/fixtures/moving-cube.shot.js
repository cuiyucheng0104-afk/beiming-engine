// 校准场景「匀速方块」的镜头代码：规格（相机、背景、物体）从 ctx.params 来，是片子描述里抄的校准场景那几段。
// 物体是不受光的自发光体，颜色是场景线性值；位置 = 起点 + 速度 × (f + sub)。只认规格里用到的盒子、球和匀速直线运动。

export function build(ctx) {
  const { THREE } = ctx;
  const { camera: cam, backgroundLinear, objects } = ctx.params;

  const scene = new THREE.Scene();
  // 片子描述没给背景色就不设背景，清屏值由帧源定
  if (backgroundLinear) {
    scene.background = new THREE.Color().setRGB(...backgroundLinear);
  }

  const camera = new THREE.PerspectiveCamera(cam.yFovDeg, ctx.size[0] / ctx.size[1], cam.nearM, cam.farM);
  camera.position.set(...cam.positionM);
  camera.up.set(...cam.upDir);
  camera.lookAt(...cam.lookAtM);

  const entities = {};
  for (const o of objects) {
    if (!['box', 'sphere'].includes(o.shape) || o.motion?.kind !== 'linear') throw new Error(`这个镜头不认识物体 ${o.id} 的形状或运动`);
    const geometry = o.shape === 'box' ? new THREE.BoxGeometry(...o.sizeM) : new THREE.SphereGeometry(o.radiusM, 64, 32);
    const material = new THREE.MeshBasicMaterial({ toneMapped: false });
    material.color.setRGB(...o.emissionLinear);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = o.id;
    scene.add(mesh);
    entities[o.id] = mesh;
  }

  return {
    scene,
    camera,
    entities,
    state(f, sub) {
      const t = f + sub;
      for (const o of objects) entities[o.id].position.set(...o.positionM.map((p, i) => p + o.motion.velocityMPerFrame[i] * t));
    },
    meta() {
      return {};
    },
    dispose() {
      for (const mesh of Object.values(entities)) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
    },
  };
}
