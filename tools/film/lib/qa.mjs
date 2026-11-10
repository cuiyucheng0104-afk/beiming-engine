// 北冥仓库 · 出片编排 · 机器 QA 门对接（tools/qa/cli.mjs，报告格式见附录 C8）。
//   runQa({ master, film, profile, runDir, exec, timeoutSec }) → { status: passed|failed|not-run, report, reportPath, technical, exitCode, failed[], warned[], message }
// 调用：node tools/qa/cli.mjs report <运行目录>/master.mp4 --film <作品>/film.json [--page <页面目录>] [--profile <档位>] --out <运行目录>/qa --json
//   report 跑全部检查组（交付规格、画面异常、文字、底板、声画同步，再加已知问题台账），写 qa/report.json、report.md、contact.jpg；
//   B 路线没有页面，文字与底板组由 QA 自己跳过并写明原因。
//   stdout 是 C2 信封：result 是 C8 报告本身，result.technicalAcceptance 是 QA 给的技术验收结论。
//   退出码：0 → passed；4 → failed（硬门不过，整个出片失败）；2 → 参数不匹配（编排器与 QA 版本不一致，按 not-run 并告警）；
//          3 → 缺环境（退出码 3）；124 → 超时；其余 → 运行失败。
// run.json 的 technicalAcceptance.evidence 写相对运行目录的 qa/report.json（作品描述包的运行记录校验器按运行目录解析）；
// 仓库相对路径另记在 technicalAcceptance.report。
// FILM_QA_CLI 可以指向另一个实现（测试用 tests/film/fixtures/qa-stub.mjs）。
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, FilmError } from './exit.mjs';
import { ROOT, rel } from './repo.mjs';

export function qaCli() {
  const f = process.env.FILM_QA_CLI ? path.resolve(process.env.FILM_QA_CLI) : path.join(ROOT, 'tools/qa/cli.mjs');
  return fs.existsSync(f) ? f : null;
}

function parseOut(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* 可能前面混了日志 */ }
  const i = s.lastIndexOf('\n{');
  if (i >= 0) { try { return JSON.parse(s.slice(i + 1)); } catch { /* 放弃 */ } }
  return null;
}

const isReport = j => j && Array.isArray(j.checks) && typeof j.ok === 'boolean';
const lastLine = s => String(s || '').trim().split('\n').filter(Boolean).slice(-1)[0] || '';

export function qaArgs({ master, film, profile, runDir, pageDir = null }) {
  const args = ['report', master, '--film', path.join(film.dir, 'film.json'), '--out', path.join(runDir, 'qa')];
  if (pageDir) args.push('--page', pageDir);
  if (profile && !profile.custom) args.push('--profile', profile.id);
  args.push('--json');
  return args;
}

export async function runQa({ master, film, profile, runDir, exec, timeoutSec = 900, pageDir = null }) {
  timeoutSec = Math.max(timeoutSec, 120);
  const cli = qaCli();
  if (!cli) return { status: 'not-run', reason: 'qa-missing', message: '机器 QA 门 tools/qa/cli.mjs 不存在，本次没有做技术验收' };
  const args = [cli, ...qaArgs({ master, film, profile, runDir, pageDir })];
  let res;
  try {
    // 文字与底板检查要逐帧跑页面，长片可能几分钟不出声：看门狗放宽到 15 分钟，总超时由调用方按帧数给
    res = await exec(process.execPath, args, { cwd: ROOT, label: 'QA（tools/qa/cli.mjs report）', timeoutSec, stallSec: 900, logFile: path.join(runDir, 'logs', 'qa.log'), quiet: true, okCodes: [0, 2, 3, 4] });
  } catch (e) {
    if (e instanceof FilmError && e.exitCode === EXIT.TIMEOUT) throw e;
    throw new FilmError(EXIT.RUN, 'qa-crashed', `机器 QA 门运行失败：${e.message}`, `完整输出见 ${rel(path.join(runDir, 'logs', 'qa.log'))}；修好后 npm run film -- qa ${film.relDir} 补跑`);
  }
  const out = parseOut(res.stdout);
  const err = out?.error ? `${out.error.message}${out.error.hint ? `（${out.error.hint}）` : ''}` : lastLine(res.stderr);
  if (res.code === 2) return { status: 'not-run', reason: 'qa-usage-mismatch', message: `QA 不接受编排器给的参数（退出码 2）：${err}`, exitCode: 2 };
  if (res.code === 3) {
    throw new FilmError(EXIT.ENV, 'qa-env', `机器 QA 门缺环境（退出码 3）：${err}`, `按提示补齐后补跑：npm run film -- qa ${film.relDir}；体检：npm run env:doctor`);
  }
  const report = isReport(out?.result) ? out.result : isReport(out) ? out : null;
  const qaDir = path.join(runDir, 'qa');
  fs.mkdirSync(qaDir, { recursive: true });
  const reportPath = path.join(qaDir, 'report.json');
  if (!report) {
    fs.writeFileSync(path.join(qaDir, 'qa-stdout.txt'), res.stdout);
    return { status: res.code === 0 ? 'not-run' : 'failed', reason: 'qa-report-missing', message: `QA 退出码 ${res.code}，但没有给出 C8 格式的报告（原始输出存在 ${rel(path.join(qaDir, 'qa-stdout.txt'))}）`, exitCode: res.code };
  }
  // QA 自己写了 qa/report.json（--out）；测试替身只在 stdout 给报告时由这里补写
  if (!fs.existsSync(reportPath)) fs.writeFileSync(reportPath, JSON.stringify(report, null, 1) + '\n');
  const failed = report.checks.filter(c => c.status === 'fail');
  const ok = res.code === 0 && report.ok && !failed.length;
  const ta = report.technicalAcceptance && typeof report.technicalAcceptance === 'object' ? report.technicalAcceptance : null;
  const technical = {
    status: ok ? 'passed' : 'failed',
    evidence: ['qa/report.json'],
    report: rel(reportPath),
    by: 'node tools/qa/cli.mjs report（机器 QA 门）',
    qa: ta ? { status: ta.status ?? null, evidence: ta.evidence ?? [] } : null,
    summary: report.summary ? { pass: report.summary.pass ?? null, warn: report.summary.warn ?? null, fail: report.summary.fail ?? null, waived: report.summary.waived ?? null, hardFailures: report.summary.hardFailures ?? failed.map(c => c.id) } : null,
    skipped: Array.isArray(report.skipped) ? report.skipped : [],
    failed: failed.map(c => ({ id: c.id, value: c.value ?? null, expected: c.expected ?? null })),
  };
  return {
    status: ok ? 'passed' : 'failed', report, reportPath, exitCode: res.code, technical,
    outputs: Array.isArray(out?.outputs) ? out.outputs : [],
    failed: technical.failed,
    warned: report.checks.filter(c => c.status === 'warn').map(c => c.id),
    message: ok ? `QA 通过：${report.checks.length} 项（注意 ${report.checks.filter(c => c.status === 'warn').length} 项）` : `QA 硬门不通过：${failed.map(c => c.id).join('、') || `退出码 ${res.code}`}`,
  };
}
