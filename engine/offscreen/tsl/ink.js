// 北冥引擎 · 离屏出片 · 屏幕空间手绘墨线（TSL）：engine/look/ink.js 的对应，算法与常数逐项照搬。
// ID 图 + 深度 → 边缘（近的一侧拥有这条线）→ 8×8 块归约与可分离膨胀 → 笔画（圆头笔 + 域扭曲抖动 + 笔压 + 断线）。抖动的种子 = boilSeed(t, p, fps)，同一拍内线不动。
//
//   createInk({ THREE, TSL, renderer }, { width, height }) → {
//     render({ scene, camera, p, t, k = 1, ss = 1, fps = 24 })   画一遍 ID 图 → 边缘 → 笔画，结果在 line 里；渲完还原渲染目标
//     line        笔画覆盖率的 RenderTarget（UnsignedByte，R 通道 = 覆盖率）；合成时 texture(ink.line.texture) 取样
//     idTarget    ID 图（HalfFloat、Nearest、带 FloatType 深度）
//     dispose()
//   }
//   width × height 是墨线缓冲的尺寸（= 输出尺寸 × ss）。p 的字段、像素量按标定高度给（内部乘 k·ss），与 GLSL 版相同：
//     width wobble warp boilFps boilHold pressure breakup inner silhouette depthThreshold near far farScale opacity fogFade
//   fog：雾参数或 null（线在雾里按 fogFade 变淡）；ID 通道的未支持语义见 idpass.js。
// 屏幕坐标：WebGPU 是左上角原点，GLSL 版的 gl_FragCoord 是左下角。边缘检测对翻转对称；笔画的域扭曲噪声按坐标取值，这里把 y 翻回 GL 约定，
// 这样同一帧同一参数下笔画与 A 路线逐点一致。
//
// 性能（与 tests/offscreen/fixtures/ink-legacy.js 逐像素一致，见 tests/offscreen/ink-fast.test.mjs）：
//   · 边缘遍：空白背景（id < 0.5 或 alpha < 0.002）直接早退，四邻域深度只取一次，仅真实边缘像素算视空间坐标与雾。
//   · 笔画遍：真实画面里只有约 1% 是边缘像素。先按 8×8 块把边缘图归约成每块的 (局部最大半宽, 紧凑边缘包围盒 x/y, 是否有边缘)，
//     再在 1/64 分辨率的块图上做可分离膨胀；笔画着色器先查膨胀块图——空白块（约 80%–90%）在 vnoise 之前整块早退，
//     活跃块按局部半宽与每块紧包围盒的距离剪枝，只扫描真实可能覆盖当前像素的边缘，且只需编译一套笔画着色器（不再按 R 编多份）。
import { createIdPass } from './idpass.js';
import { fogUniforms, setFog, fogNodes } from './fog.js';
import { noise } from './noise.js';
import { createFullscreen, glCoord } from './pass.js';
import { markGpu } from '../gputimer.mjs';

const TILE = 8;

// 墨线沸腾的种子：boilHold（整数 ≥ 1）按帧，否则按 boilFps。与 engine/look/ink.js 的 boilSeed 同一个公式（tests/offscreen/ink.test.mjs 对拍）。
// 不直接 import 它：那个文件顶层 import 了仓库的 three r170，会和离屏用的 r187 同时装进一个进程。
export function boilSeed(t, p, fps = 24) {
  if (p.boilHold !== undefined && p.boilHold !== null) {
    if (!(Number.isInteger(p.boilHold) && p.boilHold >= 1)) throw new TypeError(`墨线 boilHold 要是 ≥ 1 的整数（每几帧沸腾一次），收到 ${JSON.stringify(p.boilHold)}`);
    return Math.floor(Math.round(t * fps) / p.boilHold) % 100000;
  }
  return Math.floor(t * p.boilFps + 1e-6) % 100000;
}

/** 块膨胀半径（单位：tile 块）：严格覆盖两档域扭曲噪声（±1.3|wobble|）与采样窗口 ±R 所能触及的全部边缘块。 */
export function inkTilePad(R, wobble, tile = TILE) {
  const reachPx = Math.max(0, R) + Math.ceil(1.3 * Math.abs(wobble) + 0.5);
  return Math.ceil(reachPx / tile);
}

export function createInk({ THREE, TSL, renderer }, { width: LW, height: LH }) {
  const {
    Fn, If, Loop, float, int, uint, vec2, vec4, ivec2, uniform, texture, screenCoordinate,
    floor, ceil, min, max, mix, clamp, abs, select, smoothstep, length,
    perspectiveDepthToViewZ, orthographicDepthToViewZ,
  } = TSL;

  const TW = Math.ceil(LW / TILE), TH = Math.ceil(LH / TILE);
  const fullTiles = (LW % TILE === 0) && (LH % TILE === 0);
  const NEAREST = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
  const idTarget = new THREE.RenderTarget(LW, LH, { type: THREE.HalfFloatType, ...NEAREST, depthTexture: new THREE.DepthTexture(LW, LH, THREE.FloatType) });
  const edge = new THREE.RenderTarget(LW, LH, { type: THREE.HalfFloatType, depthBuffer: false, ...NEAREST });
  const tile0 = new THREE.RenderTarget(TW, TH, { type: THREE.HalfFloatType, depthBuffer: false, ...NEAREST });
  const tileH = new THREE.RenderTarget(TW, TH, { type: THREE.HalfFloatType, depthBuffer: false, ...NEAREST });
  const tileReach = new THREE.RenderTarget(TW, TH, { type: THREE.HalfFloatType, depthBuffer: false, ...NEAREST });
  const line = new THREE.RenderTarget(LW, LH, { type: THREE.UnsignedByteType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  const idPass = createIdPass({ THREE, TSL, renderer });
  const fx = createFullscreen({ THREE, renderer });

  const idTex = texture(idTarget.texture), depthTex = texture(idTarget.depthTexture), edgeTex = texture(edge.texture);
  const tile0Tex = texture(tile0.texture), tileHTex = texture(tileH.texture), tileReachTex = texture(tileReach.texture);
  const mx = ivec2(LW - 1, LH - 1);
  const U = {
    ...fogUniforms({ THREE, TSL }),
    near: uniform(0.1), far: uniform(100), ortho: uniform(0), halfW: uniform(2), depthThr: uniform(0.03), inner: uniform(0.6), sil: uniform(0.12), opacity: uniform(1), fogFade: uniform(0),
    wd: uniform(new THREE.Vector3()),
    wobble: uniform(1), warp: uniform(60), pressure: uniform(0), breakup: uniform(0), seed: uniform(0),
    sr: uniform(8), tilePad: uniform(2),
  };
  const { viewPosAt, fogAmount } = fogNodes(TSL, U);

  // 边缘检测：ID 跳变 + 深度断层 / 折痕；输出 (浓度, 半线宽, 深度差, 1)
  const edgeMaterial = new THREE.NodeMaterial();
  edgeMaterial.fragmentNode = Fn(() => {
    const p = ivec2(screenCoordinate.xy);
    const gid = s => s.x.add(s.y.mul(2048));
    const s0 = idTex.load(p);
    const id0 = gid(s0);
    const out = vec4(0).toVar();
    // 空白天底或透明处必不出线：整段跳过邻域深度读取与雾算术
    If(id0.greaterThanEqual(0.5).and(s0.w.greaterThanEqual(0.002)), () => {
      const lzD = d => select(U.ortho.greaterThan(0.5), orthographicDepthToViewZ(d, U.near, U.far), perspectiveDepthToViewZ(d, U.near, U.far)).negate();
      const lz = q => lzD(depthTex.load(q).x);
      const d0 = depthTex.load(p).x;
      const z0 = lzD(d0), iz0 = float(1).div(z0);
      const e = float(0).toVar(), gap = float(0).toVar();

      // ① ID 跳变（4 邻域），顺便记下 4 个轴向邻域的视空间深度给 ② 复用
      const zCard = [];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const q = clamp(p.add(ivec2(dx, dy)), ivec2(0), mx);
        const idq = gid(idTex.load(q));
        const zq = lz(q);
        zCard.push(zq);
        const rel = zq.sub(z0).div(z0);
        const own = rel.greaterThan(0.002).or(rel.greaterThan(-0.002).and(id0.greaterThan(idq)));
        If(abs(idq.sub(id0)).greaterThan(0.5).and(own), () => { e.assign(1); gap.assign(max(gap, rel)); });
      }
      // ② 深度断层 / 折痕：1/z 的二阶差分（平面上恒为 0）；只在近的一侧出线
      const checkLap = (zp, zm) => {
        const lap = float(1).div(zp).add(float(1).div(zm)).sub(iz0.mul(2)).div(iz0);
        If(lap.lessThan(U.depthThr.negate()), () => { e.assign(1); gap.assign(max(gap, max(zp, zm).div(z0).sub(1))); });
      };
      checkLap(zCard[0], zCard[1]);
      checkLap(zCard[2], zCard[3]);
      for (const [dx, dy] of [[1, 1], [1, -1]]) {
        checkLap(lz(clamp(p.add(ivec2(dx, dy)), ivec2(0), mx)), lz(clamp(p.sub(ivec2(dx, dy)), ivec2(0), mx)));
      }
      If(e.greaterThan(0.5), () => {
        const uvTop = screenCoordinate.xy.div(vec2(LW, LH));
        const vp = viewPosAt(uvTop, d0);
        const wp = U.uCamWorld.mul(vec4(vp, 1)).xyz;
        const f = fogAmount(length(vp), wp.y);
        const strength = clamp(s0.w, 0, 1).mul(U.opacity).mul(float(1).sub(U.fogFade.mul(f)));
        const hw = U.halfW.mul(s0.z).mul(mix(float(1), U.wd.z, smoothstep(U.wd.x, U.wd.y, z0))).mul(select(gap.greaterThan(U.sil), float(1), U.inner));
        out.assign(vec4(strength, hw, gap, 1));
      });
    });
    return out;
  })();

  // 8×8 边缘块归约：输出 (局部最大半宽 E.y, minX + maxX*16, minY + maxY*16, 是否有边缘 0|1)
  // HalfFloat 精确表示 0..2048 整数与 E.y 本身（E.y 本就来自 HalfFloat 边缘图），无精度损失
  const tile0Mat = new THREE.NodeMaterial();
  tile0Mat.fragmentNode = Fn(() => {
    const tp = ivec2(screenCoordinate.xy);
    const bx = tp.x.shiftLeft(uint(3)), by = tp.y.shiftLeft(uint(3));
    const hasEdge = float(0).toVar(), maxHw = float(0).toVar();
    const minX = int(TILE).toVar(), maxX = int(-1).toVar(), minY = int(TILE).toVar(), maxY = int(-1).toVar();
    Loop({ start: int(0), end: int(TILE), type: 'int', condition: '<', name: 'ly' },
      { start: int(0), end: int(TILE), type: 'int', condition: '<', name: 'lx' }, ({ lx, ly }) => {
        const ex = bx.add(lx), ey = by.add(ly);
        const body = () => {
          const E = edgeTex.load(ivec2(ex, ey));
          If(E.x.greaterThan(0), () => {
            hasEdge.assign(1);
            maxHw.assign(max(maxHw, E.y));
            minX.assign(min(minX, lx));
            maxX.assign(max(maxX, lx));
            minY.assign(min(minY, ly));
            maxY.assign(max(maxY, ly));
          });
        };
        if (fullTiles) body();
        else If(ex.lessThan(LW).and(ey.lessThan(LH)), body);
      });
    return select(hasEdge.greaterThan(0.5),
      vec4(maxHw, float(minX.add(maxX.shiftLeft(uint(4)))), float(minY.add(maxY.shiftLeft(uint(4)))), 1),
      vec4(0));
  })();

  // 可分离块膨胀：横向 tile0 → tileH，纵向 tileH → tileReach，每块存邻居 ±tilePad 范围内的 (maxHw, 0, 0, hasAny)
  const tileHMat = new THREE.NodeMaterial();
  tileHMat.fragmentNode = Fn(() => {
    const tp = ivec2(screenCoordinate.xy);
    const pad = int(U.tilePad);
    const x0 = max(int(0), tp.x.sub(pad)), x1 = min(int(TW - 1), tp.x.add(pad));
    const maxHw = float(0).toVar(), hasAny = float(0).toVar();
    Loop({ start: x0, end: x1, type: 'int', condition: '<=', name: 'nx' }, ({ nx }) => {
      const t = tile0Tex.load(ivec2(nx, tp.y));
      maxHw.assign(max(maxHw, t.x));
      hasAny.assign(max(hasAny, t.w));
    });
    return vec4(maxHw, 0, 0, hasAny);
  })();

  const tileVMat = new THREE.NodeMaterial();
  tileVMat.fragmentNode = Fn(() => {
    const tp = ivec2(screenCoordinate.xy);
    const pad = int(U.tilePad);
    const y0 = max(int(0), tp.y.sub(pad)), y1 = min(int(TH - 1), tp.y.add(pad));
    const maxHw = float(0).toVar(), hasAny = float(0).toVar();
    Loop({ start: y0, end: y1, type: 'int', condition: '<=', name: 'ny' }, ({ ny }) => {
      const t = tileHTex.load(ivec2(tp.x, ny));
      maxHw.assign(max(maxHw, t.x));
      hasAny.assign(max(hasAny, t.w));
    });
    return vec4(maxHw, 0, 0, hasAny);
  })();

  const { vnoise } = noise(TSL);

  // 笔画：以边缘像素为圆心画圆头笔，查找坐标做低频域扭曲；先查膨胀块图早退，再按局部半宽与每块紧包围盒只扫可能相交的边缘
  const strokeMat = new THREE.NodeMaterial();
  strokeMat.fragmentNode = Fn(() => {
    const pTL = ivec2(screenCoordinate.xy);
    const reach = tileReachTex.load(ivec2(pTL.x.shiftRight(uint(3)), pTL.y.shiftRight(uint(3))));
    const cov = float(0).toVar();
    If(reach.w.greaterThan(0.5), () => {
      const c = glCoord(TSL, LH);   // 与 gl_FragCoord 同约定（左下角原点）
      const sd = uint(U.seed).mul(uint(7919)).add(uint(13));
      const q = c.toVar();
      If(U.wobble.notEqual(0), () => {
        const a = c.div(U.warp), b = c.div(U.warp.mul(0.31));
        q.addAssign(vec2(vnoise(a, sd), vnoise(a.add(31.7), sd.add(uint(1)))).mul(2).sub(1).mul(U.wobble));
        q.addAssign(vec2(vnoise(b, sd.add(uint(2))), vnoise(b.add(13.1), sd.add(uint(3)))).mul(2).sub(1).mul(U.wobble).mul(0.3));
      });
      const pr = float(1).toVar();
      If(U.pressure.notEqual(0), () => {
        pr.assign(float(1).add(U.pressure.mul(vnoise(q.div(U.warp.mul(0.45)), sd.add(uint(5))).mul(2).sub(1))));
      });

      const b0 = ivec2(floor(q));
      const qTL = vec2(q.x, float(LH).sub(q.y));
      const prPos = max(pr, float(0));
      const maxRadSafe = reach.x.mul(prPos).add(0.501);
      const sr = int(U.sr);
      const b0TLY = int(LH - 1).sub(b0.y);
      // 搜索窗口（左上角坐标）：同时受原始 [b0 - SR, b0 + SR]、画幅边界、以及局部最大半径 maxRadSafe 约束
      const winX0 = max(max(int(0), b0.x.sub(sr)), int(ceil(qTL.x.sub(maxRadSafe).sub(0.5))));
      const winX1 = min(min(int(LW - 1), b0.x.add(sr)), int(floor(qTL.x.add(maxRadSafe).sub(0.5))));
      const winY0 = max(max(int(0), b0TLY.sub(sr)), int(ceil(qTL.y.sub(maxRadSafe).sub(0.5))));
      const winY1 = min(min(int(LH - 1), b0TLY.add(sr)), int(floor(qTL.y.add(maxRadSafe).sub(0.5))));
      If(winX0.lessThanEqual(winX1).and(winY0.lessThanEqual(winY1)), () => {
        const tMinX = winX0.shiftRight(uint(3)), tMaxX = winX1.shiftRight(uint(3));
        const tMinY = winY0.shiftRight(uint(3)), tMaxY = winY1.shiftRight(uint(3));

        Loop({ start: tMinY, end: tMaxY, type: 'int', condition: '<=', name: 'ty' },
          { start: tMinX, end: tMaxX, type: 'int', condition: '<=', name: 'tx' }, ({ tx, ty }) => {
            const T = tile0Tex.load(ivec2(tx, ty));
            If(T.w.greaterThan(0.5), () => {
              const gx = int(T.y.add(0.5)), gy = int(T.z.add(0.5));
              const baseX = tx.shiftLeft(uint(3)), baseY = ty.shiftLeft(uint(3));
              const bx0 = max(winX0, baseX.add(gx.bitAnd(int(15))));
              const bx1 = min(winX1, baseX.add(gx.shiftRight(uint(4))));
              const by0 = max(winY0, baseY.add(gy.bitAnd(int(15))));
              const by1 = min(winY1, baseY.add(gy.shiftRight(uint(4))));
              If(bx0.lessThanEqual(bx1).and(by0.lessThanEqual(by1)), () => {
                const tRadSafe = T.x.mul(prPos).add(0.501);
                const cx = clamp(qTL.x, float(bx0).add(0.5), float(bx1).add(0.5));
                const cy = clamp(qTL.y, float(by0).add(0.5), float(by1).add(0.5));
                If(length(qTL.sub(vec2(cx, cy))).lessThan(tRadSafe), () => {
                  const sx0 = max(bx0, int(ceil(qTL.x.sub(tRadSafe).sub(0.5))));
                  const sx1 = min(bx1, int(floor(qTL.x.add(tRadSafe).sub(0.5))));
                  const sy0 = max(by0, int(ceil(qTL.y.sub(tRadSafe).sub(0.5))));
                  const sy1 = min(by1, int(floor(qTL.y.add(tRadSafe).sub(0.5))));
                  Loop({ start: sy0, end: sy1, type: 'int', condition: '<=', name: 'ey' },
                    { start: sx0, end: sx1, type: 'int', condition: '<=', name: 'ex' }, ({ ex, ey }) => {
                      const E = edgeTex.load(ivec2(ex, ey));
                      If(E.x.greaterThan(0), () => {
                        // 与优化前完全相同的距离算式（e.y 为左下角坐标 = LH - 1 - ey）
                        const d = length(q.sub(vec2(float(ex).add(0.5), float(int(LH - 1).sub(ey)).add(0.5))));
                        cov.assign(max(cov, clamp(E.y.mul(pr).add(0.5).sub(d), 0, 1).mul(E.x)));
                      });
                    });
                });
              });
            });
          });

        If(cov.greaterThan(0).and(U.breakup.greaterThan(0)), () => {
          const brk = smoothstep(U.breakup.sub(0.1), U.breakup.add(0.1), vnoise(q.div(U.warp.mul(0.6)), sd.add(uint(9))));
          cov.mulAssign(brk);
        });
      });
    });
    return vec4(cov, 0, 0, 1);
  })();

  function render({ scene, camera, p, fog = null, fogColor, t, k = 1, ss = 1, fps = 24 }) {
    const prev = renderer.getRenderTarget();
    try {
      markGpu(renderer, 'ink:ids');
      const maxWidth = idPass.render(scene, camera, idTarget) || 1;
      U.near.value = camera.near; U.far.value = camera.far; U.ortho.value = camera.isOrthographicCamera ? 1 : 0;
      const hw = p.width * 0.5 * k * ss;
      U.halfW.value = hw; U.depthThr.value = p.depthThreshold; U.inner.value = p.inner; U.sil.value = p.silhouette; U.opacity.value = p.opacity;
      U.fogFade.value = fog ? (p.fogFade ?? 0.9) : 0;
      setFog(THREE, U, fog, camera, fogColor);
      U.wd.value.set(p.near, p.far, p.farScale);
      markGpu(renderer, 'ink:edge'); fx.draw(edgeMaterial, edge);
      const widest = hw * maxWidth * Math.max(1, p.farScale ?? 1) * Math.max(1, p.inner ?? 1) * (1 + Math.max(0, p.pressure ?? 0));
      const R = Math.min(Math.max(8, Math.min(16, Math.ceil(8 * k))), Math.max(2, Math.ceil(widest + 1)));
      const wobblePx = p.wobble * k * ss;
      U.wobble.value = wobblePx; U.warp.value = p.warp * k * ss; U.pressure.value = p.pressure; U.breakup.value = p.breakup;
      U.seed.value = boilSeed(t, p, fps);
      U.sr.value = R;
      U.tilePad.value = inkTilePad(R, wobblePx, TILE);
      markGpu(renderer, 'ink:stroke');
      fx.draw(tile0Mat, tile0);
      fx.draw(tileHMat, tileH);
      fx.draw(tileVMat, tileReach);
      fx.draw(strokeMat, line);
    } finally { renderer.setRenderTarget(prev); }
  }

  function dispose() {
    idPass.dispose(); edgeMaterial.dispose(); tile0Mat.dispose(); tileHMat.dispose(); tileVMat.dispose(); strokeMat.dispose();
    idTarget.dispose(); idTarget.depthTexture.dispose(); edge.dispose(); tile0.dispose(); tileH.dispose(); tileReach.dispose(); line.dispose();
  }

  return { render, line, edge, idTarget, dispose };
}
