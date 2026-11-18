// 照校准场景的规格搭镜头：相机、背景、物体都从规格来。物体是不受光的自发光体，颜色是场景线性值；
// 位置 = 起点 + 速度 × (f + sub)。只认规格里用到的盒子、球、静态旋转和匀速直线运动。
// 调参用的两个值走 ctx.params：background 是 false 时不设背景；stranger 是 line 时往场景里加一条线（辅助层画不了的对象）。

export const calibShot = (spec) => function build(ctx) {
  const { THREE } = ctx;
  const { camera: cam, backgroundLinear, objects } = spec;

  const scene = new THREE.Scene();
  // 不设背景时清屏值由帧源定
  if (ctx.params.background !== false) scene.background = new THREE.Color().setRGB(...backgroundLinear);

  const camera = new THREE.PerspectiveCamera(cam.yFovDeg, ctx.size[0] / ctx.size[1], cam.nearM, cam.farM);
  camera.position.set(...cam.positionM);
  camera.up.set(...cam.upDir);
  camera.lookAt(...cam.lookAtM);

  const entities = {}, disposable = [];
  for (const o of objects) {
    if (!['box', 'sphere'].includes(o.shape) || (o.motion && o.motion.kind !== 'linear')) throw new Error(`这个镜头不认识物体 ${o.id} 的形状或运动`);
    const geometry = o.shape === 'box' ? new THREE.BoxGeometry(...o.sizeM) : new THREE.SphereGeometry(o.radiusM, 64, 32);
    const material = new THREE.MeshBasicMaterial({ toneMapped: false });
    material.color.setRGB(...o.emissionLinear);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = o.id;
    if (o.rotation) mesh.quaternion.setFromAxisAngle(new THREE.Vector3(...o.rotation.axisDir).normalize(), o.rotation.angleRad);
    scene.add(mesh);
    entities[o.id] = mesh;
    disposable.push(geometry, material);
  }
  if (ctx.params.stranger === 'line') {
    const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.5, -0.5, -3), new THREE.Vector3(0.5, 0.5, -3)]);
    const material = new THREE.LineBasicMaterial({ toneMapped: false });
    scene.add(new THREE.Line(geometry, material));
    disposable.push(geometry, material);
  }

  return {
    scene,
    camera,
    entities,
    state(f, sub) {
      const t = f + sub;
      for (const o of objects) entities[o.id].position.set(...o.positionM.map((p, i) => p + (o.motion?.velocityMPerFrame[i] ?? 0) * t));
    },
    meta() {
      return {};
    },
    dispose() {
      for (const x of disposable) x.dispose();
    },
  };
};
