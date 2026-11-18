// 北冥引擎 · 离屏出片 · 几何与场景图桥：engine/form 的造型函数与 src/ 的角色（顶层 import 仓库的 three r170）拷进 r187 复用，不用改只读的 src/。
//   geometry(THREE, g) → r187 的 BufferGeometry：position / normal / uv / 自定义属性（含 InstancedBufferAttribute）、index、groups、userData 原样带过去，共用同一块 TypedArray
//   mirrorObject(THREE, root170, { mapMaterial }) → { root, map, pairs, sync() }：
//     递归镜像 Group / Object3D / Mesh / InstancedMesh；每帧在 r170 侧跑完 setPose / CPU 顶点形变 / 实例矩阵更新后调一次 sync()，
//     自动同步层级变换、手动矩阵（matrixAutoUpdate = false）以及升过 version 的顶点与实例缓冲。
// 相机工具（engine/stage/camera.js 的 aimCamera、project、placeOnScreen…）可以直接操作 r187 的相机与物体，不需要桥。
export function geometry(THREE, g) {
  const out = new THREE.BufferGeometry();
  for (const [k, a] of Object.entries(g.attributes)) {
    if (a.isInterleavedBufferAttribute) throw new TypeError(`几何桥不支持交错属性（${k}）：造型函数里先 toNonIndexed / 拆开再交进来`);
    const Attr = a.isInstancedBufferAttribute ? THREE.InstancedBufferAttribute : THREE.BufferAttribute;
    out.setAttribute(k, a.isInstancedBufferAttribute ? new Attr(a.array, a.itemSize, a.normalized, a.meshPerAttribute ?? 1) : new Attr(a.array, a.itemSize, a.normalized));
  }
  if (g.index) out.setIndex(new THREE.BufferAttribute(g.index.array, 1));
  for (const gr of g.groups) out.addGroup(gr.start, gr.count, gr.materialIndex);
  out.userData = g.userData;
  return out;
}

export function mirrorObject(THREE, root170, { mapMaterial } = {}) {
  const map = new Map(), pairs = [], geoMap = new Map(), attrLinks = [];
  const track = (s, d) => { if (s && d) attrLinks.push([s, d, s.version]); };
  const getGeo = g => {
    let h = geoMap.get(g);
    if (!h) {
      h = geometry(THREE, g);
      for (const k of Object.keys(g.attributes)) track(g.attributes[k], h.attributes[k]);
      if (g.index) track(g.index, h.index);
      geoMap.set(g, h);
    }
    return h;
  };
  const syncTransform = (s, d) => {
    d.visible = s.visible;
    d.renderOrder = s.renderOrder;
    if (s.matrixAutoUpdate === false) {
      d.matrix.fromArray(s.matrix.elements);
      d.matrixWorldNeedsUpdate = true;
    } else {
      d.position.set(s.position.x, s.position.y, s.position.z);
      d.quaternion.set(s.quaternion.x, s.quaternion.y, s.quaternion.z, s.quaternion.w);
      d.scale.set(s.scale.x, s.scale.y, s.scale.z);
    }
    if (s.isInstancedMesh) d.count = s.count;
  };
  const visit = s => {
    let d;
    if (s.isInstancedMesh) {
      const g = getGeo(s.geometry), m = mapMaterial ? mapMaterial(s.material, s) : new THREE.MeshBasicMaterial();
      d = new THREE.InstancedMesh(g, m, s.instanceMatrix.count);
      d.count = s.count;
      d.instanceMatrix = new THREE.InstancedBufferAttribute(s.instanceMatrix.array, 16);
      track(s.instanceMatrix, d.instanceMatrix);
      if (s.instanceColor) {
        d.instanceColor = new THREE.InstancedBufferAttribute(s.instanceColor.array, 3);
        track(s.instanceColor, d.instanceColor);
      }
    } else if (s.isMesh) {
      const g = getGeo(s.geometry), m = mapMaterial ? mapMaterial(s.material, s) : new THREE.MeshBasicMaterial();
      d = new THREE.Mesh(g, m);
    } else if (s.isGroup) {
      d = new THREE.Group();
    } else {
      d = new THREE.Object3D();
    }
    d.name = s.name;
    d.castShadow = s.castShadow; d.receiveShadow = s.receiveShadow;
    d.frustumCulled = s.frustumCulled; d.renderOrder = s.renderOrder;
    d.layers.mask = s.layers.mask;
    d.matrixAutoUpdate = s.matrixAutoUpdate;
    d.userData = { ...s.userData };
    if (d.userData.outlineVertex && !d.userData.outlineVertex.tsl) delete d.userData.outlineVertex;
    syncTransform(s, d);
    map.set(s, d); pairs.push([s, d]);
    for (const c of s.children) d.add(visit(c));
    return d;
  };
  const root = visit(root170);
  function sync() {
    for (const [s, d] of pairs) syncTransform(s, d);
    for (const link of attrLinks) {
      if (link[0].version !== link[2]) { link[1].needsUpdate = true; link[2] = link[0].version; }
    }
  }
  return { root, map, pairs, sync };
}
