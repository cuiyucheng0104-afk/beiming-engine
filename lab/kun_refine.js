// 鲲·原版精修 自测页（?test=kun_refine）。背景、天空、光线、机位、描边合成全部照抄 lab/kun.js，只把鲲换成 src/kun_refine.js，便于横向对比。
// DUR = 4 秒，三个机位按时间分段（同 lab/kun.js）：0–1.5 大远景侧面 / 1.5–3.0 渡船甲板仰视 / 3.0–4.0 眼睛特写
// 可选参数（同 lab/kun.js）：&lod=0.3 &noink=1 &pass=1 &view=side|top|far|eye|under|reveal|hero|hero2|ferry &roll=-0.5 &look=1
// 本页另加：&nopine=1（不要小松）&nowhisk=1（不要龙须）&noclouds=1（不要祥云纹）&nowisps=1（不要飘带）
//           &ink=2（手绘感更强的描边：线宽按笔压起伏、偶尔断笔、墨色吸一点底色；默认 1 = 与 lab/kun.js 完全相同）
//           &post=look（改走正片的后期管线 src/look.js：ID 图描边（用鲲网格上的 userData.outlineVertex）+ Kuwahara + bloom + 调色 + 纸纹，
//                       验证“换进正片只改 import”；天空图作为 scene.background）
//           &cam=x,y,z&at=x,y,z&fov=&sky=zoom,ox,oy（自由机位）&pitch=（鲲绕 Z 轴俯仰，弧度）
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { createKun } from '../src/kun_refine.js';
import { PALETTE, setToonGlobals } from '../src/toon_refine.js';
import { createLook } from '../src/look.js';

const q = new URLSearchParams(location.search);
const POST = q.get('post') === 'look';
const W = innerWidth, H = innerHeight, PR = POST ? 1 : 2, RW = W * PR, RH = H * PR;
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(PR); renderer.setSize(W, H);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, W / H, 5, 6000);
const t0 = performance.now();
const kun = createKun({ lod: +(q.get('lod') || 1), pine: !q.get('nopine'), whiskers: !q.get('nowhisk'), clouds: !q.get('noclouds'), wisps: !q.get('nowisps') });
console.warn(`[kun_refine] 构建 ${(performance.now() - t0).toFixed(0)} ms，描边网格 ${kun.outlineMeshes.length} 个`);
{
  let tri = 0; const inst = [];
  kun.group.traverse(o => { if (!o.isMesh) return; const g = o.geometry, t = (g.index ? g.index.count : g.attributes.position.count) / 3, n = o.isInstancedMesh ? o.count : 1; tri += t * n; if (o.isInstancedMesh) inst.push(`${o.name}:${o.count}`); });
  console.warn(`[kun_refine] 三角形 ${(tri / 1e6).toFixed(2)} M；实例 ${inst.join(' ')}`);
}
scene.add(kun.group);

const KEY_DIR = new THREE.Vector3(0.75, 0.1, 0.65).normalize();
const key = new THREE.DirectionalLight('#ffd3b0', 1);
key.position.copy(KEY_DIR); key.target.position.set(0, 0, 0);
scene.add(key, key.target);
setToonGlobals({ cityDir: [0.08, -1, 0.1], keyDir: KEY_DIR.toArray() });

const rtC = new THREE.WebGLRenderTarget(RW, RH, { type: THREE.HalfFloatType, samples: 4 });
const rtN = new THREE.WebGLRenderTarget(RW, RH, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(RW, RH, THREE.FloatType) });
const sky = await new THREE.TextureLoader().loadAsync('./assets/ref/sky_test.png');
sky.colorSpace = THREE.SRGBColorSpace;

const INK2 = q.get('ink') === '2';
const comp = new FullScreenQuad(new THREE.ShaderMaterial({
  uniforms: {
    tC: { value: rtC.texture }, tN: { value: rtN.texture }, tD: { value: rtN.depthTexture }, tSky: { value: sky },
    res: { value: new THREE.Vector2(RW, RH) }, near: { value: 5 }, far: { value: 6000 }, inkT: { value: 0 },
    ink: { value: new THREE.Color(PALETTE.ink) }, haze: { value: new THREE.Color('#a497d6') }, hazeK: { value: 0.00035 },
    skyUV: { value: new THREE.Vector4(1, 1, 0, 0) }, inkOn: { value: q.get('noink') ? 0 : 1 }, showPass: { value: q.get('pass') ? 1 : 0 },
  },
  defines: INK2 ? { INK2: '' } : {},
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }',
  fragmentShader: /* glsl */`
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
      vec2 j = ( vec2( n2( vUv * res / 22.0 + inkT * 7.31 ), n2( vUv * res / 22.0 + 31.0 + inkT * 5.17 ) ) - 0.5 ) * 2.4 * px;
      vec2 uv = vUv + j;
      vec4 n0 = texture2D( tN, uv ); float z0 = vz( uv );
      vec3 m0 = n0.xyz * 2.0 - 1.0; float w0 = length( m0 ); m0 /= max( w0, 1e-4 );
      #ifdef INK2
        // 笔压：沿屏幕低频噪声起伏 ±40%；断笔：偶尔一小段线变淡
        float press = 0.62 + 0.76 * n2( vUv * res / 90.0 + inkT * 2.1 );
        float lw = 3.4 * press;
      #else
        float lw = 3.2 + 1.2 * n2( vUv * res / 60.0 + inkT * 3.3 );
      #endif
      float e = 0.0;
      for ( int i = 0; i < 8; i ++ ) {
        float a = float( i ) * 0.7853982;
        vec2 o = vec2( cos( a ), sin( a ) ) * px * lw;
        vec4 n1 = texture2D( tN, uv + o ); float z1 = vz( uv + o );
        float dz = ( z1 - z0 ) / max( min( z0, z1 ), 1.0 );
        float de = smoothstep( 0.012, 0.03, dz );
        vec3 m1 = n1.xyz * 2.0 - 1.0; float w1 = length( m1 ); m1 /= max( w1, 1e-4 );
        float dn = smoothstep( 0.45, 0.7, 1.0 - dot( m0, m1 ) ) * step( 0.001, n1.a );
        float di = step( 0.003, abs( n0.a - n1.a ) ) * step( z0, z1 + 0.5 );
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
    }`,
  depthTest: false, depthWrite: false,
}));

const IA = 1774 / 887, SA = W / H;
function skyCover(zoom = 1, ox = 0.5, oy = 0.5) {
  const sx = SA / IA / zoom, sy = 1 / zoom;
  comp.material.uniforms.skyUV.value.set(sx, sy, (1 - sx) * ox, (1 - sy) * oy);
  if (POST) { skyBg.repeat.set(sx, sy); skyBg.offset.set((1 - sx) * ox, (1 - sy) * oy); }
}
// 正片后期（&post=look）：天空图当 scene.background（同样 cover 裁切），交给 look.js
const skyBg = sky.clone(); skyBg.colorSpace = THREE.SRGBColorSpace; skyBg.needsUpdate = true;
const look = POST ? createLook(renderer, W, H, { ss: 2 }) : null;
if (POST) { scene.background = skyBg; await look.ready; }

const VIEWS = [
  { t0: 0, t1: 1.5, fov: 30, sky: [1, 0.5, 0.45], cam: k => [lerpN(-20, 10, k), -95, lerpN(-1010, -930, k)], look: k => [lerpN(10, 0, k), 12, 0] },
  { t0: 1.5, t1: 3, fov: 40, sky: [1.35, 0.5, 0.95], cam: k => [lerpN(50, 30, k), -300, lerpN(-170, -150, k)], look: k => [lerpN(118, 100, k), -10, 10] },
  { t0: 3, t1: 4.01, fov: 26, sky: [1.6, 0.35, 0.75], cam: null, look: null },
];
const EXTRA = {
  top: { fov: 32, sky: [1, 0.5, 0.6], cam: k => [-420 + 40 * k, 330, -620], look: k => [-20, -10, 0] },
  far: { fov: 18, sky: [1, 0.5, 0.4], cam: k => [200 - 40 * k, -60, -2600], look: k => [60, 30, 0] },
  side: { fov: 30, sky: [1, 0.5, 0.45], cam: k => [0, -95, -980], look: k => [0, 12, 0] },
  eye: { fov: 26, sky: [1.6, 0.35, 0.75], cam: null, look: null },
  under: { fov: 38, sky: [1.5, 0.5, 0.9], cam: k => [80 - 30 * k, -330, -70], look: k => [80 - 30 * k, 0, -10] },
  reveal: { fov: 31, sky: [1.5, 0.5, 0.9], cam: k => [ev.x + 70 + 10 * k, ev.y - 150, ev.z - 70], look: k => [ev.x, ev.y, ev.z] },
  // 镜头 C 渡船甲板机位（= VIEWS[1] 的固定版，取 k=0.33）
  ferry: { fov: 40, sky: [1.35, 0.5, 0.95], cam: k => [43, -300, -163], look: k => [112, -10, 10] },
  // 海报帧：从头前下方 3/4 仰看，头、金瞳、龙须在前，身体和松树往后退进霞光
  hero: { fov: 34, sky: [1.25, 0.42, 0.62], cam: k => [560, -190, -520], look: k => [70, 10, 0] },
  hero2: { fov: 28, sky: [1.15, 0.5, 0.5], cam: k => [430, -140, -700], look: k => [40, 20, 0] },
};
const ROLL = +(q.get('roll') || 0), LOOK = !!q.get('look');
kun.group.rotation.x = ROLL;
kun.group.rotation.z = +(q.get('pitch') || 0);
kun.fitShadow(key, { size: 4096 });
// 自由机位（找海报帧用）：&cam=x,y,z&at=x,y,z&fov=36&sky=zoom,ox,oy
if (q.get('cam')) {
  const nums = k => q.get(k).split(',').map(Number);
  EXTRA.free = { fov: +(q.get('fov') || 36), sky: q.get('sky') ? nums('sky') : [1.3, 0.5, 0.6], cam: () => nums('cam'), look: () => nums('at') };
}
const forced = EXTRA[q.get('cam') ? 'free' : q.get('view')];
const lerpN = (a, b, k) => a + (b - a) * k;
const ev = new THREE.Vector3();

window.DUR = 4;
window.render = t => {
  const v = forced ? { t0: 0, t1: window.DUR, ...forced } : (VIEWS.find(x => t >= x.t0 && t < x.t1) || VIEWS[VIEWS.length - 1]);
  const k = (t - v.t0) / (v.t1 - v.t0);
  const fr = Math.round(t * 24);
  const ts = Math.floor(fr / 3) * 3 / 24;                   // 鲲：一拍三（8 fps）
  camera.fov = v.fov; camera.updateProjectionMatrix();
  kun.group.updateMatrixWorld(true); kun.eyeWorld(ev, -1);
  if (v.cam) { camera.position.set(...v.cam(k)); camera.lookAt(...v.look(k)); }
  else {
    kun.group.updateMatrixWorld(true);
    kun.eyeWorld(ev, -1);
    camera.position.set(ev.x + lerpN(-14, -8, k), ev.y - 22, ev.z - 92);
    camera.lookAt(ev.x - 3, ev.y + 2, ev.z);
  }
  kun.setPose(ts, LOOK ? { look: camera.position } : {});
  skyCover(...v.sky);
  if (POST) {                                                // 正片后期管线：墨线一拍二沸腾由 look.js 按 t 自己算
    setToonGlobals({ inkTime: Math.floor(fr / 2), pass: 0 });
    renderer.shadowMap.autoUpdate = true;
    look.render(scene, camera, { t: fr / 24 });
    return;
  }
  comp.material.uniforms.inkT.value = Math.floor(fr / 2);
  setToonGlobals({ inkTime: Math.floor(fr / 2) });
  renderer.shadowMap.autoUpdate = true;
  setToonGlobals({ pass: 0 });
  renderer.setRenderTarget(rtC); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, camera);
  renderer.shadowMap.autoUpdate = false;
  setToonGlobals({ pass: 1 });
  renderer.setRenderTarget(rtN); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, camera);
  setToonGlobals({ pass: 0 });
  renderer.setRenderTarget(null); comp.render(renderer);
};
const tw = performance.now();
window.render(0); window.render(1.6); window.render(3.2);
console.warn(`[kun_refine] 预热（含着色器编译）${(performance.now() - tw).toFixed(0)} ms`);
window.READY = true;
