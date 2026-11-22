// 北冥引擎 · 离屏出片 · 物体 / 实例 ID 通道（TSL）：engine/look/ids.js 的对应。按 userData 开关把场景临时换成 ID 材质渲一遍，供屏幕空间墨线做边缘检测。
// 输出 RGBA = (id 低 11 位, id 高位, 线宽系数, 线可见度)，HalfFloat 能精确存 0..2048 的整数，拆两段可放 400 万个 ID，与 GLSL 版同一编码。
//
//   createIdPass({ THREE, TSL, renderer }) → { render(scene, camera, target) → 最大线宽, renderMrt(scene, camera, target) → 预填 ID 源或 null, dispose() }
//   target：HalfFloat、Nearest、带 FloatType DepthTexture。renderMrt 要求 target 为 output + inkId 双附件；满足严格条件时主场景同遍写 ID，否则返回 null、由调用方走原双遍。
//
// 支持的开关（userData，子物体继承父物体，显式写了以子物体为准）：
//   outline、outlineWidth、outlineAlpha、outlineGroup、outlinePerInstance（InstancedMesh 默认 true = 逐实例分配连续 ID；false = 共用一个 ID）、
//   outlineVertex: { tsl: node | ({ THREE, TSL }) => node }（描边物体的自定义顶点位移节点；若材质自带 positionNode 也会自动继承）、
//   outlineOccluder（'auto' | 'solid' | 'soft' | 'own' | false）：soft = 用物体自己的材质、只按自身 alpha 削减线的可见度（不写深度）；own = 用自己的材质实心挡线（全写 0）。
//   材质带 map 且设了 alphaTest 或 transparent 时，按贴图 alpha 镂空（阈值 alphaTest > 0 ? alphaTest : 0.5）；MeshBasicNodeMaterial 原生处理 InstancedMesh、SkinnedMesh 与变形目标。
//   材质上 userData.noId = true：这个物体不进 ID 图（不描边也不挡线）。
// 不支持（遇到抛 Error(code 'unsupported.outline')，不静默画错）：BatchedMesh、多材质数组、只给 GLSL 字符串没给 tsl 的 outlineVertex。
// MRT 只接受不透明、写深度的 toonKind 网格；soft/own、自定义 outlineVertex、noId 与其他材质一律回退，避免共享深度改变遮挡语义。

export function createIdPass({ THREE, TSL, renderer }) {
  const { Fn, If, Discard, uniform, texture, float, vec4, floor, instanceIndex, mrt, output } = TSL;
  const cache = new WeakMap();   // 物体 → { mat, u, sig }：签名不变就复用同一个 ID 材质
  const mrtCache = new WeakMap();  // 主材质 → 共用 MRT ID 节点；逐物体 ID 在 onBeforeRender 写 uniform
  const objKey = new WeakMap();
  let seq = 1;
  const keyOf = x => { if (!x) return 0; if (!objKey.has(x)) objKey.set(x, seq++); return objKey.get(x); };
  const made = new Set();
  const HIDE = new THREE.MeshBasicNodeMaterial({ visible: false });
  const sceneMrt = mrt({ output, inkId: vec4(0) }).setClearColor('inkId', 0x000000, 0);

  const BLEND_KEYS = ['blending', 'blendSrc', 'blendDst', 'blendEquation', 'blendSrcAlpha', 'blendDstAlpha', 'blendEquationAlpha', 'depthWrite'];
  const unsupported = (o, what) => Object.assign(new Error(`离屏墨线 ID 通道未支持：${what}（物体 ${o.name || o.type}）`), { code: 'unsupported.outline' });
  const drawn = m => !!m && m.visible !== false;
  const inId = m => drawn(m) && m.userData?.noId !== true;

  function idNode(u, inst) {
    const vId = inst ? u.baseId.add(u.perInstance.mul(float(instanceIndex))) : u.baseId;
    const hi = floor(vId.div(2048));
    return vec4(vId.sub(hi.mul(2048)), hi, u.width, u.alpha);
  }
  const setId = (e, baseId, perInstance, wmul, alpha) => {
    e.u.baseId.value = baseId; e.u.perInstance.value = perInstance; e.u.width.value = wmul; e.u.alpha.value = alpha;
  };

  function idMaterialFor(o, m0, ov) {
    const side = m0 ? m0.side : THREE.FrontSide;
    const cut = !!(m0 && m0.map && (m0.alphaTest > 0 || m0.transparent));
    const inst = !!o.isInstancedMesh;
    const posInit = m0?.toonPosInit ?? null;
    const posSrc = ov ? ov.tsl : (m0?.positionNode ?? null);
    const sig = `${side}|${inst ? 1 : 0}|${cut ? m0.map.uuid : ''}|${keyOf(posSrc)}|${keyOf(posInit)}`;
    let e = cache.get(o);
    if (!e || e.sig !== sig) {
      if (e) { e.mat.dispose(); made.delete(e.mat); }
      const u = { baseId: uniform(0), perInstance: uniform(0), width: uniform(1), alpha: uniform(1), cutRef: uniform(0.5) };
      class IdNodeMaterial extends THREE.MeshBasicNodeMaterial {
        setupPosition(builder) {
          if (posInit) TSL.positionLocal.assign(posInit);
          return super.setupPosition(builder);
        }
      }
      const mat = posInit ? new IdNodeMaterial({ side }) : new THREE.MeshBasicNodeMaterial({ side });
      if (posSrc) mat.positionNode = typeof posSrc === 'function' ? posSrc({ THREE, TSL }) : posSrc;
      mat.fragmentNode = Fn(() => {
        if (cut) If(texture(m0.map).a.lessThan(u.cutRef), () => { Discard(); });
        return idNode(u, inst);
      })();
      mat.fog = false; mat.toneMapped = false;
      e = { mat, u, sig };
      cache.set(o, e); made.add(mat);
    }
    if (m0.map && (m0.alphaTest > 0 || m0.transparent)) e.u.cutRef.value = m0.alphaTest > 0 ? m0.alphaTest : 0.5;
    return e;
  }

  function mrtIdFor(m0) {
    let e = mrtCache.get(m0);
    if (!e) {
      const u = { baseId: uniform(0), perInstance: uniform(0), width: uniform(1), alpha: uniform(1) };
      e = { u, node: mrt({ inkId: Fn(() => idNode(u, true))() }) };
      mrtCache.set(m0, e);
    }
    return e;
  }

  const checkMesh = (o, ov) => {
    if (o.isBatchedMesh) throw unsupported(o, 'BatchedMesh');
    if (Array.isArray(o.material)) throw unsupported(o, '多材质数组');
    if (ov && !ov.tsl) throw unsupported(o, 'outlineVertex 只有 GLSL 版，未提供 tsl 节点');
  };

  function collect(scene) {
    const entries = [], groups = new Map();
    let nextId = 1, maxWidth = 0;
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
          if (st.grp !== undefined && st.grp !== null) {
            if (!groups.has(st.grp)) groups.set(st.grp, nextId++);
            baseId = groups.get(st.grp);
          } else {
            const n = o.isInstancedMesh && st.per !== false ? o.count : 1;
            baseId = nextId; perInst = n > 1 ? 1 : 0; nextId += Math.max(1, n);
          }
          const wmul = st.width ?? 1; maxWidth = Math.max(maxWidth, wmul);
          entries.push({ mode: 'outline', o, m0, ov: st.ov, baseId, perInst, wmul, alpha: (st.alpha ?? 1) * (m0.transparent ? m0.opacity : 1) });
        } else {
          let mode = st.occ ?? 'auto';
          if (mode === 'auto') {
            if (o.isPoints || o.isLine || shown.every(m => m.blending === THREE.AdditiveBlending || m.blending === THREE.MultiplyBlending || m.colorWrite === false)) mode = false;
            else if (o.isSprite || shown.some(m => m.transparent)) mode = 'soft';
            else if (shown.some(m => m.isShaderMaterial)) mode = 'own';
            else mode = 'solid';
          }
          if (mode === false || ((o.isPoints || o.isLine) && mode !== 'soft')) entries.push({ mode: 'hide', o });
          else if (mode === 'soft' || mode === 'own') {
            if (Array.isArray(o.material)) throw unsupported(o, `多材质数组的 ${mode} 遮挡`);
            entries.push({ mode, o, m0 });
          } else if (!o.isMesh) entries.push({ mode: 'hide', o });
          else {
            checkMesh(o, st.ov);
            entries.push({ mode: 'solid', o, m0, ov: st.ov, baseId: 0, perInst: 0, wmul: 0, alpha: 0 });
          }
        }
      } else if (mats && mats.some(drawn)) entries.push({ mode: 'hide', o });
      for (const c of o.children) visit(c, st);
    };
    visit(scene, { outline: undefined, width: 1, alpha: 1, occ: undefined, per: true, ov: undefined, grp: undefined });
    return { entries, maxWidth };
  }

  function render(scene, camera, target) {
    const swaps = [], patched = new Map(), cbs = [];
    const guard = o => {
      const f = o.onBeforeRender;
      if (f === THREE.Object3D.prototype.onBeforeRender) return;
      cbs.push([o, f]); o.onBeforeRender = function (...a) { try { f.apply(this, a); } catch { /* ID 图期间忽略原材质 uniform 写入 */ } };
    };
    const patch = (m, soft) => {
      if (patched.has(m)) return;
      const save = {}; for (const k of BLEND_KEYS) save[k] = m[k];
      patched.set(m, save);
      m.blending = THREE.CustomBlending; m.blendEquation = m.blendEquationAlpha = THREE.AddEquation;
      if (soft) { m.blendSrc = THREE.ZeroFactor; m.blendDst = THREE.OneFactor; m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor; m.depthWrite = false; }
      else { m.blendSrc = m.blendDst = m.blendSrcAlpha = m.blendDstAlpha = THREE.ZeroFactor; }
    };
    const { entries, maxWidth } = collect(scene);
    const prevTarget = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    const bg = scene.background, sm = renderer.shadowMap.autoUpdate;
    try {
      for (const e of entries) {
        if (e.mode === 'hide') { swaps.push([e.o, e.o.material]); e.o.material = HIDE; continue; }
        if (e.mode === 'soft' || e.mode === 'own') { patch(e.o.material, e.mode === 'soft'); continue; }
        const id = idMaterialFor(e.o, e.m0, e.ov);
        setId(id, e.baseId, e.perInst, e.wmul, e.alpha);
        swaps.push([e.o, e.o.material]); e.o.material = id.mat;
        guard(e.o);
      }
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

  function renderMrt(scene, camera, target) {
    const { entries, maxWidth } = collect(scene);
    const eligible = entries.every(e => (e.mode === 'outline' || e.mode === 'solid') && !e.ov && e.o.isMesh &&
      e.m0?.isToonTslMaterial === true && !e.m0.transparent && e.m0.depthWrite && e.m0.colorWrite && e.m0.mrtNode == null);
    if (!eligible) return null;
    const prevTarget = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha(), prevMrt = renderer.getMRT();
    const materials = [], callbacks = [];
    try {
      for (const e of entries) {
        const id = mrtIdFor(e.m0), original = e.o.onBeforeRender;
        if (!materials.some(x => x[0] === e.m0)) materials.push([e.m0, e.m0.mrtNode]);
        e.m0.mrtNode = id.node;
        callbacks.push([e.o, original]);
        e.o.onBeforeRender = function (...a) { original.apply(this, a); setId(id, e.baseId, e.perInst, e.wmul, e.alpha); };
      }
      renderer.setMRT(sceneMrt); renderer.setRenderTarget(target);
      renderer.clear(true, true, true); renderer.render(scene, camera);
    } finally {
      for (let i = callbacks.length - 1; i >= 0; i--) callbacks[i][0].onBeforeRender = callbacks[i][1];
      for (const [m, node] of materials) m.mrtNode = node;
      renderer.setMRT(prevMrt); renderer.setClearColor(prevClear, prevAlpha); renderer.setRenderTarget(prevTarget);
    }
    return { maxWidth, texture: target.textures[1], depthTexture: target.depthTexture };
  }

  function renderScene(scene, camera, target, allowMrt = true) {
    if (allowMrt) {
      const prepared = renderMrt(scene, camera, target);
      if (prepared) return prepared;
    }
    const prevTarget = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha(), prevMrt = renderer.getMRT();
    try {
      renderer.setMRT(sceneMrt); renderer.setRenderTarget(target);
      renderer.clear(true, true, true); renderer.render(scene, camera);
    } finally {
      renderer.setMRT(prevMrt); renderer.setClearColor(prevClear, prevAlpha); renderer.setRenderTarget(prevTarget);
    }
    return null;
  }

  function dispose() { for (const m of made) m.dispose(); made.clear(); HIDE.dispose(); }

  return { render, renderMrt, renderScene, dispose };
}
