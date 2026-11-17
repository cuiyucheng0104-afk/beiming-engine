// 北冥引擎 · 离屏出片 · 全屏 pass 的公共底座：QuadMesh + NodeMaterial，把片元节点画进渲染目标（null = 当前宿主目标不动，用 draw(mat, target) 显式指定）。
//   createFullscreen({ THREE, renderer }) → { material(fragmentNode) → NodeMaterial, draw(mat, target) }
// 屏幕坐标：WebGPU 的 screenCoordinate 是左上角原点；GLSL 版的 gl_FragCoord 是左下角，需要 GL 坐标的地方用 glCoord。
export function createFullscreen({ THREE, renderer }) {
  const quad = new THREE.QuadMesh();
  return {
    material(fragmentNode) { const m = new THREE.NodeMaterial(); m.fragmentNode = fragmentNode; return m; },
    draw(material, target) { quad.material = material; renderer.setRenderTarget(target); quad.render(renderer); },
  };
}

// 与 gl_FragCoord.xy 同约定（像素中心、左下角原点）的坐标节点；h = 目标高度（像素）
export const glCoord = (TSL, h) => TSL.vec2(TSL.screenCoordinate.x, TSL.float(h).sub(TSL.screenCoordinate.y));
