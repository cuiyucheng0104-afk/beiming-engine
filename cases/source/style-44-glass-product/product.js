// 棱光 PRISM：虚构香水瓶。单位毫米，瓶底在 y=0，轴线 +Y。
// 部件（从下到上）：厚壁六棱柱玻璃瓶身 + 香水 / 吸管 / 缎面金属环 / 铬泵头 / 瓶盖内金属套 / 切面玻璃瓶盖
import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

export const ACC_A = new THREE.Color('#62d6ff');   // 强调色：冰蓝（只给光）
export const ACC_B = new THREE.Color('#a68cff');   // → 柔紫

export function glass(o = {}) {
  return new THREE.MeshPhysicalMaterial(Object.assign({
    color: '#ffffff', metalness: 0, roughness: .03, transmission: 1, thickness: 14, ior: 1.52,
    dispersion: 1.6, attenuationColor: new THREE.Color('#f2f7fa'), attenuationDistance: 260,
    specularIntensity: 1, envMapIntensity: 1.3, side: THREE.DoubleSide,
  }, o));
}
const metal = (color, rough, o = {}) => new THREE.MeshPhysicalMaterial(Object.assign({ color, metalness: 1, roughness: rough, envMapIntensity: 1.25 }, o));

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.anisotropy = 8; t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}
// 拉丝：横向细线（环、泵头的粗糙度贴图）
const brushed = canvasTex(256, 512, (g, w, h) => {
  g.fillStyle = '#7a7a7a'; g.fillRect(0, 0, w, h);
  let s = 7; const R = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 1400; i++) { const y = R() * h; g.fillStyle = `rgba(${R() < .5 ? 255 : 0},${R() < .5 ? 255 : 0},${R() < .5 ? 255 : 0},${.05 + R() * .09})`; g.fillRect(0, y, w, .6 + R() * 1.2); }
});

// 圆角正六边形轮廓（r = 外接圆半径，c = 圆角）
function hexShape(r, c = 1.2) {
  const s = new THREE.Shape(), P = [];
  for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; P.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r)); }
  for (let i = 0; i < 6; i++) {
    const p = P[i], a = P[(i + 5) % 6], b = P[(i + 1) % 6];
    const pa = a.clone().sub(p).normalize().multiplyScalar(c), pb = b.clone().sub(p).normalize().multiplyScalar(c);
    if (i === 0) s.moveTo(p.x + pa.x, p.y + pa.y); else s.lineTo(p.x + pa.x, p.y + pa.y);
    s.quadraticCurveTo(p.x, p.y, p.x + pb.x, p.y + pb.y);
  }
  s.closePath(); return s;
}
// 沿 +Y 挤出的六棱柱（带倒角），y0..y1
function hexPrism(r, y0, y1, bevel = 2.2, c = 1.4, seg = 3) {
  const g = new THREE.ExtrudeGeometry(hexShape(r - bevel, c), { depth: (y1 - y0) - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: seg, curveSegments: 6 });
  g.rotateX(-Math.PI / 2); g.translate(0, y0 + bevel, 0);
  return toCreasedNormals(g, .62);   // 倒角各段之间 < 36° → 平滑成圆润棱边；平面仍是平面（不再出现阶梯状的一格一格反光）
}

export const DIM = { r: 27, h: 66, neckR: 8.2, neckTop: 73, collarY: [69.5, 77], pumpY: [77, 84.5], capY: [72.5, 101] };

export function makeBottle() {
  const root = new THREE.Group(), body = new THREE.Group(); root.add(body);
  const parts = {};
  // 每个部件的枢轴在它自己的中心高度 c（旋转不会甩出去）
  const part = (name, axisOff, rot, c) => { const g = new THREE.Group(), inner = new THREE.Group(); g.position.y = c; inner.position.y = -c; g.add(inner); body.add(g); parts[name] = { g, off: axisOff, rot, c }; return inner; };

  // 瓶身：厚壁六棱柱 + 瓶肩六棱台 + 瓶颈
  const gBody = part('body', 0, [0, 0, 0], 36);
  const shell = new THREE.Mesh(hexPrism(DIM.r, 0, DIM.h, 2.6, 2.0, 8), glass({ thickness: 22 }));
  gBody.add(shell);
  // 瓶肩：从瓶身顶到瓶颈的切角（六棱台，玻璃）
  const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(DIM.neckR + 3.5, DIM.r * .86, 4.5, 6, 1), glass({ thickness: 8 }));
  shoulder.rotation.y = Math.PI / 6 + Math.PI / 2; shoulder.position.y = DIM.h + 2.0; gBody.add(shoulder);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(DIM.neckR, DIM.neckR, 5, 48), glass({ thickness: 6 }));
  neck.position.y = DIM.h + 6.2; gBody.add(neck);
  // 香水：内腔里的液体（淡紫，略带衰减），液面在 y=50
  const liquid = new THREE.Mesh(hexPrism(DIM.r - 7.5, 15, 52, 1.6, 3.0, 4), glass({ thickness: 30, ior: 1.36, dispersion: .6, attenuationColor: new THREE.Color('#e9e2ff'), attenuationDistance: 90, roughness: .02 }));
  gBody.add(liquid);

  // 吸管：不透明乳白细管（玻璃里能看见的内部件）
  const gTube = part('tube', 62, [.02, 0, -.015], 43); parts.tube.tw = .1;   // 吸管整根抽出到瓶口以上、对准泵头下的接管（避免与瓶身前上棱的高光叠成十字）
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.15, 62, 24), new THREE.MeshPhysicalMaterial({ color: '#dfe6ec', roughness: .35, clearcoat: .6, clearcoatRoughness: .2, sheen: .5, envMapIntensity: 1.2 }));
  tube.position.y = 12 + 31; gTube.add(tube);
  const tubeTip = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.6, 2.4, 24), metal('#cfd4d9', .2)); tubeTip.position.y = 12.5; gTube.add(tubeTip);

  // 金属环：缎面银，套在瓶颈
  const gCollar = part('collar', 40, [-.22, 0, .2], 73);
  const collarP = [[8.4, 0], [11.6, 0], [12.2, .6], [12.2, 6.9], [11.6, 7.5], [8.4, 7.5]].map(([x, y]) => new THREE.Vector2(x, y + DIM.collarY[0]));
  const collar = new THREE.Mesh(new THREE.LatheGeometry(collarP, 160), metal('#d8dbdf', .2, { roughnessMap: brushed }));
  gCollar.add(collar);
  const groove = new THREE.Mesh(new THREE.TorusGeometry(12.25, .32, 12, 160), metal('#9aa0a6', .3)); groove.rotation.x = Math.PI / 2; groove.position.y = DIM.collarY[0] + 3.75; gCollar.add(groove);

  // 泵头：镜面铬短柱 + 喷口
  const gPump = part('pump', 54, [.3, .4, .15], 81);
  const pumpP = [[0, 0], [5.6, 0], [6.2, .5], [6.2, 6.3], [5.4, 7.3], [0, 7.5]].map(([x, y]) => new THREE.Vector2(x, y + DIM.pumpY[0]));
  const pump = new THREE.Mesh(new THREE.LatheGeometry(pumpP, 96), metal('#eceef1', .24));
  gPump.add(pump);
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(.9, .9, 1, 24), new THREE.MeshPhysicalMaterial({ color: '#0d0e10', roughness: .4 }));
  nozzle.rotation.x = Math.PI / 2; nozzle.position.set(0, DIM.pumpY[0] + 4.6, 6.0); gPump.add(nozzle);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.6, 4, 32), metal('#b7bcc2', .25)); stem.position.y = DIM.pumpY[0] - 1.5; gPump.add(stem);

  // 瓶盖内金属套（瓶盖玻璃里看得见的不透明件）
  const gSleeve = part('sleeve', 68, [-.35, -.3, -.2], 80);
  const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(7.4, 7.4, 13, 64, 1, true), metal('#c9ccd0', .28, { side: THREE.DoubleSide, roughnessMap: brushed }));
  sleeve.position.y = DIM.capY[0] + 7.5; gSleeve.add(sleeve);
  const sleeveTop = new THREE.Mesh(new THREE.CircleGeometry(7.4, 64), metal('#c9ccd0', .2)); sleeveTop.rotation.x = -Math.PI / 2; sleeveTop.position.y = DIM.capY[0] + 14; gSleeve.add(sleeveTop);

  // 切面玻璃瓶盖：六棱柱，顶面斜切（一块晶体）
  const gCap = part('cap', 84, [.42, .5, .3], 87);
  const capG = hexPrism(15.5, DIM.capY[0], DIM.capY[1], 1.6, 1.2, 6);
  { const p = capG.attributes.position, top = DIM.capY[1];
    for (let i = 0; i < p.count; i++) { const y = p.getY(i); if (y > top - 6) { const x = p.getX(i), z = p.getZ(i), k = (y - (top - 6)) / 6; p.setY(i, y - k * (x * .32 + z * .1 + 5)); } }
    }
  const cap = new THREE.Mesh(toCreasedNormals(capG, .62), glass({ thickness: 16, dispersion: 2.4 }));
  gCap.add(cap);

  root.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
  return { root, body, parts, shell, liquid, cap };
}

// 爆炸视图：es = 每个部件的展开量 0..1（可各自错开），部件沿局部 +Y 拉开；每件带确定性的小倾斜与和位移成比例的自转；整体往回移半个展开量，保持居中
export function explode(b, es, spin = 0) {
  const names = Object.keys(b.parts); let em = 0;
  names.forEach((n, i) => {
    const p = b.parts[n], e = Array.isArray(es) ? es[i] : es; em = Math.max(em, e);
    p.g.position.set(0, p.c + p.off * e, 0);
    const tw = p.tw ?? 1, tx = Math.sin(i * 1.7 + .4) * .12 * tw, tz = Math.cos(i * 2.3 + .9) * .1 * tw;
    p.g.rotation.set((p.rot[0] + tx) * e, p.rot[1] * e + spin * p.off * .006 * e, (p.rot[2] + tz) * e);
  });
}
