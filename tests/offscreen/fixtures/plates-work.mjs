// 底板对拍的作品夹具：plates-scene 用离屏 tsl/plates.js（PNG 由 tools/plates/png.mjs 解码）→ TSL look（后期全关，由测试给参数）→ 交给宿主。
import { fileURLToPath } from 'node:url';
import { createPlates } from '../../../engine/offscreen/tsl/plates.js';
import { createLook } from '../../../engine/offscreen/tsl/look.js';
import { platesScene } from './plates-scene.mjs';

const DIR = fileURLToPath(new URL('../../../assets/plates/', import.meta.url));
export async function build({ THREE, TSL, renderer, width: W, height: H, pipeline }) {
  const P = await createPlates({ THREE, TSL });
  const { tex } = P.loadPlates(['sky_dawn', 'clouds_front_a'], { dir: DIR });
  const { scene, camera } = platesScene({ THREE, P, W, H, sky: tex.sky_dawn, cloud: tex.clouds_front_a });
  const look = createLook({ THREE, TSL, renderer }, { width: W, height: H, ss: 1, msaa: 0, fps: 24 });
  const post = pipeline(look.output);
  return { render() { look.render(scene, camera, { t: 0, ...globalThis.__PLATES_P }); post.render(); }, dispose() { look.dispose(); } };
}
