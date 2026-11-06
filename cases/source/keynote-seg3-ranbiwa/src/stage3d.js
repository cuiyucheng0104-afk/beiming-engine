// 三维舞台：木桌、立体书、台灯、翻页、三道 V 形折页纸门、相机。单位：米，y 向上，书脊沿 z 轴（x=0）。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { makePost } from '/core/three/post.js';
import { clamp, lerp, seg, ss, eo, eio, mulberry, track, TAU } from '/core/lib.js';
import { T, b, BEAT } from './timeline.js';
import { G, WP, HP, camX, shake } from './scroll2d.js';

export const KM = 0.30 / WP;                 // 世界 px → 米
export const PW = WP * KM, PH = HP * KM;     // 页面 0.30 × 0.19 m
export const BT = .003, HPG = .022;          // 书封厚度、页面高度
export const X = wx => (wx - G) * KM, Z = wy => wy * KM;
const dip = x => -.0042 * Math.exp(-Math.abs(x) / .013);

export function texOf(c, o = {}) {
  const t = new THREE.CanvasTexture(c); t.colorSpace = o.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  if (o.mip === false) { t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; } else { t.anisotropy = 8; t.minFilter = THREE.LinearMipmapLinearFilter; }
  t.magFilter = THREE.LinearFilter; return t;
}

// 页面网格：沿 s（离书脊的距离）分段；dir=-1 左页、+1 右页
function pageGeo(dir, NS = 64) {
  const g = new THREE.BufferGeometry(), n = (NS + 1) * 2, pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), idx = [];
  for (let i = 0; i <= NS; i++) for (let j = 0; j < 2; j++) {
    const k = i * 2 + j, s = i / NS;
    uv[k * 2] = dir < 0 ? 1 - s : s; uv[k * 2 + 1] = j === 0 ? 1 : 0;
  }
  for (let i = 0; i < NS; i++) {
    const a = i * 2, bb = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
    if (dir < 0) idx.push(a, c, bb, c, d, bb); else idx.push(a, bb, c, c, bb, d);
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx);
  g.userData = { NS, dir }; setFlat(g, dir, 0); return g;
}
function setFlat(g, dir, lift) {
  const p = g.attributes.position, NS = g.userData.NS;
  for (let i = 0; i <= NS; i++) { const s = i / NS * PW, x = dir * s; for (let j = 0; j < 2; j++) p.setXYZ(i * 2 + j, x, HPG + dip(x) + lift, j === 0 ? -PH / 2 : PH / 2); }
  p.needsUpdate = true; g.computeVertexNormals(); g.computeBoundingSphere();
}
// 翻页：左页绕书脊翻到右边。u∈[0,1]
function setLeaf(g, u) {
  const p = g.attributes.position, NS = g.userData.NS;
  const e = u < .5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;     // 缓入缓出
  const base = Math.PI * (1 - e), lag = 1.05 * Math.sin(Math.PI * u), flat = 1 - Math.sin(Math.PI * Math.min(1, u * 1.15));
  let x = 0, y = HPG + .0006;
  for (let i = 0; i <= NS; i++) {
    const s = i / NS;
    if (i > 0) { const ph = Math.min(Math.PI, Math.max(0, base + lag * Math.pow(s, 1.25))); x += Math.cos(ph) * PW / NS; y += Math.sin(ph) * PW / NS; }
    const yy = y + dip(x) * flat + (u > .5 ? .0006 : 0);
    for (let j = 0; j < 2; j++) p.setXYZ(i * 2 + j, x, yy, j === 0 ? -PH / 2 : PH / 2);
  }
  p.needsUpdate = true; g.computeVertexNormals(); g.computeBoundingSphere();
}

function linesCanvas() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 256; const x = c.getContext('2d');
  x.fillStyle = '#efe5cf'; x.fillRect(0, 0, 64, 256); const R = mulberry(5);
  for (let i = 0; i < 256; i += 2.2) { x.fillStyle = `rgba(140,118,86,${.10 + R() * .22})`; x.fillRect(0, i, 64, .9); }
  return c;
}
function blockGeo(dir) {
  const s = new THREE.Shape(), top = HPG - .0009, n = 40;
  s.moveTo(dir * PW, BT); s.lineTo(dir * PW, top);
  for (let i = n; i >= 0; i--) { const x = dir * PW * Math.pow(i / n, 2.2); s.lineTo(x === 0 ? dir * .0004 : x, top + dip(x)); }
  s.lineTo(dir * .0004, BT); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: PH - .001, bevelEnabled: false, curveSegments: 1 }); g.translate(0, 0, -(PH - .001) / 2);
  return g;
}

export async function makeStage(IMG, canv) {
  const W = 1920, H = 1080;
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1); renderer.setSize(W, H);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.NoToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.getElementById('stage').appendChild(renderer.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#050302');
  const cam = new THREE.PerspectiveCamera(2, W / H, .02, 20);
  const post = makePost(renderer, scene, cam, W, H, { ssaa: 1 });
  post.bloom.threshold = .82; post.bloom.strength = .32; post.bloom.radius = .55;

  // 环境（房间的反射光）
  const hdr = await new RGBELoader().loadAsync('/core/assets/polyhaven/lythwood_lounge_2k.hdr');
  const pm = new THREE.PMREMGenerator(renderer); scene.environment = pm.fromEquirectangular(hdr).texture; hdr.dispose(); pm.dispose();
  scene.environmentIntensity = 0;

  // —— A11–A12 的取景框（正交等效）——
  const tex1 = texOf(canv.s1E, { mip: false });
  const quadMat = new THREE.ShaderMaterial({
    uniforms: { tE: { value: tex1 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
    fragmentShader: 'uniform sampler2D tE; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(tE, vUv).rgb, 1.); }',
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(1920 * KM, 1080 * KM), quadMat); quad.rotation.x = -Math.PI / 2; scene.add(quad);

  // —— 木桌 ——
  const tl = new THREE.TextureLoader();
  const wd = await tl.loadAsync('/core/assets/polyhaven/walnut_diff.jpg'), wn = await tl.loadAsync('/core/assets/polyhaven/walnut_nor.jpg'), wr = await tl.loadAsync('/core/assets/polyhaven/walnut_rough.jpg');
  wd.colorSpace = THREE.SRGBColorSpace;
  for (const x of [wd, wn, wr]) { x.wrapS = x.wrapT = THREE.RepeatWrapping; x.repeat.set(2.2, 2.2); x.anisotropy = 8; x.rotation = Math.PI / 2; }
  const desk = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), new THREE.MeshStandardMaterial({ map: wd, normalMap: wn, roughnessMap: wr, roughness: .9, color: '#c9a888' }));
  desk.rotation.x = -Math.PI / 2; desk.receiveShadow = true; scene.add(desk);

  // —— 书 ——
  const book = new THREE.Group(); scene.add(book);
  const clothT = new THREE.Texture(IMG.cloth); clothT.image = IMG.cloth; clothT.needsUpdate = true; clothT.colorSpace = THREE.SRGBColorSpace; clothT.wrapS = clothT.wrapT = THREE.RepeatWrapping; clothT.repeat.set(2, 1.3);
  const cloth = new THREE.MeshStandardMaterial({ map: clothT, roughness: .92, color: '#d8d8e8' });
  for (const d of [-1, 1]) {
    const bd = new THREE.Mesh(new THREE.BoxGeometry(PW + .008, BT, PH + .012), cloth); bd.position.set(d * (PW / 2 + .002), BT / 2, 0); bd.castShadow = bd.receiveShadow = true; book.add(bd);
    const lt = texOf(linesCanvas()); lt.wrapS = lt.wrapT = THREE.RepeatWrapping; lt.repeat.set(30, 70);
    const blk = new THREE.Mesh(blockGeo(d), new THREE.MeshStandardMaterial({ map: lt, roughness: .95 })); blk.castShadow = blk.receiveShadow = true; book.add(blk);
  }
  const spine = new THREE.Mesh(new THREE.CylinderGeometry(.006, .006, PH + .012, 16, 1, false, Math.PI / 2, Math.PI), cloth);
  spine.rotation.x = Math.PI / 2; spine.position.set(0, .0035, 0); book.add(spine);

  const mkTexPair = (a, e) => [texOf(a), texOf(e)];
  const [LA, LE] = mkTexPair(canv.LA, canv.LE), [RA, RE] = mkTexPair(canv.RA, canv.RE);
  const pageMat = (map, emi) => new THREE.MeshStandardMaterial({ map, emissiveMap: emi, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 1, roughness: .93, side: THREE.FrontSide });
  const leafGeo = pageGeo(-1, 72);
  const leafF = new THREE.Mesh(leafGeo, pageMat(LA, LE)); leafF.castShadow = leafF.receiveShadow = true;
  const NB = texOf(canv.NB), NL = texOf(canv.NL);
  const leafB = new THREE.Mesh(leafGeo, new THREE.MeshStandardMaterial({ map: NB, roughness: .93, side: THREE.BackSide })); leafB.receiveShadow = true;
  const rightP = new THREE.Mesh(pageGeo(1), pageMat(RA, RE)); rightP.receiveShadow = true;
  const newL = new THREE.Mesh(pageGeo(-1), new THREE.MeshStandardMaterial({ map: NL, roughness: .93 })); newL.position.y = -.0005; newL.receiveShadow = true;
  book.add(leafF, leafB, rightP, newL);

  // —— 台灯（Poly Haven CC0）+ 茶杯 ——
  const gl = new GLTFLoader();
  const lampG = (await gl.loadAsync('/core/assets/polyhaven/desk_lamp_arm_01/desk_lamp_arm_01.gltf')).scene;
  lampG.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  lampG.scale.setScalar(.62); lampG.position.set(-.47, 0, .13); lampG.rotation.y = -Math.PI * .5; scene.add(lampG);
  const teaG = (await gl.loadAsync('/core/assets/polyhaven/tea_set_01/tea_set_01.gltf')).scene;
  const keep = new Set(['tea_set_01_cup_small_01', 'tea_set_01_saucer_circular_03']);
  const tea = new THREE.Group();
  teaG.traverse(o => { if (keep.has(o.name)) { const c = o.clone(); c.traverse(m => { if (m.isMesh) { m.castShadow = m.receiveShadow = true; } }); tea.add(c); } });
  // 杯碟原本分散摆放：各自归零后叠在一起
  tea.children.forEach(c => { c.position.set(0, c.name.includes('cup') ? .012 : 0, 0); });
  tea.position.set(.46, 0, -.17); scene.add(tea);

  // 台灯光源：放在模型灯泡处
  lampG.updateMatrixWorld(true);
  let bulbMat = null; const head = new THREE.Vector3();
  lampG.traverse(o => { if (o.isMesh && o.material.name.endsWith('_light')) { bulbMat = o.material; new THREE.Box3().setFromObject(o).getCenter(head); } });
  bulbMat.emissive = new THREE.Color('#ffd6a0'); bulbMat.emissiveIntensity = 0; bulbMat.toneMapped = false;
  const spot = new THREE.SpotLight('#ffe0b8', 0, 0, .78, 1, 2); spot.position.copy(head).add(new THREE.Vector3(.02, -.03, 0)); spot.target.position.set(.03, HPG + .03, -.02);
  spot.castShadow = true; spot.shadow.mapSize.set(2048, 2048); spot.shadow.bias = -.00015; spot.shadow.normalBias = .0015; spot.shadow.camera.near = .05; spot.shadow.camera.far = 2; spot.shadow.radius = 3;
  scene.add(spot, spot.target);
  const fill = new THREE.PointLight('#ffcf9a', 0, 0, 2); fill.position.set(.15, .45, .6); scene.add(fill);

  // —— 三道 V 形折页纸门 ——
  const DOORS = [
    { W: .27, H: .165, z: -.062, c: canv.D[0] },
    { W: .235, H: .124, z: -.014, c: canv.D[1] },
    { W: .20, H: .085, z: .034, c: canv.D[2] },
  ];
  const V = .2;   // 每翼向前折 ~11.5°
  for (const d of DOORS) {
    const tex = texOf(d.c);
    const mats = {
      front: new THREE.MeshStandardMaterial({ map: tex, alphaTest: .5, roughness: .9, side: THREE.FrontSide }),
      back: new THREE.MeshStandardMaterial({ map: tex, alphaTest: .5, roughness: .92, side: THREE.BackSide, color: '#efe6d2' }),
      depth: new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: .5, side: THREE.DoubleSide }),
    };
    mats.back.onBeforeCompile = s => { s.fragmentShader = s.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n diffuseColor.rgb = vec3(.86,.82,.74);'); };
    mats.back.customProgramCacheKey = () => 'doorback';
    const g = new THREE.Group(); g.position.set(0, HPG, d.z);
    for (const side of [-1, 1]) {
      const geo = new THREE.PlaneGeometry(d.W / 2, d.H); geo.translate(side * d.W / 4, d.H / 2, 0);
      const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setX(i, side < 0 ? uv.getX(i) * .5 : .5 + uv.getX(i) * .5);
      const wing = new THREE.Group(); wing.rotation.y = -side * V;
      const f = new THREE.Mesh(geo, mats.front), bk = new THREE.Mesh(geo, mats.back);
      f.castShadow = true; f.customDepthMaterial = mats.depth; f.receiveShadow = bk.receiveShadow = true;
      wing.add(f, bk); g.add(wing);
    }
    g.visible = false; book.add(g); d.g = g;
  }

  // —— 相机路径 ——
  const V1 = 1080 * KM, x0 = X(camX(T.lamp));
  const keys = [
    [T.lamp - 1.5, [Math.log(2), 90, x0, HPG, 0, Math.log(V1)]],
    [T.lamp, [Math.log(2), 90, x0, HPG, 0, Math.log(V1)]],
    [b(41.6), [Math.log(24), 52, .0, HPG, .004, Math.log(.50)]],
    [b(47.2), [Math.log(27), 32, .0, HPG + .052, -.004, Math.log(.355)]],
    [35, [Math.log(27), 28.5, .0, HPG + .05, -.006, Math.log(.335)]],
    [36.5, [Math.log(27), 28.5, .0, HPG + .05, -.006, Math.log(.335)]],
  ];
  const path = track(keys);
  const v = new THREE.Vector3();
  function setCam(t) {
    let fov, el, tx, ty, tz, vis;
    if (t < T.lamp) { const s = shake(t); fov = 2; el = 90; tx = X(camX(t) + s[0]); ty = HPG; tz = Z(s[1]); vis = V1; }
    else { const k = path(t); fov = Math.exp(k[0]); el = k[1]; tx = k[2]; ty = k[3]; tz = k[4]; vis = Math.exp(k[5]); }
    const D = vis / 2 / Math.tan(fov * Math.PI / 360), e = el * Math.PI / 180;
    cam.fov = fov; cam.position.set(tx, ty + D * Math.sin(e), tz + D * Math.cos(e));
    cam.up.set(0, Math.cos(e), -Math.sin(e)); cam.lookAt(tx, ty, tz);
    cam.near = Math.max(.01, D * .35); cam.far = D + 4; cam.updateProjectionMatrix();
    return { D, tx, ty, tz, fov, el };
  }

  function update(t) {
    const s2 = t >= T.lamp;
    const c = setCam(t);
    quad.visible = !s2;
    if (!s2) { const s = shake(t); quad.position.set(X(camX(t) + s[0]), HPG + .0002, Z(s[1])); }
    for (const m of [leafF, leafB, rightP, newL]) m.visible = s2;
    // 光：台灯在 b36 开（0.25 s 升到全亮，钨丝式）
    const lamp = s2 ? eo(clamp((t - T.lamp) / .25)) * (1 - .06 * Math.exp(-(t - T.lamp) / .12)) : 0;
    spot.intensity = .92 * lamp; fill.intensity = .07 * lamp; bulbMat.emissiveIntensity = 6 * lamp;
    scene.environmentIntensity = .34 * ss(clamp((t - T.lamp) / 1.2));
    // 画里的光淡下去（印在纸上的样子），右页旧灯箱重新微亮
    leafF.material.emissiveIntensity = s2 ? lerp(1, .28, ss(clamp((t - T.lamp) / (b(40) - T.lamp)))) : 1;
    rightP.material.emissiveIntensity = s2 ? .28 * ss(clamp((t - T.relight) / .9)) : 0;
    // 翻页
    const u = clamp((t - T.leafStart) / (T.leafLand - T.leafStart));
    if (u <= 0) setFlat(leafGeo, -1, .0006); else setLeaf(leafGeo, u);
    newL.visible = s2 && u > 0;
    // 纸门：落地就在拍上
    DOORS.forEach((d, i) => {
      const tb = T.doors[i], t0 = tb - .27;
      d.g.visible = t >= t0;
      if (t < t0) return;
      let a;
      if (t < tb) { const q = (t - t0) / .27; a = -Math.PI / 2 * (1 - q * q); }
      else { const q = t - tb; a = .16 * Math.exp(-q / .09) * Math.sin(q * 34) ; }
      d.g.rotation.x = a;
    });
    // 景深、泛光、暗角
    const p = s2 ? clamp((t - T.lamp) / 3) : 0;
    post.dof.focus = s2 ? lerp(c.D, Math.hypot(cam.position.x, cam.position.y - (HPG + .05), cam.position.z + .014), ss(clamp((t - b(42)) / 3))) : c.D;
    post.dof.aper = lerp(0, 8, ss(p)); post.dof.maxCoc = 16;
    post.bloom.strength = lerp(.32, .18, ss(p)); post.vig.uniforms.amt.value = lerp(.28, .42, ss(p));
  }
  function render() {
    const dbg = new URLSearchParams(location.search).get('dbg');
    if (dbg) { const [px, py, pz, lx, ly, lz] = dbg.split(',').map(Number); cam.fov = 40; cam.up.set(0, 1, 0); cam.position.set(px, py, pz); cam.lookAt(lx, ly, lz); cam.near = .01; cam.far = 10; cam.updateProjectionMatrix(); post.dof.aper = 0; }
    post.composer.render();
  }
  lampG.updateMatrixWorld(true); window.LAMPPARTS = []; lampG.traverse(o => { if (o.isMesh) { const bb = new THREE.Box3().setFromObject(o); window.LAMPPARTS.push([o.name, o.material.name, bb.min.toArray().map(v => +v.toFixed(3)), bb.max.toArray().map(v => +v.toFixed(3))]); } });
  // 世界点 → 屏幕
  function project(x, y, z) { v.set(x, y, z).project(cam); return [(v.x + 1) / 2 * W, (1 - v.y) / 2 * H]; }
  return { renderer, scene, cam, post, update, render, tex1, pages: { LA, LE, RA, RE }, DOORS, project, leafF };
}
