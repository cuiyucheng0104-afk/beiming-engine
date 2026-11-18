// 《林间擂台》· C 版画面：three.js（WebGL）渲染的微缩场景 + 像素角色卡片 + 自己写的后期链。
// 画法参考 cases/vendor/lemo-opuscar/styles/hd-2d/STYLE.md（MIT，LemoLab），只取方法、代码自己写：
//   · 角色是平的像素卡片，逐帧跳着动；镜头、光、浮尘是连续滑动的
//   · 光：暗而冷的环境光 + 从树冠缝里漏下来的暖色斜阳（有影子）+ 一盏盏暖色小灯；卡片的法线朝上偏前，背后的光才照得到它
//   · 后期顺序：2 倍超采样 → 景深（移轴并进同一个带符号的弥散圆里，一次采样完成）→ 泛光 → 暗角与调色 → 胶片曲线
//   setup(canvas) → 建好场景；render(t) 画出第 t 秒（只由 t 决定，不读时钟、不用随机数）
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import * as PX from './px.js';
import { createDiorama } from './diorama.js';
import { FPS, FRAMES, UNITS, LAMPS, SUN, AMBIENT, BACKDROP, TEAM, TOP, MOTES, LX, tileX, tileZ, spriteBox, spriteFrame, flicker, cameraAt, moteAt } from './layout.js';

export const DUR = FRAMES / FPS;
// 调画面只改这一组数
const LOOK = {
  ssaa: 2,
  sun: 5.2, hemi: 1.15, fill: .5, lamp: 4.6,          // 光的强弱（three 的物理单位）
  dof: { aper: 300, maxCoc: 26, tiltC: .5, tiltW: .2, tiltF: .3, tiltAmt: 22 },   // 弥散圆以超采样后的像素计
  bloom: { strength: .36, radius: .7, threshold: .92 },
  grade: { vignette: .62, warm: .05, contrast: .16, saturation: 1.08 },
  exposure: 1.02,
};
const Q = new URLSearchParams(location.search);       // 调试用：?dof=0 ?bloom=0 ?grade=0 关掉某一步，看风格本体成不成立

let renderer, scene, camera, composer, dofPass, sprites = [], lamps = [], motes, shafts = [];

const nearest = t => { t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.colorSpace = THREE.SRGBColorSpace; return t; };
const loadTexture = url => new Promise((ok, bad) => new THREE.TextureLoader().load(url, t => ok(nearest(t)), undefined, () => bad(new Error(`读不到贴图 ${url}`))));

// 景深 + 移轴：一个带符号的弥散圆（负 = 比焦点近，正 = 比焦点远），螺旋采样；远处的像素不会糊到清楚的前景上
const DOF_SHADER = {
  uniforms: { tColor: { value: null }, tDepth: { value: null }, px: { value: new THREE.Vector2() }, near: { value: 1 }, far: { value: 100 }, focus: { value: 10 },
    aper: { value: 0 }, maxCoc: { value: 0 }, tiltC: { value: .5 }, tiltW: { value: .2 }, tiltF: { value: .3 }, tiltAmt: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
  fragmentShader: `
    varying vec2 vUv; uniform sampler2D tColor, tDepth; uniform vec2 px;
    uniform float near, far, focus, aper, maxCoc, tiltC, tiltW, tiltF, tiltAmt;
    float viewZ(vec2 uv){ float z = texture2D(tDepth, uv).x * 2. - 1.; return 2. * near * far / (far + near - z * (far - near)); }
    float coc(vec2 uv, float z){
      float c = clamp(aper * (1. / focus - 1. / z), -maxCoc, maxCoc);
      float t = min(maxCoc, tiltAmt * smoothstep(tiltW, tiltW + tiltF, abs(uv.y - tiltC)));
      return abs(c) >= t ? c : (uv.y < tiltC ? -t : t);
    }
    void main(){
      float zc = viewZ(vUv), cc = coc(vUv, zc);
      vec3 acc = texture2D(tColor, vUv).rgb; float wsum = 1.;
      const int N = 96;
      for (int i = 1; i < N; i++) {
        float fi = float(i), r = sqrt(fi / float(N)) * maxCoc, a = fi * 2.39996323;
        vec2 uv = vUv + vec2(cos(a), sin(a)) * r * px;
        float zs = viewZ(uv), cs = abs(coc(uv, zs));
        if (zs > zc) cs = min(cs, abs(cc));              // 采到的是更远的东西：最多糊到和中心一样
        float w = clamp(cs - r + 1., 0., 1.);
        acc += texture2D(tColor, uv).rgb * w; wsum += w;
      }
      gl_FragColor = vec4(acc / wsum, 1.);
    }`,
};
class DofPass extends Pass {
  constructor(w, h, ss) {
    super();
    this.rt = new THREE.WebGLRenderTarget(w * ss, h * ss, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(w * ss, h * ss) });
    this.material = new THREE.ShaderMaterial(DOF_SHADER);
    this.material.uniforms.px.value.set(1 / (w * ss), 1 / (h * ss));
    this.quad = new FullScreenQuad(this.material);
    this.on = true;
  }
  render(r, writeBuffer) {
    r.setRenderTarget(this.rt); r.clear(); r.render(scene, camera);
    const u = this.material.uniforms, d = LOOK.dof;
    u.tColor.value = this.rt.texture; u.tDepth.value = this.rt.depthTexture; u.near.value = camera.near; u.far.value = camera.far;
    u.focus.value = this.focus; u.aper.value = this.on ? d.aper : 0; u.maxCoc.value = this.on ? d.maxCoc : .001;
    u.tiltC.value = d.tiltC; u.tiltW.value = d.tiltW; u.tiltF.value = d.tiltF; u.tiltAmt.value = this.on ? d.tiltAmt : 0;
    r.setRenderTarget(this.renderToScreen ? null : writeBuffer); this.quad.render(r);
  }
}
// 暗角 + 调色（在胶片曲线之前，线性空间里做）：四角压暗并偏冷，中间略暖，对比和饱和各提一点
const GRADE_SHADER = {
  uniforms: { tDiffuse: { value: null }, vignette: { value: .6 }, warm: { value: .05 }, contrast: { value: .15 }, saturation: { value: 1.05 }, aspect: { value: 16 / 9 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
  fragmentShader: `
    varying vec2 vUv; uniform sampler2D tDiffuse; uniform float vignette, warm, contrast, saturation, aspect;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      vec2 p = (vUv - vec2(.5, .52)) * vec2(1., 1.18);
      float v = smoothstep(.28, .86, length(p));
      c *= mix(vec3(1.), vec3(.30, .36, .44), v * vignette);
      c *= vec3(1. + warm, 1., 1. - warm);
      float l = dot(c, vec3(.2126, .7152, .0722));
      c = mix(vec3(l), c, saturation);
      c = mix(c, c * c * (3. - 2. * min(c, 1.)), contrast * step(0., 1. - l));
      gl_FragColor = vec4(max(c, 0.), 1.);
    }`,
};

export async function setup(canvas) {
  const W = window.__RENDER?.width ?? window.innerWidth, H = window.__RENDER?.height ?? window.innerHeight;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1); renderer.setSize(W, H, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = LOOK.exposure;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene(); scene.background = new THREE.Color(BACKDROP);
  camera = new THREE.PerspectiveCamera(cameraAt(0).fov, W / H, 2, 60);
  scene.add(createDiorama().group);

  // —— 光 ——
  scene.add(new THREE.HemisphereLight(AMBIENT.sky, AMBIENT.ground, LOOK.hemi));
  const sun = new THREE.DirectionalLight(SUN.color, LOOK.sun);
  const to = new THREE.Vector3(...SUN.to), dir = new THREE.Vector3(...SUN.from).sub(to).normalize();
  sun.position.copy(to).addScaledVector(dir, 30); sun.target.position.copy(to);
  sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -.0006; sun.shadow.normalBias = .03; sun.shadow.radius = 3.5;
  Object.assign(sun.shadow.camera, { left: -17, right: 17, top: 17, bottom: -17, near: 5, far: 60 });
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight('#9fb6d6', LOOK.fill);            // 镜头方向来的一点冷补光：让朝镜头的面不死黑
  fill.position.set(0, 9, 16); scene.add(fill);
  const halo = new THREE.CanvasTexture(PX.halo(64)); halo.colorSpace = THREE.SRGBColorSpace;
  LAMPS.forEach((l, i) => {
    const light = new THREE.PointLight(l.color, LOOK.lamp * l.power, l.kind === 'team' ? 5 : 9, 2);
    light.position.set(l.x + (l.kind === 'lantern' && !l.id.startsWith('stone') && l.id !== 'foreground' ? .3 : 0), l.y + (l.kind === 'brazier' ? .35 : 0), l.z + (l.kind === 'window' ? .5 : 0));
    if (l.shadow) { light.castShadow = true; light.shadow.mapSize.set(1024, 1024); light.shadow.bias = -.004; light.shadow.radius = 3; light.shadow.camera.near = .3; }
    scene.add(light);
    let glow = null;
    if (l.kind !== 'team') {                                               // 每盏灯叠一个加色的光晕
      glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: halo, color: l.color, blending: THREE.AdditiveBlending, depthWrite: false, opacity: .3 }));
      glow.position.copy(light.position); glow.userData.size = l.kind === 'brazier' ? 2.2 : l.kind === 'window' ? 1.3 : 1.5; scene.add(glow);
    }
    lamps.push({ light, glow, base: LOOK.lamp * l.power, i, steady: l.kind === 'team' || l.kind === 'window' });
  });

  // —— 光柱：三片顺着阳光方向的加色薄片，从树冠缝伸到擂台 ——
  { const c = document.createElement('canvas'); c.width = 64; c.height = 64; const g = c.getContext('2d'), img = g.createImageData(64, 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const a = Math.sin(Math.PI * x / 63) ** 2 * Math.sin(Math.PI * Math.min(1, y / 50)) ** .7, i = (y * 64 + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = a * 255; img.data[i + 3] = 255; }
    g.putImageData(img, 0, 0); const tex = new THREE.CanvasTexture(c);
    for (const [x, z, w, k] of [[-.7, .1, 2.2, 1], [2.7, -1.2, 1.3, .7], [-3.6, 2.2, 1.1, .6]]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, 9), new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(SUN.color).multiplyScalar(.12 * k), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide }));
      const mid = new THREE.Vector3(x, 0, z).addScaledVector(dir, 4.4); m.position.copy(mid);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir); m.rotateY(.5); m.userData.k = k; scene.add(m); shafts.push(m);
    } }

  // —— 棋子：像素卡片，脚踩在石板上；脚下一个本方颜色的圈，脚边一块战力牌 ——
  const up = new THREE.Vector3(0, .82, .57).normalize();
  for (const u of UNITS) {
    const { size, lift } = spriteBox(u), map = await loadTexture(`units/${u.atlas}_idle.png`);
    map.repeat.set(1 / u.frames, 1);
    const geo = new THREE.PlaneGeometry(size, size), n = geo.attributes.normal;
    for (let i = 0; i < n.count; i++) n.setXYZ(i, up.x, up.y, up.z);       // 法线朝上偏前：背后来的阳光也照得到卡片
    const mat = new THREE.MeshLambertMaterial({ map, alphaTest: .5, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: .22, color: 0xd8d8d8 });
    const card = new THREE.Mesh(geo, mat); card.position.y = lift; card.castShadow = true; card.receiveShadow = true;
    card.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: .5 });
    card.customDistanceMaterial = new THREE.MeshDistanceMaterial({ map, alphaTest: .5 });
    const feet = new THREE.Group(); feet.position.set(tileX(u.row), TOP, tileZ(u.lane) + .12); feet.rotation.x = -.16; feet.add(card); scene.add(feet);
    const team = u.team === 'own' ? 'teal' : 'red', s = u.team === 'own' ? -1 : 1;
    const ring = new THREE.Mesh(new THREE.PlaneGeometry(.85, .45).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: nearest(new THREE.CanvasTexture(PX.ring({ team }))), transparent: true, depthWrite: false, color: new THREE.Color(1.5, 1.5, 1.5) }));
    ring.position.set(tileX(u.row), TOP + .006, tileZ(u.lane) + .14); ring.renderOrder = 1; scene.add(ring);
    const badge = new THREE.Mesh(new THREE.PlaneGeometry(.34, .34), new THREE.MeshBasicMaterial({ map: nearest(new THREE.CanvasTexture(PX.badge({ n: u.str, team }))), alphaTest: .5, color: new THREE.Color(1.25, 1.25, 1.25) }));
    badge.position.set(tileX(u.row) + s * LX * .33, TOP + .2, tileZ(u.lane) + .44); badge.rotation.x = -.3; scene.add(badge);
    sprites.push({ u, map });
  }

  // —— 浮尘与萤火 ——
  { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(MOTES * 3), 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(MOTES * 3), 3));
    motes = new THREE.Points(g, new THREE.PointsMaterial({ size: .07, map: halo, vertexColors: true, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, sizeAttenuation: true })); scene.add(motes); }

  // —— 后期 ——
  composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType }));
  dofPass = new DofPass(W, H, LOOK.ssaa); dofPass.on = Q.get('dof') !== '0'; composer.addPass(dofPass);
  if (Q.get('bloom') !== '0') composer.addPass(new UnrealBloomPass(new THREE.Vector2(W, H), LOOK.bloom.strength, LOOK.bloom.radius, LOOK.bloom.threshold));
  if (Q.get('grade') !== '0') { const p = new ShaderPass(GRADE_SHADER); Object.entries(LOOK.grade).forEach(([k, v]) => { p.uniforms[k].value = v; }); p.uniforms.aspect.value = W / H; composer.addPass(p); }
  composer.addPass(new OutputPass());
}

export function render(t) {
  const frame = Math.round(t * FPS), sec = frame / FPS, cam = cameraAt(frame);
  camera.position.set(...cam.pos); camera.lookAt(...cam.look); camera.updateMatrixWorld();
  dofPass.focus = new THREE.Vector3(...cam.look).sub(camera.position).length();
  for (const s of sprites) s.map.offset.x = spriteFrame(s.u, frame) / s.u.frames;        // 角色逐帧跳
  for (const l of lamps) {
    const k = l.steady ? 1 : flicker(l.i, sec);
    l.light.intensity = l.base * k;
    if (l.glow) { const s = l.glow.userData.size * (.92 + .08 * k); l.glow.scale.set(s, s, 1); }
  }
  shafts.forEach((m, i) => { m.material.color.set(SUN.color).multiplyScalar(.12 * m.userData.k * (1 + .12 * Math.sin(sec * .9 + i * 2))); });
  const pos = motes.geometry.attributes.position, col = motes.geometry.attributes.color;
  for (let i = 0; i < MOTES; i++) { const m = moteAt(i, sec); pos.setXYZ(i, m.x, m.y, m.z); m.fire ? col.setXYZ(i, 1.6 * m.glow, 1.5 * m.glow, .5 * m.glow) : col.setXYZ(i, .5 * m.glow, .45 * m.glow, .34 * m.glow); }
  pos.needsUpdate = col.needsUpdate = true;
  composer.render();
}

export { TEAM };
