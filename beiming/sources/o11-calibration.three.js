// World-space scale, ground, camera boundary and local rotations with observable reference values.
export function build({ THREE }) {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 50), scene = new THREE.Scene();
  const material = new THREE.MeshBasicMaterial();
  const entities = {};
  function add(name, geometry, pos) {
    const obj = new THREE.Mesh(geometry, material);
    obj.position.set(...pos);
    scene.add(obj);
    entities[name] = obj;
    return obj;
  }
  const triangle = new THREE.BufferGeometry();
  triangle.setAttribute('position', new THREE.Float32BufferAttribute([-0.05, -0.05, 0, 0.05, -0.05, 0, 0, 0.05, 0], 3));
  add('near', triangle, [0, 0, -0.5]);
  add('edge', triangle, [0, 0, -1]);
  add('outside', triangle, [4, 0, -0.5]);
  add('behind', triangle, [0, 0, 0.5]);
  add('finger', new THREE.BoxGeometry(0.1, 0.1, 0.1), [0, 0.0481, -2]);
  const foot = add('foot', new THREE.BoxGeometry(0.1, 0.1, 0.1), [0, 0.05, -3]);
  const deform = add('deform', triangle, [0, 1, -3]);
  const lead = add('lead', triangle, [-1, 1, -3]);
  const follow = add('follow', triangle, [1, 1, -3]);
  const rig = add('rig', triangle, [0, 2, -4]);
  const leadBone = new THREE.Bone(), followBone = new THREE.Bone();
  leadBone.name = 'pilot';
  followBone.name = 'lag';
  rig.add(leadBone, followBone);
  const shifted = add('shifted', triangle, [0.65, 0, -0.5]);
  shifted.visible = false;
  return {
    camera, scene, entities, meta: () => ({}),
    state(f) {
      deform.scale.x = f === 1 ? 3.78 : 1;
      deform.position.x = f * 0.5;
      deform.rotation.z = f * 0.15;
      foot.position.set(Math.min(f, 2) * 0.025, f >= 2 ? 0.1 : 0.05, -3);
      lead.rotation.z = f >= 1 ? 0.7 : 0;
      follow.rotation.z = f >= 3 ? 0.6 : 0;
      leadBone.rotation.z = lead.rotation.z;
      followBone.rotation.z = follow.rotation.z;
      camera.filmOffset = f === 2 ? 20 : 0;
      camera.updateProjectionMatrix();
      shifted.visible = true;
    },
    dispose() {
      for (const obj of Object.values(entities)) obj.geometry.dispose();
      material.dispose();
    },
  };
}
