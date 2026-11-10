// 北冥仓库 · film check：出片前的只读检查（不渲帧、不写作品目录、不建运行目录）。
//   1. 作品描述：转调 node engine/production/film.js check <作品> --json（P05，附录 C6 的 validateFilm）；它还不存在时退出码 3 并说明
//   2. A / C：页面契约探测（engine/render/events.mjs --probe --no-events：render 是函数、DUR 有限正数、round(DUR×fps) = 帧数、GPU 不是软件渲染）
//      B：原生预检（engine/render/native.mjs --check-only：运行时版本、工具与 media/ 素材）
//   3. 编排视图：路线、档位、帧数、镜头表能否标切点、闸门要求
// 退出码取最严重的一项：契约不过 4 > 缺环境 3 > 0。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXIT, FilmError } from '../lib/exit.mjs';
import { ROOT, rel, pythonBin } from '../lib/repo.mjs';
import { loadFilm, shotsAt } from '../lib/spec.mjs';
import { resolveProfile, framesAt } from '../lib/profiles.mjs';
import { exec } from '../lib/proc.mjs';
import { raeaInfo } from '../lib/native-steps.mjs';
import { envelope } from '../lib/output.mjs';
import { fmt } from './build.mjs';

export const checkSpec = {
  positionals: [{ name: '作品目录', required: true }],
  options: {
    '--profile': { type: 'string', arg: '<档位>', help: '按这个档位核对（默认 film.json 的 output.profile）' },
    '--page': { type: 'string', arg: '<目录>', help: '页面目录（默认作品目录）' },
    '--json': { type: 'bool', help: 'stdout 只输出一个 JSON 对象' },
    '--help': { type: 'bool', help: '只打印用法' },
  },
};

export const CHECK_HELP = `用法：npm run film -- check <作品目录> [--profile <档位>] [--page <目录>] [--json]
出片前的只读检查（不渲帧、不写作品目录、不建运行目录）：
  1. 作品描述  node engine/production/film.js check（P05 的校验器：镜头首尾相接、事件落在镜头内、引用存在、路线取自注册表…）
  2. 页面契约  A / C 打开页面等 READY，查 render / DUR / 帧数 / 软件渲染；B 跑 native.mjs --check-only
  3. 编排视图  路线、档位、帧数、切点、闸门要求
退出码：0 全部通过 · 3 缺环境（校验器、浏览器、RAEA_BIN…）· 4 契约不满足

选项：
${fmt(checkSpec.options)}`;

const P05 = path.join(ROOT, 'engine/production/film.js');

function parseLast(stdout) {
  const s = String(stdout || '').trim();
  try { return JSON.parse(s); } catch { /* 取最后一行 */ }
  const line = s.split('\n').filter(Boolean).at(-1);
  try { return JSON.parse(line); } catch { return null; }
}

export async function checkCommand(opts, positionals) {
  const film = loadFilm(positionals[0], { page: opts.page ? path.resolve(opts.page) : null });
  const warnings = [...film.warnings];
  const checks = [];
  const add = (id, status, message, extra = {}) => checks.push({ id, status, message, ...extra });

  // 1 作品描述（P05）
  if (fs.existsSync(P05)) {
    try {
      const r = await exec(process.execPath, [P05, 'check', film.dir, '--json'], { cwd: ROOT, quiet: true, timeoutSec: 120, okCodes: [0, 1, 2, 3, 4], label: 'engine/production/film.js check', sweep: false });
      const j = parseLast(r.stdout);
      const ok = r.code === 0 && (j ? j.ok !== false : true);
      add('spec', ok ? 'pass' : r.code === 3 ? 'env' : 'fail', ok ? '作品描述通过 P05 校验' : `作品描述校验不通过（退出码 ${r.code}）${j?.error?.message ? `：${j.error.message}` : ''}`, { exitCode: r.code, diagnostics: j?.diagnostics || j?.warnings || null });
    } catch (e) { add('spec', 'env', `作品描述校验器运行失败：${e.message}`); }
  } else {
    add('spec', 'env', '作品描述校验器 engine/production/film.js 还不存在（由 P05 提供）：这一项没有检查', { hint: 'P05·M0 合入后重跑；在那之前编排器只做最小检查（路线、帧数、画幅、镜头表）' });
  }

  // 3 编排视图
  let profile = null, frames = film.frameCount;
  try { profile = resolveProfile(film, { override: opts.profile || null }, warnings); frames = framesAt(film, profile.fps, warnings); add('profile', 'pass', `档位 ${profile.id}：${profile.width}×${profile.height}@${profile.fps}，${frames} 帧`); }
  catch (e) { add('profile', e.exitCode === EXIT.USAGE ? 'fail' : 'fail', e.message); }
  const shots = shotsAt(film, profile?.fps || film.fps);
  add('shots', shots.length > 1 || !shots[0].implicit ? 'pass' : 'info', shots[0].implicit ? '没有镜头表：联系表不标切点（v2 作品写 shots）' : `${shots.length} 个镜头，切点 ${shots.slice(1).map(s => s.in).join('、') || '无'}`);
  if (film.route === 'b' && profile && (profile.width !== film.width || profile.height !== film.height || profile.fps !== film.fps)) add('profile-native', 'fail', `档位 ${profile.id} 与 B 作品的 film.json 画幅帧率不一致（原生按 film.json 出片）`);

  // 2 页面契约 / 原生预检
  if (film.route === 'b') {
    const r = raeaInfo();
    if (!r.ok) add('native', 'env', r.reason === 'unset' ? '没有设 RAEA_BIN：B 路线的原生运行时不随仓库分发' : `RAEA_BIN 不可用（${r.reason}）`, { hint: '把 RAEA_BIN 设为运行时可执行文件的完整路径（版本 0.1.0-canary.2）' });
    else {
      try {
        const res = await exec(process.execPath, [path.join(ROOT, 'engine/render/native.mjs'), film.dir, '--check-only'], { cwd: ROOT, quiet: true, timeoutSec: 120, okCodes: [0, 1, 2, 3], label: 'native.mjs --check-only', sweep: false });
        const line = (res.stdout + res.stderr).trim().split('\n').filter(Boolean).slice(-1)[0] || '';
        add('native', res.code === 0 ? 'pass' : /media\/ 缺少/.test(res.stderr) ? 'fail' : 'env', res.code === 0 ? `原生预检通过（RAEA ${r.version}）` : `原生预检不通过：${line}`, res.code !== 0 && /media\/ 缺少/.test(res.stderr) ? { hint: `先准备素材：node engine/native/prepare.mjs ${film.relDir}（film build 会自动做）` } : {});
      } catch (e) { add('native', 'env', e.message); }
    }
  } else if (!fs.existsSync(path.join(film.pageDir, 'index.html'))) {
    add('page', 'fail', `页面目录 ${rel(film.pageDir)} 下没有 index.html`);
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'film-check-'));
    try {
      const pf = path.join(tmp, 'probe.json');
      const size = profile ? `${profile.width}x${profile.height}` : `${film.width}x${film.height}`;
      const res = await exec(process.execPath, [path.join(ROOT, 'engine/render/events.mjs'), film.pageDir, '--size', size, '--probe', pf, '--no-events'],
        { cwd: ROOT, quiet: true, timeoutSec: 300, stallSec: 240, okCodes: [0, 4], label: '页面探测', env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp } });
      const p = JSON.parse(fs.readFileSync(pf, 'utf8'));
      if (p.problems?.length) add('page', 'fail', `页面约定不满足：${p.problems.join('；')}`);
      else {
        const fps = profile?.fps || film.fps, got = Math.round(p.dur * fps);
        add('page', got === frames ? 'pass' : 'fail', got === frames ? `页面约定满足：DUR ${p.dur} 秒 = ${got} 帧，TEXTS ${p.hasTexts ? '有' : '无'}` : `页面 DUR ${p.dur} 秒 = ${got} 帧，作品描述要求 ${frames} 帧`, { dur: p.dur, hasTexts: p.hasTexts, evCount: p.evCount });
        add('gpu', p.software ? 'env' : 'pass', p.software ? `WebGL 落到了软件渲染（${String(p.gpu).slice(0, 80)}）` : `GPU：${p.gpu || '未知'}`, p.software ? { hint: 'macOS 设 BEIMING_ANGLE=metal，RTX 机器设 BEIMING_ANGLE=vulkan' } : {});
        if (p.fps && p.fps !== fps) add('page-fps', 'warn', `页面自报 ${p.fps} fps，档位是 ${fps} fps`);
        if (!p.hasTexts) add('texts', 'warn', '页面没有 window.TEXTS(t)：文字检查无从做起');
      }
    } catch (e) { add('page', e.exitCode === EXIT.TIMEOUT ? 'fail' : 'env', `页面探测失败：${e.message}`); }
    finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  // 闸门要求
  add('gates', 'info', `闸门：look ${film.gates.look === 'required' ? '必审' : '可选'}，animatic ${film.gates.animatic === 'required' ? '必审' : '可选'}，final 必审`);
  const worst = checks.some(c => c.status === 'fail') ? EXIT.CONTRACT : checks.some(c => c.status === 'env') ? EXIT.ENV : EXIT.OK;
  const err = worst === EXIT.OK ? null : new FilmError(worst, worst === EXIT.CONTRACT ? 'check-failed' : 'check-env', worst === EXIT.CONTRACT ? `检查不通过：${checks.filter(c => c.status === 'fail').map(c => c.id).join('、')}` : `检查没做全（缺环境）：${checks.filter(c => c.status === 'env').map(c => c.id).join('、')}`, checks.find(c => c.hint && c.status !== 'pass')?.hint || null);
  const mark = { pass: '✓', fail: '✗', env: '…', warn: '!', info: '·' };
  const human = [`检查 ${film.relDir}（${film.routeInfo.brand}）`, ...checks.map(c => `  ${mark[c.status]} ${c.id.padEnd(14)} ${c.message}`)].join('\n');
  return { env: envelope({ command: 'film check', exitCode: worst, error: err, warnings, data: { film: film.relDir, route: film.route, checks, python: pythonBin() } }), human, exitCode: worst };
}
