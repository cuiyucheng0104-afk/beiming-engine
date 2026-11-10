// 北冥仓库 · 规范检查 · cases 域的共用件：运行被检查仓库里的 tools/casebook.py（经 tools/env 的统一 Python 入口）。
// 同一次检查里每条命令只跑一次（ctx.memo）。找不到 Python 或被检查的仓库没有 casebook.py 时返回 { skipped: 原因 }。
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolvePython, pythonEnv } from '../../../env/lib/python.mjs';

export async function runCasebook(ctx, args) {
  return ctx.memo(`casebook:${args.join(' ')}`, async () => {
    const script = path.join(ctx.root, 'tools', 'casebook.py');
    if (!fs.existsSync(script)) return { skipped: '被检查的仓库里没有 tools/casebook.py' };
    const py = await resolvePython({ root: ctx.root });
    if (!py.ok) return { skipped: `没有可用的 Python（${py.error}）`, hint: py.hint };
    const r = spawnSync(py.cmd, [...py.args, script, ...args, '--json', '--quiet'], {
      cwd: ctx.root, encoding: 'utf8', timeout: 110_000, maxBuffer: 64 << 20, env: pythonEnv(process.env, { root: ctx.root }), windowsHide: true,
    });
    if (r.error) return { skipped: `casebook.py 没能运行（${r.error.message}）` };
    let envelope = null;
    try { envelope = JSON.parse(r.stdout); } catch { envelope = null; }
    if (!envelope || typeof envelope !== 'object') return { crashed: `casebook.py ${args.join(' ')} 没有输出 JSON 信封（退出码 ${r.status}）：${(r.stderr || '').trim().split('\n').slice(-3).join(' / ')}` };
    return { envelope, stderr: r.stderr };
  });
}

/** 运行失败或跳过时统一的发现：跳过只给提示（环境不全不该让规范检查失败），没输出信封算规则自身出错。 */
export function notRun(res, file = 'tools/casebook.py') {
  if (res.crashed) throw new Error(res.crashed);
  return [{ level: 'warn', file, message: `跳过：${res.skipped}`, hint: res.hint || '装好 Python 后重跑：node tools/env/doctor.mjs 查看缺什么' }];
}
