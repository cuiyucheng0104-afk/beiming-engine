// 北冥引擎 · 离屏出片 · 屏幕空间手绘墨线（TSL）：engine/look/ink.js 的对应，算法与常数逐项照搬。
// ID 图 + 深度 → 边缘（近的一侧拥有这条线）→ 笔画（圆头笔 + 域扭曲抖动 + 笔压 + 断线）。抖动的种子 = boilSeed(t, p, fps)，同一拍内线不动。
//
//   createInk({ THREE, TSL, renderer }, { width, height }) → {
//     render({ scene, camera, p, t, k = 1, ss = 1, fps = 24 })   画一遍 ID 图 → 边缘 → 笔画，结果在 line 里；渲完还原渲染目标
//     line        笔画覆盖率的 RenderTarget（UnsignedByte，R 通道 = 覆盖率）；合成时 texture(ink.line.texture) 取样
//     idTarget    ID 图（HalfFloat、Nearest、带 FloatType 深度）
//     dispose()
//   }
//   width × height 是墨线缓冲的尺寸（= 输出尺寸 × ss）。p 的字段、像素量按标定高度给（内部乘 k·ss），与 GLSL 版相同：
//     width wobble warp boilFps boilHold pressure breakup inner silhouette depthThreshold near far farScale opacity
//   没有的：雾里变淡（fogFade，GLSL 版在 fog = null 时也是 0）；ID 通道的未支持语义见 idpass.js。
// 屏幕坐标：WebGPU 是左上角原点，GLSL 版的 gl_FragCoord 是左下角。边缘检测对翻转对称；笔画的域扭曲噪声按坐标取值，这里把 y 翻回 GL 约定，
// 这样同一帧同一参数下笔画与 A 路线逐点一致。
import { createIdPass } from './idpass.js';

// 墨线沸腾的种子：boilHold（整数 ≥ 1）按帧，否则按 boilFps。与 engine/look/ink.js 的 boilSeed 同一个公式（tests/offscreen/ink.test.mjs 对拍）。
// 不直接 import 它：那个文件顶层 import 了仓库的 three r170，会和离屏用的 r187 同时装进一个进程。
export function boilSeed(t, p, fps = 24) {
  if (p.boilHold !== undefined && p.boilHold !== null) {
    if (!(Number.isInteger(p.boilHold) && p.boilHold >= 1)) throw new TypeError(`墨线 boilHold 要是 ≥ 1 的整数（每几帧沸腾一次），收到 ${JSON.stringify(p.boilHold)}`);
    return Math.floor(Math.round(t * fps) / p.boilHold) % 100000;
  }
  return Math.floor(t * p.boilFps + 1e-6) % 100000;
}

export function createInk({ THREE, TSL, renderer }, { width: LW, height: LH }) {
  const { Fn, If, Loop, float, int, uint, vec2, vec4, ivec2, uniform, texture, screenCoordinate, floor, fract, max, mix, clamp, abs, select, smoothstep, length,
    perspectiveDepthToViewZ, orthographicDepthToViewZ } = TSL;

  const NEAREST = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
  const idTarget = new THREE.RenderTarget(LW, LH, { type: THREE.HalfFloatType, ...NEAREST, depthTexture: new THREE.DepthTexture(LW, LH, THREE.FloatType) });
  const edge = new THREE.RenderTarget(LW, LH, { type: THREE.HalfFloatType, depthBuffer: false, ...NEAREST });
  const line = new THREE.RenderTarget(LW, LH, { type: THREE.UnsignedByteType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  const idPass = createIdPass({ THREE, TSL, renderer });
  const quad = new THREE.QuadMesh();

  const idTex = texture(idTarget.texture), depthTex = texture(idTarget.depthTexture), edgeTex = texture(edge.texture);
  const mx = ivec2(LW - 1, LH - 1);
  const U = {
    near: uniform(0.1), far: uniform(100), ortho: uniform(0), halfW: uniform(2), depthThr: uniform(0.03), inner: uniform(0.6), sil: uniform(0.12), opacity: uniform(1),
    wd: uniform(new THREE.Vector3()),
    wobble: uniform(1), warp: uniform(60), pressure: uniform(0), breakup: uniform(0), seed: uniform(0),
  };

  // 边缘检测：ID 跳变 + 深度断层 / 折痕；输出 (浓度, 半线宽, 深度差, 1)
  const edgeMaterial = new THREE.NodeMaterial();
  edgeMaterial.fragmentNode = Fn(() => {
    const p = ivec2(screenCoordinate.xy);
    const lz = q => {
      const d = depthTex.load(q).x;
      return select(U.ortho.greaterThan(0.5), orthographicDepthToViewZ(d, U.near, U.far), perspectiveDepthToViewZ(d, U.near, U.far)).negate();
    };
    const gid = s => s.x.add(s.y.mul(2048));
    const s0 = idTex.load(p);
    const id0 = gid(s0);
    const z0 = lz(p), iz0 = float(1).div(z0);
    const e = float(0).toVar(), gap = float(0).toVar();
    // ① ID 跳变（4 邻域）。只有更近（或一样近）的一侧画线；两个部件互相穿插、深度几乎一样时固定让 ID 大的一侧画
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const q = clamp(p.add(ivec2(dx, dy)), ivec2(0), mx);
      const idq = gid(idTex.load(q));
      const zq = lz(q), rel = zq.sub(z0).div(z0);
      const own = rel.greaterThan(0.002).or(rel.greaterThan(-0.002).and(id0.greaterThan(idq)));
      If(abs(idq.sub(id0)).greaterThan(0.5).and(own), () => { e.assign(1); gap.assign(max(gap, rel)); });
    }
    // ② 深度断层 / 折痕：1/z 的二阶差分（平面上恒为 0）；只在近的一侧出线
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const zp = lz(clamp(p.add(ivec2(dx, dy)), ivec2(0), mx)), zm = lz(clamp(p.sub(ivec2(dx, dy)), ivec2(0), mx));
      const lap = float(1).div(zp).add(float(1).div(zm)).sub(iz0.mul(2)).div(iz0);
      If(lap.lessThan(U.depthThr.negate()), () => { e.assign(1); gap.assign(max(gap, max(zp, zm).div(z0).sub(1))); });
    }
    const strength = clamp(s0.w, 0, 1).mul(U.opacity);
    const hw = U.halfW.mul(s0.z).mul(mix(float(1), U.wd.z, smoothstep(U.wd.x, U.wd.y, z0))).mul(select(gap.greaterThan(U.sil), float(1), U.inner));
    const valid = id0.greaterThanEqual(0.5).and(s0.w.greaterThanEqual(0.002)).and(e.greaterThan(0.5));
    return select(valid, vec4(strength, hw, gap, 1), vec4(0));
  })();

  // 整数哈希（PCG，Jarzynski & Olano 2020）与五次插值的值噪声：与 engine/look/glsl.js 的 HASH_NOISE 逐式相同
  const pcgh = Fn(([v]) => {
    const s = v.mul(uint(747796405)).add(uint(2891336453));
    const w = s.shiftRight(s.shiftRight(uint(28)).add(uint(4))).bitXor(s).mul(uint(277803737));
    return w.shiftRight(uint(22)).bitXor(w);
  });
  const h21 = Fn(([p, seed]) => float(pcgh(uint(p.x).add(pcgh(uint(p.y).add(seed))))).mul(1 / 4294967295));
  const vnoise = Fn(([x, seed]) => {
    const i = floor(x), f = fract(x), ii = ivec2(i);
    const u = f.mul(f).mul(f).mul(f.mul(f.mul(6).sub(15)).add(10));
    const a = h21(ii, seed), b = h21(ii.add(ivec2(1, 0)), seed), c = h21(ii.add(ivec2(0, 1)), seed), d = h21(ii.add(ivec2(1, 1)), seed);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  });

  // 笔画：以边缘像素为圆心画圆头笔，查找坐标做低频域扭曲；SR = 搜索半径（编译期常量，按需要编译几个变体）
  const strokeMats = new Map();
  const strokeMaterial = SR => {
    if (strokeMats.has(SR)) return strokeMats.get(SR);
    const m = new THREE.NodeMaterial();
    m.fragmentNode = Fn(() => {
      const c = vec2(screenCoordinate.x, float(LH).sub(screenCoordinate.y));   // 与 gl_FragCoord 同约定（左下角原点）
      const sd = uint(U.seed).mul(uint(7919)).add(uint(13));
      const a = c.div(U.warp), b = c.div(U.warp.mul(0.31));
      const q = c.add(vec2(vnoise(a, sd), vnoise(a.add(31.7), sd.add(uint(1)))).mul(2).sub(1).mul(U.wobble))
        .add(vec2(vnoise(b, sd.add(uint(2))), vnoise(b.add(13.1), sd.add(uint(3)))).mul(2).sub(1).mul(U.wobble).mul(0.3)).toVar();
      const pr = float(1).add(U.pressure.mul(vnoise(q.div(U.warp.mul(0.45)), sd.add(uint(5))).mul(2).sub(1)));   // 笔压：沿线粗细起伏
      const b0 = ivec2(floor(q));
      const cov = float(0).toVar();
      Loop({ start: int(-SR), end: int(SR), type: 'int', condition: '<=', name: 'j' }, { start: int(-SR), end: int(SR), type: 'int', condition: '<=', name: 'i' }, ({ i, j }) => {
        const e = b0.add(ivec2(i, j));
        const inb = e.x.greaterThanEqual(0).and(e.y.greaterThanEqual(0)).and(e.x.lessThanEqual(mx.x)).and(e.y.lessThanEqual(mx.y));
        const ec = clamp(e, ivec2(0), mx);
        const E = edgeTex.load(ivec2(ec.x, mx.y.sub(ec.y)));   // 边缘图按左上角存，这里的 e 是左下角约定
        const d = length(q.sub(vec2(e).add(0.5)));
        cov.assign(max(cov, select(inb.and(E.x.greaterThan(0)), clamp(E.y.mul(pr).add(0.5).sub(d), 0, 1).mul(E.x), float(0))));
      });
      const brk = select(U.breakup.greaterThan(0), smoothstep(U.breakup.sub(0.1), U.breakup.add(0.1), vnoise(q.div(U.warp.mul(0.6)), sd.add(uint(9)))), float(1));
      return vec4(cov.mul(brk), 0, 0, 1);
    })();
    strokeMats.set(SR, m);
    return m;
  };

  const draw = (material, target) => { quad.material = material; renderer.setRenderTarget(target); quad.render(renderer); };

  function render({ scene, camera, p, t, k = 1, ss = 1, fps = 24 }) {
    const prev = renderer.getRenderTarget();
    try {
      const maxWidth = idPass.render(scene, camera, idTarget) || 1;
      U.near.value = camera.near; U.far.value = camera.far; U.ortho.value = camera.isOrthographicCamera ? 1 : 0;
      const hw = p.width * 0.5 * k * ss;
      U.halfW.value = hw; U.depthThr.value = p.depthThreshold; U.inner.value = p.inner; U.sil.value = p.silhouette; U.opacity.value = p.opacity;
      U.wd.value.set(p.near, p.far, p.farScale);
      draw(edgeMaterial, edge);
      const widest = hw * maxWidth * Math.max(1, p.farScale ?? 1) * Math.max(1, p.inner ?? 1) * (1 + Math.max(0, p.pressure ?? 0));
      const R = Math.min(Math.max(8, Math.min(16, Math.ceil(8 * k))), Math.max(2, Math.ceil(widest + 1)));
      U.wobble.value = p.wobble * k * ss; U.warp.value = p.warp * k * ss; U.pressure.value = p.pressure; U.breakup.value = p.breakup;
      U.seed.value = boilSeed(t, p, fps);
      draw(strokeMaterial(R), line);
    } finally { renderer.setRenderTarget(prev); }
  }

  function dispose() {
    idPass.dispose(); edgeMaterial.dispose(); for (const m of strokeMats.values()) m.dispose();
    idTarget.dispose(); idTarget.depthTexture.dispose(); edge.dispose(); line.dispose();
  }

  return { render, line, idTarget, dispose };
}
