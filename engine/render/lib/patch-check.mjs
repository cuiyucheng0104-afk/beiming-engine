// 北冥引擎 · 片段补丁没命中算构建失败（FX22）：engine/shade/patch.js 的补丁（inject / patchVertex / quantizeShadow）与 engine/look/compose.js 的
// 纸纹变体是按 three / 引擎着色器里的一段原文找位置的，原文变了就抛 ShaderPatchError。渲染器（page.mjs）只认两样东西，别的文字一概不认
// （作品自己的日志里写了「变体对不上了」之类的话，不算）：
//   ① 结构化记录：抛错的地方在构造错误时就往页面的 globalThis[Symbol.for(PATCH_ERRORS_KEY)] 里记一条 { fn, anchor, message }。
//      page.mjs 在置 READY 之后、每帧 render 之后、收尾时各读一次，非空就判失败——页面把异常接住、什么都不打、照常画回退帧也一样。
//      patchWatch 在页面脚本之前把这张表换成只能追加的，页面脚本清不掉已经记下的；每记一条同时照 ② 的写法打一行 console.error，
//      不经 renderFrame 的出片路径（lib/yuv.mjs 的 GPU 直出 / 超采样，帧末只调 film.check()）靠它当场判失败。
//   ② 机器前缀：错误信息以 PATCH_TAG 开头。未捕获的异常（pageerror）、render(t) 抛的错、console.error 里带这个前缀的，当场判失败。
// 都判 failure.shader-error（退出码 1），这一帧不留图。--allow-gl-errors 不放行：它是调试时带着 GLSL 编译错误先出图用的；
// 补丁没命中出的是「没打补丁的着色器」，画面错了却没有任何编译错误。
//
//   PATCH_TAG / PATCH_ERRORS_KEY      与 engine/shade/patch.js、engine/look/compose.js 里的字面量一致（那两个是页面端模块，不从这里导入）
//   patchWatch({ key, tag })          注入页面（page.addInitScript）：只能追加的记录表，每追加一条打一行带前缀的 console.error
//   readPatchErrors(key) → [{ fn, anchor, message }]   在页面里执行（page.evaluate）：读出记录
//   patchMiss(src, where?) → RenderError | null   src 是记录数组（非空就算），或页面的报错 / 控制台文字（可带堆栈，要有 PATCH_TAG）；where 写在信息前面
import { RenderError } from './errors.mjs';

export const PATCH_TAG = '[BEIMING_SHADER_PATCH_ERROR]';
export const PATCH_ERRORS_KEY = 'beiming.shaderPatchErrors';

export function patchWatch({ key, tag }) {
  const sym = Symbol.for(key), kept = [], text = v => String(v ?? '').slice(0, 600);
  if (Object.getOwnPropertyDescriptor(globalThis, sym)) return;
  Object.defineProperty(globalThis, sym, { configurable: false, enumerable: false, get() {   // 每次给一份副本：改它、清它都动不到 kept
    const view = kept.slice();
    view.push = (...recs) => {
      for (const r of recs) {
        const rec = Object.freeze({ fn: text(r?.fn), anchor: text(r?.anchor), message: text(r?.message ?? r) });
        kept.push(rec); console.error(rec.message.includes(tag) ? rec.message : `${tag} ${rec.message}`);
      }
      return kept.length;
    };
    return view;
  } });
}

export const readPatchErrors = key => Array.from(globalThis[Symbol.for(key)] ?? [], r => ({ fn: String(r?.fn ?? ''), anchor: String(r?.anchor ?? ''), message: String(r?.message ?? r) }));

export function patchMiss(src, where = '') {
  const line = Array.isArray(src) ? src[0] && String(src[0].message ?? src[0]) : String(src ?? '').split('\n').find(l => l.includes(PATCH_TAG));
  if (!line) return null;
  const more = Array.isArray(src) && src.length > 1 ? `（共 ${src.length} 处）` : '';
  return new RenderError('failure.shader-error', `${where}着色器补丁没命中（构建失败）：${line.replace(/^(Uncaught )?(\w*Error: )?/, '').replace(PATCH_TAG, '').trim().slice(0, 300)}${more}`, {
    hint: 'three 升级或改了着色器之后，补丁按原文找的那段片段没了：对照报错里的锚点改 engine/shade/patch.js（或报错点名的模块），再跑 node engine/look/r187-look-regression.mjs 复核两版；不能跳过，也不能用 --allow-gl-errors 放行',
  });
}
