// 北冥引擎 · 内置材质补丁：往 three（r170 / r187）的内置材质（MeshToonMaterial、MeshDepthMaterial…）里注入自定义着色器片段。
// 在传入的着色器原文中逐条校验锚点，缺失直接报错。同一组钩子共用一个程序缓存键。
// shortcut: activeAnchors 按当前未展开文本排除常规注释、条件指令及其续行、常量死分支与展开循环内的锚点，不递归展开其他 ShaderChunk；
//   不防页面对抗性改写 THREE.ShaderLib / ShaderChunk（如借外部 chunk 开关条件分支、在展开循环内撕裂条件/注释收尾，或用 #define 重命名已补丁函数）。
//   若需支持这类对抗性改写，须在 three 展开并完成预处理的着色器上核验补丁效果。
// 片段补丁没命中算构建失败（FX22）：这里抛的错（ShaderPatchError）在 material.onBeforeCompile 里同步冒出 renderer.compile / render；
// 构造时就把 { fn, anchor, message } 记进本模块闭包里的数组：页面把异常接住、把 console.error 静音都抹不掉，页面代码也没有写它的入口
// （不挂 globalThis，不导出写入函数）。渲染器（engine/render/page.mjs + lib/patch-check.mjs）每次 page.evaluate 交回之前、截完图之后用 inject.patchErrors() 读副本，
// 有记录就判 failure.shader-error：本模块每个实例求值时把自己的模块地址登记到渲染器开页面时放好的登记口上（见下面 register 那一行），
// 渲染器按地址 import 同一个实例来读；消息以 [BEIMING_SHADER_PATCH_ERROR] 开头（与 patch-check.mjs 的 PATCH_TAG 一致），
// 渲染器靠这个前缀认未捕获的异常与 console.error。
//
//   inject(src, anchor, code, mode, who)   在锚点后（'after'）/ 前（'before'）插入，或整段替换（'replace'）；who 用于报错。
//                                           按当前未展开文本排除常规注释、条件指令及其续行、常量死分支与展开循环内的锚点；仅在未知编译条件内出现也报错。#include 按 three 的行首规则认。
//                                           不防页面对抗性改写 THREE.ShaderLib / ShaderChunk（如借外部 chunk 开关条件分支、或在展开循环内撕裂条件/注释收尾），见文件头 shortcut:。
//                                           以前的 inject 插进去的文本（材质钩子、引擎自己的片段）里的也不算：接着上一次的结果再打补丁时，
//                                           锚点只在原来的着色器里找。生效的一处都没有、或者不止一处（分不出哪一处真的生效）都报错
//   inject.patchErrors() → [{ fn, anchor, message }]   本页至今记下的补丁错误（副本，只读、不可改写）；挂在 inject 上而不是新导出：
//                                           本模块的导出名单被 tests/engine/api-snapshot.json 钉着（stable）
//   strHash(s) / programKey(prefix, parts)  程序缓存键：前缀 | 各段源码拼起来的哈希
//   vec3Of(v) / colorOf(c)                  数组 / {x,y,z} / 实例 → 新的 THREE.Vector3；色值 → 新的 THREE.Color：
//                                           '#hex' / 0xhex / THREE.Color / [r, g, b]（sRGB 0..1，与 engine/look/params.js 的 toColor 同一约定）；
//                                           空值 = 白；别的类型直接报错（three 的 Color.set 遇到不认识的值会静默保持白色）
//   patchVertex(src, hooks, own, who)       顶点钩子 vertexPars / vertexMainStart / vertexNormal（改 objectNormal）/ vertexBegin（改 transformed）；
//                                           own = { head, begin, project } 是材质自己的声明与赋值，排在同位置的钩子前面；
//                                           给了 vertexNormal 而着色器里没有 #include <beginnormal_vertex> 也报错（不给这个钩子的不要求有它）
//   quantizeShadow(frag, lo, hi, who)       投影量化：getShadow / getPointShadow 的返回值过 smoothstep( lo, hi )（lo / hi 是 GLSL 表达式）；
//                                           投影块里这句返回不止一处（r170 两处、r187 五处），要全部换掉。只认对拍过的投影块原文
//                                           （three r170 / r187 发行包里的，按长度与摘要认）：这段文本有任何改动（哪怕只加一段注释）都报错，
//                                           重新对拍之后把新的摘要加进 SHADOW_CHUNKS；
//                                           r187 下顺带把 PCF 采样核换回 r170 PCFSoftShadowMap 的核（投影边缘两版一致）；
//                                           投影块既不是 r187 的写法、也没有 r170 自带的软阴影核时报错（不按没换核的样子出图）
//   hasVertexHooks(hooks)                   有没有会改形体的顶点钩子（vertexPars / vertexMainStart / vertexBegin）
//   makeDepthMaterial({ hooks, uniforms, defines, key, side, who })   带同样顶点形变的阴影深度材质，投影才跟形体对得上
//   bindPatched(mesh, mat, { castShadow, receiveShadow, outline, depth, id, weight, perInstance })
//                                           挂材质 + 投影（depth 是返回深度材质的函数，只在投影时挂）+ 描边元数据
//                                           userData：outline / outlineId / outlineWeight / outlinePerInstance / instanced
//   counter(start)                          自增编号：const next = counter(1); next() → 1, 2, 3…
import * as THREE from 'three';

// 对拍过的 three 版本（engine/shade/r187-toon-regression.mjs：r187 对 r170 金标准）；别的版本只告警，锚点不匹配时照样直接报错
const SUPPORTED_THREE_REVISIONS = new Set(['170', '187']), SUPPORTED = 'r' + [...SUPPORTED_THREE_REVISIONS].join(' / r');
if (!SUPPORTED_THREE_REVISIONS.has(THREE.REVISION)) console.warn(`engine/shade 只在 three ${SUPPORTED} 上对拍过，当前 r${THREE.REVISION}：锚点不匹配时会直接报错`);

const PATCH_TAG = '[BEIMING_SHADER_PATCH_ERROR]', fatalPatchErrors = [];   // 模块私有：只有下面的构造函数往里记
class ShaderPatchError extends Error {   // 不导出：别的模块按 name 认（engine/look/ids.js），要抛就调 inject（engine/look/compose.js）
  constructor(fn, who, anchor, text) {
    super(`${PATCH_TAG} ${who}：${text}`);
    this.name = 'ShaderPatchError';
    fatalPatchErrors.push(Object.freeze({ fn, anchor, message: this.message }));
  }
}

// 锚点在生效代码里的各处。照第一次出现的位置换不行：材质参数里一段注释先提到同一条 #include，补丁就整段写进注释里，
// 生效的那一条原样留着、画面错了却没有任何报错。所以 // 与 /* */ 注释里的不算（GLSL 没有字符串，注释按先后认；GLSL ES 3.00 先把
// 「反斜杠 + 换行」接起来再认注释，注释记号中间、行注释末尾夹着行续接的照它的规矩认）；
// #include 照 three 展开它的正则认（WebGLProgram.js 的 includePattern：顶着行首，前面只许空格 / 制表符，include 后可以不止一个空格）。
const COMMENT = /\/(?:\\(?:\r\n|[\r\n]))*\/(?:\\(?:\r\n|[\r\n])|[^\r\n])*|\/(?:\\(?:\r\n|[\r\n]))*\*[\s\S]*?(?:\*(?:\\(?:\r\n|[\r\n]))*\/|$)/g, literal = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 只算整数常量的 !、&&、|| 与括号；未知标识符与 defined 按 Kleene 三值（0 / 0.5 / 1）短路求值；
// 当前文本里被 #define 成非原子常量的标识符，或含未知运算符/残缺语法的表达式均按 NaN → MAYBE 处理。
const NEVER = 0, MAYBE = 1, ALWAYS = 2, INT_LITERAL = /^(?:0x[\da-f]+|0[0-7]*|[1-9]\d*)u?$/i, IDENT = /^[a-z_]\w*$/i;
function evalExpr(expr, nonAtomic, atomOnly = false) {
  const tokens = expr.match(/\w+|&&|\|\||\S/g) ?? [];
  let i = 0;
  function atom(depth) {
    if (depth > 64) return NaN;
    const t = tokens[i++];
    if (!t) return NaN;
    if (t === '(') { const v = or(depth + 1); return tokens[i++] === ')' ? v : NaN; }
    if (t === '!') return 1 - atom(depth + 1);
    if (INT_LITERAL.test(t)) return Number(!/^0(?:x0+|0*)u?$/i.test(t));
    if (t === 'defined' && !atomOnly) {
      const paren = tokens[i] === '(';
      if (paren) i++;
      const id = tokens[i++];
      return id && id !== 'defined' && IDENT.test(id) && (!paren || tokens[i++] === ')') ? 0.5 : NaN;
    }
    return !atomOnly && t !== 'defined' && IDENT.test(t) && !nonAtomic?.has(t) ? 0.5 : NaN;
  }
  function and(depth) {
    let v = atom(depth);
    while (tokens[i] === '&&') { i++; v = Math.min(v, atom(depth)); }
    return v;
  }
  function or(depth) {
    let v = and(depth);
    while (tokens[i] === '||') { i++; v = Math.max(v, and(depth)); }
    return v;
  }
  const v = atomOnly ? atom(0) : or(0);
  return i === tokens.length ? v : NaN;
}
const conditionOf = (expr, nonAtomic) => { const v = evalExpr(expr, nonAtomic); return Number.isNaN(v) ? MAYBE : v * ALWAYS; };

function preprocessorSpans(masked, dead, uncertain) {
  const stack = [], nonAtomic = new Set();
  let state = ALWAYS;
  for (const line of masked.matchAll(/(?:\\(?:\r\n|[\r\n])|[^\r\n])+/g)) {
    const logical = line[0].replace(/\\(?:\r\n|[\r\n])/g, '');
    const def = /^\s*#\s*define\s+(\w+)(\(?)(.*)/.exec(logical);
    if (state !== NEVER && def && (def[2] || Number.isNaN(evalExpr(def[3], null, true)))) nonAtomic.add(def[1]);
    const directive = /^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)/.exec(logical);
    if (!directive) {
      if (state !== ALWAYS) (state === NEVER ? dead : uncertain).push([line.index, line.index + line[0].length]);
      continue;
    }
    dead.push([line.index, line.index + line[0].length]);   // 条件指令的续行仍是指令的一部分。
    const [, op, rest] = directive;
    if (op === 'endif') { state = stack.pop()?.parent ?? ALWAYS; continue; }
    if (op === 'if' || op === 'ifdef' || op === 'ifndef') stack.push({ parent: state, remaining: state });
    const branch = stack.at(-1);
    if (!branch) continue;
    const condition = op === 'else' ? ALWAYS : op === 'if' || op === 'elif' ? conditionOf(rest, nonAtomic) : MAYBE;
    state = Math.min(branch.remaining, condition);
    branch.remaining = Math.min(branch.remaining, ALWAYS - condition);   // 只有此前所有分支都没选中，才可能进入后续分支
  }
}

function activeAnchors(src, anchor) {
  const inc = /^#include <([\w./]+)>$/.exec(anchor), dead = [];
  const masked = src.replace(COMMENT, (comment, start) => {
    dead.push([start, start + comment.length]);
    return ' '.repeat(comment.length);   // 注释整体是空白，内部换行不结束预处理指令；等宽遮盖保留原文偏移。
  });
  // three 先在原文里展开循环，再交给 GLSL 处理注释；循环头尾即使在两段注释里也会匹配。
  // 循环界限可能是 NUM_* 等计数。用前瞻从每个循环头起配，避免符号界限的匹配吞掉 three 会展开的数字循环头。
  for (const block of src.matchAll(/(?=(#pragma unroll_loop_start\s+for\s*\(\s*int\s+i\s*=\s*\w+\s*;\s*i\s*<\s*\w+\s*;\s*i\s*\+\+\s*\)\s*\{[\s\S]+?\}\s+#pragma unroll_loop_end))/g)) {
    dead.push([block.index, block.index + block[1].length]);
  }
  // 可见的 pragma（含不完整的循环）仍按保守规则排除，不把补丁放进展开区。
  for (const block of masked.matchAll(/#pragma\s+unroll_loop_start\b[\s\S]*?(?:#pragma\s+unroll_loop_end\b|$)/g)) {
    dead.push([block.index, block.index + block[0].length]);
  }
  const uncertain = [];
  preprocessorSpans(masked, dead, uncertain);
  const within = (spans, index) => spans.some(([a, b]) => a <= index && index < b);
  const re = inc ? new RegExp(`(?<=^[ \\t]*)#include +<${literal(inc[1])}>`, 'gm') : new RegExp(literal(anchor), 'g');
  return [...src.matchAll(re)].filter(m => !within(dead, m.index)).map(m => ({ index: m.index, hit: m[0], uncertain: within(uncertain, m.index) }));
}

// 以前的 inject 交出去的文本 → 里面哪些区间是补丁插进去的 [[起, 止), …]。接着它再打补丁时这些区间里不找锚点：材质钩子的文本是调用方给的，
// 里面写一条同样的 #include（放在死分支里），再用注释把原来那条盖住，补丁就整段落进死分支，画面错了却没有任何报错。
// 钩子文本里的注释记号照样参与上面的注释判定：它把原来的锚点盖住了（或者按文本看像是盖住了）就报缺失，不放行。
// shortcut: 只按文本认「上一次的结果」，留最近 64 份（一条补丁链十来份）；调用方在两次 inject 之间自己改过文本的，这一段记录就断了，退回只按注释认。
const INJECTED = new Map();
export function inject(src, anchor, code, mode = 'after', who = 'patch.js') {
  const mine = INJECTED.get(src) ?? [], hits = activeAnchors(src, anchor).filter(m => !mine.some(([a, b]) => m.index >= a && m.index < b)), name = `「${anchor.slice(0, 60)}」`, rev = `three r${THREE.REVISION}，本模块支持 ${SUPPORTED}`;
  if (!hits.length) throw new ShaderPatchError('inject', who, anchor, `着色器锚点缺失${name}（${rev}）`);
  if (hits.length > 1) throw new ShaderPatchError('inject', who, anchor, `着色器锚点不唯一${name}：生效代码里有 ${hits.length} 处，分不出补丁该打在哪一处（${rev}）`);
  const [{ index, hit, uncertain }] = hits;
  if (uncertain) throw new ShaderPatchError('inject', who, anchor, `无法确认着色器锚点${name}所在的条件分支生效（${rev}）`);
  // 在 at 处去掉 cut 个字符、放进 put
  const at = mode === 'after' ? index + hit.length : index, cut = mode === 'replace' ? hit.length : 0, put = mode === 'after' ? '\n' + code : mode === 'before' ? code + '\n' : code;
  const out = src.slice(0, at) + put + src.slice(at + cut);
  INJECTED.delete(out);
  INJECTED.set(out, [...mine.map(([a, b]) => a >= at ? [a + put.length - cut, b + put.length - cut] : [a, b]), [at, at + put.length]]);
  if (INJECTED.size > 64) INJECTED.delete(INJECTED.keys().next().value);
  return out;
}
Object.defineProperty(inject, 'patchErrors', { value: () => fatalPatchErrors.map(e => ({ ...e })) });   // 不可写、不可重配：页面换不掉这个出口
// 同一个文件换个地址导入（带 #片段、?参数、patch%2Ejs）浏览器就另起一个实例、各记各的，渲染器按请求地址找不全：每个实例求值时
// 把自己的模块地址登记到渲染器放好的登记口上（patch-check.mjs 的 patchSink），渲染器按这个地址 import 到的就是这个实例。
// 登记的是地址、不是读出口：页面自己塞一个函数冒充不了。没有登记口（Node、平时预览）就不登记
globalThis.__bmShadePatchSink?.register(import.meta.url);

export function strHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); }
export const programKey = (prefix, parts) => prefix + '|' + strHash(parts.join('§'));

export const vec3Of = v => v instanceof THREE.Vector3 ? v.clone() : Array.isArray(v) ? new THREE.Vector3(...v) : new THREE.Vector3(v.x, v.y, v.z);
export function colorOf(c) {
  if (c instanceof THREE.Color || c?.isColor) return new THREE.Color().copy(c);
  if (Array.isArray(c)) return new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
  if (c === undefined || c === null || typeof c === 'string' || typeof c === 'number') return new THREE.Color(c ?? 0xffffff);
  throw new TypeError(`颜色要写 '#hex' / 0xhex / THREE.Color / [r, g, b]（sRGB 0..1），收到 ${typeof c}：${String(c).slice(0, 40)}`);
}

export function patchVertex(src, h, own = {}, who) {
  let s = src;
  s = inject(s, '#include <common>', (own.head || '') + (h.vertexPars || ''), 'after', who);
  s = inject(s, 'void main() {', h.vertexMainStart || '', 'after', who);
  if (h.vertexNormal) s = inject(s, '#include <beginnormal_vertex>', h.vertexNormal, 'after', who);
  s = inject(s, '#include <begin_vertex>', (own.begin || '') + (h.vertexBegin || ''), 'after', who);
  if (own.project) s = inject(s, '#include <project_vertex>', own.project, 'after', who);
  return s;
}

const SHADOW_ANCHOR = 'return mix( 1.0, shadow, shadowIntensity );';
// 这句返回在投影块里不止一处，漏换一处画面就错、却没有任何编译错误。只认对拍过的投影块原文（three 发行包里的，按「长度:摘要」认），
// 别的一律报错：改过的文本里哪些返回还算数，按文本猜不准（注释顶替空格、宏给函数或 return 起别名、预处理死分支，都骗得过去）
const SHADOW_CHUNKS = new Set(['8884:222jt6.18wxyi2' /* r170 build */, '10168:mgthj5.3fkhhd' /* r187 build */, '12626:40cb13.7lwj9z' /* r187 src/（带注释，r187-toon-regression.test.mjs 用它核） */]);
const chunkKey = s => `${s.length}:${strHash(s)}.${strHash([...s].reverse().join(''))}`;   // 正反各算一遍，两个 32 位摘要
// r187 的 PCF 换成了硬件比较采样 + 按屏幕像素旋转的 Vogel 圆盘（投影边缘带屏幕空间抖动，量化后是毛边）；
// 这里换回 r170 PCFSoftShadowMap 的确定性 3 × 3 双线性核：取样点都落在纹素中心，线性过滤的硬件比较在那里等于单个纹素的 step
const PCF_VOGEL = /shadow = \(\s*texture\( shadowMap, vec3\( shadowCoord\.xy \+ vogelDiskSample\( 0, 5, phi \)[\s\S]*?\) \* 0\.2;/;
const PCF_SOFT_R170 = /* glsl */`{
					vec2 toonTx = vec2( 1.0 ) / shadowMapSize;
					vec2 toonF = fract( shadowCoord.xy * shadowMapSize + 0.5 );
					vec2 toonUv = shadowCoord.xy - toonF * toonTx;
					#define TOON_CMP( ox, oy ) texture( shadowMap, vec3( toonUv + vec2( ox, oy ) * toonTx, shadowCoord.z ) )
					shadow = ( TOON_CMP( 0.0, 0.0 ) + TOON_CMP( 1.0, 0.0 ) + TOON_CMP( 0.0, 1.0 ) + TOON_CMP( 1.0, 1.0 )
						+ mix( TOON_CMP( -1.0, 0.0 ), TOON_CMP( 2.0, 0.0 ), toonF.x ) + mix( TOON_CMP( -1.0, 1.0 ), TOON_CMP( 2.0, 1.0 ), toonF.x )
						+ mix( TOON_CMP( 0.0, -1.0 ), TOON_CMP( 0.0, 2.0 ), toonF.y ) + mix( TOON_CMP( 1.0, -1.0 ), TOON_CMP( 1.0, 2.0 ), toonF.y )
						+ mix( mix( TOON_CMP( -1.0, -1.0 ), TOON_CMP( 2.0, -1.0 ), toonF.x ), mix( TOON_CMP( -1.0, 2.0 ), TOON_CMP( 2.0, 2.0 ), toonF.x ), toonF.y ) ) * ( 1.0 / 9.0 );
				}`;
export function quantizeShadow(frag, lo, hi, who = 'patch.js') {
  let sm = THREE.ShaderChunk.shadowmap_pars_fragment;
  // 投影块整个没了（three 升级拿掉了）或者不是原生字符串：下面的 includes / replaceAll 要么抛 TypeError（不记进补丁错误记录，页面接住就放行），要么能被改写
  if (typeof sm !== 'string') throw new ShaderPatchError('quantizeShadow', who, SHADOW_ANCHOR, `投影量化锚点缺失（three r${THREE.REVISION}）：投影块 shadowmap_pars_fragment 没了（THREE.ShaderChunk 里是 ${sm === null ? 'null' : typeof sm}）`);
  const key = chunkKey(sm);   // 下面换采样核之前的原文
  const noKernel = anchor => new ShaderPatchError('quantizeShadow', who, anchor, `软阴影采样锚点缺失（three r${THREE.REVISION}）：${anchor}`);
  if (sm.includes('sampler2DShadow shadowMap')) {   // r187 这一路；r170 的块里没有它，下面的替换与以前逐字相同
    if (!PCF_VOGEL.test(sm)) throw noKernel('vogelDiskSample( 0, 5, phi )');
    sm = sm.replace(PCF_VOGEL, () => PCF_SOFT_R170);
  } else if (!sm.includes('SHADOWMAP_TYPE_PCF_SOFT')) throw noKernel('SHADOWMAP_TYPE_PCF_SOFT');   // r170 这一路靠块里自带的软阴影核
  if (!SHADOW_CHUNKS.has(key)) throw new ShaderPatchError('quantizeShadow', who, SHADOW_ANCHOR,
    `投影量化锚点缺失（three r${THREE.REVISION}）：投影块 shadowmap_pars_fragment 不是对拍过的原文（three ${SUPPORTED} 发行包里的；现在这段是 ${key}）。先核对里面每个 getShadow / getPointShadow 都只以「${SHADOW_ANCHOR}」返回，重新对拍，再把它加进 engine/shade/patch.js 的 SHADOW_CHUNKS`);
  return inject(frag, '#include <shadowmap_pars_fragment>', sm.replaceAll(SHADOW_ANCHOR, `return mix( 1.0, smoothstep( ${lo}, ${hi}, shadow ), shadowIntensity );`), 'replace', who);
}

export const hasVertexHooks = h => !!(h.vertexPars || h.vertexBegin || h.vertexMainStart);

export function makeDepthMaterial({ hooks = {}, uniforms = {}, defines = {}, key = 'depth', side = THREE.FrontSide, who } = {}) {
  const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side });
  const k = programKey(key, [hooks.vertexPars, hooks.vertexMainStart, hooks.vertexBegin, JSON.stringify(defines)]);
  d.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, uniforms);
    Object.assign(sh.defines || (sh.defines = {}), defines);
    sh.vertexShader = patchVertex(sh.vertexShader, { ...hooks, vertexNormal: '' }, {}, who);
  };
  d.customProgramCacheKey = () => k;
  return d;
}

export function bindPatched(mesh, mat, { castShadow = true, receiveShadow = true, outline = true, depth = null, id, weight = 1, perInstance } = {}) {
  mesh.material = mat;
  if (depth && castShadow) mesh.customDepthMaterial = depth();
  mesh.castShadow = castShadow; mesh.receiveShadow = receiveShadow;
  mesh.userData.outline = outline;
  mesh.userData.outlineId = id;
  mesh.userData.outlineWeight = weight;
  mesh.userData.outlinePerInstance = perInstance ?? !!mesh.isInstancedMesh;
  mesh.userData.instanced = !!mesh.isInstancedMesh;
  return mesh;
}

export function counter(start = 1) { let n = start; return () => n++; }
