// 鲲 + 卡通材质自测页（?test=kun）。DUR = 4 秒，三个机位按时间分段：
//   0.0–1.5  ① 大远景侧面全身（镜头 C 的朝向：头朝画左，逆光从画左后方来）
//   1.5–3.0  ② 从下方仰视腹部和头（镜头 C 那种渡船甲板机位）
//   3.0–4.0  ③ 眼睛特写
// 背景：assets/ref/sky_test.png（cover 铺满）。主光 = 破晓低角度逆光；城市暖光自下而上。
// 描边：这里临时写了一个屏幕空间描边（深度 + 法线 + 物体/实例 ID，按一拍二抖动），只为看效果；正片描边归后期代理。
// 渲染器、合成、机位表、三遍渲染在 lab/kun_bench.js（各变体页共用）。
// 可选参数：&lod=0.3（实例密度）&noink=1（关描边）&pass=1（看法线/ID 通道，左右条纹交替）
//   &view=side|top|far|eye|under|reveal（固定机位）&roll=-0.5（鲲侧倾，弧度）&look=1（眼珠看镜头）
import * as THREE from 'three';
import { createKun } from '../src/kun.js';
import { PALETTE, setToonGlobals } from '../src/toon.js';
import { labRenderer, kunStats, keyLight, inkComposite, BASE_VIEWS, baseExtra, pickView, eyeCloseup, frameTimes, drawPasses } from './kun_bench.js';

const q = new URLSearchParams(location.search);
// &roll=0.4：鲲绕身体长轴侧倾（弧度），让一侧肋部和背上的植被朝向镜头；&look=1：眼珠看向镜头
const ROLL = +(q.get('roll') || 0), LOOK = !!q.get('look');
const { renderer, W, H, RW, RH } = labRenderer(2);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, W / H, 5, 6000);
const t0 = performance.now();
// 看镜头时胸鳍按 YXZ 合成，与正片镜头 C 相同（kun.js 的 finEulerOrder）
const kun = createKun({ lod: +(q.get('lod') || 1), finEulerOrder: LOOK ? 'YXZ' : 'XYZ' });
console.warn(`[kun] 构建 ${(performance.now() - t0).toFixed(0)} ms，描边网格 ${kun.outlineMeshes.length} 个`);
kunStats('kun', kun);
scene.add(kun.group);

const { key } = keyLight(scene, setToonGlobals);
const { rtC, rtN, comp, skyCover } = await inkComposite({ RW, RH, W, H, PALETTE, q });

const ev = new THREE.Vector3();
const EXTRA = baseExtra(ev);
kun.group.rotation.x = ROLL;
kun.fitShadow(key, { size: 4096 });
const forced = EXTRA[q.get('view')];

window.DUR = 4;
window.render = t => {
  const { v, k } = pickView(BASE_VIEWS, forced, t, window.DUR);
  const { ts, inkT } = frameTimes(t);                       // 鲲：一拍三（8 fps）；墨线一拍二
  camera.fov = v.fov; camera.updateProjectionMatrix();
  kun.group.updateMatrixWorld(true); kun.eyeWorld(ev, -1);
  if (v.cam) { camera.position.set(...v.cam(k)); camera.lookAt(...v.look(k)); }
  else eyeCloseup(camera, kun, ev, k);                      // 眼睛特写：从眼睛外侧略偏下看
  kun.setPose(ts, LOOK ? { look: camera.position } : {});   // 相机就位后再摆姿态（眼珠要看相机）
  skyCover(...v.sky);
  drawPasses({ renderer, scene, camera, comp, rtC, rtN, setToonGlobals, inkT });
};
const tw = performance.now();
window.render(0); window.render(1.6); window.render(3.2);
console.warn(`[kun] 预热（含着色器编译）${(performance.now() - tw).toFixed(0)} ms`);
window.READY = true;
