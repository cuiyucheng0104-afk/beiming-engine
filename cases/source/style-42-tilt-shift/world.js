// 港口一日 · 世界：码头、岸桥、集装箱船、堆场、卡车环线、拖船、灯、招牌
// 坐标：x 向东，z 向南（+z 朝向主机位），y 向上；单位米。水在 z<0，岸线 z=0。
import * as THREE from 'three';
import { GB } from './geo.js';
import { clamp, lerp, seg, ss, hash, mulberry } from '/core/lib.js';

// —— 全局 uniform：云影、夜、水面 ——
export const U = {
  cloud: { value: 0 }, blobs: { value: Array.from({ length: 6 }, () => new THREE.Vector4(1e5, 1e5, 1, 1)) },
  night: { value: 0 }, waterT: { value: 0 }, waterAmp: { value: 1 }, sky: { value: new THREE.Color('#9cc4e4') },
};

const NOISE = `
  float wh(vec3 p){ p = fract(p*vec3(.1031,.1030,.0973)); p += dot(p, p.yxz+33.33); return fract((p.x+p.y)*p.z); }
  float wn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f); float a = wh(vec3(i,1.)), b = wh(vec3(i+vec2(1,0),1.)), c = wh(vec3(i+vec2(0,1),1.)), d = wh(vec3(i+vec2(1,1),1.)); return mix(mix(a,b,f.x), mix(c,d,f.x), f.y); }
  float fbm(vec2 p){ return wn(p)*.5 + wn(p*2.03+7.1)*.27 + wn(p*4.1-3.3)*.15 + wn(p*8.3+1.7)*.08; }
  uniform float uCloud; uniform vec4 uBlob[6];
  // 云影覆盖度 0..1：前沿收硬（归一化半径 .80–.90，中点 .85 = cloudArrive 的判定线），噪声只让前沿轻微起伏
  float cloudCov(vec2 xz){
    if (uCloud <= 0.) return 0.;
    float c = 0.;
    for (int i = 0; i < 6; i++) {
      vec2 d = (xz - uBlob[i].xy) / uBlob[i].zw;
      float r = length(d) + (fbm(xz * .0032 + float(i) * 3.7) - .5) * .42;
      c = max(c, 1. - smoothstep(.80, .90, r));
    }
    return c * uCloud * (.9 + .1 * fbm(xz * .02));
  }`;

// 给 MeshStandardMaterial 打补丁：世界坐标、云影、（可选）做旧噪声与贴地变暗
export function patch(m, o = {}) {
  const key = 'p' + (o.tug ? 't' + o.tug : '') + (o.grime ? 'g' : '') + (o.water ? 'w' : '') + (o.win ? 'f' : '') + (o.ground ? 'd' : '');
  m.customProgramCacheKey = () => key;
  m.onBeforeCompile = sh => {
    sh.uniforms.uCloud = U.cloud; sh.uniforms.uBlob = U.blobs; sh.uniforms.uNight = U.night; sh.uniforms.uWT = U.waterT; sh.uniforms.uWA = U.waterAmp; sh.uniforms.uSky = U.sky;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vCW;' + (o.tug ? '\nvarying vec3 vLP;' : '') + (o.win ? '\nattribute vec3 wp; varying vec3 vWp; varying vec2 vFac;' : ''))
      .replace('#include <project_vertex>', `#include <project_vertex>
      #ifdef USE_INSTANCING
        vCW = (modelMatrix * instanceMatrix * vec4(transformed, 1.)).xyz;
      #else
        vCW = (modelMatrix * vec4(transformed, 1.)).xyz;
      #endif
      ${o.win ? 'vWp = wp; vFac = uv;' : ''} ${o.tug ? 'vLP = transformed;' : ''}`);
    let fs = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vCW; uniform float uNight, uWT, uWA; uniform vec3 uSky; float gCloud = 0.; ${o.tug ? 'varying vec3 vLP;' : ''} ${o.win ? 'varying vec3 vWp; varying vec2 vFac; float gLit = 0.;' : ''}
      ${NOISE}`);
    if (o.grime) fs = fs.replace('#include <color_fragment>', `#include <color_fragment>
      { float gn = wn(vCW.xz * .55 + vCW.y * .13) * .6 + wn(vCW.xz * 2.7 - vCW.y * .9) * .4; diffuseColor.rgb *= .88 + .2 * gn;
        diffuseColor.rgb *= mix(.66, 1., smoothstep(0., 3.2, vCW.y)); }`);
    // 拖船（物体局部坐标，船动时污渍不"游"）：斑驳、舷边锈流痕、水线锈带/藻痕、贴水变暗、甲板油污
    if (o.tug) fs = fs.replace('#include <color_fragment>', `#include <color_fragment>
      { vec3 p = vLP; float k = ${o.tug === 2 ? '1.' : '0.'};
        float mot = fbm(p.xz * 1.6 + p.y * .7) * .6 + wn(p.xz * 7.3 + p.y * 3.1) * .4;
        diffuseColor.rgb *= .7 + .45 * mot;
        float st = smoothstep(.58, .9, wn(vec2(p.x * 3.1 + p.z * 2.3, p.y * .32))) * smoothstep(2.9, .2, p.y) * (1. - k);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.3, .13, .06), st * .8);
        float wl = 1. - smoothstep(-.62, -.12, p.y + (wn(p.xz * 2.) - .5) * .25);
        diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(.2, .11, .06), vec3(.12, .16, .09), wn(p.xz * 4.)), wl * .85 * (1. - k));
        diffuseColor.rgb *= mix(.62, 1., smoothstep(-.6, 1.4, p.y)) * (1. - k) + k;
        float oil = smoothstep(.62, .8, fbm(p.xz * .9 + 4.)) * k; diffuseColor.rgb *= 1. - .45 * oil;
        float scuff = smoothstep(.7, .9, wn(p.xz * 5.5)) * k; diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.45, .43, .36), scuff * .5); }`);
    if (o.ground) fs = fs.replace('#include <color_fragment>', `#include <color_fragment>
      { float gn = fbm(vCW.xz * .045) * .55 + wn(vCW.xz * .6) * .3 + wn(vCW.xz * 3.1) * .15; diffuseColor.rgb *= .84 + .3 * gn;
        float oil = smoothstep(.72, .8, wn(vCW.xz * .11 + 3.)); diffuseColor.rgb *= 1. - .18 * oil; }`);
    if (o.win) fs = fs.replace('#include <color_fragment>', `#include <color_fragment>
      if (vFac.x >= 0. && vWp.x > 0.) {
        vec2 cs = vWp.xy; vec2 q = vFac / cs; vec2 id = floor(q); vec2 f = fract(q);
        float wx = vWp.z > .5 ? .06 : .26, wy0 = .3, wy1 = .8;
        vec2 fw = fwidth(q) * 1.2;
        float win = smoothstep(wx-fw.x, wx+fw.x, f.x) * (1.-smoothstep(1.-wx-fw.x, 1.-wx+fw.x, f.x)) * smoothstep(wy0-fw.y, wy0+fw.y, f.y) * (1.-smoothstep(wy1-fw.y, wy1+fw.y, f.y));
        float r = wh(vec3(id, vWp.z * 13.1));
        vec3 glass = mix(vec3(.05,.07,.1), uSky * .75, .2 + .45 * r);
        diffuseColor.rgb = mix(diffuseColor.rgb, glass, win);
        gLit = win * step(.35, r);
      }`).replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      totalEmissiveRadiance += gLit * uNight * vec3(1., .74, .44) * 1.6;`);
    if (o.water) fs = fs.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      { vec2 p = vCW.xz; float t = uWT;
        float e = .6;
        float h0 = fbm(p * .09 + vec2(t * .05, t * .03)) + .5 * fbm(p * .31 - vec2(t * .11, -t * .07));
        float hx = fbm((p + vec2(e, 0.)) * .09 + vec2(t * .05, t * .03)) + .5 * fbm((p + vec2(e, 0.)) * .31 - vec2(t * .11, -t * .07));
        float hz = fbm((p + vec2(0., e)) * .09 + vec2(t * .05, t * .03)) + .5 * fbm((p + vec2(0., e)) * .31 - vec2(t * .11, -t * .07));
        vec3 nW = normalize(vec3(-(hx - h0) / e * 2.2 * uWA, 1., -(hz - h0) / e * 2.2 * uWA));
        normal = normalize((viewMatrix * vec4(nW, 0.)).xyz); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
      { float deep = smoothstep(-20., -170., vCW.z); diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(.55, .72, .95), deep);
        diffuseColor.rgb *= .92 + .14 * fbm(vCW.xz * .012); }`);
    // 云影：直射光大幅压暗、反射天空也压暗（水面），再把被遮住的区域降饱和、偏冷蓝（暗部压到约 40%）
    fs = fs.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
      { gCloud = cloudCov(vCW.xz); reflectedLight.directDiffuse *= 1. - .8 * gCloud; reflectedLight.directSpecular *= 1. - .9 * gCloud;
        reflectedLight.indirectDiffuse *= 1. - .15 * gCloud; reflectedLight.indirectSpecular *= 1. - .45 * gCloud; }`)
      .replace('#include <opaque_fragment>', `{ float lc = dot(outgoingLight, vec3(.2126, .7152, .0722));
        outgoingLight = mix(outgoingLight, mix(vec3(lc), outgoingLight, .5) * vec3(.86, .95, 1.16), gCloud); }
      #include <opaque_fragment>`);
    sh.fragmentShader = fs;
  };
  return m;
}
const std = (o = {}, p = {}) => patch(new THREE.MeshStandardMaterial({ roughness: .8, metalness: 0, ...o }), p);

// —— 程序纹理 ——
function canvasTex(w, h, draw, rep = false) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); draw(g, w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  if (rep) t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}
// 集装箱：竖向瓦楞 + 门端 + 污渍（灰度，实例色乘上去）
const containerTex = () => canvasTex(512, 128, (g, w, h) => {
  const R = mulberry(5);
  g.fillStyle = '#e8e8e8'; g.fillRect(0, 0, w, h);
  for (let x = 0; x < w; x += 6) { g.fillStyle = 'rgba(0,0,0,.16)'; g.fillRect(x, 0, 2, h); g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(x + 3, 0, 1, h); }
  g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, 0, w, 5); g.fillRect(0, h - 6, w, 6); g.fillRect(0, 0, 6, h); g.fillRect(w - 6, 0, 6, h);
  for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(60,40,20,${.04 + R() * .08})`; const x = R() * w, y = R() * h; g.fillRect(x, y, 4 + R() * 30, 2 + R() * 18); }
  g.fillStyle = 'rgba(255,255,255,.55)'; g.fillRect(30, 24, 70, 10); g.fillRect(30, 40, 46, 7);
});
const radial = (inner = 'rgba(255,255,255,1)', mid = .25) => canvasTex(128, 128, (g, w, h) => {
  const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  gr.addColorStop(0, inner); gr.addColorStop(mid, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
});

// 光池贴图：平方反比衰减 1/(1+(r/r0)²)，边缘平滑归零（不出"气泡"边）
const invSq = () => canvasTex(256, 256, (g, w, h) => {
  const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2), r0 = .16, tail = 1 / (1 + 1 / (r0 * r0));
  for (let i = 0; i <= 24; i++) { const r = i / 24, f = Math.max(0, (1 / (1 + (r / r0) ** 2) - tail) / (1 - tail)) * (1 - r * r); gr.addColorStop(r, `rgba(255,255,255,${f.toFixed(4)})`); }
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
});

export const BOX = [12.2, 2.6, 2.44];      // 40 尺箱
export const CBOX = ['#c8372d', '#1f5fae', '#e8812a', '#3e9a4a', '#efefe8', '#f2c230', '#2c8f9a', '#9a3b6e', '#d95a3a', '#3f4fa0', '#7a8a92', '#e0b23a'];

// ———————————————————————————————————————————————————————————————
export function buildWorld(scene) {
  const W = {};
  const bmat = std({ vertexColors: true, roughness: .84 }, { grime: true });
  const fmat = std({ vertexColors: true, roughness: .8, emissive: '#000' }, { grime: true, win: true });
  const gmat = std({ vertexColors: true, roughness: .93 }, { ground: true });

  // —— 地面：水、码头、堆场、道路、绿地 ——
  const water = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000).rotateX(-Math.PI / 2), std({ color: '#2a9fb3', roughness: .14, metalness: .05, envMapIntensity: 1.2 }, { water: true }));
  water.position.set(0, -.6, -2000 + 0); water.receiveShadow = true; scene.add(water);
  const G = new GB();
  // 陆地（南侧大片）
  G.box(-2000, 2000, -3, 0, 0, 2400, '#b9b2a2', '#c9c2b2', { noSides: true });
  G.box(-2000, 2000, -3, 0, 0, 0.01, '#8f8a80');
  // 码头前沿（浅混凝土）z 0–50
  G.flat(-420, 230, 0, 50, .03, '#d3ccbd');
  // 堆场沥青 z 50–205
  G.flat(-420, 230, 50, 205, .04, '#5d6064');
  // 环线道路（深色）
  G.flat(-276, 160, 9, 21, .06, '#4c4f54');       // 岸桥下车道
  G.flat(144, 156, 9, 199, .065, '#4c4f54');      // 东侧
  G.flat(-276, 160, 187, 199, .06, '#4c4f54');     // 南侧
  G.flat(-276, -264, 9, 199, .065, '#4c4f54');    // 西侧
  // 城市路 z 258–272
  G.flat(-2000, 2000, 256, 274, .05, '#45484d');
  for (let x = -2000; x < 2000; x += 9) G.flat(x, x + 4.5, 264.8, 265.2, .07, '#e9e4d6');
  G.flat(-2000, 2000, 254.5, 255.5, .07, '#d9d4c6'); G.flat(-2000, 2000, 274.5, 275.5, .07, '#d9d4c6');
  // 绿带与草地
  G.flat(-2000, 2000, 276, 300, .045, '#5f9e3c'); G.flat(-2000, 2000, 236, 254, .045, '#6aa844');
  G.flat(230, 2000, 0, 236, .02, '#c3bba9');
  // 岸桥轨道、黄线、白色车位线
  for (const z of [4, 34]) { G.flat(-420, 230, z - .25, z + .25, .08, '#3a3836'); G.flat(-420, 230, z + 1.2, z + 1.7, .08, '#3a3836'); }
  for (const z of [8.6, 21.4]) G.flat(-270, 160, z - .2, z + .2, .08, '#f0c43a');
  for (let x = -268; x < 158; x += 8) G.flat(x, x + 4, 14.85, 15.15, .08, '#ecebe4');
  for (let z = 22; z < 190; z += 8) G.flat(149.85, 150.15, z, z + 4, .08, '#ecebe4');
  for (let x = -268; x < 146; x += 8) G.flat(x, x + 4, 192.85, 193.15, .08, '#ecebe4');
  // 码头边缘：系缆桩与护舷
  G.box(-420, 230, -1.6, .25, -1.2, 0, '#2d2e30', '#c9c2b4');
  for (let x = -400; x < 230; x += 18) { G.cyl(x, 1.2, .45, 0, .9, '#2a2a2c', 8); G.box(x - 1, x + 1, -1.4, .4, -1.6, -1.1, '#202022'); }
  // 堆场车道白线
  for (const zc of [65, 105, 145]) for (const z of [zc - 10.5, zc + 10.5]) for (let x = -240; x < 135; x += 10) G.flat(x, x + 5, z - .15, z + .15, .08, '#d8d6cc');
  // 防波堤（西）与东突堤
  G.box(-1400, 100, -2, 4.2, -213, -199, '#a8a49a', '#c9c4b8');
  G.box(-1400, 100, 4.2, 5.2, -209, -203, '#bdb8ac', '#d8d3c7');
  G.box(220, 1400, -2, 2.2, -200, 0, '#b9b2a2', '#c6bfaf');
  G.flat(232, 1400, -190, -8, 2.25, '#c9c2b2');
  // 东突堤上的油罐（白）、小仓库
  for (const [x, z, r] of [[270, -150, 13], [305, -150, 13], [340, -150, 13], [270, -110, 11], [305, -110, 11]]) { G.cyl(x, z, r, 2.2, 15, '#eeeae2', 24); G.cyl(x, z, r * .9, 15, 15.6, '#d8d4cc', 24); }
  // 西侧工作船码头（小）
  W.ground = G;
  const ground = new THREE.Mesh(G.build(), gmat); ground.receiveShadow = true; ground.castShadow = true; scene.add(ground);

  // 防波堤消波块
  {
    const geo = new THREE.DodecahedronGeometry(1.6, 0), R = mulberry(31), n = 900;
    const m = new THREE.InstancedMesh(geo, std({ color: '#c4beb2', roughness: .95 }, { grime: true }), n), M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler();
    for (let i = 0; i < n; i++) { const x = -900 + R() * 1000, side = R() < .5 ? -1 : 1; E.set(R() * 6, R() * 6, R() * 6); Q.setFromEuler(E); M.compose(new THREE.Vector3(x, .8 + R(), -206 + side * (7.5 + R() * 3)), Q, new THREE.Vector3(1, 1, 1).multiplyScalar(.7 + R() * .6)); m.setMatrixAt(i, M); }
    m.castShadow = m.receiveShadow = true; scene.add(m);
  }

  // —— 建筑：仓库（赤陶/钴蓝屋顶）、港务楼（招牌）、门卫 ——
  const B = new GB(), R = mulberry(9);
  const sheds = [];
  for (let i = 0; i < 6; i++) { const x0 = -420 + i * 105; sheds.push([x0, x0 + 88, 208, 232]); }
  const roofC = ['#b4553c', '#2f6db0', '#c26a48', '#3a8a8a', '#b4553c', '#5f6770'];
  sheds.forEach(([x0, x1, z0, z1], i) => {
    B.box(x0, x1, 0, 9, z0, z1, '#ece4d2', roofC[i], { facade: true, wp: [6, 4.5, .9] , noTop: true });
    B.gable(x0, x1, z0, z1, 9, 3.5, roofC[i], '#ece4d2', true);
    for (let k = 0; k < 6; k++) B.box(x0 + 6 + k * 14, x0 + 12 + k * 14, 0, 5.2, z1, z1 + .3, '#8a8f96');   // 卷帘门
  });
  // 港务楼（招牌所在）
  const OF = { x0: 166, x1: 204, z0: 52, z1: 88, h: 15 };
  B.box(OF.x0, OF.x1, 0, OF.h, OF.z0, OF.z1, '#f3efe6', '#9a968e', { facade: true, wp: [3.2, 3.6, .2] });
  B.box(OF.x0 - .5, OF.x1 + .5, OF.h, OF.h + .9, OF.z0 - .5, OF.z1 + .5, '#d9d3c6', '#8a867e');
  B.box(OF.x0 + 6, OF.x0 + 14, OF.h, OF.h + 3, OF.z0 + 8, OF.z0 + 16, '#c9c4ba', '#77746e');   // 屋顶机房
  for (let k = 0; k < 4; k++) B.box(OF.x0 + 20 + k * 3.4, OF.x0 + 22.4 + k * 3.4, OF.h + .9, OF.h + 2.2, OF.z0 + 22, OF.z0 + 25, '#b7b3aa', '#9b978f');   // 空调外机
  // 门卫与小楼
  B.box(120, 136, 0, 7, 226, 240, '#e9dcc0', '#7a5a4a', { facade: true, wp: [3, 3.5, .3] });
  B.box(-330, -296, 0, 11, 60, 96, '#d8e2dc', '#6e6c69', { facade: true, wp: [3.4, 3.7, .4] });
  // 东突堤仓库
  B.box(250, 330, 2.2, 12, -80, -40, '#e8d9bd', '#c26a48', { facade: true, wp: [7, 5, .8], noTop: true }); B.gable(250, 330, -80, -40, 12, 4, '#c26a48', '#e8d9bd', true);
  B.box(250, 300, 2.2, 9, -30, -10, '#d9c3a0', '#5f6770', { facade: true, wp: [6, 4, .7] });
  // 灯塔（防波堤东端）
  for (let k = 0; k < 6; k++) B.cyl(100, -206, 3.2 - k * .25, 5.2 + k * 3, 8.2 + k * 3, k % 2 ? '#d33a2c' : '#f4f1ea', 16, false);
  B.cyl(100, -206, 2.3, 23.2, 23.6, '#2a2a2c', 16); B.cyl(100, -206, 1.6, 23.6, 26, '#404448', 12);
  const bgeo = B.build();
  const bld = new THREE.Mesh(bgeo, fmat); bld.castShadow = bld.receiveShadow = true; scene.add(bld);
  W.office = OF; W.lighthouse = new THREE.Vector3(100, 25, -206);

  // —— 树（饱和绿）——
  {
    const R2 = mulberry(44), pts = [];
    for (let x = -700; x < 700; x += 11) { pts.push([x + R2() * 4, 284 + R2() * 8, 1]); if (R2() < .6) pts.push([x + R2() * 6, 245 + R2() * 6, .85]); }
    for (let i = 0; i < 18; i++) pts.push([212 + R2() * 14, 50 + R2() * 44, .8]);
    for (let i = 0; i < 14; i++) pts.push([240 + R2() * 120, 20 + R2() * 180, .9]);
    const geo = new THREE.IcosahedronGeometry(3.4, 1), tg = new THREE.CylinderGeometry(.35, .45, 3, 6).translate(0, 1.5, 0);
    const m = new THREE.InstancedMesh(geo, std({ color: '#ffffff', roughness: .9 }, { grime: true }), pts.length), tr = new THREE.InstancedMesh(tg, std({ color: '#6b4a32' }), pts.length);
    const M = new THREE.Matrix4(), C = new THREE.Color();
    pts.forEach(([x, z, s], i) => { const k = s * (.8 + R2() * .5); M.makeScale(k, k * .95, k).setPosition(x, 3 + 3 * k, z); m.setMatrixAt(i, M); m.setColorAt(i, C.set(['#4f9a35', '#3f8a2e', '#69ad3e', '#2f7a34'][i % 4])); M.makeScale(k, k, k).setPosition(x, 0, z); tr.setMatrixAt(i, M); });
    m.castShadow = true; m.receiveShadow = true; tr.castShadow = true; scene.add(m, tr);
  }

  // —— 集装箱（一个实例网格装下所有静态箱：堆场 + 船上）——
  const ctex = containerTex();
  const cgeo = new THREE.BoxGeometry(...BOX);
  const cmat = std({ map: ctex, roughness: .62, metalness: .15 }, { grime: true });
  const statics = [];   // [x,y,z,colorIdx, group, order]
  const RY = mulberry(17);
  // 堆场：三排 × 三列 箱区，6 行 × 10 贝 × 1–4 层
  for (const zc of [65, 105, 145]) for (const [x0, nb] of [[-236, 10], [-98, 10], [40, 7]]) for (let b = 0; b < nb; b++) for (let r = 0; r < 6; r++) {
    const hgt = 1 + Math.floor(Math.pow(RY(), .7) * 4); const x = x0 + b * 12.8 + 6.1, z = zc - 7.5 + r * 2.9;
    for (let k = 0; k < hgt; k++) statics.push([x, 1.3 + k * 2.6, z, Math.floor(RY() * CBOX.length)]);
  }
  // 船上（非作业贝）：x = 60-15k，10 列 × 3 层
  const SHIP = { x0: -128, x1: 88, z0: -37, z1: -5, deck: 12 };
  const bayX = []; for (let k = 0; k <= 10; k++) bayX.push(60 - 15 * k);
  const CR = [-60, 0, 60];
  const shipBay = {};   // 作业贝的箱子（可被吊走）
  for (const x of bayX) {
    const work = CR.includes(x);
    const list = [];
    for (let k = 0; k < 3; k++) for (let r = 0; r < 11; r++) {
      const z = -33.5 + r * 2.5, y = SHIP.deck + 1.3 + k * 2.6, c = Math.floor(RY() * CBOX.length);
      if (work) list.push([x, y, z, c]); else statics.push([x, y, z, c]);
    }
    if (work) { list.sort((a, b) => b[1] - a[1] || b[2] - a[2]); shipBay[x] = list; }   // 先吊顶层、从靠岸侧往外
  }
  const mStat = new THREE.InstancedMesh(cgeo, cmat, statics.length);
  { const M = new THREE.Matrix4(), C = new THREE.Color(); statics.forEach(([x, y, z, c], i) => { M.makeTranslation(x, y, z); mStat.setMatrixAt(i, M); mStat.setColorAt(i, C.set(CBOX[c])); }); }
  mStat.castShadow = mStat.receiveShadow = true; scene.add(mStat);
  // 动态箱：船上作业贝 33×3 + 吊具上 3 + 卡车上 60
  const nDyn = 33 * 3 + 3 + 70;
  const mDyn = new THREE.InstancedMesh(cgeo, cmat, nDyn); mDyn.castShadow = mDyn.receiveShadow = true; mDyn.frustumCulled = false; scene.add(mDyn);
  mDyn.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(nDyn * 3), 3);
  W.mDyn = mDyn; W.shipBay = shipBay; W.CR = CR; W.SHIP = SHIP;

  // —— 集装箱船 ——
  {
    const S = new GB(), { x0, x1, z0, z1, deck } = SHIP, zm = (z0 + z1) / 2, bw = 30;
    const hull = '#1f2c48', boot = '#b83a2e';
    S.box(x0, x1 - 22, -4, deck - 1.2, z0, z1, hull, '#5a5e64');
    S.box(x0, x1 - 22, -4, .6, z0 - .05, z1 + .05, boot);
    S.box(x0 - .1, x1 - 22, deck - 1.2, deck, z0 - .1, z1 + .1, '#e8e4dc', '#6a6e74');   // 舷墙白条
    // 船首：两段收窄
    const bow = (xa, xb, wa, wb, y0, y1, c) => {
      const a = [[xa, z0 + (bw / 2 - wa)], [xb, zm - wb], [xb, zm + wb], [xa, z1 - (bw / 2 - wa)]];
      S.quad([xa, y0, zm + wa], [xb, y0, zm + wb], [xb, y1, zm + wb], [xa, y1, zm + wa], [.3, 0, .95], c);
      S.quad([xb, y0, zm - wb], [xa, y0, zm - wa], [xa, y1, zm - wa], [xb, y1, zm - wb], [.3, 0, -.95], c);
      S.quad([xa, y1, zm + wa], [xb, y1, zm + wb], [xb, y1, zm - wb], [xa, y1, zm - wa], [0, 1, 0], '#5a5e64');
    };
    bow(x1 - 22, x1 - 8, 16, 11, -4, deck, hull); bow(x1 - 8, x1, 11, 1.5, -2, deck + 1.5, hull);
    // 尾楼（白）
    S.box(-122, -106, deck, deck + 16, z0 + 4, z1 - 4, '#f2efe8', '#d4d0c8', { facade: true, wp: [2.2, 2.8, .15] });
    S.box(-118, -108, deck + 16, deck + 19, z0 + 1, z1 - 1, '#f2efe8', '#c9c5bd', { facade: true, wp: [1.6, 3, .1] });
    S.box(-128, -124, deck, deck + 13, zm - 3.5, zm + 3.5, '#2a2a2c', '#c83a2c');   // 烟囱
    // 舱口盖
    for (const x of bayX) S.box(x - 6.6, x + 6.6, deck, deck + .5, z0 + 2, z1 - 2, '#6d7278', '#7d828a');
    const m = new THREE.Mesh(S.build(), fmat); m.castShadow = m.receiveShadow = true; scene.add(m);
  }

  // —— 岸桥 ×3（红白），可动：小车、钢丝、吊具 ——
  const cranes = [];
  {
    const red = '#d6352a', wht = '#f2f0ea';
    for (const cx of CR) {
      const C = new GB();
      for (const z of [4, 34]) for (const dx of [-9, 9]) C.box(cx + dx - .9, cx + dx + .9, .5, 44, z - .9, z + .9, red, red);
      for (const z of [4, 34]) C.box(cx - 10, cx + 10, 40.5, 44, z - 1.1, z + 1.1, red, red);
      for (const dx of [-9, 9]) { C.box(cx + dx - 1, cx + dx + 1, 24, 25.6, 3, 35, red, red); C.box(cx + dx - 1.2, cx + dx + 1.2, 0, 2, 2, 36, '#3a3a3c', '#3a3a3c'); }
      for (const dx of [-5, 5]) C.box(cx + dx - .8, cx + dx + .8, 44, 46.5, -52, 52, wht, wht);   // 大梁（白）
      C.box(cx - 6, cx + 6, 44, 45, -52, -50, wht, wht);
      for (const dx of [-8, 8]) C.box(cx + dx - .8, cx + dx + .8, 44, 70, 32.5, 34.5, red, red);   // A 字架
      C.box(cx - 9, cx + 9, 68, 71, 32.5, 34.5, red, red);
      C.box(cx - 7, cx + 7, 46.5, 52, 38, 50, wht, red, { facade: true, wp: [2, 2.5, .2] });       // 机房
      const m = new THREE.Mesh(C.build(), fmat); m.castShadow = m.receiveShadow = true; scene.add(m);
      // 拉索（细长条）
      const stay = (a, b) => { const g = new THREE.CylinderGeometry(.18, .18, 1, 5); const mm = new THREE.Mesh(g, std({ color: '#404040' })); const d = b.clone().sub(a); mm.position.copy(a).addScaledVector(d, .5); mm.scale.y = d.length(); mm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()); mm.castShadow = true; scene.add(mm); };
      for (const dx of [-5, 5]) { stay(new THREE.Vector3(cx + dx * 1.4, 70, 33.5), new THREE.Vector3(cx + dx, 46, -50)); stay(new THREE.Vector3(cx + dx * 1.4, 70, 33.5), new THREE.Vector3(cx + dx, 46, -12)); stay(new THREE.Vector3(cx + dx * 1.4, 70, 33.5), new THREE.Vector3(cx + dx, 46, 50)); }
      const trolley = new THREE.Mesh(new THREE.BoxGeometry(12, 3.2, 6), std({ color: '#f2f0ea', roughness: .6 }, { grime: true })); trolley.castShadow = true; scene.add(trolley);
      const ropes = new THREE.Mesh(new THREE.BoxGeometry(.25, 1, .25).translate(0, -.5, 0), std({ color: '#2a2a2a' })); scene.add(ropes);
      const ropes2 = ropes.clone(); scene.add(ropes2);
      const spreader = new THREE.Mesh(new THREE.BoxGeometry(12.4, .9, 2.7), std({ color: '#f2c230', roughness: .55 })); spreader.castShadow = true; scene.add(spreader);
      cranes.push({ cx, trolley, ropes, ropes2, spreader });
    }
  }
  W.cranes = cranes;

  // —— 轮胎吊（黄，静态）——
  {
    const Y = new GB();
    for (const [x, zc] of [[-160, 65], [-20, 105], [80, 145], [-60, 145], [100, 65]]) {
      for (const dz of [-11, 11]) for (const dx of [-3, 3]) Y.box(x + dx - .6, x + dx + .6, 0, 21, zc + dz - .6, zc + dz + .6, '#f0b825', '#f0b825');
      for (const dz of [-11, 11]) Y.box(x - 3.6, x + 3.6, 0, 1.4, zc + dz - 1, zc + dz + 1, '#3a3a3c', '#3a3a3c');
      Y.box(x - 3.6, x + 3.6, 21, 23.5, zc - 12, zc + 12, '#f0b825', '#f0b825');
      Y.box(x - 2, x + 2, 23.5, 26, zc + 6, zc + 11, '#e9e6de', '#d0ccc4');
    }
    const m = new THREE.Mesh(Y.build(), std({ vertexColors: true, roughness: .6 }, { grime: true })); m.castShadow = m.receiveShadow = true; scene.add(m);
  }

  // —— 卡车车队（环线 59 辆）——
  W.loop = makeLoop();
  const NT = 59;
  const cabG = new THREE.BoxGeometry(2.6, 3.0, 2.5).translate(0, 1.9, 0), chG = new THREE.BoxGeometry(12.6, .5, 2.3).translate(0, 1.2, 0), winG = new THREE.BoxGeometry(.2, 1.0, 2.2).translate(1.32, 2.6, 0), wheelG = new THREE.BoxGeometry(12.0, .9, 2.5).translate(0, .45, 0);
  const cab = new THREE.InstancedMesh(cabG, std({ color: '#fff', roughness: .45, metalness: .1 }, { grime: true }), NT);
  const chassis = new THREE.InstancedMesh(chG, std({ color: '#2b2d31', roughness: .8 }), NT);
  const wheels = new THREE.InstancedMesh(wheelG, std({ color: '#141416', roughness: .9 }), NT);
  const cwin = new THREE.InstancedMesh(winG, std({ color: '#0d1014', roughness: .1, metalness: .4 }), NT);
  const TC = ['#e8463c', '#2f5fb3', '#f2f2ec', '#f2c230', '#3f8f5a', '#f08a2c', '#6fb7e0', '#e0e0e0'];
  { const C = new THREE.Color(); for (let i = 0; i < NT; i++) cab.setColorAt(i, C.set(TC[i % TC.length])); }
  for (const m of [cab, chassis, wheels, cwin]) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; scene.add(m); }
  W.trucks = { NT, cab, chassis, wheels, cwin, TC };

  // —— 城市路小汽车（两向）——
  const NCAR = 160;
  const carG = new THREE.BoxGeometry(4.4, 1.4, 1.9).translate(0, .85, 0), carTop = new THREE.BoxGeometry(2.4, .7, 1.7).translate(-.2, 1.9, 0);
  const cars = new THREE.InstancedMesh(carG, std({ color: '#fff', roughness: .4, metalness: .2 }), NCAR), carT = new THREE.InstancedMesh(carTop, std({ color: '#15181c', roughness: .15, metalness: .5 }), NCAR);
  { const C = new THREE.Color(), CC = ['#f4f4f0', '#2a2d33', '#c9c9cc', '#c8372d', '#2f5fb3', '#f2c230', '#9aa3ab', '#3f8f5a']; for (let i = 0; i < NCAR; i++) cars.setColorAt(i, C.set(CC[(i * 7) % CC.length])); }
  for (const m of [cars, carT]) { m.castShadow = true; m.frustumCulled = false; scene.add(m); }
  W.cars = { NCAR, cars, carT };

  // —— 码头工人（模型铁路小人）——
  {
    const n = 70, R3 = mulberry(71);
    const geo = new THREE.CapsuleGeometry(.3, 1.0, 2, 6).translate(0, .85, 0);
    const m = new THREE.InstancedMesh(geo, std({ color: '#fff', roughness: .8 }), n), C = new THREE.Color(), PC = ['#f08a2c', '#f2c230', '#e8463c', '#f4f4f0', '#2f5fb3', '#3f8f5a'];
    const ppl = [];
    for (let i = 0; i < n; i++) { ppl.push({ x: R3() < .5 ? -300 + R3() * 440 : 160 + R3() * 50, z: R3() < .6 ? 44 + R3() * 4 : 92 + R3() * 8, dir: R3() < .5 ? 1 : -1, v: .9 + R3() * .6, ph: R3() * 1000 }); m.setColorAt(i, C.set(PC[i % PC.length])); }
    m.castShadow = true; m.frustumCulled = false; scene.add(m);
    W.people = { m, ppl };
  }

  // —— 拖船（放大 1.25 倍，模型感）——
  W.tug = makeTug(scene);

  // —— 尾迹 ——
  W.wake = makeWake(scene);

  // —— 灯：高杆灯、码头路灯、吊臂灯、船灯、灯塔、桅灯 ——
  W.lights = makeLights(scene, W);

  // —— 屋顶招牌「港口一日」——
  W.sign = makeSign(scene, OF);

  // —— 白汽：72 个半透明柔边粒子（billboard），扩散、上升、顺风漂 ——
  W.steam = makePuffs(scene, 72);
  return W;
}

// —— 卡车环线：岸桥车道（向东）→ 东侧（向南）→ 南侧（向西）→ 西侧（向北）。总长正好 59×20 m，车位 k 在 s=20k ——
function makeLoop() {
  const r = 10, N = 12, X0 = -270, X1 = 150, Z0 = 15, chord = 2 * r * Math.sin(Math.PI / 4 / N), arcs = 4 * N * chord;
  const Z1 = Z0 + 2 * r + (59 * 20 - arcs - 2 * (X1 - X0 - 2 * r)) / 2;
  const P = [];
  const arc = (cx, cz, a0) => { for (let i = 1; i < N; i++) { const a = a0 + i / N * Math.PI / 2; P.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]); } };
  P.push([X0 + r, Z0], [X1 - r, Z0]); arc(X1 - r, Z0 + r, -Math.PI / 2);
  P.push([X1, Z0 + r], [X1, Z1 - r]); arc(X1 - r, Z1 - r, 0);
  P.push([X1 - r, Z1], [X0 + r, Z1]); arc(X0 + r, Z1 - r, Math.PI / 2);
  P.push([X0, Z1 - r], [X0, Z0 + r]); arc(X0 + r, Z0 + r, Math.PI);
  const S = [0]; for (let i = 1; i <= P.length; i++) { const a = P[i - 1], b = P[i % P.length]; S.push(S[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
  const L = S[S.length - 1];
  const at = s => {
    s = ((s % L) + L) % L; let i = 0, j = S.length - 1; while (j - i > 1) { const m = (i + j) >> 1; if (S[m] <= s) i = m; else j = m; }
    const a = P[i % P.length], b = P[(i + 1) % P.length], u = (s - S[i]) / (S[i + 1] - S[i] || 1);
    return { x: lerp(a[0], b[0], u), z: lerp(a[1], b[1], u), yaw: Math.atan2(-(b[1] - a[1]), b[0] - a[0]) };
  };
  return { L, at, X0, Z1, r };
}

// —— 拖船 ——（几何全部烘到船体局部坐标里，污渍用局部坐标，船动时不"游"）
function makeTug(scene) {
  const g = new THREE.Group(), k = 1.25;
  const sh = new THREE.Shape();   // 平面轮廓：船首在 +x
  sh.moveTo(-10, -4.2); sh.lineTo(4, -4.4); sh.quadraticCurveTo(10.5, -3.6, 11.5, 0); sh.quadraticCurveTo(10.5, 3.6, 4, 4.4); sh.lineTo(-10, 4.2); sh.quadraticCurveTo(-12, 3.4, -12, 0); sh.quadraticCurveTo(-12, -3.4, -10, -4.2);
  const hullG = new THREE.ExtrudeGeometry(sh, { depth: 3.6, bevelEnabled: true, bevelSize: .35, bevelThickness: .35, bevelSegments: 2, curveSegments: 16 }).rotateX(-Math.PI / 2).translate(0, -1.2, 0);
  const T1 = { tug: 1 };
  const red = std({ color: '#b3261d', roughness: .55 }, T1), wht = std({ color: '#efebe2', roughness: .6 }, T1), blk = std({ color: '#1c1d20', roughness: .7 }, T1);
  const hull = new THREE.Mesh(hullG, red); g.add(hull);
  const deck = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: .2, bevelEnabled: false, curveSegments: 16 }).rotateX(-Math.PI / 2).translate(0, 2.78, 0).scale(.95, 1, .93), std({ color: '#5b7a4a', roughness: .9 }, { tug: 2 })); g.add(deck);   // 甲板面要高出船体倒角（原来埋在船体里，看到的是红色顶面）
  const box = (w, h, d, x, y, z, m) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d).translate(x, y, z), m); g.add(b); return b; };
  const cyl = (r0, r1, h, x, y, z, m, n = 12) => { const c = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, h, n).translate(x, y, z), m); g.add(c); return c; };
  box(9, 2.6, 6.2, -.5, 3.9, 0, wht); box(6, 2.4, 5.4, .2, 6.4, 0, wht);
  box(6.6, .35, 6.4, .2, 7.75, 0, std({ color: '#c92a20', roughness: .6 }, T1));
  // 驾驶室玻璃：深色、反天空（环境贴图），带白色窗框
  const win = std({ color: '#0a0f16', roughness: .04, metalness: .9, envMapIntensity: 2.2 }, T1);
  for (const [w, h, d, x, y, z] of [[.15, 1.1, 4.6, 3.25, 6.6, 0], [5, 1.1, .15, .2, 6.6, 2.72], [5, 1.1, .15, .2, 6.6, -2.72], [.15, .9, 4.2, 4.0, 4.1, 0]]) box(w, h, d, x, y, z, win);
  for (const zz of [-1.15, 0, 1.15]) box(.2, 1.2, .14, 3.3, 6.6, zz, wht);
  for (const xx of [-1.4, .2, 1.8]) for (const s of [-1, 1]) box(.14, 1.2, .2, xx, 6.6, s * 2.74, wht);
  cyl(.9, 1.0, 3.2, -3.6, 7.6, 0, blk, 14);
  cyl(.93, .93, .6, -3.6, 8.1, 0, std({ color: '#f2c230' }, T1), 14);
  cyl(.12, .12, 4, 1.2, 9.9, 0, blk, 6);
  box(.12, .12, 3.2, 1.2, 10.6, 0, blk);                                   // 雷达横杆
  cyl(.35, .35, .5, 2.6, 8.2, 1.6, std({ color: '#d9d6cc', roughness: .4, metalness: .4 }, T1), 10);   // 探照灯
  // 栏杆：沿甲板边缘一圈立柱 + 扶手
  {
    const rail = std({ color: '#e9e6de', roughness: .5 }, T1), pts = sh.getSpacedPoints(46);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], ax = a.x * .93, az = -a.y * .9, bx = b.x * .93, bz = -b.y * .9;
      if (ax > -3 && ax < 3.5) continue;   // 舷梯口
      const L = Math.hypot(bx - ax, bz - az), m = new THREE.Mesh(new THREE.BoxGeometry(L, .07, .07).rotateY(-Math.atan2(bz - az, bx - ax)).translate((ax + bx) / 2, 3.45, (az + bz) / 2), rail); g.add(m);
      g.add(new THREE.Mesh(new THREE.BoxGeometry(.07, .95, .07).translate(ax, 3.0, az), rail));
    }
  }
  // 船尾拖缆机、缆桩、缆绳盘、救生圈
  box(2.2, 1.2, 2.2, -8.4, 3.1, 0, std({ color: '#2a5fa0', roughness: .6 }, T1));
  for (const [x, z] of [[-10.2, 1.8], [-10.2, -1.8], [8.6, 1.5], [8.6, -1.5]]) { cyl(.28, .32, .8, x, 2.95, z, blk, 8); cyl(.42, .42, .1, x, 3.35, z, blk, 8); }
  const rope = new THREE.Mesh(new THREE.TorusGeometry(.75, .22, 6, 18).rotateX(Math.PI / 2).translate(-6.2, 3.05, 2.1), std({ color: '#b9a57e', roughness: .95 }, T1)); g.add(rope);
  const rope2 = new THREE.Mesh(new THREE.TorusGeometry(.5, .2, 6, 16).rotateX(Math.PI / 2).translate(-6.2, 3.25, 2.1), rope.material); g.add(rope2);
  const ring = std({ color: '#f07a24', roughness: .6 }, T1);
  for (const [x, z, ry] of [[-2.2, 3.13, 0], [-2.2, -3.13, 0], [3.3, 0, Math.PI / 2]]) g.add(new THREE.Mesh(new THREE.TorusGeometry(.45, .13, 6, 14).rotateY(ry).translate(x, 6.6 - (x < 0 ? 2.4 : 0), z), ring));
  // 舷边轮胎护舷：每只略有大小、角度差别，磨损的灰黑橡胶
  const tyreM = std({ color: '#2a2a2b', roughness: .97 }, T1);
  for (let i = 0; i < 9; i++) { const x = -9 + i * 2.2; for (const s of [-1, 1]) { const r = .58 + hash(i * 3 + s) * .1; g.add(new THREE.Mesh(new THREE.TorusGeometry(r, .3, 6, 12).rotateZ((hash(i * 7 + s) - .5) * .3).translate(x, 1.2 - hash(i + s * 9) * .2, s * 4.7), tyreM)); } }
  box(1.6, 1.8, 6.4, 11.6, 1.6, 0, tyreM);
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  // 接触阴影：贴水面的深色柔边椭圆（环境光遮蔽），让船"坐"在水里
  {
    const cs = new THREE.Mesh(new THREE.PlaneGeometry(31, 14).rotateX(-Math.PI / 2).translate(-.4, -.4, 0), new THREE.MeshBasicMaterial({ map: radial('rgba(255,255,255,1)', .55), color: '#000', transparent: true, opacity: .55, depthWrite: false, fog: false }));
    cs.material.map.colorSpace = THREE.NoColorSpace; cs.renderOrder = 1; g.add(cs);
    cs.material.blending = THREE.CustomBlending; cs.material.blendSrc = THREE.ZeroFactor; cs.material.blendDst = THREE.OneMinusSrcAlphaFactor;
  }
  g.scale.setScalar(k); scene.add(g);
  // 航线：港外东北 → 港口入口 → 停在船首旁
  const P = [[420, -620], [300, -420], [205, -265], [160, -200], [138, -140], [124, -96], [116, -64]];
  const curve = new THREE.CatmullRomCurve3(P.map(p => new THREE.Vector3(p[0], 0, p[1])), false, 'centripetal');
  const L = curve.getLength();
  return { g, curve, L, funnel: new THREE.Vector3(-3.6 * k, 9.4 * k, 0), mastTop: new THREE.Vector3(1.2 * k, 12 * k, 0) };
}

// —— 尾迹（白色泡沫带）——
function makeWake(scene) {
  const K = 40, pos = new Float32Array(K * 2 * 3), uv = new Float32Array(K * 2 * 2), idx = [];
  for (let k = 0; k < K - 1; k++) { const a = k * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    uniforms: { op: { value: 0 }, t: { value: 0 } }, transparent: true, depthWrite: false,
    vertexShader: `varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vW = (modelMatrix*vec4(position,1.)).xyz; gl_Position = projectionMatrix*viewMatrix*vec4(vW,1.); }`,
    fragmentShader: `varying vec2 vUv; varying vec3 vW; uniform float op, t;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
      float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
      void main(){ float x = abs(vUv.y*2.-1.), s = vUv.x;
        float edge = smoothstep(.55,.95,x)*(1.-smoothstep(.95,1.,x));
        float core = (1.-smoothstep(.0,.45,x)) * (1.-s*.8);
        float fo = n(vW.xz*.9 + t*.3)*.6 + n(vW.xz*2.7)*.4;
        float a = (edge*.9 + core*.75) * smoothstep(.25,.75,fo) * (1.-s) * smoothstep(0.,.06,s) * op;
        gl_FragColor = vec4(vec3(.96,.98,1.), a*.85); }`,
  });
  const m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.renderOrder = 2; scene.add(m);
  return { m, pos, uv, K, mat };
}

// —— 发光：广告牌式光晕（实例化 billboard）+ 地面光池 ——
function makeGlow(scene, n, tex) {
  const geo = new THREE.InstancedBufferGeometry(); const base = new THREE.PlaneGeometry(1, 1);
  geo.index = base.index; geo.attributes.position = base.attributes.position; geo.attributes.uv = base.attributes.uv;
  const ctr = new Float32Array(n * 3), col = new Float32Array(n * 3), sz = new Float32Array(n);
  geo.setAttribute('ctr', new THREE.InstancedBufferAttribute(ctr, 3)); geo.setAttribute('col', new THREE.InstancedBufferAttribute(col, 3)); geo.setAttribute('sz', new THREE.InstancedBufferAttribute(sz, 1));
  geo.instanceCount = n;
  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: tex } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute vec3 ctr, col; attribute float sz; varying vec2 vUv; varying vec3 vC; void main(){ vUv = uv; vC = col; vec4 mv = viewMatrix * vec4(ctr, 1.); mv.xy += position.xy * sz; gl_Position = projectionMatrix * mv; if (sz <= 0.) gl_Position = vec4(2.,2.,2.,1.); }`,
    fragmentShader: `uniform sampler2D map; varying vec2 vUv; varying vec3 vC; void main(){ float a = texture2D(map, vUv).a; gl_FragColor = vec4(vC * a, 1.); }`,
  });
  const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = 6; scene.add(m);
  return { m, ctr, col, sz, n, set(i, p, c, s) { ctr[i * 3] = p.x; ctr[i * 3 + 1] = p.y; ctr[i * 3 + 2] = p.z; col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2]; sz[i] = s; }, up() { geo.attributes.ctr.needsUpdate = geo.attributes.col.needsUpdate = geo.attributes.sz.needsUpdate = true; } };
}

// —— 汽团粒子：柔边噪声贴图的 billboard，逐粒子大小与不透明度；受太阳色与天光着色 ——
function makePuffs(scene, n) {
  const tex = canvasTex(128, 128, (g, w, h) => {
    const R = mulberry(77); g.clearRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {   // 若干小团叠成不规则的一朵
      const a = R() * 6.28, r = R() * 26, x = w / 2 + Math.cos(a) * r, y = h / 2 + Math.sin(a) * r, rr = 18 + R() * 22;
      const gr = g.createRadialGradient(x, y, 0, x, y, rr); gr.addColorStop(0, 'rgba(255,255,255,.22)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
    }
  });
  const geo = new THREE.InstancedBufferGeometry(); const base = new THREE.PlaneGeometry(1, 1);
  geo.index = base.index; geo.attributes.position = base.attributes.position; geo.attributes.uv = base.attributes.uv;
  const ctr = new Float32Array(n * 3), sz = new Float32Array(n), al = new Float32Array(n), rot = new Float32Array(n);
  geo.setAttribute('ctr', new THREE.InstancedBufferAttribute(ctr, 3)); geo.setAttribute('sz', new THREE.InstancedBufferAttribute(sz, 1)); geo.setAttribute('al', new THREE.InstancedBufferAttribute(al, 1)); geo.setAttribute('rot', new THREE.InstancedBufferAttribute(rot, 1));
  geo.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: tex }, lit: { value: new THREE.Color('#ffffff') }, shade: { value: new THREE.Color('#a9b8cc') } }, transparent: true, depthWrite: false,
    vertexShader: `attribute vec3 ctr; attribute float sz, al, rot; varying vec2 vUv; varying float vA; varying float vY;
      void main(){ vUv = uv; vA = al; vY = position.y; float c = cos(rot), s = sin(rot); vec2 q = vec2(c * position.x - s * position.y, s * position.x + c * position.y);
        vec4 mv = viewMatrix * vec4(ctr, 1.); mv.xy += q * sz; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform sampler2D map; uniform vec3 lit, shade; varying vec2 vUv; varying float vA; varying float vY;
      void main(){ float a = texture2D(map, vUv).a * vA; vec3 c = mix(shade, lit, smoothstep(-.5, .5, vY)); gl_FragColor = vec4(c, a); }`,
  });
  const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = 7; scene.add(m);
  let k = 0;
  return { m, mat, n, begin() { k = 0; }, add(p, size, alpha, r) { if (k >= n) return; ctr.set([p.x, p.y, p.z], k * 3); sz[k] = size; al[k] = alpha; rot[k] = r; k++; },
    end() { geo.instanceCount = k; for (const a of ['ctr', 'sz', 'al', 'rot']) geo.attributes[a].needsUpdate = true; m.visible = k > 0; } };
}

function makeLights(scene, W) {
  const L = { list: [] };   // {p, kind, group, pool}
  const add = (x, y, z, group, pool = 0, col = [1, .78, .45], size = 3) => L.list.push({ p: new THREE.Vector3(x, y, z), group, pool, col, size });
  // 高杆灯（堆场）：杆 + 灯盘
  const masts = [];
  for (const x of [-236, -106, 24, 138]) for (const z of [86, 126, 172]) masts.push([x, z]);
  const poleG = new THREE.CylinderGeometry(.35, .6, 32, 6).translate(0, 16, 0), headG = new THREE.BoxGeometry(4, .8, 4).translate(0, 32.4, 0);
  const pole = new THREE.InstancedMesh(poleG, std({ color: '#9aa0a6', roughness: .5, metalness: .4 }), masts.length + 17);
  const head = new THREE.InstancedMesh(headG, new THREE.MeshStandardMaterial({ color: '#33363a', emissive: '#ffcc88', emissiveIntensity: 0 }), masts.length + 17);
  const M = new THREE.Matrix4(); let k = 0;
  for (const [x, z] of masts) { M.makeTranslation(x, 0, z); pole.setMatrixAt(k, M); head.setMatrixAt(k, M); k++; add(x, 32.6, z, 'lamps', 46); }
  // 码头前沿路灯 z=47
  for (let x = -250; x <= 150; x += 25) { M.makeScale(.55, .45, .55).setPosition(x, 0, 47); pole.setMatrixAt(k, M); head.setMatrixAt(k, M); k++; add(x, 14.8, 47, 'lamps', 18); }
  pole.count = head.count = k; pole.castShadow = true; scene.add(pole, head); L.head = head;
  // 岸桥吊臂灯（每台沿大梁 6 盏 + A 字架顶红灯）
  for (const cx of W.CR) { for (let i = 0; i < 6; i++) add(cx + (i % 2 ? 5 : -5), 44, -48 + Math.floor(i / 2) * 44, 'boom', 0, [1, .92, .8], 2.2); add(cx, 71.5, 33.5, 'boom', 0, [1, .12, .08], 2.6); add(cx, 26, 19, 'boom', 32, [1, .85, .6], 2.5); }
  // 船：甲板灯、尾楼
  for (let x = -110; x <= 70; x += 20) add(x, W.SHIP.deck + 9, -21, 'windows', 0, [1, .85, .6], 1.6);
  add(-114, W.SHIP.deck + 20, -21, 'windows', 0, [1, 1, 1], 2.4);
  // 城市路灯（远处）
  for (let x = -700; x <= 700; x += 30) add(x, 9, 255, 'lamps', 14, [1, .72, .38], 2.2);
  // 灯塔
  add(W.lighthouse.x, W.lighthouse.y, W.lighthouse.z, 'lighthouse', 0, [1, .95, .8], 6);
  // 拖船桅灯
  add(0, 0, 0, 'mast', 0, [1, .95, .85], 1.8); L.mastIdx = L.list.length - 1;
  add(0, 0, 0, 'mast', 0, [1, .1, .08], 1.2); add(0, 0, 0, 'mast', 0, [.1, 1, .3], 1.2);
  L.glow = makeGlow(scene, L.list.length, radial('rgba(255,255,255,1)', .18));
  // 地面光池
  const pools = L.list.filter(l => l.pool > 0);
  const pg = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const pm = new THREE.MeshBasicMaterial({ map: invSq(),  color: '#ffc27a', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const pmesh = new THREE.InstancedMesh(pg, pm, pools.length);
  pools.forEach((l, i) => { M.makeScale(l.pool * 3.6, 1, l.pool * 3.6).setPosition(l.p.x, .3, l.p.z); pmesh.setMatrixAt(i, M); });
  pmesh.renderOrder = 4; pmesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(pools.length * 3).fill(0), 3);
  scene.add(pmesh); L.pools = pools; L.pmesh = pmesh;
  // 灯塔光束：贴在水面上的一道旋转光带（水面上方 .15 m，被陆地自然遮住）。不用 3D 圆锥：圆锥扫过镜头会变成焦外的大圆斑
  const beam = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
    uniforms: { ang: { value: 0 }, op: { value: 0 }, ctr: { value: new THREE.Vector2(W.lighthouse.x, W.lighthouse.z) } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `varying vec3 vW; void main(){ vW = (modelMatrix * vec4(position, 1.)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.); }`,
    fragmentShader: `uniform float ang, op; uniform vec2 ctr; varying vec3 vW;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main(){ vec2 d = vW.xz - ctr; float r = length(d); float a = atan(d.y, d.x) - ang; a = mod(a + 3.14159, 6.28318) - 3.14159;
        float w = .022 + 4. / max(r, 1.);
        float k = exp(-a * a / (w * w)) * smoothstep(8., 40., r) * (1. - smoothstep(250., 1100., r)) * (.55 + .45 * smoothstep(1100., 200., r));
        float gl = .7 + .3 * h(floor(vW.xz * .7));
        gl_FragColor = vec4(vec3(1., .88, .66) * k * gl * op, 1.); }`,
  }));
  beam.position.set(W.lighthouse.x, -.45, W.lighthouse.z); beam.renderOrder = 3; beam.frustumCulled = false; scene.add(beam); L.beam = beam;
  return L;
}

// —— 招牌：钢架 + 灯箱字 ——
function makeSign(scene, OF) {
  const tex = canvasTex(1024, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h); g.fillStyle = '#fff'; g.font = '900 210px "Noto Sans SC"'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('港口一日', w / 2, h / 2 + 8);
  });
  const grp = new THREE.Group();
  const fr = new THREE.Mesh(new THREE.BoxGeometry(30, 1, .6), std({ color: '#55595e', metalness: .5, roughness: .5 }));
  fr.position.y = .5; grp.add(fr);
  for (const x of [-12, -4, 4, 12]) { const p = new THREE.Mesh(new THREE.BoxGeometry(.4, 7.2, .4), fr.material); p.position.set(x, 3.6, -.6); grp.add(p); }
  const back = new THREE.Mesh(new THREE.PlaneGeometry(29, 7.25), new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: .35, color: '#2f3236', emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0, roughness: .5 }));
  back.position.set(0, 4.6, 0); grp.add(back);
  grp.traverse(o => { if (o.isMesh) o.castShadow = true; });
  grp.position.set((OF.x0 + OF.x1) / 2, OF.h + .9, OF.z1 - 6); grp.rotation.y = .62; grp.scale.setScalar(1.45);   // 面向东南主机位
  scene.add(grp);
  return { grp, back, tex };
}
