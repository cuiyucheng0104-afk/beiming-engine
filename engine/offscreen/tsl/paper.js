// 北冥引擎 · 离屏出片 · 纸纹（TSL）：engine/look/paper.js 的对应。
//   · 程序化纸纹（默认）：1 像素颗粒 + 颗粒团 + 纸齿浮雕（左上来光）+ 大块斑驳 + 纤维；以 0.5 附近为中性，颗粒尺度按 max(.5, 高度 / refHeight) 缩放，
//     整幅在 GPU 上算一次，再在 GPU 内求均值（不读回 CPU）。
//   · 图片纸纹：构造时给 image = { tex, mid } 或每帧给 p.tex / p.mid（如 canvasPaper）；支持 scaleMode 'pixel'（默认，整数倍 kp）
//     与 'refHeight'（连续倍率 k + 合成阶段按输出像素覆盖纸纹格的面积取样），以及 anchor（paperAnchor 跟镜头推拉摇移）。
//   不支持：每帧传字符串 paper.url（Node 渲染期不按帧拉取文件，先用 loadPaper 解码成 { tex, mid }）。
import { createFullscreen, glCoord } from './pass.js';
import { noise } from './noise.js';

const MEAN_N = 16;
const SCALE_MODES = ['pixel', 'refHeight'];
const finite2 = v => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);

function anchorOf(a) {
  if (a === undefined || a === null || a === false) return null;
  const zoom = a.zoom ?? 1;
  if (!finite2(a.pos) || !finite2(a.origin ?? a.pos) || !(Number.isFinite(zoom) && zoom > 0)) {
    throw new TypeError(`纸纹 anchor 要写成 { pos: [x, y], origin: [x0, y0], zoom > 0 }，收到 ${JSON.stringify(a)}`);
  }
  return { pos: a.pos, origin: a.origin ?? a.pos, zoom };
}

const withAnchor = (o, a) => (a ? { ...o, anchor: a } : o);

export function paperAnchor(now, ref) {
  for (const [k, v] of [['now', now], ['ref', ref]]) {
    if (!v || ![v.x, v.y, v.s].every(Number.isFinite) || !(v.s > 0)) {
      throw new TypeError(`paperAnchor：${k} 要是 { x, y, s > 0 }（screenAnchor 的结果），收到 ${JSON.stringify(v)}`);
    }
  }
  return { pos: [now.x, now.y], origin: [ref.x, ref.y], zoom: now.s / ref.s };
}

export function canvasPaper(THREE, canvas, { strength = 0.12 } = {}) {
  if (!canvas || !(canvas.width > 0) || !(canvas.height > 0)) {
    throw new TypeError('canvasPaper：要一张有尺寸的画布（例如 xuanPaper({ width: 1024, height: 1024 })）');
  }
  const w = canvas.width, h = canvas.height;
  const raw = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const px = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength).slice();
  let s = 0;
  for (let i = 0; i < px.length; i += 4) s += px[i] / 255;
  const tex = new THREE.DataTexture(px, w, h, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return { tex, mid: s / (w * h), strength };
}

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
  const procMid = texture(meanB.texture).load(ivec2(0, 0)).x;
  const mid = image ? uniform(image.mid) : procMid;

  let target = null, procMat = null, dirty = true;

  function build(h) {
    const p = glCoord(TSL, h);
    const grain = h21(ivec2(p), uint(7)).sub(0.5);                                      // 1 像素的纸面颗粒
    const g2 = vnoise(p.div(uK.mul(1.7)), uint(9)).sub(0.5);                             // 2 像素左右的颗粒团
    const emb = tooth(p.add(vec2(-1, 1))).sub(tooth(p.add(vec2(1, -1))));                // 纸齿浮雕（左上来光）
    const mott = fbm(p.div(uK.mul(160)), uint(37));                                      // 大块斑驳（颜料吃纸不均）
    const q = vec2(p.x.div(70), p.y.div(2.5));
    const fib = vnoise(vec2(q.x.mul(0.96).add(q.y.mul(0.28)), q.x.mul(-0.28).add(q.y.mul(0.96))).div(uK), uint(51)).sub(0.5);
    const v = float(0.5).add(grain.mul(0.03)).add(g2.mul(0.08)).add(emb.mul(0.5)).add(mott.mul(0.3)).add(fib.mul(0.05));
    return fx.material(vec4(v, v, v, 1));
  }

  function resize(w, h) {
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

  function layer(p, kp = 1, k = kp) {
    if (p?.url !== undefined && p.url !== null) {
      throw Object.assign(new Error('离屏纸纹未支持每帧传 paper.url：请先用 loadPaper 解码成 { tex, mid }'), { code: 'unsupported.paper' });
    }
    if (p?.scaleMode !== undefined && p.scaleMode !== null && !SCALE_MODES.includes(p.scaleMode)) {
      throw new TypeError(`纸纹 scaleMode 只能是 ${SCALE_MODES.join(' / ')}，收到 ${JSON.stringify(p.scaleMode)}`);
    }
    const anchor = anchorOf(p?.anchor);
    const extTex = p?.tex || image?.tex || null;
    if (!extTex) {
      if (dirty) {
        const prev = renderer.getRenderTarget();
        try {
          uK.value = Math.max(0.5, target.height / refHeight);
          fx.draw(procMat, target);
          procTex.value = target.texture; fx.draw(meanAMat, meanA);
          meanTex.value = meanA.texture; fx.draw(meanBMat, meanB);
        } finally { renderer.setRenderTarget(prev); }
        dirty = false;
      }
      return withAnchor({ texture: target.texture, strength: p ? p.strength : 0, mid: null, w: target.width, h: target.height }, anchor);
    }
    const refH = p?.scaleMode === 'refHeight';
    const img = extTex.image, iw = img?.width || 1024, ih = img?.height || 1024;
    const sc = (p?.scale ?? 1) * (refH ? k : kp);
    const midVal = p?.tex ? (p.mid ?? 0.5) : (image?.mid ?? 0.5);
    const o = withAnchor({ texture: extTex, strength: p ? p.strength : 0, mid: midVal, w: iw * sc, h: ih * sc }, anchor);
    return refH ? { ...o, texels: [iw, ih] } : o;
  }

  return {
    resize, prepare, layer, mid, procMid,
    get target() { return target; },
    dispose() { target?.dispose(); meanA.dispose(); meanB.dispose(); procMat?.dispose(); meanAMat.dispose(); meanBMat.dispose(); empty.dispose(); },
  };
}
