// 北冥引擎 · 审片与验收的共用词表（叶子模块，不 import 任何东西，浏览器与 Node 都能用）。
// project.js（RenderResult 的 creativeAcceptance）、review.js（films/<名>/review/ 的审片记录）、
// docs/creative-review/RUBRIC.md 与 issue.schema.json 用同一套 id；三处一致由 tests/production/review.test.mjs 守住。
//
//   REVIEWER_KINDS / DECISIONS / HUMAN_DECISIONS / SOURCE_KINDS / VERDICTS   记录字段的取值
//   RUBRIC_DIMENSIONS   六个评分维度（1–10 分，锚点见 RUBRIC.md）
//   VETOES              一票否决项（出现任一项，不论分数都不能交付）
//   ISSUE_LAYERS / ISSUE_PRIORITIES / ISSUE_STATUSES   问题条目定位到哪一层、多急、处理到哪
//   isPlaceholderQuote(text)   一眼就是占位符或 agent 自评口吻的"原话"：这种记录无效

export const REVIEWER_KINDS = Object.freeze(['human', 'ai']);
export const DECISIONS = Object.freeze(['approve', 'reject', 'waive', 'comment']);
/** 只能由人做的决定：agent 只能写 comment（代理审片），永远推不动闸门。 */
export const HUMAN_DECISIONS = Object.freeze(['approve', 'reject', 'waive']);
export const SOURCE_KINDS = Object.freeze(['session', 'chat', 'im', 'email', 'meeting', 'document', 'other']);
export const VERDICTS = Object.freeze(['pass', 'fail', 'note']);

export const RUBRIC_DIMENSIONS = Object.freeze({
  style: '画风与质感',
  subject: '主体与构图',
  camera: '镜头与连续性',
  motion: '动作与表演',
  rhythm: '节奏与声音',
  text: '文字与信息',
});
export const VETOES = Object.freeze({
  'edge-exposed': '底板露边或截断边',
  'frame-defect': '断帧、跳帧、黑帧或意外静帧',
  flicker: '闪烁或拍内跳变',
  'text-defect': '文字越出安全区、缺字或读不完',
  'look-missing': '承诺的画风层缺失（墨线、笔触、纸纹等没出来）',
  'av-desync': '声画不同步（超出同步容差）',
  'rights-issue': '素材、字体、IP 的权利问题',
});
export const ISSUE_LAYERS = Object.freeze({
  model: '造型', material: '材质与着色', lighting: '灯光', plate: '底板', post: '后期',
  performance: '动作与表演', camera: '镜头与运镜', edit: '剪辑与节奏', overlay: '显示层', text: '文字', sound: '声音', tech: '技术与编码',
});
export const ISSUE_PRIORITIES = Object.freeze(['P0', 'P1', 'P2', 'P3']);
export const ISSUE_STATUSES = Object.freeze(['open', 'fixed', 'verified', 'wontfix']);

const PLACEHOLDER_QUOTES = [
  /\{\{[^}]*\}\}/, /^<[^>]*>$/, /^[（(\[【].*[）)\]】]$/,
  /^(todo|tbd|tbc|n\/a|na|null|none|undefined|placeholder|xxx+|-+|—+|…+|\.{3,}|待补|待填|待定|略|无|空|示例|样例|原话|用户原话|用户的原话)$/i,
  /^(代理检查通过|代理审片通过|自检通过|ai\s*审片通过|agent\s*(approved|checked))[。.!！]?$/i,
];

export function isPlaceholderQuote(text) {
  if (typeof text !== 'string' || !text.trim()) return true;
  const t = text.trim();
  return PLACEHOLDER_QUOTES.some(re => re.test(t));
}
