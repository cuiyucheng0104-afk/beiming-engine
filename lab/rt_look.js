// 光追分层风格化自测页：?test=rt_look&dir=out/rt/kun&frame=0
// 读 dir 里一帧的分层图（颜色、深度、物体编号、法线 + meta.json），经 engine/look/layers.js 画成北冥画风。
// 可选参数：&view=color|ids|edge|toon|final（默认 final）  &split=1（左半原始光追、右半风格化）
//   &lw=3.2（线宽）  &bands=3（色阶档数）  &kr=3（Kuwahara 半径）  &ps=0.1（纸纹强度）  &dt=0.03&nt=0.5（折痕 / 法线阈值）  &t=0（墨线抖动时刻）
import * as THREE from 'three';
import { createLayerLook, loadLayers } from '../engine/look/layers.js';

const Q = new URLSearchParams(location.search);
const num = (k, d) => (Q.has(k) ? +Q.get(k) : d);
const layers = await loadLayers(Q.get('dir') || 'out/rt/kun', num('frame', 0));
const { width: W, height: H } = layers;

const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1); renderer.setSize(W, H, false);
renderer.domElement.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh';
document.body.appendChild(renderer.domElement);
const look = createLayerLook(renderer, W, H);

window.DUR = 1;
window.render = t => look.render(layers, {
  t: t + num('t', 0),
  view: Q.get('view') || 'final',
  split: Q.get('split') ? 0.5 : 0,
  outline: { width: num('lw', 2.4), depthThreshold: num('dt', 0.03), normalThreshold: num('nt', 0.5) },
  toon: { bands: num('bands', 3) },
  kuwahara: { radius: num('kr', 3) },
  paper: { strength: num('ps', 0.1) },
});
window.render(0);
window.READY = true;
