// 北冥引擎 · 卡通材质的表面层：贴在物体空间坐标上的斑块、笔触、风化（不随动画滑动），在光照分档之前改反照率。
// 全部是坐标的纯函数；高频部分按屏幕频率自动淡出，远景不闪。交给 toon.js 的 toonKind({ layers: [...] }) 使用。
// 一层 = { defaults, pars（uniform 声明）, glsl（函数）, uniforms(o), vars（钩子可写变量）, surface（钩子 fragmentAlbedo 之前）, post（之后） }
//
//   patchLayer({ rust, core, algaeK })   斑块：植被斑驳 dab、锈斑 rust（可带深色斑心 core）、藻斑 algae、小斑点 spot
//                                         rust = 'color'：往 rustColor 混；'tint'：固有色乘 rustTint（保住色相）。algaeK：藻斑量的倍率
//   paintLayer                            绘画感：三档植被斑驳、干笔笔触 stroke、颜料颗粒 grain、锈斑撕边 / 积色边 / 甩点 / 海绵点、
//                                         藻斑撕边、成簇斑点；斑块可沿物体 X 轴拉长（patchStretch < 1）
//   muralLayer                            壁画风化：褪色大斑（向地仗色 muralGround 靠）、干笔飞白、剥落块、氧化暗斑、细碎点；
//                                         钩子可写 toonMuralP（风化坐标）、toonMuralK（本像素风化量倍率，负值按 0 算）
//                                         分支只看 uniform（uMuralAmt），fwidth 都在一致控制流里算，K 逐像素变也不会让导数失效
import { colorOf, vec3Of } from './patch.js';
import { AA_GLSL, glf } from './util.glsl.js';

export function patchLayer({ rust = 'color', core = true, algaeK = 1 } = {}) {
  const tint = rust === 'tint';
  const rustApply = tint
    ? 'diffuseColor.rgb *= mix( vec3( 1.0 ), uRustTint, rust * uRustAmt );' + (core ? '\n  diffuseColor.rgb *= mix( vec3( 1.0 ), uRustTint * 0.86, core * uRustAmt * 0.55 );' : '')
    : 'diffuseColor.rgb = mix( diffuseColor.rgb, uRustColor, rust * uRustAmt );' + (core ? '\n  diffuseColor.rgb = mix( diffuseColor.rgb, uRustColor * vec3( 0.55, 0.5, 0.62 ), core * uRustAmt * 0.75 );' : '');
  return {
    defaults: {
      patchScale: 0.05,
      rustColor: '#806a99', rustTint: [0.7, 0.75, 0.95], rustAmt: 0, rustThr: 0.1,
      algaeColor: '#60806f', algaeAmt: 0, algaeThr: 0.28,
      spotColor: '#202020', spotAmt: 0, spotThr: 0.5, spotScale: 6,
      dabAmt: 0, dabScale: 1.2,
    },
    pars: /* glsl */`
uniform float uPatchScale;
uniform vec3 ${tint ? 'uRustTint' : 'uRustColor'}; uniform float uRustAmt, uRustThr;
uniform vec3 uAlgaeColor; uniform float uAlgaeAmt, uAlgaeThr;
uniform vec3 uSpotColor; uniform float uSpotAmt, uSpotThr, uSpotScale;
uniform float uDabAmt, uDabScale;
`,
    uniforms: o => ({
      uPatchScale: { value: o.patchScale },
      ...(tint ? { uRustTint: { value: vec3Of(o.rustTint) } } : { uRustColor: { value: colorOf(o.rustColor) } }),
      uRustAmt: { value: o.rustAmt }, uRustThr: { value: o.rustThr },
      uAlgaeColor: { value: colorOf(o.algaeColor) }, uAlgaeAmt: { value: o.algaeAmt }, uAlgaeThr: { value: o.algaeThr },
      uSpotColor: { value: colorOf(o.spotColor) }, uSpotAmt: { value: o.spotAmt }, uSpotThr: { value: o.spotThr }, uSpotScale: { value: o.spotScale },
      uDabAmt: { value: o.dabAmt }, uDabScale: { value: o.dabScale },
    }),
    surface: /* glsl */`
if ( uDabAmt > 0.0 ) {
  vec3 Q = vToonObj * uDabScale;
  float d1 = toonNoise( Q ), d2 = toonNoise( Q * 2.3 + 17.0 );
  float a1 = max( fwidth( d1 ), 1e-4 ) * 0.8, a2 = max( fwidth( d2 ), 1e-4 ) * 0.8;
  float q = 0.55 * smoothstep( 0.12 - a1, 0.12 + a1, d1 ) + 0.45 * smoothstep( 0.22 - a2, 0.22 + a2, d2 );
  diffuseColor.rgb *= mix( 1.0 - uDabAmt, 1.0 + 0.7 * uDabAmt, q );
}
if ( uRustAmt + uAlgaeAmt + uSpotAmt > 0.0 ) {
  vec3 P = vToonObj * uPatchScale;
  vec3 w = vec3( toonNoise( P * 0.6 + 1.3 ), toonNoise( P * 0.6 + 7.1 ), toonNoise( P * 0.6 + 13.7 ) );
  float nR = toonFbm( P + w * 0.9 );
  float aR = max( fwidth( nR ), 1e-4 ) * 0.8;
  float rust = smoothstep( uRustThr - aR, uRustThr + aR, nR );${core ? `
  float core = smoothstep( uRustThr + 0.17 - aR, uRustThr + 0.17 + aR, nR );` : ''}
  ${rustApply}
  float nA = toonFbm( P * 1.6 - w * 0.7 + 31.0 );
  float aA = max( fwidth( nA ), 1e-4 ) * 0.8;
  float alg = smoothstep( uAlgaeThr - aA, uAlgaeThr + aA, nA ) * ( 1.0 - rust );
  diffuseColor.rgb = mix( diffuseColor.rgb, uAlgaeColor, alg * uAlgaeAmt${algaeK === 1 ? '' : ` * ${glf(algaeK)}`} );
  float nS = toonNoise( vToonObj * uPatchScale * uSpotScale + w * 0.4 + 57.0 );
  float aS = max( fwidth( nS ), 1e-4 ) * 0.8;
  float spot = smoothstep( uSpotThr - aS, uSpotThr + aS, nS );
  diffuseColor.rgb = mix( diffuseColor.rgb, uSpotColor, spot * uSpotAmt );
}
`,
  };
}

export const paintLayer = {
  defaults: {
    patchScale: 0.05, patchStretch: 1,
    rustColor: '#806a99', rustAmt: 0, rustThr: 0.1,
    rustBreak: 0, rustPool: 0, rustSpatter: 0, spatterScale: 9, rustDapple: 0,
    algaeColor: '#60806f', algaeAmt: 0, algaeThr: 0.28,
    spotColor: '#202020', spotAmt: 0, spotThr: 0.5, spotScale: 6, spotCluster: 0,
    dabAmt: 0, dabScale: 1.2, dabWarm: 0.6,
    strokeAmt: 0, strokeScale: 0.08, strokeDir: [1, 0, 0], strokeStretch: 0.85,
    grainAmt: 0, grainScale: 0.9,
  },
  pars: /* glsl */`
uniform float uPatchScale, uPatchStretch;
uniform vec3 uRustColor; uniform float uRustAmt, uRustThr, uRustBreak, uRustPool, uRustSpatter, uSpatterScale, uRustDapple;
uniform vec3 uAlgaeColor; uniform float uAlgaeAmt, uAlgaeThr;
uniform vec3 uSpotColor; uniform float uSpotAmt, uSpotThr, uSpotScale, uSpotCluster;
uniform float uDabAmt, uDabScale, uDabWarm;
uniform float uStrokeAmt, uStrokeScale, uStrokeStretch; uniform vec3 uStrokeDir;
uniform float uGrainAmt, uGrainScale;
`,
  glsl: AA_GLSL,
  uniforms: o => ({
    uPatchScale: { value: o.patchScale }, uPatchStretch: { value: o.patchStretch },
    uRustColor: { value: colorOf(o.rustColor) }, uRustAmt: { value: o.rustAmt }, uRustThr: { value: o.rustThr },
    uRustBreak: { value: o.rustBreak }, uRustPool: { value: o.rustPool }, uRustSpatter: { value: o.rustSpatter }, uSpatterScale: { value: o.spatterScale }, uRustDapple: { value: o.rustDapple },
    uAlgaeColor: { value: colorOf(o.algaeColor) }, uAlgaeAmt: { value: o.algaeAmt }, uAlgaeThr: { value: o.algaeThr },
    uSpotColor: { value: colorOf(o.spotColor) }, uSpotAmt: { value: o.spotAmt }, uSpotThr: { value: o.spotThr }, uSpotScale: { value: o.spotScale }, uSpotCluster: { value: o.spotCluster },
    uDabAmt: { value: o.dabAmt }, uDabScale: { value: o.dabScale }, uDabWarm: { value: o.dabWarm },
    uStrokeAmt: { value: o.strokeAmt }, uStrokeScale: { value: o.strokeScale }, uStrokeStretch: { value: o.strokeStretch }, uStrokeDir: { value: vec3Of(o.strokeDir) },
    uGrainAmt: { value: o.grainAmt }, uGrainScale: { value: o.grainScale },
  }),
  surface: /* glsl */`
float toonPx = max( length( fwidth( vToonObj ) ), 1e-5 );   // 一个像素覆盖的物体单位
if ( uDabAmt > 0.0 ) {
  // 植被斑驳：两层噪声三档量化 → 暗 / 中 / 亮（亮档偏黄绿）
  vec3 Q = vToonObj * uDabScale;
  float d1 = toonNoise( Q ), d2 = toonNoise( Q * 2.2 + 17.0 );
  float fade = 1.0 - smoothstep( 0.5, 1.2, toonPx * uDabScale * 2.2 );
  float dark = 1.0 - toonAA( -0.18, d1 );
  float lit = toonAA( 0.24, d2 ) * ( 1.0 - dark );
  vec3 warm = mix( vec3( 1.0 ), vec3( 1.13, 1.12, 0.78 ), uDabWarm );
  diffuseColor.rgb *= mix( vec3( 1.0 ), mix( vec3( 1.0 - uDabAmt * 1.3 ), warm * ( 1.0 + uDabAmt * 0.6 ), lit ), max( dark, lit ) * fade );
}
if ( uStrokeAmt > 0.0 ) {
  // 干笔笔触：沿 uStrokeDir 拉长的噪声 → 三档（压暗 / 不动 / 提亮）
  vec3 Q = vToonObj * uStrokeScale;
  vec3 sd = normalize( uStrokeDir );
  Q -= sd * dot( Q, sd ) * uStrokeStretch;
  float n = toonNoise( Q + 5.3 );
  float fade = 1.0 - smoothstep( 0.35, 0.9, toonPx * uStrokeScale * 3.0 );
  float s = toonAA( 0.32, n ) - toonAA( 0.32, - n );
  diffuseColor.rgb *= 1.0 + uStrokeAmt * s * fade;
}
if ( uGrainAmt > 0.0 ) {
  float g = toonNoise( vToonObj * uGrainScale + 91.0 );
  float fade = 1.0 - smoothstep( 0.25, 0.7, toonPx * uGrainScale );
  diffuseColor.rgb *= 1.0 + uGrainAmt * g * fade;
}
if ( uRustAmt + uAlgaeAmt + uSpotAmt > 0.0 ) {
  vec3 P = vToonObj * uPatchScale;
  P.x *= uPatchStretch;
  vec3 w = vec3( toonNoise( P * 0.6 + 1.3 ), toonNoise( P * 0.6 + 7.1 ), toonNoise( P * 0.6 + 13.7 ) );
  float hf = toonNoise( vToonObj * uPatchScale * vec3( 5.0 * uPatchStretch, 7.5, 7.5 ) + 3.1 );   // 撕边用的高频
  float hfFade = 1.0 - smoothstep( 0.4, 1.1, toonPx * uPatchScale * 7.5 );
  // 锈斑：撕边 + 积色边 + 斑心 + 斑外甩点
  float hf2 = toonNoise( vToonObj * uPatchScale * vec3( 15.0 * uPatchStretch, 19.0, 19.0 ) + 11.0 );   // 海绵点
  float hf2Fade = 1.0 - smoothstep( 0.4, 1.0, toonPx * uPatchScale * 19.0 );
  float nR = toonFbm( P + w * 0.9 ) + hf * uRustBreak * hfFade + hf2 * uRustDapple * hf2Fade;
  float rust = toonAA( uRustThr, nR );
  float pool = rust * ( 1.0 - toonAA( uRustThr + 0.055, nR ) );
  float core = toonAA( uRustThr + 0.19, nR + hf * 0.05 * hfFade );
  float sp = toonNoise( vToonObj * uPatchScale * uSpatterScale * vec3( uPatchStretch, 1.0, 1.0 ) + 77.0 );
  float spBand = toonSS( uRustThr - 0.16, uRustThr - 0.02, nR ) * ( 1.0 - rust );
  float spFade = 1.0 - smoothstep( 0.35, 0.9, toonPx * uPatchScale * uSpatterScale );
  float spat = toonAA( 0.32, sp ) * spBand * spFade * uRustSpatter;
  vec3 rustC = mix( uRustColor, uRustColor * vec3( 1.14, 1.1, 1.06 ), toonAA( 0.28, hf2 ) * hf2Fade );   // 斑里一层浅色洗
  diffuseColor.rgb = mix( diffuseColor.rgb, rustC, clamp( rust + spat, 0.0, 1.0 ) * uRustAmt );
  diffuseColor.rgb = mix( diffuseColor.rgb, uRustColor * vec3( 0.74, 0.68, 0.84 ), pool * uRustPool * uRustAmt );
  diffuseColor.rgb = mix( diffuseColor.rgb, uRustColor * vec3( 0.55, 0.5, 0.62 ), core * uRustAmt * 0.72 );
  // 藻斑：撕边
  float nA = toonFbm( P * 1.6 - w * 0.7 + 31.0 ) + hf * 0.05 * hfFade;
  float alg = toonAA( uAlgaeThr, nA ) * ( 1.0 - rust );
  diffuseColor.rgb = mix( diffuseColor.rgb, uAlgaeColor, alg * uAlgaeAmt );
  // 深色小斑点：成簇（低频簇掩膜），太小时淡出
  float nS = toonNoise( vToonObj * uPatchScale * uSpotScale * vec3( uPatchStretch, 1.0, 1.0 ) + w * 0.4 + 57.0 );
  float cl = mix( 1.0, toonSS( 0.05, 0.35, toonNoise( P * 1.7 + 41.0 ) ), uSpotCluster );
  float sFade = 1.0 - smoothstep( 0.45, 1.0, toonPx * uPatchScale * uSpotScale );
  float spot = toonAA( uSpotThr, nS ) * cl * sFade;
  diffuseColor.rgb = mix( diffuseColor.rgb, uSpotColor, spot * uSpotAmt );
}
`,
};

export const muralLayer = {
  defaults: {
    muralAmt: 0, muralScale: 0.06, muralGround: '#e0d4bc', stainTint: [0.62, 0.55, 0.62],
    fleckThr: 0.42, fleckAmt: 0.55, fleckFreq: 8, chipThr: 0.36, chipAmt: 0.55, fadeAmt: 0.3, stainAmt: 0.4, dotAmt: 0.45,
  },
  pars: /* glsl */`
uniform float uMuralAmt, uMuralScale, uFleckThr, uFleckAmt, uFleckFreq, uChipThr, uChipAmt, uFadeAmt, uStainAmt, uDotAmt;
uniform vec3 uMuralGround, uStainTint;
`,
  uniforms: o => ({
    uMuralAmt: { value: o.muralAmt }, uMuralScale: { value: o.muralScale }, uMuralGround: { value: colorOf(o.muralGround) }, uStainTint: { value: vec3Of(o.stainTint) },
    uFleckThr: { value: o.fleckThr }, uFleckAmt: { value: o.fleckAmt }, uFleckFreq: { value: o.fleckFreq }, uChipThr: { value: o.chipThr }, uChipAmt: { value: o.chipAmt },
    uFadeAmt: { value: o.fadeAmt }, uStainAmt: { value: o.stainAmt }, uDotAmt: { value: o.dotAmt },
  }),
  vars: /* glsl */`
vec3 toonMuralP = vToonObj;     // 钩子可写：风化噪声坐标
float toonMuralK = 1.0;         // 钩子可写：本像素风化量倍率
`,
  post: /* glsl */`
if ( uMuralAmt > 0.0 ) {         // 只按 uniform 分支：toonMuralK 可以逐像素变，放进条件里 fwidth 就是非一致控制流里的导数（未定义）
  vec3 Pm = toonMuralP * uMuralScale;
  float amt = uMuralAmt * max( toonMuralK, 0.0 );   // K = 0 时下面每一步都 mix(x, y, 0) = x，不改色
  // 1) 褪色大斑：颜料层变薄，向地仗色靠（软边，分两档）
  float fn = toonFbm( Pm * 0.45 + vec3( 3.1, 7.7, 1.3 ) );
  float fa = max( fwidth( fn ), 1e-4 );
  float fade = 0.55 * smoothstep( 0.02 - fa, 0.02 + fa, fn ) + 0.45 * smoothstep( 0.22 - fa, 0.22 + fa, fn );
  diffuseColor.rgb = mix( diffuseColor.rgb, mix( diffuseColor.rgb, uMuralGround, 0.55 ), fade * uFadeAmt * amt );
  // 2) 干笔飞白：细碎小白点（高频两层，硬边）
  vec3 Q = Pm * uFleckFreq + vec3( 11.0, -4.0, 2.0 );
  float fl = 0.75 * toonNoise( Q ) + 0.45 * toonNoise( Q * 2.6 + 5.0 );
  float afl = max( fwidth( fl ), 1e-4 );
  float farK = 1.0 - smoothstep( 0.3, 0.75, length( fwidth( Q ) ) );
  float flake = smoothstep( uFleckThr - afl, uFleckThr + afl, fl ) * farK;
  // 2b) 剥落块：偶尔一块大些的，露出地仗
  vec3 Q2 = Pm * 1.5 + vec3( -7.0, 13.0, 5.0 );
  float ch = toonFbm( Q2 ) + 0.25 * toonNoise( Q2 * 4.0 );
  float ach = max( fwidth( ch ), 1e-4 );
  float chip = smoothstep( uChipThr - ach, uChipThr + ach, ch );
  diffuseColor.rgb = mix( diffuseColor.rgb, uMuralGround, max( flake * uFleckAmt, chip * uChipAmt ) * amt );
  // 3) 氧化暗斑
  float sn = toonFbm( Pm * 0.8 + vec3( 21.0, 3.0, 9.0 ) );
  float sa = max( fwidth( sn ), 1e-4 );
  float stain = smoothstep( 0.3 - sa, 0.3 + sa, sn ) * ( 1.0 - flake ) * ( 1.0 - chip );
  diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * uStainTint, stain * uStainAmt * amt );
  // 4) 细碎点：深浅两种
  vec3 D = Pm * uFleckFreq * 1.9 + vec3( 57.0 );
  float dn = toonNoise( D ), da = max( fwidth( dn ), 1e-4 );
  float farD = 1.0 - smoothstep( 0.3, 0.7, length( fwidth( D ) ) );
  float dk = smoothstep( 0.62 - da, 0.62 + da, dn ) * farD, dl = smoothstep( 0.62 - da, 0.62 + da, - dn ) * farD;
  diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 0.55, 0.5, 0.6 ), dk * uDotAmt * amt );
  diffuseColor.rgb = mix( diffuseColor.rgb, uMuralGround, dl * uDotAmt * 0.6 * amt );
}
`,
};
