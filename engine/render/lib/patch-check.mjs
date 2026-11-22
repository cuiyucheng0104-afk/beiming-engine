// 北冥引擎 · 片段补丁没命中算构建失败（FX22）：engine/shade/patch.js 的补丁（inject / patchVertex / quantizeShadow）与 engine/look/compose.js 的
// 纸纹变体是按 three / 引擎着色器里的一段原文找位置的，原文变了就抛 ShaderPatchError。判失败只认一样东西：
//   patch.js 模块闭包里的记录。抛错的地方在构造错误时就记一条 { fn, anchor, message }，页面代码没有写它的入口（不在 globalThis 上，
//   也没有导出写入函数），页面把异常接住、把 console.error 静音、照常画回退帧都抹不掉；页面自己往哪个全局键上塞东西都不算。
//   读法：在页面里按模块地址 import 同一个模块实例，读它的 inject.patchErrors()（patchCheck，有记录就抛）。哪些地址算 patch.js 由渲染器这边定，
//   页面说了不算：
//   ① 页面实际请求过、路径以 /shade/patch.js 结尾的地址（isPatchModule；作品站把 engine/ 拷到别处、作品自带另一版 engine 副本也认得）；
//   ② 页面实际加载过、响应内容与引擎的 engine/shade/patch.js 原文逐字相同的脚本（路径认不出的写法：//patch.js、大小写不同、patch%2Ejs、
//     改了名的副本）。内容在渲染器这边比（watchPatchModules 听 response），页面的 CSP、改写 fetch 都碰不到。
//   ③ 登记口，只用来补 #片段。同一个地址带上不同的 #片段 导入，浏览器各起一个模块实例、各记各的，而请求地址里没有 #片段。所以开页面时先于
//     页面任何脚本放一个登记口 globalThis.__bmShadePatchSink（patchSink），patch.js 每个实例求值时把自己的模块地址（import.meta.url）登记进去：
//     登记过的删不掉、换不掉，取出来要这一页的随机口令（只有渲染器有）。谁都能调登记口，所以登记的东西不直接信：只收地址（塞函数的不收：
//     页面自造一个读出口，回空消息挡不住真记录、回合成消息也冒充不了），而且去掉 #片段 之后要是 ① ② 认下来的地址才读；页面登记一个自己没加载过的
//     地址，渲染器不去 import。patch.js 的地址换个 #片段 再登记一次，读到的只是一个没出过错的新实例。
//   ④ 登记的 blob: / data: 地址（渲染器这边收不到它们的响应）：登记时在页面里取它的内容（用放登记口那一刻取好的 fetch：页面事后改 fetch 没用），
//     与原文逐字相同才读，自造的报错模块不是原文。取不到内容的（页面用 CSP 挡住了 fetch、blob: 已经注销）核不了，照认：宁可错判失败，不放行。
//   没有登记口的页面（不是 watchPatchModules 开的）只有按资源加载记录找的 ① 。
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
// shortcut: 不防页面改写运行环境：内建原型（Array.prototype.push 之类，patch.js 自己记录也靠它）、静态方法与全局（Promise.allSettled、URL…）；要防得把记录与读法挪出页面的执行环境。
// shortcut: 不防页面用 import map 把某个 patch.js 地址改指到别的模块：同样的手法能把引擎的 patch.js 整个换成不抛错的，页面里怎么读都拦不住。
// shortcut: 作品自己在一个路径以 /shade/patch.js 结尾的地址上放一个模块并加载它，等于自称是引擎的 patch.js：它报的带机器前缀的记录照认（① 的口径，
//   为的是别的版本的 engine 副本记的错不漏）；页面先用 CSP 挡住 fetch、再往登记口塞一个自造的 blob: / data: 模块，也照认（④）。都是页面自己让构建失败，不会让该失败的放行。
//   改过的 patch.js 副本放在别的路径上（或装进 blob:）时都不认，它记的错读不到；真有作品这样用时把那一版的原文也拿来比。
//
//   PATCH_TAG                         与 engine/shade/patch.js 里的字面量一致（那是页面端模块，不从这里导入）
//   isPatchModule(url)                这个请求是不是 engine/shade/patch.js（按路径结尾认，作品站把 engine/ 拷到别处也认得）
//   patchSink({ secret, source })     在页面里执行（addInitScript）：放登记口 { register(模块地址), read(口令) → Promise<[{ url, genuine }]> }；source 是 patch.js 的原文，
//                                     genuine：blob: / data: 地址核下来的结果（④），别的地址是 null（由 ③ 按渲染器认下来的地址核）
//   watchPatchModules(page) → Promise 开页面时调（openFilm，要在 goto 之前等它）：放登记口、记下这一页加载过的 patch.js 地址（① ②），并给 page.evaluate 加守卫（见上）；
//                                     evaluate 自己失败时也先读，有记录抛 failure.shader-error（render(t) 抛的补丁错不归 render-throw），没有再抛原错
//   patchCheck(page, where?)          读记录，有一条就抛 failure.shader-error。没被 watchPatchModules 看着的页面（调用方自己开的）
//                                     改在页面里按资源加载记录找 patch.js 的地址，不跳过
//   readPatchErrors({ urls, re, secret }) → Promise<[{ fn, anchor, message }]>   在页面里执行（page.evaluate）：urls 是渲染器认下来的 patch.js 地址（不带 #片段），
//                                     null = 按 re 在 performance 的资源记录里找；secret 是这一页登记口的口令（没有登记口的不用给）
//   patchMiss(src, where?) → RenderError | null   src 是记录数组，或页面的报错文字（可带堆栈）；都只认带 PATCH_TAG 的（数组里不看排第几，有几条算几处）；where 写在信息前面
import { readFile } from 'node:fs/promises';
import { RenderError } from './errors.mjs';

export const PATCH_TAG = '[BEIMING_SHADER_PATCH_ERROR]';

const PATCH_MODULE = /^[^?#]*\/shade\/patch\.js([?#]|$)/, WATCHED = new WeakMap();   // page → { urls: 这一页加载过、认下来的 patch.js 地址, pending: 还在比正文的响应, evaluate: 没加守卫的 page.evaluate, secret: 登记口的口令 }
export const isPatchModule = url => PATCH_MODULE.test(String(url));

// 同一个地址再 import 一次拿到的是页面模块表里的同一个实例；加载失败的（404）页面自己也没加载成，不会有记录
// shortcut: urls 为 null 时靠 performance 的资源记录找模块，页面资源超过缓冲（默认 250 条）或自己清过记录就找不全；出片入口都走 watchPatchModules，自己开页面出片的调用方多起来时也改成先 watch。
export const readPatchErrors = async ({ urls, re, secret }) => {
  const found = urls ?? performance.getEntriesByType('resource').map(e => e.name).filter(n => new RegExp(re).test(n)), known = new Set(found);
  const more = (await globalThis.__bmShadePatchSink?.read(secret) ?? []).filter(r => r.genuine ?? known.has(r.url.split('#')[0])).map(r => r.url);   // 登记口只补 #片段，外加核过的 blob: / data:
  const mods = await Promise.allSettled([...new Set([...found, ...more])].map(u => import(u)));
  return [...new Set(mods.map(m => m.value?.inject?.patchErrors))].flatMap(read => read?.() ?? [])   // Set：两个地址落到同一个实例的只读一次
    .map(r => ({ fn: String(r.fn), anchor: String(r.anchor), message: String(r.message) }));
};

export function patchSink({ secret, source }) {
  const seen = new Map(), get = globalThis.fetch.bind(globalThis);   // 地址 → null，或 Promise<认不认>（blob: / data:：内容是不是 patch.js 的原文，取不到的照认）
  Object.defineProperty(globalThis, '__bmShadePatchSink', { value: Object.freeze({   // defineProperty 默认不可写、不可重配、不可枚举
    register(url) { if (typeof url === 'string' && !seen.has(url)) seen.set(url, /^(blob|data):/i.test(url) ? get(url).then(r => r.text()).then(text => text === source, () => true) : null); },
    read: async key => key === secret ? Promise.all([...seen].map(async ([url, genuine]) => ({ url, genuine: await genuine }))) : [],
  }) });
}

export async function watchPatchModules(page) {
  const urls = new Set(), pending = new Set(), evaluate = page.evaluate.bind(page), secret = crypto.randomUUID();
  WATCHED.set(page, { urls, pending, evaluate, secret });
  // 渲染器被单独拷走、旁边没有 engine/shade 时（测试里的最小仓库）读不到原文：只剩按路径认的那一路
  const source = await readFile(new URL('../../shade/patch.js', import.meta.url), 'utf8').catch(() => null), size = String(Buffer.byteLength(source ?? ''));
  await page.addInitScript(patchSink, { secret, source });
  page.on('request', r => { if (isPatchModule(r.url())) urls.add(r.url().split('#')[0]); });
  page.on('response', r => {
    const h = r.headers();
    // 只取脚本，长度对不上的不用取正文（压缩过的响应长度不算数，照取）
    if (source === null || r.request().resourceType() !== 'script' || (h['content-length'] && !h['content-encoding'] && h['content-length'] !== size)) return;
    const p = r.text().then(text => { if (text === source) urls.add(r.url().split('#')[0]); }, () => {}).finally(() => pending.delete(p));   // 页面已关之类取不到正文的：不认
    pending.add(p);
  });
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
  const { urls, pending, secret, evaluate = page.evaluate.bind(page) } = WATCHED.get(page) ?? {};   // 自己读用没加守卫的 evaluate
  if (pending) await Promise.all(pending);   // 还在比正文的响应先等完
  const miss = patchMiss(await evaluate(readPatchErrors, { urls: urls ? [...urls] : null, re: PATCH_MODULE.source, secret }), where);
  if (miss) throw miss;
}

export function patchMiss(src, where = '') {
  const hits = (Array.isArray(src) ? src.map(r => String(r?.message ?? r ?? '')) : String(src ?? '').split('\n')).filter(l => l.includes(PATCH_TAG)), line = hits[0];
  if (!line) return null;
  const more = Array.isArray(src) && hits.length > 1 ? `（共 ${hits.length} 处）` : '';
  return new RenderError('failure.shader-error', `${where}着色器补丁没命中（构建失败）：${line.replace(/^(Uncaught )?(\w*Error: )?/, '').replace(PATCH_TAG, '').trim().slice(0, 300)}${more}`, {
    hint: 'three 升级或改了着色器之后，补丁按原文找的那段片段没了：对照报错里的锚点改 engine/shade/patch.js（或报错点名的模块），再跑 node engine/look/r187-look-regression.mjs 复核两版；不能跳过，也不能用 --allow-gl-errors 放行',
  });
}
