// 北冥仓库 · 出片编排 · 机器 QA 门对接（P07 的 tools/qa/cli.mjs，报告格式见附录 C8）。
//   runQa({ master, film, profile, runDir, log, exec }) → { status: passed|failed|not-run, report, reportPath, reason, exitCode }
// 调用：node tools/qa/cli.mjs delivery <成片> --film <作品>/film.json [--profile <档位>] --json（与计划 7.3 H1 的判定命令同形）
//   stdout 可以是 C8 报告本身 { schemaVersion, film, input, profile, checks[], ok }，也可以是 C2 信封（outputs 里 kind 含 qa / report 的那一项是报告）
//   退出码：0 → passed；4 → failed（硬门不过）；2 → 参数不匹配（编排器与 QA 版本不一致，按 not-run 并告警）；其余 → 运行失败
// 报告统一落在 <运行目录>/qa/report.json，run.json 的 technicalAcceptance.evidence 指向它。
// FILM_QA_CLI 可以指向另一个实现（测试与集成用）；缺失时 status = not-run，由调用方决定是否允许（--final 不允许）。
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, FilmError } from './exit.mjs';
import { ROOT, rel } from './repo.mjs';

export function qaCli() {
  const f = process.env.FILM_QA_CLI ? path.resolve(process.env.FILM_QA_CLI) : path.join(ROOT, 'tools/qa/cli.mjs');
  return fs.existsSync(f) ? f : null;
}

function parseOut(stdout) {
  const s = stdout.trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* 可能前面混了日志 */ }
  const i = s.lastIndexOf('\n{');
  if (i >= 0) { try { return JSON.parse(s.slice(i + 1)); } catch { /* 放弃 */ } }
  return null;
}

const isReport = j => j && Array.isArray(j.checks) && typeof j.ok === 'boolean';

export async function runQa({ master, film, profile, runDir, exec, timeoutSec = 900 }) {
  timeoutSec = Math.max(timeoutSec, 60);
  const cli = qaCli();
  if (!cli) return { status: 'not-run', reason: 'qa-missing', message: '机器 QA 门 tools/qa/cli.mjs 还不存在（由 P07 提供），本次没有做技术验收' };
  const args = [cli, 'delivery', master, '--film', path.join(film.dir, 'film.json')];
  if (profile && !profile.custom) args.push('--profile', profile.id);
  args.push('--json');
  let res, code = 0;
  try {
    // QA 的文字检查要逐帧跑页面，长片可能几分钟不出声：看门狗放宽到 15 分钟，总超时由调用方按帧数给
    res = await exec(process.execPath, args, { cwd: ROOT, label: 'QA（tools/qa/cli.mjs delivery）', timeoutSec, stallSec: 900, logFile: path.join(runDir, 'logs', 'qa.log'), quiet: true, okCodes: [0, 4] });
    code = res.code;
  } catch (e) {
    if (e instanceof FilmError && e.details && (e.details.code === 2)) {
      return { status: 'not-run', reason: 'qa-usage-mismatch', message: `QA 不接受编排器给的参数（退出码 2）：${String(e.details.stderr || '').trim().split('\n').slice(-1)[0] || ''}`, exitCode: 2 };
    }
    if (e instanceof FilmError && e.details && e.details.code === 3) {
      throw new FilmError(EXIT.ENV, 'qa-env', `QA 缺环境（退出码 3）：${String(e.details.stderr || '').trim().split('\n').slice(-1)[0] || ''}`, '按 QA 的提示补齐依赖后重跑：node tools/film/cli.mjs build <作品> --from qa');
    }
    throw e;
  }
  const out = parseOut(res.stdout);
  let report = isReport(out) ? out : null;
  if (!report && out && Array.isArray(out.outputs)) {
    const o = out.outputs.find(x => /qa|report/i.test(String(x.kind || '')) || /report\.json$/.test(String(x.path || '')));
    if (o) {
      const p = path.isAbsolute(o.path) ? o.path : path.resolve(ROOT, o.path);
      try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); if (isReport(j)) report = j; } catch { /* 下面按缺报告处理 */ }
    }
    if (!report && isReport(out.report)) report = out.report;
  }
  const qaDir = path.join(runDir, 'qa');
  fs.mkdirSync(qaDir, { recursive: true });
  const reportPath = path.join(qaDir, 'report.json');
  if (!report) {
    fs.writeFileSync(path.join(qaDir, 'qa-stdout.json'), res.stdout);
    return { status: code === 0 ? 'not-run' : 'failed', reason: 'qa-report-missing', message: `QA 退出码 ${code}，但没有给出 C8 格式的报告（原始输出存在 ${rel(path.join(qaDir, 'qa-stdout.json'))}）`, exitCode: code };
  }
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  const failed = report.checks.filter(c => c.status === 'fail');
  const ok = code === 0 && report.ok && !failed.length;
  return {
    status: ok ? 'passed' : 'failed', report, reportPath, exitCode: code,
    failed: failed.map(c => ({ id: c.id, value: c.value ?? null, expected: c.expected ?? null })),
    warned: report.checks.filter(c => c.status === 'warn').map(c => c.id),
    message: ok ? `QA 通过：${report.checks.length} 项` : `QA 硬门不通过：${failed.map(c => c.id).join('、') || `退出码 ${code}`}`,
  };
}
