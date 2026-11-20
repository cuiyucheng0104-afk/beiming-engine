// 优化前的 TSL 墨线原样副本（engine/offscreen/tsl/ink.js @ 优化前），只作逐像素对照的基准，不要改：
// 边缘遍对全画幅（含空白天底）都做 4 邻域 ID + 8 邻域深度 + 雾计算；笔画遍对全画幅每个像素都跑 6 次 vnoise 与 (2SR+1)² 完整窗口循环。
import { createIdPass } from '../../../engine/offscreen/tsl/idpass.js';
import { fogUniforms, setFog, fogNodes } from '../../../engine/offscreen/tsl/fog.js';
import { noise } from '../../../engine/offscreen/tsl/noise.js';
import { createFullscreen, glCoord } from '../../../engine/offscreen/tsl/pass.js';
import { boilSeed } from '../../../engine/offscreen/tsl/ink.js';

export function createInkLegacy({ THREE, TSL, renderer }, { width: LW, height: LH }) {
  const { Fn, If, Loop, float, int, uint, vec2, vec4, ivec2, uniform, texture, screenCoordinate, floor, max, mix, clamp, abs, select, smoothstep, length,
    perspectiveDepthToViewZ, orthographicDepthToViewZ } = TSL;

  const NEAREST = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
  const idTarget = new THREE.RenderTarget(LW, LH, { type: THREE.HalfFloatType, ...NEAREST, depthTexture: new THREE.DepthTexture(LW, LH, THREE.FloatType) });
  const edge = new THREE.RenderTarget(LW, LH, { type: THREE.HalfFloatType, depthBuffer: false, ...NEAREST });
  const line = new THREE.RenderTarget(LW, LH, { type: THREE.UnsignedByteType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  const idPass = createIdPass({ THREE, TSL, renderer });
  const fx = createFullscreen({ THREE, renderer });

  const idTex = texture(idTarget.texture), depthTex = texture(idTarget.depthTexture), edgeTex = texture(edge.texture);
  const mx = ivec2(LW - 1, LH - 1);
  const U = {
    ...fogUniforms({ THREE, TSL }),
    near: uniform(0.1), far: uniform(100), ortho: uniform(0), halfW: uniform(2), depthThr: uniform(0.03), inner: uniform(0.6), sil: uniform(0.12), opacity: uniform(1), fogFade: uniform(0),
    wd: uniform(new THREE.Vector3()),
    wobble: uniform(1), warp: uniform(60), pressure: uniform(0), breakup: uniform(0), seed: uniform(0),
  };
  const { viewPosAt, fogAmount } = fogNodes(TSL, U);

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
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const q = clamp(p.add(ivec2(dx, dy)), ivec2(0), mx);
      const idq = gid(idTex.load(q));
      const zq = lz(q), rel = zq.sub(z0).div(z0);
      const own = rel.greaterThan(0.002).or(rel.greaterThan(-0.002).and(id0.greaterThan(idq)));
      If(abs(idq.sub(id0)).greaterThan(0.5).and(own), () => { e.assign(1); gap.assign(max(gap, rel)); });
    }
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const zp = lz(clamp(p.add(ivec2(dx, dy)), ivec2(0), mx)), zm = lz(clamp(p.sub(ivec2(dx, dy)), ivec2(0), mx));
      const lap = float(1).div(zp).add(float(1).div(zm)).sub(iz0.mul(2)).div(iz0);
      If(lap.lessThan(U.depthThr.negate()), () => { e.assign(1); gap.assign(max(gap, max(zp, zm).div(z0).sub(1))); });
    }
    const uvTop = screenCoordinate.xy.div(vec2(LW, LH));
    const vp = viewPosAt(uvTop, depthTex.load(p).x);
    const wp = U.uCamWorld.mul(vec4(vp, 1)).xyz;
    const f = fogAmount(length(vp), wp.y);
    const strength = clamp(s0.w, 0, 1).mul(U.opacity).mul(float(1).sub(U.fogFade.mul(f)));
    const hw = U.halfW.mul(s0.z).mul(mix(float(1), U.wd.z, smoothstep(U.wd.x, U.wd.y, z0))).mul(select(gap.greaterThan(U.sil), float(1), U.inner));
    const valid = id0.greaterThanEqual(0.5).and(s0.w.greaterThanEqual(0.002)).and(e.greaterThan(0.5));
    return select(valid, vec4(strength, hw, gap, 1), vec4(0));
  })();

  const { vnoise } = noise(TSL);

  const strokeMats = new Map();
  const strokeMaterial = SR => {
    if (strokeMats.has(SR)) return strokeMats.get(SR);
    const m = new THREE.NodeMaterial();
    m.fragmentNode = Fn(() => {
      const c = glCoord(TSL, LH);
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
        const E = edgeTex.load(ivec2(ec.x, mx.y.sub(ec.y)));
        const d = length(q.sub(vec2(e).add(0.5)));
        cov.assign(max(cov, select(inb.and(E.x.greaterThan(0)), clamp(E.y.mul(pr).add(0.5).sub(d), 0, 1).mul(E.x), float(0))));
      });
      const brk = select(U.breakup.greaterThan(0), smoothstep(U.breakup.sub(0.1), U.breakup.add(0.1), vnoise(q.div(U.warp.mul(0.6)), sd.add(uint(9)))), float(1));
      return vec4(cov.mul(brk), 0, 0, 1);
    })();
    strokeMats.set(SR, m);
    return m;
  };

  function render({ scene, camera, p, fog = null, fogColor, t, k = 1, ss = 1, fps = 24 }) {
    const prev = renderer.getRenderTarget();
    try {
      const maxWidth = idPass.render(scene, camera, idTarget) || 1;
      U.near.value = camera.near; U.far.value = camera.far; U.ortho.value = camera.isOrthographicCamera ? 1 : 0;
      const hw = p.width * 0.5 * k * ss;
      U.halfW.value = hw; U.depthThr.value = p.depthThreshold; U.inner.value = p.inner; U.sil.value = p.silhouette; U.opacity.value = p.opacity;
      U.fogFade.value = fog ? (p.fogFade ?? 0.9) : 0;
      setFog(THREE, U, fog, camera, fogColor);
      U.wd.value.set(p.near, p.far, p.farScale);
      fx.draw(edgeMaterial, edge);
      const widest = hw * maxWidth * Math.max(1, p.farScale ?? 1) * Math.max(1, p.inner ?? 1) * (1 + Math.max(0, p.pressure ?? 0));
      const R = Math.min(Math.max(8, Math.min(16, Math.ceil(8 * k))), Math.max(2, Math.ceil(widest + 1)));
      U.wobble.value = p.wobble * k * ss; U.warp.value = p.warp * k * ss; U.pressure.value = p.pressure; U.breakup.value = p.breakup;
      U.seed.value = boilSeed(t, p, fps);
      fx.draw(strokeMaterial(R), line);
    } finally { renderer.setRenderTarget(prev); }
  }

  function dispose() {
    idPass.dispose(); edgeMaterial.dispose(); for (const m of strokeMats.values()) m.dispose();
    idTarget.dispose(); idTarget.depthTexture.dispose(); edge.dispose(); line.dispose();
  }

  return { render, line, edge, idTarget, dispose };
}
