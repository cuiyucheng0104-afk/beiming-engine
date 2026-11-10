// 北冥引擎 · 物体 / 实例 ID 通道：把场景按 userData 开关临时换成 ID 材质渲一遍，供屏幕空间墨线做边缘检测。
// 输出 RGBA = (id 低 11 位, id 高位, 线宽系数, 线可见度)。HalfFloat 能精确存 0..2048 的整数，拆两段可放 400 万个 ID。
// 顶点着色器用 three 自带的 chunk（<begin_vertex>/<project_vertex>），所以 InstancedMesh、蒙皮、变形都对得上。
//
//   createIdPass(renderer) → { render(scene, camera, target) → 场景里最大的线宽系数（没有描边物体时为 0），dispose() }
//   target 要带 DepthTexture（墨线的深度检测用它），建议 Nearest 过滤、无 MSAA。dispose 释放缓存的全部 ID 材质。
//
// 物体上的开关（userData，子物体继承父物体，子物体显式写了就以子物体为准）：
//   outline: true            只有它为 true 的 Mesh / InstancedMesh 才描边；底板面片不要设
//   outlineWidth: 1          线宽系数
//   outlineAlpha: 1          线的不透明度系数（透明材质再乘自身 opacity）
//   outlinePerInstance: true InstancedMesh 默认每个实例一个 ID；false = 整个 InstancedMesh 共用一个 ID
//   outlineGroup: 'body'     同组的物体共用一个 ID，组内部件相接处不出线（只留外轮廓和深度折痕）
//   outlineOccluder: 'auto'  不描边物体怎么挡线：'auto' | 'solid'(实心挡) | 'soft'(按自身 alpha 半挡) | 'own'(用自身材质实心挡) | false(不挡)
//                            auto：透明材质 → soft；加色 / 正片叠底 / Points / Line → 不挡；ShaderMaterial → own；其它 → solid
//   outlineVertex: { head, body, uniforms }  描边物体如果在自己的材质里做了顶点位移，把同样的 GLSL 交给 ID 图
//                            （head 放在 main 之前，body 放在 #include <begin_vertex> 之后，改 transformed）
// 带贴图且 alphaTest / transparent 的材质按贴图 alpha 镂空。渲 ID 图期间物体的 onBeforeRender 出错会被吞掉
// （它可能去改自己材质的 uniform，而此刻挂着的是 ID 材质）；'soft' / 'own' 沿用的材质若自带 onBeforeRender（例如按通道切混合），
// 回调之后会重新套上挡线混合。
// 主渲染里看不见的东西 ID 图里也没有：材质 visible = false 的物体原样留着（three 自己跳过），多材质时不可见的那几组照样不画；
// 不挡线的物体换成一个不可见材质跳过，子物体照常参与。
//
// 材质上的开关（material.userData，不继承）：
//   noId: true               用这个材质画的网格不进 ID 图：不描边也不挡线（多材质时只是这一组）。只管用它画的这一份，
//                            不改物体 userData，子物体仍按上面的继承规则照常描边 / 挡线，和卡通材质旧通道里 TOON_NO_ID 的 discard
//                            作用范围一致（engine/shade/toon.js 的 noId 材质自动带上它）。

import * as THREE from 'three';

function idVertexShader(head = '', body = '') {
  return /* glsl */`
#include <common>
#include <batching_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
uniform float uBaseId, uPerInstance;
uniform mat3 uCutTransform;
flat varying float vId;
varying vec2 vCutUv;
${head}
void main(){
  #include <batching_vertex>
  #include <skinbase_vertex>
  #include <morphinstance_vertex>
  #include <begin_vertex>
  ${body}
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  #ifdef USE_INSTANCING
    vId = uBaseId + uPerInstance * float(gl_InstanceID);
  #else
    vId = uBaseId;
  #endif
  vCutUv = (uCutTransform * vec3(uv, 1.)).xy;
}`;
}
const ID_FS = /* glsl */`
uniform float uWidth, uAlpha;
uniform sampler2D uCutMap; uniform float uCutRef;
flat varying float vId;
varying vec2 vCutUv;
void main(){
  #ifdef CUTOUT
    if (texture2D(uCutMap, vCutUv).a < uCutRef) discard;
  #endif
  gl_FragColor = vec4(mod(vId, 2048.), floor(vId / 2048.), uWidth, uAlpha);
}`;

const BLEND_KEYS = ['blending', 'blendSrc', 'blendDst', 'blendEquation', 'blendSrcAlpha', 'blendDstAlpha', 'blendEquationAlpha', 'depthWrite'];
const IDENT3 = new THREE.Matrix3();

export function createIdPass(renderer) {
  let cache = new WeakMap();     // 物体 → { mat, sig }：签名不变就复用
  const made = new Set();        // 建过的 ID 材质（WeakMap 不能遍历），dispose 时逐个释放
  const HIDE = new THREE.MeshBasicMaterial({ visible: false });   // 不挡线的物体换上它：本身不画，子物体照常
  function idMaterialFor(o, m0, ov, occluder) {
    const cut = !!(m0 && m0.map && (m0.alphaTest > 0 || m0.transparent));
    const side = m0 ? m0.side : THREE.FrontSide;
    const sig = `${cut ? m0.map.uuid : ''}|${side}|${occluder}|${ov ? ov.head + ov.body : ''}`;
    let e = cache.get(o);
    if (!e || e.sig !== sig) {
      if (e) { e.mat.dispose(); made.delete(e.mat); }
      const m = new THREE.ShaderMaterial({
        vertexShader: idVertexShader(ov?.head, ov?.body), fragmentShader: ID_FS,
        uniforms: { uBaseId: { value: 0 }, uPerInstance: { value: 0 }, uWidth: { value: 1 }, uAlpha: { value: 1 },
          uCutMap: { value: cut ? m0.map : null }, uCutRef: { value: cut ? (m0.alphaTest > 0 ? m0.alphaTest : .5) : 0 }, uCutTransform: { value: new THREE.Matrix3() },
          ...(ov?.uniforms || {}) },
        defines: cut ? { CUTOUT: '' } : {}, side,
      });
      e = { mat: m, sig }; cache.set(o, e); made.add(m);
    }
    if (cut) { if (m0.map.matrixAutoUpdate) m0.map.updateMatrix(); e.mat.uniforms.uCutTransform.value.copy(m0.map.matrix); }
    else e.mat.uniforms.uCutTransform.value.copy(IDENT3);
    return e.mat;
  }

  function render(scene, camera, target) {
    const swaps = [], patched = new Map(), groups = new Map(), cbs = [], mcbs = [];
    const guard = o => {
      const f = o.onBeforeRender;
      if (f === THREE.Object3D.prototype.onBeforeRender) return;
      cbs.push([o, f]); o.onBeforeRender = function (...a) { try { f.apply(this, a); } catch (e) { /* ID 图里忽略 */ } };
    };
    let nextId = 1, maxWidth = 0;
    // 'soft' / 'own' 挡线：沿用物体自己的材质，只改混合（soft 只写 alpha 遮挡，own 整体写 0）
    const patch = (m, soft) => {
      if (patched.has(m)) return;
      const save = {}; for (const k of BLEND_KEYS) save[k] = m[k];
      patched.set(m, save);
      const apply = () => {
        m.blending = THREE.CustomBlending; m.blendEquation = m.blendEquationAlpha = THREE.AddEquation;
        if (soft) { m.blendSrc = THREE.ZeroFactor; m.blendDst = THREE.OneFactor; m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor; m.depthWrite = false; }
        else { m.blendSrc = m.blendDst = m.blendSrcAlpha = m.blendDstAlpha = THREE.ZeroFactor; }
      };
      apply();
      // 材质自己的 onBeforeRender 在 three 里紧挨着绘制调用，可能把混合改回去（如 toon.js 的 translucent）：回调之后再套一次
      const f = m.onBeforeRender;
      if (f !== THREE.Material.prototype.onBeforeRender) { mcbs.push([m, f]); m.onBeforeRender = function (...a) { f.apply(this, a); apply(); }; }
    };
    const hide = o => { swaps.push([o, o.material]); o.material = HIDE; };
    const drawn = m => !!m && m.visible !== false;              // 主渲染会画的材质（组）
    const inId = m => drawn(m) && m.userData?.noId !== true;    // 其中进 ID 图的：noId 只管用它画的这一组，不传给子物体
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
      if (shown.length) {   // 有要进 ID 图的材质（组）才处理；材质全不可见的物体原样留着（主渲染和 ID 图里 three 都跳过它）
        const m0 = shown[0];
        // 换材质：进 ID 图的组换成 m（null = 沿用自身材质），noId 的组换成不可见材质，主渲染本来就不画的组保持不画
        const swapIn = m => {
          swaps.push([o, o.material]);
          o.material = Array.isArray(o.material) ? o.material.map(x => inId(x) ? (m || x) : drawn(x) ? HIDE : x) : (m || o.material);
          guard(o);
        };
        if (st.outline === true && o.isMesh) {
          const m = idMaterialFor(o, m0, st.ov, false);
          if (st.grp !== undefined && st.grp !== null) {   // 同组共用一个 ID：组内部件之间不出线
            if (!groups.has(st.grp)) groups.set(st.grp, nextId++);
            m.uniforms.uBaseId.value = groups.get(st.grp); m.uniforms.uPerInstance.value = 0;
          } else {
            const n = o.isInstancedMesh && st.per !== false ? o.count : 1;
            m.uniforms.uBaseId.value = nextId; m.uniforms.uPerInstance.value = n > 1 ? 1 : 0; nextId += Math.max(1, n);
          }
          const wmul = st.width ?? 1; maxWidth = Math.max(maxWidth, wmul);
          m.uniforms.uWidth.value = wmul;
          m.uniforms.uAlpha.value = (st.alpha ?? 1) * (m0 && m0.transparent ? m0.opacity : 1);
          swapIn(m);
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
            for (const m of shown) patch(m, mode === 'soft');
            if (shown.length < mats.filter(drawn).length) swapIn(null);   // 多材质里 noId 的那几组：本组不画
          }
          else if (o.isMesh) {   // solid：ID=0、实心挡线
            const m = idMaterialFor(o, m0, st.ov, true);
            m.uniforms.uBaseId.value = 0; m.uniforms.uPerInstance.value = 0; m.uniforms.uWidth.value = 0; m.uniforms.uAlpha.value = 0;
            swapIn(m);
          } else hide(o);
        }
      } else if (mats && mats.some(drawn)) hide(o);   // 画得出来的材质全是 noId：本物体不描边、不挡线；子物体照常按 userData 继承
      for (const c of o.children) visit(c, st);
    };
    visit(scene, { outline: undefined, width: 1, alpha: 1, occ: undefined, per: true, ov: undefined, grp: undefined });

    const bg = scene.background, sm = renderer.shadowMap.autoUpdate;
    scene.background = null; renderer.shadowMap.autoUpdate = false;
    try {
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0); renderer.clear(true, true, true);
      renderer.render(scene, camera);
    } finally {
      for (let i = swaps.length - 1; i >= 0; i--) swaps[i][0].material = swaps[i][1];
      for (const [o, f] of cbs) o.onBeforeRender = f;
      for (const [m, f] of mcbs) m.onBeforeRender = f;
      for (const [m, save] of patched) Object.assign(m, save);
      scene.background = bg; renderer.shadowMap.autoUpdate = sm;
    }
    return maxWidth;
  }

  function dispose() { for (const m of made) m.dispose(); made.clear(); cache = new WeakMap(); HIDE.dispose(); }

  return { render, dispose };
}
