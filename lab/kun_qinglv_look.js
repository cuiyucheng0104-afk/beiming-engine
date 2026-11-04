// 鲲 · 青绿仙山版 × 正片后期管线（src/look.js → engine/look）联调页（?test=kun_qinglv_look）。
// 目的：确认换进正片时 engine/look/ids.js 的 ID 图能编译 userData.outlineVertex（弯曲、扑动、瀑布边缘），墨线贴着弯过的形体走。
// 参数：&view=side|hero|under &dbg=id|edge|line（看中间缓冲）
import * as THREE from 'three';
import { createKun } from '../src/kun_qinglv.js';
import { setToonGlobals } from '../src/toon.js';
import { createLook } from '../src/look.js';

const q = new URLSearchParams(location.search);
const W = innerWidth, H = innerHeight;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1); renderer.setSize(W, H);
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
const look = createLook(renderer, W, H, { ss: 2 });

const scene = new THREE.Scene();
const sky = await new THREE.TextureLoader().loadAsync('./assets/ref/sky_test.png');
sky.colorSpace = THREE.SRGBColorSpace; scene.background = sky;
const camera = new THREE.PerspectiveCamera(30, W / H, 5, 6000);
const kun = createKun({});
scene.add(kun.group);
const KEY_DIR = new THREE.Vector3(0.75, 0.1, 0.65).normalize();
const key = new THREE.DirectionalLight('#ffd3b0', 1);
key.position.copy(KEY_DIR); scene.add(key, key.target);
setToonGlobals({ cityDir: [0.08, -1, 0.1], keyDir: KEY_DIR.toArray() });
kun.fitShadow(key, { size: 4096 });

const VIEWS = {
  side: { fov: 30, cam: [0, -95, -980], look: [0, 12, 0] },
  hero: { fov: 34, cam: [460, -150, -550], look: [30, 30, 0] },
  under: { fov: 40, cam: [40, -300, -160], look: [110, -10, 10] },
};
const v = VIEWS[q.get('view')] || VIEWS.side;
window.DUR = 4;
window.render = t => {
  const fr = Math.round(t * 24), ts = Math.floor(fr / 3) * 3 / 24;
  camera.fov = v.fov; camera.updateProjectionMatrix();
  camera.position.set(...v.cam); camera.lookAt(...v.look);
  kun.setPose(ts);
  setToonGlobals({ inkTime: Math.floor(fr / 2), pass: 0 });
  look.render(scene, camera, { t: fr / 24, debug: q.get('dbg') || undefined });
};
await look.ready;
window.render(0);
window.READY = true;
