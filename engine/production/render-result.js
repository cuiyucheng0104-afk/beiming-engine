/**
 * RenderResult（运行记录）的两种校验口径：
 * - 默认：T01 的旧形状照常通过（creativeAcceptance 写 events / styleComparison 的记录）。
 * - strict（运行记录 run.json 一律用它，见附录 C8 与 state.js）：accepted 必须有 creativeAcceptance.reviews[]
 *   里至少一条人工认可（reviewerKind = human、decision = approve、带审阅人原话与出处）；只有 AI 评审时最多是 ai-reviewed；
 *   技术验收 passed 必须指向一份可解析、ok = true 的 QA 报告（qa/report.json）。
 *   不论哪种口径，只要写了 reviews[] 就逐条校验，AI 评审不能 approve / reject / waive。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCHEMA_VERSION, diagnostic, isNonEmptyString, isPlainObject, isPositiveInteger, normalizeRelativePath, registryFor } from './project-contract.js';
import { resolveRoute } from './routes.js';
import { DECISIONS, HUMAN_DECISIONS, REVIEWER_KINDS, RUBRIC_DIMENSIONS, SOURCE_KINDS, VETOES, isAgentName, isPlaceholderQuote } from './vocab.js';

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
/** technicalAcceptance.status 的取值；passed / accepted 的结果要求它是 passed。 */
export const TECHNICAL_STATUSES = Object.freeze(['not-run', 'running', 'blocked', 'failed', 'passed']);
/** creativeAcceptance.status 的取值；accepted 的结果要求它是 accepted；只有 AI 评审（代理审片）时最多是 ai-reviewed。 */
export const CREATIVE_STATUSES = Object.freeze(['not-reviewed', 'ai-reviewed', 'rejected', 'accepted']);

const SHA256 = /^[0-9a-f]{64}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * creativeAcceptance 的评审条目（附录 C8 的 reviews[]）：
 *   { reviewerKind: 'human' | 'ai', reviewer, decision: approve | reject | waive | comment, quote, source: { kind, ref, at },
 *     scores?: { 维度 id: 1–10 }, vetoes?: [否决项 id], evidenceFrames?: [帧号], record?: 'review/<闸>-<日期>.json' }
 * 规则：AI 评审只能是 comment（代理审片）；人工的 approve / reject / waive 必须带审阅人原话与出处（占位符或自评口吻无效），reviewer 不能是 agent 的名字。
 * 维度与否决项的 id 见 engine/production/vocab.js 与 docs/creative-review/SCORING-GUIDE.md。
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
      if (isAgentName(r.reviewer)) {
        push('creative-agent-reviewer', `${p}.reviewer`, `reviewer 写的是 agent（${JSON.stringify(r.reviewer)}）：${r.decision} 只能由用户或指定审片人做，agent 不能自己批准、否决或豁免`);
        complete = false;
      }
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
