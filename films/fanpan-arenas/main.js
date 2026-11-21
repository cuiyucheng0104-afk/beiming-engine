// 页面约定（engine/render/page.mjs）：window.DUR / render(t) / READY / FPS。无声，没有声画事件表；画面上的字都画在贴图里，不报 TEXTS。
// 时间只从 film.json 来：七个镜头各出一套场景，改切点用 node engine/production/film.js retime，不改这里。
import { pageTiming } from '/engine/production/timeline.js';
import { setup, render } from './stage.js';

const timing = pageTiming(await (await fetch('./film.json')).json());
await setup(document.getElementById('c'), timing);
window.FPS = timing.fps;
window.DUR = timing.DUR;
window.EV = [];
window.TEXTS = () => [];
window.render = render;
await render(0);
window.READY = true;
