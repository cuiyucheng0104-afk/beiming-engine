// 渡 · 镜头 S1（唯一的镜头）：A 路线页面这一侧的入口。场景本身在 ../scene.mjs，与离屏出片（../offscreen.mjs）共用同一份。
// 这里只做页面才有的事：用浏览器读天空底板（sRGB、线性过滤、不建 mip，与离屏侧的读法一致），后期参数取 film.json 的 lookPreset。
import * as THREE from 'three';
import { frameOf } from '../../../engine/core/clock.js';
import { buildScene } from '../scene.mjs';

export async function build({ fps, DW, DH, preset }) {
  const sky = await new THREE.TextureLoader().loadAsync(new URL('../../../assets/plates/sky_dawn.png', import.meta.url).href);
  sky.colorSpace = THREE.SRGBColorSpace; sky.generateMipmaps = false; sky.minFilter = sky.magFilter = THREE.LinearFilter;
  const { scene, camera, update } = buildScene({ THREE, W: DW, H: DH, sky });
  const P = preset();   // film.json 里本镜头的 lookPreset，不另写一份后期数值
  return { scene, camera, update: t => update(frameOf(t, fps)), look: t => ({ t, ...P }) };
}
