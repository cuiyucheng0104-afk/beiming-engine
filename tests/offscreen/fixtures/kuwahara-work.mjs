// Kuwahara 对拍的作品夹具：合成输入图 → TSL Kuwahara → 转回线性后交给宿主（宿主的目标是 sRGB，会再编码一次，往返至多差 1 级）。
// 参数由测试在 import 前写到 globalThis.__KUWA = { radius, q, strength, far? }；far = { radius, start, end } 时带上合成深度图做远近换半径。
import { kuwahara } from '../../../engine/offscreen/tsl/kuwahara.js';
import { kuwaharaLegacy } from './kuwahara-legacy.js';
import { kuwaharaInput, kuwaharaDepth, KUWA_NEAR, KUWA_FAR } from './kuwahara-input.mjs';

export function build({ THREE, TSL, width: W, height: H, pipeline }) {
  const { radius = 4, q = 8, strength = 1, far, impl } = globalThis.__KUWA ?? {};   // impl: 'legacy' 取优化前的原样副本（逐像素对照用）
  const kuwahara_ = impl === 'legacy' ? kuwaharaLegacy : kuwahara;
  const KR = Math.min(10, Math.max(2, Math.ceil(Math.max(radius, far?.radius ?? 0))));
  const { texture, uniform, vec4, sRGBTransferEOTF } = TSL;
  const tex = new THREE.DataTexture(kuwaharaInput(W, H), W, H, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  let depthTex = null, farArg;
  if (far) {
    depthTex = new THREE.DataTexture(kuwaharaDepth(W, H), W, H, THREE.RedFormat, THREE.FloatType);
    depthTex.minFilter = depthTex.magFilter = THREE.NearestFilter;
    depthTex.needsUpdate = true;
    farArg = { depth: texture(depthTex), radius: uniform(far.radius), start: uniform(far.start), end: uniform(far.end), near: uniform(KUWA_NEAR), farClip: uniform(KUWA_FAR) };
  }
  const kIn = texture(tex);
  const rawSample = kIn.sample.bind(kIn);
  kIn.sample = uvNode => { globalThis.__KUWA_SAMPLES = (globalThis.__KUWA_SAMPLES ?? 0) + 1; return rawSample(uvNode); };   // 计数：着色器构建期间采样了几次（测试用）
  const k = kuwahara_(TSL, { input: kIn, KR, far: farArg, radius: uniform(radius), q: uniform(q), strength: uniform(strength), texel: uniform(new THREE.Vector2(1 / W, 1 / H)) });
  const post = pipeline(vec4(sRGBTransferEOTF(k.rgb), 1));
  return { render() { post.render(); }, dispose() { tex.dispose(); depthTex?.dispose(); } };
}
