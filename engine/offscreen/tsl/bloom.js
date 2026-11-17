// 北冥引擎 · 离屏出片 · bloom（TSL）：engine/look/bloom.js 的对应——软阈值预滤（4×4 盒）→ 13 抽头下采样 mip 链 → 帐篷上采样逐级混回（radius 决定大光晕的权重）。
// 阈值比的是线性 HDR 的最大通道；最后一步只取上采样的模糊结果。换分辨率光晕一致：refHeight 给了时 skip = round(log2(h / refHeight))，先 2×2 盒降 skip 级。
//
//   createBloom({ THREE, TSL, renderer }, { levels = 7, minSize = 8, refHeight = 0 }?) → {
//     resize(w, h)   按源图尺寸建 mip 链
//     render(src, p) → 光晕纹理（RenderTarget 的 texture）；mip 链为空时返回 null。src 是 RenderTarget 的 texture；p：{ threshold, knee, radius }
//     dispose()
//   }
// 取样都在 UV 空间做双线性（4 个 tap 合成 4×4 盒、半分辨率一次双线性 = 2×2 盒），目标的行序对它们是对称的，不需要翻 y。
import { createFullscreen } from './pass.js';

export function createBloom({ THREE, TSL, renderer }, { levels = 7, minSize = 8, refHeight = 0 } = {}) {
  const { uniform, texture, vec2, vec4, max, clamp, mix, uv } = TSL;
  const fx = createFullscreen({ THREE, renderer });
  const rt = (w, h) => new THREE.RenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  const empty = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); empty.needsUpdate = true;
  const T = () => texture(empty);

  // 预滤：4 个双线性取样合成 4×4 盒，再按软阈值衰减
  const preIn = T(), preU = { texel: uniform(new THREE.Vector2()), thr: uniform(0.7), knee: uniform(0.2) };
  const preMat = fx.material((() => {
    const q = uv(), o = preU.texel;
    const c = preIn.sample(q.add(vec2(o.x.negate(), o.y.negate()))).rgb.add(preIn.sample(q.add(vec2(o.x, o.y.negate()))).rgb)
      .add(preIn.sample(q.add(vec2(o.x.negate(), o.y))).rgb).add(preIn.sample(q.add(vec2(o.x, o.y))).rgb).mul(0.25);
    const l = max(c.r, max(c.g, c.b));
    const k = max(preU.knee, 1e-4);
    const s = clamp(l.sub(preU.thr).add(k), 0, k.mul(2));
    const soft = s.mul(s).div(k.mul(4));
    const w = max(soft, l.sub(preU.thr)).div(max(l, 1e-4));
    return vec4(c.mul(w), 1);
  })());
  // 13 抽头下采样
  const downIn = T(), downU = { texel: uniform(new THREE.Vector2()) };
  const downMat = fx.material((() => {
    const s = (x, y) => downIn.sample(uv().add(vec2(x, y).mul(downU.texel))).rgb;
    let c = s(0, 0).mul(0.125);
    c = c.add(s(-2, -2).add(s(2, -2)).add(s(-2, 2)).add(s(2, 2)).mul(0.03125));
    c = c.add(s(0, -2).add(s(-2, 0)).add(s(2, 0)).add(s(0, 2)).mul(0.0625));
    c = c.add(s(-1, -1).add(s(1, -1)).add(s(-1, 1)).add(s(1, 1)).mul(0.125));
    return vec4(c, 1);
  })());
  // 半分辨率处一次双线性 = 2×2 盒子平均
  const boxIn = T();
  const boxMat = fx.material(vec4(boxIn.sample(uv()).rgb, 1));
  // 帐篷上采样，与同级下采样结果按 radius 混
  const lowIn = T(), curIn = T(), upU = { texel: uniform(new THREE.Vector2()), radius: uniform(0.6) };
  const upMat = fx.material((() => {
    const s = (x, y) => lowIn.sample(uv().add(vec2(x, y).mul(upU.texel))).rgb;
    let t = s(0, 0).mul(4);
    t = t.add(s(-1, 0).add(s(1, 0)).add(s(0, -1)).add(s(0, 1)).mul(2));
    t = t.add(s(-1, -1).add(s(1, -1)).add(s(-1, 1)).add(s(1, 1)));
    return vec4(mix(curIn.sample(uv()).rgb, t.div(16), upU.radius), 1);
  })());

  let W = 0, H = 0, lv = [], skip = 0;
  const free = () => { for (const l of lv) { l.down.dispose(); l.up?.dispose(); } lv = []; };

  function resize(w, h) {
    free(); W = w; H = h;
    const want = refHeight > 0 && h > 0 ? Math.max(0, Math.round(Math.log2(h / refHeight))) : 0;
    let bw = W >> 1, bh = H >> 1;
    while (lv.length < levels + want && Math.min(bw, bh) >= minSize) {
      lv.push({ w: bw, h: bh, down: rt(bw, bh), up: lv.length >= want ? rt(bw, bh) : null }); bw >>= 1; bh >>= 1;
    }
    skip = Math.min(want, Math.max(0, lv.length - 1));
    for (let i = skip; i < lv.length; i++) lv[i].up ??= rt(lv[i].w, lv[i].h);   // 链比预想的短：起始级前移
  }

  function render(src, p) {
    if (!lv.length) return null;
    let tex = src, tw = W, th = H;
    for (let i = 0; i < skip; i++) { boxIn.value = tex; fx.draw(boxMat, lv[i].down); tex = lv[i].down.texture; tw = lv[i].w; th = lv[i].h; }
    preIn.value = tex; preU.texel.value.set(1 / tw, 1 / th); preU.thr.value = p.threshold; preU.knee.value = p.knee;
    fx.draw(preMat, lv[skip].down);
    for (let i = skip + 1; i < lv.length; i++) {
      downIn.value = lv[i - 1].down.texture; downU.texel.value.set(1 / lv[i - 1].w, 1 / lv[i - 1].h);
      fx.draw(downMat, lv[i].down);
    }
    let low = lv[lv.length - 1].down;
    for (let i = lv.length - 2; i >= skip; i--) {
      lowIn.value = low.texture; curIn.value = lv[i].down.texture;
      upU.texel.value.set(1 / lv[i + 1].w, 1 / lv[i + 1].h); upU.radius.value = i === skip ? 1 : p.radius;
      fx.draw(upMat, lv[i].up); low = lv[i].up;
    }
    return low.texture;
  }

  return { resize, render, get skip() { return skip; }, get levels() { return lv.length; }, dispose() { free(); for (const m of [preMat, downMat, boxMat, upMat]) m.dispose(); empty.dispose(); } };
}
