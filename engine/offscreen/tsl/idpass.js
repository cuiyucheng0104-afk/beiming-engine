// 北冥引擎 · 离屏出片 · 物体 ID 通道（TSL）：engine/look/ids.js 的子集。按 userData 开关把场景临时换成 ID 材质渲一遍，供屏幕空间墨线做边缘检测。
// 输出 RGBA = (id 低 11 位, id 高位, 线宽系数, 线可见度)，HalfFloat 能精确存 0..2048 的整数，与 GLSL 版同一编码。
//
//   createIdPass({ THREE, TSL, renderer }) → { render(scene, camera, target) → 场景里最大的线宽系数（没有描边物体时为 0）, dispose() }
//   target：THREE.RenderTarget，HalfFloat、Nearest、带 DepthTexture（墨线用它做深度检测；FloatType 与 GLSL 版同精度）。渲完还原渲染目标、清屏色与场景背景。
//
// 支持的开关（userData，子物体继承父物体，显式写了以子物体为准）：outline、outlineWidth、outlineAlpha、outlineGroup、
//   outlineOccluder（'auto' | 'solid' | 'soft' | 'own' | false）：soft = 用物体自己的材质、只按自身 alpha 削减线的可见度（不写深度）；own = 用自己的材质实心挡线（全写 0）。
//   auto 的判法同 GLSL 版：Points / Line / 加色 / 正片叠底 / colorWrite = false → 不挡；Sprite 或半透明 → soft；ShaderMaterial → own；其它 → solid。
// 材质上 userData.noId = true：这个物体不进 ID 图（不描边也不挡线）。
// 不在这一版的（M2 范围裁定）：遇到就抛 Error(code 'unsupported.outline')，不静默画错——
//   InstancedMesh / SkinnedMesh / BatchedMesh / 变形目标、多材质数组、带贴图 alpha 镂空（alphaTest / transparent + map）、
//   描边物体的材质自带顶点位移（positionNode）、outlineVertex、outlinePerInstance；soft / own 物体的多材质数组。
// soft / own 沿用物体自己的材质，只临时改混合（同 GLSL 版的 patch；渲完逐项还原），不处理材质自带 onBeforeRender 把混合改回去的情况。
// 主渲染里看不见的东西这里也没有：visible = false 的物体与材质原样留着；不挡线的物体（Points / Line / 加色 / 正片叠底 / colorWrite = false）换成不可见材质跳过，子物体照常参与。

export function createIdPass({ THREE, TSL, renderer }) {
  const { uniform } = TSL;
  const cache = new WeakMap();   // 物体 → { mat, v, side }：同一个物体复用同一个 ID 材质
  const made = new Set();
  const HIDE = new THREE.MeshBasicNodeMaterial({ visible: false });

  const BLEND_KEYS = ['blending', 'blendSrc', 'blendDst', 'blendEquation', 'blendSrcAlpha', 'blendDstAlpha', 'blendEquationAlpha', 'depthWrite'];
  const unsupported = (o, what) => Object.assign(new Error(`离屏墨线 ID 通道未支持：${what}（物体 ${o.name || o.type}）。M2 只覆盖不透明 Mesh 与 outline / outlineWidth / outlineAlpha / outlineGroup / 实心遮挡`), { code: 'unsupported.outline' });

  function idMaterialFor(o, side) {
    let e = cache.get(o);
    if (!e || e.side !== side) {
      if (e) { e.mat.dispose(); made.delete(e.mat); }
      const v = uniform(new THREE.Vector4());
      const mat = new THREE.MeshBasicNodeMaterial({ side });
      mat.fragmentNode = v;
      mat.fog = false; mat.toneMapped = false;
      e = { mat, v, side };
      cache.set(o, e); made.add(mat);
    }
    return e;
  }

  function render(scene, camera, target) {
    const swaps = [], groups = new Map(), patched = new Map();
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
    const plain = o => {
      if (o.isInstancedMesh || o.isSkinnedMesh || o.isBatchedMesh || o.morphTargetInfluences?.length) throw unsupported(o, 'InstancedMesh / SkinnedMesh / BatchedMesh / 变形目标');
    };
    const swapIn = (o, m0, e, vec) => {
      if (Array.isArray(o.material)) throw unsupported(o, '多材质数组');
      if (m0.positionNode) throw unsupported(o, '材质自带顶点位移（positionNode）');
      if (m0.map && (m0.alphaTest > 0 || m0.transparent)) throw unsupported(o, '带贴图的 alpha 镂空');
      e.v.value.set(...vec);
      swaps.push([o, o.material]); o.material = e.mat;
    };
    const visit = (o, inh) => {
      if (!o.visible) return;
      const u = o.userData;
      const st = {
        outline: u.outline ?? inh.outline, width: u.outlineWidth ?? inh.width, alpha: u.outlineAlpha ?? inh.alpha,
        occ: u.outlineOccluder ?? inh.occ, grp: u.outlineGroup ?? inh.grp,
      };
      if (u.outlineVertex || u.outlinePerInstance === false) throw unsupported(o, 'outlineVertex / outlinePerInstance');
      const mats = (o.isMesh || o.isSprite || o.isPoints || o.isLine) ? (Array.isArray(o.material) ? o.material : [o.material]) : null;
      const shown = mats ? mats.filter(inId) : [];
      if (shown.length) {
        const m0 = shown[0];
        if (st.outline === true && o.isMesh) {
          plain(o);
          let base;
          if (st.grp !== undefined && st.grp !== null) {   // 同组共用一个 ID：组内部件之间不出线
            if (!groups.has(st.grp)) groups.set(st.grp, nextId++);
            base = groups.get(st.grp);
          } else base = nextId++;
          const wmul = st.width ?? 1; maxWidth = Math.max(maxWidth, wmul);
          swapIn(o, m0, idMaterialFor(o, m0.side), [base % 2048, Math.floor(base / 2048), wmul, (st.alpha ?? 1) * (m0.transparent ? m0.opacity : 1)]);
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
          else { plain(o); swapIn(o, m0, idMaterialFor(o, m0.side), [0, 0, 0, 0]); }   // solid：ID = 0、实心挡线
        }
      } else if (mats && mats.some(drawn)) hide(o);   // 画得出来的材质全是 noId：本物体不描边不挡线，子物体照常
      for (const c of o.children) visit(c, st);
    };

    const prevTarget = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    const bg = scene.background, sm = renderer.shadowMap.autoUpdate;
    try {
      visit(scene, { outline: undefined, width: 1, alpha: 1, occ: undefined, grp: undefined });
      scene.background = null; renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0); renderer.clear(true, true, true);
      renderer.render(scene, camera);
    } finally {
      for (let i = swaps.length - 1; i >= 0; i--) swaps[i][0].material = swaps[i][1];
      for (const [m, save] of patched) Object.assign(m, save);
      scene.background = bg; renderer.shadowMap.autoUpdate = sm;
      renderer.setClearColor(prevClear, prevAlpha); renderer.setRenderTarget(prevTarget);
    }
    return maxWidth;
  }

  function dispose() { for (const m of made) m.dispose(); made.clear(); HIDE.dispose(); }

  return { render, dispose };
}
