// 帧渲染走北冥 render(t) 契约，浏览器预览的播放时钟只负责选帧。
import * as THREE from 'three';
import { pageTiming } from '../../engine/production/timeline.js';
import { buildRain } from './shots/rain.js';

const response = await fetch('./film.json');
if (!response.ok) throw new Error('雨落成纹的 film.json 加载失败');
const timing = pageTiming(await response.json());
const { fps, frameCount, DUR, shots, events } = timing;
if (window.__RENDER?.fps != null && window.__RENDER.fps !== fps) {
  throw new Error('渲染帧率与 film.json 不一致');
}

const stage = document.querySelector('#stage');
const renderer = new THREE.WebGLRenderer({ antialias: false });
stage.prepend(renderer.domElement);
const rain = buildRain(renderer, timing);
function resize() {
  const w = window.__RENDER?.width ?? Math.round(stage.clientWidth * Math.min(2, devicePixelRatio));
  const h = window.__RENDER?.height ?? Math.round(stage.clientHeight * Math.min(2, devicePixelRatio));
  renderer.setSize(w, h, false);
  rain.resize(w, h);
}

Object.assign(window, {
  DUR, FPS: fps, TIMELINE: { shots, events }, BEIMING_CONTRACT: 1,
  render(t) { rain.draw(timing.frameOf(t)); },
});

const spec = document.querySelector('#spec');
spec.textContent = `${fps} fps · ${DUR} 秒`;
resize();
// 预热时保持空白。渲染器随后只调用所请求的帧。
window.READY = true;

if (!window.__RENDER) {
  const play = document.querySelector('#play');
  const seek = document.querySelector('#seek');
  const counter = document.querySelector('#counter');
  document.querySelector('#controls').hidden = false;
  spec.hidden = true;
  seek.max = frameCount - 1;
  let playing = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  let frame = 0;
  let start;
  const show = f => {
    frame = f;
    seek.value = f;
    counter.value = `${f + 1}/${frameCount}`;
    window.render(f / fps);
  };
  let pending;
  function setPlaying(value) {
    cancelAnimationFrame(pending);
    playing = value;
    play.textContent = value ? '暂停' : '播放';
    start = undefined;
    if (playing) pending = requestAnimationFrame(tick);
  }
  function tick(now) {
    if (!playing) return;
    start ??= now - frame * 1000 / fps;
    const next = Math.floor((now - start) * fps / 1000) % frameCount;
    if (next !== frame) show(next);
    pending = requestAnimationFrame(tick);
  }
  play.addEventListener('click', () => setPlaying(!playing));
  seek.addEventListener('input', () => {
    setPlaying(false);
    show(Number(seek.value));
  });
  new ResizeObserver(() => { resize(); show(frame); }).observe(stage);
  show(0);
  setPlaying(playing);
}
