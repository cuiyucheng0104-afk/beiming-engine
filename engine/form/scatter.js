// 北冥引擎 · 表面散布：在网格表面按逐顶点权重确定性地撒点，把小物件摆到点上，打成一个实例化网格。
// 同一个种子永远撒在同样的位置（随机数来自 mulberry），重渲逐帧一致。
//   withWeights(geo, { 名: Float32Array }) → 共享 position / normal / index、另带权重属性的几何体（只给采样用）
//   weightedSampler(geo, 权重名, 种子) → MeshSurfaceSampler（.sample(p, n) 取点和法线）
//   samplersOn(geo, weights) → (权重名, 种子) => sampler
//   placeOnSurface(p, n, { yaw, scale, sink, lean }) → Matrix4：局部 +Y 朝法线（可加 lean 偏一偏），绕法线转 yaw，沿法线埋进 sink
//   placeAligned(p, n, along, scale, sink) → Matrix4：局部 +Y 朝法线，局部 +X 顺着 along 在切平面上的投影
//   pickFrom(r, arr)  用一个 [0,1) 随机数从数组里挑一个
//   instanced(geo, mat, items, name, { attrs, bind }) → InstancedMesh；items = [{ m: Matrix4, c?: 颜色 }]，
//       attrs 是挂到 geo 上的逐实例属性，bind(mesh, mat) 交给着色那一层挂材质 / 描边标记
import * as THREE from 'three';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';
import { mulberry } from '../core/math.js';

const UP = new THREE.Vector3(0, 1, 0);

export function withWeights(geo, weights) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', geo.attributes.position); g.setAttribute('normal', geo.attributes.normal); g.setIndex(geo.index);
  for (const k in weights) g.setAttribute(k, new THREE.BufferAttribute(weights[k], 1));
  return g;
}

export const weightedSampler = (geo, name, seed) => new MeshSurfaceSampler(new THREE.Mesh(geo)).setWeightAttribute(name).setRandomGenerator(mulberry(seed)).build();

export function samplersOn(geo, weights) {
  const g = withWeights(geo, weights);
  return (name, seed) => weightedSampler(g, name, seed);
}

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _c = new THREE.Color();

export function placeOnSurface(p, n, { yaw = 0, scale, sink = 0, lean = null }) {
  const up = n.clone(); if (lean) up.add(lean).normalize();
  _q.setFromUnitVectors(UP, up); _q2.setFromAxisAngle(UP, yaw); _q.multiply(_q2);
  return new THREE.Matrix4().compose(p.clone().addScaledVector(n, -sink), _q.clone(), scale);
}

export function placeAligned(p, n, along, scale, sink = 0) {
  const y = n.clone().normalize();
  const x = along.clone().addScaledVector(y, -along.dot(y)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  const m = new THREE.Matrix4().makeBasis(x, y, z).scale(scale);
  m.setPosition(p.clone().addScaledVector(y, -sink));
  return m;
}

export const pickFrom = (r, arr) => arr[Math.floor(r * arr.length) % arr.length];

export function instanced(geo, mat, items, name, { attrs = null, bind = null } = {}) {
  const m = new THREE.InstancedMesh(geo, mat, Math.max(1, items.length));
  items.forEach((it, i) => { m.setMatrixAt(i, it.m); if (it.c) m.setColorAt(i, _c.set(it.c)); });
  m.count = items.length;
  m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true;
  if (attrs) for (const k in attrs) geo.setAttribute(k, attrs[k]);
  m.frustumCulled = false; m.name = name;
  if (bind) bind(m, mat);
  return m;
}
