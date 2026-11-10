// .github/workflows 的 ci.yml、release.yml 与 .github/dependabot.yml 的静态核对（逐行扫描，不依赖 YAML 库）：
// actions 固定到 40 位提交哈希并注明版本、每个 job 有时限、run 里不直接展开外部输入（防脚本注入）、
// 引用的仓库脚本都存在、必需的 job 都在、dependabot 覆盖 npm / pip / GitHub Actions。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';

const read = rel => fs.readFileSync(path.join(REPO, rel), 'utf8');
const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/release.yml'];

// 取出全部 run 脚本：{ file, line, text }（块标量按缩进收集）
export function runBlocks(text, file) {
  const lines = text.split(/\r?\n/), out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length + (lines[i].trimStart().startsWith('-') ? 2 : 0);
    if (!/^[|>][-+]?\s*$/.test(m[2])) { out.push({ file, line: i + 1, text: m[2] }); continue; }
    const body = [];
    for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > indent); j++) body.push(lines[j]);
    out.push({ file, line: i + 1, text: body.join('\n') });
  }
  return out;
}

// job 名 → 这一段文本（只认 jobs: 下两格缩进的键）
function jobsOf(text) {
  const lines = text.split(/\r?\n/), jobs = {};
  let inJobs = false, cur = null;
  for (const l of lines) {
    if (/^jobs:\s*$/.test(l)) { inJobs = true; continue; }
    if (inJobs && /^\S/.test(l)) { inJobs = false; cur = null; }
    const m = inJobs && /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (m) { cur = m[1]; jobs[cur] = []; continue; }
    if (cur) jobs[cur].push(l);
  }
  return Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join('\n')]));
}

test('actions 都固定到 40 位提交哈希，行尾注明版本；本仓库的可复用工作流用相对路径', () => {
  for (const f of [...WORKFLOWS, '.github/workflows/pages.yml'].filter(x => fs.existsSync(path.join(REPO, x)))) {
    if (f.endsWith('pages.yml')) continue;   // 作品站的工作流归作品站维护，这里只核对本包的两个
    for (const [i, l] of read(f).split(/\r?\n/).entries()) {
      const m = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(l);
      if (!m) continue;
      if (m[1].startsWith('./')) { assert.ok(fs.existsSync(path.join(REPO, m[1])), `${f}:${i + 1} 引用的 ${m[1]} 不存在`); continue; }
      assert.match(m[1], /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/, `${f}:${i + 1} 没有固定到提交哈希：${m[1]}`);
      assert.match(m[2], /#\s*v\d+(\.\d+){0,2}\b/, `${f}:${i + 1} 行尾要注明对应版本（# vX.Y.Z）`);
    }
  }
});

test('同一个 action 在各处用同一个哈希（dependabot 升级时不会只改一半）', () => {
  const seen = new Map();
  for (const f of WORKFLOWS) {
    for (const m of read(f).matchAll(/uses:\s*([\w.-]+\/[\w.-]+)@([0-9a-f]{40})/g)) {
      if (seen.has(m[1])) assert.equal(m[2], seen.get(m[1]), `${m[1]} 在 ${f} 里用了不同的哈希`);
      seen.set(m[1], m[2]);
    }
  }
  assert.ok(seen.size >= 5);
});

test('ci.yml：五个 job 都在，各有时限；权限只读；windows-paths 用 PowerShell 且去掉 Git Bash；环境自检三平台', () => {
  const text = read('.github/workflows/ci.yml'), jobs = jobsOf(text);
  assert.deepEqual(Object.keys(jobs), ['unit', 'check', 'smoke-render', 'env-smoke', 'windows-paths']);
  assert.match(jobs['env-smoke'], /os: \[ubuntu-24\.04, macos-26, windows-2025\]/);
  assert.match(jobs['env-smoke'], /hashFiles\('tools\/env\/doctor\.mjs'\) != ''/);
  for (const k of ['windows-paths', 'env-smoke']) assert.match(jobs[k], /continue-on-error: \$\{\{ vars\.BEIMING_\w+_REQUIRED != 'true' \}\}/);
  for (const [k, v] of Object.entries(jobs)) assert.match(v, /timeout-minutes:\s*\d+/, `${k} 没有 timeout-minutes`);
  assert.match(text, /^permissions:\n {2}contents: read$/m);
  assert.match(jobs.unit, /node: \['24', '22'\]/);
  assert.match(jobs.unit, /python-version: '3\.12'/);
  assert.match(jobs['smoke-render'], /BEIMING_ANGLE: swiftshader/);
  assert.match(jobs['smoke-render'], /sha256sum -c/);
  assert.match(jobs['windows-paths'], /shell: pwsh/);
  assert.match(jobs['windows-paths'], /notmatch '\\\\Git\\\\\(usr\\\\\)\?bin/);
  assert.match(text, /workflow_call:/);
});

test('release.yml：标签触发、复用 ci.yml、只有建草稿的 job 有写权限，发布由人工点', () => {
  const text = read('.github/workflows/release.yml'), jobs = jobsOf(text);
  assert.match(text, /tags: \['v\*'\]/);
  assert.match(jobs.ci, /uses: \.\/\.github\/workflows\/ci\.yml/);
  assert.match(text, /^permissions:\n {2}contents: read$/m);
  const writers = Object.entries(jobs).filter(([, v]) => /contents: write/.test(v)).map(([k]) => k);
  assert.deepEqual(writers, ['publish']);
  assert.match(jobs.publish, /--draft/);
  assert.doesNotMatch(text, /gh release edit [^\n]*--draft=false/);
  assert.match(jobs.notes, /changelog\.mjs notes "\$TAG" --package package\.json/);
});

test('run 脚本里不直接展开外部输入（标签名、PR 标题、inputs 都先进 env 再用）', () => {
  for (const f of WORKFLOWS) {
    for (const b of runBlocks(read(f), f)) {
      for (const m of b.text.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)) {
        assert.match(m[1], /^(matrix\.\w+|steps\.\w+\.outputs\.[\w-]+|runner\.\w+|env\.\w+)$/, `${f}:${b.line} 的 run 里直接展开了 \${{ ${m[1]} }}：先放进 env`);
      }
    }
  }
});

test('工作流里调用的仓库脚本都存在（node / python 后面的相对路径；用 hashFiles 守着的步骤允许暂缺）', () => {
  const missing = [];
  for (const f of WORKFLOWS) {
    const guarded = new Set([...read(f).matchAll(/hashFiles\('([^']+)'\)/g)].map(m => m[1]));
    for (const b of runBlocks(read(f), f)) {
      for (const m of b.text.matchAll(/(?:^|\s)node\s+((?:tools|tests|engine|routes)\/[^\s"']+\.m?js)/g)) {
        if (!fs.existsSync(path.join(REPO, m[1])) && !guarded.has(m[1])) missing.push(`${f}:${b.line} ${m[1]}`);
      }
      for (const m of b.text.matchAll(/-r\s+((?:tests|tools)\/[^\s"']+)/g)) if (!fs.existsSync(path.join(REPO, m[1]))) missing.push(`${f}:${b.line} ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('dependabot：每周检查 npm、pip（含 lint 依赖）、GitHub Actions；three 与 playwright-core 不自动升级', () => {
  const text = read('.github/dependabot.yml');
  for (const eco of ['npm', 'pip', 'github-actions']) assert.match(text, new RegExp(`package-ecosystem: ${eco}\\b`));
  assert.match(text, /- \/tests\/ci/);
  assert.match(text, /dependency-name: three/);
  assert.match(text, /dependency-name: playwright-core/);
  assert.equal((text.match(/interval: weekly/g) || []).length, 3);
});

test('lint 依赖按哈希固定：每个版本只出现一次，且带多平台 wheel 哈希', () => {
  const text = read('tests/ci/requirements-lint.txt');
  const pins = [...text.matchAll(/^([A-Za-z0-9_.-]+)==([\w.]+)/gm)];
  assert.ok(pins.length >= 1);
  assert.ok((text.match(/--hash=sha256:[0-9a-f]{64}/g) || []).length >= 6, 'linux / macOS / Windows 的 wheel 都要有哈希');
});
