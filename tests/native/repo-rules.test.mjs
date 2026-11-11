// B 路线仓库规范规则（tools/repo-check/rules/route-b/，由 tools/repo-check.mjs 的加载器加载）：在本仓库上全部不报错；
// 在临时造的反例仓库上逐条抓到问题。只看 route-b 域的结论（别的域的规则文件好坏不归本包管）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../../tools/repo-check/core/loader.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RULES_DIR = join(ROOT, 'tools/repo-check/rules');
const check = root => {
  const r = spawnSync(process.execPath, [join(ROOT, 'tools/repo-check.mjs'), '--only', 'route-b', '--json', ...(root ? ['--root', root] : [])], { encoding: 'utf8', timeout: 120000 });
  const j = JSON.parse(r.stdout);
  const rules = Object.fromEntries(j.data.rules.filter(x => x.id.startsWith('route-b.')).map(x => [x.id, x]));
  const findings = j.data.findings.filter(f => f.rule?.startsWith('route-b.') || f.id?.startsWith('route-b.'));
  return { rules, findings, envelope: j };
};

test('加载器认得 route-b 的每个规则文件（一个文件一条规则，id 的域等于目录名）', async () => {
  const { rules, problems } = await loadRules(RULES_DIR);
  assert.deepEqual(problems.filter(p => p.file.includes('/route-b/')), []);
  const ids = rules.filter(r => r.domain === 'route-b').map(r => r.id).sort();
  const files = readdirSync(join(RULES_DIR, 'route-b')).filter(f => f.endsWith('.mjs') && !f.startsWith('_')).length;
  assert.equal(ids.length, files);
  assert.deepEqual(ids, ['route-b.aigc-label', 'route-b.cli-contract', 'route-b.film-module-imports', 'route-b.manual-boundary',
    'route-b.no-hardcoded-contract', 'route-b.no-runtime-distribution', 'route-b.runtime-lock', 'route-b.spawn-timeout']);
});

test('本仓库：B 路线规则没有错误；三平台可执行文件哈希都已锁定（runtime-lock 没有提示）', () => {
  const { rules, findings } = check(null);
  assert.equal(Object.keys(rules).length, 8);
  for (const r of Object.values(rules)) assert.notEqual(r.status, 'fail', `${r.id} 不通过`);
  assert.deepEqual(findings.filter(f => f.rule === 'route-b.runtime-lock' && f.level !== 'info'), []);
  assert.match(findings.find(f => f.rule === 'route-b.runtime-lock').message, /三平台都已锁定/);
});

test('锁里缺某个平台的可执行文件哈希：逐个提示，info 列出还没锁的平台（不说「已锁定」）', () => {
  const root = mkdtempSync(join(tmpdir(), 'bne-lock-'));
  try {
    const lock = JSON.parse(readFileSync(join(ROOT, 'engine/native/runtime.lock.json'), 'utf8'));
    lock.platforms['windows-x64'].binarySha256 = null;
    lock.platforms['linux-x64'].binarySha256 = null;
    mkdirSync(join(root, 'engine/native'), { recursive: true });
    mkdirSync(join(root, 'engine/render'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"t","private":true}');
    writeFileSync(join(root, 'engine/native/runtime.lock.json'), JSON.stringify(lock));
    writeFileSync(join(root, 'engine/render/native.mjs'), `export const VALIDATED = '${lock.version}';\n`);
    spawnSync('git', ['init', '-q'], { cwd: root, timeout: 30000 });
    spawnSync('git', ['add', '-A'], { cwd: root, timeout: 30000 });
    const { rules, findings } = check(root);
    assert.notEqual(rules['route-b.runtime-lock'].status, 'fail');
    const mine = findings.filter(f => f.rule === 'route-b.runtime-lock');
    assert.deepEqual(mine.filter(f => f.level === 'warn').map(f => f.message.split(' ')[0]).sort(), ['linux-x64', 'windows-x64']);
    const info = mine.find(f => f.level === 'info').message;
    assert.match(info, /已锁定 1 个平台，windows-x64、linux-x64 还没有/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('反例：写死契约、锁文件残缺、辅助模块越界 import、缺 aigc、直接 spawnSync、手册缺许可边界、入口不用命令约定库、运行时二进制入库都被抓到', () => {
  const root = mkdtempSync(join(tmpdir(), 'bne-rules-'));
  const put = (f, text) => { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), text); };
  try {
    put('package.json', '{"name":"t","private":true}');
    put('routes/b-native/template/film.json', JSON.stringify({ route: 'b', title: '{{TITLE}}', dur: 10, fps: 24, size: [1920, 1080], native: { images: [{ to: 'sky.png', from: '../../assets/plates/sky_dawn.png' }] } }));
    put('routes/b-native/template/film.tsx', "import { layout } from './layout.js';\nconst N = 240;\n");
    put('routes/b-native/template/layout.js', "import { shotAt } from '../../engine/native/view.js';\nexport const layout = () => shotAt;\n");
    put('routes/b-native/template/shader.wesl', 'fn main() {}\n');
    put('engine/render/native.mjs', "#!/usr/bin/env node\n// 入口\nconst a = ['-t 10'];\nexport const VALIDATED = '9.9.9';\n");
    put('engine/native/runtime.lock.json', JSON.stringify({ version: '0.1.0', license: 'MIT', platforms: {} }));
    put('engine/native/x.mjs', "import { spawnSync } from 'node:child_process';\nspawnSync('ffmpeg', []);\n");
    put('engine/native/bin/raea', 'binary');
    put('routes/b-native/README.md', '# B\n\n## 边界与常见坑\n\n- 没写许可\n');
    spawnSync('git', ['init', '-q'], { cwd: root, timeout: 30000 });
    spawnSync('git', ['add', '-A'], { cwd: root, timeout: 30000 });
    const { rules, envelope } = check(root);
    for (const id of ['route-b.no-hardcoded-contract', 'route-b.runtime-lock', 'route-b.film-module-imports', 'route-b.aigc-label', 'route-b.spawn-timeout',
      'route-b.manual-boundary', 'route-b.cli-contract', 'route-b.no-runtime-distribution']) assert.equal(rules[id]?.status, 'fail', `${id} 应当不通过`);
    assert.ok(rules['route-b.no-hardcoded-contract'].errors >= 2, '模版里的 240 与入口里的 -t 10 都要报');
    assert.ok(rules['route-b.no-runtime-distribution'].errors >= 2, '运行时二进制入库与 .wesl 源文件都要报');
    assert.ok(rules['route-b.runtime-lock'].errors >= 3, '许可、平台、VALIDATED 不一致都要报');
    assert.notEqual(envelope.exitCode, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
