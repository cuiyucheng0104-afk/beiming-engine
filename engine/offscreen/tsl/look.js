// 北冥引擎 · 离屏出片 · A 风格后期管线（TSL）：engine/look/index.js 的对应，按同一个顺序串起来：
//   ① 主场景 → HalfFloat 线性 HDR，带深度纹理
//   ② ID 图（超采样 ss 倍）→ 边缘检测（含雾淡出）→ 笔画（tsl/ink.js）
//   ③ 空气透视雾（tsl/fog.js）→ bloom → 调色 → 输出变换（线性 → sRGB 数值）
//   ④ Kuwahara（sRGB 空间，远处换半径）→ 叠墨线 → 纸纹（支持 anchor / refHeight 面积取样）→ 暗角 →（颗粒），或 p.debug 调试视图
// 参数合并、默认值与种子用 engine/look/index.js 导出的纯函数（lookDefaults / lookParams / grainCellOf / grainSeedOf），语义不另抄一份。
import { lookDefaults, lookParams, grainCellOf, grainSeedOf } from '../../look/index.js';
import { createInk } from './ink.js';
import { createFog } from './fog.js';
import { createGrade } from './grade.js';
import { createBloom } from './bloom.js';
import { createPaper } from './paper.js';
import { createCompose } from './compose.js';
import { createDebugView } from './debug.js';
import { kuwahara } from './kuwahara.js';
import { createFullscreen } from './pass.js';
import { markGpu, markGpuZero } from '../gputimer.mjs';

const unsupported = (code, msg) => Object.assign(new Error(msg), { code });
// WP5 安全白名单（fail-closed）：只有 __LOOKDEV 的顶层键全部落在此表内（不影响 scene / depth / ID 通道）时，才允许复用中间层快照
export const LOOKDEV_CACHE_KEYS = Object.freeze(new Set(['grade', 'fog', 'bloom', 'kuwahara', 'paper', 'vignette', 'grain', 'outline']));
const lookdevCacheSafe = ld => !ld || (typeof ld === 'object' && !Array.isArray(ld) && Object.keys(ld).every(k => LOOKDEV_CACHE_KEYS.has(k)));

export function createLook({ THREE, TSL, renderer }, { width: W, height: H, ss = 2, msaa = 0, refHeight = 1080, fps = 24, defaults, paper: image = null, fogColor } = {}) {
  const { uniform, texture, select, sRGBTransferEOTF, vec4 } = TSL;
  if (renderer.toneMapping !== THREE.NoToneMapping) throw unsupported('unsupported.look', '离屏 look 只支持 NoToneMapping（renderer.toneMapping 不是）');
  const D = lookDefaults(defaults);
  const LW = W * ss, LH = H * ss;
  const fx = createFullscreen({ THREE, renderer });
  const rt = (w, h, o = {}) => new THREE.RenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, ...o });
  const mrtOk = ss === 1 && msaa === 0;   // WP2.2：只有这种配置才可能同遍写 ID；单附件与双附件目标分离按需分配，回退与无墨线帧不挂全局 MRT、不常驻第二附件
  const T = {
    scene: null,
    sceneMrt: null,
    fog: rt(W, H), grade: rt(W, H), out: rt(W, H), kuwa: rt(W, H),
  };
  const ensureScene = () => (T.scene ??= new THREE.RenderTarget(W, H, {
    type: THREE.HalfFloatType, samples: msaa, depthTexture: new THREE.DepthTexture(W, H, THREE.FloatType),
  }));
  const ensureSceneMrt = () => {
    if (!T.sceneMrt) {
      T.sceneMrt = new THREE.RenderTarget(W, H, {
        count: 2, type: THREE.HalfFloatType, samples: 0, depthTexture: new THREE.DepthTexture(W, H, THREE.FloatType),
      });
      T.sceneMrt.textures[0].name = 'output'; T.sceneMrt.textures[1].name = 'inkId';
      T.sceneMrt.textures[1].minFilter = T.sceneMrt.textures[1].magFilter = THREE.NearestFilter;
    }
    return T.sceneMrt;
  };
  if (!mrtOk) ensureScene();
  const ink = createInk({ THREE, TSL, renderer }, { width: LW, height: LH });
  const fog = createFog({ THREE, TSL, renderer }, { width: W, height: H });
  const grade = createGrade({ THREE, TSL, renderer }, { width: W, height: H });
  const bloom = createBloom({ THREE, TSL, renderer }, { refHeight }); bloom.resize(W, H);
  const paper = createPaper({ THREE, TSL, renderer }, { refHeight, image }); paper.resize(W, H);
  const compose = createCompose({ THREE, TSL }, { width: W, height: H, mid: paper.procMid });
  const debug = createDebugView({ THREE, TSL }, { width: W, height: H, depthTexture: ink.idTarget.depthTexture });
  const uDebugOn = uniform(0);

  // Kuwahara：采样半径 KR 与是否远近换半径是编译期的，按需要编译几个变体（与 GLSL 版同样）
  const kIn = texture(T.out.texture), kDepth = texture(T.scene ? T.scene.depthTexture : ink.idTarget.depthTexture);
  const KU = { radius: uniform(4), farRadius: uniform(4), farStart: uniform(40), farEnd: uniform(120), q: uniform(8), strength: uniform(1), near: uniform(0.1), farClip: uniform(100), texel: uniform(new THREE.Vector2(1 / W, 1 / H)) };
  const kMats = new Map();
  const kMat = (KR, far) => {
    const key = `${KR}${far ? 'f' : ''}`;
    if (!kMats.has(key)) {
      const node = kuwahara(TSL, { input: kIn, KR, radius: KU.radius, q: KU.q, strength: KU.strength, texel: KU.texel,
        far: far ? { depth: kDepth, radius: KU.farRadius, start: KU.farStart, end: KU.farEnd, near: KU.near, farClip: KU.farClip } : undefined });
      kMats.set(key, fx.material(node));
    }
    return kMats.get(key);
  };

  const node = select(uDebugOn.greaterThan(0.5), debug.node, compose.node);
  const output = vec4(sRGBTransferEOTF(node.rgb), 1);
  let snapshot = null;   // WP5：lookdev 显式给令牌时才复用现有 GPU 目标；普通出片令牌为 null，永远重渲

  function render(scene, camera, p = {}) {
    const t = p.t ?? 0, k = H / refHeight, kp = Math.max(1, Math.round(k));   // kp：图片纸纹 / 颗粒的整数像素倍率
    const { outline: OL, kuwahara: KW, bloom: BL, grade: GR, fog: FG, paper: PA, vignette: VG, grain: GN, grainSize, grainHold } = lookParams(p, D);
    const prev = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    try {
      markGpu(renderer, 'paper'); paper.prepare();
      camera.updateMatrixWorld();

      // ① 主场景；lookdev 令牌有效且 __LOOKDEV 全部键在纯后期白名单内时才复用快照，普通出片永远重渲
      const lineOn = !!(OL && OL.opacity > 0 && OL.width > 0);
      const rawToken = globalThis.__OFFSCREEN_LOOKDEV_CACHE ?? null;
      const token = rawToken !== null && lookdevCacheSafe(globalThis.__LOOKDEV) ? rawToken : null;
      const reuse = token !== null && snapshot?.key === token && snapshot.scene === scene && snapshot.camera === camera;
      let sceneTarget = reuse ? snapshot.target : null;
      let ids = reuse ? snapshot.ids : null;
      let idPlan = null;
      if (reuse) {
        markGpuZero(renderer, 'scene');
      } else {
        markGpu(renderer, 'scene');
        if (mrtOk && lineOn) {
          const res = ink.renderMrt(scene, camera, ensureSceneMrt);
          if (res.ids) { ids = res.ids; sceneTarget = res.ids.target; }
          else idPlan = res.plan;
        }
        if (!sceneTarget) {
          sceneTarget = ensureScene();
          renderer.setRenderTarget(sceneTarget);
          renderer.clear(true, true, true);
          renderer.render(scene, camera);
        }
        snapshot = token !== null ? { key: token, scene, camera, target: sceneTarget, ids: null } : null;
        renderer.setClearColor(prevClear, prevAlpha);
      }

      // ② 墨线：有快照就直接读 sceneMrt 第二附件或保留的 ink.idTarget；首组未开墨线时这里补跑 ID
      if (lineOn) {
        const maxWidth = ink.render({ scene, camera, p: OL, fog: FG, fogColor, t, k, ss, fps, ids, idPlan });
        if (snapshot) snapshot.ids = ids ?? { maxWidth, texture: ink.idTarget.texture, depthTexture: ink.idTarget.depthTexture };
        renderer.setClearColor(prevClear, prevAlpha);
      }

      // ③ 雾 → bloom → 调色 → 输出变换
      let src = sceneTarget.texture;
      if (FG) { markGpu(renderer, 'fog'); fog.render(src, sceneTarget.depthTexture, FG, camera, T.fog, fogColor); src = T.fog.texture; }
      let glow = null;
      if (BL && BL.strength > 0) { markGpu(renderer, 'bloom'); glow = bloom.render(src, BL); }
      markGpu(renderer, 'grade');
      grade.render({ src, bloom: glow, bloomAmount: BL ? BL.strength : 0, bloomTint: BL?.tint, grade: GR, protect: KW && KW.protect }, T.grade);
      grade.output(T.grade.texture, T.out);

      // ④ Kuwahara（sRGB 空间）→ 合成或调试视图
      let col = T.out.texture;
      if (KW && KW.strength > 0 && KW.radius > 0) {
        const r = KW.radius * k, rf = (KW.farRadius ?? KW.radius) * k, KR = Math.min(10, Math.max(2, Math.ceil(Math.max(r, rf))));
        const far = rf !== r && !camera.isOrthographicCamera;
        if (far) kDepth.value = sceneTarget.depthTexture;
        KU.radius.value = r; KU.farRadius.value = rf; KU.farStart.value = KW.farStart ?? 40; KU.farEnd.value = KW.farEnd ?? 120;
        KU.q.value = KW.q ?? 8; KU.strength.value = Math.min(1, KW.strength); KU.near.value = camera.near; KU.farClip.value = camera.far;
        markGpu(renderer, 'kuwahara'); fx.draw(kMat(KR, far), T.kuwa); col = T.kuwa.texture;
      }
      markGpu(renderer, 'paper');
      const layer = paper.layer(PA, kp, k);
      if (p.debug) {
        uDebugOn.value = 1;
        debug.update(p.debug, {
          id: ink.idTexture, depth: ink.depthTexture, edge: ink.edge.texture,
          line: ink.line.texture, bloom: glow, paper: layer.texture, kuwahara: col, scene: sceneTarget.texture,
        }, camera);
      } else {
        uDebugOn.value = 0;
        compose.update({ src: col, line: lineOn ? ink.line.texture : null, ink: OL, paper: layer, vignette: VG, grain: GN,
          grainSeed: grainSeedOf(t, fps, grainHold), grainCell: grainCellOf(grainSize, k, kp) });
      }
    } finally { renderer.setClearColor(prevClear, prevAlpha); renderer.setRenderTarget(prev); }
  }

  function dispose() {
    for (const r of Object.values(T)) if (r) { r.depthTexture?.dispose(); r.dispose(); }
    for (const m of kMats.values()) m.dispose();
    for (const m of [ink, fog, grade, bloom, paper, compose, debug]) m.dispose();
  }

  return { render, node, output, dispose };
}
