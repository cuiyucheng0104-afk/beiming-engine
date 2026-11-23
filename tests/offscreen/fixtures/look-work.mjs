// 整条后期链对拍的作品夹具：ink-scene 的场景 → TSL look（bloom、调色、Kuwahara、墨线、纸纹、暗角、颗粒）→ 交给宿主。
// 参数由测试在 import 前写到 globalThis.__LOOK = { defaults, p, ss, imagePaper, paperFile?, msaa? }；paperFile 是纸纹 PNG 的绝对路径。
import { createLook } from '../../../engine/offscreen/tsl/look.js';
import { inkScene } from './ink-scene.mjs';
import { paperTile } from './look-paper.mjs';
import { loadPaper } from '../../../engine/offscreen/paper.mjs';
import { mergeParams } from '../../../engine/style/index.js';

export function build({ THREE, TSL, renderer, width: W, height: H, pipeline }) {
  const { defaults, p, ss, refHeight = 1080, imagePaper, perFrameTile, paperFile, msaa = 0, fogColor, ortho = false } = globalThis.__LOOK;
  const { scene, camera: persp } = inkScene(THREE, W, H);
  let camera = persp;
  if (ortho) {
    const h = 3.2, w = h * (W / H);
    camera = new THREE.OrthographicCamera(-w, w, h, -h, 0.1, 100);
    camera.position.copy(persp.position); camera.lookAt(0, 0, 0);
  }
  let paper = paperFile ? loadPaper(THREE, paperFile) : null;
  let frameTex = null;
  const pp = { ...p };
  if (imagePaper) {
    const { px, size, mid } = paperTile();
    const tex = new THREE.DataTexture(px, size, size, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.needsUpdate = true;
    paper = { tex, mid };
  }
  if (perFrameTile) {
    const { px, size, mid } = paperTile();
    frameTex = new THREE.DataTexture(px, size, size, THREE.RGBAFormat);
    frameTex.wrapS = frameTex.wrapT = THREE.RepeatWrapping; frameTex.minFilter = frameTex.magFilter = THREE.LinearFilter; frameTex.needsUpdate = true;
    pp.paper = { ...(p.paper || {}), tex: frameTex, mid };
  }
  const look = createLook({ THREE, TSL, renderer }, { width: W, height: H, ss, msaa, refHeight, fps: 24, defaults, paper, fogColor });
  const post = pipeline(look.output);
  return {
    render() { look.render(scene, camera, globalThis.__LOOKDEV ? mergeParams(pp, globalThis.__LOOKDEV) : pp); post.render(); },
    dispose() { look.dispose(); paper?.tex.dispose(); frameTex?.dispose(); },
  };
}
