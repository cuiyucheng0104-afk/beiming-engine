// 墨线对拍的作品夹具：ink-scene 的场景 → TSL 墨线 → 把笔画覆盖率当灰度输出（转回线性，宿主的 sRGB 目标会再编码一次，往返至多差 1 级）。
// 参数由测试在 import 前写到 globalThis.__INK = { p, t, k, ss, fps }。
import { createInk } from '../../../engine/offscreen/tsl/ink.js';
import { inkScene } from './ink-scene.mjs';

export function build({ THREE, TSL, renderer, width: W, height: H, pipeline }) {
  const { texture, vec3, vec4, ivec2, screenCoordinate, sRGBTransferEOTF } = TSL;
  const { scene, camera } = inkScene(THREE, W, H);
  const ink = createInk({ THREE, TSL, renderer }, { width: W, height: H });
  const cov = texture(ink.line.texture).load(ivec2(screenCoordinate.xy)).x;
  const post = pipeline(vec4(sRGBTransferEOTF(vec3(cov, cov, cov)), 1));
  return {
    render() {
      const { p, t, k, ss, fps } = globalThis.__INK;
      ink.render({ scene, camera, p, t, k, ss, fps });
      post.render();
    },
    dispose() { ink.dispose(); },
  };
}
