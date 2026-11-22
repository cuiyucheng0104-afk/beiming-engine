// V4 补录用的镜头代码：照校准场景「三轴标记加转台」的规格搭场景（规格直接读校准目录，不抄）。
// 物体是不受光的自发光体；世界变换同 calib/check.mjs 的 objectTransform：R = R运动 · R静态，T = R运动 · (位置 − 枢轴) + 枢轴。
// 圆柱轴沿局部 Y（three 的 CylinderGeometry 也是），球 64×32 段、平滑法线。由 v4-probe.mjs 经页面宿主的帧源接口调用。
import spec from '../../../calib/probe-axes-turntable/scene.json' with { type: 'json' };

export function build(ctx) {
  const { THREE } = ctx;
  const { camera: cam, backgroundLinear, objects } = spec;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color().setRGB(...backgroundLinear);
  const camera = new THREE.PerspectiveCamera(cam.yFovDeg, ctx.size[0] / ctx.size[1], cam.nearM, cam.farM);
  camera.position.set(...cam.positionM);
  camera.up.set(...cam.upDir);
  camera.lookAt(...cam.lookAtM);

  const geometryOf = (o) => (o.shape === 'box' ? new THREE.BoxGeometry(...o.sizeM)
    : o.shape === 'sphere' ? new THREE.SphereGeometry(o.radiusM, 64, 32)
      : o.shape === 'cylinder' ? new THREE.CylinderGeometry(o.radiusM, o.radiusM, o.heightM, 128)
        : null);
  const entities = {}, disposable = [];
  for (const o of objects) {
    const geometry = geometryOf(o);
    if (!geometry || (o.motion && o.motion.kind !== 'spin')) throw new Error(`这个镜头不认识物体 ${o.id} 的形状或运动`);
    const material = new THREE.MeshBasicMaterial({ toneMapped: false });
    material.color.setRGB(...o.emissionLinear);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = o.id;
    scene.add(mesh);
    entities[o.id] = mesh;
    disposable.push(geometry, material);
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
        const rs = o.rotation ? quat(o.rotation.axisDir, o.rotation.angleRad) : new THREE.Quaternion();
        const m = o.motion, mesh = entities[o.id];
        if (!m) { mesh.quaternion.copy(rs); mesh.position.set(...o.positionM); continue; }
        const rm = quat(m.axisDir, m.angularVelocityRadPerFrame * t);
        mesh.quaternion.copy(rm).multiply(rs);
        mesh.position.copy(v(o.positionM).sub(v(m.pivotM)).applyQuaternion(rm).add(v(m.pivotM)));
      }
    },
    meta() {
      return {};
    },
    dispose() {
      for (const x of disposable) x.dispose();
    },
  };
}
