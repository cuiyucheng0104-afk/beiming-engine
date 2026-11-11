// 镜头缓存测试片（tests/render/shots.test.mjs）：时间只来自 film.json（output.frameCount / fps、shots[].in / out），
// 三个镜头各在自己的模块里画（shots/s1.js … s3.js），共享的底色在 shared.js。
import { background } from './shared.js';
import * as s1 from './shots/s1.js';
import * as s2 from './shots/s2.js';
import * as s3 from './shots/s3.js';

const FILM = await (await fetch('./film.json')).json();
const { fps, frameCount, width, height } = FILM.output;
const modules = { S1: s1, S2: s2, S3: s3 };
const c = document.createElement('canvas');
c.width = width; c.height = height;
document.body.appendChild(c);
const g = c.getContext('2d');
window.DUR = frameCount / fps;
window.FPS = fps;
window.render = t => {
  const f = Math.min(frameCount - 1, Math.round(t * fps));
  const shot = FILM.shots.find(s => f >= s.in && f < s.out);
  background(g, width, height);
  modules[shot.id].draw(g, f - shot.in, shot.out - shot.in, width, height);
};
window.READY = true;
