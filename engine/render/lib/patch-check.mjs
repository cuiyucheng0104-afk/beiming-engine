// 北冥引擎 · 片段补丁没命中算构建失败（FX22）：engine/shade/patch.js 的补丁（inject / patchVertex / quantizeShadow）与 engine/look/compose.js 的
// 纸纹变体是按 three / 引擎着色器里的一段原文找位置的，原文变了就抛 ShaderPatchError。判失败只认一样东西：
//   patch.js 模块闭包里的记录。抛错的地方在构造错误时就记一条 { fn, anchor, message }，页面代码没有写它的入口（不在 globalThis 上，
//   也没有导出写入函数），页面把异常接住、把 console.error 静音、照常画回退帧都抹不掉；页面自己往哪个全局键上塞东西都不算。
//   渲染器按页面实际请求过的模块地址（isPatchModule）在页面里 import 同一个模块实例、读 inject.patchErrors()，非空就抛（patchCheck）。
//   出帧都是经 page.evaluate 驱动 render(t) 的（page.mjs 的 renderFrame 与收尾、lib/yuv.mjs 的 GPU 直出 / 超采样、工具自己调的），
//   所以读法只装在一处：watchPatchModules 给这一页的 page.evaluate 加一道守卫，每次把结果交回调用方之前先读一遍，各出帧路径不用
//   各自记得调，以后新加的也漏不掉；page.mjs 另在置 READY 之后读一次（那之前没有 evaluate）。没加载过 patch.js 的页面不读、不多发请求。
// 机器前缀 PATCH_TAG 只用来给已经致命的错归类（未捕获的异常、render(t) 抛的错：failure.shader-error 而不是 page-error / render-throw）；
// console.error 里带前缀的只是线索，page.mjs 当场去读上面的记录，记录里没有就不判（页面自己打一行带前缀的字不算）。
// 都判 failure.shader-error（退出码 1），这一帧不留图。--allow-gl-errors 不放行：它是调试时带着 GLSL 编译错误先出图用的；
// 补丁没命中出的是「没打补丁的着色器」，画面错了却没有任何编译错误。
// shortcut: 只读主文档的模块实例，在 Worker 里加载的 patch.js 读不到；页面渲染器的出片页都在主文档里建材质，真有 Worker 出片时给 Worker 加同样的读法。
//
//   PATCH_TAG                         与 engine/shade/patch.js 里的字面量一致（那是页面端模块，不从这里导入）
//   isPatchModule(url)                这个请求是不是 engine/shade/patch.js（按路径结尾认，作品站把 engine/ 拷到别处也认得）
//   watchPatchModules(page)           开页面时调（openFilm）：记下这一页请求过的 patch.js 地址，并给 page.evaluate 加守卫（见上）；
//                                     evaluate 自己失败时也先读，有记录抛 failure.shader-error（render(t) 抛的补丁错不归 render-throw），没有再抛原错
//   patchCheck(page, where?)          读记录，有一条就抛 failure.shader-error。没被 watchPatchModules 看着的页面（调用方自己开的）
//                                     改在页面里按资源加载记录找 patch.js 的地址，不跳过
//   readPatchErrors({ urls, re }) → Promise<[{ fn, anchor, message }]>   在页面里执行（page.evaluate）：urls 是页面请求过的 patch.js 地址，
//                                     null = 按 re 在 performance 的资源记录里找
//   patchMiss(src, where?) → RenderError | null   src 是记录数组（非空就算），或页面的报错文字（可带堆栈，要有 PATCH_TAG）；where 写在信息前面
import { RenderError } from './errors.mjs';

export const PATCH_TAG = '[BEIMING_SHADER_PATCH_ERROR]';

const PATCH_MODULE = /^[^?#]*\/shade\/patch\.js([?#]|$)/, WATCHED = new WeakMap();   // page → { urls: 这一页请求过的 patch.js 地址, evaluate: 没加守卫的 page.evaluate }
export const isPatchModule = url => PATCH_MODULE.test(String(url));

// 同一个地址再 import 一次拿到的是页面模块表里的同一个实例；加载失败的（404）页面自己也没加载成，不会有记录
// shortcut: urls 为 null 时靠 performance 的资源记录找模块，页面资源超过缓冲（默认 250 条）或自己清过记录就找不全；出片入口都走 watchPatchModules，自己开页面出片的调用方多起来时也改成先 watch。
export const readPatchErrors = ({ urls, re }) => Promise.allSettled((urls ?? [...new Set(performance.getEntriesByType('resource').map(e => e.name).filter(n => new RegExp(re).test(n)))]).map(u => import(u)))
  .then(mods => mods.flatMap(m => m.value?.inject?.patchErrors?.() ?? []).map(r => ({ fn: String(r.fn), anchor: String(r.anchor), message: String(r.message) })));

export function watchPatchModules(page) {
  const urls = new Set(), evaluate = page.evaluate.bind(page);
  WATCHED.set(page, { urls, evaluate });
  page.on('request', r => { if (isPatchModule(r.url())) urls.add(r.url()); });
  page.evaluate = async (...args) => {
    let out;
    try { out = await evaluate(...args); } catch (e) {
      await patchCheck(page).catch(miss => { if (miss instanceof RenderError) throw miss; });   // 页面已关之类读不了的：抛原来的错
      throw e;
    }
    await patchCheck(page);
    return out;
  };
}

export async function patchCheck(page, where = '') {
  const { urls, evaluate = page.evaluate.bind(page) } = WATCHED.get(page) ?? {};   // 自己读用没加守卫的 evaluate
  if (urls && !urls.size) return;   // 看着的页面没加载过 patch.js：不读
  const miss = patchMiss(await evaluate(readPatchErrors, { urls: urls ? [...urls] : null, re: PATCH_MODULE.source }), where);
  if (miss) throw miss;
}

export function patchMiss(src, where = '') {
  const line = Array.isArray(src) ? src[0] && String(src[0].message ?? src[0]) : String(src ?? '').split('\n').find(l => l.includes(PATCH_TAG));
  if (!line) return null;
  const more = Array.isArray(src) && src.length > 1 ? `（共 ${src.length} 处）` : '';
  return new RenderError('failure.shader-error', `${where}着色器补丁没命中（构建失败）：${line.replace(/^(Uncaught )?(\w*Error: )?/, '').replace(PATCH_TAG, '').trim().slice(0, 300)}${more}`, {
    hint: 'three 升级或改了着色器之后，补丁按原文找的那段片段没了：对照报错里的锚点改 engine/shade/patch.js（或报错点名的模块），再跑 node engine/look/r187-look-regression.mjs 复核两版；不能跳过，也不能用 --allow-gl-errors 放行',
  });
}
