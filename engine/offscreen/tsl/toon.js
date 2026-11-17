// 北冥引擎 · 离屏出片 · 三档卡通材质（TSL）：engine/shade/toon.js 的对应。参数表（TOON_BASE）、乘法色调（tintFrom）、
// 共享状态的写法（setToonShared）直接用 GLSL 版导出的，光照合成逐式照搬 shadeGlsl。作品同一份 opts 交给两边。
//
//   makeToonShared({ THREE, TSL }, init) → shared   与 GLSL 版同名的 uniform 节点（uInkTime、uExposure、uFillDirW…）；setToonShared(S, g) 两边通用
//   toonKind({ THREE, TSL }, spec) → { make(opts), bind(mesh, mat, opts), shared }
//     spec：name、shared、firstId、defaults、featherMin、bandAA、skyStepUniform、rimCore、layers（TSL 表面层，见 surface.js 的 TSL 版）
//     make(opts)：TOON_BASE 里的任意键；材质钩子给 TSL 版 opts.tsl = { fragmentBase(c), fragmentAlbedo(c), uniforms }：
//       c = { THREE, TSL, diffuse（vec3 可写）, base（vec3，fragmentBase 之后的固有色）, ink（float 可写）, overlay（vec4 可写）,
//             obj（物体空间坐标，同 vToonObj）, u（本材质的 uniform 节点，含 opts.tsl.uniforms）, noise: { hash33, noise, fbm } }
//       opts 里有 GLSL 钩子（vertexBegin、fragmentAlbedo…）却没给 opts.tsl：抛 unsupported.toon（不静默少画皴线）
//   mat.userData.toon：与 GLSL 版同名的 uniform 节点，运行时照样 u.uRimLitAmt.value = …
// 主光：第一盏投影的平行光（没有投影光就取第一盏平行光；都没有用 uKeyDirW），与 r170 的灯光排序一致；只取方向与投影，颜色全按参数绝对给定。
// 投影：主光要先 useR170Shadow(TSL, light)，滤波与 r170 的 PCFSoftShadowMap 同式；量化 smoothstep(shadowLo, shadowHi) 在材质里做，
//   只在 light.shadow.intensity = 1 时与 GLSL 版相同（不是 1 抛错）。环境光、半球光不进卡通合成（GLSL 版也不进）。
// 不支持（抛 Error，code unsupported.toon）：InstancedMesh、translucent / transparent、map、vertexColors、rest、outlineVertex、
//   defines、spec.shade / pars / glsl / vars / uniforms（GLSL 的插桩钩子）。
import { TOON_BASE, tintFrom, setToonShared } from '../../shade/toon.js';
import { colorOf, vec3Of } from '../../shade/patch.js';

export { setToonShared, TOON_BASE };
const unsupported = msg => Object.assign(new Error(`离屏卡通材质未支持：${msg}`), { code: 'unsupported.toon' });
const GLSL_HOOKS = ['vertexPars', 'vertexMainStart', 'vertexBegin', 'vertexNormal', 'fragmentPars', 'fragmentBase', 'fragmentAlbedo', 'fragmentNormal'];

// 与 engine/shade/noise.glsl.js 逐式相同：toonHash33（Hash without Sine，David Hoskins，MIT）、toonNoise（梯度噪声，五次插值）、toonFbm
export function toonNoise(TSL) {
  const { Fn, vec3, float, floor, fract, dot, mix } = TSL;
  const hash33 = Fn(([q]) => {
    const p3 = fract(q.mul(vec3(0.1031, 0.1030, 0.0973))).toVar();
    p3.addAssign(dot(p3, p3.yxz.add(33.33)));
    return fract(p3.xxy.add(p3.yxx).mul(p3.zyx)).mul(2).sub(1);
  });
  const noise = Fn(([p]) => {
    const i = floor(p), f = fract(p);
    const u = f.mul(f).mul(f).mul(f.mul(f.mul(6).sub(15)).add(10));
    const n = (x, y, z) => dot(hash33(i.add(vec3(x, y, z))), f.sub(vec3(x, y, z)));
    return float(1.6).mul(mix(mix(mix(n(0, 0, 0), n(1, 0, 0), u.x), mix(n(0, 1, 0), n(1, 1, 0), u.x), u.y),
      mix(mix(n(0, 0, 1), n(1, 0, 1), u.x), mix(n(0, 1, 1), n(1, 1, 1), u.x), u.y), u.z));
  });
  const fbm = Fn(([p0]) => {
    const p = p0.toVar(), s = float(0).toVar(), a = float(0.5).toVar();
    for (let k = 0; k < 4; k++) { s.addAssign(a.mul(noise(p))); p.assign(p.mul(2.03).add(vec3(1.7, 9.2, 3.1))); a.mulAssign(0.5); }
    return s;
  });
  return { hash33, noise, fbm };
}

export function makeToonShared({ THREE, TSL }, { fillDir = [0, -1, 0], skyDir = [0, 1, 0], keyDir = [0.3, 0.8, 0.5] } = {}) {
  const { uniform } = TSL, v = a => new THREE.Vector3(...a).normalize();
  return { uToonPass: uniform(0), uInkTime: uniform(0), uExposure: uniform(1), uFillDirW: uniform(v(fillDir)), uFillGain: uniform(1), uSkyDirW: uniform(v(skyDir)), uSkyGain: uniform(1), uKeyDirW: uniform(v(keyDir)) };
}

const R170 = new WeakSet();   // 挂了 r170 滤波的 LightShadow

// 主光的投影滤波：r170 PCFSoftShadowMap 的 getShadow 逐式照搬（4 个整纹素 + 12 个按小数位置插值的取样，/9），深度比较不经硬件过滤（最近邻）。
export function useR170Shadow(TSL, light) {
  const { Fn, vec2, fract, mix, texture } = TSL;
  light.shadow.filterNode = Fn(({ depthTexture, shadowCoord, shadow }) => {
    const size = vec2(shadow.mapSize.width, shadow.mapSize.height), t = vec2(1).div(size), dx = t.x, dy = t.y;
    const c = uv => texture(depthTexture, uv).compare(shadowCoord.z);
    const f = fract(shadowCoord.xy.mul(size).add(0.5)), uv = shadowCoord.xy.sub(f.mul(t));
    const o = (x, y) => uv.add(vec2(dx.mul(x), dy.mul(y)));
    return c(uv).add(c(o(1, 0))).add(c(o(0, 1))).add(c(uv.add(t)))
      .add(mix(c(o(-1, 0)), c(o(2, 0)), f.x)).add(mix(c(o(-1, 1)), c(o(2, 1)), f.x))
      .add(mix(c(o(0, -1)), c(o(0, 2)), f.y)).add(mix(c(o(1, -1)), c(o(1, 2)), f.y))
      .add(mix(mix(c(o(-1, -1)), c(o(2, -1)), f.x), mix(c(o(-1, 2)), c(o(2, 2)), f.x), f.y))
      .mul(1 / 9);
  });
  R170.add(light.shadow);
  return light;
}

export function toonKind({ THREE, TSL }, spec = {}) {
  const k = { name: 'toon', firstId: 1, featherMin: 0.015, bandAA: 1.2, layers: [], shade: {}, ...spec };
  for (const key of ['pars', 'glsl', 'vars', 'uniforms']) if (k[key]) throw unsupported(`spec.${key}（GLSL 插桩），${k.name}`);
  if (Object.keys(k.shade).length) throw unsupported(`spec.shade 的光照钩子（${Object.keys(k.shade).join('、')}），${k.name}`);
  const { uniform, Fn, float, vec3, vec4, dot, max, clamp, mix, select, smoothstep, pow, exp2, fwidth, normalize,
    normalView, positionViewDirection, positionGeometry, cameraViewMatrix, diffuseColor } = TSL;
  const shared = k.shared || makeToonShared({ THREE, TSL });
  const L = k.layers;
  const defaults = Object.assign({}, TOON_BASE, ...L.map(l => l.defaults || {}), k.defaults || {});
  const N3 = toonNoise(TSL);
  const lum = c => dot(c, vec3(0.2126, 0.7152, 0.0722));
  let nextId = k.firstId;
  const C = c => { const x = colorOf(c); return new THREE.Color(x.r, x.g, x.b); };   // GLSL 版的取色约定（sRGB 数组等），换成 r187 的对象
  const V3 = v => { const x = v.isVector3 ? v : vec3Of(v); return new THREE.Vector3(x.x, x.y, x.z); };

  // 光照模型：direct 逐盏光记下（方向、阴影量、是否投影），finish 选主光后做整套卡通合成
  class ToonModel extends THREE.LightingModel {
    constructor(mat) { super(); this.mat = mat; this.lights = []; }
    start(builder) { this.lights = []; super.start(builder); }
    direct({ lightDirection, lightNode }) {
      const light = lightNode.light;
      if (!light.isDirectionalLight) return;
      let att = float(1);
      if (lightNode.shadowNode) {
        if (!R170.has(light.shadow)) throw unsupported(`主光 ${light.name || light.uuid} 的投影要先 useR170Shadow(TSL, light)（滤波与 r170 PCFSoft 同式）`);
        if (light.shadow.intensity !== 1) throw unsupported(`主光的 shadow.intensity = ${light.shadow.intensity}（只支持 1）`);
        const u = this.mat.userData.toon;
        att = smoothstep(u.uShadowLo, u.uShadowHi, lightNode.shadowNode);   // 投影量化（同 quantizeShadow；强度为 1 时 mix(1, x, 1) = x，先后无别）
      }
      this.lights.push({ L: lightDirection, att, cast: !!light.castShadow });
    }
    finish(builder) {
      const pick = this.lights.find(l => l.cast) || this.lights[0];
      const Lv = pick ? pick.L : normalize(cameraViewMatrix.mul(vec4(shared.uKeyDirW, 0)).xyz);
      const att = pick ? pick.att : float(1);
      builder.context.outgoingLight.assign(this.mat.toonShade(Lv, att));   // r187 先把 reflectedLight 加总进 outgoingLight 再调 finish，所以直接改它
    }
  }

  class ToonNodeMaterial extends THREE.NodeMaterial {
    constructor() { super(); this.lights = true; this.isToonTslMaterial = true; }
    setupLightingModel() { return new ToonModel(this); }
    // 合成节点挂在光照模型里，不进 three 的缓存键：结构相同的两个材质会共用一份程序、连 uniform 也串用，所以按材质区分
    customProgramCacheKey() { return this.uuid; }
    // 场景里一盏灯也没有时 r187 不走光照模型、直接用这里的出射光：同 GLSL 版，主光取 uKeyDirW、不接投影
    setupOutgoingLight(builder) {
      const ln = this.lightsNode || builder.lightsNode;
      if (ln && ln.getScope().hasLights) return vec3(0);   // 有灯：finish 会整个改写出射光
      return this.toonShade(normalize(cameraViewMatrix.mul(vec4(shared.uKeyDirW, 0)).xyz), float(1));
    }
  }

  function make(opts = {}) {
    const o = { ...defaults, ...opts };
    const hooked = GLSL_HOOKS.filter(h => o[h]);
    if (hooked.length && !o.tsl) throw unsupported(`材质钩子 ${hooked.join('、')} 只有 GLSL 版：给 opts.tsl 一份 TSL 版（${k.name}）`);
    for (const key of ['map', 'vertexColors', 'transparent', 'translucent', 'rest', 'outlineVertex']) if (o[key]) throw unsupported(`${key}（${k.name}）`);
    if (o.defines && Object.keys(o.defines).length) throw unsupported(`defines（${k.name}）`);
    const t1 = o.shade1 ? tintFrom(o.color, o.shade1) : vec3Of(o.shade1Tint);
    const t2 = o.shade2 ? tintFrom(o.color, o.shade2) : vec3Of(o.shade2Tint);
    const U = (v) => uniform(v);
    const u = {
      uLitTint: U(V3(o.litTint)), uShade1Tint: U(V3(t1)), uShade2Tint: U(V3(t2)),
      uStep1: U(o.step1), uFeather1: U(Math.max(k.featherMin, o.feather1)), uStep2: U(o.step2), uFeather2: U(Math.max(k.featherMin, o.feather2)),
      uShadowDepth: U(o.shadowDepth), uCastShade: U(o.castShade), uShadowLo: U(o.shadowLo), uShadowHi: U(o.shadowHi),
      uEdgeNoise: U(o.edgeNoise), uEdgeNoiseScale: U(o.edgeNoiseScale),
      uRimColor: U(C(o.rimColor)), uRimAmt: U(o.rimAmt), uRimPower: U(o.rimPower), uRimInside: U(o.rimInside), uRimDirK: U(o.rimDirK),
      uRimLitColor: U(C(o.rimLitColor)), uRimLitAmt: U(o.rimLitAmt), uRimLitDirK: U(o.rimLitDirK), uRimLitInside: U(o.rimLitInside), uRimLitPower: U(o.rimLitPower),
      ...(k.rimCore ? {
        uRimColor2: U(C(o.rimColor2 || o.rimColor)), uRimCoreOn: U(o.rimColor2 ? 1 : 0), uRimCore: U(o.rimCore),
        uRimLitColor2: U(C(o.rimLitColor2 || o.rimLitColor)), uRimLitCoreOn: U(o.rimLitColor2 ? 1 : 0), uRimLitCore: U(o.rimLitCore),
        uRimBreak: U(o.rimBreak), uRimNoiseScale: U(o.rimNoiseScale),
      } : {}),
      uFillColor: U(C(o.fillColor)), uFillAmt: U(o.fillAmt), uFillStep: U(o.fillStep), uFillStep2: U(o.fillStep2), uFillW1: U(o.fillW1), uFillFlat: U(o.fillFlat),
      uSkyTint: U(V3(o.skyTint)), uSkyAmt: U(o.skyAmt), ...(k.skyStepUniform ? { uSkyStep: U(o.skyStep) } : {}),
      uInkColor: U(C(o.inkColor)), uObjectId: U(o.objectId ?? nextId++), uOutlineW: U(o.outlineW), uInstIdOn: U(o.instanceId ? 1 : 0),
      ...Object.assign({}, ...L.map(l => (l.uniforms ? l.uniforms(o, { THREE, TSL, C, V3 }) : {}))),
      ...shared, ...(o.tsl?.uniforms || {}),
    };
    const mat = new ToonNodeMaterial();
    mat.side = o.side; mat.fog = o.fog; mat.opacity = o.opacity ?? 1; mat.depthWrite = o.depthWrite ?? true;
    mat.color = C(o.color);
    mat.name = k.name;
    const aa = k.bandAA, sky = k.skyStepUniform ? u.uSkyStep : float(0.3);

    // 反照率阶段：钩子可写变量 → fragmentBase → toonBase → 表面层 → fragmentAlbedo → 后置表面层；随后光照合成（shadeGlsl 逐式）
    mat.toonShade = (Lv, att) => Fn(() => {
      const c = { THREE, TSL, u, obj: positionGeometry, noise: N3, diffuse: diffuseColor.rgb.toVar(), ink: float(0).toVar(), overlay: vec4(0).toVar() };
      o.tsl?.fragmentBase?.(c);
      c.base = c.diffuse.toVar();
      for (const l of L) l.surface?.(c);
      o.tsl?.fragmentAlbedo?.(c);
      for (const l of L) l.post?.(c);
      const alb = c.diffuse, N = normalView, V = positionViewDirection, Lw = Lv;
      const en = N3.noise(c.obj.mul(u.uEdgeNoiseScale).add(101)).mul(u.uEdgeNoise);
      // 三色分档（半兰伯特 + 两道羽化；羽化取 max(给定值, bandAA 像素)）
      const hl = dot(N, Lw).mul(0.5).add(0.5).add(en);
      const hlS = hl.mul(mix(float(1).sub(u.uShadowDepth), 1, att));
      const f1 = max(u.uFeather1, fwidth(hlS).mul(aa));
      const m1 = max(clamp(u.uStep1.sub(hlS).div(f1).add(0.5), 0, 1), u.uCastShade.mul(float(1).sub(att)));
      const f2 = max(u.uFeather2, fwidth(hl).mul(aa));
      const m2 = clamp(u.uStep2.sub(hl).div(f2).add(0.5), 0, 1);
      const col = mix(alb.mul(u.uLitTint), mix(alb.mul(u.uShade1Tint), alb.mul(u.uShade2Tint), m2), m1).toVar();
      // 天空冷光：只进阴影档里朝天的面
      const skyV = normalize(cameraViewMatrix.mul(vec4(shared.uSkyDirW, 0)).xyz);
      const sk = dot(N, skyV), fsk = max(0.02, fwidth(sk));
      const skyM = smoothstep(sky.sub(fsk), sky.add(fsk), sk.add(en)).mul(m1).mul(u.uSkyAmt).mul(shared.uSkyGain);
      col.assign(mix(col, alb.mul(u.uSkyTint), clamp(skyM, 0, 1)));
      // 下方补光：自下而上，两档量化
      const fillV = normalize(cameraViewMatrix.mul(vec4(shared.uFillDirW, 0)).xyz);
      const fillN = dot(N, fillV).add(en.mul(0.6)), fillF = max(0.015, fwidth(fillN).mul(1.2));
      const fillM = u.uFillW1.mul(smoothstep(u.uFillStep.sub(fillF), u.uFillStep.add(fillF), fillN))
        .add(float(1).sub(u.uFillW1).mul(smoothstep(u.uFillStep2.sub(fillF), u.uFillStep2.add(fillF), fillN))).mul(u.uFillAmt).mul(shared.uFillGain);
      const lr = clamp(lum(alb).div(max(lum(c.base), 1e-4)), 0, 1.4);
      const warm = mix(alb.mul(u.uFillColor).mul(2.4), u.uFillColor.mul(mix(float(1), lr, 0.55)), u.uFillFlat);
      col.assign(mix(col, warm, clamp(fillM, 0, 1)));
      // 边缘光：背光侧（hlv 越小越亮）+ 受光侧；都是硬边，内沿加噪声像笔触
      const ndv = clamp(dot(N, V), 0, 1), hlv = clamp(dot(N, Lw).mul(0.5).add(0.5), 0, 1);
      const rn = k.rimCore ? select(u.uRimBreak.greaterThan(0), N3.noise(c.obj.mul(u.uRimNoiseScale).add(211)).mul(u.uRimBreak), float(0)) : float(0);
      const rb = float(1).sub(ndv);
      const rp = pow(rb, exp2(float(1).sub(u.uRimPower).mul(3))).add(en.mul(0.8)).add(rn);
      const fr = max(0.012, fwidth(rp).mul(1.2)), tAp = u.uRimInside.add(u.uRimDirK.mul(hlv));
      const ap = smoothstep(tAp.sub(fr), tAp.add(fr), rp).mul(u.uRimAmt);
      const rq = pow(rb, exp2(float(1).sub(u.uRimLitPower).mul(3))).add(en.mul(0.8)).add(rn);
      const fq = max(0.012, fwidth(rq).mul(1.2)), tLit = u.uRimLitInside.add(u.uRimLitDirK.mul(float(1).sub(hlv)));
      const rl = smoothstep(tLit.sub(fq), tLit.add(fq), rq).mul(u.uRimLitAmt).mul(att);
      col.assign(mix(col, u.uRimColor.mul(mix(float(1), lr, 0.35)), clamp(ap, 0, 1)));
      if (k.rimCore) {
        const ap2 = smoothstep(tAp.add(u.uRimCore).sub(fr), tAp.add(u.uRimCore).add(fr), rp.sub(rn.mul(0.6))).mul(u.uRimAmt).mul(u.uRimCoreOn);
        col.assign(mix(col, u.uRimColor2, clamp(ap2, 0, 1)));
      }
      col.assign(mix(col, u.uRimLitColor, clamp(rl, 0, 1)));
      if (k.rimCore) {
        const rl2 = smoothstep(tLit.add(u.uRimLitCore).sub(fq), tLit.add(u.uRimLitCore).add(fq), rq.sub(rn.mul(0.6))).mul(u.uRimLitAmt).mul(att).mul(u.uRimLitCoreOn);
        col.assign(mix(col, u.uRimLitColor2, clamp(rl2, 0, 1)));
      }
      col.assign(mix(col, u.uInkColor, clamp(c.ink, 0, 1)));
      col.assign(mix(col, c.overlay.rgb, clamp(c.overlay.a, 0, 1)));
      return col.mul(shared.uExposure);
    })();
    mat.userData.toon = u;
    mat.userData.toonOpts = o;
    if (o.noId) mat.userData.noId = true;
    return mat;
  }

  // 挂材质 + 投影 + 描边标记（与 GLSL 版 bindPatched 同样的 userData）；顶点不形变，不需要另挂深度材质
  function bind(mesh, mat, { castShadow = true, receiveShadow = true, outline = true, perInstance } = {}) {
    if (mesh.isInstancedMesh) throw unsupported(`InstancedMesh（${k.name}）`);
    const u = mat.userData.toon;
    mesh.material = mat; mesh.castShadow = castShadow; mesh.receiveShadow = receiveShadow;
    Object.assign(mesh.userData, { outline, outlineId: u.uObjectId.value, outlineWeight: u.uOutlineW.value, outlinePerInstance: perInstance ?? false, instanced: false });
    return mesh;
  }

  return { make, bind, shared };
}
