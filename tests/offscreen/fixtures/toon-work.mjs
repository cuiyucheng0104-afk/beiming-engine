// 卡通材质对拍的作品夹具：toon-scene 的场景用 TSL 卡通材质 → TSL look（后期由测试决定，默认全关）→ 交给宿主。参数：globalThis.__TOON = { p, shadow }。
import { toonKind, makeToonShared, setToonShared, useR170Shadow } from '../../../engine/offscreen/tsl/toon.js';
import { createLook } from '../../../engine/offscreen/tsl/look.js';
import { toonScene } from './toon-scene.mjs';
import { patchLayer } from '../../../engine/offscreen/tsl/surface.js';

export function build({ THREE, TSL, renderer, width: W, height: H, pipeline }) {
  const { p = {}, shadow = false, inkTime = 0, wide = false, r187Filter = false, noLights = false, mutate = null } = globalThis.__TOON ?? {};
  renderer.shadowMap.enabled = shadow; renderer.shadowMap.type = THREE.PCFSoftShadowMap;   // 同 A 路线外壳；PCFShadowMap 时 r187 会给深度比较开硬件过滤
  const shared = makeToonShared({ THREE, TSL });
  setToonShared(shared, { inkTime });
  const { scene, camera } = toonScene({ THREE, kind: spec => toonKind({ THREE, TSL }, spec), shared, W, H, shadow, wide, noLights, mutate, TSL, layers: [patchLayer()], tsl: sun => { useR170Shadow(TSL, sun); if (r187Filter) sun.shadow.filterNode = undefined; } });
  const look = createLook({ THREE, TSL, renderer }, { width: W, height: H, ss: 1, msaa: 0, fps: 24 });
  const post = pipeline(look.output);
  return { render() { look.render(scene, camera, { t: 0, ...p }); post.render(); }, dispose() { look.dispose(); } };
}
