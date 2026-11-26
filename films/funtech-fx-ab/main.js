// 通过北冥页面契约选择整数帧。只有交互预览读取播放时钟。
import * as THREE from 'three';
import { pageTiming } from '../../engine/production/timeline.js';
import { buildEffects } from './shots/effects.js';

const timing = pageTiming(await (await fetch('./film.json')).json());
if (window.__RENDER?.fps != null && window.__RENDER.fps !== timing.fps) throw new Error('渲染帧率不一致');
const stage = document.querySelector('main');
const renderer = new THREE.WebGLRenderer({ antialias: false });
stage.prepend(renderer.domElement);
const effects = buildEffects(renderer, timing);
function resize() {
  const w = window.__RENDER?.width ?? Math.round(stage.clientWidth * Math.min(2, devicePixelRatio));
  const h = window.__RENDER?.height ?? Math.round(stage.clientHeight * Math.min(2, devicePixelRatio));
  renderer.setSize(w, h, false);
  effects.resize(w, h);
}
const labels = [
  ['墨滴扩散', '相同落点与墨量 · 左侧解析墨晕，右侧染料对流'],
  ['烟尘拖尾', '相同烟源轨迹 · 左侧解析烟团，右侧速度场与涡卷'],
  ['粒子聚字', '相同种子与字形 · 左侧 CPU 插值，右侧 GPU 点着色'],
];
const title = document.querySelector('#title'), note = document.querySelector('#note');
function draw(t) {
  const { index, localFrame } = timing.at(t);
  title.textContent = labels[index][0];
  note.textContent = labels[index][1];
  effects.render(index, localFrame);
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
  show(0);
  setPlaying(active);
}
