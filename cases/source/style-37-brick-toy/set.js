// 真实书桌：中性摄影棚 HDRI、胡桃木桌面（有桌沿）、地板、茶具、台灯、书、铅笔；钥光 + 柔光箱
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { mulberry } from '/core/lib.js';

const PH = '/core/assets/polyhaven/';
export const M = 125;                         // 1 米 = 125 凸点
export const DESK = { x0: -95, x1: 70, z0: -62, z1: 46 };   // 桌面范围（约 1.32 m × 0.86 m）
export const CUP = { x: 14, z: -14 };         // 茶杯
export const LAMP = { x: -52, z: -44 };

export async function buildSet(scene) {
  const hdr = await new RGBELoader().loadAsync(PH + 'photo_studio_loft_hall_2k.hdr');
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = hdr; scene.background = hdr;
  scene.backgroundBlurriness = .55; scene.backgroundIntensity = .2; scene.environmentIntensity = .45;
  scene.environmentRotation.y = scene.backgroundRotation.y = 1.2;

  const tl = new THREE.TextureLoader();
  const tex = async (f, srgb, rx = 3.2, ry = 2.1) => { const t = await tl.loadAsync(PH + f); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry); t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };
  const W = DESK.x1 - DESK.x0, D = DESK.z1 - DESK.z0, TH = 3.6;
  const wood = new THREE.MeshStandardMaterial({ color: '#d9a77c', map: await tex('walnut_diff.jpg', true), normalMap: await tex('walnut_nor.jpg'), roughnessMap: await tex('walnut_rough.jpg'), roughness: 1 });
  const edge = new THREE.MeshStandardMaterial({ color: '#3b2516', roughness: .6 });
  const desk = new THREE.Mesh(new THREE.BoxGeometry(W, TH, D), [edge, edge, wood, edge, edge, edge]);
  desk.position.set((DESK.x0 + DESK.x1) / 2, -TH / 2, (DESK.z0 + DESK.z1) / 2); desk.receiveShadow = true; desk.castShadow = true; scene.add(desk);
  // 桌腿 + 地板（尺度揭示时看得到桌子边缘之外）
  const legM = new THREE.MeshStandardMaterial({ color: '#2e1d12', roughness: .55 });
  const LEGS = [[DESK.x0 + 5, DESK.z0 + 5], [DESK.x1 - 5, DESK.z0 + 5], [DESK.x0 + 5, DESK.z1 - 5], [DESK.x1 - 5, DESK.z1 - 5]];
  for (const [x, z] of LEGS) {
    const l = new THREE.Mesh(new THREE.BoxGeometry(5, 92, 5), legM); l.position.set(x, -TH - 46, z); scene.add(l);
  }
  desk.castShadow = false;   // 桌子在地上的影子换成柔和的接触阴影（下面），不要方块硬影
  await buildRoom(scene, tl, -TH - 92, LEGS);

  // 光：暖白钥光（投影）+ 冷补光 + 三块柔光箱（亮面塑料上的矩形高光）
  const key = new THREE.DirectionalLight('#fff4e8', 3.0); key.position.set(-60, 110, 50); key.target.position.set(0, 0, 0);
  key.castShadow = true; key.shadow.mapSize.set(4096, 4096); key.shadow.bias = -.0004; key.shadow.normalBias = .03; key.shadow.radius = 4;
  Object.assign(key.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 10, far: 500 }); scene.add(key, key.target);
  const fill = new THREE.DirectionalLight('#cfe0ff', .45); fill.position.set(60, 40, -50); scene.add(fill);
  RectAreaLightUniformsLib.init();
  const box = (col, I, w, h, p, at) => { const l = new THREE.RectAreaLight(col, I, w, h); l.position.set(...p); l.lookAt(...at); scene.add(l); return l; };
  box('#fff6ee', 6, 70, 45, [-55, 60, 55], [0, 4, 0]);
  box('#e4eeff', 9, 60, 30, [45, 45, -75], [0, 6, 0]);
  box('#fff6ee', 4, 50, 35, [-10, 75, 20], [-10, 2, 0]);

  // 真实道具
  const gl = new GLTFLoader();
  const load = async n => (await gl.loadAsync(`${PH}${n}/${n}.gltf`)).scene;
  const tea = await load('tea_set_01');
  let cupNode = null; const dead = [];
  const keep = { tea_set_01_teapot_01: [-34, -30, .9], tea_set_01_teapot_01_lid: [-34, -30, .9], tea_set_01_saucer_circular_04: [52, 16, 0], tea_set_01_cup_small_02: [52, 16, 2.2, .012], tea_set_01_sugar_cup_01: [-48, -8, 0], tea_set_01_sugar_cup_01_lid: [-48, -8, 0] };
  tea.traverse(o => {
    if (!o.name.startsWith('tea_set_01_')) return;
    if (o.name === 'tea_set_01_cup_small_01') { cupNode = o; return; }
    const k = keep[o.name]; if (!k) dead.push(o); else { o.position.set(k[0] / M, o.position.y + (k[3] ?? 0), k[1] / M); o.rotation.y = k[2]; }
  });
  dead.forEach(o => o.parent.remove(o));
  cupNode.parent.remove(cupNode);
  tea.scale.setScalar(M); scene.add(tea);
  const lamp = await load('desk_lamp_arm_01'); lamp.scale.setScalar(M); lamp.position.set(LAMP.x, 0, LAMP.z); lamp.rotation.y = .9; scene.add(lamp);
  for (const o of [tea, lamp]) o.traverse(m => { if (m.isMesh) m.castShadow = m.receiveShadow = true; });
  const bulb = new THREE.PointLight('#ffe2b8', 900, 160, 2); bulb.position.set(LAMP.x + 30, 70, LAMP.z + 25); scene.add(bulb);

  // 茶杯：单独放进一个"支点"组，好绕杯底边缘翻倒
  const cupGeo = cupNode.geometry ?? cupNode.children.find(c => c.isMesh)?.geometry;
  const cupMat = cupNode.material ?? cupNode.children.find(c => c.isMesh)?.material;
  const cupMesh = new THREE.Mesh(cupGeo, cupMat); cupMesh.scale.setScalar(M); cupMesh.castShadow = cupMesh.receiveShadow = true;
  cupGeo.computeBoundingBox();
  // 杯底半径：取最低 3 mm 内顶点的最大水平半径
  const pa = cupGeo.attributes.position; let rb = 0, ymin = Infinity, rr = 0, ymax = -Infinity;
  for (let i = 0; i < pa.count; i++) ymin = Math.min(ymin, pa.getY(i)), ymax = Math.max(ymax, pa.getY(i));
  for (let i = 0; i < pa.count; i++) {
    const r = Math.hypot(pa.getX(i), pa.getZ(i)); const y = pa.getY(i);
    if (y < ymin + .003 && r < .06) rb = Math.max(rb, r);
    if (y > ymax - .002 && r < .07) rr = Math.max(rr, r);
  }
  const cup = { mesh: cupMesh, rb: rb * M, rr: rr * M, h: (ymax - ymin) * M, y0: -ymin * M };

  // 书（右后方）
  const books = new THREE.Group(); books.position.set(42, 0, -42); books.rotation.y = -.25; scene.add(books);
  const cloth = ['#7b2d26', '#274b6d', '#3d5c3a', '#c9a45c'];
  let by = 0; const R = mulberry(11);
  [[34, 4.2, 25], [31, 3.4, 23], [33, 5, 24]].forEach(([w, h, d], i) => {
    const b = new THREE.Group(); b.position.y = by; b.rotation.y = (R() - .5) * .25;
    const cover = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: cloth[i], roughness: .75 })); cover.position.y = h / 2; b.add(cover);
    const pages = new THREE.Mesh(new THREE.BoxGeometry(w - .6, h - .7, d - .3), new THREE.MeshStandardMaterial({ color: '#efe6d2', roughness: .9 })); pages.position.set(.4, h / 2, 0); b.add(pages);
    b.traverse(m => { if (m.isMesh) m.castShadow = m.receiveShadow = true; }); books.add(b); by += h;
  });
  // 铅笔（前方斜放）
  const pencil = new THREE.Group();
  const pb = new THREE.Mesh(new THREE.CylinderGeometry(.95, .95, 22, 6), new THREE.MeshStandardMaterial({ color: '#f3b61f', roughness: .45 }));
  const pw = new THREE.Mesh(new THREE.ConeGeometry(.95, 2.6, 6), new THREE.MeshStandardMaterial({ color: '#e9c89a', roughness: .8 })); pw.position.y = 12.3;
  const pl = new THREE.Mesh(new THREE.ConeGeometry(.3, .8, 12), new THREE.MeshStandardMaterial({ color: '#2b2b2b', roughness: .4 })); pl.position.y = 14;
  const pf = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1.4, 16), new THREE.MeshStandardMaterial({ color: '#b9bcc0', metalness: 1, roughness: .3 })); pf.position.y = -11.7;
  const pe = new THREE.Mesh(new THREE.CylinderGeometry(.95, .95, 1.6, 16), new THREE.MeshStandardMaterial({ color: '#e88a8a', roughness: .8 })); pe.position.y = -13.2;
  pencil.add(pb, pw, pl, pf, pe); pencil.rotation.set(Math.PI / 2, 0, -1.1); pencil.position.set(-40, .95, 30);
  pencil.traverse(m => { if (m.isMesh) m.castShadow = m.receiveShadow = true; }); scene.add(pencil);

  return { key, bulb, lamp, cup };
}

// —— 房间：木地板（拼条）、抹灰墙 + 踢脚线、窗光斑、桌下柔和接触阴影 ——（只在尺度揭示时看得清）
function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
async function buildRoom(scene, tl, FY, LEGS) {
  const R = mulberry(77);
  // 地板：用胡桃木照片纹理切成长条，逐条错位、明暗略有差别，条缝描暗线 → 实木拼条地板
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = PH + 'walnut_diff.jpg'; });
  const PL = 8, plankW = 2048 / PL;
  const floorMap = canvasTex(2048, 2048, (g, w, h) => {
    g.fillStyle = '#6b4428'; g.fillRect(0, 0, w, h);
    for (let k = 0; k < PL; k++) {
      let y = -R() * 900;
      while (y < h) {
        const len = 700 + R() * 900, sx = R() * (img.width - len * .5 - 2), sy = R() * (img.height - plankW * .5 - 2);
        g.save(); g.beginPath(); g.rect(k * plankW, y, plankW, len); g.clip();
        g.translate(k * plankW + plankW / 2, y + len / 2); g.rotate(Math.PI / 2);
        g.drawImage(img, sx, sy, len * .5, plankW * .5, -len / 2, -plankW / 2, len, plankW);
        g.restore();
        g.fillStyle = `rgba(${R() < .5 ? '255,235,210' : '40,22,10'},${.04 + R() * .08})`; g.fillRect(k * plankW, y, plankW, len);
        g.fillStyle = 'rgba(25,14,6,.75)'; g.fillRect(k * plankW, y, plankW, 3);
        y += len;
      }
      g.fillStyle = 'rgba(25,14,6,.8)'; g.fillRect(k * plankW, 0, 3, h);
    }
  });
  floorMap.wrapS = floorMap.wrapT = THREE.RepeatWrapping; floorMap.repeat.set(9, 9);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400), new THREE.MeshStandardMaterial({ color: '#c79a72', map: floorMap, roughness: .55, envMapIntensity: .8 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = FY; floor.receiveShadow = true; scene.add(floor);
  // 墙：暖白抹灰（细噪点 + 大尺度斑驳）
  const plaster = canvasTex(1024, 1024, (g, w, h) => {
    g.fillStyle = '#e9e3d9'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 26000; i++) { const v = R(); g.fillStyle = `rgba(${v < .5 ? '120,110,96' : '255,252,246'},${.03 + R() * .05})`; g.fillRect(R() * w, R() * h, 1 + R() * 2.5, 1 + R() * 2.5); }
    for (let i = 0; i < 40; i++) { const x = R() * w, y = R() * h, r = 60 + R() * 160, gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, `rgba(150,138,120,${.03 + R() * .04})`); gr.addColorStop(1, 'rgba(150,138,120,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r); }
  });
  plaster.wrapS = plaster.wrapT = THREE.RepeatWrapping; plaster.repeat.set(4, 2);
  const wallM = new THREE.MeshStandardMaterial({ color: '#e4dfd6', map: plaster, roughness: .92 });
  const WZ = -175, WX = -260;
  const back = new THREE.Mesh(new THREE.PlaneGeometry(900, 520), wallM); back.position.set(0, FY + 260, WZ); back.receiveShadow = true; scene.add(back);
  const side = new THREE.Mesh(new THREE.PlaneGeometry(900, 520), wallM); side.rotation.y = Math.PI / 2; side.position.set(WX, FY + 260, WZ + 450); side.receiveShadow = true; scene.add(side);
  // 踢脚线（白漆木条，带一道线脚）
  const skirtM = new THREE.MeshStandardMaterial({ color: '#f1eee8', roughness: .45 });
  const sk1 = new THREE.Mesh(new THREE.BoxGeometry(900, 15, 2.2), skirtM); sk1.position.set(0, FY + 7.5, WZ + 1.1);
  const sk1b = new THREE.Mesh(new THREE.BoxGeometry(900, 1.6, 3.2), skirtM); sk1b.position.set(0, FY + 15, WZ + 1.6);
  const sk2 = new THREE.Mesh(new THREE.BoxGeometry(2.2, 15, 900), skirtM); sk2.position.set(WX + 1.1, FY + 7.5, WZ + 450);
  const sk2b = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.6, 900), skirtM); sk2b.position.set(WX + 1.6, FY + 15, WZ + 450);
  for (const m of [sk1, sk1b, sk2, sk2b]) { m.receiveShadow = true; scene.add(m); }
  // 窗光斑：右上方一扇四格窗投进来的暖光（墙上一块、地上一块，边缘柔），叠加混合
  const windowTex = canvasTex(512, 512, (g, w, h) => {
    g.filter = 'blur(10px)'; g.fillStyle = '#fff';
    const m = 40, bar = 16, cw = (w - 2 * m - bar) / 2, ch = (h - 2 * m - bar) / 2;
    for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]]) g.fillRect(m + i * (cw + bar), m + j * (ch + bar), cw, ch);
  });
  const patch = (w, h, op) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: windowTex, color: new THREE.Color('#ffd9a8').multiplyScalar(op), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: true }));
  const wp = patch(130, 150, .34); wp.position.set(150, FY + 210, WZ + .6); wp.rotation.z = .12; scene.add(wp);
  const fp = patch(150, 210, .26); fp.rotation.set(-Math.PI / 2, 0, .5); fp.position.set(160, FY + .3, -40); scene.add(fp);
  // 桌下柔和的接触阴影：一大片很淡的 + 四条腿脚下各一小团
  const blob = canvasTex(256, 256, (g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2); gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(.55, 'rgba(0,0,0,.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  }, false);
  const shadowM = op => new THREE.MeshBasicMaterial({ map: blob, color: '#000', transparent: true, opacity: op, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
  const big = new THREE.Mesh(new THREE.PlaneGeometry((DESK.x1 - DESK.x0) * 1.45, (DESK.z1 - DESK.z0) * 1.55), shadowM(.42));
  big.rotation.x = -Math.PI / 2; big.position.set((DESK.x0 + DESK.x1) / 2 + 6, FY + .2, (DESK.z0 + DESK.z1) / 2 - 4); scene.add(big);
  for (const [x, z] of LEGS) { const b = new THREE.Mesh(new THREE.PlaneGeometry(16, 16), shadowM(.6)); b.rotation.x = -Math.PI / 2; b.position.set(x, FY + .25, z); scene.add(b); }
}
