// 页面约定（engine/render/page.mjs）：window.DUR / render(t) / READY / FPS。无声小样，没有声画事件表。
import { FPS } from './stage.js';
import { setup, render, DUR } from './film.js';

await setup(document.getElementById('c'));
window.FPS = FPS;
window.DUR = DUR;
window.EV = [];
window.TEXTS = () => [];
window.render = render;
render(0);
window.READY = true;
