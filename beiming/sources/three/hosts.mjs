// three 帧源的宿主注册表与 host:'any' 解析策略。
// 主线验收与基准考题只准入浏览器页面宿主（page）；Node + Dawn 离屏宿主（offscreen）登记为显式实验宿主条目，
// 仅在显式开启实验对拍（allowExperimental: true 且非主线验收、非考题）时参与 host:'any' 双宿主展开与离屏渲染。
import { renderingOf, SHOT_INPUT_EXAM } from '../../kernel/eval/input.mjs';

export class SourceError extends Error {
  /** next 是可选的「接下来可以怎么办」：一组可执行的替代办法，每项 { verb, why }（和 API 错误信封的 next 同一个写法） */
  constructor(code, message, next) {
    super(message);
    this.code = code;
    if (next) this.next = next;
  }
}

export const THREE_HOSTS = Object.freeze({
  page: Object.freeze({
    id: 'page',
    experimental: false,
    mainlineAcceptance: true,
    examEligible: true,
    backend: 'webgl2',
    note: '主线浏览器页面宿主（主线验收与基准考题唯一准入宿主）',
  }),
  offscreen: Object.freeze({
    id: 'offscreen',
    experimental: true,
    mainlineAcceptance: false,
    examEligible: false,
    backend: 'webgpu-dawn',
    note: 'Node + Dawn 实验宿主，不进主线验收与考题',
  }),
});

const HOST_OPTS_KEYS = ['allowExperimental', 'mainline', 'mainlineAcceptance', 'exam'];
const bad = (message) => new SourceError('usage.bad-argument', message);
const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasExam = (v) => v === true || (typeof v === 'string' && v.trim().length > 0) || (isPlainObj(v) && Object.keys(v).length > 0);

function parseHostOpts(opts, label = 'opts') {
  if (opts === undefined) return { allowExperimental: false, mainline: false, exam: false };
  if (!isPlainObj(opts)) throw bad(`${label} 必须是普通对象`);
  for (const k of Object.keys(opts)) {
    if (!HOST_OPTS_KEYS.includes(k)) throw bad(`${label} 不认识键 ${k}`);
    if (opts[k] !== undefined && typeof opts[k] !== 'boolean') throw bad(`${label}.${k} 必须是布尔值`);
  }
  const mainline = opts.mainline === true || opts.mainlineAcceptance === true;
  const exam = opts.exam === true;
  return { allowExperimental: opts.allowExperimental === true, mainline, exam };
}

/**
 * 返回当前上下文允许声明的 three 宿主名列表。
 * 默认、主线验收或考题上下文固定返回 ['page']；显式传 { allowExperimental: true }（或 { experimentalHosts: true }）且非主线/非考题时返回 ['page', 'offscreen']。
 */
export function listThreeHosts(opts = {}) {
  if (opts !== undefined && !isPlainObj(opts)) throw bad('opts 必须是普通对象');
  const { allowExperimental, mainline, exam } = parseHostOpts({
    allowExperimental: opts?.allowExperimental ?? opts?.experimentalHosts,
    mainline: opts?.mainline,
    mainlineAcceptance: opts?.mainlineAcceptance,
    exam: opts?.exam,
  });
  return allowExperimental && !mainline && !exam ? ['page', 'offscreen'] : ['page'];
}

/**
 * 解析 three 镜头的宿主声明（支持顶层 shot 或带 renderer 的镜头条目，以及包含 shot 的 ShotInput）：
 * - 主线验收（mainline: true）、考题（exam: true）或未开启实验宿主（allowExperimental !== true）时：
 *   host:'any' 仅解析为 'page'；显式 host:'offscreen' 报 SourceError('contract.unsupported-mode')。
 * - 实验对拍模式（allowExperimental: true 且非主线、非考题）时：
 *   host:'any' 展开为 ['page', 'offscreen']，显式 'page' 或 'offscreen' 原样返回。
 * - 非法入参或未知宿主名报 SourceError('usage.bad-argument')。
 */
export function resolveThreeHost(shot, opts = {}) {
  if (!isPlainObj(shot)) throw bad('shot 必须是普通对象');
  const { allowExperimental, mainline, exam } = parseHostOpts(opts);
  const rawShot = isPlainObj(shot.shot) ? shot.shot : shot;
  if (rawShot.renderer !== undefined && !isPlainObj(rawShot.renderer)) throw bad('shot.renderer 必须是普通对象');
  const target = renderingOf(rawShot);
  if (!isPlainObj(target)) throw bad('镜头渲染配置必须是普通对象');
  if (target.source !== undefined && target.source !== 'three') {
    throw bad(`resolveThreeHost 只解析 three 帧源的镜头，给的是 ${String(target.source)}`);
  }
  const host = target.host;
  if (typeof host !== 'string' || !host.trim()) throw bad('镜头 host 必须是非空字符串');
  if (host !== 'any' && !Object.hasOwn(THREE_HOSTS, host)) {
    throw bad(`three 帧源不认识宿主 ${host}（只支持 page、offscreen 或 any）`);
  }

  const inExam = exam || hasExam(shot[SHOT_INPUT_EXAM]) || hasExam(shot.exam) || hasExam(rawShot.exam);
  const experimentalAllowed = allowExperimental && !mainline && !inExam;

  if (!experimentalAllowed) {
    if (host === 'offscreen') {
      const reason = mainline || inExam
        ? 'three 离屏实验宿主（offscreen）严禁进入主线验收与基准考题'
        : 'three 帧源默认未启用离屏实验宿主（offscreen）';
      throw new SourceError('contract.unsupported-mode', reason);
    }
    return 'page';
  }

  if (host === 'any') return ['page', 'offscreen'];
  return host;
}
