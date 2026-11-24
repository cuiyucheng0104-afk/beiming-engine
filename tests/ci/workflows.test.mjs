// .github/workflows 的 ci.yml、release.yml、conformance-5090.yml 与 .github/dependabot.yml 的静态核对（逐行扫描，不依赖 YAML 库）：
// actions 固定到 40 位提交哈希并注明版本、每个 job 有时限、run 里不直接展开外部输入（防脚本注入）、
// 引用的仓库脚本都存在、必需的 job 都在、dependabot 覆盖 npm / pip（仅 tests/ci）/ GitHub Actions。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from './helpers.mjs';

const read = rel => fs.readFileSync(path.join(REPO, rel), 'utf8');
const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/release.yml', '.github/workflows/conformance-5090.yml'];

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

test('ci.yml：六个 job 都在，各有时限；权限只读；windows-paths 用 PowerShell 且去掉 Git Bash；环境自检三平台', () => {
  const text = read('.github/workflows/ci.yml'), jobs = jobsOf(text);
  assert.deepEqual(Object.keys(jobs), ['unit', 'check', 'render', 'smoke-render', 'env-smoke', 'windows-paths']);
  assert.match(jobs['env-smoke'], /os: \[ubuntu-24\.04, macos-26, windows-2025\]/);
  assert.match(jobs['env-smoke'], /hashFiles\('tools\/env\/doctor\.mjs'\) != ''/);
  // 红了就是红：任何 job 都不许 continue-on-error（含 windows-paths、env-smoke，它们转绿后已去掉吞红）
  assert.doesNotMatch(text.replace(/^\s*#.*$/gm, ''), /continue-on-error/, 'ci.yml 里不许有 continue-on-error 吞红');
  for (const [k, v] of Object.entries(jobs)) assert.match(v, /timeout-minutes:\s*\d+/, `${k} 没有 timeout-minutes`);
  assert.match(text, /^permissions:\n {2}contents: read$/m);
  // Node 24 + Linux 全量由 render (tests-*) 两片覆盖，unit 只留没有浏览器与 FFmpeg 的 Node 22，不再重复跑一遍 Node 24
  assert.match(jobs.unit, /node: \['22'\]/);
  for (const k of ['unit', 'windows-paths']) assert.match(jobs[k], /node tools\/run-tests\.mjs --parallel /, `${k} 要用 --parallel 让 Python 组与 Node 组同时跑`);
  assert.match(jobs.unit, /python-version: '3\.12'/);
  assert.match(jobs.render, /BEIMING_ANGLE: swiftshader/);
  assert.match(jobs.render, /sha256sum -c/);
  assert.match(jobs['windows-paths'], /shell: pwsh/);
  assert.match(jobs['windows-paths'], /notmatch '\\\\Git\\\\\(usr\\\\\)\?bin/);
  assert.match(text, /workflow_call:/);
});

test('ci.yml：render 的 tests 三片与 smoke 并行且互不拖累；smoke-render 汇总各路，release.yml 要的产物名只由 smoke 一路上传', () => {
  const jobs = jobsOf(read('.github/workflows/ci.yml'));
  assert.match(jobs.render, /- part: tests-beiming\n\s+tests_args: --only beiming,audio\n\s+- part: tests-beiming-api\n\s+tests_args: --only beiming-api\n\s+- part: tests-rest\n\s+tests_args: --skip beiming,beiming-api,audio\n\s+- part: smoke\n/);
  // 各 --only 分片并集要等于 --skip 集合，确保不漏域（新增的域自动落进 --skip 那一片）
  const onlyDomains = [...jobs.render.matchAll(/--only ([\w,-]+)/g)].flatMap(m => m[1].split(',')).sort();
  const skipDomains = /--skip ([\w,-]+)/.exec(jobs.render)[1].split(',').sort();
  assert.deepEqual(onlyDomains, skipDomains, 'tests 各 --only 分片的并集必须等于 --skip 集合');
  assert.match(jobs.render, /fail-fast: false/, '一路红了另一路也要跑完');
  // 每个只属于某一路的步骤都要带 matrix.part 条件，否则两路会各跑一遍对方的活
  const stepsOf = text => text.split(/\n {6}- /).slice(1).map(s => `- ${s}`);
  const steps = stepsOf(jobs.render);
  const find = re => steps.find(s => re.test(s));
  assert.match(find(/node tools\/run-tests\.mjs/), /if: startsWith\(matrix\.part, 'tests'\)/);
  assert.match(find(/node tools\/run-tests\.mjs/), /--parallel --timeout 900 --require browser,ffmpeg,python \$TESTS_ARGS/);
  assert.match(find(/node tests\/ci\/smoke-render\.mjs/), /if: matrix\.part == 'smoke'/);
  assert.match(find(/name: smoke-render\n/), /matrix\.part == 'smoke'/, 'smoke-render 产物（release.yml 下载）只能由 smoke 一路上传，名字不能撞');
  assert.match(find(/name: golden-capture-linux-swiftshader/), /matrix\.part == 'smoke'/);
  assert.match(find(/name: render-\$\{\{ matrix\.part \}\}\n/), /startsWith\(matrix\.part, 'tests'\)/, '两片测试报告各用自己的产物名，不撞');
  // apt 下载缓存：Chromium 的系统依赖不再每次走 Ubuntu 镜像
  assert.match(jobs.render, /Dir::Cache::archives "\/tmp\/beiming-apt"/);
  assert.match(jobs.render, /path: \/tmp\/beiming-apt\/\*\.deb/);
  // 汇总任务：沿用 smoke-render 这个检查名，上游失败时也要跑（否则会被跳过而不是变红）
  assert.match(jobs['smoke-render'], /needs: render\b/);
  assert.match(jobs['smoke-render'], /if: always\(\)/);
  assert.match(jobs['smoke-render'], /test "\$RENDER_RESULT" = success/);
  assert.match(read('.github/workflows/release.yml'), /name: smoke-render\n\s+path: smoke/);
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

test('conformance-5090.yml：PR 先过轻量 filter，改到帧源且开了 5090 才排显卡队；夜间 exam → 一致性（限 10 分钟）→ 夜间重建', () => {
  const text = read('.github/workflows/conformance-5090.yml'), jobs = jobsOf(text);
  assert.deepEqual(Object.keys(jobs), ['filter', 'exam', 'conformance-5090', 'nightly-rebuild']);
  for (const t of ['pull_request:', 'schedule:', 'workflow_dispatch:', 'workflow_call:']) assert.ok(text.includes(`\n  ${t}`), `缺触发 ${t}`);
  assert.match(text, /^permissions:\n {2}contents: read$/m);
  assert.doesNotMatch(text, /contents: write|write-all/);
  for (const [k, v] of Object.entries(jobs)) assert.match(v, /timeout-minutes:\s*\d+/, `${k} 没有 timeout-minutes`);

  assert.match(jobs.filter, /runs-on: ubuntu-24\.04/);
  assert.match(jobs.filter, /timeout-minutes: 5\b/);
  // 「PR 分支」：直接由 pull_request 触发，或 workflow_call 显式 mode=pr。从 PR 调用 workflow_call 时 event_name 也是 pull_request，
  // 只能靠 from_call 哨兵（workflow_call 下默认 true，直接触发时没有 inputs）区分；mode 传空串也要走夜间链
  const PR = "((github.event_name == 'pull_request' && !inputs.from_call) || (inputs.from_call && inputs.mode == 'pr'))";
  assert.match(text, /workflow_call:\n {4}inputs:\n {6}mode:\n[\s\S]*?default: nightly\n/);
  assert.match(text, /\n {6}from_call:\n(?: {8}.*\n)*? {8}type: boolean\n(?: {8}.*\n)*? {8}default: true\n/, 'workflow_call 要有布尔哨兵 from_call，默认 true');
  assert.doesNotMatch(text, /!inputs\.mode\b/, '用 !inputs.mode 判 PR：从 PR 调用并传 mode: \'\' 会误走 PR 分支');
  assert.ok(jobs.filter.includes(`if: ${PR}\n`), 'filter 只在 PR 分支跑');
  const out = /frame_sources_changed: \$\{\{ steps\.([\w-]+)\.outputs\.frame_sources_changed \}\}/.exec(jobs.filter);
  assert.ok(out, 'filter 要把判定结果交给 jobs.filter.outputs');
  assert.match(jobs.filter, new RegExp(`- id: ${out[1]}\\n`), `outputs 引用的步骤 id ${out[1]} 不存在`);
  assert.match(jobs.filter, /fetch-depth: 0\b/, '三点差异要能找到合并基');
  assert.match(jobs.filter, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(jobs.filter, /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.doesNotMatch(text, /HEAD~1|HEAD\^/, '只比最后一个提交会漏掉前面改帧源的提交');
  assert.match(jobs.filter, /git diff -z --name-only --no-renames "\$BASE_SHA\.\.\.\$HEAD_SHA" \| node tests\/ci\/conformance-filter\.mjs --null >> "\$GITHUB_OUTPUT"/);
  assert.match(text, /cron: '\d+ \d+ \* \* \*'/, '夜间流水每天一次');

  const gpu = jobs['conformance-5090'];
  assert.match(gpu, /runs-on: \[self-hosted, linux, x64, rtx5090\]/);
  assert.match(gpu, /timeout-minutes: 10\b/);
  assert.match(gpu, /needs: \[filter, exam\]/);
  assert.match(gpu, /concurrency:\n\s+group: gpu-5090\n\s+cancel-in-progress: false/);
  const cond = /if: >-\n([\s\S]*?)\n {4}\S/.exec(gpu)?.[1] ?? '';
  assert.match(cond, /vars\.BEIMING_5090_RUNNER == 'true'/);
  assert.match(cond, /!cancelled\(\)/, 'filter 或 exam 被跳过时不能连带跳过');
  const flat = cond.replace(/\s+/g, ' ');
  assert.ok(flat.includes(`(${PR} && needs.filter.outputs.frame_sources_changed == 'true')`), cond);
  assert.ok(flat.includes(`(!${PR} && needs.exam.result == 'success')`), cond);
  // 自托管运行器只跑同仓分支的 PR：fork 的代码不受信
  const sameRepo = "(github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)";
  assert.ok(flat.includes(sameRepo), 'conformance-5090 缺同仓来源守卫');
  // 一致性要真跑帧源实渲测试（只读表的测试把 render() 改坏也全绿），且先确认浏览器在，免得实渲测试自己跳过
  for (const g of ['beiming/kernel/conformance/', 'beiming/calib/', 'beiming/sources/three/', 'beiming/sources/blender/', 'beiming/host/page/']) {
    assert.ok(gpu.includes(`'${g}*.test.mjs'`), `一致性命令缺 ${g}`);
  }
  assert.match(gpu, /import\('\.\/tests\/ci\/browser\.mjs'\)[^\n]*process\.exit\(3\)/);
  // 只有空的浏览器目录时 browserOk 也为真，render.test.mjs 起不了帧源就 t.skip、整步照绿：先真起停一次，起不来 exit 3
  const boot = /import\('\.\/beiming\/host\/page\/host\.mjs'\)[^\n]*/.exec(gpu)?.[0] ?? '';
  assert.match(boot, /await startSource\(\)[^\n]*await s\.stop\(\)[^\n]*process\.exit\(3\)/, '一致性前要真起停一次 three 帧源');
  assert.ok(gpu.indexOf(boot) < gpu.indexOf("node --test 'beiming/kernel/conformance/"), '起停帧源要在跑套件之前');

  assert.ok(jobs.exam.includes(`!${PR}`), 'exam 只在夜间链跑');
  const nightly = jobs['nightly-rebuild'];
  assert.match(nightly, /needs: conformance-5090\b/);
  // 不写状态函数会被套上隐式 success()：夜间链里祖先 filter 是 skipped，会连带跳过。只认 if 里的条件，注释里写了不算
  const nightlyCond = (/if: >-\n([\s\S]*?)\n {4}\S/.exec(nightly)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  assert.ok(nightlyCond.startsWith("!cancelled() && needs['conformance-5090'].result == 'success' && "), nightlyCond);
  // render.test.mjs 起不了帧源就 t.skip，node --test 仍退出 0：three 那一条用 TAP 落盘，出现 # SKIP 就 exit 3
  assert.match(gpu, /set -eo pipefail\n/);
  assert.match(gpu, /\n\s+rc=0\n\s+node --test --test-reporter=tap 'beiming\/sources\/three\/\*\.test\.mjs' > "\$TAP" \|\| rc=\$\?\n/, 'three 实渲测试要用 TAP 报告并落盘，退出码先记下');
  // 不得用 grep / tee 判跳过：缺命令（127）或文件不可读（2）会被 if grep 当成未命中放行。命令行里不许出现，注释里提到不算
  assert.doesNotMatch(gpu.replace(/^\s*#.*$/gm, ''), /\b(grep|tee)\b/, '判跳过只靠 node');
  // 校验脚本拿出来真跑：bash 双引号里没有 $ ` \" 时内容原样交给 node
  const verify = /\n\s+TAP="\$TAP" node --input-type=module -e "([^"\n]*readFileSync[^"\n]*)"\n\s+test "\$rc" -eq 0 \|\| exit "\$rc"\n/.exec(gpu)?.[1];
  assert.ok(verify && !/[$`]/.test(verify), 'three 的 TAP 要由 node 校验，之后再按测试自己的退出码收尾');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i6-tap-'));
  const OK = 'TAP version 13\nok 1 - a\n# tests 1\n# skipped 0\n';
  for (const [name, tap, want] of [
    ['通过', OK, 0],
    ['有 # SKIP 指令', OK.replace('ok 1 - a', 'ok 1 - a # SKIP 起不了帧源'), 3],
    ['汇总里跳过数非零', OK.replace('# skipped 0', '# skipped 2'), 3],
    ['没有用例', OK.replace('# tests 1', '# tests 0'), 3],
    ['空文件', '', 3],
    ['文件不存在', null, 1],
  ]) {
    const TAP = path.join(dir, `${name}.tap`);
    if (tap !== null) fs.writeFileSync(TAP, tap);
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', verify], { env: { ...process.env, TAP }, encoding: 'utf8' });
    assert.equal(r.status, want, `${name}：${r.stderr}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(nightly.replace(/\s+/g, ' ').includes(`!${PR} &&`), 'PR 里一致性通过也不能触发夜间重建');
  assert.ok(nightly.replace(/\s+/g, ' ').includes(sameRepo), 'nightly-rebuild 缺同仓来源守卫');
  assert.match(nightly, /uses: actions\/setup-node@/);
  assert.match(nightly, /npm ci/);
  // exam 与 nightly-rebuild 真实入口均存在且无条件执行，禁止 hashFiles(...) == '' 的 ::notice:: 假绿跳过回退
  for (const entry of ['beiming/bench/exam.mjs', 'tools/nightly/rebuild.mjs']) {
    assert.ok(fs.existsSync(path.join(REPO, entry)), `定时任务入口 ${entry} 必须真实存在`);
  }
  assert.match(jobs.exam, /run:\s*npm ci && node beiming\/bench\/exam\.mjs\b/);
  assert.match(nightly, /run:\s*npm ci && node tools\/nightly\/rebuild\.mjs\b/);
  assert.doesNotMatch(text, /hashFiles\(|还没有合入|还没合入|::notice::/, 'conformance-5090.yml 不得保留缺入口假绿跳过回退');
  // 只有一致性任务进显卡队：别的 job 用了 gpu-5090 会挤掉排队中的那个
  assert.equal((text.match(/group: gpu-5090/g) || []).length, 1);
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
      for (const m of b.text.matchAll(/(?:^|\s)node\s+((?:beiming|tools|tests|engine|routes)\/[^\s"']+\.m?js)/g)) {
        if (!fs.existsSync(path.join(REPO, m[1])) && !guarded.has(m[1])) missing.push(`${f}:${b.line} ${m[1]}`);
      }
      for (const m of b.text.matchAll(/-r\s+((?:tests|tools)\/[^\s"']+)/g)) if (!fs.existsSync(path.join(REPO, m[1]))) missing.push(`${f}:${b.line} ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('dependabot：每周检查 npm、pip（仅 lint 依赖）、GitHub Actions；根目录 pip 不覆盖；three 与 playwright-core 不自动升级', () => {
  const text = read('.github/dependabot.yml');
  for (const eco of ['npm', 'pip', 'github-actions']) assert.match(text, new RegExp(`package-ecosystem: ${eco}\\b`));
  // 根目录是 requirements.in → requirements.lock，Dependabot pip-compile 会改坏 requirements.txt 且不重生锁
  assert.match(text, /package-ecosystem: pip\s*\n\s*directory: \/tests\/ci/);
  assert.doesNotMatch(text, /package-ecosystem: pip[\s\S]*?directories:/);
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
