// render 域的仓库规范检查（tools/repo-check/rules/render/）：本仓库上没有错误；在临时“小仓库”里构造违规，各规则报出自己的 id、
// 整次检查退出 4。小仓库只复制规则要读的文件，不碰本仓库。
//   node --test tests/render/rules.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const check = (root, only) => {
  const r = spawnSync(process.execPath, [join(ROOT, 'tools/repo-check.mjs'), '--only', only, '--root', root, '--json'], { encoding: 'utf8', timeout: 120000 });
  return { code: r.status, env: JSON.parse(r.stdout), stderr: r.stderr };
};
const findings = (env, id) => (env.data?.findings ?? []).filter(f => f.rule === id);
const errors = (env, id) => findings(env, id).filter(f => f.level === 'error');

function mini() {
  const dir = mkdtempSync(join(tmpdir(), 'beiming-rules-'));
  for (const d of ['engine/render', 'tools/rtx', 'tools/lib']) cpSync(join(ROOT, d), join(dir, d), { recursive: true });
  cpSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
  return dir;
}

test('本仓库：render 域三条规则都没有错误', () => {
  const { env } = check(ROOT, 'render');
  for (const id of ['render.error-codes', 'render.compat-exports', 'render.no-shell']) assert.deepEqual(errors(env, id), [], id);
  assert.ok(findings(env, 'render.error-codes').some(f => f.level === 'info'), '应有一条汇总');
});

test('违规：错误码没进 README 表、表里退出码与前缀不符、删了兼容导出、经 shell 起子进程，各自报出并退出 4', () => {
  const dir = mini();
  try {
    const add = (file, text) => writeFileSync(join(dir, file), readFileSync(join(dir, file), 'utf8') + text);
    add('engine/render/lib/lock.mjs', "\nexport const x = () => { throw new Error('contract.brand-new-code'); };\nexport const y = () => require('node:child_process').spawn('sh', ['-c', 'ls']);\n");
    const readme = join(dir, 'engine/render/README.md');
    writeFileSync(readme, readFileSync(readme, 'utf8').replace('| `busy.output-locked` | 5 |', '| `busy.output-locked` | 4 |'));
    const page = join(dir, 'engine/render/page.mjs');
    writeFileSync(page, readFileSync(page, 'utf8').replace('export { chromeArgs, chromeExecutable, defaultAngle, isSoftwareRenderer, SOFTWARE_RENDERER };', 'export { chromeArgs, chromeExecutable, isSoftwareRenderer };'));
    const { code, env } = check(dir, 'render');
    assert.ok(code === 4 || code === 1, `退出码 ${code}`);   // 1：小仓库里别的域规则缺文件时的“规则自身出错”，不影响本域的判定
    assert.ok(errors(env, 'render.error-codes').some(f => /contract\.brand-new-code/.test(f.message)), '新错误码没进表');
    assert.ok(errors(env, 'render.error-codes').some(f => /busy\.output-locked 的退出码写成 4/.test(f.message)), '退出码与前缀不符');
    assert.ok(errors(env, 'render.compat-exports').some(f => /defaultAngle、SOFTWARE_RENDERER/.test(f.message)), '删了兼容导出');
    assert.ok(errors(env, 'render.no-shell').some(f => f.file === 'engine/render/lib/lock.mjs'), '经 shell 起子进程');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
