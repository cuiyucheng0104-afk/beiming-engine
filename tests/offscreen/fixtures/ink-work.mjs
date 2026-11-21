// 墨线对拍的作品夹具：ink-scene 的场景 → TSL 墨线 → 把笔画覆盖率当灰度输出（转回线性，宿主的 sRGB 目标会再编码一次，往返至多差 1 级）。
// 参数由测试在 import 前写到 globalThis.__INK = { p, t, k, ss, fps, impl?, fog?, fogColor?, empty?, ortho? }。
import { createInk } from '../../../engine/offscreen/tsl/ink.js';
import { createInkLegacy } from './ink-legacy.js';
import { inkScene } from './ink-scene.mjs';

export function build({ THREE, TSL, renderer, width: W, height: H, pipeline }) {
  const { texture, vec3, vec4, ivec2, screenCoordinate, sRGBTransferEOTF } = TSL;
  const o = globalThis.__INK || {};
  let scene, camera;
  if (o.empty) {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(35, W / H, 0.1, 100);
    camera.position.set(0, 1.2, 9);
    camera.lookAt(0, 0, 0);
  } else {
    ({ scene, camera } = inkScene(THREE, W, H));
    if (o.ortho) {
      const a = W / H, s = 3.2;
      camera = new THREE.OrthographicCamera(-s * a, s * a, s, -s, 0.1, 100);
      camera.position.set(0, 1.2, 9);
      camera.lookAt(0, 0, 0);
    }
  }
  const make = o.impl === 'legacy' ? createInkLegacy : createInk;
  const ink = make({ THREE, TSL, renderer }, { width: W, height: H });
  const cov = texture(ink.line.texture).load(ivec2(screenCoordinate.xy)).x;
  const post = pipeline(vec4(sRGBTransferEOTF(vec3(cov, cov, cov)), 1));
  return {
    render() {
      const { p, t, k, ss, fps, fog = null, fogColor } = globalThis.__INK;
      ink.render({ scene, camera, p, fog, fogColor, t, k, ss, fps });
      post.render();
    },
    dispose() { ink.dispose(); },
  };
}
