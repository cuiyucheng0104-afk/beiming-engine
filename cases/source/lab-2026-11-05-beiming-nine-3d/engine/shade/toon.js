// 北冥引擎 · 三档卡通材质（三渲二的“光”）：MeshToonMaterial + 着色器补丁（three r170）。
// 三色分档（两道羽化 + fwidth 抗锯齿）、投影量化（投影区压进阴影档）、背光侧 / 受光侧硬边边缘光（可选双色亮芯 + 撕边 rimCore）、
// 下方补光 fill（两档量化）、天空冷光（只进阴影档）；表面层见 surface.js。输出模式 shared.uToonPass：0 彩色，1 视空间法线 + 物体 / 实例 ID。
// 主光 = 第一盏投影平行光，只取方向和投影；颜色全按参数绝对给定（保色板用 NoToneMapping）；噪声是坐标的纯函数，任意帧可单独重渲。
//
//   makeToonShared(init) / setToonShared(S, g)   全场共享 uniform；g = { pass, inkTime, exposure, fillDir, fillGain, skyDir, skyGain, keyDir }
//   tintFrom(base, shade)   阴影色 / 基色（线性空间逐通道比值）→ 乘法色调（实例色物体每个实例各有三档色）
//   TOON_BASE               中性默认参数：step* / feather*、shadow*、edgeNoise*、rim* / rimLit*、fill*、sky*、inkColor、outlineW…
//   toonKind(spec) → { make(opts), depth(mat), bind(mesh, mat, opts), shared }   一族材质：同一套着色器 + 自己的物体 ID 段
//     spec：name（缓存键 / 报错前缀）、shared、firstId、defaults、featherMin（羽化下限）、bandAA（分档 fwidth 倍数）、
//           skyStepUniform、rimCore、depth（false = 不挂深度材质）、layers（表面层）、
//           pars / glsl / uniforms(o) / vars（本族追加的 uniform 声明、函数、uniform 值、钩子可写变量）、
//           shade = { rimNormal, bands, skyMask, afterSky, flatMask, afterFill, rimScale, rimLitColor, afterRim, final, passPre, passNormal }
//             插在光照合成固定位置的 GLSL，可读 N V L att alb en hl m1 m2 col skyV fillM lr ndv hlv ap rl
//   make(opts)：默认参数里的任意键，另加 uniforms / defines / objectId / outlineVertex；
//     顶点钩子 vertexPars / vertexMainStart / vertexBegin（改 transformed）/ vertexNormal（改 objectNormal）；
//     片元钩子 fragmentPars / fragmentBase（斑块前写固有色）/ fragmentAlbedo（改 diffuseColor、toonInk、toonOverlay）/ fragmentNormal；
//     rest（噪声坐标取 aRest，CPU 形变网格用）/ translucent（彩色通道半透明，ID 通道自动不透明）/ noId（不进 ID 通道）
//   运行时调参 mat.userData.toon.uXxx.value；有顶点钩子时 bind 挂同样形变的阴影深度材质。
import * as THREE from 'three';
import { inject, programKey, vec3Of, colorOf, patchVertex, quantizeShadow, hasVertexHooks, makeDepthMaterial, bindPatched, counter } from './patch.js';
import { NOISE_GLSL } from './noise.glsl.js';
import { SS_GLSL, LUM_GLSL, glf } from './util.glsl.js';

export function makeToonShared({ fillDir = [0, -1, 0], skyDir = [0, 1, 0], keyDir = [0.3, 0.8, 0.5] } = {}) {
  return {
    uToonPass: { value: 0 },                                         // 0 彩色；1 法线 + ID
    uInkTime: { value: 0 },                                          // 墨线抖动时钟
    uExposure: { value: 1 },                                         // 整体提亮
    uFillDirW: { value: new THREE.Vector3(...fillDir).normalize() }, // 下方补光来自的方向
    uFillGain: { value: 1 },
    uSkyDirW: { value: new THREE.Vector3(...skyDir).normalize() },
    uSkyGain: { value: 1 },
    uKeyDirW: { value: new THREE.Vector3(...keyDir).normalize() },   // 场景里没有平行光时的主光方向
  };
}

export function setToonShared(S, g = {}) {
  if (g.fillDir) S.uFillDirW.value.set(...g.fillDir).normalize();
  if (g.skyDir) S.uSkyDirW.value.set(...g.skyDir).normalize();
  if (g.keyDir) S.uKeyDirW.value.set(...g.keyDir).normalize();
  for (const [k, u] of [['fillGain', 'uFillGain'], ['skyGain', 'uSkyGain'], ['exposure', 'uExposure'], ['inkTime', 'uInkTime'], ['pass', 'uToonPass']])
    if (g[k] !== undefined) S[u].value = g[k];
}

export function tintFrom(base, shade) {
  const b = new THREE.Color(base), s = new THREE.Color(shade);
  return new THREE.Vector3(s.r / Math.max(b.r, 1e-4), s.g / Math.max(b.g, 1e-4), s.b / Math.max(b.b, 1e-4));
}

// 分档在 hl = 0.5·N·L + 0.5 上做：hl > step1 为亮面；hl < step2 为二档暗部
export const TOON_BASE = {
  color: '#ffffff',
  shade1: null, shade2: null,                  // 直接给阴影色（单色物体）；null 时用乘法色调
  shade1Tint: [0.62, 0.64, 0.8], shade2Tint: [0.36, 0.38, 0.58], litTint: [1, 1, 1],
  step1: 0.55, feather1: 0.02,                 // 亮 / 一档（作用于含投影的 hl）
  step2: 0.3, feather2: 0.03,                  // 一档 / 二档（作用于原始 hl）
  shadowDepth: 0.5, castShade: 1,              // 投影压低 hl 的比例；投影区强制进阴影档
  shadowLo: 0.42, shadowHi: 0.58,              // 投影量化窗口（越窄越像色块）
  edgeNoise: 0.03, edgeNoiseScale: 0.06,       // 明暗交界线扰动幅度 / 频率（1/物体单位）
  rimColor: '#ffffff', rimAmt: 1, rimPower: 0.2, rimInside: 0.42, rimDirK: 0.3,
  rimLitColor: '#ffffff', rimLitAmt: 0, rimLitInside: 0.2, rimLitPower: 0.4, rimLitDirK: 0.3,
  rimColor2: null, rimCore: 0.12, rimLitColor2: null, rimLitCore: 0.1,   // rimCore：亮芯色（null = 不画）与宽度
  rimBreak: 0, rimNoiseScale: 0.12,            // rimCore：边缘光内沿撕边幅度 / 频率
  fillColor: '#ffb070', fillAmt: 0, fillStep: 0.45, fillStep2: 0.8, fillW1: 0.45, fillFlat: 0.6,   // 两档阈值作用于 N·(指向补光)
  skyTint: [0.8, 0.88, 1.18], skyAmt: 0, skyStep: 0.3,
  inkColor: '#202020',
  outlineW: 1, instanceId: true,               // 法线长度 = 描边权重；instanceId=false 时整批实例同一个 ID（只画外轮廓）
  side: THREE.FrontSide, fog: true,
  rest: false, translucent: false, noId: false,
};

const OWN_VERTEX = rest => ({
  head: 'varying vec3 vToonObj;\nflat varying float vToonInst;\n' + (rest ? 'attribute vec3 aRest;\n' : ''),
  begin: rest ? 'vToonObj = aRest;\n' : 'vToonObj = position + float( gl_InstanceID ) * vec3( 1.618, 2.718, 3.1416 );\n',
  project: 'vToonInst = float( gl_InstanceID );',
});
const LIGHT_ANCHOR = 'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;';
const join = (list, key) => list.map(l => l[key] || '').join('');

const parsGlsl = (k, L) => /* glsl */`
uniform vec3 uLitTint, uShade1Tint, uShade2Tint;
uniform float uStep1, uFeather1, uStep2, uFeather2, uShadowDepth, uCastShade, uShadowLo, uShadowHi;
uniform float uEdgeNoise, uEdgeNoiseScale;
uniform vec3 uRimColor; uniform float uRimAmt, uRimPower, uRimInside, uRimDirK;
uniform vec3 uRimLitColor; uniform float uRimLitAmt, uRimLitDirK, uRimLitInside, uRimLitPower;${k.rimCore ? `
uniform vec3 uRimColor2, uRimLitColor2; uniform float uRimCore, uRimCoreOn, uRimLitCore, uRimLitCoreOn, uRimBreak, uRimNoiseScale;` : ''}
uniform vec3 uFillColor; uniform float uFillAmt, uFillStep, uFillStep2, uFillW1, uFillFlat;
uniform vec3 uSkyTint; uniform float uSkyAmt;${k.skyStepUniform ? ' uniform float uSkyStep;' : ''}
uniform vec3 uInkColor; uniform float uObjectId, uOutlineW, uInstIdOn;
uniform float uToonPass, uInkTime, uExposure, uFillGain, uSkyGain;
uniform vec3 uFillDirW, uSkyDirW, uKeyDirW;
varying vec3 vToonObj;
flat varying float vToonInst;
${join(L, 'pars')}${k.pars || ''}${LUM_GLSL}${NOISE_GLSL}${SS_GLSL}${join(L, 'glsl')}${k.glsl || ''}`;

// 卡通光照合成（替换 meshtoon 里 outgoingLight 那一行）
const shadeGlsl = (k, s) => {
  const NR = s.rimNormal ? 'NR' : 'N', C = k.rimCore, aa = glf(k.bandAA), sky = k.skyStepUniform ? 'uSkyStep' : '0.3';
  const rb = C ? 'rimBase' : '1.0 - ndv', rn = C ? ' + rn' : '';
  return /* glsl */`
vec3 outgoingLight;
{
  vec3 N = normal;${s.rimNormal ? `
  vec3 NR = ${s.rimNormal};` : ''}
  vec3 V = geometryViewDir;
  vec3 L;
  #if NUM_DIR_LIGHTS > 0
    L = directionalLights[ 0 ].direction;
  #else
    L = normalize( ( viewMatrix * vec4( uKeyDirW, 0.0 ) ).xyz );
  #endif
  float att = 1.0;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    DirectionalLightShadow toonKs = directionalLightShadows[ 0 ];
    att = receiveShadow ? getShadow( directionalShadowMap[ 0 ], toonKs.shadowMapSize, toonKs.shadowIntensity, toonKs.shadowBias, toonKs.shadowRadius, vDirectionalShadowCoord[ 0 ] ) : 1.0;
  #endif
  vec3 alb = diffuseColor.rgb;
  float en = toonNoise( vToonObj * uEdgeNoiseScale + 101.0 ) * uEdgeNoise;
  // 三色分档（半兰伯特 + 两道羽化；羽化取 max(给定值, ${aa} 像素)）
  float hl = 0.5 * dot( N, L ) + 0.5 + en;
  float hlS = hl * mix( 1.0 - uShadowDepth, 1.0, att );
  float f1 = max( uFeather1, fwidth( hlS ) * ${aa} );
  float m1 = clamp( ( uStep1 - hlS ) / f1 + 0.5, 0.0, 1.0 );
  m1 = max( m1, uCastShade * ( 1.0 - att ) );
  float f2 = max( uFeather2, fwidth( hl ) * ${aa} );
  float m2 = clamp( ( uStep2 - hl ) / f2 + 0.5, 0.0, 1.0 );
  ${s.bands || ''}
  vec3 col = mix( alb * uLitTint, mix( alb * uShade1Tint, alb * uShade2Tint, m2 ), m1 );
  // 天空冷光：只进阴影档里朝天的面
  vec3 skyV = normalize( ( viewMatrix * vec4( uSkyDirW, 0.0 ) ).xyz );
  float sk = dot( N, skyV );
  float fsk = max( 0.02, fwidth( sk ) );
  float skyM = smoothstep( ${sky} - fsk, ${sky} + fsk, sk + en ) * m1 * uSkyAmt * uSkyGain;
  col = mix( col, alb * uSkyTint, clamp( skyM, 0.0, 1.0 )${s.skyMask || ''} );
  ${s.afterSky || ''}
  // 下方补光：自下而上，两档量化
  vec3 fillV = normalize( ( viewMatrix * vec4( uFillDirW, 0.0 ) ).xyz );
  float fillN = dot( N, fillV ) + en * 0.6;
  float fillF = max( 0.015, fwidth( fillN ) * 1.2 );
  float fillM = uFillW1 * smoothstep( uFillStep - fillF, uFillStep + fillF, fillN ) + ( 1.0 - uFillW1 ) * smoothstep( uFillStep2 - fillF, uFillStep2 + fillF, fillN );
  fillM *= uFillAmt * uFillGain;
  float lr = clamp( toonLum( alb ) / max( toonLum( toonBase ), 1e-4 ), 0.0, 1.4 );
  vec3 warm = mix( alb * uFillColor * 2.4, uFillColor * mix( 1.0, lr, 0.55 ), uFillFlat${s.flatMask || ''} );
  col = mix( col, warm, clamp( fillM, 0.0, 1.0 ) );
  ${s.afterFill || ''}
  // 边缘光：Ap（背光侧，hlv 越小越亮）+ 受光侧；都是硬边，内沿加噪声像笔触
  float ndv = clamp( dot( ${NR}, V ), 0.0, 1.0 );
  float hlv = clamp( 0.5 * dot( ${NR}, L ) + 0.5, 0.0, 1.0 );${C ? `
  float rn = uRimBreak > 0.0 ? toonNoise( vToonObj * uRimNoiseScale + 211.0 ) * uRimBreak : 0.0;
  float rimBase = 1.0 - ndv;` : ''}
  float rp = pow( ${rb}, exp2( 3.0 * ( 1.0 - uRimPower ) ) ) + en * 0.8${rn};
  float fr = max( 0.012, fwidth( rp ) * 1.2 );
  float tAp = uRimInside + uRimDirK * hlv;
  float ap = smoothstep( tAp - fr, tAp + fr, rp ) * uRimAmt${s.rimScale || ''};${C ? `
  float ap2 = smoothstep( tAp + uRimCore - fr, tAp + uRimCore + fr, rp - rn * 0.6 ) * uRimAmt * uRimCoreOn;` : ''}
  float rq = pow( ${rb}, exp2( 3.0 * ( 1.0 - uRimLitPower ) ) ) + en * 0.8${rn};
  float fq = max( 0.012, fwidth( rq ) * 1.2 );
  float tLit = uRimLitInside + uRimLitDirK * ( 1.0 - hlv );
  float rl = smoothstep( tLit - fq, tLit + fq, rq ) * uRimLitAmt * att${s.rimScale || ''};${C ? `
  float rl2 = smoothstep( tLit + uRimLitCore - fq, tLit + uRimLitCore + fq, rq - rn * 0.6 ) * uRimLitAmt * att * uRimLitCoreOn;` : ''}
  col = mix( col, uRimColor * mix( 1.0, lr, 0.35 ), clamp( ap, 0.0, 1.0 ) );${C ? `
  col = mix( col, uRimColor2, clamp( ap2, 0.0, 1.0 ) );` : ''}
  col = mix( col, ${s.rimLitColor || 'uRimLitColor'}, clamp( rl, 0.0, 1.0 ) );${C ? `
  col = mix( col, uRimLitColor2, clamp( rl2, 0.0, 1.0 ) );` : ''}
  ${s.afterRim || ''}
  col = mix( col, uInkColor, clamp( toonInk, 0.0, 1.0 ) );
  col = mix( col, toonOverlay.rgb, clamp( toonOverlay.a, 0.0, 1.0 ) );
  ${s.final || ''}
  outgoingLight = col * uExposure + totalEmissiveRadiance;
}
`;
};

const passGlsl = s => /* glsl */`
#ifdef TOON_NO_ID
if ( uToonPass > 0.5 ) discard;          // 不进法线 / ID 通道
#endif
if ( uToonPass > 0.5 ) {
  float toonId = fract( uObjectId * 0.7548776662 + vToonInst * uInstIdOn * 0.5698402910 + 0.137 );${s.passPre ? `
  ${s.passPre}` : ''}
  gl_FragColor = vec4( ${s.passNormal || 'normal'} * uOutlineW * 0.5 + 0.5, toonId );
}
`;

export function toonKind(spec = {}) {
  const k = { name: 'toon', firstId: 1, featherMin: 0.015, bandAA: 1.2, layers: [], shade: {}, depth: true, ...spec };
  const L = k.layers, who = k.name;
  const shared = k.shared || makeToonShared();
  const next = counter(k.firstId);
  const defaults = Object.assign({}, TOON_BASE, ...L.map(l => l.defaults || {}), k.defaults || {});
  const PARS = parsGlsl(k, L), SHADE = shadeGlsl(k, k.shade), PASS = passGlsl(k.shade);
  // 反照率阶段：钩子可写变量 → fragmentBase → toonBase → 表面层 → fragmentAlbedo → 后置表面层
  const albedo = o => /* glsl */`
float toonInk = 0.0;            // 钩子可写：0..1，往墨线色混（光照之后）
vec4 toonOverlay = vec4( 0.0 ); // 钩子可写：不受光照的覆盖色（rgb, 量）
${k.vars || ''}${join(L, 'vars')}${o.fragmentBase || ''}
vec3 toonBase = diffuseColor.rgb;
${join(L, 'surface')}${o.fragmentAlbedo || ''}${join(L, 'post')}`;

  function make(opts = {}) {
    const o = { ...defaults, ...opts };
    const t1 = o.shade1 ? tintFrom(o.color, o.shade1) : vec3Of(o.shade1Tint);
    const t2 = o.shade2 ? tintFrom(o.color, o.shade2) : vec3Of(o.shade2Tint);
    const mat = new THREE.MeshToonMaterial({ color: colorOf(o.color), side: o.side, fog: o.fog,
      transparent: !!(o.transparent || o.translucent), opacity: o.opacity ?? 1, map: o.map || null,
      depthWrite: o.depthWrite ?? true, vertexColors: !!o.vertexColors });
    const u = {
      uLitTint: { value: vec3Of(o.litTint) }, uShade1Tint: { value: t1 }, uShade2Tint: { value: t2 },
      uStep1: { value: o.step1 }, uFeather1: { value: Math.max(k.featherMin, o.feather1) }, uStep2: { value: o.step2 }, uFeather2: { value: Math.max(k.featherMin, o.feather2) },
      uShadowDepth: { value: o.shadowDepth }, uCastShade: { value: o.castShade }, uShadowLo: { value: o.shadowLo }, uShadowHi: { value: o.shadowHi },
      uEdgeNoise: { value: o.edgeNoise }, uEdgeNoiseScale: { value: o.edgeNoiseScale },
      uRimColor: { value: colorOf(o.rimColor) }, uRimAmt: { value: o.rimAmt }, uRimPower: { value: o.rimPower }, uRimInside: { value: o.rimInside }, uRimDirK: { value: o.rimDirK },
      uRimLitColor: { value: colorOf(o.rimLitColor) }, uRimLitAmt: { value: o.rimLitAmt }, uRimLitDirK: { value: o.rimLitDirK }, uRimLitInside: { value: o.rimLitInside }, uRimLitPower: { value: o.rimLitPower },
      ...(k.rimCore ? {
        uRimColor2: { value: colorOf(o.rimColor2 || o.rimColor) }, uRimCoreOn: { value: o.rimColor2 ? 1 : 0 }, uRimCore: { value: o.rimCore },
        uRimLitColor2: { value: colorOf(o.rimLitColor2 || o.rimLitColor) }, uRimLitCoreOn: { value: o.rimLitColor2 ? 1 : 0 }, uRimLitCore: { value: o.rimLitCore },
        uRimBreak: { value: o.rimBreak }, uRimNoiseScale: { value: o.rimNoiseScale },
      } : {}),
      uFillColor: { value: colorOf(o.fillColor) }, uFillAmt: { value: o.fillAmt }, uFillStep: { value: o.fillStep }, uFillStep2: { value: o.fillStep2 }, uFillW1: { value: o.fillW1 }, uFillFlat: { value: o.fillFlat },
      uSkyTint: { value: vec3Of(o.skyTint) }, uSkyAmt: { value: o.skyAmt }, ...(k.skyStepUniform ? { uSkyStep: { value: o.skyStep } } : {}),
      uInkColor: { value: colorOf(o.inkColor) }, uObjectId: { value: o.objectId ?? next() },
      uOutlineW: { value: o.outlineW }, uInstIdOn: { value: o.instanceId ? 1 : 0 },
      ...Object.assign({}, ...L.map(l => l.uniforms ? l.uniforms(o) : {})),
      ...(k.uniforms ? k.uniforms(o) : {}),
      ...shared, ...(o.uniforms || {}),
    };
    const defines = { ...(o.defines || {}), ...(o.noId ? { TOON_NO_ID: 1 } : {}) };
    const key = programKey(k.name, [o.rest, o.vertexPars, o.vertexMainStart, o.vertexBegin, o.vertexNormal, o.fragmentPars, o.fragmentBase, o.fragmentAlbedo, o.fragmentNormal, JSON.stringify(defines)]);
    mat.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, u);
      Object.assign(sh.defines || (sh.defines = {}), defines);
      sh.vertexShader = patchVertex(sh.vertexShader, o, OWN_VERTEX(o.rest), who);
      // 片元：参数 → 量化投影 → 反照率（斑块 + 钩子）→ 法线钩子 → 卡通合成 → 输出模式
      let f = sh.fragmentShader;
      f = inject(f, '#include <common>', PARS + (o.fragmentPars || ''), 'after', who);
      f = quantizeShadow(f, 'uShadowLo', 'uShadowHi', who);
      f = inject(f, '#include <color_fragment>', albedo(o), 'after', who);
      f = inject(f, '#include <normal_fragment_maps>', o.fragmentNormal || '', 'after', who);
      f = inject(f, LIGHT_ANCHOR, SHADE, 'replace', who);
      f = inject(f, '#include <dithering_fragment>', PASS, 'after', who);
      sh.fragmentShader = f;
    };
    mat.customProgramCacheKey = () => key;
    mat.userData.toon = u;
    mat.userData.toonOpts = o;
    if (o.translucent) {
      // 彩色通道：正常混合、不写深度；法线 / ID 通道：不混合、写深度（在渲染前按 uToonPass 切换）
      mat.forceSinglePass = true;   // 双面透明默认会画两遍并强制重编，这里不需要
      mat.depthWrite = false;
      mat.onBeforeRender = () => {
        const idPass = shared.uToonPass.value > 0.5;
        mat.blending = idPass ? THREE.NoBlending : THREE.NormalBlending;
        mat.depthWrite = idPass;
      };
    }
    return mat;
  }

  // 阴影深度材质：带同样的顶点形变（弯曲、摆动），否则投影和形体对不上
  function depth(mat) {
    const o = mat.userData.toonOpts || {};
    return makeDepthMaterial({ hooks: o, uniforms: mat.userData.toon, defines: o.defines || {}, key: k.name + '-depth',
      side: o.side === THREE.DoubleSide ? THREE.DoubleSide : THREE.FrontSide, who });
  }

  // 挂材质 + 投影深度材质 + 描边标记（perInstance 不给时：实例化网格且材质开了实例 ID）
  function bind(mesh, mat, { castShadow = true, receiveShadow = true, outline = true, perInstance } = {}) {
    const o = mat.userData.toonOpts || {}, u = mat.userData.toon;
    bindPatched(mesh, mat, { castShadow, receiveShadow, outline,
      depth: k.depth !== false && hasVertexHooks(o) ? () => depth(mat) : null,
      id: u.uObjectId.value, weight: u.uOutlineW.value,
      perInstance: perInstance ?? (!!mesh.isInstancedMesh && u.uInstIdOn.value > 0.5) });
    if (o.outlineVertex) mesh.userData.outlineVertex = o.outlineVertex;
    return mesh;
  }

  return { make, depth, bind, shared };
}
