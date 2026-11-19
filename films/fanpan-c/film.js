// 《林间寨擂》· C 版画面：three.js（WebGL）渲染的微缩场景 + 像素角色卡片 + 自己写的后期链。
// 画法参考 cases/vendor/lemo-opuscar/styles/hd-2d/STYLE.md（MIT，LemoLab），只取方法、代码自己写：
//   · 角色和小物件是平的像素卡片，逐帧跳着动；镜头、光、飘浮物是连续滑动的
//   · 光：暗而偏青的环境光 + 一束穿过树冠的金色斜阳（只在擂台上留一个完整的光池，四周是碎光斑）+ 暖橙色的火和灯 + 两颗阵营色晶石
//   · 景深按参考图量出来的样子做：画面高度 25%–58% 是清楚的一带（擂台和棋子全在里面），往上只略微发软，往下越来越虚
//   · 后期顺序：2 倍超采样 → 景深 → 泛光 → 暗角与调色 → 胶片曲线
//   setup(canvas) → 建好场景；render(t) 画出第 t 秒（只由 t 决定，不读时钟、不用随机数）
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import * as TX from './tex.js';
import { D, RAMP as R } from './pix.js';
import { buildScene, tex, card, glowSprite } from './scene.js';
import { FPS, FRAMES, UNITS, CLASHES, SELECT, SUN, AMBIENT, BACKDROP, TEAM, TOP, LX, LZ, HX, HZ, FRONT_ROW, ROWS, LANES, tileX, tileZ, spriteBox, spriteFrame, flicker, cameraAt, rnd } from './stage.js';

export const DUR = FRAMES / FPS;
// 调画面只改这一组数
const LOOK = {
  ssaa: 2,
  sun: 6.6, hemi: .66, fill: .36, lamp: 1,
  // 景深（弥散圆以超采样后的像素计）：aper 按深度虚化的强弱；near* 画面下方的移轴虚化从哪里开始、到底边虚到多大；far* 画面上方同理
  dof: { aper: 300, maxCoc: 26, nearFrom: .37, nearAmt: 17, farFrom: .8, farAmt: 5 },
  bloom: { strength: .36, radius: .7, threshold: .9 },
  grade: { vignette: .72, warm: .04, contrast: .24, saturation: 1.2 },
  exposure: .62,
  fog: { color: '#0b3a40', near: 21, far: 46 },
  unitGlow: .26,                                       // 棋子自发光的底：背阴里也不会沉下去
};
const Q = new URLSearchParams(location.search);       // 调试用：?dof=0 ?bloom=0 ?grade=0 关掉某一步，看风格本体成不成立

let renderer, scene, camera, composer, dofPass, S, sprites = [], shafts = [], fx = {};

// 景深：一个带符号的弥散圆（负 = 比焦点近，正 = 比焦点远），螺旋采样；远处的像素不会糊到清楚的前景上
const DOF_SHADER = {
  uniforms: { tColor: { value: null }, tDepth: { value: null }, px: { value: new THREE.Vector2() }, near: { value: 1 }, far: { value: 100 }, focus: { value: 10 },
    aper: { value: 0 }, maxCoc: { value: 0 }, nearFrom: { value: .37 }, nearAmt: { value: 0 }, farFrom: { value: .8 }, farAmt: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
  fragmentShader: `
    varying vec2 vUv; uniform sampler2D tColor, tDepth; uniform vec2 px;
    uniform float near, far, focus, aper, maxCoc, nearFrom, nearAmt, farFrom, farAmt;
    float viewZ(vec2 uv){ float z = texture2D(tDepth, uv).x * 2. - 1.; return 2. * near * far / (far + near - z * (far - near)); }
    float coc(vec2 uv, float z){
      float c = clamp(aper * (1. / focus - 1. / z), -maxCoc, maxCoc);
      float tn = nearAmt * pow(smoothstep(nearFrom, 0., uv.y), 1.3), tf = farAmt * smoothstep(farFrom, 1., uv.y);
      float t = min(maxCoc, max(tn, tf));
      return abs(c) >= t ? c : (tn > tf ? -t : t);
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
    this.quad = new FullScreenQuad(this.material); this.on = true;
  }
  render(r, writeBuffer) {
    r.setRenderTarget(this.rt); r.clear(); r.render(scene, camera);
    const u = this.material.uniforms, d = LOOK.dof, k = this.on ? 1 : 0;
    u.tColor.value = this.rt.texture; u.tDepth.value = this.rt.depthTexture; u.near.value = camera.near; u.far.value = camera.far; u.focus.value = this.focus;
    u.aper.value = d.aper * k; u.maxCoc.value = this.on ? d.maxCoc : .001; u.nearFrom.value = d.nearFrom; u.nearAmt.value = d.nearAmt * k; u.farFrom.value = d.farFrom; u.farAmt.value = d.farAmt * k;
    r.setRenderTarget(this.renderToScreen ? null : writeBuffer); this.quad.render(r);
  }
}
// 暗角 + 调色（在胶片曲线之前，线性空间里做）：四角压暗并偏青，中间略暖，对比和饱和各提一点
const GRADE_SHADER = {
  uniforms: { tDiffuse: { value: null }, vignette: { value: .6 }, warm: { value: .05 }, contrast: { value: .15 }, saturation: { value: 1.05 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
  fragmentShader: `
    varying vec2 vUv; uniform sampler2D tDiffuse; uniform float vignette, warm, contrast, saturation;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      vec2 p = (vUv - vec2(.5, .55)) * vec2(1., 1.2);
      float v = smoothstep(.3, .88, length(p));
      c *= mix(vec3(1.), vec3(.20, .34, .40), v * vignette);
      c *= vec3(1. + warm, 1., 1. - warm);
      float l = dot(c, vec3(.2126, .7152, .0722));
      c = max(mix(vec3(l), c, saturation), 0.);
      c = mix(c, c * c * (3. - 2. * min(c, 1.)), contrast * step(l, 1.));
      gl_FragColor = vec4(max(c, 0.), 1.);
    }`,
};

const loadImage = url => new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error(`读不到 ${url}`)); i.src = url; });
// 棋子的序列帧：给每一帧描一圈阵营色的外轮廓（这一圈自己发亮），身体留一点自发光的底
async function unitMaps(u) {
  const img = await loadImage(`units/${u.atlas}_idle.png`), w = img.width, h = img.height, c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0); const src = g.getImageData(0, 0, w, h), a = src.data;
  const e = document.createElement('canvas'); e.width = w; e.height = h; const ge = e.getContext('2d'), em = ge.createImageData(w, h), b = em.data;
  const solid = (x, y) => x >= 0 && y >= 0 && x < w && y < h && Math.floor(x / u.cell) === Math.floor(Math.max(0, x) / u.cell) && a[(y * w + x) * 4 + 3] > 127;
  const rim = (u.team === 'own' ? R.teal : R.red)[4], add = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (a[i + 3] > 127) { a[i + 3] = 255; for (let k = 0; k < 3; k++) b[i + k] = a[i + k] * LOOK.unitGlow; b[i + 3] = 255; }
    else { a[i + 3] = 0; if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) add.push(i); }
  }
  for (const i of add) for (let k = 0; k < 4; k++) { a[i + k] = k < 3 ? rim[k] : 255; b[i + k] = k < 3 ? rim[k] : 255; }
  g.putImageData(src, 0, 0); ge.putImageData(em, 0, 0);
  const mk = cv => { const t = new THREE.CanvasTexture(cv); t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.colorSpace = THREE.SRGBColorSpace; t.repeat.set(1 / u.frames, 1); return t; };
  return [mk(c), mk(e)];
}
const flat = (c, w, h, { glow = 1.4, add = false, opacity = 1 } = {}) => new THREE.Mesh(new THREE.PlaneGeometry(w, h).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: tex(c), transparent: true, alphaTest: add ? 0 : .5, depthWrite: false, opacity, blending: add ? THREE.AdditiveBlending : THREE.NormalBlending, color: new THREE.Color(glow, glow, glow) }));
function points(n, size, soft = true) {
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
  const p = new THREE.Points(g, new THREE.PointsMaterial({ size, map: soft ? glowSprite('#fff', 1).material.map : null, vertexColors: true, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, sizeAttenuation: true, fog: false }));
  p.frustumCulled = false; scene.add(p); return p;
}

export async function setup(canvas) {
  const W = window.__RENDER?.width ?? window.innerWidth, H = window.__RENDER?.height ?? window.innerHeight;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1); renderer.setSize(W, H, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = LOOK.exposure;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene(); scene.background = new THREE.Color(BACKDROP); scene.fog = new THREE.Fog(LOOK.fog.color, LOOK.fog.near, LOOK.fog.far);
  camera = new THREE.PerspectiveCamera(cameraAt(0).fov, W / H, 2, 60);
  S = buildScene(); scene.add(S.group);

  // —— 光 ——
  scene.add(new THREE.HemisphereLight(AMBIENT.sky, AMBIENT.ground, LOOK.hemi));
  const sun = new THREE.DirectionalLight(SUN.color, LOOK.sun), to = new THREE.Vector3(...SUN.to), dir = new THREE.Vector3(...SUN.from).sub(to).normalize();
  sun.position.copy(to).addScaledVector(dir, 30); sun.target.position.copy(to);
  sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -.0006; sun.shadow.normalBias = .03; sun.shadow.radius = 3;
  Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: 4, far: 62 });
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight('#8fc6d6', LOOK.fill); fill.position.set(0, 9, 16); scene.add(fill);   // 镜头方向来的一点冷补光：朝镜头的面不死黑

  // —— 光柱：顺着阳光方向的加色薄片，从树冠缝伸到擂台和空地 ——
  { const t = new THREE.CanvasTexture(TX.shaft());
    for (const [x, z, w, k] of [[-.9, .2, 2.6, 1], [1.9, -.9, 1.5, .8], [-3.4, 1.9, 1.1, .6], [3.9, 1.4, 1.0, .55], [-1.8, -3.4, 1.3, .6], [5.4, -2.2, .9, .45], [-5.6, -.4, 1.0, .5]]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, 10), new THREE.MeshBasicMaterial({ map: t, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide, fog: false }));
      m.position.copy(new THREE.Vector3(x, 0, z).addScaledVector(dir, 4.9)); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir); m.rotateY(.55); m.userData.k = k; scene.add(m); shafts.push(m);
    } }

  // —— 棋子：像素卡片，脚踩在石板上；脚下一个阵营色的圈，脚边一块战力牌 ——
  const up = new THREE.Vector3(0, .82, .57).normalize(), ringTex = { own: TX.ring({ team: 'teal' }), foe: TX.ring({ team: 'red' }) }, pos = {};
  for (const u of UNITS) {
    const { size, lift } = spriteBox(u), [map, emap] = await unitMaps(u), x = tileX(u.row), z = tileZ(u.lane);
    const geo = new THREE.PlaneGeometry(size, size), n = geo.attributes.normal; for (let i = 0; i < n.count; i++) n.setXYZ(i, up.x, up.y, up.z);
    const cardMesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map, alphaTest: .5, emissive: 0xffffff, emissiveMap: emap, emissiveIntensity: 1, color: 0xe8e8e8 }));
    cardMesh.position.y = lift; cardMesh.castShadow = cardMesh.receiveShadow = true;
    cardMesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: .5 });
    const feet = new THREE.Group(); feet.position.set(x, TOP + .005, z + .16 + u.row * .004); feet.rotation.x = -.16; feet.add(cardMesh); scene.add(feet);
    const ring = flat(ringTex[u.team], 1.0, .5, { glow: 1.7 }); ring.position.set(x, TOP + .012, z + .18); ring.renderOrder = 2; scene.add(ring);
    const s = u.team === 'own' ? -1 : 1, badge = card(TX.badge({ n: u.str, team: u.team === 'own' ? 'teal' : 'red' }), x + s * LX * .36, TOP + .02, z + .5, { s: 1.3, glow: 1.3, tilt: -.3 }); scene.add(badge);
    sprites.push({ u, map, emap }); pos[u.id] = { x, z, u };
  }

  // —— 棋盘上的效果 ——
  // 出兵格上的符（空着的格子才画）、选中框、前线的一道金色光幕
  const taken = new Set(UNITS.map(u => `${u.lane},${u.row}`)); fx.runes = [];
  for (let lane = 0; lane < LANES; lane++) for (const [row, team] of [[0, 'teal'], [ROWS - 1, 'red']]) if (!taken.has(`${lane},${row}`)) {
    const m = flat(TX.rune({ team, kind: lane }), .52, .52, { glow: 1.5, add: true, opacity: .9 }); m.position.set(tileX(row), TOP + .014, tileZ(lane)); scene.add(m); fx.runes.push(m);
    const g = glowSprite(TEAM[team === 'teal' ? 'own' : 'foe'], 1.3, .3); g.position.set(tileX(row), TOP + .12, tileZ(lane)); scene.add(g); fx.runes.push(g);
  }
  fx.select = flat(TX.brackets(), LX, LZ, { glow: 1.8 }); fx.select.position.set(tileX(SELECT.row), TOP + .016, tileZ(SELECT.lane)); scene.add(fx.select);
  fx.selectGlow = glowSprite('#ffd868', 1.5, .22); fx.selectGlow.position.set(tileX(SELECT.row), TOP + .2, tileZ(SELECT.lane)); scene.add(fx.selectGlow);
  { const t = new THREE.CanvasTexture(TX.shaft(16, 64)); t.wrapS = THREE.RepeatWrapping; t.repeat.set(6, 1);
    fx.front = new THREE.Mesh(new THREE.PlaneGeometry(2 * HZ, .7).rotateY(Math.PI / 2), new THREE.MeshBasicMaterial({ map: t, color: '#ffc850', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide, opacity: .5, fog: false }));
    fx.front.rotation.z = Math.PI; fx.front.position.set((FRONT_ROW + 1) * LX - HX, TOP + .35, 0); scene.add(fx.front); }
  // 交手：两个棋子之间一青一红两道斩击弧，加一把四溅的火花
  fx.clash = CLASHES.map(([a, b], i) => {
    const A = pos[a], B = pos[b], x = (A.x + B.x) / 2, z = A.z + .2, y = TOP + .52;
    const mk = (rp, flip) => { const m = card(TX.slash({ rp }), x, y, z + .02 + i * .003, { s: .62, glow: 1.6, tilt: -.16 }); m.geometry = m.geometry.clone().translate(0, -17 / D * .62, 0); if (flip) m.scale.x = -1; scene.add(m); return m; };
    const sparks = Array.from({ length: 7 }, (_, k) => { const m = card(TX.spark({ rp: k % 3 === 0 ? R.bone : R.gold }), x, y, z + .05, { s: .45 + rnd(i * 9 + k, 3) * .4, glow: 2.2, tilt: -.16 }); scene.add(m); return m; });
    const glow = glowSprite('#ffe6a0', 1.1, .4); glow.position.set(x, y, z + .1); scene.add(glow);
    const light = new THREE.PointLight('#ffd27a', 0, 3.2, 2); light.position.set(x, y + .1, z + .3); scene.add(light);
    return { own: mk(R.teal, false), foe: mk(R.red, true), sparks, glow, light, x, y, z, off: [3, 9, 13][i] };
  });
  // 远程棋子的一发光弹（带三节拖尾），飞向它对面的敌人
  { const A = pos.ranged, B = pos.crawler; fx.bolt = { from: [A.x + .35, TOP + .62, A.z + .22], to: [B.x - .2, TOP + .45, B.z + .22], parts: [1, .7, .5, .34].map(k => { const g = glowSprite('#7cf8dc', .5 * k, .95); scene.add(g); return g; }) }; }
  // 最强的两个棋子脚下往上冒的光点
  fx.aura = { pts: points(48, .09), who: [pos.guardian, pos.juggernaut] };

  // —— 飘浮物：光里的浮尘、草边的萤火、火上的火星、落叶、蝴蝶、炊烟 ——
  fx.dust = points(260, .06); fx.fireflies = points(46, .17); fx.embers = points(S.flames.length * 9, .075);
  fx.leaves = Array.from({ length: 22 }, (_, i) => { const m = card(TX.leaf({ rp: [R.thatch, R.grass, R.red, R.gold][i % 4] }), 0, 0, 0, { s: .8, glow: i % 4 === 1 ? .7 : .95, tilt: 0, cast: false }); scene.add(m); return m; });
  fx.flies = Array.from({ length: 6 }, (_, i) => { const t = new THREE.CanvasTexture(TX.butterfly({ rp: [R.violet, R.gold, R.teal][i % 3] })); t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.colorSpace = THREE.SRGBColorSpace; t.repeat.set(.5, 1);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(.23, .18), new THREE.MeshBasicMaterial({ map: t, alphaTest: .5, color: new THREE.Color(1.3, 1.3, 1.3) })); m.rotation.x = -.3; scene.add(m); return { m, t }; });
  { const puff = TX.puff(); fx.smoke = S.smoke.flatMap((p, j) => Array.from({ length: 6 }, (_, k) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(.6, .6), new THREE.MeshBasicMaterial({ map: tex(puff), transparent: true, depthWrite: false, color: j === 2 ? '#c8a078' : '#8fa8a8', opacity: .5 })); m.rotation.x = -.4; scene.add(m); return { m, p, k, j }; })); }

  // —— 后期 ——
  composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType }));
  dofPass = new DofPass(W, H, LOOK.ssaa); dofPass.on = Q.get('dof') !== '0'; composer.addPass(dofPass);
  if (Q.get('bloom') !== '0') composer.addPass(new UnrealBloomPass(new THREE.Vector2(W, H), LOOK.bloom.strength, LOOK.bloom.radius, LOOK.bloom.threshold));
  if (Q.get('grade') !== '0') { const p = new ShaderPass(GRADE_SHADER); Object.entries(LOOK.grade).forEach(([k, v]) => { p.uniforms[k].value = v; }); composer.addPass(p); }
  composer.addPass(new OutputPass());
}

const frac = v => v - Math.floor(v);
export function render(t) {
  const frame = Math.round(t * FPS), sec = frame / FPS, step = Math.floor(frame * 10 / FPS), cam = cameraAt(frame);     // step：每秒 10 拍，像素的东西按拍跳
  camera.position.set(...cam.pos); camera.lookAt(...cam.look); camera.updateMatrixWorld();
  dofPass.focus = new THREE.Vector3(...cam.look).sub(camera.position).length();
  for (const s of sprites) { const o = spriteFrame(s.u, frame) / s.u.frames; s.map.offset.x = s.emap.offset.x = o; }
  S.flames.forEach(f => { f.tex.offset.x = ((step + f.phase) % 4) / 4; });
  for (const l of S.lamps) { const k = l.steady ? 1 : flicker(l.i, sec); if (l.light) l.light.intensity = l.base * LOOK.lamp * k; const s = l.glow.userData.size * (.9 + .1 * k); l.glow.scale.set(s, s, 1); }
  for (const c of S.crystals) { const b = Math.sin(sec * 1.6 + c.phase); c.mesh.position.y = c.glow.position.y = c.y + b * .07; c.mesh.rotation.y = sec * .8 + c.phase; c.light.intensity = 5 + b; }
  for (const w of S.sway) w.o.rotation[w.axis] = (w.axis === 'x' ? 0 : 0) + Math.sin(sec * w.speed + w.phase) * w.amp + (w.base ?? 0);
  shafts.forEach((m, i) => { m.material.color.set(SUN.color).multiplyScalar(.15 * m.userData.k * (1 + .14 * Math.sin(sec * .9 + i * 2))); });

  // 棋盘上的效果
  const pulse = .5 + .5 * Math.sin(sec * 3.2);
  fx.select.material.color.setScalar(1.3 + .7 * pulse); fx.select.scale.setScalar(1 + .03 * pulse); fx.selectGlow.material.opacity = .14 + .12 * pulse;
  fx.runes.forEach((m, i) => { m.material.opacity = (m.isSprite ? .22 : .7) * (.75 + .25 * Math.sin(sec * 2.1 + i)); });
  fx.front.material.opacity = .42 + .1 * Math.sin(sec * 2.6); fx.front.material.map.offset.x = sec * .08;
  for (const c of fx.clash) {
    const life = ((step + c.off) % 15) / 9, on = life <= 1;                                   // 每 1.5 秒交手一次，一次亮 0.9 秒
    c.own.visible = c.foe.visible = on; c.glow.visible = on; c.light.intensity = on ? 6 * (1 - life) : 0;
    const sc = .8 + life * .35; c.own.scale.set(sc, sc, 1); c.foe.scale.set(-sc, sc, 1); c.own.position.x = c.x - .08 - life * .06; c.foe.position.x = c.x + .08 + life * .06;
    c.glow.material.opacity = .55 * (1 - life); c.sparks.forEach((m, k) => { const a = k / 7 * 6.283 + c.off, r = .12 + life * (.5 + .3 * (k % 3)); m.visible = on && life < .25 + .75 * ((k * 5) % 7) / 6; m.position.set(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r * .7 + .1 - life * life * .25, c.z + .05); });
  }
  { const b = fx.bolt, k0 = frac(sec / 1.5 + .43); b.parts.forEach((g, i) => { const k = Math.max(0, k0 - i * .07), e = k * k * (3 - 2 * k); g.position.set(b.from[0] + (b.to[0] - b.from[0]) * e, b.from[1] + (b.to[1] - b.from[1]) * e + Math.sin(e * Math.PI) * .12, b.from[2]); g.material.opacity = k0 > .97 ? 0 : .95 - i * .2; }); }
  { const p = fx.aura.pts.geometry.attributes.position, c = fx.aura.pts.geometry.attributes.color;
    for (let i = 0; i < 48; i++) { const w = fx.aura.who[i % 2], k = frac(sec * (.35 + rnd(i, 1) * .3) + rnd(i, 2)), a = rnd(i, 3) * 6.283 + sec * .6, own = i % 2 === 0, f = Math.sin(k * Math.PI) * 1.5;
      p.setXYZ(i, w.x + Math.cos(a) * .42, TOP + .05 + k * 1.15, w.z + .2 + Math.sin(a) * .26); own ? c.setXYZ(i, .1 * f, 1.0 * f, .8 * f) : c.setXYZ(i, 1.1 * f, .25 * f, .2 * f); }
    p.needsUpdate = c.needsUpdate = true; }

  // 飘浮物
  { const p = fx.dust.geometry.attributes.position, c = fx.dust.geometry.attributes.color;
    for (let i = 0; i < 260; i++) { const inPool = i % 3 > 0, x = (rnd(i, 1) - .5) * (inPool ? 9 : 17) + Math.sin(sec * (.25 + rnd(i, 4) * .3) + i) * .35, y = .5 + rnd(i, 2) * 4.6 + Math.sin(sec * (.3 + rnd(i, 5) * .3) + i * 1.7) * .22, z = (rnd(i, 3) - .5) * (inPool ? 7 : 12) - .3 + Math.cos(sec * (.2 + rnd(i, 6) * .3) + i * .7) * .35, g = (inPool ? .75 : .32) * (.6 + .4 * Math.sin(sec * .8 + i));
      p.setXYZ(i, x, y, z); c.setXYZ(i, 1.0 * g, .82 * g, .45 * g); } p.needsUpdate = c.needsUpdate = true; }
  { const p = fx.fireflies.geometry.attributes.position, c = fx.fireflies.geometry.attributes.color;
    for (let i = 0; i < 46; i++) { const a = rnd(i, 1) * 6.283, r = 5.2 + rnd(i, 2) * 3.2, g = Math.max(0, Math.sin(sec * (1.1 + rnd(i, 7)) + i * 2.1)) ** 2 * 1.6;
      p.setXYZ(i, Math.cos(a) * r * 1.15 + Math.sin(sec * .5 + i) * .4, .3 + rnd(i, 3) * 1.5 + Math.sin(sec * .7 + i * 1.3) * .2, Math.sin(a) * r * .72 - .2 + Math.cos(sec * .4 + i) * .4); c.setXYZ(i, .75 * g, 1.3 * g, .3 * g); } p.needsUpdate = c.needsUpdate = true; }
  { const p = fx.embers.geometry.attributes.position, c = fx.embers.geometry.attributes.color, w = new THREE.Vector3();
    S.lamps.filter(l => !l.steady && l.glow.userData.size > 1.3).slice(0, S.flames.length).forEach((l, j) => { l.glow.getWorldPosition(w); for (let k = 0; k < 9; k++) { const i = j * 9 + k, life = frac(sec * (.4 + rnd(i, 1) * .35) + rnd(i, 2)), g = (1 - life) * 1.8;
      p.setXYZ(i, w.x + Math.sin(life * 5 + i) * .16 + (rnd(i, 3) - .5) * .2, w.y + life * 1.5, w.z + .1 + (rnd(i, 4) - .5) * .2); c.setXYZ(i, 1.5 * g, .6 * g, .15 * g); } });
    p.needsUpdate = c.needsUpdate = true; }
  fx.leaves.forEach((m, i) => { const life = frac(sec / 6 * (1 + (i % 2)) + rnd(i, 1)), sw = Math.sin(life * 9 + i);                            // 落叶：6 秒或 3 秒落完一趟，循环得上
    m.position.set((rnd(i, 2) - .5) * 15 + sw * .35 + life * .8, 5.6 - life * 5.5, (rnd(i, 3) - .5) * 9 - .5); m.rotation.z = Math.floor(life * 16 + i) * .9; m.visible = m.position.y > .08; });
  fx.flies.forEach(({ m, t: tx }, i) => { const a = sec * (.5 + rnd(i, 1) * .3) + i * 2.4, cx = [-5.4, 5.6, -3.2, 3.4, -6.2, 1.2][i], cz = [1.6, -1.6, 3.9, 3.3, -2.4, -5.4][i];
    m.position.set(cx + Math.cos(a) * .7, .7 + rnd(i, 2) * .6 + Math.sin(a * 2.3) * .18, cz + Math.sin(a * 1.3) * .5); tx.offset.x = ((step + i) % 2) * .5; });
  fx.smoke.forEach(({ m, p, k, j }) => { const life = frac(sec / 6 * 2 + k / 6), s = .45 + life * 1.1; m.position.set(p[0] + Math.sin(life * 3 + k + j) * .25 + life * .5, p[1] + life * 2.4, p[2]); m.scale.setScalar(s); m.material.opacity = .42 * Math.sin(life * Math.PI) ** .8; });
  composer.render();
}
