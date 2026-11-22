// 北冥引擎 · 离屏出片 · 后期调试视图（TSL）：engine/look/debug.js 的对应——把中间缓冲画到输出看。
//   DEBUG_VIEWS：['id', 'depth', 'edge', 'line', 'bloom', 'paper', 'kuwahara', 'scene']
//   createDebugView({ THREE, TSL }, { width, height, depthTexture }) → {
//     node                               vec4 节点（rgb = [0,1] sRGB 数值，a = 1）
//     update(mode, buffers, camera)      切换当前显示的纹理与相机近远面；未知视图名退回 buffers.kuwahara
//     dispose()
//   }
// 注意：WGSL 里深度纹理（texture_depth_2d）不能绑进普通颜色采样槽，因此 depth 单独走构造时绑定的 depthTexture 节点。
const MODES = { id: 1, depth: 2, edge: 3, line: 4, bloom: 5, paper: 6, kuwahara: 0, scene: 5 };
export const DEBUG_VIEWS = Object.keys(MODES);

export function createDebugView({ THREE, TSL }, { width: W, height: H, depthTexture }) {
  const { Fn, uniform, texture, vec2, vec3, vec4, float, abs, fract, clamp, log, select, screenCoordinate, perspectiveDepthToViewZ } = TSL;
  const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); black.needsUpdate = true;
  const tColor = texture(black);
  const tDepth = texture(depthTexture);
  const U = { mode: uniform(0), near: uniform(0.1), far: uniform(100), scale: uniform(1) };

  const hue = x => clamp(abs(fract(vec3(x, x.add(2 / 3), x.add(1 / 3))).mul(6).sub(3)).sub(1), 0, 1);

  const node = Fn(() => {
    const uvT = screenCoordinate.xy.div(vec2(W, H));
    const a = tColor.sample(uvT).level(0);
    const d = tDepth.sample(uvT).level(0).x;
    const m = U.mode;
    const c = a.rgb.toVar();

    // 1: id（按黄金分割色相着色，alpha 控制明暗）
    const idVal = a.x.add(a.y.mul(2048));
    const cId = select(idVal.lessThan(0.5), vec3(0), hue(fract(idVal.mul(0.61803))).mul(float(0.5).add(a.w.mul(0.5))));
    c.assign(select(m.greaterThan(0.5).and(m.lessThan(1.5)), cId, c));

    // 2: depth（对数视空间深度）
    const z = perspectiveDepthToViewZ(d, U.near, U.far).negate();
    const cDepth = vec3(float(1).sub(clamp(log(z).div(log(U.far)), 0, 1)));
    c.assign(select(m.greaterThan(1.5).and(m.lessThan(2.5)), cDepth, c));

    // 3: edge（强度 / 半线宽 / 深度差）
    const cEdge = vec3(a.x, a.y.div(6), a.z);
    c.assign(select(m.greaterThan(2.5).and(m.lessThan(3.5)), cEdge, c));

    // 4: line（白底黑线）
    const cLine = vec3(float(1).sub(a.r));
    c.assign(select(m.greaterThan(3.5).and(m.lessThan(4.5)), cLine, c));

    // 5: bloom（×4）或 scene（×1）
    const cLin = a.rgb.mul(U.scale);
    c.assign(select(m.greaterThan(4.5).and(m.lessThan(5.5)), cLin, c));

    // 6: paper
    const cPaper = vec3(a.r);
    c.assign(select(m.greaterThan(5.5), cPaper, c));

    return vec4(clamp(c, 0, 1), 1);
  })();

  function update(mode, buffers, camera) {
    U.near.value = camera.near; U.far.value = camera.far;
    const known = Object.hasOwn(MODES, mode);
    const code = known ? MODES[mode] : 0;
    U.mode.value = code;
    U.scale.value = mode === 'bloom' ? 4 : 1;
    tColor.value = (code === 2 ? black : (known ? buffers[mode] : buffers.kuwahara)) || black;
    tDepth.value = buffers.depth || depthTexture;
  }

  return { node, update, dispose() { black.dispose(); } };
}
