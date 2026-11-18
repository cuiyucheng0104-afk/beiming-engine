// 北冥引擎 · 离屏出片 · 纸纹（TSL）：engine/look/paper.js 的子集。
//   · 程序化纸纹（默认）：1 像素颗粒 + 颗粒团 + 很淡的纸齿浮雕（左上来光）+ 大块斑驳 + 极淡的纤维；以 0.5 附近为中性，颗粒尺度按 max(.5, 高度 / refHeight) 缩放。
//     整幅在 GPU 上算一次，再在 GPU 上量均值当中性点（GLSL 版读回 16×16 到 CPU；离屏的读回是异步的，所以这里在 GPU 内求平均，不读回）。
//   · 图片纸纹：构造时给 image = { tex, mid }——tex 是 THREE.DataTexture（RGBA8，行序自上而下，即图片的行序，RepeatWrapping、线性过滤），
//     mid 是它的中性亮度（均值），按「1 图像像素 = kp 输出像素」平铺（scaleMode 'pixel'）。Node 里读 PNG 不是这里的事：调用方解码成 DataTexture 再交进来。
//   不支持：scaleMode 'refHeight'、纸纹跟锚点走（anchor）、每帧换 tex / url：传了就抛 code 'unsupported.paper'，不静默按像素模式画。
//
//   createPaper({ THREE, TSL, renderer }, { refHeight = 1080, image = null }?) → {
//     resize(w, h)       按输出尺寸（重）建程序化纸纹，下次 prepare 时生成
//     prepare()          需要时生成程序化纸纹并求均值（GPU 内，不读回）
//     layer(p, kp = 1) → { texture, strength, w, h }   本帧的纸纹纹理、强度、平铺尺寸（像素）
//     mid                中性亮度的 TSL 节点（程序化：GPU 里量出来的均值；图片：image.mid）
//     dispose()
//   }
import { createFullscreen, glCoord } from './pass.js';
import { noise } from './noise.js';

const MEAN_N = 16;

export function createPaper({ THREE, TSL, renderer }, { refHeight = 1080, image = null } = {}) {
  const { Fn, Loop, int, uniform, texture, vec2, vec3, vec4, float, ivec2, uint, floor, uv } = TSL;
  const fx = createFullscreen({ THREE, renderer });
  const { h21, vnoise } = noise(TSL);
  const uK = uniform(1);
  const empty = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); empty.needsUpdate = true;
  const rt = (w, h, type, filter) => new THREE.RenderTarget(w, h, { type, depthBuffer: false, minFilter: filter, magFilter: filter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping });

  const fbm = Fn(([p0, s]) => {
    const p = p0.toVar(), a = float(0).toVar(), m = float(0.5).toVar();
    for (let i = 0; i < 3; i++) {
      a.addAssign(m.mul(vnoise(p, s.add(uint(i * 101)))));
      p.assign(p.mul(2.03).add(vec2(17.1, 9.3))); m.mulAssign(0.5);
    }
    return a.div(0.875).sub(0.5);
  });
  const tooth = p => fbm(p.div(uK.mul(4.5)), uint(23));

  // 均值：16×16 的格子，每格在纸纹上均匀取 8×8 个点（8 位目标，与 GLSL 版同样的取整），再把 256 格平均到 1×1 的浮点目标
  const procTex = texture(empty), meanTex = texture(empty);
  const meanA = rt(MEAN_N, MEAN_N, THREE.UnsignedByteType, THREE.NearestFilter), meanB = rt(1, 1, THREE.FloatType, THREE.NearestFilter);
  const c0 = floor(uv().mul(MEAN_N));
  const meanAMat = fx.material(Fn(() => {
    const sum = float(0).toVar();
    Loop({ start: int(0), end: int(8), type: 'int', condition: '<', name: 'j' }, { start: int(0), end: int(8), type: 'int', condition: '<', name: 'i' }, ({ i, j }) => {
      sum.addAssign(procTex.sample(c0.add(vec2(float(i).add(0.5), float(j).add(0.5)).div(8)).div(MEAN_N)).level(0).r);
    });
    return vec4(vec3(sum.div(64)), 1);
  })());
  const meanBMat = fx.material(Fn(() => {
    const tot = float(0).toVar();
    Loop({ start: int(0), end: int(MEAN_N), type: 'int', condition: '<', name: 'j' }, { start: int(0), end: int(MEAN_N), type: 'int', condition: '<', name: 'i' }, ({ i, j }) => {
      tot.addAssign(meanTex.load(ivec2(i, j)).r);
    });
    return vec4(tot.div(MEAN_N * MEAN_N), 0, 0, 1);
  })());
  const mid = image ? uniform(image.mid) : texture(meanB.texture).load(ivec2(0, 0)).x;

  let target = null, procMat = null, dirty = true;

  function build(h) {
    const p = glCoord(TSL, h);
    const grain = h21(ivec2(p), uint(7)).sub(0.5);                                      // 1 像素的纸面颗粒
    const g2 = vnoise(p.div(uK.mul(1.7)), uint(9)).sub(0.5);                             // 2 像素左右的颗粒团
    const emb = tooth(p.add(vec2(-1, 1))).sub(tooth(p.add(vec2(1, -1))));                // 纸齿浮雕（左上来光）
    const mott = fbm(p.div(uK.mul(160)), uint(37));                                      // 大块斑驳（颜料吃纸不均）
    const q = vec2(p.x.div(70), p.y.div(2.5));
    const fib = vnoise(vec2(q.x.mul(0.96).add(q.y.mul(0.28)), q.x.mul(-0.28).add(q.y.mul(0.96))).div(uK), uint(51)).sub(0.5);   // 极淡的纤维（GLSL 的 v * mat2：旋转取转置）
    const v = float(0.5).add(grain.mul(0.03)).add(g2.mul(0.08)).add(emb.mul(0.5)).add(mott.mul(0.3)).add(fib.mul(0.05));
    return fx.material(vec4(v, v, v, 1));
  }

  function resize(w, h) {
    if (image) return;
    target?.dispose(); procMat?.dispose();
    target = rt(w, h, THREE.UnsignedByteType, THREE.LinearFilter);
    procMat = build(h);
    dirty = true;
  }

  function prepare() {
    if (image || !dirty) return;
    const prev = renderer.getRenderTarget();
    try {
      uK.value = Math.max(0.5, target.height / refHeight);
      fx.draw(procMat, target);
      procTex.value = target.texture; fx.draw(meanAMat, meanA);
      meanTex.value = meanA.texture; fx.draw(meanBMat, meanB);
    } finally { renderer.setRenderTarget(prev); }
    dirty = false;
  }

  function layer(p, kp = 1) {
    for (const k of ['scaleMode', 'anchor', 'tex', 'url']) {
      if (p?.[k] !== undefined && p[k] !== null) throw Object.assign(new Error(`离屏纸纹未支持 paper.${k}：只有程序化纸纹与构造时给的图片纸纹（pixel 模式）`), { code: 'unsupported.paper' });
    }
    if (image) {
      const { width: iw, height: ih } = image.tex.image, sc = (p?.scale ?? 1) * kp;
      return { texture: image.tex, strength: p ? p.strength : 0, w: iw * sc, h: ih * sc };
    }
    return { texture: target.texture, strength: p ? p.strength : 0, w: target.width, h: target.height };
  }

  return {
    resize, prepare, layer, mid,
    get target() { return target; },
    dispose() { target?.dispose(); meanA.dispose(); meanB.dispose(); procMat?.dispose(); meanAMat.dispose(); meanBMat.dispose(); empty.dispose(); },
  };
}
