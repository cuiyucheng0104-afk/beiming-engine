// 北冥仓库 · 检索范围测试（node --test tests/agent-layer）
// 测什么：根目录 .ignore 让 ripgrep（以及基于它的 Claude Code Grep / Glob）默认不搜 cases/ 下的归档与快照，
//         显式点名目录或 --no-ignore 时仍能搜到。验收口径见计划 P03：
//           rg -l 'window.render'               → cases/ 下 0 命中
//           rg --no-ignore -l 'window.render' cases → ≥ 200 个文件
// 找 ripgrep 的顺序：RG 环境变量 → PATH 里的 rg → Claude Code 自带的 ripgrep（以 argv0=rg 调用 claude 可执行文件）。
// 都找不到时跳过（CI 装 ripgrep 后即可跑）。只读。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function findRg() {
  const tries = [];
  if (process.env.RG) tries.push({ cmd: process.env.RG });
  tries.push({ cmd: 'rg' });
  for (const c of [process.env.CLAUDE_CODE_EXECPATH, 'claude'].filter(Boolean)) tries.push({ cmd: c, argv0: 'rg' });
  for (const t of tries) {
    const r = spawnSync(t.cmd, ['--version'], { encoding: 'utf8', argv0: t.argv0, timeout: 20000, windowsHide: true });
    if (r.status === 0 && /^ripgrep \d/.test(r.stdout)) return t;
  }
  return null;
}
const RG = findRg();
const skip = RG ? false : '找不到 ripgrep（设 RG=<rg 路径> 或安装 ripgrep）';

function rg(args) {
  const r = spawnSync(RG.cmd, args, { cwd: ROOT, encoding: 'utf8', argv0: RG.argv0, maxBuffer: 64 * 1024 * 1024, timeout: 120000, windowsHide: true });
  assert.ok(r.status === 0 || r.status === 1, `rg ${args.join(' ')} 出错（${r.status}）：${r.stderr}`);
  return r.stdout.split(/\r?\n/).filter(Boolean).map(s => s.replace(/\\/g, '/').replace(/^\.\//, ''));
}

test('默认检索：window.render 在 cases/ 下 0 命中，引擎与路线里照常命中', { skip }, () => {
  const hits = rg(['-l', '--fixed-strings', 'window.render', '.']);   // 显式给 .：rg 的 stdin 不是终端时，不给路径会去搜 stdin
  assert.deepEqual(hits.filter(h => h.startsWith('cases/')), [], '默认检索不应命中归档');
  assert.ok(hits.some(h => h.startsWith('engine/') || h.startsWith('routes/') || h.startsWith('src/')), `默认检索应命中引擎、路线或样片：${hits.join(', ')}`);
  assert.deepEqual(rg(['-l', '--fixed-strings', 'window.render', 'cases']), [], '只给 cases 目录时也跳过归档');
});

test('显式检索：--no-ignore 或直接点名快照目录时能搜到归档', { skip }, () => {
  const all = rg(['--no-ignore', '-l', '--fixed-strings', 'window.render', 'cases']);
  assert.ok(all.length >= 200, `rg --no-ignore -l window.render cases 应 ≥ 200 个文件，实际 ${all.length}`);
  assert.ok(rg(['-l', '--fixed-strings', 'window.render', 'cases/vendor']).length > 0, '点名 cases/vendor 应能搜到');
  assert.ok(rg(['-l', '--fixed-strings', 'window.render', 'cases/source']).length > 0, '点名 cases/source 应能搜到');
  assert.ok(rg(['--no-ignore-dot', '-l', '--fixed-strings', 'window.render', 'cases']).length >= 200, '--no-ignore-dot 只关 .ignore');
});

test('案例卡与目录说明仍在默认检索范围里；快照文件不在默认文件列表里', { skip }, () => {
  const files = rg(['--files', '.']);
  assert.ok(files.some(f => f.startsWith('cases/entries/')), 'cases/entries/ 应能搜到');
  assert.ok(files.includes('cases/vendor/README.md') === false, 'cases/vendor/ 整个目录默认跳过（README 按路径直接读）');
  assert.deepEqual(files.filter(f => f.startsWith('cases/source/') || f.startsWith('cases/vendor/') || f === 'cases/catalog.json'), []);
});
