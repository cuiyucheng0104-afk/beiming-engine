// B 路线仓库规范规则（tools/repo-check/rules/route-b）：在本仓库上全部通过；在临时造的反例目录上逐条抓到问题。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, rules } from '../../tools/repo-check/rules/route-b/index.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ENTRY = fileURLToPath(new URL('../../tools/repo-check/rules/route-b/index.mjs', import.meta.url));

test('本仓库：B 路线规则全部不报错（只允许「平台还没锁定」的提示）', () => {
  const results = check(ROOT);
  assert.equal(results.length, rules.length);
  for (const r of results) assert.notEqual(r.status, 'fail', `${r.id}：${r.errors.join('；')}`);
});

test('反例：写死契约、锁文件残缺、辅助模块越界 import、缺 aigc、直接 spawnSync、手册缺许可边界都被抓到', () => {
  const root = mkdtempSync(join(tmpdir(), 'bne-rules-'));
  const put = (f, text) => { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), text); };
  try {
    put('routes/b-native/template/film.json', JSON.stringify({ route: 'b', title: '{{TITLE}}', dur: 10, fps: 24, size: [1920, 1080], native: { images: [{ to: 'sky.png', from: '../../assets/plates/sky_dawn.png' }] } }));
    put('routes/b-native/template/film.tsx', "import { layout } from './layout.js';\nconst N = 240;\n");
    put('routes/b-native/template/layout.js', "import { shotAt } from '../../engine/native/view.js';\nexport const layout = () => shotAt;\n");
    put('engine/render/native.mjs', "// 入口\nconst a = ['-t 10'];\n");
    put('engine/native/runtime.lock.json', JSON.stringify({ version: '0.1.0', license: 'MIT', platforms: {} }));
    put('engine/native/x.mjs', "import { spawnSync } from 'node:child_process';\nspawnSync('ffmpeg', []);\n");
    put('routes/b-native/README.md', '# B\n\n## 边界与常见坑\n\n- 没写许可\n');
    const byId = Object.fromEntries(check(root).map(r => [r.id, r]));
    assert.equal(byId['route-b.no-hardcoded-contract'].status, 'fail');
    assert.ok(byId['route-b.no-hardcoded-contract'].errors.length >= 2, '模版里的 240 与入口里的 -t 10 都要报');
    assert.equal(byId['route-b.runtime-lock'].status, 'fail');
    assert.equal(byId['route-b.film-module-imports'].status, 'fail');
    assert.equal(byId['route-b.aigc-label'].status, 'fail');
    assert.equal(byId['route-b.spawn-timeout'].status, 'fail');
    assert.equal(byId['route-b.manual-boundary'].status, 'fail');
    const cli = spawnSync(process.execPath, [ENTRY, '--root', root, '--json'], { encoding: 'utf8', timeout: 60000 });
    assert.equal(cli.status, 4);
    assert.equal(JSON.parse(cli.stdout).ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('命令行：--help 退出 0；未知参数 exit 2', () => {
  assert.equal(spawnSync(process.execPath, [ENTRY, '--help'], { timeout: 30000 }).status, 0);
  assert.equal(spawnSync(process.execPath, [ENTRY, '--nope'], { timeout: 30000 }).status, 2);
  assert.ok(readFileSync(ENTRY, 'utf8').startsWith('#!/usr/bin/env node'));
});
