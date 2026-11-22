// 北冥引擎 · 片段补丁没命中算构建失败（FX22）：engine/shade/patch.js 的补丁（inject / patchVertex / quantizeShadow）与 engine/look/compose.js 的
// 纸纹变体是按 three / 引擎着色器里的一段原文找位置的，原文变了就抛错。这个错不管从哪条路冒出来——置 READY 之前的未捕获异常、
// render(t) 抛错、被页面自己接住后只打到控制台——渲染器（page.mjs）都判成 failure.shader-error（退出码 1），这一帧不留图。
// --allow-gl-errors 不放行：它是调试时带着 GLSL 编译错误先出图用的；补丁没命中出的是「没打补丁的着色器」，画面错了却没有任何编译错误。
//
//   PATCH_MISS                        认补丁没命中的报错文字（patch.js / compose.js 的写法；两版实测见 engine/look/r187-look-regression.test.mjs）
//   patchMiss(text, where?) → RenderError | null   text 是页面的报错或控制台文字（可带堆栈），不是补丁没命中时返回 null；where 写在信息前面
import { RenderError } from './errors.mjs';

export const PATCH_MISS = /着色器锚点缺失|投影量化锚点缺失|软阴影采样锚点缺失|变体对不上了/;

export function patchMiss(text, where = '') {
  const line = String(text ?? '').split('\n').find(l => PATCH_MISS.test(l));
  if (!line) return null;
  return new RenderError('failure.shader-error', `${where}着色器补丁没命中（构建失败）：${line.replace(/^(Uncaught )?(\w*Error: )?/, '').slice(0, 300)}`, {
    hint: 'three 升级或改了着色器之后，补丁按原文找的那段片段没了：对照报错里的锚点改 engine/shade/patch.js（或报错点名的模块），再跑 node engine/look/r187-look-regression.mjs 复核两版；不能跳过，也不能用 --allow-gl-errors 放行',
  });
}
