// 页面约定（engine/render/page.mjs）：DUR / render(t) / READY，另挂 EV、TIMELINE、TEXTS 给事件导出与检查。
import { loadFonts } from '../../engine/overlay/text.js';
import { DUR, EV, TIMELINE } from './timeline.js';
import { setup, render, TEXTS } from './film.js';

await loadFonts([['BM Sans', '../../fonts/NotoSansSC-var.woff2', '100 900']]);
setup(document.getElementById('c'));
window.DUR = DUR;
window.EV = EV;
window.TIMELINE = TIMELINE;
window.TEXTS = TEXTS;
window.render = render;
render(0);
window.READY = true;
