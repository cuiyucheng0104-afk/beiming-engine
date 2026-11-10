// 页面约定（engine/render/page.mjs）：window.DUR / render(t) / READY，window.FPS（film.json 的 fps）；另挂 EV、TIMELINE、TEXTS 给事件导出与检查。
// 字体缺字时不静默：控制台报 [字体缺字]（渲染日志里能看到），window.FONT_REPORT 记下缺的字，TEXTS 每条也带 missing。
import { loadFonts } from '../../engine/overlay/text.js';
import { FPS, DUR, TIMELINE, buildEvents } from './timeline.js';
import { setup, render, TEXTS, scene, FONTS, TITLE, SEAL_TEXT } from './film.js';
import { loadProbes } from './type.js';

await loadFonts(FONTS);
await loadProbes(FONTS);        // 缺字检查用的探针字体（type.js）
const report = setup(document.getElementById('c'));
for (const [role, text] of [['title', TITLE], ['seal', SEAL_TEXT]]) {
  const r = report.fonts[role];
  if (r.missing.length) {
    console.error(`[字体缺字] ${role === 'title' ? '片名' : '印文'}「${text}」里的 ${r.missing.map(c => `「${c}」`).join('')} 不在字体 ${r.family} 里，`
      + '会回落到系统字体（换机器字形就变）：做一份含这些字的 OFL 字体子集放进作品目录，并加到 film.js 的 FONTS 最前面；或换字。');
  }
}
window.FONT_REPORT = report;
window.FPS = FPS;          // 页面按这个帧率量化一拍二；渲染器默认按它出片，--fps 与它不一致会直接报错
window.DUR = DUR;
window.EV = buildEvents(scene());
window.TIMELINE = TIMELINE;
window.TEXTS = TEXTS;
window.render = render;
render(0);
window.READY = true;
