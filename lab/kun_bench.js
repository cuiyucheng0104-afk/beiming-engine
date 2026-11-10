// lab/kun_bench.js — 鲲自测页（lab/kun.js 和各变体页 lab/kun_*.js）的共用部分。不是自测页本身（?test= 不要指它）。
// 各页只写自己的：用哪个 createKun、额外机位、怎么摆姿态（翅膀时钟、飘带时钟、看镜头……）、调试参数。
//
//   labRenderer(PR)                    渲染器（像素比 PR、软阴影、sRGB 输出、不做色调映射），挂到页面上 → { renderer, W, H, RW, RH }
//   kunStats(tag, kun, extra)          控制台打三角形数与实例数
//   keyLight(scene, setToonGlobals)    主光：破晓低角度逆光（东偏南、略高于地平线）；城市暖光自下而上 → { key, KEY_DIR }
//   inkComposite({ RW, RH, W, H, PALETTE, q, ink2 })   彩色（MSAA）+ 法线/ID（带深度）两张渲染目标、天空图、
//                                      屏幕空间描边合成（深度 + 法线 + 物体/实例 ID，一拍二抖动，空气透视）→ { rtC, rtN, sky, comp, skyCover }
//       skyCover(zoom, ox, oy)         天空图按 cover 铺满画面（比例从图本身取，换图不会拉伸）
//       ink2 = true                    手绘感更强的描边（笔压起伏、偶尔断笔、墨色吸一点底色；lab/kun_refine.js 的 &ink=2）
//   BASE_VIEWS                         默认三段机位：0–1.5 大远景侧面 / 1.5–3.0 渡船甲板仰视 / 3.0–4.0 眼睛特写
//   baseExtra(ev)                      &view= 固定机位 top / far / side / eye / under / reveal（reveal 盯着 ev = 眼睛世界坐标）
//   pickView(views, extra, t, dur)     按时间或固定机位取机位，返回 { v, k }（k = 段内进度 0..1）
//   eyeCloseup(camera, kun, ev, k)     眼睛特写机位：从眼睛外侧略偏下看
//   frameTimes(t)                      → { fr, ts, inkT }：帧号、鲲一拍三的时间、墨线一拍二的拍号（engine/core/clock.js）
//   drawPasses({ renderer, scene, camera, comp, rtC, rtN, setToonGlobals, inkT })   三遍：彩色 → 法线/ID → 合成到屏幕
// 描边只是自测用的临时做法；正片的描边在后期（src/look.js → engine/look）。
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { frameOf, heldTime, hold } from '../engine/core/clock.js';

// 被当成自测页直接打开（?test=kun_bench）时立刻报错，不让页面一直等不到 READY
if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('test') === 'kun_bench')
  throw new Error('lab/kun_bench.js 是鲲自测页的共用部分，不是自测页：请用 ?test=kun、kun_refine、kun_qinglv、kun_xuan、kun_bronze 或 kun_peng');

export const SKY_URL = './assets/ref/sky_test.png';
export const lerpN = (a, b, k) => a + (b - a) * k;

export function labRenderer(PR = 2) {
  const W = innerWidth, H = innerHeight, RW = W * PR, RH = H * PR;
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(PR); renderer.setSize(W, H);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
  document.body.appendChild(renderer.domElement);
  return { renderer, W, H, RW, RH };
}

export function kunStats(tag, kun, extra = '') {
  let tri = 0; const inst = [];
  kun.group.traverse(o => { if (!o.isMesh) return; const g = o.geometry, t = (g.index ? g.index.count : g.attributes.position.count) / 3, n = o.isInstancedMesh ? o.count : 1; tri += t * n; if (o.isInstancedMesh) inst.push(`${o.name}:${o.count}`); });
  console.warn(`[${tag}] 三角形 ${(tri / 1e6).toFixed(2)} M；实例 ${inst.join(' ')}${extra}`);
}

// 主光只用来定方向：fitShadow 会把灯和阴影相机摆到鲲身上；鲲朝东（+X）游
export function keyLight(scene, setToonGlobals) {
  const KEY_DIR = new THREE.Vector3(0.75, 0.1, 0.65).normalize();
  const key = new THREE.DirectionalLight('#ffd3b0', 1);
  key.position.copy(KEY_DIR); key.target.position.set(0, 0, 0);
  scene.add(key, key.target);
  setToonGlobals({ fillDir: [0.08, -1, 0.1], keyDir: KEY_DIR.toArray() });
  return { key, KEY_DIR };
}

export async function loadSky(url = SKY_URL) {
  try { return await new THREE.TextureLoader().loadAsync(url); }
  catch { throw new Error(`天空图加载失败：${url}`); }
}

const COMP_FS = /* glsl */`
    #include <packing>
    uniform sampler2D tC, tN, tD, tSky; uniform vec2 res; uniform float near, far, inkT, hazeK, inkOn, showPass;
    uniform vec3 ink, haze; uniform vec4 skyUV; varying vec2 vUv;
    float vz( vec2 uv ) { return - perspectiveDepthToViewZ( texture2D( tD, uv ).x, near, far ); }
    float h21( vec2 p ) { p = fract( p * vec2( 0.1031, 0.1030 ) ); p += dot( p, p.yx + 33.33 ); return fract( ( p.x + p.y ) * p.x ); }
    float n2( vec2 p ) { vec2 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
      return mix( mix( h21( i ), h21( i + vec2( 1, 0 ) ), f.x ), mix( h21( i + vec2( 0, 1 ) ), h21( i + vec2( 1, 1 ) ), f.x ), f.y ); }
    void main() {
      vec4 c = texture2D( tC, vUv );
      vec3 skyc = texture2D( tSky, vUv * skyUV.xy + skyUV.zw ).rgb;
      if ( showPass > 0.5 ) { vec4 n = texture2D( tN, vUv ); gl_FragColor = vec4( mix( n.rgb, vec3( n.a ), step( 0.5, fract( vUv.x * 2.0 ) ) ), 1.0 ); return; }
      vec2 px = 1.0 / res;
      // 手绘抖动：每两帧换一次（inkT = floor(frame/2)）
      vec2 j = ( vec2( n2( vUv * res / 22.0 + inkT * 7.31 ), n2( vUv * res / 22.0 + 31.0 + inkT * 5.17 ) ) - 0.5 ) * 2.4 * px;
      vec2 uv = vUv + j;
      vec4 n0 = texture2D( tN, uv ); float z0 = vz( uv );
      vec3 m0 = n0.xyz * 2.0 - 1.0; float w0 = length( m0 ); m0 /= max( w0, 1e-4 );   // 法线长度 = 描边权重
      #ifdef INK2
        // 笔压：沿屏幕低频噪声起伏 ±40%；断笔：偶尔一小段线变淡
        float press = 0.62 + 0.76 * n2( vUv * res / 90.0 + inkT * 2.1 );
        float lw = 3.4 * press;
      #else
        float lw = 3.2 + 1.2 * n2( vUv * res / 60.0 + inkT * 3.3 );   // 线宽（渲染像素，PR=2）略有粗细起伏
      #endif
      float e = 0.0;
      for ( int i = 0; i < 8; i ++ ) {
        float a = float( i ) * 0.7853982;
        vec2 o = vec2( cos( a ), sin( a ) ) * px * lw;
        vec4 n1 = texture2D( tN, uv + o ); float z1 = vz( uv + o );
        float dz = ( z1 - z0 ) / max( min( z0, z1 ), 1.0 );
        float de = smoothstep( 0.012, 0.03, dz );                                   // 只在近的一侧画轮廓线
        vec3 m1 = n1.xyz * 2.0 - 1.0; float w1 = length( m1 ); m1 /= max( w1, 1e-4 );
        float dn = smoothstep( 0.45, 0.7, 1.0 - dot( m0, m1 ) ) * step( 0.001, n1.a );
        float di = step( 0.003, abs( n0.a - n1.a ) ) * step( z0, z1 + 0.5 );           // 物体 / 实例分界
        #ifdef INK2
          e = max( e, max( de * mix( 0.45, 1.0, smoothstep( 0.2, 0.9, w0 ) ), max( dn * 0.75, di * 0.9 ) * smoothstep( 0.3, 1.0, w0 ) ) );
        #else
          e = max( e, max( de, max( dn * 0.75, di * 0.9 ) * smoothstep( 0.3, 1.0, w0 ) ) );
        #endif
      }
      e *= step( 0.001, n0.a ) * inkOn;
      #ifdef INK2
        e *= mix( 0.35, 1.0, smoothstep( 0.18, 0.3, n2( vUv * res / 140.0 + 17.0 + inkT * 1.3 ) ) );
      #endif
      float la = mix( 0.95, 0.5, smoothstep( 500.0, 1600.0, z0 ) );
      vec3 sc = c.a > 0.001 ? c.rgb / c.a : vec3( 0.0 );
      float fogA = ( 1.0 - exp( - z0 * hazeK ) ) * step( 0.001, n0.a );
      sc = mix( sc, haze, fogA * 0.55 );
      vec3 col = skyc * ( 1.0 - c.a ) + sc * c.a;
      #ifdef INK2
        vec3 inkc = mix( ink, min( col, ink ) * 0.6 + col * 0.12, 0.25 );
        col = mix( col, inkc, e * la );
      #else
        col = mix( col, ink, e * la );
      #endif
      gl_FragColor = vec4( col, 1.0 );
      #include <colorspace_fragment>
    }`;

export async function inkComposite({ RW, RH, W, H, PALETTE, q, ink2 = false }) {
  const rtC = new THREE.WebGLRenderTarget(RW, RH, { type: THREE.HalfFloatType, samples: 4 });
  const rtN = new THREE.WebGLRenderTarget(RW, RH, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(RW, RH, THREE.FloatType) });
  const sky = await loadSky();
  sky.colorSpace = THREE.SRGBColorSpace;
  const comp = new FullScreenQuad(new THREE.ShaderMaterial({
    uniforms: {
      tC: { value: rtC.texture }, tN: { value: rtN.texture }, tD: { value: rtN.depthTexture }, tSky: { value: sky },
      res: { value: new THREE.Vector2(RW, RH) }, near: { value: 5 }, far: { value: 6000 }, inkT: { value: 0 },
      ink: { value: new THREE.Color(PALETTE.ink) }, haze: { value: new THREE.Color('#a497d6') }, hazeK: { value: 0.00035 },
      skyUV: { value: new THREE.Vector4(1, 1, 0, 0) }, inkOn: { value: q.get('noink') ? 0 : 1 }, showPass: { value: q.get('pass') ? 1 : 0 },
    },
    defines: ink2 ? { INK2: '' } : {},
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }',
    fragmentShader: COMP_FS,
    depthTest: false, depthWrite: false,
  }));
  // 天空图 cover 铺满：图的宽高比从图本身取
  const IA = sky.image.width / sky.image.height, SA = W / H;
  function skyCover(zoom = 1, ox = 0.5, oy = 0.5) {
    const sx = SA / IA / zoom, sy = 1 / zoom;
    comp.material.uniforms.skyUV.value.set(sx, sy, (1 - sx) * ox, (1 - sy) * oy);
    return [sx, sy, (1 - sx) * ox, (1 - sy) * oy];
  }
  return { rtC, rtN, sky, comp, skyCover };
}

// 默认三段机位（各页相同，便于横向对比）：cam / look 是段内进度 k 的函数；cam 为 null 的是眼睛特写
export const BASE_VIEWS = [
  { t0: 0, t1: 1.5, fov: 30, sky: [1, 0.5, 0.45], cam: k => [lerpN(-20, 10, k), -95, lerpN(-1010, -930, k)], look: k => [lerpN(10, 0, k), 12, 0] },
  { t0: 1.5, t1: 3, fov: 40, sky: [1.35, 0.5, 0.95], cam: k => [lerpN(50, 30, k), -300, lerpN(-170, -150, k)], look: k => [lerpN(118, 100, k), -10, 10] },
  { t0: 3, t1: 4.01, fov: 26, sky: [1.6, 0.35, 0.75], cam: null, look: null },
];
// 调试机位（&view=top：俯视 3/4 看背部和尾鳍；&view=far：镜头 A 式大远景；reveal 盯着眼睛 ev）
export const baseExtra = ev => ({
  top: { fov: 32, sky: [1, 0.5, 0.6], cam: k => [-420 + 40 * k, 330, -620], look: k => [-20, -10, 0] },
  far: { fov: 18, sky: [1, 0.5, 0.4], cam: k => [200 - 40 * k, -60, -2600], look: k => [60, 30, 0] },
  side: { fov: 30, sky: [1, 0.5, 0.45], cam: k => [0, -95, -980], look: k => [0, 12, 0] },
  eye: { fov: 26, sky: [1.6, 0.35, 0.75], cam: null, look: null },
  under: { fov: 38, sky: [1.5, 0.5, 0.9], cam: k => [80 - 30 * k, -330, -70], look: k => [80 - 30 * k, 0, -10] },
  reveal: { fov: 31, sky: [1.5, 0.5, 0.9], cam: k => [ev.x + 70 + 10 * k, ev.y - 150, ev.z - 70], look: k => [ev.x, ev.y, ev.z] },
});

export function pickView(views, forced, t, dur) {
  const v = forced ? { t0: 0, t1: dur, ...forced } : (views.find(x => t >= x.t0 && t < x.t1) || views[views.length - 1]);
  return { v, k: (t - v.t0) / (v.t1 - v.t0) };
}

export function eyeCloseup(camera, kun, ev, k) {
  kun.group.updateMatrixWorld(true);
  kun.eyeWorld(ev, -1);
  camera.position.set(ev.x + lerpN(-14, -8, k), ev.y - 22, ev.z - 92);
  camera.lookAt(ev.x - 3, ev.y + 2, ev.z);
}

// 帧号从 t 四舍五入（engine/core/clock.js）：鲲一拍三、墨线一拍二都从整数帧号量化
export function frameTimes(t) {
  const fr = frameOf(t);
  return { fr, ts: heldTime(fr, 3), inkT: hold(fr, 2) };
}

export function drawPasses({ renderer, scene, camera, comp, rtC, rtN, setToonGlobals, inkT }) {
  comp.material.uniforms.inkT.value = inkT;   // 墨线一拍二（屏幕描边）
  setToonGlobals({ inkTime: inkT });          // 材质里画的线同步抖动
  // 1) 彩色
  renderer.shadowMap.autoUpdate = true;
  setToonGlobals({ pass: 0 });
  renderer.setRenderTarget(rtC); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, camera);
  // 2) 法线 + ID（云丝在着色器里自行丢弃）
  renderer.shadowMap.autoUpdate = false;
  setToonGlobals({ pass: 1 });
  renderer.setRenderTarget(rtN); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, camera);
  setToonGlobals({ pass: 0 });
  // 3) 合成到屏幕
  renderer.setRenderTarget(null); comp.render(renderer);
}
