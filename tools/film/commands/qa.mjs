// 北冥仓库 · film qa：对一次已经出好的片子补跑 / 重跑机器 QA 门（tools/qa/cli.mjs report），不重渲任何东西。
//   默认审 out/latest 指的那次完整出片；--run <run-id> 指定别的。报告写进 <运行目录>/qa/report.json，
//   并更新那次的 run.json：technicalAcceptance 与 status（passed / failed），附一条 qaRuns 记录。
// 适用：QA 门晚于出片合入、改了 QA 阈值或豁免台账后复核、build 时加了 --no-qa。
// 退出码：0 通过 · 2 用法错误 · 3 QA 门不可用或缺环境 · 4 硬门不过 · 5 作品正被另一次运行占用。
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, FilmError, usage } from '../lib/exit.mjs';
import { rel } from '../lib/repo.mjs';
import { loadFilm } from '../lib/spec.mjs';
import { resolveProfile } from '../lib/profiles.mjs';
import { readLatest, acquireLock, writeAtomic, jobOf } from '../lib/rundir.mjs';
import { exec, isolatedEnv, killAll } from '../lib/proc.mjs';
import { runQa } from '../lib/qa.mjs';
import { envelope } from '../lib/output.mjs';
import { onInterrupt } from '../lib/session.mjs';

export const qaSpec = {
  positionals: [{ name: '作品目录', describe: '作品目录，例如 films/my-film（相对当前目录）', required: true }],
  options: {
    '--run': { type: 'string', arg: '<run-id>', help: '审哪一次出片（默认 out/latest）' },
    '--out-root': { type: 'string', arg: '<目录>', help: '运行目录的上层（默认 <作品>/out）' },
    '--timeout': { type: 'int', min: 10, arg: '<秒>', help: 'QA 的超时（默认 900）' },
  },
};

export const QA_DOC = {
  summary: '对一次已经出好的片子补跑机器 QA 门（node tools/qa/cli.mjs report），不重渲',
  usage: ['npm run film -- qa <作品目录> [--run <run-id>] [--json]'],
  description: [
    '默认审 out/latest 指的那次完整出片；--run 指定别的。报告写进 <运行目录>/qa/（report.json、report.md、contact.jpg），',
    '并回写那次的 run.json（technicalAcceptance、status）。适用：改了 QA 阈值或豁免台账后复核、build 时加了 --no-qa。',
  ],
  examples: ['npm run film -- qa films/my-film', 'npm run film -- qa films/my-film --run 20261110-120000-abcdef12'],
  exitCodes: { 0: '通过', 2: '用法错误', 3: 'QA 门不可用或缺环境', 4: '硬门不过', 5: '作品正被另一次运行占用', 124: '超时', 130: '收到 SIGINT，已清理', 143: '收到 SIGTERM，已清理' },
};

export async function qaCommand(opts, positionals) {
  const film = loadFilm(positionals[0]);
  const outRoot = opts.outRoot ? path.resolve(opts.outRoot) : path.join(film.dir, 'out');
  const id = opts.run || readLatest(outRoot, 'build');
  if (!id) throw new FilmError(EXIT.CONTRACT, 'nothing-to-qa', `${film.relDir} 还没有完整出过片（out/latest 为空）`, `先出片：npm run film -- build ${film.relDir}`);
  const dir = path.join(outRoot, id);
  const runFile = path.join(dir, 'run.json');
  let run;
  try { run = JSON.parse(fs.readFileSync(runFile, 'utf8')); } catch { throw usage(`找不到运行 ${id}（${rel(runFile)}）`, `可用的运行在 ${rel(outRoot)}/ 下；不给 --run 时用 out/latest`); }
  if (jobOf(run) !== 'build') throw usage(`运行 ${id} 是 ${jobOf(run)}，机器 QA 门只审完整出片（build）`);
  const master = path.join(dir, 'master.mp4');
  if (!fs.existsSync(master)) throw new FilmError(EXIT.CONTRACT, 'qa-no-master', `运行 ${id} 没有 master.mp4（outcome = ${run.outcome || '?'}）`, `重新出片：npm run film -- build ${film.relDir}`);
  const warnings = [];
  let profile;
  try { profile = resolveProfile(film, { override: run.profile?.custom ? null : run.profile?.id || null }, warnings); } catch { profile = { id: run.profile?.id, custom: !!run.profile?.custom }; }

  const lock = acquireLock(outRoot, { command: 'qa', kind: 'qa' }, warnings);
  const tmp = path.join(dir, 'work', `tmp-qa-${process.pid}`);
  const undo = onInterrupt(() => { fs.rmSync(tmp, { recursive: true, force: true }); lock.release(); });
  let r;
  try {
    const env = isolatedEnv(process.env, tmp);
    const run_ = (cmd, args, o = {}) => exec(cmd, args, { env, ...o });
    const frames = run.expected?.frames || film.frameCount;
    r = await runQa({ master, film, profile, runDir: dir, exec: run_, pageDir: film.route !== 'b' ? film.pageDir : null, timeoutSec: opts.timeout || Math.max(900, Math.round(frames * 1.5)) });
  } finally {
    await killAll().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
    lock.release();
    undo();
  }
  if (r.status === 'not-run') throw new FilmError(EXIT.ENV, r.reason || 'qa-missing', r.message, '检查 tools/qa/cli.mjs 是否完整（node tools/qa/cli.mjs --help）；修好后重跑 npm run film -- qa ' + film.relDir);

  // 回写 run.json：技术验收以这次 QA 为准；accepted 的运行不改 status（用户认可只能由 review 改）
  const at = new Date().toISOString();
  run.technicalAcceptance = r.technical ? { ...r.technical, by: `${r.technical.by}，film qa 补跑` } : { status: r.status === 'passed' ? 'passed' : 'failed', evidence: r.reportPath ? ['qa/report.json'] : [], by: 'node tools/qa/cli.mjs report（机器 QA 门，film qa 补跑）', summary: r.message, failed: r.failed || [] };
  if (run.status !== 'accepted') run.status = r.status === 'passed' ? (run.outcome === 'complete' ? 'passed' : 'blocked') : 'failed';
  else if (r.status !== 'passed') warnings.push({ code: 'accepted-qa-failed', message: `运行 ${id} 已是 accepted，但这次补跑的 QA 不通过：请如实告知用户，必要时重新终渲` });
  run.qaRuns = [...(run.qaRuns || []), { at, status: r.status, report: r.reportPath ? rel(r.reportPath) : null, by: 'film qa' }];
  writeAtomic(runFile, JSON.stringify(run, null, 2) + '\n');

  const outputs = [{ path: rel(r.reportPath), sha256: null, kind: 'qa-report' }, { path: rel(runFile), sha256: null, kind: 'run-json' }];
  const human = `${r.message}\n  报告    ${rel(r.reportPath)}\n  run.json ${rel(runFile)}（status = ${run.status}）`;
  if (r.status !== 'passed') {
    const e = new FilmError(EXIT.CONTRACT, 'qa-failed', r.message, `逐项见 ${rel(r.reportPath)}；改完重新出片：npm run film -- build ${film.relDir}`);
    e.outputs = outputs; e.runJson = rel(runFile); e.warnings = warnings;
    throw e;
  }
  return { env: envelope({ command: 'film qa', outputs, runJson: rel(runFile), warnings, data: { run: id, status: run.status, checks: r.report?.checks?.length ?? null } }), human };
}
