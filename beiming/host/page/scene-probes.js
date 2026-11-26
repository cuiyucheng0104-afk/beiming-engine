import * as THREE from 'three';
import { measureProbe, poseKey, probeFrames, probeTargets } from '../../sources/scene-probe-measure.mjs';

function meshIndices(mesh, cameraProbe) {
  const { geometry } = mesh;
  const size = geometry.index?.count ?? geometry.attributes.position.count;
  const range = cameraProbe ? geometry.drawRange : { start: 0, count: size };
  const spans = cameraProbe && Array.isArray(mesh.material)
    ? geometry.groups.filter((group) => mesh.material[group.materialIndex]?.visible)
    : [{ start: 0, count: size }];
  const result = [];
  for (const span of spans) {
    const start = Math.max(range.start, span.start), end = Math.min(size, range.start + range.count, span.start + span.count);
    for (let i = start; i + 2 < end; i += 3) {
      for (let j = i; j < i + 3; j++) result.push(geometry.index?.getX(j) ?? j);
    }
  }
  return result;
}

function capture(object, plan, size) {
  const { camera, entities, scene } = object;
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  const poses = Object.create(null);
  const namesByMesh = new Map(), visible = new Set();
  const cameraProbe = ['probe.near-clip', 'probe.tri-budget'].includes(plan.kind);
  const needMeshes = plan.kind !== 'probe.joint-vel';
  const point = new THREE.Vector3(), matrix = new THREE.Matrix4(), quat = new THREE.Quaternion();
  if (cameraProbe) scene.traverseVisible((mesh) => { if (camera.layers.test(mesh.layers)) visible.add(mesh); });
  if (cameraProbe && plan.allScene) for (const mesh of visible) namesByMesh.set(mesh, []);
  for (const { name, bone } of probeTargets(plan)) {
    const root = entities[name];
    if (!root) continue;
    let joint = root;
    if (bone) {
      root.traverse((obj) => { if (obj.isSkinnedMesh) joint = obj.skeleton.getBoneByName(bone) ?? joint; });
      if (joint === root && !(root.isBone && root.name === bone)) joint = root.getObjectByName(bone);
      if (!joint?.isBone) continue;
    }
    const pose = { position: joint.getWorldPosition(point).toArray(), rotation: joint.quaternion.clone().normalize().toArray() };
    if (plan.kind === 'probe.deform') {
      joint.getWorldQuaternion(quat).normalize();
      pose.rootInverse = matrix.compose(point, quat, new THREE.Vector3(1, 1, 1)).invert().toArray();
    }
    poses[poseKey(name, bone)] = pose;
    if (needMeshes) root.traverse((mesh) => {
      if (!namesByMesh.has(mesh)) namesByMesh.set(mesh, []);
      namesByMesh.get(mesh).push(name);
    });
  }

  const meshes = [];
  for (const [mesh, names] of namesByMesh) {
    const position = mesh.geometry?.attributes.position;
    if (!mesh.isMesh || !position) continue;
    if (mesh.isSkinnedMesh) mesh.skeleton.update();
    const indices = meshIndices(mesh, cameraProbe);
    const inView = visible.has(mesh) && mesh.material?.visible !== false;
    for (let i = 0; i < (mesh.isInstancedMesh ? mesh.count : 1); i++) {
      if (mesh.isInstancedMesh) {
        mesh.getMatrixAt(i, matrix);
        matrix.premultiply(mesh.matrixWorld);
      } else matrix.copy(mesh.matrixWorld);
      const vertices = Array.from({ length: position.count }, (_, j) => mesh.getVertexPosition(j, point).applyMatrix4(matrix).toArray());
      meshes.push({ id: `${mesh.uuid}:${i}`, names, vertices, indices, visible: inView });
    }
  }

  const proj = camera.clone(false);
  proj.aspect = size[0] / size[1];
  proj.updateProjectionMatrix();
  const p = proj.projectionMatrix.elements;
  return {
    meshes, poses,
    camera: { view: camera.matrixWorldInverse.toArray(), left: (p[8] - 1) / p[0], right: (p[8] + 1) / p[0],
      bottom: (p[9] - 1) / p[5], top: (p[9] + 1) / p[5], near: camera.near, far: camera.far },
  };
}

export function querySceneProbe(loaded, f, plan, size = loaded.size) {
  const { object } = loaded, samples = new Map();
  try {
    for (const frame of probeFrames(plan, f)) {
      object.state(frame, 0);
      samples.set(frame, capture(object, plan, size));
    }
  } finally {
    object.state(f, 0);
  }
  return measureProbe(plan, samples, f);
}
