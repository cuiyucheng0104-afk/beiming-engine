// 北冥引擎 · 内置材质补丁：往 three r170 的内置材质（MeshToonMaterial、MeshDepthMaterial…）里注入自定义着色器片段。
// 锚点逐条校验，缺失直接报错（three 升级后不会悄悄失效）；同一组钩子共用一个程序缓存键。
//
//   inject(src, anchor, code, mode, who)   在锚点后（'after'）/ 前（'before'）插入，或整段替换（'replace'）；who 用于报错
//   strHash(s) / programKey(prefix, parts)  程序缓存键：前缀 | 各段源码拼起来的哈希
//   vec3Of(v) / colorOf(c)                  数组 / {x,y,z} / 实例 → 新的 THREE.Vector3；色值 → 新的 THREE.Color：
//                                           '#hex' / 0xhex / THREE.Color / [r, g, b]（sRGB 0..1，与 engine/look/params.js 的 toColor 同一约定）；
//                                           空值 = 白；别的类型直接报错（three 的 Color.set 遇到不认识的值会静默保持白色）
//   patchVertex(src, hooks, own, who)       顶点钩子 vertexPars / vertexMainStart / vertexNormal（改 objectNormal）/ vertexBegin（改 transformed）；
//                                           own = { head, begin, project } 是材质自己的声明与赋值，排在同位置的钩子前面
//   quantizeShadow(frag, lo, hi, who)       投影量化：getShadow 的返回值过 smoothstep( lo, hi )（lo / hi 是 GLSL 表达式）
//   hasVertexHooks(hooks)                   有没有会改形体的顶点钩子（vertexPars / vertexMainStart / vertexBegin）
//   makeDepthMaterial({ hooks, uniforms, defines, key, side, who })   带同样顶点形变的阴影深度材质，投影才跟形体对得上
//   bindPatched(mesh, mat, { castShadow, receiveShadow, outline, depth, id, weight, perInstance })
//                                           挂材质 + 投影（depth 是返回深度材质的函数，只在投影时挂）+ 描边元数据
//                                           userData：outline / outlineId / outlineWeight / outlinePerInstance / instanced
//   counter(start)                          自增编号：const next = counter(1); next() → 1, 2, 3…
import * as THREE from 'three';

if (THREE.REVISION !== '170') console.warn(`engine/shade 按 three r170 写，当前 r${THREE.REVISION}：锚点不匹配时会直接报错`);

export function inject(src, anchor, code, mode = 'after', who = 'patch.js') {
  if (!src.includes(anchor)) throw new Error(`${who}：着色器锚点缺失「${anchor.slice(0, 60)}」（three r${THREE.REVISION}，本模块按 r170 写）`);
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
  if (s.includes('#include <beginnormal_vertex>') && h.vertexNormal) s = inject(s, '#include <beginnormal_vertex>', h.vertexNormal, 'after', who);
  s = inject(s, '#include <begin_vertex>', (own.begin || '') + (h.vertexBegin || ''), 'after', who);
  if (own.project) s = inject(s, '#include <project_vertex>', own.project, 'after', who);
  return s;
}

const SHADOW_ANCHOR = 'return mix( 1.0, shadow, shadowIntensity );';
export function quantizeShadow(frag, lo, hi, who = 'patch.js') {
  const sm = THREE.ShaderChunk.shadowmap_pars_fragment;
  if (!sm.includes(SHADOW_ANCHOR)) throw new Error(`${who}：投影量化锚点缺失（three r${THREE.REVISION}）：${SHADOW_ANCHOR}`);
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
