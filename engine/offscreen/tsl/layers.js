// 北冥引擎 · 离屏出片 · 分层风格化（TSL / WebGPU，同源跨端）：engine/look/layers.js 的对应实现。
// 把外部离线光追 / 路径追踪渲染器导出的分层图（颜色、16 位深度、16 位物体编号、视空间法线）合成为北冥画风：
// 4 邻域物体编号不连续（近侧拥有线）+ 1/z 二阶差分折痕 + 法线夹角内线 → 圆头笔域扭曲抖动与笔压 → 保色相多档色阶 → Kuwahara 笔触 → 纸纹。
// 严守许可边界（D03 / D12 / docs/rights/rt-boundary.md）：纯自写宽松许可代码，不依赖 engine/native/ 与外部专有渲染器。
//
//   await decodePng(bytes) → { width, height, channels, depth, data }   8/16 位非隔行灰度/RGB/RGBA PNG（16 位返回 Uint16Array）
//   await loadLayers(dir, frame = 0, fetchBytes?) → { color, depth, ids, normal, depthUnit, width, height }
//   createLayerLook({ THREE, TSL, renderer }, w, h, opts?) → { render(layers, p), node, output, dispose() }
//     p: { t, view: 'final'|'color'|'ids'|'edge'|'toon', split, outline, toon, kuwahara, paper, target }
import { decodeLayerPng, readBytes } from '../io.mjs';
import { createFullscreen, glCoord } from './pass.js';
import { noise } from './noise.js';
import { kuwahara } from './kuwahara.js';
import { createPaper } from './paper.js';
import { linVec } from './color.js';

export async function decodePng(bytes) {
  return decodeLayerPng(bytes);
}

export async function loadLayers(dir, frame = 0, fetchBytes = u => readBytes(u)) {
  const cleanDir = String(dir).replace(/\/+$/, '');
  const base = `${cleanDir}/${String(frame).padStart(6, '0')}`;
  const [color, depth, ids, normal, metaBytes] = await Promise.all([
    fetchBytes(`${base}.png`).then(decodePng),
    fetchBytes(`${base}.depth.png`).then(decodePng),
    fetchBytes(`${base}.object_index.png`).then(decodePng),
    fetchBytes(`${base}.view_normal.png`).then(decodePng),
    fetchBytes(`${cleanDir}/meta.json`),
  ]);
  const meta = JSON.parse(new globalThis.TextDecoder('utf-8').decode(metaBytes));
  const fr = meta.frames?.find(f => f.index === Number(frame)) ?? meta.frames?.[0];
  if (!fr?.depth_unit_m) throw new Error(`meta.json 里找不到第 ${frame} 帧的 depth_unit_m`);
  return { color, depth, ids, normal, depthUnit: fr.depth_unit_m, width: color.width, height: color.height };
}

const D_OUT = { width: 2.4, color: '#1b1a22', tint: 0.35, wobble: 1.6, warp: 60, boilFps: 12, pressure: 0.25, inner: 0.55, depthThreshold: 0.03, normalThreshold: 0.5, opacity: 1 };
const D_TOON = { bands: 3, soft: 0.07, lo: 0.35, hi: 0.92, sky: 0 };
const D_KUWA = { radius: 3, strength: 1, q: 8 };
const D_PAPER = { strength: 0.1, scale: 1 };
const VIEWS = { final: 0, color: 1, ids: 2, edge: 3, toon: 4 };
const opt = (v, d) => (v === false ? null : { ...d, ...(v === true || v == null ? {} : v) });

export function createLayerLook({ THREE, TSL, renderer }, w, h, o = {}) {
  const {
    Fn, If, Loop, uniform, texture, float, int, uint, vec2, vec3, vec4, ivec2,
    screenCoordinate, clamp, abs, dot, max, mix, floor, length, smoothstep, select, sRGBTransferEOTF,
  } = TSL;

  const fx = createFullscreen({ THREE, renderer });
  const { h21, vnoise } = noise(TSL);
  const paper = createPaper({ THREE, TSL, renderer }, { image: o.paper ?? null });
  paper.resize(w, h);

  const NEAREST = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
  const T = {
    edge: new THREE.RenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, ...NEAREST }),
    line: new THREE.RenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }),
    kuwa: new THREE.RenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }),
  };

  const dummyByte = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); dummyByte.needsUpdate = true;
  const dummyFloat = new THREE.DataTexture(new Float32Array([1]), 1, 1, THREE.RedFormat, THREE.FloatType); dummyFloat.needsUpdate = true;

  const tColor = texture(dummyByte);
  const tDepth = texture(dummyFloat);
  const tId = texture(dummyFloat);
  const tNormal = texture(dummyByte);
  const tEdge = texture(T.edge.texture);
  const tLine = texture(T.line.texture);
  const tKuwa = texture(T.kuwa.texture);
  const tPaper = texture(dummyByte);
  const mx = ivec2(w - 1, h - 1);

  const U = {
    kuwaRad: uniform(3), kuwaQ: uniform(8), kuwaStr: uniform(1), texel: uniform(new THREE.Vector2(1 / w, 1 / h)),
    halfW: uniform(1), inner: uniform(0.55), depthThr: uniform(0.03), normThr: uniform(0.5), opacity: uniform(1),
    wobble: uniform(0), warp: uniform(60), pressure: uniform(0), seed: uniform(0),
    ink: uniform(new THREE.Vector3()), view: uniform(0), split: uniform(0), tint: uniform(0.35),
    paper: uniform(0), paperMid: uniform(0.5), useProcMid: uniform(1), paperSize: uniform(new THREE.Vector2(1, 1)),
    bands: uniform(3), skyBands: uniform(0), soft: uniform(0.07), lo: uniform(0.35), hi: uniform(0.92),
    encodeEotf: uniform(1),
  };

  // Kuwahara 变体缓存（KR = 2..10）
  const kuwaMats = new Map();
  const kuwaMaterial = KR => {
    if (!kuwaMats.has(KR)) {
      kuwaMats.set(KR, fx.material(kuwahara(TSL, {
        input: tColor, KR, radius: U.kuwaRad, q: U.kuwaQ, strength: U.kuwaStr, texel: U.texel,
      })));
    }
    return kuwaMats.get(KR);
  };

  // 边缘检测：4 邻域 ID 跳变（近侧拥有线）+ 同物体视空间法线夹角 + 1/z 二阶差分折痕
  const edgeMat = fx.material(Fn(() => {
    const p = ivec2(screenCoordinate.xy);
    const id0 = tId.load(p).x, z0 = tDepth.load(p).x, iz0 = float(1).div(z0);
    const n0 = tNormal.load(p).xyz.mul(2).sub(1);
    const outline = float(0).toVar(), inner = float(0).toVar();

    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const q = clamp(p.add(ivec2(dx, dy)), ivec2(0), mx);
      const idq = tId.load(q).x;
      If(abs(idq.sub(id0)).greaterThan(0.5), () => {
        const zq = tDepth.load(q).x, rel = zq.sub(z0).div(z0);
        If(rel.greaterThan(0.002).or(rel.greaterThan(-0.002).and(id0.greaterThan(idq))), () => {
          outline.assign(1);
        });
      }).Else(() => {
        const nq = tNormal.load(q).xyz.mul(2).sub(1);
        If(id0.greaterThan(0.5).and(dot(n0, nq).lessThan(U.normThr)), () => {
          inner.assign(1);
        });
      });
    }

    If(id0.greaterThan(0.5), () => {
      for (const [ax, ay] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
        const zp = tDepth.load(clamp(p.add(ivec2(ax, ay)), ivec2(0), mx)).x;
        const zm = tDepth.load(clamp(p.sub(ivec2(ax, ay)), ivec2(0), mx)).x;
        If(float(1).div(zp).add(float(1).div(zm)).sub(iz0.mul(2)).div(iz0).lessThan(U.depthThr.negate()), () => {
          inner.assign(1);
        });
      }
    });

    const hasEdge = outline.greaterThan(0.5).or(inner.greaterThan(0.5));
    const hw = U.halfW.mul(select(outline.greaterThan(0.5), float(1), U.inner));
    return select(hasEdge, vec4(U.opacity, hw, 0, 1), vec4(0));
  })());

  // 笔画扩张：对齐 GL 左下角原点的域扭曲噪声与圆头笔压
  const strokeMats = new Map();
  const strokeMaterial = SR => {
    if (!strokeMats.has(SR)) {
      strokeMats.set(SR, fx.material(Fn(() => {
        const c = glCoord(TSL, h);
        const sd = uint(U.seed).mul(uint(7919)).add(uint(13));
        const a = c.div(U.warp), b = c.div(U.warp.mul(0.31));
        const q = c.add(vec2(vnoise(a, sd), vnoise(a.add(31.7), sd.add(uint(1)))).mul(2).sub(1).mul(U.wobble))
          .add(vec2(vnoise(b, sd.add(uint(2))), vnoise(b.add(13.1), sd.add(uint(3)))).mul(2).sub(1).mul(U.wobble).mul(0.3)).toVar();
        const pr = float(1).add(U.pressure.mul(vnoise(q.div(U.warp.mul(0.45)), sd.add(uint(5))).mul(2).sub(1)));
        const b0 = ivec2(floor(q));
        const cov = float(0).toVar();
        Loop({ start: int(-SR), end: int(SR), type: 'int', condition: '<=', name: 'j' }, { start: int(-SR), end: int(SR), type: 'int', condition: '<=', name: 'i' }, ({ i, j }) => {
          const e = b0.add(ivec2(i, j));
          const inb = e.x.greaterThanEqual(0).and(e.y.greaterThanEqual(0)).and(e.x.lessThanEqual(mx.x)).and(e.y.lessThanEqual(mx.y));
          const ec = clamp(e, ivec2(0), mx);
          const E = tEdge.load(ivec2(ec.x, mx.y.sub(ec.y)));
          const d = length(q.sub(vec2(e).add(0.5)));
          cov.assign(max(cov, select(inb.and(E.x.greaterThan(0)), clamp(E.y.mul(pr).add(0.5).sub(d), 0, 1).mul(E.x), float(0))));
        });
        return vec4(cov, 0, 0, 1);
      })()));
    }
    return strokeMats.get(SR);
  };

  const quant = Fn(([L, n]) => {
    const s = clamp(L.sub(U.lo).div(U.hi.sub(U.lo)), 0, 1).mul(n);
    const bnd = floor(s.add(0.5)), d = s.sub(bnd);
    const lower = clamp(bnd.sub(1), float(0), n.sub(1)), upper = clamp(bnd, float(0), n.sub(1));
    const xq = mix(lower.add(0.5).div(n), upper.add(0.5).div(n), smoothstep(U.soft.negate(), U.soft, d));
    return mix(U.lo, U.hi, xq);
  });

  const toonColor = Fn(([c, id]) => {
    const n = select(id.lessThan(0.5), U.skyBands, U.bands);
    const L = dot(c, vec3(0.2126, 0.7152, 0.0722));
    return select(n.lessThan(1.5).or(L.lessThan(0.002)), c, clamp(c.mul(quant(L, n).div(max(L, 1e-6))), 0, 1));
  });

  // 合成节点（sRGB 数值空间 0..1）
  const srgbNode = Fn(() => {
    const pTop = ivec2(screenCoordinate.xy);
    const pGL = glCoord(TSL, h);
    const raw = tColor.load(pTop).rgb;
    const id = tId.load(pTop).x;
    const cov = tLine.load(pTop).x;
    const c = toonColor(tKuwa.load(pTop).rgb, id);

    const idVis = select(
      id.lessThan(0.5),
      vec3(1),
      vec3(h21(ivec2(int(id), 1), uint(7)), h21(ivec2(int(id), 2), uint(7)), h21(ivec2(int(id), 3), uint(7))).mul(0.8).add(0.1),
    );
    const edgeVis = mix(vec3(0.96, 0.94, 0.9), U.ink, cov);

    const uvGL = pGL.div(U.paperSize);
    const pSample = tPaper.sample(vec2(uvGL.x, float(1).sub(uvGL.y))).r;
    const effMid = select(U.useProcMid.greaterThan(0.5), paper.procMid, U.paperMid);
    const cPaper = select(U.paper.greaterThan(0), c.mul(float(1).add(U.paper.mul(2).mul(pSample.sub(effMid)))), c);
    const finalVis = mix(cPaper, mix(U.ink, cPaper.mul(0.25), U.tint), cov);

    let o = select(U.view.equal(1), raw, finalVis);
    o = select(U.view.equal(2), idVis, o);
    o = select(U.view.equal(3), edgeVis, o);
    o = select(U.view.equal(4), c, o);
    o = select(screenCoordinate.x.lessThan(U.split.mul(w)), raw, o);
    return vec4(clamp(o, 0, 1), 1);
  })();

  const outputNode = vec4(sRGBTransferEOTF(srgbNode.rgb), 1);
  const finalMat = fx.material(Fn(() => select(U.encodeEotf.greaterThan(0.5), outputNode, srgbNode))());

  let tex = null, src = null;
  const upload = L => {
    if (L.width !== w || L.height !== h) throw new Error(`分层图 ${L.width}×${L.height} 与 createLayerLook 的 ${w}×${h} 不符`);
    tex?.forEach(t => t.dispose());
    const n = w * h;
    const mk = (data, fmt, type, filter = THREE.NearestFilter) => {
      const t = new THREE.DataTexture(data, w, h, fmt, type);
      t.colorSpace = THREE.NoColorSpace;
      t.minFilter = t.magFilter = filter;
      t.needsUpdate = true;
      return t;
    };
    const expandRgba = (img, alpha) => {
      const out = new Uint8Array(n * 4);
      const ch = img.channels;
      for (let i = 0; i < n; i++) {
        out[i * 4] = img.data[i * ch];
        out[i * 4 + 1] = img.data[i * ch + Math.min(1, ch - 1)];
        out[i * 4 + 2] = img.data[i * ch + Math.min(2, ch - 1)];
        out[i * 4 + 3] = alpha;
      }
      return out;
    };
    const depthF32 = new Float32Array(n);
    const idF32 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      depthF32[i] = L.depth.data[i] * L.depthUnit;
      idF32[i] = L.ids.data[i];
    }
    const cT = mk(expandRgba(L.color, 0), THREE.RGBAFormat, THREE.UnsignedByteType, THREE.LinearFilter);
    const dT = mk(depthF32, THREE.RedFormat, THREE.FloatType);
    const iT = mk(idF32, THREE.RedFormat, THREE.FloatType);
    const nT = mk(expandRgba(L.normal, 255), THREE.RGBAFormat, THREE.UnsignedByteType);
    tex = [cT, dT, iT, nT];
    src = L;
  };

  function render(L, p = {}) {
    if (src !== L) upload(L);
    const [cT, dT, iT, nT] = tex;
    const k = h / 1080;
    const OL = opt(p.outline, D_OUT), TN = opt(p.toon, D_TOON), KU = opt(p.kuwahara, D_KUWA), PA = opt(p.paper, D_PAPER);
    const prevRT = renderer.getRenderTarget();
    const outTarget = p.target !== undefined ? p.target : prevRT;

    tColor.value = cT;
    tDepth.value = dT;
    tId.value = iT;
    tNormal.value = nT;

    paper.prepare();

    const radPx = (KU?.radius ?? 2) * k;
    const KR = Math.max(2, Math.min(10, Math.ceil(radPx)));
    U.kuwaRad.value = radPx;
    U.kuwaQ.value = KU?.q ?? 8;
    U.kuwaStr.value = KU ? KU.strength : 0;
    fx.draw(kuwaMaterial(KR), T.kuwa);

    if (OL) {
      U.halfW.value = OL.width * 0.5 * k;
      U.inner.value = OL.inner;
      U.depthThr.value = OL.depthThreshold;
      U.normThr.value = OL.normalThreshold;
      U.opacity.value = OL.opacity;
      fx.draw(edgeMat, T.edge);

      const SR = Math.max(2, Math.min(16, Math.ceil(OL.width * 0.5 * k * (1 + OL.pressure) + 1)));
      U.wobble.value = OL.wobble * k;
      U.warp.value = OL.warp * k;
      U.pressure.value = OL.pressure;
      U.seed.value = Math.floor((p.t ?? 0) * OL.boilFps + 1e-6) % 100000;
      fx.draw(strokeMaterial(SR), T.line);
    } else {
      renderer.setRenderTarget(T.line);
      renderer.setClearColor(0, 1);
      renderer.clear(true, false, false);
    }

    const pl = PA ? paper.layer(PA, Math.max(1, Math.round(k)), k) : null;
    linVec(THREE, OL?.color ?? D_OUT.color, U.ink.value);
    U.tint.value = OL?.tint ?? 0;
    U.view.value = VIEWS[p.view ?? 'final'] ?? 0;
    U.split.value = p.split ?? 0;
    U.paper.value = pl?.strength ?? 0;
    U.useProcMid.value = pl && pl.mid === null ? 1 : 0;
    U.paperMid.value = pl?.mid ?? 0.5;
    tPaper.value = pl?.texture ?? cT;
    U.paperSize.value.set(pl?.w ?? 1, pl?.h ?? 1);
    U.bands.value = TN?.bands ?? 0;
    U.skyBands.value = TN?.sky ?? 0;
    U.soft.value = TN?.soft ?? 0.07;
    U.lo.value = TN?.lo ?? 0.35;
    U.hi.value = TN?.hi ?? 0.92;

    if (!p.skipOutputDraw) {
      const targetIsSrgb = outTarget?.texture?.colorSpace === THREE.SRGBColorSpace;
      U.encodeEotf.value = targetIsSrgb ? 1 : 0;
      fx.draw(finalMat, outTarget);
    }
    renderer.setRenderTarget(prevRT);
  }

  return {
    render,
    node: srgbNode,
    output: outputNode,
    dispose() {
      tex?.forEach(t => t.dispose());
      Object.values(T).forEach(t => t.dispose());
      [edgeMat, finalMat, ...kuwaMats.values(), ...strokeMats.values()].forEach(m => m.dispose());
      dummyByte.dispose();
      dummyFloat.dispose();
      paper.dispose();
    },
  };
}
