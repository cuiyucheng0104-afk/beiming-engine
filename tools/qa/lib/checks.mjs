// 北冥 QA · 检查项登记与结果对象。每一项检查有固定 id、硬 / 软级别和一句话说明；
// docs/quality/QA-GATE.md 必须逐项写到（tools/repo-check/rules/qa 会核对），新增检查先在这里登记。
//
//   CHECKS                        id → { group, severity: 'hard' | 'soft', title }
//   makeCheck(id, { expected })   → { id, group, title, severity, status, value, expected, evidence, findings, message, hint }
//   finding(check, f)             记一条发现：{ key, target?, frames?: [a, b), at?, message, detail?, status? }；
//                                 status 缺省按检查级别取 fail（硬门）或 warn（软项）
//   settle(check, fallback)       由发现重算状态（fail > warn > waived > pass）
import { statusOf } from './waivers.mjs';

export const CHECKS = {
  'delivery.container': { group: 'delivery', severity: 'hard', title: '容器能解析，是 MP4 / MOV，只有一条视频流' },
  'delivery.decode': { group: 'delivery', severity: 'hard', title: '用 -xerror 完整解码画面与声音，没有解码错误' },
  'delivery.frame-count': { group: 'delivery', severity: 'hard', title: '实际解码帧数等于作品描述的 frameCount' },
  'delivery.frame-rate': { group: 'delivery', severity: 'hard', title: 'r_frame_rate 与 avg_frame_rate 都等于档位帧率' },
  'delivery.cfr': { group: 'delivery', severity: 'hard', title: '视频时间戳严格等间隔（恒定帧率）' },
  'delivery.duration': { group: 'delivery', severity: 'hard', title: '视频时长等于 帧数 ÷ 帧率（误差不超过 1 帧）' },
  'delivery.size': { group: 'delivery', severity: 'hard', title: '宽高等于档位且为偶数' },
  'delivery.sar': { group: 'delivery', severity: 'hard', title: '方形像素（SAR 1:1）' },
  'delivery.codec': { group: 'delivery', severity: 'hard', title: 'H.264；High 档次与 Level 上限为软项' },
  'delivery.pix-fmt': { group: 'delivery', severity: 'hard', title: '像素格式 yuv420p（不是全范围的 yuvj420p）' },
  'delivery.color': { group: 'delivery', severity: 'hard', title: '色彩标注：范围 tv，矩阵、原色、传递函数都是 BT.709' },
  'delivery.range-pixels': { group: 'delivery', severity: 'soft', title: '标成有限范围时，像素也确实落在 16–235（只改标签不改像素会被抓到）' },
  'delivery.audio-stream': { group: 'delivery', severity: 'hard', title: '音轨：AAC-LC、48 kHz、立体声' },
  'delivery.av-align': { group: 'delivery', severity: 'hard', title: '音画首尾对齐：起点差、终点差都不超过 1 帧' },
  'delivery.loudness': { group: 'delivery', severity: 'hard', title: '最终文件的积分响度在档位目标 ± 容差内（ebur128）' },
  'delivery.true-peak': { group: 'delivery', severity: 'hard', title: '最终文件的真峰值不高于档位上限（4 倍过采样）' },
  'delivery.faststart': { group: 'delivery', severity: 'soft', title: '网页档 moov 在 mdat 之前（faststart）' },
  'delivery.aigc-label': { group: 'delivery', severity: 'hard', title: '含 AI 生成画面时，mp4 comment 元数据有 AIGC 标识（D11）' },
  'visual.black': { group: 'visual', severity: 'hard', title: '没有未声明的黑场' },
  'visual.freeze': { group: 'visual', severity: 'hard', title: '没有未声明的静帧（≥ 档位 freezeMinSec 的整帧不动）' },
  'visual.flicker': { group: 'visual', severity: 'hard', title: '没有闪帧：逐帧平均亮度与前后 5 帧中值之差不超过阈值（切点除外）' },
  'visual.cuts': { group: 'visual', severity: 'hard', title: '检出的切点与镜头表一一对应（±1 帧）；多出的切点是硬失败，漏检是软项' },
  'visual.jumps': { group: 'visual', severity: 'soft', title: '镜头内没有异常的帧差尖峰（疑似跳帧）' },
  'visual.flash-rate': { group: 'visual', severity: 'soft', title: '大面积闪烁每秒不超过 3 次（ITU-R BT.1702 的近似筛查）' },
  'visual.edge-clear': { group: 'visual', severity: 'soft', title: '画面边缘没有清屏色（黑）露出（疑似底板没盖满）' },
  'visual.edge-line': { group: 'visual', severity: 'soft', title: '没有贯穿画面高度 30% 以上的笔直竖向断层（疑似底板截断边）' },
  'texts.contract': { group: 'texts', severity: 'soft', title: '页面按约定提供 window.TEXTS，格式正确；没有外网请求' },
  'texts.inframe': { group: 'texts', severity: 'hard', title: '文字方框完整在画内' },
  'texts.safe-area': { group: 'texts', severity: 'hard', title: '文字在图文安全区内（按档位）' },
  'texts.duration': { group: 'texts', severity: 'hard', title: '不透明度 ≥ 90% 的连续停留 ≥ max(0.8 秒, 字数×0.12 秒)；导演规范的读字时长为软项' },
  'texts.contrast': { group: 'texts', severity: 'hard', title: '文字与背景对比度 ≥ 3:1（开、关文字各渲一次取背景）；低于 4.5:1 为软项' },
  'texts.glyphs': { group: 'texts', severity: 'hard', title: '每个字都在声明的网页字体 cmap 里，没有回退到系统字体' },
  'sync.events': { group: 'sync', severity: 'hard', title: '要求有声的事件，起音落在同步容差内（声音晚 0–1 帧、早不超过 0.25 帧）' },
  'known-issues.open': { group: 'report', severity: 'hard', title: '本作品在已知问题台账里没有未放行的 P0 / P1' },
};

export function makeCheck(id, { expected = null } = {}) {
  const c = CHECKS[id];
  if (!c) throw new Error(`未登记的检查 ${id}`);
  return { id, group: c.group, title: c.title, severity: c.severity, status: 'pass', value: null, expected, evidence: {}, findings: [], message: '', hint: null };
}

export function finding(check, f) {
  const status = f.status || (check.severity === 'hard' ? 'fail' : 'warn');
  const item = { key: f.key || check.id, status, message: f.message };
  if (f.target !== undefined) item.target = f.target;
  if (f.frames) item.frames = f.frames;
  if (f.at !== undefined) item.at = f.at;
  if (f.detail !== undefined) item.detail = f.detail;
  if (f.hint) item.hint = f.hint;
  check.findings.push(item);
  return item;
}

export function settle(check, fallback = 'pass') {
  check.status = statusOf(check.findings, fallback);
  if (!check.message) {
    const bad = check.findings.filter(f => f.status === 'fail' || f.status === 'warn');
    check.message = bad.length ? bad.slice(0, 3).map(f => f.message).join('；') + (bad.length > 3 ? `；另有 ${bad.length - 3} 条` : '') : '';
  }
  return check;
}

// 不能执行时：硬门记 fail，软项记 warn，并写清原因
export function notRun(check, why, hint = null) {
  finding(check, { key: 'not-run', message: `未执行：${why}`, status: check.severity === 'hard' ? 'fail' : 'warn' });
  check.evidence.notRun = true;
  if (hint) check.hint = hint;
  return settle(check);
}
