// 灯外的真实世界：胡桃木框的纸雕灯盒、桌面、暗墙、灯口溢出的面光（只在最后拉出时入画）
import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { paint, tex } from './paper.js';
RectAreaLightUniformsLib.init();

export const BOX = { w: .60, h: .34, d: .16, front: .014, border: .034 };
const tl = new THREE.TextureLoader();
function wood(rep = 1, rot = 0) {
  const ld = (f, srgb) => { const t = tl.load('/core/assets/polyhaven/' + f); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep, rep); t.rotation = rot; t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };
  return { map: ld('walnut_diff.jpg', true), normalMap: ld('walnut_nor.jpg'), roughnessMap: ld('walnut_rough.jpg') };
}

export function lightbox(scene) {
  const g = new THREE.Group(); scene.add(g);
  const { w, h, d, front, border } = BOX, W = w + border * 2, H = h + border * 2;
  const sh = new THREE.Shape(); sh.moveTo(-W / 2, -H / 2); sh.lineTo(W / 2, -H / 2); sh.lineTo(W / 2, H / 2); sh.lineTo(-W / 2, H / 2); sh.closePath();
  const hole = new THREE.Path(), r = .006;
  hole.moveTo(-w / 2 + r, -h / 2); hole.lineTo(w / 2 - r, -h / 2); hole.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r); hole.lineTo(w / 2, h / 2 - r); hole.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
  hole.lineTo(-w / 2 + r, h / 2); hole.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r); hole.lineTo(-w / 2, -h / 2 + r); hole.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2); sh.holes.push(hole);
  const wm = new THREE.MeshStandardMaterial({ ...wood(3), color: '#8a6a52', roughness: .55, normalScale: new THREE.Vector2(.6, .6) });
  const frame = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: .018, bevelEnabled: true, bevelThickness: .003, bevelSize: .003, bevelSegments: 3, curveSegments: 6 }), wm);
  frame.position.z = front - .004; frame.castShadow = frame.receiveShadow = true; g.add(frame);
  const side = (sw, shh, sd, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(sw, shh, sd), wm); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; g.add(m); };
  const bt = border * .5;
  side(W, bt, d, 0, -h / 2 - bt / 2, front - d / 2); side(W, bt, d, 0, h / 2 + bt / 2, front - d / 2);
  side(bt, H, d, -w / 2 - bt / 2, 0, front - d / 2); side(bt, H, d, w / 2 + bt / 2, 0, front - d / 2);
  side(W, H, .01, 0, 0, front - d - .005);
  const inner = new THREE.MeshStandardMaterial({ color: '#0a0806', roughness: 1 });
  for (const [ww, hh, x, y, rx, ry] of [[w, d, 0, -h / 2 + .0005, -Math.PI / 2, 0], [w, d, 0, h / 2 - .0005, Math.PI / 2, 0], [d, h, -w / 2 + .0005, 0, 0, Math.PI / 2], [d, h, w / 2 - .0005, 0, 0, -Math.PI / 2]]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(ww, hh), inner); m.position.set(x, y, front - d / 2); m.rotation.set(rx, ry, 0); m.receiveShadow = true; g.add(m);
  }
  const table = new THREE.Mesh(new THREE.PlaneGeometry(3, 2), new THREE.MeshStandardMaterial({ ...wood(4, Math.PI / 2), color: '#6a4a36', roughness: .45 }));
  table.rotation.x = -Math.PI / 2; table.position.set(0, -H / 2, .4); table.receiveShadow = true; g.add(table);
  const wallC = paint(4, 2.4, x => { const gr = x.createRadialGradient(0, .1, .1, 0, 0, 2); gr.addColorStop(0, '#262230'); gr.addColorStop(1, '#08070b'); x.fillStyle = gr; x.fillRect(-2, -1.2, 4, 2.4); }, 200);
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(4, 2.4), new THREE.MeshStandardMaterial({ map: tex(wallC), roughness: 1 }));
  wall.position.set(0, .6, -.9); wall.receiveShadow = true; g.add(wall);
  const spill = new THREE.RectAreaLight('#ffc98a', 0, w * .9, h * .9); spill.position.set(0, 0, front + .002); spill.lookAt(0, -.05, 1); g.add(spill);
  const fill = new THREE.HemisphereLight('#3a3448', '#140c06', .22); g.add(fill);
  return { g, frame, spill, fill };
}
