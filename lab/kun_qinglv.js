// 鲲 · 青绿仙山版自测页（?test=kun_qinglv）。背景、光、机位、描边合成与 lab/kun.js 相同（共用 lab/kun_bench.js），方便横向对比。
// DUR = 4 秒，三个机位按时间分段：
//   0.0–1.5  ① 大远景侧面全身   1.5–3.0  ② 从下方仰视（镜头 C 渡船甲板机位）   3.0–4.0  ③ 眼睛特写
// 可选参数：&lod=0.3 &noink=1 &pass=1 &roll=-0.5 &look=1
//   &view=side|top|far|eye|under|reveal（同 lab/kun.js）| hero（海报帧）| isle（仙岛近景）| front（迎面）| tail（尾鳍）
import * as THREE from 'three';
import { createKun } from '../src/kun_qinglv.js';
import { PALETTE, setToonGlobals } from '../src/toon.js';
import { labRenderer, kunStats, keyLight, inkComposite, BASE_VIEWS, baseExtra, pickView, eyeCloseup, frameTimes, drawPasses, lerpN } from './kun_bench.js';

const q = new URLSearchParams(location.search);
const ROLL = +(q.get('roll') || 0), LOOK = !!q.get('look');
const { renderer, W, H, RW, RH } = labRenderer(2);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, W / H, 5, 6000);
const t0 = performance.now();
const kun = createKun({ lod: +(q.get('lod') || 1) });
console.warn(`[kun_qinglv] 构建 ${(performance.now() - t0).toFixed(0)} ms，描边网格 ${kun.outlineMeshes.length} 个`);
kunStats('kun_qinglv', kun);
scene.add(kun.group);

const { key } = keyLight(scene, setToonGlobals);
const { rtC, rtN, comp, skyCover } = await inkComposite({ RW, RH, W, H, PALETTE, q });

const ev = new THREE.Vector3();
const EXTRA = {
  ...baseExtra(ev),
  // 海报帧：前下方 3/4 仰角，金眼、龙须、折扇胸鳍和背上的仙岛同框
  hero: { fov: 42, sky: [1.25, 0.3, 0.42], cam: k => [lerpN(372, 360, k), lerpN(68, 62, k), lerpN(-446, -434, k)], look: k => [10, 34, 0] },
  isle: { fov: 30, sky: [1.5, 0.5, 0.3], cam: k => [lerpN(150, 140, k), 120, -330], look: k => [-20, 92, -5] },
  front: { fov: 36, sky: [1.3, 0.45, 0.5], cam: k => [760, -60, -300], look: k => [60, 20, 0] },
  tail: { fov: 30, sky: [1.4, 0.75, 0.5], cam: k => [-330, -60, -420], look: k => [-230, 30, 0] },
};
kun.group.rotation.x = ROLL;
kun.fitShadow(key, { size: 4096 });
const forced = EXTRA[q.get('view')];

window.DUR = 4;
window.render = t => {
  const { v, k } = pickView(BASE_VIEWS, forced, t, window.DUR);
  const { ts, inkT } = frameTimes(t);                       // 鲲：一拍三（8 fps）；墨线、瀑布：一拍二
  camera.fov = v.fov; camera.updateProjectionMatrix();
  kun.group.updateMatrixWorld(true); kun.eyeWorld(ev, -1);
  if (v.cam) { camera.position.set(...v.cam(k)); camera.lookAt(...v.look(k)); }
  else eyeCloseup(camera, kun, ev, k);
  kun.setPose(ts, LOOK ? { look: camera.position } : {});
  skyCover(...v.sky);
  drawPasses({ renderer, scene, camera, comp, rtC, rtN, setToonGlobals, inkT });
};
const tw = performance.now();
window.render(0); window.render(1.6); window.render(3.2);
console.warn(`[kun_qinglv] 预热（含着色器编译）${(performance.now() - tw).toFixed(0)} ms`);
window.READY = true;
