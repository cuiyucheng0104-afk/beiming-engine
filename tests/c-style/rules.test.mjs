// repo-check 路线 C 规则（tools/repo-check/rules/route-c/*.mjs）的测试：按框架的加载器能加载；仓库现状全部通过；坏样本能被抓出来。
// 坏样本放在临时目录里，用框架的 createContext 造上下文，不碰真实仓库。
// 运行：node --test "tests/c-style/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../../tools/repo-check/core/loader.mjs';
import { createContext } from '../../tools/repo-check/core/context.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IDS = ['route-c.fonts', 'route-c.manual', 'route-c.replicate', 'route-c.styles-fresh', 'route-c.styles-provenance', 'route-c.template'];
const { rules, problems } = await loadRules(path.join(ROOT, 'tools/repo-check/rules'));
const rule = id => rules.find(r => r.id === id);

test('框架加载器：路线 C 的 6 条规则都能加载，文件没有导出问题', () => {
  assert.deepEqual(rules.filter(r => r.domain === 'route-c').map(r => r.id).sort(), IDS);
  assert.deepEqual(problems.filter(p => p.file.includes('/route-c/')), []);
});

test('仓库现状：check:repo --only route-c 里路线 C 的规则全部通过（别的域的加载问题不算在这里）', () => {
  const r = spawnSync(process.execPath, ['tools/repo-check.mjs', '--only', 'route-c', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  const env = JSON.parse(r.stdout);
  const mine = env.data.rules.filter(x => x.id.startsWith('route-c.'));
  assert.deepEqual(mine.map(x => x.id).sort(), IDS);
  const bad = env.data.findings.filter(f => String(f.rule).startsWith('route-c.') && f.level === 'error');
  assert.deepEqual(bad, []);
});

function fakeRoot(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'route-c-rule-'));
  for (const [f, txt] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), txt); }
  return { root: d, ctx: createContext({ root: d }), done: () => fs.rmSync(d, { recursive: true, force: true }) };
}
const messages = fs_ => fs_.map(f => f.message).join('\n');

test('route-c.template：抓出 $LIB / .venv、/core/、无种子随机、写死的速度、缺 window.FPS、v1 film.json、缺署名、字体不在', async () => {
  const t = fakeRoot({
    'routes/c-style/template/film.js': "const r = Math.random();\nimport x from \"/core/lib.js\";\nexport const FONTS = [{ family: 'X', manifest: '../../routes/c-style/fonts/fonts.json' }];\n",
    'routes/c-style/template/mix.py': 'PY = "$LIB/.venv/bin/python"\n',
    'routes/c-style/template/timeline.js': "const SECS = [{ id: 'A', t0: 0, bpm: 90, meter: 4 }];\n",
    'routes/c-style/template/main.js': 'window.DUR = 1;\n',
    'routes/c-style/template/film.json': JSON.stringify({ route: 'c', title: '{{TITLE}}', dur: 8, fps: 24, size: [1920, 1080], poster: 7.5 }),
  });
  try {
    const msgs = messages(await rule('route-c.template').run(t.ctx));
    for (const re of [/Math\.random/, /\/core\//, /\$LIB 或 \.venv/, /没有从 film\.json 读时间/, /写死了速度/, /window\.FPS/, /v2/, /aigc/, /credits/, /不写 poster/, /fonts\.json 不存在/]) assert.match(msgs, re);
  } finally { t.done(); }
});

test('route-c.manual：抓出缺定义、缺警示、一概而论的旧说法、不存在的风格 id、缺来源头与 py.mjs', async () => {
  const t = fakeRoot({
    'routes/c-style/README.md': '# C\n还原出来的源码不能直接用北冥的 `engine/render/*` 渲。\n看 `lemo/no-such-style`。\n',
    'routes/c-style/styles.json': JSON.stringify({ styles: [{ id: 'lemo/ink-wash' }] }),
  });
  try {
    const found = await rule('route-c.manual').run(t.ctx);
    const msgs = messages(found);
    for (const re of [/不是第三个 GPU 后端/, /setup\.sh/, /一概而论/, /lemo\/no-such-style/, /DIRECTOR/, /licensing\.md/, /py\.mjs/, /ENVIRONMENT/]) assert.match(msgs, re);
    assert.equal(found.find(f => /一概而论/.test(f.message)).line, 2);
  } finally { t.done(); }
});

test('route-c.replicate：缺说明文件时报错并给出下一步', async () => {
  const t = fakeRoot({ 'x.txt': '' });
  try {
    const f = await rule('route-c.replicate').run(t.ctx);
    assert.equal(f.length, 1);
    assert.equal(f[0].level, 'error');
    assert.match(f[0].hint, /c-runtime setup/);
  } finally { t.done(); }
});

test('route-c.fonts：分片被改过时报 sha256 不符，缺许可文本时报 OFL', async () => {
  const src = path.join(ROOT, 'routes/c-style/fonts');
  const t = fakeRoot({});
  try {
    fs.cpSync(src, path.join(t.root, 'routes/c-style/fonts'), { recursive: true });
    fs.mkdirSync(path.join(t.root, 'tools'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'tools/lib'), path.join(t.root, 'tools/lib'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'tools/qa/lib'), path.join(t.root, 'tools/qa/lib'), { recursive: true });
    const ctx = createContext({ root: t.root });
    assert.equal((await rule('route-c.fonts').run(ctx))[0].level, 'info');
    const f0 = path.join(t.root, 'routes/c-style/fonts/mashanzheng-03.woff2');
    fs.appendFileSync(f0, Buffer.from([0]));
    fs.rmSync(path.join(t.root, 'routes/c-style/fonts/OFL.txt'));
    const msgs = messages(await rule('route-c.fonts').run(createContext({ root: t.root })));
    assert.match(msgs, /mashanzheng-03\.woff2 的 sha256/);
    assert.match(msgs, /OFL\.txt 缺失/);
  } finally { t.done(); }
});
