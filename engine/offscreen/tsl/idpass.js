// 北冥引擎 · 离屏出片 · 物体 / 实例 ID 通道（TSL）：engine/look/ids.js 的对应。按 userData 开关把场景临时换成 ID 材质渲一遍，供屏幕空间墨线做边缘检测。
// 输出 RGBA = (id 低 11 位, id 高位, 线宽系数, 线可见度)，HalfFloat 能精确存 0..2048 的整数，拆两段可放 400 万个 ID，与 GLSL 版同一编码。
//
//   createIdPass({ THREE, TSL, renderer }) → { render(scene, camera, target) → 场景里最大的线宽系数（没有描边物体时为 0）, dispose() }
//   target：THREE.RenderTarget，HalfFloat、Nearest、带 DepthTexture（墨线用它做深度检测；FloatType 与 GLSL 版同精度）。渲完还原渲染目标、清屏色与场景背景。
//
// 支持的开关（userData，子物体继承父物体，显式写了以子物体为准）：
//   outline、outlineWidth、outlineAlpha、outlineGroup、outlinePerInstance（InstancedMesh 默认 true = 逐实例分配连续 ID；false = 共用一个 ID）、
//   outlineVertex: { tsl: node | ({ THREE, TSL }) => node }（描边物体的自定义顶点位移节点；若材质自带 positionNode 也会自动继承）、
//   outlineOccluder（'auto' | 'solid' | 'soft' | 'own' | false）：soft = 用物体自己的材质、只按自身 alpha 削减线的可见度（不写深度）；own = 用自己的材质实心挡线（全写 0）。
//   材质带 map 且设了 alphaTest 或 transparent 时，按贴图 alpha 镂空（阈值 alphaTest > 0 ? alphaTest : 0.5）；MeshBasicNodeMaterial 原生处理 InstancedMesh、SkinnedMesh 与变形目标。
//   材质上 userData.noId = true：这个物体不进 ID 图（不描边也不挡线）。
// 不支持（遇到抛 Error(code 'unsupported.outline')，不静默画错）：BatchedMesh、多材质数组、只给 GLSL 字符串没给 tsl 的 outlineVertex。

export function createIdPass({ THREE, TSL, renderer }) {
  const { Fn, If, Discard, uniform, texture, float, vec4, floor, instanceIndex } = TSL;
  const cache = new WeakMap();   // 物体 → { mat, u, sig }：签名不变就复用同一个 ID 材质
  const objKey = new WeakMap();  // 引用对象 → 递增序号（拼缓存签名用）
  let seq = 1;
  const keyOf = x => { if (!x) return 0; if (!objKey.has(x)) objKey.set(x, seq++); return objKey.get(x); };
  const made = new Set();
  const HIDE = new THREE.MeshBasicNodeMaterial({ visible: false });

  const BLEND_KEYS = ['blending', 'blendSrc', 'blendDst', 'blendEquation', 'blendSrcAlpha', 'blendDstAlpha', 'blendEquationAlpha', 'depthWrite'];
  const unsupported = (o, what) => Object.assign(new Error(`离屏墨线 ID 通道未支持：${what}（物体 ${o.name || o.type}）`), { code: 'unsupported.outline' });

  function idMaterialFor(o, m0, ov) {
    const side = m0 ? m0.side : THREE.FrontSide;
    const cut = !!(m0 && m0.map && (m0.alphaTest > 0 || m0.transparent));
    const inst = !!o.isInstancedMesh;
    const posSrc = ov ? ov.tsl : (m0?.positionNode ?? null);
    const sig = `${side}|${inst ? 1 : 0}|${cut ? m0.map.uuid : ''}|${keyOf(posSrc)}`;
    let e = cache.get(o);
    if (!e || e.sig !== sig) {
      if (e) { e.mat.dispose(); made.delete(e.mat); }
      const u = { baseId: uniform(0), perInstance: uniform(0), width: uniform(1), alpha: uniform(1), cutRef: uniform(0.5) };
      const mat = new THREE.MeshBasicNodeMaterial({ side });
      if (posSrc) mat.positionNode = typeof posSrc === 'function' ? posSrc({ THREE, TSL }) : posSrc;
      mat.fragmentNode = Fn(() => {
        if (cut) If(texture(m0.map).a.lessThan(u.cutRef), () => { Discard(); });
        const vId = inst ? u.baseId.add(u.perInstance.mul(float(instanceIndex))) : u.baseId;
        const hi = floor(vId.div(2048));
        const lo = vId.sub(hi.mul(2048));
        return vec4(lo, hi, u.width, u.alpha);
      })();
      mat.fog = false; mat.toneMapped = false;
      e = { mat, u, sig };
      cache.set(o, e); made.add(mat);
    }
    if (cut) e.u.cutRef.value = m0.alphaTest > 0 ? m0.alphaTest : 0.5;
    return e;
  }

  function render(scene, camera, target) {
    const swaps = [], groups = new Map(), patched = new Map(), cbs = [];
    const guard = o => {
      const f = o.onBeforeRender;
      if (f === THREE.Object3D.prototype.onBeforeRender) return;
      cbs.push([o, f]); o.onBeforeRender = function (...a) { try { f.apply(this, a); } catch { /* ID 图期间忽略原材质 uniform 写入 */ } };
    };
    // soft / own 挡线：沿用物体自己的材质，只改混合（soft 只写 alpha 遮挡，own 整体写 0）
    const patch = (m, soft) => {
      if (patched.has(m)) return;
      const save = {}; for (const k of BLEND_KEYS) save[k] = m[k];
      patched.set(m, save);
      m.blending = THREE.CustomBlending; m.blendEquation = m.blendEquationAlpha = THREE.AddEquation;
      if (soft) { m.blendSrc = THREE.ZeroFactor; m.blendDst = THREE.OneFactor; m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor; m.depthWrite = false; }
      else { m.blendSrc = m.blendDst = m.blendSrcAlpha = m.blendDstAlpha = THREE.ZeroFactor; }
    };
    let nextId = 1, maxWidth = 0;
    const drawn = m => !!m && m.visible !== false;
    const inId = m => drawn(m) && m.userData?.noId !== true;
    const hide = o => { swaps.push([o, o.material]); o.material = HIDE; };
    const checkMesh = (o, ov) => {
      if (o.isBatchedMesh) throw unsupported(o, 'BatchedMesh');
      if (Array.isArray(o.material)) throw unsupported(o, '多材质数组');
      if (ov && !ov.tsl) throw unsupported(o, 'outlineVertex 只有 GLSL 版，未提供 tsl 节点');
    };
    const swapIn = (o, e, baseId, perInstance, wmul, alpha) => {
      e.u.baseId.value = baseId; e.u.perInstance.value = perInstance;
      e.u.width.value = wmul; e.u.alpha.value = alpha;
      swaps.push([o, o.material]); o.material = e.mat;
      guard(o);
    };
    const visit = (o, inh) => {
      if (!o.visible) return;
      const u = o.userData;
      const st = {
        outline: u.outline ?? inh.outline, width: u.outlineWidth ?? inh.width, alpha: u.outlineAlpha ?? inh.alpha,
        occ: u.outlineOccluder ?? inh.occ, per: u.outlinePerInstance ?? inh.per, ov: u.outlineVertex ?? inh.ov,
        grp: u.outlineGroup ?? inh.grp,
      };
      const mats = (o.isMesh || o.isSprite || o.isPoints || o.isLine) ? (Array.isArray(o.material) ? o.material : [o.material]) : null;
      const shown = mats ? mats.filter(inId) : [];
      if (shown.length) {
        const m0 = shown[0];
        if (st.outline === true && o.isMesh) {
          checkMesh(o, st.ov);
          let baseId, perInst = 0;
          if (st.grp !== undefined && st.grp !== null) {   // 同组共用一个 ID：组内部件之间不出线
            if (!groups.has(st.grp)) groups.set(st.grp, nextId++);
            baseId = groups.get(st.grp);
          } else {
            const n = o.isInstancedMesh && st.per !== false ? o.count : 1;
            baseId = nextId; perInst = n > 1 ? 1 : 0; nextId += Math.max(1, n);
          }
          const wmul = st.width ?? 1; maxWidth = Math.max(maxWidth, wmul);
          swapIn(o, idMaterialFor(o, m0, st.ov), baseId, perInst, wmul, (st.alpha ?? 1) * (m0.transparent ? m0.opacity : 1));
        } else {
          let mode = st.occ ?? 'auto';
          if (mode === 'auto') {
            if (o.isPoints || o.isLine || shown.every(m => m.blending === THREE.AdditiveBlending || m.blending === THREE.MultiplyBlending || m.colorWrite === false)) mode = false;
            else if (o.isSprite || shown.some(m => m.transparent)) mode = 'soft';
            else if (shown.some(m => m.isShaderMaterial)) mode = 'own';
            else mode = 'solid';
          }
          if (mode === false || ((o.isPoints || o.isLine) && mode !== 'soft')) hide(o);
          else if (mode === 'soft' || mode === 'own') {
            if (Array.isArray(o.material)) throw unsupported(o, `多材质数组的 ${mode} 遮挡`);
            patch(o.material, mode === 'soft');
          }
          else if (!o.isMesh) hide(o);
          else { checkMesh(o, st.ov); swapIn(o, idMaterialFor(o, m0, st.ov), 0, 0, 0, 0); }   // solid：ID = 0、实心挡线
        }
      } else if (mats && mats.some(drawn)) hide(o);   // 画得出来的材质全是 noId：本物体不描边不挡线，子物体照常
      for (const c of o.children) visit(c, st);
    };

    const prevTarget = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    const bg = scene.background, sm = renderer.shadowMap.autoUpdate;
    try {
      visit(scene, { outline: undefined, width: 1, alpha: 1, occ: undefined, per: true, ov: undefined, grp: undefined });
      scene.background = null; renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0); renderer.clear(true, true, true);
      renderer.render(scene, camera);
    } finally {
      for (let i = swaps.length - 1; i >= 0; i--) swaps[i][0].material = swaps[i][1];
      for (const [o, f] of cbs) o.onBeforeRender = f;
      for (const [m, save] of patched) Object.assign(m, save);
      scene.background = bg; renderer.shadowMap.autoUpdate = sm;
      renderer.setClearColor(prevClear, prevAlpha); renderer.setRenderTarget(prevTarget);
    }
    return maxWidth;
  }

  function dispose() { for (const m of made) m.dispose(); made.clear(); HIDE.dispose(); }

  return { render, dispose };
}
