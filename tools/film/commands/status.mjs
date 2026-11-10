// 北冥仓库 · film status：一部作品现在在哪一步——闸门、各类运行最近一次的结果、下一步命令。只读。
// 「已交付（用户已认可）」只在最近一次终渲的 run.json 是 accepted 时出现（决定 D08）；其余情况分三件事写：已输出 / 技术检查 / 人工认可。
import path from 'node:path';
import { rel } from '../lib/repo.mjs';
import { loadFilm } from '../lib/spec.mjs';
import { GATES, GATE_LABEL, STATE_LABEL, gateStatus, passes } from '../lib/gates.mjs';
import { listRuns, readLatest, jobOf } from '../lib/rundir.mjs';
import { envelope } from '../lib/output.mjs';

export const statusSpec = {
  positionals: [{ name: '作品目录', describe: '作品目录，例如 films/my-film（相对当前目录）', required: true }],
  options: {
    '--out-root': { type: 'string', arg: '<目录>', help: '运行目录的上层（默认 <作品>/out）' },
  },
};

export const STATUS_DOC = {
  summary: '一部作品现在在哪一步：闸门、各类运行最近一次的结果、下一步命令（只读）',
  usage: ['npm run film -- status <作品目录> [--out-root <目录>] [--json]'],
  description: [
    '闸门状态（look → animatic → final）、最近一次 stills / animatic / build / render 的结果与产物、下一步命令。',
    '「已交付（用户已认可）」只在最近一次终渲的 run.json 是 accepted 时出现；其余情况分三件事写：已输出 / 技术检查 / 人工认可。',
  ],
  examples: ['npm run film -- status films/my-film'],
  exitCodes: { 0: '成功', 2: '用法错误' },
};


export function deliveryState(run) {
  if (!run) return { output: false, technical: 'not-run', creative: 'not-reviewed', delivered: false };
  return {
    output: ['passed', 'accepted'].includes(run.status), technical: run.technicalAcceptance?.status || 'not-run',
    creative: run.creativeAcceptance?.status || 'not-reviewed', delivered: run.status === 'accepted',
  };
}

export async function statusCommand(opts, positionals) {
  const film = loadFilm(positionals[0]);
  const outRoot = opts.outRoot ? path.resolve(opts.outRoot) : film.outRoot;
  const gates = await gateStatus(film);
  const runs = listRuns(outRoot);
  const latest = {};
  for (const k of ['stills', 'animatic', 'build', 'render']) {
    const id = readLatest(outRoot, k);
    const r = runs.find(x => x.id === id);
    latest[k] = r ? { id: r.id, dir: rel(r.dir), status: r.run?.status, final: !!r.run?.final, technical: r.run?.technicalAcceptance?.status || null, creative: r.run?.creativeAcceptance?.status || null, outputs: (r.run?.outputs || []).map(o => o.path) } : null;
  }
  const lastFinal = runs.find(x => jobOf(x.run) === 'build' && x.run?.final && ['passed', 'accepted'].includes(x.run?.status)) || null;
  const failedLast = runs[0]?.run && ['failed', 'blocked'].includes(runs[0].run.status) ? { id: runs[0].id, kind: jobOf(runs[0].run), status: runs[0].run.status, error: runs[0].run.error } : null;
  const d = film.relDir;
  let next;
  if (gates.look.required && !passes(gates.look)) next = latest.stills ? `把 ${latest.stills.dir}/contact.jpg 给用户看，按原话记录：npm run film -- review approve look ${d} --quote … --source … --reviewer …` : `出风格关键帧：npm run film -- stills ${d}`;
  else if (gates.animatic.required && !passes(gates.animatic)) next = latest.animatic ? `把 ${latest.animatic.dir}/animatic.mp4 给用户看，按原话记录：npm run film -- review approve animatic ${d} --quote … --source … --reviewer …` : `出动态预演：npm run film -- animatic ${d}`;
  else if (!lastFinal) next = `终渲：npm run film -- build ${d} --final`;
  else if (lastFinal.run.status !== 'accepted') {
    next = lastFinal.run.technicalAcceptance?.status !== 'passed' ? `机器 QA 未通过或未运行：看 ${rel(lastFinal.dir)}/qa/，修好后重新终渲`
      : lastFinal.run.creativeAcceptance?.status === 'accepted' ? `用户的认可已记下，但运行记录还不能标为 accepted（看 ${rel(lastFinal.dir)}/run.json 的 warnings）：补 --events <事件 id> 或 --style-ref <风格对照依据> 后再记一次 npm run film -- review approve final ${d} …；在那之前不要对外称「已交付」`
        : `成片给用户看，按原话记录：npm run film -- review approve final ${d} --quote … --source … --reviewer …`;
  }
  else next = '已交付（用户已认可）。改动后要重新走 animatic / final 闸。';
  const fs = deliveryState(lastFinal?.run);
  const lines = [
    `${film.title}（${film.relDir}，${film.routeInfo.brand}）· ${film.width}×${film.height}@${film.fps} · ${film.frameCount} 帧${film.profileId ? ` · 档位 ${film.profileId}` : ''}`,
    '闸门：',
    ...GATES.map(g => `  ${GATE_LABEL[g].padEnd(14)} ${gates[g].required ? '必审' : '可选'}  ${STATE_LABEL[gates[g].state] || gates[g].state}${gates[g].at ? `  ${gates[g].at}` : ''}${gates[g].quote ? `  「${gates[g].quote}」` : ''}${['stale', 'rejected'].includes(gates[g].state) && gates[g].reason ? `  ${gates[g].reason}` : ''}`),
    '最近运行：',
    ...['stills', 'animatic', 'build', 'render'].map(k => `  ${k.padEnd(9)} ${latest[k] ? `${latest[k].id}  ${latest[k].status}${latest[k].final ? '（终渲）' : ''}  技术 ${latest[k].technical || '-'}` : '—'}`),
    failedLast ? `最近一次失败：${failedLast.id}（${failedLast.kind}，${failedLast.status}）${failedLast.error?.message ? `：${failedLast.error.message}` : ''}` : null,
    gates.invalid?.length ? `⚠ ${gates.invalid.length} 条闸门记录不合格、不放行任何闸：${gates.invalid.slice(0, 3).map(x => `${x.file}（${x.problems.join('；')}）`).join('、')}` : null,
    `终渲状态：${lastFinal ? `${lastFinal.id} · 已输出 ✓ · 技术检查 ${fs.technical} · 人工认可 ${fs.creative}${fs.delivered ? ' · 已交付（用户已认可）' : ''}` : '还没有终渲'}`,
    `下一步：${next}`,
  ].filter(Boolean);
  return {
    env: envelope({ command: 'film status', outputs: [], runJson: lastFinal ? rel(path.join(lastFinal.dir, 'run.json')) : null, warnings: (gates.invalid || []).map(x => ({ code: 'review-invalid', message: `${x.file}：${x.problems.join('；')}` })), data: { film: d, title: film.title, route: film.route, gates, gateRecordsBy: gates.by, invalidRecords: gates.invalid || [], latest, lastFinal: lastFinal ? { id: lastFinal.id, ...fs } : null, lastFailure: failedLast, next } }),
    human: lines.join('\n'),
  };
}
