// Kuwahara 对拍的作品夹具：合成输入图 → TSL Kuwahara → 转回线性后交给宿主（宿主的目标是 sRGB，会再编码一次，往返至多差 1 级）。
// 参数由测试在 import 前写到 globalThis.__KUWA = { radius, q, strength }。
import { kuwahara } from '../../../engine/offscreen/tsl/kuwahara.js';
import { kuwaharaInput } from './kuwahara-input.mjs';

export function build({ THREE, TSL, width: W, height: H, pipeline }) {
  const { radius = 4, q = 8, strength = 1 } = globalThis.__KUWA ?? {};
  const KR = Math.min(10, Math.max(2, Math.ceil(radius)));
  const { texture, uniform, vec4, sRGBTransferEOTF } = TSL;
  const tex = new THREE.DataTexture(kuwaharaInput(W, H), W, H, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const k = kuwahara(TSL, { input: texture(tex), KR, radius: uniform(radius), q: uniform(q), strength: uniform(strength), texel: uniform(new THREE.Vector2(1 / W, 1 / H)) });
  const post = pipeline(vec4(sRGBTransferEOTF(k.rgb), 1));
  return { render() { post.render(); }, dispose() { tex.dispose(); } };
}
