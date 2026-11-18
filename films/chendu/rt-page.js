// 晨渡 · A 路线页面的运行时：three r170 + engine/shade 的 GLSL 卡通材质 + engine/stage/plates.js，交给 makeWorld 与各镜头（双实现见 world.js 开头）。
import * as THREE from 'three';
import { toonKind, makeToonShared, setToonShared } from '../../engine/shade/toon.js';
import { patchLayer } from '../../engine/shade/surface.js';
import * as P from '../../engine/stage/plates.js';

export const rt = {
  THREE, TSL: null, toonKind, makeToonShared, setToonShared, patchLayer, P,
  geo: g => g,
  readJson: async url => (await fetch(url)).json(),
  loadTexture: url => new THREE.TextureLoader().loadAsync(url.href),
};
