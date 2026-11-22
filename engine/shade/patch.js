// 北冥引擎 · 内置材质补丁：往 three（r170 / r187）的内置材质（MeshToonMaterial、MeshDepthMaterial…）里注入自定义着色器片段。
// 锚点逐条校验，缺失直接报错（three 升级后不会悄悄失效）；同一组钩子共用一个程序缓存键。
// 片段补丁没命中算构建失败（FX22）：这里抛的错（ShaderPatchError）在 material.onBeforeCompile 里同步冒出 renderer.compile / render；
// 构造时就把 { fn, anchor, message } 记进 globalThis[Symbol.for('beiming.shaderPatchErrors')]，页面把异常接住也抹不掉这条记录，
// 渲染器（engine/render/page.mjs + lib/patch-check.mjs）每帧读它、判 failure.shader-error；消息以 [BEIMING_SHADER_PATCH_ERROR] 开头，
// 渲染器靠这个前缀认未捕获的异常与 console.error。这两个字面量要与 patch-check.mjs 的 PATCH_ERRORS_KEY / PATCH_TAG 一致。
//
//   inject(src, anchor, code, mode, who)   在锚点后（'after'）/ 前（'before'）插入，或整段替换（'replace'）；who 用于报错
//   strHash(s) / programKey(prefix, parts)  程序缓存键：前缀 | 各段源码拼起来的哈希
//   vec3Of(v) / colorOf(c)                  数组 / {x,y,z} / 实例 → 新的 THREE.Vector3；色值 → 新的 THREE.Color：
//                                           '#hex' / 0xhex / THREE.Color / [r, g, b]（sRGB 0..1，与 engine/look/params.js 的 toColor 同一约定）；
//                                           空值 = 白；别的类型直接报错（three 的 Color.set 遇到不认识的值会静默保持白色）
//   patchVertex(src, hooks, own, who)       顶点钩子 vertexPars / vertexMainStart / vertexNormal（改 objectNormal）/ vertexBegin（改 transformed）；
//                                           own = { head, begin, project } 是材质自己的声明与赋值，排在同位置的钩子前面；
//                                           给了 vertexNormal 而着色器里没有 #include <beginnormal_vertex> 也报错（不给这个钩子的不要求有它）
//   quantizeShadow(frag, lo, hi, who)       投影量化：getShadow / getPointShadow 的返回值过 smoothstep( lo, hi )（lo / hi 是 GLSL 表达式）；
//                                           投影块里这句返回不止一处（r170 两处、r187 五处），要全部换掉：有一处对不上原文就报错，不靠别处还在放行；
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

const PATCH_ERRORS = Symbol.for('beiming.shaderPatchErrors'), PATCH_TAG = '[BEIMING_SHADER_PATCH_ERROR]';
class ShaderPatchError extends Error {   // 不导出：别的模块按 name 认（engine/look/ids.js）
  constructor(fn, who, anchor, text) {
    super(`${PATCH_TAG} ${who}：${text}`);
    this.name = 'ShaderPatchError';
    (globalThis[PATCH_ERRORS] ??= []).push({ fn, anchor, message: this.message });
  }
}

export function inject(src, anchor, code, mode = 'after', who = 'patch.js') {
  if (!src.includes(anchor)) throw new ShaderPatchError('inject', who, anchor, `着色器锚点缺失「${anchor.slice(0, 60)}」（three r${THREE.REVISION}，本模块支持 ${SUPPORTED}）`);
  const rep = mode === 'after' ? anchor + '\n' + code : mode === 'before' ? code + '\n' + anchor : code;
  return src.replace(anchor, () => rep);
}

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
// 这句返回在投影块里不止一处：收 shadowIntensity 的函数有几个、提到 shadowIntensity 的 return 有几句，原文一字不差的锚点就得有几处
const SHADOW_FN = /\bfloat\s+get\w*Shadow\s*\([^)]*\bfloat\s+shadowIntensity\b/g, SHADOW_RETURN = /\breturn\b[^;]*\bshadowIntensity\b[^;]*;/g;
const count = (s, re) => (s.match(re) || []).length;
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
  const hits = sm.split(SHADOW_ANCHOR).length - 1, fns = count(sm, SHADOW_FN), returns = count(sm, SHADOW_RETURN);
  if (!hits || hits !== fns || hits !== returns) throw new ShaderPatchError('quantizeShadow', who, SHADOW_ANCHOR,
    `投影量化锚点缺失（three r${THREE.REVISION}）：${SHADOW_ANCHOR}（投影块里收 shadowIntensity 的函数 ${fns} 个、带 shadowIntensity 的返回 ${returns} 句，原文对得上的只有 ${hits} 处）`);
  const noKernel = anchor => new ShaderPatchError('quantizeShadow', who, anchor, `软阴影采样锚点缺失（three r${THREE.REVISION}）：${anchor}`);
  if (sm.includes('sampler2DShadow shadowMap')) {   // r187 这一路；r170 的块里没有它，下面的替换与以前逐字相同
    if (!PCF_VOGEL.test(sm)) throw noKernel('vogelDiskSample( 0, 5, phi )');
    sm = sm.replace(PCF_VOGEL, () => PCF_SOFT_R170);
  } else if (!sm.includes('SHADOWMAP_TYPE_PCF_SOFT')) throw noKernel('SHADOWMAP_TYPE_PCF_SOFT');   // r170 这一路靠块里自带的软阴影核
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
