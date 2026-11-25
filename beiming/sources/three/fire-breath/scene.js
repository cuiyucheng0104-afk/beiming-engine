import { applyPooledLight } from '../../../cards/lighting/emit-pool/three.js';
import { bodiesAt, cameraAt, railPoint, windAt } from './motion-flight.js';
import { emissionAt, plumeMeshes } from './particle-plume.js';
import { creature } from './scene-creature.js';
import { createEnvironment } from './scene-environment.js';

/** Absolute sequence frame at 60 Hz. No renderer, scene graph or previous sample is needed. */
export function sampleFrame(frame, sub = 0, params = {}) {
  if (!Number.isInteger(frame) || frame < 2790 || frame > 2885 || !Number.isFinite(sub) || sub < 0 || sub >= 1)
    throw new RangeError('expected an absolute shot frame and subframe in [0,1)');
  const time = (frame + sub) / 60,
    bodies = bodiesAt(time, params);
  return {
    frame,
    sub,
    time,
    bodies,
    camera: cameraAt(time, params),
    baked: windAt(time, params),
    ...emissionAt(time, bodies[0], params),
  };
}
function disposeMeshes(root) {
  const gs = new Set(),
    ms = new Set();
  root.traverse((o) => {
    if (o.geometry) gs.add(o.geometry);
    if (o.material) for (const m of [o.material].flat()) ms.add(m);
    if (o.isInstancedMesh) o.dispose();
  });
  for (const g of gs) g.dispose();
  for (const m of ms) m.dispose();
  root.clear();
}
export function createScene(THREE, params = {}, width = 1920, height = 1080) {
  const scene = new THREE.Scene(),
    fxScene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(28, width / height, 0.5, 6000);
  const terrain = createEnvironment(THREE, params, width, height),
    animals = [0, 1].map((i) => creature(THREE, i, params, height));
  const entities = { sky: terrain.sky, canyon: terrain.canyon, serpent: animals[0].root, rival: animals[1].root };
  for (const [id, o] of Object.entries(entities)) {
    o.name = id;
    scene.add(o);
  }
  const skyFill = new THREE.HemisphereLight(new THREE.Color(0.39, 0.45, 0.7), new THREE.Color(0.4, 0.27, 0.22), 1.1),
    sun = new THREE.DirectionalLight(new THREE.Color(1, 0.72, 0.49), 4.7);
  sun.target.position.set(0, 48, -38);
  sun.position.copy(sun.target.position).addScaledVector(new THREE.Vector3(0.558, 0.423, 0.714).normalize(), 520);
  sun.castShadow = true;
  Object.assign(sun.shadow.camera, { left: -140, right: 140, top: 155, bottom: -155, near: 20, far: 980 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.00025;
  sun.shadow.normalBias = 0.15;
  scene.add(sun.target);
  const rim = new THREE.DirectionalLight(new THREE.Color(0.62, 0.78, 1), 0.55);
  rim.position.set(-0.25, 0.82, -0.59);
  const fireLight = new THREE.PointLight(0xff9a43, 0, 180, 1.7);
  scene.add(skyFill, sun, rim, fireLight);
  if (terrain.rain) fxScene.add(terrain.rain);
  const plume = plumeMeshes(THREE, params, fxScene, width, height);
  let last = null,
    actualHeight = height;
  function state(f, sub = 0) {
    const s = sampleFrame(f, sub, params),
      c = s.camera;
    camera.position.fromArray(c.position);
    camera.lookAt(...c.target);
    camera.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(...c.trim, 'YXZ')));
    camera.fov = c.fov;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    animals.forEach((a, i) => a.update(s.bodies[i], s, actualHeight));
    terrain.update?.(s);
    applyPooledLight(fireLight, s.light, THREE);
    plume.update(s);
    scene.updateMatrixWorld(true);
    fxScene.updateMatrixWorld(true);
    last = s;
    return s;
  }
  function meta(f) {
    const s = last?.frame === f && last.sub === 0 ? last : sampleFrame(f, 0, params);
    return {
      anchors: { 'serpent#mouth': [...s.breath.mouth], 'rival#mouth': [...s.bodies[1].mouth] },
      readings: {
        'breath.power': s.breath.intensity,
        'breath.reachM': s.breath.length,
        'breath.particles': s.particles.fire.length,
        'wake.embers': s.particles.embers.length,
        'wake.smoke': s.particles.smoke.length,
        'pool.power': s.light.intensity,
        'flight.speed': s.bodies[0].speed,
        'wind.bend': s.baked,
      },
    };
  }
  state(2790, 0);
  return {
    scene,
    fxScene,
    camera,
    entities,
    state,
    meta,
    railPoint,
    setDepth(texture) {
      const next = texture?.image?.height ?? height;
      if (next !== actualHeight && last) animals.forEach((a, i) => a.update(last.bodies[i], last, next));
      actualHeight = next;
      terrain.setDepth?.(texture);
      plume.setDepth(texture);
    },
    dispose() {
      sun.shadow.dispose();
      if (terrain.rain) fxScene.remove(terrain.rain);
      terrain.dispose?.();
      for (const a of animals) {
        a.dispose();
        disposeMeshes(a.root);
      }
      disposeMeshes(fxScene);
      scene.clear();
      last = null;
    },
  };
}
