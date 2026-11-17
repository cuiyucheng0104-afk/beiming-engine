// 卡通材质对拍的作品夹具：toon-scene 的场景用 TSL 卡通材质 → TSL look（后期由测试决定，默认全关）→ 交给宿主。参数：globalThis.__TOON = { p, shadow }。
import { toonKind, makeToonShared, setToonShared, useR170Shadow } from '../../../engine/offscreen/tsl/toon.js';
import { createLook } from '../../../engine/offscreen/tsl/look.js';
import { toonScene } from './toon-scene.mjs';
import { patchLayer } from '../../../engine/offscreen/tsl/surface.js';

export function build({ THREE, TSL, renderer, width: W, height: H, pipeline }) {
  const { p = {}, shadow = false, inkTime = 0, wide = false, r187Filter = false, noLights = false, mutate = null } = globalThis.__TOON ?? {};
  renderer.shadowMap.enabled = shadow; renderer.shadowMap.type = THREE.PCFShadowMap;   // r187 没有 PCFSoft；滤波由 useR170Shadow 换掉
  const shared = makeToonShared({ THREE, TSL });
  setToonShared(shared, { inkTime });
  const { scene, camera, mats } = toonScene({ THREE, kind: spec => toonKind({ THREE, TSL }, spec), shared, W, H, shadow, wide, noLights, mutate, TSL, layers: [patchLayer()], tsl: sun => { useR170Shadow(TSL, sun); if (r187Filter) sun.shadow.filterNode = undefined; } });
  const look = createLook({ THREE, TSL, renderer }, { width: W, height: H, ss: 1, msaa: 0, fps: 24 });
  const post = pipeline(look.output);
  // 每帧重读 __TOON.inkTime 与 __TOON.rimAmt：测「渲染途中改参数」（材质的 uniform 在第一帧之后还要跟着变）
  return { render() { const o = globalThis.__TOON ?? {}; setToonShared(shared, { inkTime: o.inkTime ?? inkTime }); if (o.rimAmt !== undefined) for (const m of Object.values(mats)) m.userData.toon.uRimAmt.value = o.rimAmt; look.render(scene, camera, { t: 0, ...p }); post.render(); }, dispose() { look.dispose(); } };
}
