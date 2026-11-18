// 北冥引擎 · 离屏出片 · 调色（TSL）：engine/look/grade.js 的对应，常数与顺序逐项照搬——曝光 → 加 bloom → 白平衡（warmth）→ 饱和度 → lift/gamma/gain（2.2 伽马空间）→ 高光肩。
// 线性进、线性出；另把「自发光高光保护」写进 alpha，给 Kuwahara 用。再接一步输出变换（engine/look 里的 OutputPass：这里只支持 NoToneMapping，线性 → sRGB 编码，alpha 原样）。
//
//   createGrade({ THREE, TSL, renderer }, { width, height }) → {
//     render({ src, bloom, bloomAmount, bloomTint, grade, protect }, target)   src / bloom：RenderTarget 的 texture；bloom 空 = 无；target：线性结果（alpha = 保护量）
//     output(source, target)                                                   线性 → sRGB 编码（NoToneMapping 的 OutputPass），alpha 原样
//     dispose()
//   }
import { createFullscreen } from './pass.js';
import { linVec, vec3Of } from './color.js';

const IDENTITY = { exposure: 1, warmth: 0, lift: 0, gamma: 1, gain: 1, saturation: 1, shoulder: 1 };

export function createGrade({ THREE, TSL, renderer }, { width: W, height: H }) {
  const { uniform, texture, ivec2, vec2, vec3, vec4, float, dot, max, min, mix, pow, exp, select, smoothstep, screenCoordinate, sRGBTransferOETF } = TSL;
  const fx = createFullscreen({ THREE, renderer });
  const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); black.needsUpdate = true;
  const px = ivec2(screenCoordinate.xy);   // 源图与目标同尺寸：逐像素取，不插值

  const U = {
    bloom: uniform(0), exposure: uniform(1), sat: uniform(1), knee: uniform(1), prot: uniform(new THREE.Vector2()),
    bloomTint: uniform(new THREE.Vector3(1, 1, 1)), wb: uniform(new THREE.Vector3(1, 1, 1)), lift: uniform(new THREE.Vector3()),
    gamma: uniform(new THREE.Vector3(1, 1, 1)), gain: uniform(new THREE.Vector3(1, 1, 1)),
  };
  const tColor = texture(black), tBloom = texture(black);
  const lum = vec3(0.2126, 0.7152, 0.0722);

  const mat = fx.material((() => {
    let c = tColor.load(px).rgb.mul(U.exposure);
    const prot = select(U.prot.y.greaterThan(0), smoothstep(U.prot.x, U.prot.y, max(c.r, max(c.g, c.b))), float(0));
    c = c.add(tBloom.sample(screenCoordinate.xy.div(vec2(W, H))).rgb.mul(U.bloom).mul(U.bloomTint)).mul(U.wb);   // bloom 是半分辨率的光晕图，按 UV 双线性取样
    const l = dot(c, lum);
    c = max(mix(vec3(l), c, U.sat), 0);
    let g = pow(c, vec3(1 / 2.2));
    g = U.gain.mul(g.add(U.lift.mul(max(float(1).sub(g), 0))));
    g = pow(max(g, 0), vec3(1).div(U.gamma));
    c = pow(g, vec3(2.2));
    // 高光肩：大部分保色相（橙色灯过曝仍是橙色），少量按通道压（核心略发白）
    const k = vec3(U.knee);
    const pc = min(c, k).add(float(1).sub(k).mul(float(1).sub(exp(max(c.sub(k), 0).negate().div(float(1).sub(k))))));
    const m = max(c.r, max(c.g, c.b));
    const mm = select(m.lessThan(U.knee), m, U.knee.add(float(1).sub(U.knee).mul(float(1).sub(exp(m.sub(U.knee).negate().div(float(1).sub(U.knee)))))));
    const shouldered = mix(c.mul(mm.div(max(m, 1e-5))), pc, 0.3);
    c = select(U.knee.lessThan(0.999), shouldered, c);
    return vec4(c, prot);
  })());

  const outSrc = texture(black);
  const outMat = fx.material((() => { const s = outSrc.load(px); return vec4(sRGBTransferOETF(s.rgb), s.a); })());

  function render({ src, bloom, bloomAmount, bloomTint, grade, protect }, target) {
    const G = grade || IDENTITY;
    tColor.value = src; tBloom.value = bloom || black; U.bloom.value = bloom ? bloomAmount : 0;
    linVec(THREE, bloomTint ?? '#ffffff', U.bloomTint.value);
    // 白平衡：暖 = 红多蓝少，再按亮度归一，不改整体明暗
    const wm = G.warmth ?? 0, wb = U.wb.value.set(1 + 0.10 * wm, 1 + 0.012 * wm, 1 - 0.15 * wm);
    wb.divideScalar(wb.x * 0.2126 + wb.y * 0.7152 + wb.z * 0.0722);
    U.exposure.value = G.exposure ?? 1; U.sat.value = G.saturation ?? 1; U.knee.value = G.shoulder ?? 1;
    vec3Of(THREE, G.lift ?? 0, U.lift.value); vec3Of(THREE, G.gamma ?? 1, U.gamma.value); vec3Of(THREE, G.gain ?? 1, U.gain.value);
    U.prot.value.set(protect ? protect[0] : 0, protect ? protect[1] : 0);
    fx.draw(mat, target);
  }
  function output(source, target) { outSrc.value = source; fx.draw(outMat, target); }

  return { render, output, dispose() { mat.dispose(); outMat.dispose(); black.dispose(); } };
}
