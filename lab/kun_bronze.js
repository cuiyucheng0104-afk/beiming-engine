// 青铜古鲲自测页（?test=kun_bronze）。背景、天空、主光、城市光、机位与 lab/kun.js 完全相同，方便横向对比：
//   0.0–1.5  ① 大远景侧面全身（镜头 C 的朝向：头朝画左，逆光从画左后方来）
//   1.5–3.0  ② 从下方仰视腹部和头（镜头 C 渡船甲板机位）
//   3.0–4.0  ③ 眼睛特写
// 描边：临时屏幕空间描边（深度 + 法线 + 物体/实例 ID，按一拍二抖动），与 lab/kun.js 同一段代码，只为看效果。
// 可选参数：&lod=0.3 &noink=1 &pass=1 &view=side|top|far|eye|under|reveal|hero|hero_full|hero_low|front|tail &roll=-0.5 &look=1（玉眼看镜头）
//   &dbg=pattern（不渲染 3D，直接看身体纹样展开图）&dbg=fins（看各类鳍的离缘距离场）
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { createKun } from '../src/kun_bronze.js';
import { PALETTE, setToonGlobals } from '../src/toon.js';

const q = new URLSearchParams(location.search);
const W = innerWidth, H = innerHeight, PR = 2, RW = W * PR, RH = H * PR;
const t0 = performance.now();
const kun = createKun({ lod: +(q.get('lod') || 1) });
console.warn(`[kun_bronze] 构建 ${(performance.now() - t0).toFixed(0)} ms ${JSON.stringify(kun.debug.timings)}，描边网格 ${kun.outlineMeshes.length} 个，${JSON.stringify(kun.debug.counts)}`);

// —— 调试：2D 看纹样展开图 / 鳍的距离场 ——
const DBG = q.get('dbg');
if (DBG) {
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; document.body.appendChild(cv);
  const g = cv.getContext('2d');
  g.fillStyle = '#1b1d24'; g.fillRect(0, 0, W, H);
  if (DBG === 'pattern') {
    const P = kun.debug.pattern, w0 = P.band.width, h0 = P.band.height, sc = Math.min(W / w0, H / h0), dw = w0 * sc, dh = h0 * sc;
    const layer = (c, col, op) => { const t = document.createElement('canvas'); t.width = w0; t.height = h0; const tg = t.getContext('2d'); tg.drawImage(c, 0, 0); tg.globalCompositeOperation = 'multiply'; tg.fillStyle = col; tg.fillRect(0, 0, w0, h0); g.globalCompositeOperation = 'lighter'; g.globalAlpha = op; g.drawImage(t, 0, 0, dw, dh); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; };
    layer(P.zone, '#2a8f84', 0.8); layer(P.band, '#d8c49a', 1); layer(P.jade, '#ffffff', 1); layer(P.groove, '#ff3030', 1);
    // 背中线 / 腹中线
    const PRM = kun.debug.PRM, PAT = kun.debug.PAT;
    g.strokeStyle = '#9fe8ff'; g.lineWidth = 1; g.beginPath();
    for (let x = -192; x <= 303; x += 2) { const u = PRM.Ux(x) * PAT.K * sc, v = (PAT.smax - PRM.st(x)) * PAT.K * sc; x === -192 ? g.moveTo(u, v) : g.lineTo(u, v); }
    for (let x = 303; x >= -192; x -= 2) { const u = PRM.Ux(x) * PAT.K * sc, v = (PAT.smax + PRM.sb(x)) * PAT.K * sc; g.lineTo(u, v); }
    g.stroke();
  } else {
    const F = kun.debug.finFields; let x = 10;
    for (const k in F) { const c = F[k], s = Math.min(1, (H - 20) / c.height, 600 / c.width); g.drawImage(c, x, 10, c.width * s, c.height * s); g.fillStyle = '#fff'; g.fillText(k, x + 4, 24); x += c.width * s + 12; }
  }
  window.DUR = 1; window.render = () => {}; window.READY = true;
  await new Promise(() => {});   // 调试模式到此为止：模块停在这里，不再建 3D 场景
}

const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(PR); renderer.setSize(W, H);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, W / H, 5, 6000);
{ // 统计实例数与三角形数（自测用）
  let tri = 0; const inst = [];
  kun.group.traverse(o => { if (!o.isMesh) return; const g = o.geometry, t = (g.index ? g.index.count : g.attributes.position.count) / 3, n = o.isInstancedMesh ? o.count : 1; tri += t * n; if (o.isInstancedMesh) inst.push(`${o.name}:${o.count}`); });
  console.warn(`[kun_bronze] 三角形 ${(tri / 1e6).toFixed(2)} M；实例 ${inst.join(' ')}`);
}
scene.add(kun.group);

// 主光：破晓地平线低角度逆光；鲲朝东（+X）游（与 lab/kun.js 相同）
const KEY_DIR = new THREE.Vector3(0.75, 0.1, 0.65).normalize();
const key = new THREE.DirectionalLight('#ffd3b0', 1);
key.position.copy(KEY_DIR); key.target.position.set(0, 0, 0);
scene.add(key, key.target);
setToonGlobals({ cityDir: [0.08, -1, 0.1], keyDir: KEY_DIR.toArray() });

const rtC = new THREE.WebGLRenderTarget(RW, RH, { type: THREE.HalfFloatType, samples: 4 });
const rtN = new THREE.WebGLRenderTarget(RW, RH, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(RW, RH, THREE.FloatType) });
const sky = await new THREE.TextureLoader().loadAsync('./assets/ref/sky_test.png');
sky.colorSpace = THREE.SRGBColorSpace;

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
const EXTRA = {
  top: { fov: 32, sky: [1, 0.5, 0.6], cam: k => [-420 + 40 * k, 330, -620], look: k => [-20, -10, 0] },
  far: { fov: 18, sky: [1, 0.5, 0.4], cam: k => [200 - 40 * k, -60, -2600], look: k => [60, 30, 0] },
  side: { fov: 30, sky: [1, 0.5, 0.45], cam: k => [0, -95, -980], look: k => [0, 12, 0] },
  eye: { fov: 26, sky: [1.6, 0.35, 0.75], cam: null, look: null },
  under: { fov: 38, sky: [1.5, 0.5, 0.9], cam: k => [80 - 30 * k, -330, -70], look: k => [80 - 30 * k, 0, -10] },
  reveal: { fov: 31, sky: [1.5, 0.5, 0.9], cam: k => [ev.x + 70 + 10 * k, ev.y - 150, ev.z - 70], look: k => [ev.x, ev.y, ev.z] },
  // 海报帧：前下方 3/4 仰角，头、玉眼、饕餮面、背上的苔藓花与背鳍剪影都在逆光里
  // 海报帧：前方 3/4 略仰的「肖像」——下撇的厚唇挂着垂苔、玉眼直视镜头（AR 里「它看见你了」）、背上苔藓花与戈形背鳍剪影
  hero: { fov: 31, sky: [1.25, 0.4, 0.6], cam: k => [600 - 10 * k, -110, -360], look: k => [130, 4, 0], eyeContact: true },
  hero_full: { fov: 30, sky: [1.25, 0.42, 0.62], cam: k => [470 - 20 * k, -170, -560 + 10 * k], look: k => [70, 22, 0] },
  hero_low: { fov: 34, sky: [1.3, 0.45, 0.7], cam: k => [430 - 10 * k, -250, -390], look: k => [110, 12, 0], eyeContact: true },
  front: { fov: 34, sky: [1.3, 0.5, 0.6], cam: k => [560, -60, -260], look: k => [120, 10, 0] },
  tail: { fov: 34, sky: [1.3, 0.5, 0.6], cam: k => [-520, -80, -420], look: k => [-120, 0, 0] },
};
const ROLL = +(q.get('roll') || 0), LOOK = !!q.get('look');
kun.group.rotation.x = ROLL;
kun.fitShadow(key, { size: 4096 });
const forced = EXTRA[q.get('view')];
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
  kun.setPose(ts, LOOK || v.eyeContact ? { look: camera.position } : {});
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
const tw = performance.now();
window.render(0); window.render(1.6); window.render(3.2);
console.warn(`[kun_bronze] 预热（含着色器编译）${(performance.now() - tw).toFixed(0)} ms`);
window.READY = true;
