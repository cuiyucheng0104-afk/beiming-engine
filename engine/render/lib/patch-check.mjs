// 北冥引擎 · 片段补丁没命中算构建失败（FX22）：engine/shade/patch.js 的补丁（inject / patchVertex / quantizeShadow）与 engine/look/compose.js 的
// 纸纹变体是按 three / 引擎着色器里的一段原文找位置的，原文变了就抛 ShaderPatchError。判失败只认一样东西：
//   patch.js 模块闭包里的记录。抛错的地方在构造错误时就记一条 { fn, anchor, message }，页面代码没有写它的入口（不在 globalThis 上，
//   也没有导出写入函数），页面把异常接住、把 console.error 静音、照常画回退帧都抹不掉；页面自己往哪个全局键上塞东西都不算。
//   读法有两路，合起来读（patchCheck，非空就抛）：
//   ① 登记口。同一个 patch.js 换个地址导入（带 #片段、?参数、patch%2Ejs）浏览器就另起一个模块实例、各记各的，而请求地址里没有 #片段，
//     别名也认不全。所以开页面时先于页面任何脚本放一个登记口 globalThis.__bmShadePatchSink（patchSink），patch.js 每个实例求值时把
//     自己的读出口 inject.patchErrors 登记进去：登记过的删不掉、换不掉，取出来要这一页的随机口令（只有渲染器有）。
//     谁都能登记：页面自己登记一个报错的读出口，等于页面自己让这次构建失败（同它故意调 inject 找一个没有的锚点一样），不会让该失败的构建放行。
//   ② 按页面实际请求过的模块地址（isPatchModule）在页面里 import 同一个模块实例读它的 inject.patchErrors()；同一个读出口两路都有只读一次。
//     没有登记口的页面（不是 watchPatchModules 开的）只有这一路。
//   出帧都是经 page.evaluate 驱动 render(t) 的（page.mjs 的 renderFrame 与收尾、lib/yuv.mjs 的 GPU 直出 / 超采样、工具自己调的），
//   所以读法只装在一处：watchPatchModules 给这一页的 page.evaluate 加一道守卫，每次把结果交回调用方之前先读一遍，各出帧路径不用
//   各自记得调，以后新加的也漏不掉；page.mjs 另在置 READY 之后读一次（那之前没有 evaluate），capture 截完图再读一次（截图走 CDP、不经
//   evaluate：render(t) 返回之后才冒出来的错在这里拦）。没加载过 patch.js 的页面也读登记口
//   （每次 evaluate 多一个来回，登记口是空的），不 import、不多发请求。
// 机器前缀 PATCH_TAG 只用来给已经致命的错归类（未捕获的异常、render(t) 抛的错：failure.shader-error 而不是 page-error / render-throw）；
// console.error 里带前缀的只是线索，page.mjs 当场去读上面的记录，记录里没有就不判（页面自己打一行带前缀的字不算）。
// 都判 failure.shader-error（退出码 1），这一帧不留图。--allow-gl-errors 不放行：它是调试时带着 GLSL 编译错误先出图用的；
// 补丁没命中出的是「没打补丁的着色器」，画面错了却没有任何编译错误。
// shortcut: 只读主文档的模块实例，在 iframe / Worker 里加载的 patch.js 读不到；页面渲染器的出片页都在主文档里建材质，真有 iframe / Worker 出片时给它们加同样的读法。
// shortcut: 不防页面改写内建原型（Array.prototype.push 之类，patch.js 自己记录也靠它）；要防得把记录与读法挪出页面的执行环境。
//
//   PATCH_TAG                         与 engine/shade/patch.js 里的字面量一致（那是页面端模块，不从这里导入）
//   isPatchModule(url)                这个请求是不是 engine/shade/patch.js（按路径结尾认，作品站把 engine/ 拷到别处也认得）
//   patchSink(secret)                 在页面里执行（addInitScript）：放登记口 { register(读出口), read(口令) → 登记过的读出口 }
//   watchPatchModules(page) → Promise 开页面时调（openFilm，要在 goto 之前等它）：放登记口、记下这一页请求过的 patch.js 地址，并给 page.evaluate 加守卫（见上）；
//                                     evaluate 自己失败时也先读，有记录抛 failure.shader-error（render(t) 抛的补丁错不归 render-throw），没有再抛原错
//   patchCheck(page, where?)          读记录，有一条就抛 failure.shader-error。没被 watchPatchModules 看着的页面（调用方自己开的）
//                                     改在页面里按资源加载记录找 patch.js 的地址，不跳过
//   readPatchErrors({ urls, re, secret }) → Promise<[{ fn, anchor, message }]>   在页面里执行（page.evaluate）：urls 是页面请求过的 patch.js 地址，
//                                     null = 按 re 在 performance 的资源记录里找；secret 是这一页登记口的口令（没有登记口的不用给）
//   patchMiss(src, where?) → RenderError | null   src 是记录数组（非空就算），或页面的报错文字（可带堆栈，要有 PATCH_TAG）；where 写在信息前面
import { RenderError } from './errors.mjs';

export const PATCH_TAG = '[BEIMING_SHADER_PATCH_ERROR]';

const PATCH_MODULE = /^[^?#]*\/shade\/patch\.js([?#]|$)/, WATCHED = new WeakMap();   // page → { urls: 这一页请求过的 patch.js 地址, evaluate: 没加守卫的 page.evaluate }
export const isPatchModule = url => PATCH_MODULE.test(String(url));

// 同一个地址再 import 一次拿到的是页面模块表里的同一个实例；加载失败的（404）页面自己也没加载成，不会有记录
// shortcut: urls 为 null 时靠 performance 的资源记录找模块，页面资源超过缓冲（默认 250 条）或自己清过记录就找不全；出片入口都走 watchPatchModules，自己开页面出片的调用方多起来时也改成先 watch。
export const readPatchErrors = ({ urls, re, secret }) => Promise.allSettled((urls ?? [...new Set(performance.getEntriesByType('resource').map(e => e.name).filter(n => new RegExp(re).test(n)))]).map(u => import(u)))
  .then(mods => [...new Set([...mods.map(m => m.value?.inject?.patchErrors), ...(globalThis.__bmShadePatchSink?.read(secret) ?? [])])]   // 先 import 再读登记口：刚 import 出来的实例也登记了；Set 按读出口去重
    .flatMap(read => read?.() ?? []).map(r => ({ fn: String(r.fn), anchor: String(r.anchor), message: String(r.message) })));

export function patchSink(secret) {
  const readers = [];
  Object.defineProperty(globalThis, '__bmShadePatchSink', { value: Object.freeze({   // defineProperty 默认不可写、不可重配、不可枚举
    register(read) { if (typeof read === 'function') readers.push(read); },
    read: key => key === secret ? [...readers] : [],
  }) });
}

export async function watchPatchModules(page) {
  const urls = new Set(), evaluate = page.evaluate.bind(page), secret = crypto.randomUUID();
  WATCHED.set(page, { urls, evaluate, secret });
  await page.addInitScript(patchSink, secret);
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
  const { urls, secret, evaluate = page.evaluate.bind(page) } = WATCHED.get(page) ?? {};   // 自己读用没加守卫的 evaluate
  const miss = patchMiss(await evaluate(readPatchErrors, { urls: urls ? [...urls] : null, re: PATCH_MODULE.source, secret }), where);
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
