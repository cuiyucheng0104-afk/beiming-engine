// lab/look.js — 后期合成管线自测页（?test=look）。
// 自建一个小场景：几何体拼的「鲲」（MeshToonMaterial：球、圆柱、圆环 + 辐条）、背上实例化的海草/藤壶/海葵小球、
// 珊瑚、远处的小鲲（测线宽随深度、雾）、半透明云片（测半挡线）、不描边的礁石（测实心挡线）、HDR 窗灯（测 bloom）、
// 背景平面贴 assets/ref/sky_test.png（底板不描边）。
// 查询参数：
//   cfg = raw | line | kuwa | bloom | grade | fog | paper | full | nolines | nokuwa   各效果开/关
//   dbg = id | depth | edge | line | bloom | paper | kuwahara | scene                  看中间缓冲
//   ss=1|2  墨线超采样；lw 线宽；wob 抖动；kr Kuwahara 半径；kf 远处半径；ks 强度；pk 纸纹；bs bloom 强度
//   shot = mid（默认，中景）| close（近景看笔触）；still=1 镜头不动（看一拍二沸腾 / 一拍三）
//   hud=1 在后期之后叠一层模拟眼镜显示层；grain=0.x 页面内颗粒；paper=<url> 外部纸纹图
// 另外还测了：alphaTest 镂空面片（ID 图 CUTOUT 分支）、ShaderMaterial 远岸（'own' 挡线）、
// 描边的 ShaderMaterial 圆环 + 会改自身 uniform 的 onBeforeRender（ID 图期间的回调保护）。
// window.bench(n, t) 连渲 n 帧、每帧 readPixels 强制 GPU 同步，返回每帧毫秒数。
import * as THREE from 'three';
import { mulberry } from '../engine/core/math.js';
import { createLook } from '../src/look.js';

const Q = new URLSearchParams(location.search);
const num = (k, d) => (Q.has(k) ? parseFloat(Q.get(k)) : d);
const W = innerWidth, H = innerHeight;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1); renderer.setSize(W, H);
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

const look = createLook(renderer, W, H, { ss: num('ss', 2), ...(Q.has('paper') ? { paperUrl: Q.get('paper') } : {}) });

// ───────── 场景 ─────────
const scene = new THREE.Scene(); scene.background = new THREE.Color('#4F5BBF');
const camera = new THREE.PerspectiveCamera(30, W / H, .5, 400);
const rnd = mulberry(20261103);

// 三档色阶
const ramp = new THREE.DataTexture(new Uint8Array([120, 190, 255]), 3, 1, THREE.RedFormat);
ramp.minFilter = ramp.magFilter = THREE.NearestFilter; ramp.needsUpdate = true;

// 测试用卡通材质：三档色阶 + 背光边缘光 + 紫色锈斑噪点（正式的着色器归别的代理，这里只求像样，好评估后期）
function toon(hex, { rim = '#FFD3B0', rimAmt = 1, rust = .45, instanced = false } = {}) {
  const m = new THREE.MeshToonMaterial({ color: hex, gradientMap: ramp });
  m.onBeforeCompile = sh => {
    sh.uniforms.uRim = { value: new THREE.Color(rim).multiplyScalar(1.25) };
    sh.uniforms.uRimAmt = { value: rimAmt };
    sh.uniforms.uRust = { value: new THREE.Color('#7A5C9E') };
    sh.uniforms.uRustAmt = { value: rust };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjP = position;' + (instanced ? '\n#ifdef USE_INSTANCING\nvObjP = (instanceMatrix * vec4(position,1.)).xyz;\n#endif' : ''));
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vObjP; uniform vec3 uRim, uRust; uniform float uRimAmt, uRustAmt;
        float th(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float tn(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
          return mix(mix(mix(th(i), th(i + vec3(1,0,0)), f.x), mix(th(i + vec3(0,1,0)), th(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(th(i + vec3(0,0,1)), th(i + vec3(1,0,1)), f.x), mix(th(i + vec3(0,1,1)), th(i + vec3(1,1,1)), f.x), f.y), f.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        { float n = tn(vObjP * 2.2) * .65 + tn(vObjP * 7.) * .35;
          diffuseColor.rgb = mix(diffuseColor.rgb, uRust, smoothstep(.56, .62, n) * uRustAmt);
          diffuseColor.rgb *= 1. - .25 * smoothstep(.78, .8, tn(vObjP * 13.)) * uRustAmt; }`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        { vec3 Nn = normalize(normal), Vv = normalize(vViewPosition);
          float fres = 1. - saturate(dot(Nn, Vv)), back = 0.;
          #if NUM_DIR_LIGHTS > 0
            back = saturate(dot(Nn, directionalLights[0].direction) * 1.6 + .25);
          #endif
          gl_FragColor.rgb = mix(gl_FragColor.rgb, uRim, smoothstep(.6, .66, fres) * back * uRimAmt); }`);
  };
  m.customProgramCacheKey = () => 'toon-test-' + instanced;
  return m;
}

// 背景底板（不描边）
const skyTex = new THREE.TextureLoader().load('./assets/ref/sky_test.png');
skyTex.colorSpace = THREE.SRGBColorSpace;
{
  const d = 160, hh = 2 * d * Math.tan(THREE.MathUtils.degToRad(15)) * 1.6, ww = hh * 2;
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(ww, hh), new THREE.MeshBasicMaterial({ map: skyTex, fog: false, toneMapped: false }));
  sky.position.set(0, -2, -d); scene.add(sky);
}

// 「城市」剪影 + HDR 窗灯（不描边，测 bloom）
{
  const city = new THREE.Group(); city.position.set(0, -6, -95);
  const sil = new THREE.MeshBasicMaterial({ color: '#4B4A8C' });
  const lit = new THREE.MeshBasicMaterial({ color: new THREE.Color('#FFC46B').multiplyScalar(3.2) });
  for (let i = 0; i < 26; i++) {
    const bw = 3 + rnd() * 5, bh = 4 + rnd() * 16, x = -70 + i * 5.6 + rnd() * 2;
    const b = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 2), sil); b.position.set(x, bh / 2, 0); city.add(b);
    for (let k = 0; k < 6; k++) {
      const wdw = new THREE.Mesh(new THREE.BoxGeometry(.35, .5, .1), lit);
      wdw.position.set(x + (rnd() - .5) * bw * .8, 1 + rnd() * (bh - 2), 1.05); city.add(wdw);
    }
  }
  scene.add(city);
}

// 自定义 ShaderMaterial 的不描边物体（走 'own' 挡线：用自己的着色器实心挡）——一块远岸色带
{
  const bank = new THREE.Mesh(new THREE.PlaneGeometry(260, 3.5), new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
    fragmentShader: 'varying vec2 vUv; void main(){ gl_FragColor = vec4(mix(vec3(.16, .14, .36), vec3(.27, .24, .52), vUv.y), 1.); }',
  }));
  bank.position.set(0, -7.2, -96); scene.add(bank);
}

// ───────── 鲲（几何体拼）─────────
function makeKun(detail = 1) {
  const g = new THREE.Group(); g.userData.outline = true;
  const add = (geo, m, p, s = [1, 1, 1], r = [0, 0, 0]) => { const o = new THREE.Mesh(geo, m); o.position.set(...p); o.scale.set(...s); o.rotation.set(...r); o.castShadow = o.receiveShadow = true; g.add(o); return o; };
  const body = toon('#6E7BA8'), belly = toon('#F2A36B', { rust: .2 }), fin = toon('#4E5888');
  add(new THREE.SphereGeometry(1, 64, 40), body, [0, 0, 0], [4.6, 1.55, 1.75]);                       // 身体
  add(new THREE.SphereGeometry(1, 48, 32), belly, [.4, -.62, 0], [3.7, .95, 1.42]);                    // 腹部（内部折痕线）
  add(new THREE.CylinderGeometry(.55, 1.15, 3.2, 32), body, [-5.3, .15, 0], [1, 1, 1], [0, 0, Math.PI / 2 - .12]);   // 尾柄
  add(new THREE.SphereGeometry(1, 32, 16), fin, [-7.2, .45, .9], [1.3, .16, 1.0], [.2, .5, .5]);       // 尾鳍
  add(new THREE.SphereGeometry(1, 32, 16), fin, [-7.2, .45, -.9], [1.3, .16, 1.0], [-.2, -.5, .5]);
  add(new THREE.SphereGeometry(1, 32, 16), fin, [1.2, -.9, 1.7], [2.2, .14, .7], [.5, .3, -.35]);      // 胸鳍
  // 眼：圆环 + 辐条（测内部线）
  const eye = new THREE.Group(); eye.position.set(3.25, .25, 1.36); eye.rotation.set(0, .62, 0); g.add(eye);
  const ringM = toon('#E9DCC9', { rust: .3 });
  eye.add(new THREE.Mesh(new THREE.TorusGeometry(.42, .09, 16, 48), ringM));
  const pupil = new THREE.Mesh(new THREE.SphereGeometry(.3, 32, 16), new THREE.MeshToonMaterial({ color: '#343D69', gradientMap: ramp })); pupil.scale.z = .5; eye.add(pupil);
  for (let i = 0; i < 6; i++) { const s = new THREE.Mesh(new THREE.CylinderGeometry(.025, .025, .78, 6), ringM); s.rotation.z = i * Math.PI / 6; s.position.z = .1; eye.add(s); }

  if (detail) {
    // 背上散布：海草小球（实例化，每实例一个 ID）、藤壶、海葵、珊瑚
    const surf = (u, v) => {   // 椭球表面上一点（只取上半背）
      const th = u * Math.PI * 2, ph = v * Math.PI * .45;
      return new THREE.Vector3(Math.cos(ph) * Math.cos(th) * 4.6, Math.sin(ph) * 1.55, Math.cos(ph) * Math.sin(th) * 1.75);
    };
    const mossGeo = new THREE.IcosahedronGeometry(.12, 1);
    const moss = new THREE.InstancedMesh(mossGeo, toon('#ffffff', { rim: '#FFE6B0', rust: 0, instanced: true }), 1600);
    moss.userData.outlineWidth = .55; moss.castShadow = true;
    const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), col = new THREE.Color();
    const tones = ['#7FA866', '#5E8A5A', '#9DBF6A', '#6E9A5C', '#B5CF7A'];
    let n = 0;
    for (let c = 0; c < 46 && n < 1600; c++) {      // 一簇一簇
      const cu = .02 + rnd() * .6, cv = .3 + rnd() * .6, cnt = 18 + Math.floor(rnd() * 26);
      for (let i = 0; i < cnt && n < 1600; i++, n++) {
        const p = surf(cu + (rnd() - .5) * .06, Math.min(1, cv + (rnd() - .5) * .2));
        p.multiplyScalar(1 + rnd() * .06);
        const s = .6 + rnd() * .9; sc.set(s, s * (.8 + rnd() * .5), s);
        q.setFromEuler(new THREE.Euler(rnd() * 3, rnd() * 3, rnd() * 3));
        moss.setMatrixAt(n, mtx.compose(p, q, sc)); moss.setColorAt(n, col.set(tones[Math.floor(rnd() * tones.length)]));
      }
    }
    moss.count = n; g.add(moss);
    const barn = new THREE.InstancedMesh(new THREE.CylinderGeometry(.11, .17, .16, 20), toon('#E9DCC9', { rust: .15, instanced: true }), 90);
    barn.userData.outlineWidth = .6;
    for (let i = 0; i < 90; i++) {
      const p = surf(rnd() * .9 - .1, .1 + rnd() * .5), nrm = p.clone().divide(new THREE.Vector3(4.6 * 4.6, 1.55 * 1.55, 1.75 * 1.75)).normalize();
      q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), nrm); const s = .7 + rnd() * .8; sc.set(s, s, s);
      barn.setMatrixAt(i, mtx.compose(p, q, sc));
    }
    g.add(barn);
    const anem = new THREE.InstancedMesh(new THREE.SphereGeometry(.07, 10, 6), toon('#FFF4EA', { rust: 0, instanced: true }), 60);
    anem.userData.outlineWidth = .4;
    for (let i = 0; i < 60; i++) { const p = surf(.08 + rnd() * .5, .45 + rnd() * .5).multiplyScalar(1.07); sc.setScalar(.8 + rnd()); anem.setMatrixAt(i, mtx.compose(p, q.identity(), sc)); }
    g.add(anem);
    // 镂空面片（alphaTest 贴图，测 ID 图的 CUTOUT 分支）：两片海草叶
    {
      const cv = document.createElement('canvas'); cv.width = 128; cv.height = 256; const x = cv.getContext('2d');
      x.fillStyle = '#ffffff';
      for (const [bx, lean] of [[40, -18], [70, 10], [96, 24]]) {
        x.beginPath(); x.moveTo(bx - 7, 256);
        x.bezierCurveTo(bx - 12, 170, bx + lean - 10, 90, bx + lean, 8);
        x.bezierCurveTo(bx + lean + 10, 90, bx + 12, 170, bx + 7, 256); x.fill();
      }
      const ft = new THREE.CanvasTexture(cv);
      const fm = toon('#6E9A5C', { rust: 0 }); fm.map = ft; fm.alphaTest = .5; fm.side = THREE.DoubleSide;
      for (const [u, v, ry] of [[.32, .78, .4], [.12, .7, -.3]]) {
        const p = surf(u, v), f = new THREE.Mesh(new THREE.PlaneGeometry(.9, 1.8), fm);
        f.position.copy(p); f.position.y += .8; f.rotation.y = ry; g.add(f);
      }
    }
    const coralM = toon('#F07F86', { rust: .1 });
    for (let i = 0; i < 5; i++) {
      const p = surf(.15 + rnd() * .35, .55 + rnd() * .35);
      const c = new THREE.Mesh(new THREE.ConeGeometry(.12, .7 + rnd() * .5, 8), coralM); c.position.copy(p); c.position.y += .3;
      c.rotation.set((rnd() - .5) * .8, 0, (rnd() - .5) * .8); g.add(c);
    }
  }
  return g;
}
const kun = makeKun(1); scene.add(kun);
const kunFar = makeKun(0); kunFar.position.set(-26, 7, -70); kunFar.scale.setScalar(1.3); kunFar.rotation.y = .5; scene.add(kunFar);

// 描边的自定义 ShaderMaterial 物体，onBeforeRender 里改自己材质的 uniform（测 ID 图期间的回调保护：不保护的话这里会报错中止）
{
  const ring = new THREE.Mesh(new THREE.TorusGeometry(.5, .14, 16, 40), new THREE.ShaderMaterial({
    uniforms: { uT: { value: 0 } },
    vertexShader: 'varying vec3 vN; void main(){ vN = normalMatrix * normal; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
    fragmentShader: 'uniform float uT; varying vec3 vN; void main(){ float l = step(.2, normalize(vN).y) * .25 + .55; gl_FragColor = vec4(vec3(.95, .55, .55) * l, 1.); }',
  }));
  ring.position.set(6.2, 2.2, 1); ring.rotation.set(.4, .6, 0); ring.userData.outline = true;
  ring.onBeforeRender = (r, s, c, g, m) => { m.uniforms.uT.value = 1; };
  scene.add(ring);
}
// 不描边的礁石（实心挡线）
const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(1.6, 0), toon('#3E3A6A', { rimAmt: .6, rust: .2 }));
rock.position.set(2.6, -1.9, 4.6); rock.scale.set(1.3, .9, 1); scene.add(rock);

// 半透明云片（不描边，按 alpha 半挡线）
{
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128; const x = cv.getContext('2d');
  const r2 = mulberry(7);
  for (let i = 0; i < 22; i++) {
    const cx = 30 + r2() * 196, cy = 50 + r2() * 40, rr = 18 + r2() * 30;
    const gr = x.createRadialGradient(cx, cy, 0, cx, cy, rr);
    gr.addColorStop(0, 'rgba(247,169,143,0.9)'); gr.addColorStop(.6, 'rgba(242,160,166,0.55)'); gr.addColorStop(1, 'rgba(242,160,166,0)');
    x.fillStyle = gr; x.beginPath(); x.arc(cx, cy, rr, 0, 7); x.fill();
  }
  x.globalCompositeOperation = 'destination-in';
  const fade = x.createRadialGradient(128, 64, 30, 128, 64, 128); fade.addColorStop(0, 'rgba(0,0,0,1)'); fade.addColorStop(1, 'rgba(0,0,0,0)');
  x.setTransform(1, 0, 0, .5, 0, 32); x.fillStyle = fade; x.fillRect(0, -64, 256, 256); x.setTransform(1, 0, 0, 1, 0, 0);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const cloud = new THREE.Mesh(new THREE.PlaneGeometry(9, 4.5), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
  cloud.position.set(-7.2, -.6, 2.6); cloud.scale.setScalar(.85); scene.add(cloud);
}

// 光：破晓地平线低角度逆光（从鲲身后、画面左下偏远处）+ 城市灯从下往上的暖橙 + 天空冷蓝环境光
const sun = new THREE.DirectionalLight('#FFD3B0', 2.4); sun.position.set(-10, 9, -9); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 8, bottom: -8, near: 1, far: 60 }); sun.shadow.bias = -.0005;
scene.add(sun, sun.target);
const city = new THREE.DirectionalLight('#F2A36B', 1.1); city.position.set(2, -8, 6); scene.add(city);
scene.add(new THREE.HemisphereLight('#B9AEE8', '#7A5C9E', 1.6));

// ───────── 效果配置 ─────────
const FULL = {
  outline: { width: num('lw', 2.6), wobble: num('wob', 1.2) },
  kuwahara: { radius: num('kr', 5), strength: num('ks', 1), farRadius: num('kf', 8), farStart: 30, farEnd: 100 },
  bloom: { strength: num('bs', .6), threshold: .72, radius: .7 },
  grade: { warmth: .14, lift: [.035, .022, .06], gamma: 1, gain: 1.02, saturation: 1.04 },
  fog: { color: '#9C8FD8', colorHigh: '#F2A0A6', density: .012, start: 12, max: .75, baseHeight: -3, falloff: 9, cutoff: 150 },
  paper: { strength: num('pk', .12) },
  vignette: .22,
};
const OFF = { outline: false, kuwahara: false, bloom: false, grade: false, fog: null, paper: false, vignette: 0 };
const cfg = Q.get('cfg') || 'full';
const P = {
  raw: OFF,
  line: { ...OFF, outline: FULL.outline },
  kuwa: { ...OFF, kuwahara: FULL.kuwahara },
  bloom: { ...OFF, bloom: FULL.bloom },
  grade: { ...OFF, grade: FULL.grade },
  fog: { ...OFF, fog: FULL.fog },
  paper: { ...OFF, paper: FULL.paper, vignette: FULL.vignette },
  full: FULL,
  nolines: { ...FULL, outline: false },
  nokuwa: { ...FULL, kuwahara: false },
}[cfg] || FULL;

const shot = Q.get('shot') || 'mid';
// hud=1：模拟眼镜显示层（矢量线框 + 文字），验证「最后叠加、永远锐利」的接法
let hud = null;
if (Q.has('hud')) {
  const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 256; const x = cv.getContext('2d');
  x.strokeStyle = 'rgba(234,246,255,.85)'; x.lineWidth = 3; x.strokeRect(6, 6, 300, 120);
  x.fillStyle = 'rgba(234,246,255,.85)'; x.font = '40px sans-serif'; x.fillText('识别中…', 330, 70);
  x.fillStyle = '#9FE8FF'; x.font = '28px sans-serif'; x.fillText('导航 · 吴淞口 23 km', 330, 120);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const hs = new THREE.Scene(), hc = new THREE.OrthographicCamera(0, W, H, 0, -1, 1);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1024, 256), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }));
  m.position.set(1240, 860, 0); hs.add(m); hud = { scene: hs, cam: hc };
}
window.DUR = 4;
window.render = t => {
  // 鲲一拍三（8 fps 动画时钟），镜头 24 fps 平滑
  const tq = Math.floor(t * 8 + 1e-6) / 8;
  kun.rotation.set(.05 * Math.sin(tq * 1.3), -.2 + .1 * Math.sin(tq * .9), .04 * Math.sin(tq * 1.7));
  kun.position.y = .25 * Math.sin(tq * 1.1);
  const tc = Q.has('still') ? 0 : t;   // still=1：镜头不动，只看一拍二/一拍三
  if (shot === 'close') { camera.position.set(4.2 + tc * .05, 1.4, 6.2); camera.lookAt(1.6, .3, 0); }
  else { camera.position.set(-1.5 + tc * .12, 1.2, 17); camera.lookAt(-1.2, .2, 0); }
  camera.updateProjectionMatrix();
  look.render(scene, camera, { t, ...P, grain: num('grain', 0), debug: Q.get('dbg') || undefined });
  if (hud) { renderer.autoClear = false; renderer.render(hud.scene, hud.cam); renderer.autoClear = true; }   // 眼镜显示层：在后期之后直接画，不受 Kuwahara / bloom / 纸纹影响
};
// 计时：渲 n 帧，每帧 readPixels 1 像素强制 GPU 同步
window.bench = (n = 10, t0 = 1) => {
  const gl = renderer.getContext(), px = new Uint8Array(4), out = [];
  for (let i = 0; i < n; i++) { const a = performance.now(); window.render(t0 + i / 24); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); out.push(performance.now() - a); }
  return out;
};
await Promise.all([look.ready, new Promise(r => { if (skyTex.image) r(); else skyTex.onUpdate = r; const iv = setInterval(() => { if (skyTex.image) { clearInterval(iv); r(); } }, 20); })]);
window.render(0);
window.READY = true;
