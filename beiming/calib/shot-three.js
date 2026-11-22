// 校准场景在 three 上的搭法（各场景目录里的 shot.three.js 共用）：相机、背景、物体都从规格来，在页面里跑。
// 物体默认是不受光的自发光体，颜色是场景线性值；写了 material 的是受光的标准材质（底色、粗糙度、金属度），由规格的 lights 照。
// 灯是点光源：规格的瓦数照 Blender 的口径（漫反射面读回 = 底色 × 瓦数 × cos / (4π² × 距离²)），换成 three 的坎德拉是瓦数 / 4π。
// 这里只有直接光：没有投影、没有环境反射、没有间接光（Blender 那边路径追踪都有）。世界变换同 check.mjs 的 objectTransform：
// R = R运动 · R静态；linear 时 T = 位置 + 速度 × t，spin 时 T = R运动 · (位置 − 枢轴) + 枢轴。
// 圆柱轴沿局部 Y（three 的 CylinderGeometry 也是）；平面在局部 XY、法线 +Z，零厚度所以两面都画。

export const calibShot = (spec) => function build(ctx) {
  const { THREE } = ctx;
  const { camera: cam, backgroundLinear, objects, lights = [] } = spec;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color().setRGB(...backgroundLinear);
  const camera = new THREE.PerspectiveCamera(cam.yFovDeg, ctx.size[0] / ctx.size[1], cam.nearM, cam.farM);
  camera.position.set(...cam.positionM);
  camera.up.set(...cam.upDir);
  camera.lookAt(...cam.lookAtM);

  const GEOMETRY = {
    box: (o) => new THREE.BoxGeometry(...o.sizeM),
    plane: (o) => new THREE.PlaneGeometry(...o.sizeM),
    sphere: (o) => new THREE.SphereGeometry(o.radiusM, 64, 32),
    cylinder: (o) => new THREE.CylinderGeometry(o.radiusM, o.radiusM, o.heightM, 128),
  };
  const entities = {}, disposable = [];
  for (const o of objects) {
    if (!GEOMETRY[o.shape] || (o.motion && !['linear', 'spin'].includes(o.motion.kind))) throw new Error(`不认识物体 ${o.id} 的形状或运动`);
    const geometry = GEOMETRY[o.shape](o);
    const common = { toneMapped: false, side: o.shape === 'plane' ? THREE.DoubleSide : THREE.FrontSide };
    const material = o.material ? new THREE.MeshStandardMaterial({ ...common, roughness: o.material.roughnessRatio, metalness: o.material.metallicRatio }) : new THREE.MeshBasicMaterial(common);
    material.color.setRGB(...(o.material?.baseColorLinear ?? o.emissionLinear));
    if (o.material) material.emissive.setRGB(...o.emissionLinear);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = o.id;
    scene.add(mesh);
    entities[o.id] = mesh;
    disposable.push(geometry, material);
  }
  for (const l of lights) {
    if (l.kind !== 'point') throw new Error(`不认识灯 ${l.id} 的种类`);
    const light = new THREE.PointLight(new THREE.Color().setRGB(...l.colorLinear), l.powerW / (4 * Math.PI), 0, 2);
    light.position.set(...l.positionM);
    scene.add(light);
  }
  const v = (a) => new THREE.Vector3(...a);
  const quat = (axis, angle) => new THREE.Quaternion().setFromAxisAngle(v(axis).normalize(), angle);

  return {
    scene,
    camera,
    entities,
    state(f, sub) {
      const t = f + sub;
      for (const o of objects) {
        const m = o.motion, mesh = entities[o.id];
        const rs = o.rotation ? quat(o.rotation.axisDir, o.rotation.angleRad) : new THREE.Quaternion();
        if (m?.kind === 'spin') {
          const rm = quat(m.axisDir, m.angularVelocityRadPerFrame * t);
          mesh.quaternion.copy(rm).multiply(rs);
          mesh.position.copy(v(o.positionM).sub(v(m.pivotM)).applyQuaternion(rm).add(v(m.pivotM)));
        } else {
          mesh.quaternion.copy(rs);
          mesh.position.copy(v(o.positionM)).addScaledVector(v(m?.velocityMPerFrame ?? [0, 0, 0]), t);
        }
      }
    },
    meta() {
      return {};
    },
    dispose() {
      for (const x of disposable) x.dispose();
    },
  };
};
