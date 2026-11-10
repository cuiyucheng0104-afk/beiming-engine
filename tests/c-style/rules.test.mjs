// repo-check 路线 C 规则（tools/repo-check/rules/route-c/index.mjs）的测试：仓库现状全部通过；坏样本能被抓出来。
// 运行：node --test "tests/c-style/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rules, domain } from '../../tools/repo-check/rules/route-c/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNNER = path.join(ROOT, 'tools/repo-check/rules/route-c/index.mjs');
const rule = id => rules.find(r => r.id === id);

test('插件接口：domain 与规则表', () => {
  assert.equal(domain, 'route-c');
  assert.deepEqual(rules.map(r => r.id), ['route-c.styles-fresh', 'route-c.styles-provenance', 'route-c.manual', 'route-c.template', 'route-c.replicate']);
  for (const r of rules) assert.equal(typeof r.run, 'function');
});

test('仓库现状：单独运行全部通过，退出码 0，--json 信封 ok', () => {
  const r = spawnSync(process.execPath, [RUNNER, '--json'], { cwd: ROOT, encoding: 'utf8' });
  const env = JSON.parse(r.stdout.trim());
  assert.equal(r.status, 0, JSON.stringify(env.result?.filter(x => x.findings.length), null, 1));
  assert.equal(env.ok, true);
  assert.equal(env.result.length, rules.length);
});

test('用法：--help 退出码 0，不认识的参数退出码 2', () => {
  assert.equal(spawnSync(process.execPath, [RUNNER, '--help'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, [RUNNER, '--bogus'], { encoding: 'utf8' }).status, 2);
});

function fakeRoot(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'route-c-rule-'));
  for (const [f, txt] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), txt); }
  return d;
}

test('route-c.template：抓出 $LIB / .venv、/core/、无种子随机、写死的速度、缺 window.FPS', async () => {
  const d = fakeRoot({
    'routes/c-style/template/film.js': 'const r = Math.random();\nimport x from "/core/lib.js";\n',
    'routes/c-style/template/mix.py': 'PY = "$LIB/.venv/bin/python"\n',
    'routes/c-style/template/timeline.js': "const SECS = [{ id: 'A', t0: 0, bpm: 90, meter: 4 }];\n",
    'routes/c-style/template/main.js': 'window.DUR = 1;\n',
  });
  try {
    const msgs = (await rule('route-c.template').run({ root: d })).map(f => f.message).join('\n');
    for (const re of [/Math\.random/, /\/core\//, /\$LIB 或 \.venv/, /没有从 film\.json 读时间/, /写死了速度/, /window\.FPS/]) assert.match(msgs, re);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('route-c.manual：抓出缺定义、缺警示、一概而论的旧说法、不存在的风格 id', async () => {
  const d = fakeRoot({
    'routes/c-style/README.md': '# C\n还原出来的源码不能直接用北冥的 `engine/render/*` 渲。\n看 `lemo/no-such-style`。\n',
    'routes/c-style/styles.json': JSON.stringify({ styles: [{ id: 'lemo/ink-wash' }] }),
  });
  try {
    const msgs = (await rule('route-c.manual').run({ root: d })).map(f => f.message).join('\n');
    for (const re of [/不是第三个 GPU 后端/, /setup\.sh/, /一概而论/, /lemo\/no-such-style/, /DIRECTOR/]) assert.match(msgs, re);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('route-c.replicate：缺说明文件时报错并给出下一步', async () => {
  const d = fakeRoot({ 'x.txt': '' });
  try {
    const f = await rule('route-c.replicate').run({ root: d });
    assert.equal(f.length, 1);
    assert.equal(f[0].level, 'error');
    assert.match(f[0].hint, /c-runtime setup/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
