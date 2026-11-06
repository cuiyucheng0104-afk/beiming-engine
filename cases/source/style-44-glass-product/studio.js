// 暗场玻璃摄影棚：灯条小场景每帧烘成 PMREM（扫光是一条真的灯条在相机背后的弧上走），
// 背景深灰径向渐变，黑色亮面地板（模糊镜面 + 手写焦散 + 彩虹光斑 + 节拍光环），光束与七色光线，透镜镜头用的灯墙。
import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';

export const SPECTRUM = ['#ff3b3b', '#ff8a2a', '#ffe14a', '#4dff7a', '#3fe2ff', '#4a6bff', '#9a5cff'].map(c => new THREE.Color(c));

export function makeStudio(renderer, scene) {
  // —— 灯条场景（只用来烘环境图）——
  const env = new THREE.Scene(); env.background = new THREE.Color('#000000');
  const strip = (w, h, col = '#ffffff') => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(col), side: THREE.DoubleSide })); env.add(m); return m; };
  const face = (m, p) => { m.position.set(...p); m.lookAt(0, 0, 0); };
  const L = {
    left: strip(24, 190, '#f2f7ff'), right: strip(24, 190, '#fff9f1'),     // 背后两侧竖灯条：勾左右轮廓
    back: strip(280, 14, '#e9f0ff'),                                         // 远处横灯条：地平线的边光
    top: strip(170, 80, '#ffffff'),                                          // 顶部大柔光箱：给金属和玻璃体积
    front: strip(160, 50, '#ffffff'),                                        // 很弱的前补光
    key: strip(130, 60, '#ffffff'),                                          // 前上方主光：只在部件要逐个读清时开
    beam: strip(18, 18, '#ffffff'),                                          // 光束的光源（左上）
    sweep: strip(28, 260, '#ffffff'),                                        // 扫光灯条
    accent: strip(150, 150, '#62d6ff'),                                      // 强调色反光卡：跟着光脉冲
  };
  face(L.left, [-155, 40, -70]); face(L.right, [155, 40, -80]); face(L.back, [0, 25, -200]); face(L.top, [0, 175, 10]);
  face(L.front, [0, 10, 175]); face(L.key, [0, 150, 125]); face(L.beam, [-150, 110, 30]); face(L.accent, [0, -70, 120]);
  const BASE = { left: 3.2, right: 3.2, back: 1.4, top: 1.0, front: .15, key: 0, beam: 0, accent: 0 };
  const COL = {}; for (const k in L) COL[k] = L[k].material.color.clone();

  // 背景：深灰径向渐变（把玻璃边从纯黑里分出来），地板远处融进它，没有地平线
  const bgc = document.createElement('canvas'); bgc.width = 512; bgc.height = 288;
  { const g = bgc.getContext('2d'), gr = g.createRadialGradient(256, 130, 8, 256, 150, 310); gr.addColorStop(0, '#3a3e44'); gr.addColorStop(.42, '#17191c'); gr.addColorStop(1, '#030303'); g.fillStyle = gr; g.fillRect(0, 0, 512, 288); }
  const bgTex = new THREE.CanvasTexture(bgc); bgTex.colorSpace = THREE.SRGBColorSpace;
  scene.background = bgTex; scene.backgroundIntensity = 0;

  const pmrem = new THREE.PMREMGenerator(renderer); let envRT = null;
  // o: { left,right,back,top,front,key,beam,accent: 倍数, sweep:{az,x,I,tilt,y}, accentCol }
  function updateEnv(o = {}) {
    for (const k in BASE) { const I = (o[k] ?? (BASE[k] ? 1 : 0)) * (BASE[k] || 1); L[k].material.color.copy(COL[k]).multiplyScalar(I); L[k].visible = I > 1e-4; }
    if (o.accentCol) L.accent.material.color.copy(o.accentCol).multiplyScalar(o.accent || 0);
    const sw = o.sweep || { I: 0 }; L.sweep.visible = sw.I > 0;
    if (sw.I > 0) {
      const a = sw.az + sw.x * 1.35, r = 175;
      L.sweep.position.set(Math.sin(a) * r, 30 + (sw.y || 0), Math.cos(a) * r); L.sweep.lookAt(0, 0, 0); L.sweep.rotateZ(sw.tilt || 0);
      L.sweep.material.color.setRGB(sw.I, sw.I, sw.I);
    }
    const rt = pmrem.fromScene(env, 0, 1, 1000); scene.environment = rt.texture; if (envRT) envRT.dispose(); envRT = rt;
  }

  // —— 地板 ——
  const U0 = {
    color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null },
    uRefl: { value: .3 }, uFade: { value: 300 }, uTime: { value: 0 },
    uPool: { value: new THREE.Vector4(0, 0, 40, 0) },                               // 瓶底焦散：xz、半径、强度
    uPoolOff: { value: new THREE.Vector2(0, 0) },
    uRain: { value: Array.from({ length: 7 }, () => new THREE.Vector4(0, 0, 10, 0)) },  // 七色落点：xz、大小、强度
    uRainAx: { value: new THREE.Vector2(1, 0) },
    uSpec: { value: SPECTRUM.map(c => new THREE.Vector3(c.r, c.g, c.b)) },
    uWave: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 0, 0)) },   // 光环：xz、半径、强度
    uA: { value: new THREE.Color('#62d6ff') }, uB: { value: new THREE.Color('#a68cff') },
    uSpot: { value: .02 }, uCenter: { value: new THREE.Vector2(0, 0) },
    uBg: { value: bgTex }, uBgI: { value: 0 }, uRes: { value: new THREE.Vector2(3840, 2160) },
  };
  const floorShader = {
    name: 'PrismFloor', uniforms: U0,
    vertexShader: `uniform mat4 textureMatrix; varying vec4 vUv; varying vec3 vW;
      void main(){ vUv = textureMatrix * vec4(position, 1.); vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform sampler2D tDiffuse; uniform float uRefl, uFade, uTime, uSpot; uniform vec4 uPool; uniform vec2 uPoolOff; uniform vec4 uRain[7]; uniform vec2 uRainAx; uniform vec3 uSpec[7];
      uniform vec4 uWave[8]; uniform vec3 uA, uB; uniform vec2 uCenter; uniform sampler2D uBg; uniform float uBgI; uniform vec2 uRes;
      varying vec4 vUv; varying vec3 vW;
      vec2 h2(vec2 p){ p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
      float vor(vec2 p, float t){ vec2 i = floor(p), f = fract(p); float d1 = 8., d2 = 8.;
        for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) { vec2 g = vec2(float(x), float(y)); vec2 o = h2(i + g); o = .5 + .42 * sin(t + 6.2831 * o);
          float d = length(g + o - f); if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
        return d2 - d1; }
      // 焦散细丝：扭曲过的 Voronoi 边
      float caus(vec2 p, float t){ vec2 q = p + .5 * vec2(sin(p.y * 1.2 + t), cos(p.x * 1.05 - t * .8)); q += .22 * vec2(sin(q.y * 3.3 - t * 1.4), cos(q.x * 2.9 + t)); float e = vor(q * 1.3, t * 1.1); return exp(-e * 13.) * (.55 + .45 * sin(q.x * 2.1 + q.y * 1.3 + t)); }
      void main(){
        vec2 xz = vW.xz; float r0 = length(xz - uCenter);
        vec3 refl = vec3(0.);
        for (int i = 0; i < 12; i++) { float a = float(i) * 2.39996; float rr = sqrt((float(i) + .5) / 12.) * 5.;
          vec4 uv = vUv + vec4(cos(a) * rr, sin(a) * rr, 0., 0.) * vUv.w / 650.; refl += texture2DProj(tDiffuse, uv).rgb; }
        refl /= 12.;
        float fade = exp(-r0 * r0 / (uFade * uFade));
        vec3 col = refl * uRefl * fade;
        col += vec3(.018, .018, .02) * exp(-r0 * r0 / 12000.) * (1. + uSpot * 10.);
        // 瓶底焦散：透镜环（RGB 半径错开 = 色散）+ 细丝网
        if (uPool.w > 0.) {
          vec2 d = xz - uPool.xy - uPoolOff; float r = length(d) / uPool.z; float m = exp(-r * r * 1.4);
          vec2 p = d / uPool.z * 3.0;
          vec3 c3 = vec3(caus(p * .982, uTime), caus(p, uTime), caus(p * 1.018, uTime));
          vec3 rr3 = vec3(exp(-pow((r - .66) / .055, 2.)), exp(-pow((r - .69) / .055, 2.)), exp(-pow((r - .72) / .055, 2.)));
          col += (c3 * m * .6 + rr3 * .9) * uPool.w * mix(vec3(1.), uA * 1.25, .25);
        }
        // 七色落点：沿光谱轴拉长的光斑，彼此相接成一条彩带，上面叠流动的细丝
        vec2 ax = uRainAx, nx = vec2(-ax.y, ax.x);
        for (int k = 0; k < 7; k++) { vec4 R = uRain[k]; if (R.w <= 0.) continue;
          vec2 d = xz - R.xy; float u = dot(d, ax) / R.z, v = dot(d, nx) / (R.z * 3.2);
          float blob = exp(-(u * u + v * v) * 1.6);
          float fil = caus(d / R.z * 1.4 + vec2(float(k) * 1.7, 0.), uTime * 1.2);
          col += uSpec[k] * R.w * blob * (.55 + 1.6 * fil);
        }
        // 节拍光环：从瓶底扩散的彩色光环（三色错开）
        for (int k = 0; k < 8; k++) { vec4 Wv = uWave[k]; if (Wv.w <= 0.) continue;
          float r = length(xz - Wv.xy); float x = (r - Wv.z) / (.9 + Wv.z * .03);
          vec3 band = vec3(exp(-pow(x + .4, 2.) * 3.), exp(-x * x * 3.), exp(-pow(x - .4, 2.) * 3.));
          col += band * mix(uA, uB, clamp(Wv.z / 120., 0., 1.)) * Wv.w * exp(-r * r / 16000.);
        }
        vec3 bgc = texture2D(uBg, gl_FragCoord.xy / uRes).rgb * uBgI;
        col = mix(bgc, col, exp(-r0 * r0 / (uFade * uFade * 2.2)));
        gl_FragColor = vec4(col, 1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`
  };
  const floor = new Reflector(new THREE.PlaneGeometry(4000, 4000), { shader: floorShader, textureWidth: 1920, textureHeight: 1080, clipBias: .002, multisample: 4 });
  floor.rotation.x = -Math.PI / 2; floor.position.y = 0; scene.add(floor);
  const reflUpdate = floor.onBeforeRender.bind(floor); floor.onBeforeRender = () => { };   // 镜面每帧手动更新一次（否则透射预渲染会再画一遍）
  const U = floor.material.uniforms;

  // —— 光束（加色、柔边：法线与视线夹角越正越亮）——
  const beamMat = (col) => new THREE.ShaderMaterial({
    uniforms: { uCol: { value: new THREE.Color(col) }, uI: { value: 0 }, uLen: { value: 1 }, uSoft: { value: 2.2 }, uHead: { value: 0 } },
    vertexShader: `varying vec3 vN; varying vec3 vV; varying float vY; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vY = uv.y; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 uCol; uniform float uI, uLen, uSoft, uHead; varying vec3 vN; varying vec3 vV; varying float vY;
      void main(){ float y = 1. - vY; if (y > uLen) discard; float f = pow(abs(dot(normalize(vN), normalize(vV))), uSoft);
        float head = exp(-pow((uLen - y) / .04, 2.)) * uHead; float tail = smoothstep(0., .06, y);
        gl_FragColor = vec4(uCol * (f * uI * (1. + head * 3.) * tail), 1.); }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
  // 从 a 指向 b 的圆柱（局部 uv.y：1 在 a 端，0 在 b 端）
  function beam(a, b, r0, r1, col) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, 1, 32, 1, true), beamMat(col));
    m.userData.set = (A, B) => { const d = B.clone().sub(A), L = d.length(); m.position.copy(A).addScaledVector(d, .5); m.scale.set(1, L, 1); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()); m.rotateX(Math.PI); };
    m.userData.set(a, b); m.frustumCulled = false; m.renderOrder = 10; scene.add(m); return m;
  }

  // —— 灯墙（透镜镜头里给玻璃折射的背景）：少量、等距、较宽的冷白竖灯条，只一个颜色族——
  // 规则的条纹穿过厚玻璃时，变宽、弯折、断开一眼就能读出来
  const wall = new THREE.Group(); scene.add(wall);
  for (let i = 0; i < 11; i++) {
    const x = -300 + i * 60, w = 9, h = 230;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color('#eef4ff').multiplyScalar(i % 2 ? .6 : .85) }));
    m.position.set(x, 15 + h / 2, -320); wall.add(m);
  }
  wall.visible = false;

  // —— 背光卡：瓶身正后方的暗灰竖向渐变 + 两条柔和侧后灯条（加色、软边、不写深度）。
  // 不标 transparent → 进不透明列表 → 会被画进透射缓冲，玻璃折射它，瓶壁才读得出来 ——
  const cardC = document.createElement('canvas'); cardC.width = 256; cardC.height = 512;
  { const g = cardC.getContext('2d'), img = g.createImageData(256, 512);
    for (let y = 0; y < 512; y++) for (let x = 0; x < 256; x++) {
      const u = x / 255 * 2 - 1, v = y / 511;
      const fx = Math.exp(-u * u * 2.2), fy = Math.sin(Math.PI * Math.min(1, v * 1.15)) ** .8 * (1 - .35 * v);
      const bands = Math.exp(-(((Math.abs(u) - .5) / .085) ** 2)) * 1.0;
      const L = Math.min(1, (.30 * fx + bands * .9) * fy);
      const i = (y * 256 + x) * 4; img.data[i] = L * 235; img.data[i + 1] = L * 242; img.data[i + 2] = L * 252; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0); }
  const cardTex = new THREE.CanvasTexture(cardC); cardTex.colorSpace = THREE.SRGBColorSpace;
  const card = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: cardTex, color: new THREE.Color(1, 1, 1), blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: true }));
  card.visible = false; card.renderOrder = -1; scene.add(card);
  // 放到 target 背后 dist 处、正对相机（只绕竖轴转），宽 w 高 h，强度 I
  function backCard(camera, target, dist, w, h, I) {
    card.visible = I > 0; if (!card.visible) return;
    const d = new THREE.Vector3(target.x - camera.position.x, 0, target.z - camera.position.z).normalize();
    card.position.copy(target).addScaledVector(d, dist); card.position.y = target.y;
    card.scale.set(w, h, 1); card.lookAt(camera.position.x, target.y, camera.position.z);
    card.material.color.setScalar(I);
  }

  return {
    env, L, updateEnv, floor, U, bgTex, beam, wall, card, backCard,
    reflect(camera, hide = []) { const v = hide.map(o => o.visible); hide.forEach(o => o.visible = false); reflUpdate(renderer, scene, camera); hide.forEach((o, i) => o.visible = v[i]); },
  };
}
