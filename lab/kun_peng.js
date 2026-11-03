// 鲲鹏将化 自测页（?test=kun_peng）。背景、天空、光线、机位全部沿用 lab/kun.js（方便和旧版横向对比）。
// DUR = 4 秒，三个机位按时间分段（同 lab/kun.js）：
//   0.0–1.5  ① 大远景侧面全身   1.5–3.0  ② 从下方仰视（镜头 C 渡船甲板机位）   3.0–4.0  ③ 眼睛特写
// 身体一拍三（8 fps），翅膀一拍二（12 fps），墨线抖动一拍二。
// 可选参数：&view=side|top|far|eye|under|reveal|hero|wing|tail（固定机位）&roll=-0.5（鲲侧倾）&look=1（眼珠看镜头）
//   &lod=0.4 &noink=1 &pass=1 &wt=<秒>（翅膀时钟固定在某一刻，调扇翅姿态用）&bt=<秒>（身体时钟固定）
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { createKun } from '../src/kun_peng.js';
import { PALETTE, setToonGlobals } from '../src/toon.js';

const q = new URLSearchParams(location.search);
const W = innerWidth, H = innerHeight, PR = 2, RW = W * PR, RH = H * PR;
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(PR); renderer.setSize(W, H);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, W / H, 5, 6000);
const t0 = performance.now();
const kun = createKun({ lod: +(q.get('lod') || 1) });
console.warn(`[kun_peng] 构建 ${(performance.now() - t0).toFixed(0)} ms，描边网格 ${kun.outlineMeshes.length} 个`);
{
  let tri = 0; const inst = [];
  kun.group.traverse(o => { if (!o.isMesh) return; const g = o.geometry, t = (g.index ? g.index.count : g.attributes.position.count) / 3, n = o.isInstancedMesh ? o.count : 1; tri += t * n; if (o.isInstancedMesh) inst.push(`${o.name}:${o.count}`); });
  console.warn(`[kun_peng] 三角形 ${(tri / 1e6).toFixed(2)} M；实例 ${inst.join(' ')}`);
}
scene.add(kun.group);

// 主光：破晓地平线低角度逆光（同 lab/kun.js）
const KEY_DIR = new THREE.Vector3(0.75, 0.1, 0.65).normalize();
const key = new THREE.DirectionalLight('#ffd3b0', 1);
key.position.copy(KEY_DIR); key.target.position.set(0, 0, 0);
scene.add(key, key.target);
setToonGlobals({ cityDir: [0.08, -1, 0.1], keyDir: KEY_DIR.toArray() });

const rtC = new THREE.WebGLRenderTarget(RW, RH, { type: THREE.HalfFloatType, samples: 4 });
const rtN = new THREE.WebGLRenderTarget(RW, RH, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(RW, RH, THREE.FloatType) });
const sky = await new THREE.TextureLoader().loadAsync('./assets/ref/sky_test.png');
sky.colorSpace = THREE.SRGBColorSpace;

// 合成：与 lab/kun.js 相同的屏幕空间描边（深度 + 法线 + 物体/实例 ID，一拍二抖动）+ 空气透视
const comp = new FullScreenQuad(new THREE.ShaderMaterial({
  uniforms: {
    tC: { value: rtC.texture }, tN: { value: rtN.texture }, tD: { value: rtN.depthTexture }, tSky: { value: sky },
    res: { value: new THREE.Vector2(RW, RH) }, near: { value: 5 }, far: { value: 6000 }, inkT: { value: 0 },
    ink: { value: new THREE.Color(PALETTE.ink) }, haze: { value: new THREE.Color('#a497d6') }, hazeK: { value: 0.00035 },
    skyUV: { value: new THREE.Vector4(1, 1, 0, 0) }, inkOn: { value: q.get('noink') ? 0 : 1 }, showPass: { value: q.get('pass') ? 1 : 0 },
  },
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
      float lw = 3.2 + 1.2 * n2( vUv * res / 60.0 + inkT * 3.3 );
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
        e = max( e, max( de, max( dn * 0.75, di * 0.9 ) * smoothstep( 0.3, 1.0, w0 ) ) );
      }
      e *= step( 0.001, n0.a ) * inkOn;
      float la = mix( 0.95, 0.5, smoothstep( 500.0, 1600.0, z0 ) );
      vec3 sc = c.a > 0.001 ? c.rgb / c.a : vec3( 0.0 );
      float fogA = ( 1.0 - exp( - z0 * hazeK ) ) * step( 0.001, n0.a );
      sc = mix( sc, haze, fogA * 0.55 );
      vec3 col = skyc * ( 1.0 - c.a ) + sc * c.a;
      col = mix( col, ink, e * la );
      gl_FragColor = vec4( col, 1.0 );
      #include <colorspace_fragment>
    }`,
  depthTest: false, depthWrite: false,
}));

const IA = 1774 / 887, SA = W / H;
function skyCover(zoom = 1, ox = 0.5, oy = 0.5) {
  const sx = SA / IA / zoom, sy = 1 / zoom;
  comp.material.uniforms.skyUV.value.set(sx, sy, (1 - sx) * ox, (1 - sy) * oy);
}

const VIEWS = [
  { t0: 0, t1: 1.5, fov: 30, sky: [1, 0.5, 0.45], cam: k => [lerpN(-20, 10, k), -95, lerpN(-1010, -930, k)], look: k => [lerpN(10, 0, k), 12, 0] },
  { t0: 1.5, t1: 3, fov: 40, sky: [1.35, 0.5, 0.95], cam: k => [lerpN(50, 30, k), -300, lerpN(-170, -150, k)], look: k => [lerpN(118, 100, k), -10, 10] },
  { t0: 3, t1: 4.01, fov: 26, sky: [1.6, 0.35, 0.75], cam: null, look: null },
];
// 固定机位（前六个与 lab/kun.js 相同；hero / wing / tail 是本变体新增的）
const EXTRA = {
  top: { fov: 32, sky: [1, 0.5, 0.6], cam: k => [-420 + 40 * k, 330, -620], look: k => [-20, -10, 0] },
  far: { fov: 18, sky: [1, 0.5, 0.4], cam: k => [200 - 40 * k, -60, -2600], look: k => [60, 30, 0] },
  side: { fov: 30, sky: [1, 0.5, 0.45], cam: k => [0, -95, -980], look: k => [0, 12, 0] },
  eye: { fov: 26, sky: [1.6, 0.35, 0.75], cam: null, look: null },
  under: { fov: 38, sky: [1.5, 0.5, 0.9], cam: k => [80 - 30 * k, -330, -70], look: k => [80 - 30 * k, 0, -10] },
  reveal: { fov: 31, sky: [1.5, 0.5, 0.9], cam: k => [ev.x + 70 + 10 * k, ev.y - 150, ev.z - 70], look: k => [ev.x, ev.y, ev.z] },
  // 海报帧：侧下方略偏前，鲲向镜头侧倾 0.5 弧度——远侧翅膀从背后举起、近侧翅膀横在身前（设定图的构图），翅膀在下扑起始的展开位
  hero: { fov: 40, sky: [1.2, 0.45, 0.45], cam: k => [120, -60, -700], look: k => [-70, 50, 0], roll: -0.5, wt0: 0, bt0: 0.5 },
  wing: { fov: 30, sky: [1.4, 0.5, 0.3], cam: k => [60, 260, -360], look: k => [40, 80, -150] },
  tail: { fov: 30, sky: [1.4, 0.6, 0.6], cam: k => [-260, -40, -420], look: k => [-300, 10, 0] },
};
// &cam=x,y,z&at=x,y,z&fov=f&sky=zoom,ox,oy：自由机位（找海报角度用）
if (q.has('cam')) {
  const c = q.get('cam').split(',').map(Number), a = (q.get('at') || '0,0,0').split(',').map(Number);
  EXTRA.custom = { fov: +(q.get('fov') || 32), sky: (q.get('sky') || '1.2,0.5,0.5').split(',').map(Number), cam: () => c, look: () => a };
}
const ROLL = +(q.get('roll') || 0), LOOK = !!q.get('look');
kun.group.rotation.x = ROLL;
kun.fitShadow(key, { size: 4096 });
const forced = EXTRA[q.get('view')];
const lerpN = (a, b, k) => a + (b - a) * k;
const ev = new THREE.Vector3();
const WT = q.has('wt') ? +q.get('wt') : null, BT = q.has('bt') ? +q.get('bt') : null;

window.DUR = 4;
window.render = t => {
  const v = forced ? { t0: 0, t1: window.DUR, ...forced } : (VIEWS.find(x => t >= x.t0 && t < x.t1) || VIEWS[VIEWS.length - 1]);
  const k = (t - v.t0) / (v.t1 - v.t0);
  const fr = Math.round(t * 24);
  const ts = BT ?? Math.floor(fr / 3) * 3 / 24 + (v.bt0 || 0);   // 身体：一拍三（8 fps）
  const tw = WT ?? Math.floor(fr / 2) * 2 / 24 + (v.wt0 || 0);   // 翅膀：一拍二（12 fps）
  kun.group.rotation.x = q.has('roll') ? ROLL : (v.roll || 0);
  camera.fov = v.fov; camera.updateProjectionMatrix();
  kun.setPose(ts, { wingT: tw });
  kun.group.updateMatrixWorld(true); kun.eyeWorld(ev, -1);
  if (v.cam) { camera.position.set(...v.cam(k)); camera.lookAt(...v.look(k)); }
  else {
    camera.position.set(ev.x + lerpN(-14, -8, k), ev.y - 22, ev.z - 92);
    camera.lookAt(ev.x - 3, ev.y + 2, ev.z);
  }
  if (LOOK) kun.setPose(ts, { wingT: tw, look: camera.position });
  skyCover(...v.sky);
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
// 性能：连渲 n 帧（每帧 readPixels 强制同步），返回每帧毫秒
window.bench = (n = 24, tStart = 0) => {
  const px = new Uint8Array(4), gl = renderer.getContext(), out = [];
  for (let i = 0; i < n; i++) { const a = performance.now(); window.render(tStart + i / 24); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); out.push(performance.now() - a); }
  const pose = []; for (let i = 0; i < n; i++) { const a = performance.now(); kun.setPose(i / 8, { wingT: i / 12 }); pose.push(performance.now() - a); }
  return { frame: out.reduce((s, x) => s + x, 0) / n, pose: pose.reduce((s, x) => s + x, 0) / n };
};
const tw0 = performance.now();
window.render(0); window.render(1.6); window.render(3.2);
console.warn(`[kun_peng] 预热（含着色器编译）${(performance.now() - tw0).toFixed(0)} ms`);
window.READY = true;
