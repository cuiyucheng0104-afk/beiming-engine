// 整条后期链对拍的作品夹具：ink-scene 的场景 → TSL look（bloom、调色、Kuwahara、墨线、纸纹、暗角、颗粒）→ 交给宿主。
// 参数由测试在 import 前写到 globalThis.__LOOK = { defaults, p, ss, imagePaper, paperFile?, msaa? }；paperFile 是纸纹 PNG 的绝对路径。
import { createLook } from '../../../engine/offscreen/tsl/look.js';
import { inkScene } from './ink-scene.mjs';
import { paperTile } from './look-paper.mjs';
import { loadPaper } from '../../../engine/offscreen/paper.mjs';

export function build({ THREE, TSL, renderer, width: W, height: H, pipeline }) {
  const { defaults, p, ss, imagePaper, paperFile, msaa = 0 } = globalThis.__LOOK;
  const { scene, camera } = inkScene(THREE, W, H);
  let paper = paperFile ? loadPaper(THREE, paperFile) : null;
  if (imagePaper) {
    const { px, size, mid } = paperTile();
    const tex = new THREE.DataTexture(px, size, size, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.needsUpdate = true;
    paper = { tex, mid };
  }
  const look = createLook({ THREE, TSL, renderer }, { width: W, height: H, ss, msaa, fps: 24, defaults, paper });
  const post = pipeline(look.output);
  return {
    render() { look.render(scene, camera, p); post.render(); },
    dispose() { look.dispose(); paper?.tex.dispose(); },
  };
}
