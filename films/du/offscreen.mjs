// 渡 · 离屏出片入口（对照版本，不进 npm run film 出片链）：同一个场景（scene.mjs）在 Node + Dawn 里，经 TSL 版 A 风格后期链出帧。
// 作品模块契约见 docs/offscreen/README.md 2.1。出片：npm run offscreen -- render films/du/offscreen.mjs --out <文件.mp4> --frames 0:96 --size 1920x1080
// 后期参数与 A 路线页面同源：film.json 的 lookPreset → engine/style 的预设（同一份 resolveLook），纸纹用画风锁定的 assets/plates/paper.png。
// globalThis.__DU_MSAA 可改主场景多重采样（默认 4，与页面相同；逐字节对拍时用 0）。
import { readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { buildScene } from './scene.mjs';
import { createLook } from '../../engine/offscreen/tsl/look.js';
import { loadPaper } from '../../engine/offscreen/paper.mjs';
import { decodePng } from '../../tools/plates/png.mjs';
import { loadStyleSync, parseLookPreset, resolveLook } from '../../engine/style/index.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FILM = JSON.parse(readFileSync(new URL('./film.json', import.meta.url), 'utf8'));

export function build({ THREE, TSL, renderer, width: W, height: H, fps, pipeline }) {
  if (fps !== FILM.output.fps) throw new Error(`离屏帧率 ${fps} 和 film.json 的 ${FILM.output.fps} 不一致：一拍二会错拍，出片时带 --fps ${FILM.output.fps}`);
  const style = loadStyleSync(FILM.style), shot = FILM.shots[0];
  const r = resolveLook(style, parseLookPreset(shot.lookPreset).preset, shot.lookOverrides || {}, { strict: true });
  const png = decodePng(readFileSync(`${ROOT}assets/plates/sky_dawn.png`));
  const sky = new THREE.DataTexture(png.data, png.width, png.height, THREE.RGBAFormat);
  sky.colorSpace = THREE.SRGBColorSpace; sky.minFilter = sky.magFilter = THREE.LinearFilter; sky.flipY = true; sky.needsUpdate = true;
  const paper = loadPaper(THREE, `${ROOT}${style.lookDefaults.paper.asset}`);
  const { scene, camera, update, dispose } = buildScene({ THREE, W, H, sky });
  const look = createLook({ THREE, TSL, renderer }, { width: W, height: H, ss: 2, msaa: globalThis.__DU_MSAA ?? 4, refHeight: r.refHeight, fps, defaults: r.defaults, paper });
  const post = pipeline(look.output);
  return {
    render(f) { update(f); look.render(scene, camera, { t: f / fps, ...r.params }); post.render(); },
    dispose() { look.dispose(); dispose(); sky.dispose(); paper.tex.dispose(); },
  };
}
