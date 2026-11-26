// 通过北冥页面契约选择整数帧。只有交互预览读取播放时钟。
import * as THREE from 'three';
import { pageTiming } from '../../engine/production/timeline.js';
import { createFullscreen } from '../../engine/look/pass.js';
import { buildMaterials } from './shots/materials.js';
import { buildSite } from './shots/site.js';
import { buildGeometry } from './shots/geometry.js';

const [timing, cases] = await Promise.all([
  fetch('./film.json').then(response => response.json()).then(pageTiming),
  fetch('./shots/cases.json').then(response => response.json()).then(rows => rows.map(
    ([id,title,effect,baseline,variant]) => ({ id,title,effect,baseline,variant }),
  )),
]);
if (window.__RENDER?.fps != null && window.__RENDER.fps !== timing.fps) throw new Error('渲染帧率不一致');
const stage = document.querySelector('main');
const renderer = new THREE.WebGLRenderer({ antialias: false });
stage.prepend(renderer.domElement);
const fx = createFullscreen(renderer);
const materials = buildMaterials(fx);
const site = buildSite(), geometry = buildGeometry(renderer);
const view = fx.material(`
varying vec2 vUv;
uniform sampler2D leftImage, rightImage;
uniform bool linearLight;
void main(){
  vec2 uv = (vUv - vec2(vUv.x < .5 ? .04 : .51, .143)) / vec2(.45,.633);
  vec3 c = vec3(.051,.082,.106);
  if(all(greaterThanEqual(uv,vec2(0.))) && all(lessThanEqual(uv,vec2(1.)))) {
    c = vUv.x < .5 ? texture2D(leftImage,uv).rgb : texture2D(rightImage,uv).rgb;
  }
  if(linearLight && all(greaterThanEqual(uv,vec2(0.))) && all(lessThanEqual(uv,vec2(1.)))) {
    c = sRGBTransferOETF(vec4(c,1.)).rgb;
  }
  gl_FragColor = vec4(c,1.);
}
`, {leftImage:{value:null},rightImage:{value:null},linearLight:{value:false}});
if (cases.length !== timing.shots.length || cases.some((item,index) => item.id !== timing.shots[index].id)) {
  throw Error('对照项目与镜头表不同步');
}
const selected = new URLSearchParams(location.search).get('case');
function resize() {
  const w = window.__RENDER?.width ?? Math.round(stage.clientWidth * Math.min(2, devicePixelRatio));
  const h = window.__RENDER?.height ?? Math.round(stage.clientHeight * Math.min(2, devicePixelRatio));
  renderer.setSize(w, h, false);
  materials.resize(Math.round(w*.45),Math.round(h*.633));
  geometry.resize(Math.round(w*.45),Math.round(h*.633));
}
const title = document.querySelector('#title'), note = document.querySelector('#note');
const variant = document.querySelector('.label:last-of-type');
function draw(t) {
  const { index, localFrame } = timing.at(t);
  const item = cases[index];
  const phase = (localFrame+.5) / (timing.shots[index].out - timing.shots[index].in);
  title.textContent = item.title;
  variant.textContent = item.effect.startsWith('use') ? 'B　北冥 + use-shader-fx' : 'B　北冥 + 借鉴功能';
  note.textContent = `左：${item.baseline} · 右：${item.variant}`;
  const [left, right] = item.effect === 'site' ? site(item.id,phase) : item.effect === 'geometry'
    ? geometry.draw(item.id,phase,item.id==='video-plane' ? materials.plate(phase) : null)
    : materials.draw(item,phase);
  view.uniforms.linearLight.value = item.effect === 'site' || item.effect === 'geometry';
  view.uniforms.leftImage.value = left;
  view.uniforms.rightImage.value = right;
  fx.draw(view,null);
}
resize();
Object.assign(window, { DUR: timing.DUR, FPS: timing.fps, TIMELINE: timing, render: draw, READY: true });
if (!window.__RENDER) {
  const play = document.querySelector('#toggle'), slider = document.querySelector('#scrub');
  document.querySelector('nav').hidden = false;
  slider.max = timing.frameCount - 1;
  let active = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  let frame = 0, request, start;
  function show(value) { frame = value; slider.value = value; draw(value / timing.fps); }
  function tick(now) {
    start ??= now - frame * 1000 / timing.fps;
    const next = Math.floor((now - start) * timing.fps / 1000) % timing.frameCount;
    if (next !== frame) show(next);
    request = requestAnimationFrame(tick);
  }
  function setPlaying(value) {
    cancelAnimationFrame(request);
    active = value;
    start = undefined;
    play.textContent = active ? '暂停' : '播放';
    if (active) request = requestAnimationFrame(tick);
  }
  play.onclick = () => setPlaying(!active);
  slider.oninput = () => { setPlaying(false); show(Number(slider.value)); };
  new ResizeObserver(() => { resize(); show(frame); }).observe(stage);
  const initial = cases.findIndex(item => item.id === selected);
  show(initial < 0 ? 0 : timing.shots[initial].in);
  setPlaying(active && initial < 0);
}
