/**
 * 项目记录与结果契约的最小实现（T01，P05 扩展）。
 *
 * 依据 docs/routes/contracts.md §2（ProjectSpec）与 §7（RenderResult / 失败语义）：
 * - 只做字段校验、路径解析和诊断，不读取或改写任何渲染器状态。
 * - 计划字段（runtime / output / execution）与实测字段严格分离；
 *   实测 GPU、编码器、哈希只能写进 RenderResult，不能塞进 ProjectSpec。
 * - 路线取自路线注册表（routes/routes.json，缺省用 engine/production/routes.js 的内置三条）：
 *   规范值 a / b / c；旧值 beiming（= a）、raea（= b）与目录名 a-webgl / b-native / c-style 都作别名接受。
 *   后端按路线校验：a 用 three；b 用 native（旧写法 raea）；c 用 canvas / svg / dom / three / webgl；
 *   a 的风格搬到原生执行（a + native）必须声明风格迁移状态。B 路线不要求 FrameState。
 * - 作品描述的正式载体是 film.json v2（engine/production/film.js）；ProjectSpec 是它的执行侧投影，
 *   两者用 film.js 的 toProjectSpec / fromProjectSpec 互相映射。
 *
 * 当前契约尚未被渲染器消费，因此这里不声称“配置已生效”，也不负责资源存在性
 * （除显式传入 checkFiles 外：那时 entry、style.baseline、assets.manifest 必须存在，
 *  且 entry / manifest 必须是文件；outputDir 已存在时必须是目录）。
 * 路径校验与平台无关：同一份记录在 Mac 和 Windows 上得到同样的结论。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKEND_ALIASES, BUILTIN_ROUTES, loadRouteRegistry, resolveRoute } from './routes.js';
import { ContractError, SCHEMA_VERSION, diagnostic, isNonEmptyString, isPlainObject, isPositiveInteger, normalizeRelativePath, registryFor, relativeInside, resolveProjectPath, statOrNull } from './project-contract.js';

export { ContractError, SCHEMA_VERSION, normalizeRelativePath, resolveProjectPath } from './project-contract.js';
export { CREATIVE_STATUSES, RESULT_STATUSES, TECHNICAL_STATUSES, validateCreativeAcceptance, validateRenderResult } from './render-result.js';

/** 内置注册表的路线 id（规范值）；别名见 LEGACY_ROUTES 与 routes.js。 */
export const ROUTES = Object.freeze(BUILTIN_ROUTES.map(r => r.id));
/** ProjectSpec v1 的旧路线名 → 注册表 id。 */
export const LEGACY_ROUTES = Object.freeze(Object.fromEntries(BUILTIN_ROUTES.filter(r => r.legacyId).map(r => [r.legacyId, r.id])));
/** 内置注册表里出现的全部后端，加上旧写法 raea（= native）。 */
export const BACKENDS = Object.freeze([...new Set([...BUILTIN_ROUTES.flatMap(r => r.backends), ...Object.keys(BACKEND_ALIASES)])]);
export const STYLE_MIGRATION_STATES = Object.freeze(['design-only', 'partial', 'verified']);
/** 各路线的默认后端（与 film.js 的 DEFAULT_BACKEND 同口径）。 */
export const DEFAULT_BACKEND = Object.freeze({ a: 'three', b: 'native', c: 'canvas', d: 'pathtrace' });
/** 本模块所在仓库的根（engine/production/ 往上两级）：loadProjectSpec 的默认根。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);

/**
 * 时间总长只能由整数帧推导（contracts.md §2、§3）。
 * @param {{ frameCount: number, fps: number }} output
 * @returns {{ frameCount: number, fps: number, durationSeconds: number }}
 */
export function deriveOutput(output) {
  const frameCount = output?.frameCount;
  const fps = output?.fps;
  if (!isPositiveInteger(frameCount)) throw new ContractError([diagnostic('output-framecount-invalid', 'output.frameCount', 'frameCount 必须是正整数')], '输出定义无效');
  if (!isPositiveInteger(fps)) throw new ContractError([diagnostic('output-fps-invalid', 'output.fps', 'fps 必须是正整数')], '输出定义无效');
  return { frameCount, fps, durationSeconds: frameCount / fps };
}

/**
 * 读取项目里的执行计划；实测值必须来自 RenderResult，不能从 ProjectSpec 推断。
 * @param {object} spec
 * @returns {{ state: 'planned-only' | 'evidence-referenced', planned: {target: string, graphicsBackend: string}, evidence: unknown }}
 */
export function executionStatus(spec) {
  const execution = spec?.execution ?? {};
  const planned = {
    target: execution.target,
    graphicsBackend: execution.graphicsBackend,
  };
  if (execution.evidence === null || execution.evidence === undefined) {
    return { state: 'planned-only', planned, evidence: null };
  }
  return { state: 'evidence-referenced', planned, evidence: execution.evidence };
}

/**
 * 路线与后端的规范值：route 取注册表 id（别名 beiming / raea / a-webgl… 换成 a / b / c），backend 的旧写法 raea 换成 native。
 * 认不出时对应字段为 null，不抛错。
 * @param {{ route?: unknown, backend?: unknown }} spec
 * @param {{ registry?: object }} [options]
 * @returns {{ routeId: string | null, backend: string | null, routeAlias: boolean }}
 */
export function canonicalRoute(spec, options = {}) {
  const registry = options.registry ?? loadRouteRegistry();
  const r = resolveRoute(spec?.route, registry);
  const b = typeof spec?.backend === 'string' ? (BACKEND_ALIASES[spec.backend] ?? spec.backend) : null;
  return { routeId: r?.id ?? null, backend: b, routeAlias: Boolean(r?.alias) };
}

/** 第 2 节：路线取自注册表，后端按路线校验。返回规范值给后面各节用。 */
function checkRouteAndBackend(spec, options, push) {
  const registry = registryFor(options, push);
  const r = resolveRoute(spec.route, registry);
  if (!r) {
    const ids = registry.routes.map(x => x.id).join(' / ');
    const legacy = registry.routes.filter(x => x.legacyId).map(x => `${x.legacyId}（= ${x.id}）`).join('、');
    push('route-invalid', 'route', `route 必须是路线注册表里的值：${ids}${legacy ? `；旧值 ${legacy} 仍可用` : ''}（收到 ${JSON.stringify(spec.route ?? null)}）`);
  }
  const known = [...new Set([...registry.routes.flatMap(x => x.backends ?? []), ...Object.keys(BACKEND_ALIASES)])];
  const backend = typeof spec.backend === 'string' ? (BACKEND_ALIASES[spec.backend] ?? spec.backend) : null;
  if (!known.includes(spec.backend)) {
    push('backend-invalid', 'backend', `backend 必须是 ${known.join(' / ')} 之一（收到 ${JSON.stringify(spec.backend ?? null)}）`);
  } else if (r && Array.isArray(r.route.backends)) {
    const allowed = r.route.backends;
    // a 路线的风格搬到原生执行是允许的过渡做法，但要声明迁移状态（第 6 节）
    const migrating = r.id === 'a' && backend === 'native';
    if (!allowed.includes(backend) && !migrating) {
      const hint = r.id === 'b' ? '；要用 Three 执行请走 a 路线' : '';
      push('backend-route-unsupported', 'backend', `${r.route.brand ?? r.id} 的 backend 只能是 ${allowed.join(' / ')}${r.id === 'b' ? '（旧写法 raea）' : ''}，收到 ${spec.backend}${hint}`);
    }
  }
  return { routeId: r?.id ?? null, backend: known.includes(spec.backend) ? backend : null };
}

/**
 * 校验 ProjectSpec。返回结构化诊断，不抛异常。
 * @param {unknown} spec
 * @param {{ root?: string, checkFiles?: boolean, registry?: object }} [options]
 * @returns {{ ok: boolean, diagnostics: Array<{code:string,path:string,message:string}> }}
 */
export function validateProjectSpec(spec, options = {}) {
  const diagnostics = [];
  const push = (code, path, message) => diagnostics.push(diagnostic(code, path, message));
  const rootDir = options.root ? resolve(options.root) : null;
  const checkFiles = options.checkFiles === true;

  if (!isPlainObject(spec)) {
    push('spec-invalid', '$', 'ProjectSpec 必须是 JSON 对象');
    return { ok: false, diagnostics };
  }

  // 1. 结构版本：未知版本拒绝自动解释。
  if (!Number.isInteger(spec.schemaVersion)) {
    push('schema-version-missing', 'schemaVersion', 'schemaVersion 必须是整数');
  } else if (spec.schemaVersion !== SCHEMA_VERSION) {
    push('schema-version-unknown', 'schemaVersion', `未知的 schemaVersion：${spec.schemaVersion}；当前实现只接受 ${SCHEMA_VERSION}，不做向后兼容猜测`);
  }

  // 2. 身份与路线。
  if (!isNonEmptyString(spec.projectId)) {
    push('project-id-missing', 'projectId', 'projectId 必须是非空稳定字符串');
  } else if (!ID_PATTERN.test(spec.projectId)) {
    push('project-id-invalid', 'projectId', 'projectId 只能使用字母、数字、点、下划线和短横线，且不能以符号开头');
  }
  const { routeId, backend } = checkRouteAndBackend(spec, options, push);

  // 3. 入口与路径解析：entry 必填，且是文件；checkFiles 时核对它真实存在。
  if (!isNonEmptyString(spec.entry)) {
    push('entry-missing', 'entry', 'entry 必须是仓库相对文件路径（A / C 路线是页面 index.html 或离屏 offscreen.mjs，B 路线是原生入口 film.tsx，D 路线是光追场景 scene.ts）');
  }
  resolvePathField(spec.entry, 'entry', rootDir, push, { checkFiles, kind: 'file', label: '入口文件', missing: 'entry-missing', wrongKind: 'entry-not-file' });
  resolvePathField(spec.output?.outputDir, 'output.outputDir', rootDir, push, { checkFiles, kind: 'dir', label: '输出目录', mustExist: false, wrongKind: 'output-dir-not-dir' });

  // 4. 输出定义：宽高、帧率、帧数必须完整且可计算。
  const output = spec.output;
  if (!isPlainObject(output)) {
    push('output-incomplete', 'output', 'output 必须是对象，包含宽高、fps、frameCount 与 outputDir');
  } else {
    for (const field of ['width', 'height']) {
      const value = output[field];
      if (!isPositiveInteger(value)) {
        push('output-incomplete', `output.${field}`, `${field} 必须是正整数像素`);
      } else if (value % 2 !== 0) {
        push('output-dimension-odd', `output.${field}`, `${field}=${value} 是奇数；H.264 yuv420p 要求偶数宽高`);
      }
    }
    if (!isPositiveInteger(output.fps)) push('output-incomplete', 'output.fps', 'fps 必须是正整数');
    if (!isPositiveInteger(output.frameCount)) push('output-incomplete', 'output.frameCount', 'frameCount 必须是正整数；帧数不能省略');
    if (isNonEmptyString(output.outputDir) === false) push('output-incomplete', 'output.outputDir', 'outputDir 必须是仓库相对目录');
    // duration 只能由帧数推导：一致时保留作展示，不作为独立配置源
    if (output.duration !== undefined && isPositiveInteger(output.fps) && isPositiveInteger(output.frameCount)) {
      const expected = output.frameCount / output.fps;
      if (!isFiniteNumber(output.duration) || Math.abs(output.duration - expected) > 1e-9) {
        push('output-duration-derived', 'output.duration', `duration 必须等于 frameCount/fps=${expected} 秒；不要写入独立的时长值`);
      }
    }
  }

  // 5. 运行时版本：按后端要求必备字段，并单独记录源码版本。
  const runtime = spec.runtime;
  if (!isPlainObject(runtime)) {
    push('runtime-incomplete', 'runtime', 'runtime 必须是对象，记录 Three/浏览器或 RAEA 包版本');
  } else {
    if (backend === 'three' && !isNonEmptyString(runtime.three)) push('runtime-incomplete', 'runtime.three', 'Three 后端必须记录 runtime.three 版本');
    if (backend === 'native' && !isNonEmptyString(runtime.package)) push('runtime-incomplete', 'runtime.package', '原生后端必须记录原生运行时的版本 runtime.package（RAEA 运行时包版本）');
    const commit = runtime.sourceCommit ?? runtime.sourceSnapshot;
    if (!isNonEmptyString(commit)) push('runtime-incomplete', 'runtime.sourceCommit', '必须记录源码提交（sourceCommit 或 sourceSnapshot）');
  }

  // 6. 风格：北冥路线必须有基准；beiming+raea 必须声明迁移状态。
  const style = spec.style;
  if (!isPlainObject(style)) {
    push('style-incomplete', 'style', 'style 必须是对象，至少包含 id 与 version');
  } else {
    if (!isNonEmptyString(style.id)) push('style-incomplete', 'style.id', 'style.id 必须是非空字符串');
    if (!isNonEmptyString(style.version)) push('style-incomplete', 'style.version', 'style.version 必须是非空字符串');
    // 基准可以是基准帧（文件）或基准工程（目录），所以只核对存在
    const baselineCheck = { checkFiles, kind: 'any', label: '视觉基准', missing: 'style-baseline-missing' };
    if (routeId === 'a') {
      if (!isNonEmptyString(style.baseline)) {
        push('style-baseline-missing', 'style.baseline', '北冥风格路线（a）必须记录视觉基准（基准帧或基准工程路径）');
      } else {
        resolvePathField(style.baseline, 'style.baseline', rootDir, push, baselineCheck);
      }
    } else if (style.baseline !== null && style.baseline !== undefined) {
      resolvePathField(style.baseline, 'style.baseline', rootDir, push, baselineCheck);
    }
    if (routeId === 'a' && backend === 'native') {
      const migration = style.migration;
      if (!isPlainObject(migration)) {
        push('style-migration-required', 'style.migration', '北冥风格（a）搬到原生执行（native，旧写法 raea）必须用 style.migration 标明风格迁移状态，不能默认等价');
      } else {
        if (!STYLE_MIGRATION_STATES.includes(migration.state)) push('style-migration-invalid', 'style.migration.state', `迁移状态必须是 ${STYLE_MIGRATION_STATES.join(' / ')}`);
        if (!Array.isArray(migration.evidence) || migration.evidence.some(v => !isNonEmptyString(v))) {
          push('style-migration-invalid', 'style.migration.evidence', '迁移证据必须是非空字符串数组');
        }
        if (migration.state === 'verified' && (!Array.isArray(migration.evidence) || !migration.evidence.length)) {
          push('style-migration-invalid', 'style.migration.evidence', '标为 verified 时必须给出对照证据');
        }
      }
    }
  }

  // 7. 资产：manifest 路径或内嵌清单二选一。
  const assets = spec.assets;
  if (!isPlainObject(assets)) {
    push('assets-incomplete', 'assets', 'assets 必须是对象，包含 manifest 或 inline 清单');
  } else if (!Array.isArray(assets.inline) && !isNonEmptyString(assets.manifest)) {
    push('assets-incomplete', 'assets.manifest', '必须给出资产清单路径或内嵌 inline 清单，不能只写目录名');
  } else if (isNonEmptyString(assets.manifest)) {
    resolvePathField(assets.manifest, 'assets.manifest', rootDir, push, { checkFiles, kind: 'file', label: '资产清单', missing: 'assets-manifest-missing', wrongKind: 'assets-manifest-not-file' });
  } else if (Array.isArray(assets.inline) && assets.inline.some(v => !isPlainObject(v))) {
    push('assets-incomplete', 'assets.inline', 'inline 清单的每一项必须是对象');
  }

  // 8. 音频目标：目标与实测分开，响度不等同峰值。
  const audio = spec.audio;
  if (!isPlainObject(audio)) {
    push('audio-incomplete', 'audio', 'audio 必须是对象，记录采样率、声道、目标响度');
  } else {
    if (!isPositiveInteger(audio.sampleRate) || audio.sampleRate < 8000) push('audio-invalid', 'audio.sampleRate', 'sampleRate 必须是不小于 8000 的正整数');
    if (!isPositiveInteger(audio.channels) || audio.channels > 8) push('audio-invalid', 'audio.channels', 'channels 必须是 1–8 的正整数');
    if (!isFiniteNumber(audio.targetLUFS)) push('audio-invalid', 'audio.targetLUFS', 'targetLUFS 必须是有限数字（目标值，不是实测）');
    if (!isFiniteNumber(audio.truePeakLimitDbTP) || audio.truePeakLimitDbTP > 0) push('audio-invalid', 'audio.truePeakLimitDbTP', 'truePeakLimitDbTP 必须是 ≤0 的有限数字');
  }

  // 9. 执行计划：只能写计划；实测字段属于 RenderResult。
  const execution = spec.execution;
  if (!isPlainObject(execution)) {
    push('execution-incomplete', 'execution', 'execution 必须是对象，记录目标平台与图形后端计划');
  } else {
    if (!isNonEmptyString(execution.target)) push('execution-incomplete', 'execution.target', 'execution.target 必须是非空字符串');
    if (!isNonEmptyString(execution.graphicsBackend)) push('execution-incomplete', 'execution.graphicsBackend', 'execution.graphicsBackend 必须是非空字符串');
    for (const key of Object.keys(execution)) {
      if (/^(actual|measured)/i.test(key) || /Device|Encoder|Driver/.test(key)) {
        push('execution-planned-as-actual', `execution.${key}`, `ProjectSpec.execution 只保存计划；实测值属于 RenderResult（收到计划字段 ${key}）`);
      }
    }
    if (execution.evidence !== null && execution.evidence !== undefined) {
      if (!isPlainObject(execution.evidence) && !Array.isArray(execution.evidence)) {
        push('execution-incomplete', 'execution.evidence', 'evidence 只能是 null（未采集）或记录对象/数组');
      }
    }
  }

  return { ok: diagnostics.length === 0, diagnostics };
}

/**
 * 校验并解析路径字段；失败时返回 null 且登记诊断。空值返回 null、不登记（必填与否由调用方判断）。
 * - kind：'file' 必须是文件（以 / 结尾在词法上就拒绝），'dir' 必须是目录，'any' 文件或目录都行。
 * - checkFiles 且给了 root 时查文件系统：不存在登记 missing（mustExist=false 时允许不存在），类型不对登记 wrongKind。
 */
function resolvePathField(value, fieldPath, rootDir, push, { checkFiles = false, kind = 'any', label = fieldPath, missing, wrongKind, mustExist = true } = {}) {
  if (!isNonEmptyString(value)) return null;
  const parsed = normalizeRelativePath(value);
  if (!parsed.ok) {
    push('path-escape', fieldPath, parsed.message);
    return null;
  }
  if (kind === 'file' && parsed.isDirectory) {
    push(wrongKind, fieldPath, `${label}必须是文件路径，不能以 / 结尾：${value}`);
    return null;
  }
  if (!rootDir) return { ok: true, relative: parsed.path, absolute: null };
  let resolved;
  try {
    resolved = resolveProjectPath(rootDir, value, { kind });
  } catch (error) {
    const message = error instanceof ContractError ? error.diagnostics[0]?.message ?? error.message : String(error);
    push('path-escape', fieldPath, message);
    return null;
  }
  if (checkFiles) {
    const stat = statOrNull(resolved.absolute);
    if (!stat) {
      if (mustExist) push(missing, fieldPath, `${label}不存在：${resolved.relative}`);
    } else if (kind === 'file' && !stat.isFile()) {
      push(wrongKind, fieldPath, `${label}必须是文件，${resolved.relative} 是目录`);
    } else if (kind === 'dir' && !stat.isDirectory()) {
      push(wrongKind, fieldPath, `${label}必须是目录，${resolved.relative} 是文件`);
    }
  }
  return { ok: true, ...resolved };
}

/**
 * 解析并校验 ProjectSpec；输入可以是 JSON 字符串或对象。
 * @param {string | object} input
 * @param {{ root?: string, checkFiles?: boolean }} [options]
 * @returns {object}
 */
export function parseProjectSpec(input, options = {}) {
  let spec = input;
  if (typeof input === 'string') {
    try {
      // 去掉 UTF-8 BOM：Windows PowerShell 5.1 的 Set-Content / Out-File -Encoding UTF8 会写它
      spec = JSON.parse(input.charCodeAt(0) === 0xfeff ? input.slice(1) : input);
    } catch (error) {
      throw new ContractError([diagnostic('json-invalid', '$', `JSON 解析失败：${error.message}`)], 'ProjectSpec 解析失败');
    }
  }
  const { ok, diagnostics } = validateProjectSpec(spec, options);
  if (!ok) throw new ContractError(diagnostics, 'ProjectSpec 校验失败');
  return spec;
}

/**
 * 规格文件的默认根：契约 §2 规定 entry / baseline / manifest / outputDir 都是仓库相对路径，
 * 所以不能取文件所在目录。文件在本仓库内就用本仓库根；否则向上找含 .git 的目录；都找不到就要求调用方传 root。
 * @param {string} absoluteFile
 * @returns {string}
 */
export function defaultSpecRoot(absoluteFile) {
  const rel = relative(REPO_ROOT, absoluteFile);
  if (rel && relativeInside(rel)) return REPO_ROOT;
  for (let dir = dirname(absoluteFile); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) break;
  }
  throw new ContractError([diagnostic('root-unknown', '$', `找不到 ${absoluteFile} 所在的仓库根：请用 options.root 指明`)], 'ProjectSpec 载入失败');
}

/**
 * 从文件读取 ProjectSpec。root 默认是仓库根（见 defaultSpecRoot），可用 options.root 覆盖。
 * 文件开头的 UTF-8 BOM 会被去掉。
 * @param {string} filePath
 * @param {{ root?: string, checkFiles?: boolean }} [options]
 * @returns {{ spec: object, filePath: string, root: string }}
 */
export function loadProjectSpec(filePath, options = {}) {
  if (!isNonEmptyString(filePath)) {
    throw new ContractError([diagnostic('file-invalid', '$', '必须给出 ProjectSpec 文件路径')], 'ProjectSpec 载入失败');
  }
  const absoluteFile = resolve(filePath);
  const root = options.root ? resolve(options.root) : defaultSpecRoot(absoluteFile);
  let text;
  try {
    text = readFileSync(absoluteFile, 'utf8');
  } catch (error) {
    throw new ContractError([diagnostic('file-unreadable', '$', `读取失败：${error.message}`)], 'ProjectSpec 载入失败');
  }
  const spec = parseProjectSpec(text, { ...options, root });
  return { spec, filePath: absoluteFile, root };
}
