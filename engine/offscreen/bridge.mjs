// 北冥引擎 · 离屏出片 · 几何桥：engine/form 的造型函数顶层 import 了仓库的 three r170，离屏用 r187；几何只是数据，按属性拷过去即可复用，不用改造型代码。
//   geometry(THREE, g) → r187 的 BufferGeometry：position / normal / uv / 自定义属性（如 aRock、aPart）、index、groups、userData 原样带过去；
//                        数组共用同一块内存（不复制），所以之后别再改 g 的数组
// 相机工具（engine/stage/camera.js 的 aimCamera、project、placeOnScreen…）可以直接操作 r187 的相机与物体，不需要桥。
export function geometry(THREE, g) {
  const out = new THREE.BufferGeometry();
  for (const [k, a] of Object.entries(g.attributes)) {
    if (a.isInterleavedBufferAttribute) throw new TypeError(`几何桥不支持交错属性（${k}）：造型函数里先 toNonIndexed / 拆开再交进来`);
    out.setAttribute(k, new THREE.BufferAttribute(a.array, a.itemSize, a.normalized));
  }
  if (g.index) out.setIndex(new THREE.BufferAttribute(g.index.array, 1));
  for (const gr of g.groups) out.addGroup(gr.start, gr.count, gr.materialIndex);
  out.userData = g.userData;
  return out;
}
