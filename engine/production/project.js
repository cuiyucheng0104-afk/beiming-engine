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
 *
 * RenderResult（运行记录）的两种校验口径：
 * - 默认：T01 的旧形状照常通过（creativeAcceptance 写 events / styleComparison 的记录）。
 * - strict（运行记录 run.json 一律用它，见附录 C8 与 state.js）：accepted 必须有 creativeAcceptance.reviews[]
 *   里至少一条人工认可（reviewerKind = human、decision = approve、带审阅人原话与出处）；只有 AI 评审时最多是 ai-reviewed；
 *   技术验收 passed 必须指向一份可解析、ok = true 的 QA 报告（qa/report.json）。
 *   不论哪种口径，只要写了 reviews[] 就逐条校验，AI 评审不能 approve / reject / waive。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKEND_ALIASES, BUILTIN_ROUTES, RouteRegistryError, builtinRegistry, loadRouteRegistry, resolveRoute } from './routes.js';
import { DECISIONS, HUMAN_DECISIONS, REVIEWER_KINDS, RUBRIC_DIMENSIONS, SOURCE_KINDS, VETOES, isPlaceholderQuote } from './vocab.js';

export const SCHEMA_VERSION = 1;
/** 内置注册表的路线 id（规范值）；别名见 LEGACY_ROUTES 与 routes.js。 */
export const ROUTES = Object.freeze(BUILTIN_ROUTES.map(r => r.id));
/** ProjectSpec v1 的旧路线名 → 注册表 id。 */
export const LEGACY_ROUTES = Object.freeze(Object.fromEntries(BUILTIN_ROUTES.filter(r => r.legacyId).map(r => [r.legacyId, r.id])));
/** 内置注册表里出现的全部后端，加上旧写法 raea（= native）。 */
export const BACKENDS = Object.freeze([...new Set([...BUILTIN_ROUTES.flatMap(r => r.backends), ...Object.keys(BACKEND_ALIASES)])]);
/**
 * RenderResult.status：not-run → running → rendered（出片完成、待技术验收）→ passed（技术验收通过）→ accepted（创作验收也通过）；
 * 中途失败写 failed，被前置条件拦下写 blocked。rendered 由渲染器写；passed 由 QA 判定后写；accepted 只能有人工认可。
 */
export const RESULT_STATUSES = Object.freeze([
  'not-run',
  'running',
  'blocked',
  'failed',
  'rendered',
  'passed',
  'accepted',
]);
export const STYLE_MIGRATION_STATES = Object.freeze(['design-only', 'partial', 'verified']);
/** technicalAcceptance.status 的取值；passed / accepted 的结果要求它是 passed。 */
export const TECHNICAL_STATUSES = Object.freeze(['not-run', 'running', 'blocked', 'failed', 'passed']);
/** creativeAcceptance.status 的取值；accepted 的结果要求它是 accepted；只有 AI 评审（代理审片）时最多是 ai-reviewed。 */
export const CREATIVE_STATUSES = Object.freeze(['not-reviewed', 'ai-reviewed', 'rejected', 'accepted']);

/** 本模块所在仓库的根（engine/production/ 往上两级）：loadProjectSpec 的默认根。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// eslint-disable-next-line no-control-regex -- 有意匹配控制字符（路径与 id 里不许出现）
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
const WINDOWS_RESERVED = /[<>:"|?*]/;

/** 校验失败时抛出；diagnostics 保留每一条可定位的错误。 */
export class ContractError extends Error {
  /**
   * @param {Array<{code: string, path: string, message: string}>} diagnostics
   * @param {string} [label]
   */
  constructor(diagnostics, label = '契约校验失败') {
    super(`${label}：\n${diagnostics.map(d => `- [${d.code}] ${d.path}：${d.message}`).join('\n')}`);
    this.name = 'ContractError';
    this.diagnostics = diagnostics;
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = value => typeof value === 'string' && value.trim().length > 0;
const isPositiveInteger = value => Number.isInteger(value) && value > 0;
const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);

function diagnostic(code, path, message) {
  return { code, path, message };
}

/** path.relative 的结果是否仍在根内（'..draft' 这样的目录名在根内；'..'、'../x'、跨盘的绝对路径在外）。 */
function relativeInside(rel) {
  return !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

const statOrNull = file => { try { return statSync(file); } catch { return null; } };

/**
 * 词法解析仓库相对路径：拒绝绝对路径、盘符、UNC、控制字符与越界 `..`。
 * 不做文件系统查询，也不解析符号链接；写入范围只是词法提醒。
 * 绝对路径按 POSIX 与 Windows 两套规则同时判断（`/x`、`\x`、`C:`、`\\server` 在任何平台上都拒绝），
 * 所以同一份记录在 Mac 和 Windows 上结论一致。
 * @param {string} value
 * @returns {{ ok: true, segments: string[], path: string, isDirectory: boolean } | { ok: false, message: string }}
 */
export function normalizeRelativePath(value) {
  if (!isNonEmptyString(value)) return { ok: false, message: '路径必须是非空字符串' };
  if (CONTROL_CHAR.test(value)) return { ok: false, message: '路径不能包含控制字符' };
  const raw = value.trim();
  if (posix.isAbsolute(raw) || win32.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith('\\') || raw.startsWith('//')) {
    return { ok: false, message: '只能使用仓库相对路径，不能是绝对路径或盘符路径' };
  }
  const normalized = raw.replace(/\\/g, '/');
  if (WINDOWS_RESERVED.test(normalized)) {
    return { ok: false, message: '路径包含 Windows 不允许的字符（< > : " | ? *）' };
  }
  const isDirectory = normalized.endsWith('/');
  const segments = [];
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) return { ok: false, message: '路径越出了项目授权范围（起点就是 ..）' };
      segments.pop();
      continue;
    }
    if (segment.endsWith('.')) return { ok: false, message: `路径段不能以点结尾：${segment}` };
    segments.push(segment);
  }
  if (!segments.length) return { ok: false, message: '路径为空或只包含 ./：需要一个具体文件/目录' };
  return { ok: true, segments, path: segments.join('/'), isDirectory };
}

/**
 * 把仓库相对路径解析成绝对路径，并确认没有穿出 rootDir。
 * @param {string} rootDir 仓库根或项目根
 * @param {string} value 仓库相对路径
 * @param {{ kind?: string }} [options]
 * @returns {{ absolute: string, relative: string, kind: string }}
 */
export function resolveProjectPath(rootDir, value, options = {}) {
  const kind = options.kind ?? 'path';
  if (!isNonEmptyString(rootDir)) throw new ContractError([diagnostic('root-invalid', kind, 'root 必须是非空字符串')], '路径解析失败');
  const parsed = normalizeRelativePath(value);
  if (!parsed.ok) {
    throw new ContractError([diagnostic('path-escape', kind, `${parsed.message}（收到：${String(value)}）`)], '路径解析失败');
  }
  const root = resolve(rootDir);
  const absolute = resolve(root, ...parsed.segments);
  const rel = relative(root, absolute);
  if (!rel || !relativeInside(rel)) {
    throw new ContractError([diagnostic('path-escape', kind, `路径穿出了根目录：${value}`)], '路径解析失败');
  }
  return { absolute, relative: rel.split(sep).join('/'), kind };
}

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

/** 读路线注册表；坏了不抛错，登记一条诊断后退回内置三条（校验函数约定不抛异常）。 */
function registryFor(options, push) {
  if (options.registry) return options.registry;
  try {
    return loadRouteRegistry();
  } catch (error) {
    if (!(error instanceof RouteRegistryError)) throw error;
    push('routes-invalid', 'route', `${error.message}；本次按内置的 a / b / c 校验`);
    return builtinRegistry();
  }
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
    push('entry-missing', 'entry', 'entry 必须是仓库相对文件路径（A / C 路线是页面 index.html，B 路线是原生入口 film.tsx）');
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

const SHA256 = /^[0-9a-f]{64}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * creativeAcceptance 的评审条目（附录 C8 的 reviews[]）：
 *   { reviewerKind: 'human' | 'ai', reviewer, decision: approve | reject | waive | comment, quote, source: { kind, ref, at },
 *     scores?: { 维度 id: 1–10 }, vetoes?: [否决项 id], evidenceFrames?: [帧号], record?: 'review/<闸>-<日期>.json' }
 * 规则：AI 评审只能是 comment（代理审片）；人工的 approve / reject / waive 必须带审阅人原话与出处（占位符或自评口吻无效）。
 * 维度与否决项的 id 见 engine/production/vocab.js 与 docs/creative-review/RUBRIC.md。
 * @param {unknown} creative
 * @param {{ path?: string }} [options]
 * @returns {{ ok: boolean, diagnostics: Array<{code:string,path:string,message:string}>, humanApproved: boolean }}
 */
export function validateCreativeAcceptance(creative, options = {}) {
  const base = options.path ?? 'creativeAcceptance';
  const diagnostics = [];
  const push = (code, path, message) => diagnostics.push(diagnostic(code, path, message));
  let humanApproved = false;
  if (creative === undefined || creative === null) return { ok: true, diagnostics, humanApproved };
  if (!isPlainObject(creative)) {
    push('result-invalid', base, 'creativeAcceptance 必须是对象');
    return { ok: false, diagnostics, humanApproved };
  }
  const reviews = creative.reviews;
  if (reviews === undefined) return { ok: true, diagnostics, humanApproved };
  if (!Array.isArray(reviews)) {
    push('creative-reviews-invalid', `${base}.reviews`, 'reviews 必须是评审条目数组');
    return { ok: false, diagnostics, humanApproved };
  }
  reviews.forEach((r, i) => {
    const p = `${base}.reviews[${i}]`;
    if (!isPlainObject(r) || !REVIEWER_KINDS.includes(r.reviewerKind) || !isNonEmptyString(r.reviewer) || !DECISIONS.includes(r.decision)) {
      push('creative-review-invalid', p, `每条评审写 { reviewerKind: ${REVIEWER_KINDS.join(' | ')}, reviewer, decision: ${DECISIONS.join(' | ')}, quote, source }`);
      return;
    }
    const human = HUMAN_DECISIONS.includes(r.decision);
    if (r.reviewerKind === 'ai' && human) {
      push('creative-ai-decision', `${p}.decision`, `AI 评审只能是 comment（代理审片），不能 ${r.decision}：agent 不能自己批准、否决或豁免`);
    }
    let complete = true;
    if (r.reviewerKind === 'human' && human) {
      if (!isNonEmptyString(r.quote) || isPlaceholderQuote(r.quote)) {
        push('creative-review-quote', `${p}.quote`, '人工评审必须带审阅人原话（原样照录；占位符或自评口吻无效）');
        complete = false;
      }
      const src = r.source;
      if (!isPlainObject(src) || !isNonEmptyString(src.ref) || isPlaceholderQuote(src.ref)) {
        push('creative-review-source', `${p}.source`, '人工评审必须带出处 source { kind, ref, at }：能找回这句话的会话、消息、邮件或纪要');
        complete = false;
      } else {
        if (src.kind !== undefined && !SOURCE_KINDS.includes(src.kind)) push('creative-review-source', `${p}.source.kind`, `source.kind 只能是 ${SOURCE_KINDS.join(' / ')}`);
        if (src.at !== undefined && !(isNonEmptyString(src.at) && ISO_TIME.test(src.at) && !Number.isNaN(Date.parse(src.at)))) push('creative-review-source', `${p}.source.at`, 'source.at 是 ISO 8601 时间');
      }
      if (r.decision === 'approve' && complete) humanApproved = true;
    }
    if (r.scores !== undefined && !(isPlainObject(r.scores) && Object.entries(r.scores).every(([k, v]) => Object.hasOwn(RUBRIC_DIMENSIONS, k) && Number.isInteger(v) && v >= 1 && v <= 10))) {
      push('creative-review-scores', `${p}.scores`, `分数用评分维度 id（${Object.keys(RUBRIC_DIMENSIONS).join(' / ')}），1–10 的整数`);
    }
    if (r.vetoes !== undefined && !(Array.isArray(r.vetoes) && r.vetoes.every(v => Object.hasOwn(VETOES, v)))) {
      push('creative-review-vetoes', `${p}.vetoes`, `一票否决项取值：${Object.keys(VETOES).join(' / ')}`);
    }
    if (r.evidenceFrames !== undefined && !(Array.isArray(r.evidenceFrames) && r.evidenceFrames.every(f => Number.isInteger(f) && f >= 0))) {
      push('creative-review-frames', `${p}.evidenceFrames`, 'evidenceFrames 是非负整数帧号数组');
    }
  });
  return { ok: diagnostics.length === 0, diagnostics, humanApproved };
}

/** 技术证据里指向 QA 报告的条目：相对路径、以 .json 结尾（例如 qa/report.json）。 */
function qaReportEvidence(evidence) {
  return (Array.isArray(evidence) ? evidence : []).filter(e => isNonEmptyString(e) && /\.json$/i.test(e.trim()) && normalizeRelativePath(e.trim()).ok);
}

/** QA 报告（附录 C8）的最小形状：{ schemaVersion: 1, input: { path, sha256 }, checks: [...], ok }。 */
function qaReportProblem(report) {
  if (!isPlainObject(report)) return '不是 JSON 对象';
  if (report.schemaVersion !== 1) return `schemaVersion 是 ${JSON.stringify(report.schemaVersion)}，应为 1`;
  if (!isPlainObject(report.input) || !SHA256.test(report.input.sha256 ?? '')) return 'input 缺少被检文件的 sha256';
  if (!Array.isArray(report.checks)) return 'checks 不是数组';
  if (report.ok !== true) return 'ok 不是 true（有硬门没过）';
  if (report.checks.some(c => c?.status === 'fail')) return 'checks 里有 fail';
  return null;
}

/**
 * 校验 RenderResult 的最小语义（contracts.md §7；运行记录 run.json 见附录 C8）：
 * 未执行的记录不能预填成功；technical 与 creative 验收必须分别成立。
 * status 为 passed / accepted 时：技术验收必须是 passed 且附证据，并记录实际设备、图形后端、编码器、
 * 产物哈希、帧数与宽高（AGENTS.md 制作要求第 7 条）；rendered（出片完成、待 QA）同样要记录这些实测值，但不要求技术验收。
 * 两类验收的 status 都按枚举校验；route 取自路线注册表。
 * strict（运行记录一律用它）另加两条：accepted 必须有人工认可的评审（reviews[]，不再接受只写 events / styleComparison 的旧形状）；
 * 技术验收 passed 必须指向 QA 报告，给了 runDir 时还要读出来、ok = true。
 * @param {unknown} result
 * @param {{ expectedFrameCount?: number, strict?: boolean, runDir?: string, repoRoot?: string, registry?: object }} [options]
 *   repoRoot：运行目录所在的仓库根；技术证据写成仓库相对路径时据此解析（tools/qa 的写法）
 * @returns {{ ok: boolean, diagnostics: Array<{code:string,path:string,message:string}> }}
 */
export function validateRenderResult(result, options = {}) {
  const diagnostics = [];
  const push = (code, path, message) => diagnostics.push(diagnostic(code, path, message));
  const strict = options.strict === true;

  if (!isPlainObject(result)) {
    push('result-invalid', '$', 'RenderResult 必须是 JSON 对象');
    return { ok: false, diagnostics };
  }
  if (result.schemaVersion !== SCHEMA_VERSION) push('schema-version-unknown', 'schemaVersion', `未知的 schemaVersion：${result.schemaVersion}`);
  if (!RESULT_STATUSES.includes(result.status)) push('result-status-invalid', 'status', `status 必须是 ${RESULT_STATUSES.join(' / ')}`);
  if (isNonEmptyString(result.route)) {
    const registry = registryFor(options, push);
    if (!resolveRoute(result.route, registry)) push('result-route-invalid', 'route', `route 必须是路线注册表里的值：${registry.routes.map(x => x.id).join(' / ')}（旧值 beiming、raea 仍可用），收到 ${result.route}`);
  }

  const technical = result.technicalAcceptance ?? {};
  const creative = result.creativeAcceptance ?? {};
  if (!isPlainObject(technical)) push('result-invalid', 'technicalAcceptance', 'technicalAcceptance 必须是对象');
  if (!isPlainObject(creative)) push('result-invalid', 'creativeAcceptance', 'creativeAcceptance 必须是对象');
  if (technical.evidence !== undefined && (!Array.isArray(technical.evidence) || technical.evidence.some(v => !isNonEmptyString(v)))) {
    push('result-invalid', 'technicalAcceptance.evidence', '证据必须是非空字符串数组');
  }
  if (isPlainObject(technical) && technical.status !== undefined && !TECHNICAL_STATUSES.includes(technical.status)) {
    push('result-status-invalid', 'technicalAcceptance.status', `技术验收状态必须是 ${TECHNICAL_STATUSES.join(' / ')}（收到 ${String(technical.status)}）`);
  }
  if (isPlainObject(creative) && creative.status !== undefined && !CREATIVE_STATUSES.includes(creative.status)) {
    push('result-status-invalid', 'creativeAcceptance.status', `创作验收状态必须是 ${CREATIVE_STATUSES.join(' / ')}（收到 ${String(creative.status)}）`);
  }
  const reviewCheck = isPlainObject(creative) ? validateCreativeAcceptance(creative) : { diagnostics: [], humanApproved: false };
  diagnostics.push(...reviewCheck.diagnostics);
  const hasReviews = isPlainObject(creative) && Array.isArray(creative.reviews);

  const notRun = result.status === 'not-run';
  const measuredFields = {
    'actualDevice': result.actualDevice,
    'actualGraphicsBackend': result.actualGraphicsBackend,
    'actualEncoder': result.actualEncoder,
    'output.sha256': result.output?.sha256,
  };
  if (notRun) {
    for (const [field, value] of Object.entries(measuredFields)) {
      if (value !== null && value !== undefined) push('result-prefilled', field, '未执行的记录不能预填实测字段；先渲染再填写');
    }
    if (technical.status !== undefined && technical.status !== 'not-run') push('result-prefilled', 'technicalAcceptance.status', '未执行时技术验收只能是 not-run');
    if (creative.status !== undefined && creative.status !== 'not-reviewed') push('result-prefilled', 'creativeAcceptance.status', '未审查时创作验收只能是 not-reviewed');
    if (hasReviews && creative.reviews.length) push('result-prefilled', 'creativeAcceptance.reviews', '未执行的记录不能预填评审');
  }

  const needsIdentity = !notRun;
  if (needsIdentity) {
    for (const field of ['projectId', 'shotId', 'route', 'backend']) {
      if (!isNonEmptyString(result[field])) push('result-identity-missing', field, '已经开始的渲染必须记录项目、镜头与路线/后端');
    }
  }

  const passesTechnical = technical.status === 'passed';
  const acceptedOverall = result.status === 'accepted';
  const passedOverall = result.status === 'passed';
  const renderedOverall = result.status === 'rendered';
  if ((passesTechnical || passedOverall || acceptedOverall) && (!Array.isArray(technical.evidence) || !technical.evidence.length)) {
    push('result-evidence-missing', 'technicalAcceptance.evidence', '技术验收通过必须附证据（命令、日志、ffprobe、完整解码结果）');
  }
  if (passedOverall && !passesTechnical) {
    push('result-passed-without-technical', 'technicalAcceptance.status', `status=passed 表示技术验收通过，technicalAcceptance.status 必须是 passed（收到 ${String(technical.status)}）`);
  }
  if (passedOverall || acceptedOverall || renderedOverall) {
    const what = renderedOverall ? '出片完成' : '技术验收通过';
    for (const field of ['actualDevice', 'actualGraphicsBackend', 'actualEncoder']) {
      if (!isNonEmptyString(result[field])) push('result-measured-missing', field, `${what}必须记录实际执行的 ${field}，不能用计划值代替`);
    }
    if (!isNonEmptyString(result.output?.sha256)) push('result-measured-missing', 'output.sha256', `${what}必须记录产物 SHA256`);
    const frames = result.output?.frames;
    if (!isPositiveInteger(frames)) push('result-output-incomplete', 'output.frames', '必须记录实际帧数');
    if (isPositiveInteger(frames) && isPositiveInteger(options.expectedFrameCount) && frames !== options.expectedFrameCount) {
      push('result-frame-count-mismatch', 'output.frames', `实际 ${frames} 帧与项目预期 ${options.expectedFrameCount} 帧不一致`);
    }
    const width = result.output?.width;
    const height = result.output?.height;
    if (!isPositiveInteger(width) || !isPositiveInteger(height)) push('result-output-incomplete', 'output.width', '必须记录实际宽高');
  }
  if (strict && (passesTechnical || passedOverall || acceptedOverall) && Array.isArray(technical.evidence) && technical.evidence.length) {
    const reports = qaReportEvidence(technical.evidence);
    if (!reports.length) {
      push('technical-evidence-not-qa', 'technicalAcceptance.evidence', '技术验收通过必须指向一份 QA 报告（相对运行目录的 qa/report.json）；命令行和日志只能作补充证据');
    } else if (isNonEmptyString(options.runDir)) {
      for (const rel of reports) {
        // 证据路径相对运行目录（qa/report.json），或相对仓库根（tools/qa 写的是 films/<名>/out/<run-id>/qa/report.json）
        const segs = normalizeRelativePath(rel.trim()).segments;
        const bases = [options.runDir, options.repoRoot].filter(isNonEmptyString);
        const file = bases.map(b => resolve(b, ...segs)).find(f => existsSync(f)) ?? resolve(options.runDir, ...segs);
        let report = null, problem = null;
        try { report = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (error) { problem = error.code === 'ENOENT' ? '文件不存在' : `读不出或不是合法 JSON（${error.code ?? error.message}）`; }
        problem ??= qaReportProblem(report);
        if (problem) push('technical-evidence-unparseable', 'technicalAcceptance.evidence', `QA 报告 ${rel} 不能作为技术验收证据：${problem}`);
      }
    }
  }
  const creativeAccepted = acceptedOverall || creative.status === 'accepted';
  if (creativeAccepted && (hasReviews || strict) && !reviewCheck.humanApproved) {
    push('creative-accepted-without-human', 'creativeAcceptance.reviews', 'accepted 至少要一条人工认可：reviews[] 里 reviewerKind = human、decision = approve、带审阅人原话与出处；只有 AI 评审时最多写 ai-reviewed');
  }
  if (acceptedOverall) {
    if (technical.status !== 'passed') push('result-accepted-without-technical', 'technicalAcceptance.status', '创作验收通过不能替代技术验收；accepted 要求技术验收已通过');
    if (creative.status !== 'accepted') push('result-accepted-without-creative', 'creativeAcceptance.status', 'accepted 要求创作验收也已完成且通过');
    // 旧形状（没有 reviews[]）照 T01 的要求记录可见事件与风格对照；新形状由人工评审的原话与证据帧承担
    if (!hasReviews && !strict) {
      if (!Array.isArray(creative.events) || !creative.events.length) push('result-accepted-without-creative', 'creativeAcceptance.events', '创作验收必须记录可见事件，不能只写结论');
      if (!Array.isArray(creative.styleComparison) || !creative.styleComparison.length) push('result-accepted-without-creative', 'creativeAcceptance.styleComparison', '创作验收必须包含与基准的风格对照');
    }
  }
  if (creative.status === 'ai-reviewed' && hasReviews && !creative.reviews.some(r => isPlainObject(r) && r.reviewerKind === 'ai')) {
    push('creative-status-inconsistent', 'creativeAcceptance.status', 'ai-reviewed 表示做过代理审片：reviews[] 里应有 reviewerKind = ai 的 comment');
  }

  return { ok: diagnostics.length === 0, diagnostics };
}
