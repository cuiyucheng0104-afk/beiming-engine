// 三维：木桌、立体书、台灯、纸舞台、卡片、相机。单位米，y 向上；书脊在远端 z = -BD/2。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { makePost } from '/core/three/post.js';
import { clamp, lerp, seg, ss, eo, eio, back, track } from '/core/lib.js';
import { T, E8, LABEL } from './timeline.js';
import { E } from './cover.js';
import * as A from './art.js';

export const BW = .48, BD = .28, BT = .003, HB = .02, PG = BT + HB;
export const LW = .448, LH = .252;                 // 书封上的印刷版面（16:9）
const ZH = -BD / 2;                                 // 书脊（铰链）z

export function texOf(c, o = {}) {
  const t = new THREE.CanvasTexture(c); t.colorSpace = o.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.anisotropy = 16; t.generateMipmaps = o.mip !== false; t.minFilter = o.mip === false ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  return t;
}
// 剪纸件：正面是画，背面纸色，阴影是剪影
function cutMats(tex, backCol = '#EFE8DA') {
  const front = new THREE.MeshStandardMaterial({ map: tex, alphaTest: .5, roughness: .86, side: THREE.FrontSide });
  const backM = new THREE.MeshStandardMaterial({ map: tex, alphaTest: .5, roughness: .92, side: THREE.BackSide, color: backCol });
  backM.onBeforeCompile = s => { s.fragmentShader = s.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n diffuseColor.rgb = vec3(.90,.86,.78);'); };
  backM.customProgramCacheKey = () => 'paperback';
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: .5, side: THREE.DoubleSide });
  return { front, back: backM, depth };
}
// 底边铰链的纸片：原点 = 底边中点（ax 0..1 指定水平锚点）
function cutPiece(c, w, h, o = {}) {
  const tex = o.tex || texOf(c), m = cutMats(tex);
  const geo = new THREE.PlaneGeometry(w, h); geo.translate(w * (.5 - (o.ax ?? .5)), h / 2 - (o.ay ?? 0) * h, 0);
  const f = new THREE.Mesh(geo, m.front), b = new THREE.Mesh(geo, m.back);
  f.castShadow = true; f.customDepthMaterial = m.depth; f.receiveShadow = b.receiveShadow = true; b.castShadow = false;
  const g = new THREE.Group(); g.add(f, b); g.userData = { tex, f, b, w, h }; return g;
}
// V 形折页：左右两翼绕中缝折出 V（v 弧度），底边铰链
function vFold(c, w, h) {
  const tex = texOf(c), m = cutMats(tex), g = new THREE.Group(), wings = [];
  for (const side of [-1, 1]) {
    const geo = new THREE.PlaneGeometry(w / 2, h); geo.translate(side * w / 4, h / 2, 0);
    const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setX(i, side < 0 ? uv.getX(i) * .5 : .5 + uv.getX(i) * .5);
    const wing = new THREE.Group(), f = new THREE.Mesh(geo, m.front), b = new THREE.Mesh(geo, m.back);
    f.castShadow = true; f.customDepthMaterial = m.depth; f.receiveShadow = b.receiveShadow = true;
    wing.add(f, b); g.add(wing); wings.push([wing, side]);
  }
  g.userData.setV = v => wings.forEach(([wg, s]) => { wg.rotation.y = -s * v; });
  return g;
}
// 落在拍上的 back() 回弹：在 tb 第一次到位，之后回弹落定
const BS = 1.8, BX = 1 / (BS + 1);
const popAt = (t, tb, d = .62) => back(seg(t, tb - BX * d, tb + (1 - BX) * d), BS);

export async function makeStage(IMG, coverCanvas) {
  const W = 1920, H = 1080;
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  const SS = +(new URLSearchParams(location.search).get('ss') || 2);
  renderer.setPixelRatio(SS); renderer.setSize(W, H);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.NoToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.getElementById('stage').appendChild(renderer.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#000000');
  const cam = new THREE.PerspectiveCamera(2, W / H, .02, 30);
  const post = makePost(renderer, scene, cam, W, H, { ssaa: SS });
  // 色调：瑞士段恒等；台灯亮后渐入 PBR Neutral 色调曲线
  const tone = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, mixv: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
    fragmentShader: `varying vec2 vUv; uniform sampler2D tDiffuse; uniform float mixv;
      vec3 neutral(vec3 color){ const float sc = 0.76; const float de = 0.15; float x = min(color.r, min(color.g, color.b)); float off = x < 0.08 ? x - 6.25 * x * x : 0.04; color -= off;
        float pk = max(color.r, max(color.g, color.b)); if (pk < sc) return color; const float d = 1. - sc; float np = 1. - d * d / (pk + d - sc); color *= np / pk;
        float g = 1. - 1. / (de * (pk - np) + 1.); return mix(color, vec3(np), g); }
      void main(){ vec4 c = texture2D(tDiffuse, vUv); c.rgb = mix(c.rgb, neutral(c.rgb), mixv); gl_FragColor = c; }`,
  });
  post.composer.insertPass(tone, 3);

  const hdr = await new RGBELoader().loadAsync('/core/assets/polyhaven/lythwood_lounge_2k.hdr');
  const pm = new THREE.PMREMGenerator(renderer); const envT = pm.fromEquirectangular(hdr).texture;
  scene.environment = envT; scene.environmentIntensity = 0;
  hdr.mapping = THREE.EquirectangularReflectionMapping; scene.background = hdr; scene.backgroundIntensity = 0; scene.backgroundBlurriness = .5;
  scene.backgroundRotation.y = 2.2;

  // —— 木桌（Poly Haven 胡桃木，CC0）——
  const tl = new THREE.TextureLoader();
  const [wd, wn, wr] = await Promise.all(['walnut_diff', 'walnut_nor', 'walnut_rough'].map(n => tl.loadAsync(`/core/assets/polyhaven/${n}.jpg`)));
  wd.colorSpace = THREE.SRGBColorSpace;
  for (const x of [wd, wn, wr]) { x.wrapS = x.wrapT = THREE.RepeatWrapping; x.repeat.set(3, 3); x.anisotropy = 16; x.rotation = Math.PI / 2; }
  const desk = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.MeshStandardMaterial({ map: wd, normalMap: wn, roughnessMap: wr, roughness: .85, color: '#b89273' }));
  desk.rotation.x = -Math.PI / 2; desk.receiveShadow = true; scene.add(desk);

  // —— 书 ——
  const book = new THREE.Group(); scene.add(book);
  const clothT = new THREE.Texture(IMG.cloth); clothT.needsUpdate = true; clothT.colorSpace = THREE.SRGBColorSpace; clothT.wrapS = clothT.wrapT = THREE.RepeatWrapping; clothT.anisotropy = 8;
  const cloth = new THREE.MeshStandardMaterial({ map: clothT, roughness: .9 });
  const edgeC = A.cv(64, 256); { const x = edgeC.getContext('2d'); x.fillStyle = '#EFE5CF'; x.fillRect(0, 0, 64, 256); const R = A.mulberry(5); for (let i = 0; i < 256; i += 2.2) { x.fillStyle = `rgba(140,118,86,${.1 + R() * .22})`; x.fillRect(0, i, 64, .9); } }
  const edgeT = texOf(edgeC); edgeT.wrapS = edgeT.wrapT = THREE.RepeatWrapping; edgeT.repeat.set(1, 1);
  const edgeMat = new THREE.MeshStandardMaterial({ map: edgeT, roughness: .95 });
  const lowBoard = new THREE.Mesh(new THREE.BoxGeometry(BW, BT, BD), cloth); lowBoard.position.set(0, BT / 2, 0);
  const block = new THREE.Mesh(new THREE.BoxGeometry(BW - .006, HB, BD - .004), [edgeMat, edgeMat, edgeMat, edgeMat, edgeMat, edgeMat]); block.position.set(0, BT + HB / 2, .001);
  const spine = new THREE.Mesh(new THREE.CylinderGeometry((PG + BT) / 2, (PG + BT) / 2, BW, 24, 1, false, Math.PI, Math.PI), cloth);
  spine.rotation.z = Math.PI / 2; spine.position.set(0, (PG + BT) / 2, ZH);
  for (const m of [lowBoard, block, spine]) { m.castShadow = m.receiveShadow = true; book.add(m); }
  // 地面页
  const groundT = texOf(A.groundArt(BW - .008, BD - .006));
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(BW - .008, BD - .006), new THREE.MeshStandardMaterial({ map: groundT, roughness: .92 }));
  ground.rotation.x = -Math.PI / 2; ground.position.set(0, PG + .0002, .001); ground.receiveShadow = true; book.add(ground);
  // 封面：绕书脊翻起
  const hinge = new THREE.Group(); hinge.position.set(0, PG, ZH); book.add(hinge);
  const coverBoard = new THREE.Mesh(new THREE.BoxGeometry(BW, BT, BD), cloth); coverBoard.position.set(0, BT / 2, BD / 2); coverBoard.castShadow = coverBoard.receiveShadow = true; hinge.add(coverBoard);
  const coverTex = texOf(coverCanvas, { mip: true });
  const coverMat = new THREE.MeshStandardMaterial({ map: coverTex, emissiveMap: coverTex, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 1, roughness: .78 });
  const label = new THREE.Mesh(new THREE.PlaneGeometry(LW, LH), coverMat); label.rotation.x = -Math.PI / 2; label.position.set(0, BT + .0003, BD / 2);
  // 版面的上边 = 书脊一侧（本地 z=0），从正上方看时画面上方是书脊
  label.receiveShadow = true; hinge.add(label);
  const skyT = texOf(A.backdropArt(BW - .008, BD - .006));
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(BW - .008, BD - .006), new THREE.MeshStandardMaterial({ map: skyT, roughness: .92 }));
  sky.rotation.x = Math.PI / 2; sky.position.set(0, -.0003, BD / 2); sky.receiveShadow = true; hinge.add(sky);
  // 天幕：本地 z = BD 是立起后的顶端；PlaneGeometry 的 +y 经 rotation.x=π/2 指向 +z，正面朝下（立起后朝向镜头）

  // —— 台灯（Poly Haven CC0）——
  const gl = new GLTFLoader();
  const lampG = (await gl.loadAsync('/core/assets/polyhaven/desk_lamp_arm_01/desk_lamp_arm_01.gltf')).scene;
  // 灯体改成黑色金属（原模型橙色太抢画面）；灯罩内发光件保留
  lampG.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { if (!m.name.endsWith('_light')) { m.map = null; m.color = new THREE.Color('#1b1a19'); m.metalness = .7; m.roughness = .38; m.needsUpdate = true; } }); } });
  lampG.scale.setScalar(.62); lampG.position.set(-.39, 0, .2); lampG.rotation.y = -Math.PI * .5; scene.add(lampG);
  lampG.updateMatrixWorld(true);
  let bulbMat = null;
  lampG.traverse(o => { if (o.isMesh) { const mats = Array.isArray(o.material) ? o.material : [o.material]; mats.forEach(m => { if (m.name.endsWith('_light')) bulbMat = m; }); } });
  // 灯泡在模型本地坐标约 (0, .70, -.18)（glTF 里发光部件的包围盒中心）
  const head = new THREE.Vector3(0, .69, -.175).applyMatrix4(lampG.matrixWorld);
  if (bulbMat) { bulbMat.emissive = new THREE.Color('#ffd6a0'); bulbMat.emissiveIntensity = 0; bulbMat.toneMapped = false; }
  const spot = new THREE.SpotLight('#ffe2bd', 0, 0, .62, .75, 1.6);
  spot.position.copy(head); spot.target.position.set(.02, PG + .04, -.03);
  spot.castShadow = true; spot.shadow.mapSize.set(4096, 4096); spot.shadow.bias = -.0001; spot.shadow.normalBias = .0012; spot.shadow.camera.near = .05; spot.shadow.camera.far = 2.5; spot.shadow.radius = 4;
  scene.add(spot, spot.target);
  const fill = new THREE.PointLight('#ffd9b0', 0, 0, 2); fill.position.set(.35, .5, .8); scene.add(fill);
  const rim = new THREE.DirectionalLight('#cfe0ff', 0); rim.position.set(.6, .7, -.9); scene.add(rim);

  // —— 纸舞台（立在封面打开后的地面页上）——
  const stage = new THREE.Group(); stage.position.set(0, PG + .0004, 0); book.add(stage);
  const MW = .44, MH = .12;
  const mtn = vFold(A.mountainsArt(MW, MH), MW + 80 / A.PX, MH + 40 / A.PX); mtn.position.z = -.105; stage.add(mtn);
  const wings = [-1, 1].map(s => { const g = cutPiece(A.wingArt(.075, .118, s > 0), .075 + 80 / A.PX, .118 + 40 / A.PX); g.position.set(s * .205, 0, -.05); g.userData.s = s; stage.add(g); return g; });
  // 第三道折页：浪栏
  const band = vFold(A.waveBandArt(.4, .032), .4 + 80 / A.PX, .032 + 40 / A.PX); band.position.z = -.028; stage.add(band);
  // IP 卡片
  const cardH = .108;
  const CARD_X = [-.118, 0, .118], CARD_X2 = [-.168, -.082, .158];   // 17.75–18.0 让路：黑猫警长与孙悟空左移、葫芦兄弟右移
  const TRACK_X = .04, CARD_Z = -.006;                               // 卡片略往后站，给前面的纸条标签留出投影空间                                               // 纸轨偏右，剧照卡从黑猫警长与葫芦兄弟之间的通道升起
  const cards = ['wukong', 'heimao', 'hulu'].map((k, i) => {
    const a = A.cardArt(IMG[k]); const w = cardH * a.aspect;
    const g = cutPiece(a.c, w, cardH); g.position.set(CARD_X[i], 0, CARD_Z); stage.add(g); g.userData.art = a; return g;
  });
  // 纸条标签
  let LABEL_Z = .134, LABEL_LEAN = 1.1, LABEL_S = 1.06;   // 标签站在书页前沿、向后仰 63°（像桌签）：上沿投影始终低于海报画面下沿 ≥ 20 px（tools/labeltune2.js 逐帧量）
  const LBW = .228, LBH = .031, lc = A.cv((LBW) * A.LPX + 80, LBH * A.LPX + 80);
  const lTex = texOf(lc);
  const labelG = cutPiece(lc, LBW + 80 / A.LPX, LBH + 80 / A.LPX, { tex: lTex }); labelG.position.set(0, 0, LABEL_Z); stage.add(labelG);
  let labelN = -1;
  // 拉片（前沿伸出）
  const tabG = cutPiece(A.tabArt(.026, .07), .026 + 60 / A.PX, .07 + 60 / A.PX, { ay: 0 });
  tabG.rotation.x = -Math.PI / 2; tabG.position.set(.13, .0006, .162); stage.add(tabG);
  // 三层纸云（从书沟滑出）
  const CH = .085;
  const clouds = [0, 1, 2].map(k => { const g = cutPiece(A.cloudBankArt(.44, CH, k), .44 + 80 / A.PX, CH + 40 / A.PX); g.position.set(0, 0, -.128 + k * .007); g.userData.top = [.172, .152, .132][k] - CH; stage.add(g); return g; });
  // 纸轨 + 大闹天宫剧照卡片
  const trackG = cutPiece(A.trackArt(.022, .26), .022 + 60 / A.PX, .26 + 60 / A.PX); trackG.position.set(TRACK_X, -.002, -.113); stage.add(trackG);
  const still = A.cardArt(IMG.still, .04), stW = .158, stH = stW / still.aspect;
  const stillG = cutPiece(still.c, stW, stH); stillG.position.set(TRACK_X, 0, -.110); stage.add(stillG);
  const RISE0 = -.044, RISE_STEP = .02;      // 每个八分音符升一齿

  // —— 相机：[log fov, 仰角, 方位, tx, ty, tz, log 可视高] ——
  const C0 = [Math.log(2), 90, 0, 0, PG + BT + .0003, 0, Math.log(LH)];
  const K = [
    [T.lamp, C0],
    [T.lamp + .5, [Math.log(5), 84, 0, 0, PG + .004, -.002, Math.log(.29)]],
    // 揭晓：长焦从右前方高位看，台灯（灯头 + 光池）完整在左，书在右中；焦点压在书封
    [T.camSettle, [Math.log(18), 40, 30, -.12, PG + .117, .04, Math.log(.68)]],
    [T.open, [Math.log(28), 30, 14, -.03, PG + .08, -.04, Math.log(.46)]],
    [T.folds[2] + .25, [Math.log(24), 18, -6, 0, PG + .07, -.025, Math.log(.31)]],
    [T.label, [Math.log(24), 19, -11, -.03, PG + .044, .04, Math.log(.21)]],
    [T.pull, [Math.log(24), 17, 10, .045, PG + .038, .07, Math.log(.197)]],
    [T.rise, [Math.log(23), 9, 9, .03, PG + .095, -.04, Math.log(.22)]],
    // 结尾：上升幅度与仰角收小，画面上沿停在天幕上沿以内
    [20.2, [Math.log(22), 3, 5, TRACK_X, PG + .168, -.11, Math.log(.2)]],
  ];
  let path = track(K);
  const CK = new URLSearchParams(location.search).get('ck');   // 试机位用（不进成片）
  const v3 = new THREE.Vector3();
  function setCam(t) {
    let k = t <= T.lamp ? C0 : path(t);
    if (CK) { const a = CK.split(',').map(Number); k = [Math.log(a[0]), a[1], a[2], a[3], a[4], a[5], Math.log(a[6])]; }
    const fov = Math.exp(k[0]), el = k[1] * Math.PI / 180, az = k[2] * Math.PI / 180, tx = k[3], ty = k[4], tz = k[5], vis = Math.exp(k[6]);
    const D = vis / 2 / Math.tan(fov * Math.PI / 360);
    const dir = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
    cam.fov = fov; cam.position.set(tx + D * dir[0], ty + D * dir[1], tz + D * dir[2]);
    cam.up.set(-Math.sin(az) * Math.sin(el), Math.cos(el), -Math.cos(az) * Math.sin(el)); cam.lookAt(tx, ty, tz);
    cam.near = Math.max(.005, D * .2); cam.far = D + 6; cam.updateProjectionMatrix();
    return { D, fov };
  }

  const state = {};
  const fw = new THREE.Vector3(), bk = new THREE.Vector3(), BOOKC = new THREE.Vector3(0, PG + BT, 0);
  const REV_APER = +(new URLSearchParams(location.search).get('ap') || 100);
  function update(t) {
    const c = setCam(t);
    // —— 光：6.0 台灯"咔"亮（0.18 s 钨丝升温），封面从自发光过渡到受光 ——
    const lampK = t < T.lamp ? 0 : eo(clamp((t - T.lamp + 1 / 30) / .2)) * (1 - .05 * Math.exp(-(t - T.lamp) / .1));
    spot.intensity = 1.25 * lampK; fill.intensity = .05 * lampK; rim.intensity = .25 * lampK;
    if (bulbMat) bulbMat.emissiveIntensity = 5 * lampK;
    const room = ss(clamp((t - T.lamp) / .9));
    scene.environmentIntensity = .26 * room; scene.backgroundIntensity = .006 * room;   // 夜里只开一盏台灯：环境背景压到接近黑
    coverMat.emissiveIntensity = t < T.lamp ? 1 : 1 - ss(clamp((t - T.lamp) / .6));
    tone.uniforms.mixv.value = ss(clamp((t - T.lamp) / .6));
    // —— 封面：7.5 预备抬起，8.0 第一次到 90°，back() 回弹 ——
    let th = 0;
    if (t >= T.coverLift) {
      const pre = 4 * ss(seg(t, T.coverLift - 1 / 30, T.coverLift + .14));
      const d = 1.0, p = back(seg(t, T.open - BX * d, T.open + (1 - BX) * d), BS);
      th = Math.max(pre, 90 * p) * Math.PI / 180;
    }
    hinge.rotation.x = -th;
    const opened = th > .02;
    stage.visible = opened; ground.visible = opened;
    // —— 折页：后 → 前 ——
    const pm = popAt(t, T.folds[0]); mtn.rotation.x = Math.PI / 2 * (1 - pm); mtn.userData.setV(.16 * clamp(pm)); mtn.position.y = .0042 * (1 - clamp(pm));
    const pc = popAt(t, T.folds[1]);
    wings.forEach(g => { g.rotation.x = Math.PI / 2 * (1 - pc); g.rotation.y = g.userData.s * -.38 * clamp(pc); g.position.y = .0034 * (1 - clamp(pc)); });
    const pb = popAt(t, T.folds[2]); band.rotation.x = Math.PI / 2 * (1 - pb); band.userData.setV(.1 * clamp(pb)); band.position.y = .0024 * (1 - clamp(pb));
    // —— 卡片（向前扣着、背面朝上 → 在拍上立起）——
    const pp = E(seg(t, T.part - 1 / 30, T.partEnd));
    cards.forEach((g, i) => { const p = popAt(t, T.cards[i]); g.rotation.x = Math.PI / 2 * (1 - p) - .06 * clamp(p); g.position.y = (.0014 + .0001 * i) * (1 - clamp(p)); g.position.x = lerp(CARD_X[i], CARD_X2[i], pp); });
    // —— 标签：12.0 立起，之后每个十六分音符打一个字 ——
    const pl = popAt(t, T.label); labelG.rotation.x = Math.PI / 2 * (1 - pl) - LABEL_LEAN * clamp(pl); labelG.position.z = LABEL_Z; labelG.scale.setScalar(LABEL_S); labelG.position.y = .0007 * (1 - clamp(pl));
    let n = 0; T.typing.forEach(tt => { if (t >= tt) n++; });
    if (n !== labelN) { A.labelArt(lc, LBW, LBH, LABEL, n); lTex.needsUpdate = true; labelN = n; }
    // —— 拉片 ——
    const pt = eo(seg(t, T.pull - 1 / 30, T.pullEnd)); tabG.position.z = .162 + .05 * pt;
    // —— 纸云：从书沟滑出，落在拍上 ——
    clouds.forEach((g, k) => { const p = popAt(t, T.clouds[k], .5); g.position.y = lerp(-CH - .006, g.userData.top, p); g.visible = t > T.clouds[k] - .4; });
    // —— 剧照卡片：沿纸轨上升，每个八分音符过一个齿（齿内精确缓动）——
    let y = RISE0;
    if (t >= T.rise - E8) { const u = (t - (T.rise - E8)) / E8, i = Math.floor(u); y = RISE0 + RISE_STEP * (i + E(u - i)); }
    stillG.position.y = y; stillG.visible = t > T.rise - 1;
    trackG.position.y = lerp(-.27, -.002, eo(seg(t, T.pull - 1 / 30, T.pullEnd))); trackG.visible = t > T.pull - .1;
    state.cover = th * 180 / Math.PI; state.mtn = pm; state.wings = pc; state.band = pb; state.label = pl; state.typed = n; state.tab = pt; state.lamp = lampK;
    state.cards = cards.map((_, i) => popAt(t, T.cards[i])); state.clouds = clouds.map((_, k) => popAt(t, T.clouds[k], .5)); state.still = y; state.part = pp;
    // —— 景深与后期 ——
    const pr = t < T.lamp ? 0 : ss(clamp((t - T.lamp) / 1.2));
    // 揭晓镜头（6.3–8.3 s）：焦点压在书封上（不是相机目标点），光圈开大 → 微距浅景深；书翻开后回到舞台焦点
    cam.getWorldDirection(fw); const bookD = bk.copy(BOOKC).sub(cam.position).dot(fw);
    const rv = ss(seg(t, T.lamp + .3, T.camSettle)) * (1 - ss(seg(t, T.coverLift, T.open + .3)));
    post.dof.focus = lerp(c.D, bookD, rv); post.dof.aper = 7.5 * pr + REV_APER * rv; post.dof.maxCoc = 14 + 8 * rv;
    post.bloom.strength = .12 * pr; post.bloom.threshold = .9; post.bloom.radius = .5;
    post.vig.uniforms.amt.value = .38 * pr; post.vig.uniforms.warm.value = .25 * pr;
    return c;
  }
  const DBG = new URLSearchParams(location.search).get('dbg');
  function render() {
    if (DBG) { const [px, py, pz, lx, ly, lz] = DBG.split(',').map(Number); cam.fov = 40; cam.up.set(0, 1, 0); cam.position.set(px, py, pz); cam.lookAt(lx, ly, lz); cam.near = .01; cam.far = 10; cam.updateProjectionMatrix(); post.dof.aper = 0; }
    post.composer.render();
  }
  // 不经 render 也要用当前机位
  function project(x, y, z) { cam.updateMatrixWorld(); v3.set(x, y, z).project(cam); return [(v3.x + 1) / 2 * W, (1 - v3.y) / 2 * H]; }
  // 书封版面坐标 (u,v)∈[0,1920]×[0,1080] → 世界
  const lm = new THREE.Vector3();
  function coverToWorld(u, v) { label.updateWorldMatrix(true, false); lm.set((u / 1920 - .5) * LW, (.5 - v / 1080) * LH, 0); return lm.clone().applyMatrix4(label.matrixWorld); }
  function labelBox() { labelG.updateWorldMatrix(true, true); const g = labelG.userData; const pts = [[-g.w / 2, 0], [g.w / 2, 0], [-g.w / 2, g.h], [g.w / 2, g.h]].map(([a, b]) => { const p = new THREE.Vector3(a, b, 0).applyMatrix4(labelG.matrixWorld); return project(p.x, p.y, p.z); });
    return pts; }
  // 几何检查：IP 图画面矩形、标签纸条矩形（屏幕像素）
  function rectOf(g, art) {
    g.updateWorldMatrix(true, true); const u = g.userData; const [ix, iy, iw, ih] = art.imgRect;
    const xs = [ix, ix + iw].map(px => -u.w / 2 + px / art.w * u.w), ys = [iy, iy + ih].map(py => u.h - py / art.h * u.h);
    const pts = []; for (const a of xs) for (const b of ys) { const p = new THREE.Vector3(a, b, 0).applyMatrix4(g.matrixWorld); pts.push(project(p.x, p.y, p.z)); }
    return [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
  }
  function geo() {
    const lu = labelG.userData, ltop = 18 / A.LPX;
    const lart = { w: lu.w, h: lu.h, imgRect: [40 / A.LPX, ltop, lu.w - 80 / A.LPX, lu.h - 2 * ltop] };
    return { cards: cards.map(g => g.visible && stage.visible ? rectOf(g, g.userData.art) : null), still: stillG.visible ? rectOf(stillG, still) : null,
      label: stage.visible ? rectOf(labelG, lart) : null, cardP: state.cards, labelP: state.label };
  }
  const tune = (z, lean, sc = LABEL_S) => { LABEL_Z = z; LABEL_LEAN = lean; LABEL_S = sc; };
  const setKey = (i, k) => { K[i][1] = k; path = track(K); };
  return { tune, setKey, K, geo, state, renderer, scene, cam, post, update, render, project, coverTex, coverToWorld, labelBox, head, lampG };
}
