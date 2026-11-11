// 北冥仓库 · film plan：开渲前估算整片耗时与磁盘（只读：不写作品目录、不建运行目录）。
//   A / C 转调渲染器 v2 的 node engine/render/video.mjs <页面> --plan --json（P04：按正式路数各试渲几帧、按正式参数试编码，
//         推算总时长、成片体积与渲染时要的磁盘；可用空间不够 1.5 倍余量时退出码 3）。画幅、帧率、路数与出片（build）同一口径。
//   B 原生运行时没有估算接口：直接说明（用法错误），建议先出 --quality draft 的预演看耗时。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXIT, FilmError } from '../lib/exit.mjs';
import { ROOT, rel } from '../lib/repo.mjs';
import { loadFilm } from '../lib/spec.mjs';
import { resolveProfile, framesAt } from '../lib/profiles.mjs';
import { exec } from '../lib/proc.mjs';
import { onInterrupt } from '../lib/session.mjs';
import { envelope } from '../lib/output.mjs';

export const planSpec = {
  positionals: [{ name: '作品目录', describe: '作品目录，例如 films/my-film（相对当前目录）', required: true }],
  options: {
    '--profile': { type: 'string', arg: '<档位>', help: '按这个档位估算（默认 film.json 的 output.profile）' },
    '--workers': { type: 'int', arg: '<N>', min: 1, max: 32, help: '并行路数（默认 4，与 build 相同）' },
    '--page': { type: 'string', arg: '<目录>', help: '页面目录（默认作品目录）' },
  },
};

export const PLAN_DOC = {
  summary: '开渲前估算整片耗时与磁盘（A / C：转调 video.mjs --plan；只读）',
  usage: ['npm run film -- plan <作品目录> [--profile <档位>] [--workers N] [--json]'],
  description: [
    '按出片同一口径（档位的画幅与帧率、--workers 路数）起浏览器，各路试渲几帧并按正式参数试编码，推算总耗时、成片体积与渲染时要的磁盘。',
    '可用磁盘不够估算的 1.5 倍时退出码 3。不写作品目录、不建运行目录；试编码的临时文件放系统临时目录，结束即删。',
    'B 路线（原生运行时）没有估算接口：先出预演 npm run film -- animatic <作品目录> 看耗时。',
  ],
  examples: ['npm run film -- plan films/my-film', 'npm run film -- plan films/my-film --profile uhd-2160p24 --workers 8 --json'],
  exitCodes: { 0: '估算完成', 2: '用法错误（含 B 路线）', 3: '缺环境或磁盘不够', 4: '页面契约不满足', 124: '超时', 130: '收到 SIGINT，已清理', 143: '收到 SIGTERM，已清理' },
};

export async function planCommand(opts, positionals) {
  const film = loadFilm(positionals[0], { page: opts.page ? path.resolve(opts.page) : null });
  if (film.route === 'b') throw new FilmError(EXIT.USAGE, 'plan-native', 'B 路线的原生运行时没有估算接口', `先出预演看耗时：npm run film -- animatic ${film.relDir}`);
  const warnings = [...film.warnings];
  const profile = resolveProfile(film, { override: opts.profile || null }, warnings);
  const frames = framesAt(film, profile.fps, warnings);
  const workers = opts.workers || 4;
  const args = [path.join(ROOT, 'engine/render/video.mjs'), film.pageDir, '--plan', '--json', '--size', `${profile.width}x${profile.height}`, '--fps', String(profile.fps), '--workers', String(workers)];
  // 档位换了帧率时 video.mjs 拿作品目录 film.json 的帧数核对必然不符（与 build 同一处理，见 engine/render/build.mjs 的 videoArgs）
  if (profile.fps !== film.fps) args.push('--any-fps');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'film-plan-'));
  const undo = onInterrupt(() => fs.rmSync(tmp, { recursive: true, force: true }));
  let res;
  try {
    // --plan 的试编码临时文件放在 --out 所在目录：指到这次的临时目录，作品目录里不留东西
    res = await exec(process.execPath, [...args, '--out', path.join(tmp, 'plan.mp4')], {
      cwd: ROOT, quiet: true, timeoutSec: 600, stallSec: 300, okCodes: [0, 1, 2, 3, 4, 5, 124], label: '估算（video.mjs --plan）',
      env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
    });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); undo(); }
  let j = null;
  try { j = JSON.parse(res.stdout); } catch { /* 下面按失败处理 */ }
  if (!j) throw new FilmError(EXIT.RUN, 'plan-no-result', `video.mjs --plan 没有给出结果（退出码 ${res.code}）`, (res.stderr.trim().split('\n').at(-1) || '').slice(0, 300) || null);
  if (!j.ok) throw new FilmError(j.exitCode || EXIT.RUN, j.error?.code || 'plan-failed', `估算失败：${j.error?.message || `退出码 ${j.exitCode}`}`, j.error?.hint || null);
  const p = j.data?.plan || {};
  if (p.frames !== frames) warnings.push({ code: 'plan-frames', message: `估算按页面算出 ${p.frames} 帧，作品描述按档位是 ${frames} 帧：先跑 npm run film -- check ${film.relDir}` });
  const MB = b => (b == null ? '?' : `${(b / 2 ** 20).toFixed(0)} MB`);
  const human = [
    `估算 ${film.relDir}（档位 ${profile.id} ${profile.width}×${profile.height}@${profile.fps}，${p.frames} 帧，${p.lanes} 路）`,
    `  每路每帧约 ${p.perLaneFrameMs} ms（含几路争用、截图与编码）→ 整片约 ${p.estSeconds} 秒`,
    `  成片约 ${MB(p.estOutputBytes)}，渲染时要 ${MB(p.needBytes)} 磁盘${p.freeBytes != null ? `（可用 ${(p.freeBytes / 2 ** 30).toFixed(1)} GB）` : ''}`,
    `  GPU：${p.gpu || '未知'}${p.software ? '（软件渲染：正式出片会慢 5–15 倍，--gpu required 时退出码 3）' : ''}`,
    `  出片：npm run film -- build ${film.relDir}${opts.profile ? ` --profile ${profile.id}` : ''}${opts.workers ? ` --workers ${workers}` : ''}`,
  ].join('\n');
  return { env: envelope({ command: 'film plan', warnings: [...warnings, ...(j.warnings || [])], data: { film: film.relDir, route: film.route, profile: profile.id, frames, workers, plan: p, page: rel(film.pageDir) } }), human };
}
