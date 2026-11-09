// 舞台合成器：两遍渲染 + 一个全屏合成着色器，把同一条鲲按“五层”画出来（站点专用，移植自 lab/kun_qinglv.js）。
//
//   ① 彩色通道（toon pass 0）：三色分档卡通着色，MSAA，HalfFloat 线性，清成全透明（结果是预乘 alpha）
//   ② 法线通道（toon pass 1）：视空间法线 × 描边权重 + 物体 / 实例编号，带深度纹理
//   ③ 合成：按层权重把下面几样叠起来，输出预乘 alpha 的 sRGB 到透明画布
//        形  法线缓冲算出的素模明暗（受光面纸色，暗面混进 --ink-mute）+ --ink-soft 的外轮廓（对纸色 ≥ 3:1）与略淡的结构线
//        光  彩色通道本身
//        笔  墨线（深度 / 法线 / 物体编号三种边缘，近的一侧拥有这条线，一拍二抖动）+ 纸纹颗粒（engine/look/paper.js）
//        景  天空铺满画布 + 空气透视薄雾（engine/look/fog.js 的 FOG_GLSL）
//        时  画面同“景”，区别在鲲的动作一拍三（由 stage.js 在 CPU 上量化姿态时间）
//
//   createCompositor(renderer, { msaa }) → {
//     setSize(w, h)                       画布实际像素（drawing buffer）
//     render(scene, camera, p)            p 见 render() 头部注释
//     sky                                 天空贴图（setSky 之后）
//     setSky(texture, aspect)
//     restore()                           WebGL 上下文恢复后调用：丢掉旧上下文里的渲染目标与纸纹（不 dispose），下次 setSize 重建
//     dispose()
//   }
// 只依赖 three 与 engine/look 的公共模块；墨线算法与 lab/kun_qinglv.js 合成着色器一致（像素量改成按 1080 高度标定）。
import * as THREE from 'three';
import { createFullscreen } from '@engine/look/pass.js';
import { createPaper } from '@engine/look/paper.js';
import { FOG_GLSL, fogUniforms, setFog } from '@engine/look/fog.js';
import { linVec } from '@engine/look/params.js';
import { setToonGlobals } from '@film/toon_qinglv.js';

const COMPOSE_FS = /* glsl */`
#include <packing>
${FOG_GLSL}
uniform sampler2D tC, tN, tD, tSky, tPaper;
uniform vec2 uRes, uPaperSize;
uniform float uNear, uFar, uInkT, uK;
uniform float uLW, uLWv, uJit;                         // 线宽、线宽起伏、抖动（1080 高度下的像素）
uniform float uToon, uLineForm, uInkAmt, uGrain, uSky, uHaze;   // 各层权重
uniform float uPaperMid;
uniform vec2 uLineFade;                                 // 墨线随距离变淡的区间（视空间深度）
uniform vec3 uInk, uLineInk, uClayLit, uClayShade, uClayDeep, uLightV;
uniform vec4 uSkyUV;
uniform float uSkyFlip;                                 // ImageBitmap 没翻转：采样时翻 v
varying vec2 vUv;

float vz( vec2 uv ) { return - perspectiveDepthToViewZ( texture2D( tD, uv ).x, uNear, uFar ); }
// lab/kun_qinglv.js 合成里的浮点哈希与值噪声（抖动用，按拍取种子）
float lh( vec2 p ) { p = fract( p * vec2( 0.1031, 0.1030 ) ); p += dot( p, p.yx + 33.33 ); return fract( ( p.x + p.y ) * p.x ); }
float ln2( vec2 p ) { vec2 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( lh( i ), lh( i + vec2( 1, 0 ) ), f.x ), mix( lh( i + vec2( 0, 1 ) ), lh( i + vec2( 1, 1 ) ), f.x ), f.y ); }

void main() {
  vec2 px = 1.0 / uRes;
  vec2 fp = vUv * uRes / uK;                           // 换算到 1080 高度的像素坐标：换分辨率，抖动与线宽看起来一样
  vec4 c = texture2D( tC, vUv );
  float a = c.a;

  // —— 墨线：深度 / 法线 / 物体编号三种边缘（lab/kun_qinglv.js 的算法），检测坐标一拍二抖动 ——
  vec2 j = ( vec2( ln2( fp / 11.0 + uInkT * 7.31 ), ln2( fp / 11.0 + 31.0 + uInkT * 5.17 ) ) - 0.5 ) * 2.0 * uJit * uK * px;
  vec2 uv = vUv + j;
  vec4 n0 = texture2D( tN, uv ); float z0 = vz( uv );
  vec3 m0 = n0.xyz * 2.0 - 1.0; float w0 = length( m0 ); m0 /= max( w0, 1e-4 );
  float lw = max( 1.0, ( uLW + uLWv * ln2( fp / 30.0 + uInkT * 3.3 ) ) * uK );
  float e = 0.0, bg = 0.0;                             // bg：邻居里有没有空白（外轮廓）
  vec3 nAcc = vec3( 0.0 );
  for ( int i = 0; i < 8; i ++ ) {
    float ang = float( i ) * 0.7853982;
    vec2 o = vec2( cos( ang ), sin( ang ) ) * px * lw;
    vec4 n1 = texture2D( tN, uv + o ); float z1 = vz( uv + o );
    float dz = ( z1 - z0 ) / max( min( z0, z1 ), 1.0 );
    float de = smoothstep( 0.012, 0.03, dz );
    vec3 m1 = n1.xyz * 2.0 - 1.0; float w1 = length( m1 ); m1 /= max( w1, 1e-4 );
    float has1 = step( 0.001, n1.a );
    bg = max( bg, 1.0 - has1 );
    nAcc += m1 * has1;
    float dn = smoothstep( 0.45, 0.7, 1.0 - dot( m0, m1 ) ) * has1;
    float di = step( 0.003, abs( n0.a - n1.a ) ) * step( z0, z1 + 0.5 );
    e = max( e, max( de, max( dn * 0.75, di * 0.9 ) * smoothstep( 0.3, 1.0, w0 ) ) );
  }
  e *= step( 0.001, n0.a );
  float la = mix( 0.95, 0.5, smoothstep( uLineFade.x, uLineFade.y, z0 ) );   // 远处的线淡一些

  // —— 形：法线缓冲的素模明暗（不抖动的那一份法线；边上 MSAA 半覆盖的像素借邻居法线）——
  vec4 nS = texture2D( tN, vUv );
  vec3 mS = nS.xyz * 2.0 - 1.0; float wS = length( mS );
  vec3 nC = ( nS.a > 0.001 && wS > 1e-3 ) ? mS / wS : ( length( nAcc ) > 1e-3 ? normalize( nAcc ) : vec3( 0.0, 0.0, 1.0 ) );
  float hl = 0.5 + 0.5 * dot( nC, uLightV );
  vec3 clay = mix( uClayShade, uClayLit, smoothstep( 0.2, 0.9, hl ) );
  clay = mix( clay, uClayDeep, pow( 1.0 - clamp( nC.z, 0.0, 1.0 ), 3.0 ) * 0.45 );   // 侧面转过去的地方压一点淡墨
  // 外轮廓用满浓度（对纸色 ≥ 3:1，看得出形），内部的结构线略淡（0.85），小尺寸时仙岛上不至于一团乱线
  clay = mix( clay, uLineInk, max( e * 0.85, bg * step( 0.001, n0.a ) ) * uLineForm );

  // —— 光：彩色通道（预乘 → 直通）——
  vec3 sc = a > 0.001 ? c.rgb / a : clay;
  vec3 obj = mix( clay, sc, uToon );

  // —— 景：天空与空气透视 ——
  vec2 suv = vUv * uSkyUV.xy + uSkyUV.zw;
  if ( uSkyFlip > 0.5 ) suv.y = 1.0 - suv.y;
  vec3 skyc = texture2D( tSky, suv ).rgb;
  float d = texture2D( tD, vUv ).x;
  vec3 vp = viewPosAt( vUv, min( d, 0.9999999 ) );
  vec3 wp = ( uCamWorld * vec4( vp, 1.0 ) ).xyz;
  vec3 dirW = normalize( ( uCamWorld * vec4( vp, 0.0 ) ).xyz );
  float fogA = fogAmount( length( vp ), wp.y ) * step( 0.001, nS.a ) * uHaze;
  obj = mix( obj, mix( fogColor( dirW ), skyc, 0.35 ), fogA );

  // —— 笔：墨线 + 纸纹 ——
  obj = mix( obj, uInk, e * la * uInkAmt * ( 1.0 - 0.6 * fogA ) );
  float pp = texture2D( tPaper, gl_FragCoord.xy / uPaperSize ).r;
  float g = 1.0 + uGrain * 2.0 * ( pp - uPaperMid );
  obj *= g;
  skyc *= g;

  // —— 叠到天空上（预乘），换到 sRGB 后再乘 alpha：浏览器按 sRGB 预乘合成到纸面 ——
  vec3 rgbP = obj * a + skyc * ( 1.0 - a ) * uSky;
  float A = a + ( 1.0 - a ) * uSky;
  gl_FragColor = vec4( A > 1e-4 ? rgbP / A : vec3( 0.0 ), 1.0 );
  #include <colorspace_fragment>
  gl_FragColor = vec4( clamp( gl_FragColor.rgb, 0.0, 1.0 ) * A, A );
}`;

// 素模的三种颜色（sRGB）：受光的纸色、暗面、侧面转过去的深一档。暗面与侧面在原来的淡墨（#ABA3BE、#7F7A9E）里
// 混进 40% 的 --ink-mute（#585A7E）：原来“形”这一层在纸上几乎看不见（鲲所在区域对纸色 99 分位只有 2.0:1，
// WCAG 1.4.11 要求理解内容所需的图形 ≥ 3:1）。结构线用 --ink-soft（#4A4D74），浓度由 stage 给（1：外轮廓上就是
// --ink-soft 本色，对纸色 6.8:1；0.8 时混出来只有约 3.2:1，抗锯齿的边上更低）。
const CLAY = { lit: '#EFE6D6', shade: '#8A86A4', deep: '#6F6D91', line: '#4A4D74' };

export function createCompositor(renderer, { msaa = 4 } = {}) {
  const fx = createFullscreen(renderer);
  let paper = createPaper(fx, renderer, { refHeight: 1080 });
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); blank.needsUpdate = true;
  const U = {
    ...fogUniforms(),
    tC: { value: null }, tN: { value: null }, tD: { value: null }, tSky: { value: blank }, tPaper: { value: null },
    uRes: { value: new THREE.Vector2(1, 1) }, uPaperSize: { value: new THREE.Vector2(1, 1) }, uPaperMid: { value: 0.5 },
    uNear: { value: 5 }, uFar: { value: 6000 }, uInkT: { value: 0 }, uK: { value: 1 },
    uLW: { value: 1.9 }, uLWv: { value: 0.7 }, uJit: { value: 0.6 },
    uToon: { value: 1 }, uLineForm: { value: 0 }, uInkAmt: { value: 1 }, uGrain: { value: 0.12 }, uSky: { value: 1 }, uHaze: { value: 1 },
    uInk: { value: linVec('#2A2D52') }, uLineInk: { value: linVec(CLAY.line) },
    uClayLit: { value: linVec(CLAY.lit) }, uClayShade: { value: linVec(CLAY.shade) }, uClayDeep: { value: linVec(CLAY.deep) },
    uLightV: { value: new THREE.Vector3(-0.45, 0.6, 0.66).normalize() },
    uSkyUV: { value: new THREE.Vector4(1, 1, 0, 0) }, uSkyFlip: { value: 0 }, uLineFade: { value: new THREE.Vector2(500, 1600) },
  };
  const mat = fx.material(COMPOSE_FS, U);
  let rtC = null, rtN = null, W = 0, H = 0, samples = msaa, sky = null;

  function alloc() {
    rtC?.dispose(); rtN?.dispose();
    rtC = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples });
    rtN = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthTexture: new THREE.DepthTexture(W, H, THREE.FloatType) });
    U.tC.value = rtC.texture; U.tN.value = rtN.texture; U.tD.value = rtN.depthTexture;
    U.uRes.value.set(W, H); U.uK.value = H / 1080;
    paper.resize(W, H);
  }

  function setSize(w, h) {
    w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
    if (w === W && h === H) return;
    W = w; H = h; alloc();
  }

  function setSamples(n) { if (n !== samples) { samples = n; if (W) alloc(); } }

  /**
   * p = {
   *   toon 0..1     形 → 光（0 = 素模，1 = 卡通色）       lineForm 0..1  素模上的结构线浓度
   *   ink 0..1      墨线                                  grain          纸纹强度（0 关；影片默认 0.12）
   *   sky 0..1      天空铺满                              haze 0..1      空气透视雾
   *   inkT          抖动种子（一拍二：floor(帧 / 2)）     skyUV          Vector4（缩放 xy、偏移 zw）
   *   fog           engine/look/fog.js 的雾参数           shadow         这一帧是否刷新阴影贴图
   *   target        输出目标（默认 null = 画布）
   *   composite     false = 只画两遍、不合成（预热用）
   *   only          'color' | 'normal'：只画其中一遍、不合成（预热用）
   * }
   */
  function render(scene, camera, p) {
    paper.prepare();
    const layer = paper.layer({ strength: p.grain ?? 0 });
    U.tPaper.value = layer.tex; U.uPaperSize.value.set(layer.w, layer.h); U.uPaperMid.value = layer.mid;
    U.uToon.value = p.toon; U.uLineForm.value = p.lineForm; U.uInkAmt.value = p.ink; U.uGrain.value = layer.strength;
    U.uSky.value = p.sky; U.uHaze.value = p.haze; U.uInkT.value = p.inkT;
    if (p.skyUV) U.uSkyUV.value.copy(p.skyUV);
    if (p.lineFade) U.uLineFade.value.set(p.lineFade[0], p.lineFade[1]);
    U.uNear.value = camera.near; U.uFar.value = camera.far;
    setFog(U, p.fog, camera, '#9C8FD8');

    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 0);
    // ① 彩色通道（只有这一遍刷新阴影）
    if (p.only !== 'normal') {
      renderer.shadowMap.needsUpdate = !!p.shadow;
      setToonGlobals({ pass: 0 });
      renderer.setRenderTarget(rtC); renderer.clear(true, true, true); renderer.render(scene, camera);
      renderer.shadowMap.needsUpdate = false;
    }
    // ② 法线 + 编号通道
    if (p.only !== 'color') {
      setToonGlobals({ pass: 1 });
      renderer.setRenderTarget(rtN); renderer.clear(true, true, true); renderer.render(scene, camera);
      setToonGlobals({ pass: 0 });
    }
    // ③ 合成（预热管线时可以跳过）
    if (p.composite !== false && !p.only) fx.draw(mat, p.target ?? null);
    renderer.autoClear = prevAuto;
  }

  function setSky(tex) { sky = tex; U.tSky.value = tex || blank; U.uSkyFlip.value = tex?.userData?.flipV ? 1 : 0; }
  // 上下文恢复：three 已经换了一套新的 GL 状态，旧的渲染目标、纸纹目标里存的是旧上下文的 GL 对象，
  // 对它们调 dispose 会在新上下文上删旧对象，控制台刷“object does not belong to this context”。只丢引用，下次 setSize 重建。
  function restore() {
    rtC = rtN = null; W = H = 0;
    U.tC.value = U.tN.value = U.tD.value = null;
    paper = createPaper(fx, renderer, { refHeight: 1080 });
  }
  // 纸纹：尺寸变了要重画一次并回读均值（同步回读，趁 GPU 空闲时做）
  function prepare() { if (W) paper.prepare(); }

  function dispose() {
    rtC?.dispose(); rtN?.dispose(); mat.dispose(); paper.dispose(); fx.dispose(); blank.dispose();
  }

  return {
    setSize, setSamples, render, setSky, prepare, restore, dispose, uniforms: U,
    get size() { return { w: W, h: H }; },
    get targets() { return { color: rtC, normal: rtN }; },
    get sky() { return sky; },
    get material() { return mat; },
  };
}
