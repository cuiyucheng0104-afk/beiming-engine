// 鲲·原版精修 自测页（?test=kun_refine）。背景、天空、光线、机位、描边合成全部与 lab/kun.js 相同（共用 lab/kun_bench.js），
// 只把鲲换成 src/kun_refine.js，便于横向对比。
// DUR = 4 秒，三个机位按时间分段（同 lab/kun.js）：0–1.5 大远景侧面 / 1.5–3.0 渡船甲板仰视 / 3.0–4.0 眼睛特写
// 可选参数（同 lab/kun.js）：&lod=0.3 &noink=1 &pass=1 &view=side|top|far|eye|under|reveal|hero|hero2|ferry &roll=-0.5 &look=1
// 本页另加：&nopine=1（不要小松）&nowhisk=1（不要龙须）&noclouds=1（不要祥云纹）&nowisps=1（不要飘带）
//           &ink=2（手绘感更强的描边：线宽按笔压起伏、偶尔断笔、墨色吸一点底色；默认 1 = 与 lab/kun.js 完全相同）
//           &post=look（改走正片的后期管线 src/look.js：ID 图描边（用鲲网格上的 userData.outlineVertex）+ Kuwahara + bloom + 调色 + 纸纹，
//                       验证换进正片的后期；天空图作为 scene.background）
//           &cam=x,y,z&at=x,y,z&fov=&sky=zoom,ox,oy（自由机位）&pitch=（鲲绕 Z 轴俯仰，弧度）
import * as THREE from 'three';
import { createKun } from '../src/kun_refine.js';
import { PALETTE, setToonGlobals } from '../src/toon_refine.js';
import { createLook } from '../src/look.js';
import { labRenderer, kunStats, keyLight, inkComposite, BASE_VIEWS, baseExtra, pickView, eyeCloseup, frameTimes, drawPasses } from './kun_bench.js';

const q = new URLSearchParams(location.search);
const POST = q.get('post') === 'look';
const ROLL = +(q.get('roll') || 0), LOOK = !!q.get('look');
const { renderer, W, H, RW, RH } = labRenderer(POST ? 1 : 2);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, W / H, 5, 6000);
const t0 = performance.now();
// 看镜头时胸鳍按 YXZ 合成（与 kun.js 在正片镜头 C 里相同，finEulerOrder）
const kun = createKun({ lod: +(q.get('lod') || 1), pine: !q.get('nopine'), whiskers: !q.get('nowhisk'), clouds: !q.get('noclouds'), wisps: !q.get('nowisps'),
  finEulerOrder: LOOK ? 'YXZ' : 'XYZ' });
console.warn(`[kun_refine] 构建 ${(performance.now() - t0).toFixed(0)} ms，描边网格 ${kun.outlineMeshes.length} 个`);
kunStats('kun_refine', kun);
scene.add(kun.group);

const { key } = keyLight(scene, setToonGlobals);
const { rtC, rtN, sky, comp, skyCover: coverComp } = await inkComposite({ RW, RH, W, H, PALETTE, q, ink2: q.get('ink') === '2' });
function skyCover(zoom, ox, oy) {
  const [sx, sy, offX, offY] = coverComp(zoom, ox, oy);
  if (POST) { skyBg.repeat.set(sx, sy); skyBg.offset.set(offX, offY); }
}
// 正片后期（&post=look）：天空图当 scene.background（同样 cover 裁切），交给 look.js
const skyBg = sky.clone(); skyBg.colorSpace = THREE.SRGBColorSpace; skyBg.needsUpdate = true;
const look = POST ? createLook(renderer, W, H, { ss: 2 }) : null;
if (POST) { scene.background = skyBg; await look.ready; }

const ev = new THREE.Vector3();
const EXTRA = {
  ...baseExtra(ev),
  // 镜头 C 渡船甲板机位（= BASE_VIEWS[1] 的固定版，取 k=0.33）
  ferry: { fov: 40, sky: [1.35, 0.5, 0.95], cam: k => [43, -300, -163], look: k => [112, -10, 10] },
  // 海报帧：从头前下方 3/4 仰看，头、金瞳、龙须在前，身体和松树往后退进霞光
  hero: { fov: 34, sky: [1.25, 0.42, 0.62], cam: k => [560, -190, -520], look: k => [70, 10, 0] },
  hero2: { fov: 28, sky: [1.15, 0.5, 0.5], cam: k => [430, -140, -700], look: k => [40, 20, 0] },
};
kun.group.rotation.x = ROLL;
kun.group.rotation.z = +(q.get('pitch') || 0);
kun.fitShadow(key, { size: 4096 });
// 自由机位（找海报帧用）：&cam=x,y,z&at=x,y,z&fov=36&sky=zoom,ox,oy
if (q.get('cam')) {
  const nums = k => q.get(k).split(',').map(Number);
  EXTRA.free = { fov: +(q.get('fov') || 36), sky: q.get('sky') ? nums('sky') : [1.3, 0.5, 0.6], cam: () => nums('cam'), look: () => nums('at') };
}
const forced = EXTRA[q.get('cam') ? 'free' : q.get('view')];

window.DUR = 4;
window.render = t => {
  const { v, k } = pickView(BASE_VIEWS, forced, t, window.DUR);
  const { fr, ts, inkT } = frameTimes(t);                   // 鲲：一拍三（8 fps）；墨线一拍二
  camera.fov = v.fov; camera.updateProjectionMatrix();
  kun.group.updateMatrixWorld(true); kun.eyeWorld(ev, -1);
  if (v.cam) { camera.position.set(...v.cam(k)); camera.lookAt(...v.look(k)); }
  else eyeCloseup(camera, kun, ev, k);
  kun.setPose(ts, LOOK ? { look: camera.position } : {});
  skyCover(...v.sky);
  if (POST) {                                                // 正片后期管线：墨线一拍二沸腾由 look.js 按 t 自己算
    setToonGlobals({ inkTime: inkT, pass: 0 });
    renderer.shadowMap.autoUpdate = true;
    look.render(scene, camera, { t: fr / 24 });
    return;
  }
  drawPasses({ renderer, scene, camera, comp, rtC, rtN, setToonGlobals, inkT });
};
const tw = performance.now();
window.render(0); window.render(1.6); window.render(3.2);
console.warn(`[kun_refine] 预热（含着色器编译）${(performance.now() - tw).toFixed(0)} ms`);
window.READY = true;
