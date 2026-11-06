// 入口分发：无参数加载正片 src/main.js；?test=<名字> 加载 lab/<名字>.js（各模块自测页）。
// 被加载的模块负责设置 window.DUR、window.render(t)、window.READY（北冥引擎页面约定，见 engine/render/page.mjs）。
const p = new URLSearchParams(location.search);
const name = p.get('test');
await import(p.has('trailer') ? './trailer-reference.js' : name ? `../lab/${name}.js` : './film.js');
