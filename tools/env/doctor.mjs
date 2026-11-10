#!/usr/bin/env node
// 北冥仓库 · 环境自检：这台机器能不能出片、缺什么、怎么补。只读：不安装、不改文件（--out 时只写指定的报告文件）。
//   npm run env:doctor -- [--route a|b|c] [--gpu required|software-ok] [--quick] [--json] [--out 报告.json]
//   node tools/env/doctor.mjs --route a --json
//
// 检查项（每项 {id, ok, required, found, expected, fix}，fix 可以直接复制执行）：
//   Node 版本（D09）；npm 依赖与锁文件一致；playwright-core 1.63.0 与它配套的 chromium-headless-shell 已装；
//   按当前 ANGLE 设置启动一次浏览器，报告 WebGL 实际用的 GPU（识别软件渲染与「有独显却落到核显」）；
//   FFmpeg ≥ 7 及 libx264、aac、loudnorm、ebur128 等组件；Python 3.12 解释器与 requirements.lock 一致、核心模块可导入；
//   字体；sh（仍有 sh 入口时）；工作区换行；磁盘空间；生效的环境变量（拼错的会提示）；
//   --route b：RAEA_BIN、share/raea/VERSION 与已登记构建的 sha256；--route c：案例库与风格库快照（casebook check）。
// 必需项不合格时，最后给出「按顺序执行」的修复命令（系统级安装在前，npm ci 类修复并成 npm run setup 一步）；--json 的 nextSteps 字段同此。
// 供别的 Node 工具调用：import { doctor, nextSteps } from './tools/env/doctor.mjs'
// 退出码：0 必需项全部通过；3 有必需项不合格；2 用法错误；1 自检本身出错。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXIT, runCli, isMain, choice, log, usageError } from './lib/cli.mjs';
import { ROOT } from './lib/python.mjs';
import * as C from './lib/checks.mjs';

const HELP = `北冥仓库 · 环境自检（只读）

用法：
  npm run env:doctor -- [选项]
  node tools/env/doctor.mjs [选项]

选项：
  --route a|b|c         只看某条路线需要的项（可重复或逗号分隔）；不写时检查通用项，B 路线的原生运行时只作提示
  --gpu required        要求硬件 GPU：软件渲染或「有独显却落到核显」判失败（交付渲染前用）
  --gpu software-ok     默认：软件渲染只告警（CI、无显卡的机器）
  --quick               不启动浏览器、不导入 Python 模块、不跑案例库校验，只查文件与版本（约 1 秒）
  --out <文件>          另把 JSON 报告写到这个文件
  --json                stdout 只输出一个 JSON 对象（C2 信封，checks 字段是全部检查项）
  --help                本说明

每一项都给出「修复」命令；照着做完再跑一次，直到 exit 0。
退出码：0 必需项全部通过；3 有必需项不合格；2 用法错误；1 自检本身出错。`;

const PLATFORM_NAME = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

export async function doctor({ routes = [], gpuMode = 'software-ok', quick = false, env = process.env, root = ROOT } = {}) {
  const spec = C.loadSpec(root);
  const want = r => routes.length === 0 || routes.includes(r);
  const needWebgl = routes.length === 0 || routes.includes('a') || routes.includes('b');
  const t0 = Date.now();
  const sync = [C.checkNode(spec), C.checkNpm(root), C.checkPlaywright(root, spec), C.checkHeadlessShell(root, spec, env)];
  const browserReady = sync[1].ok && sync[2].ok && sync[3].ok;
  const tasks = [
    quick || !browserReady
      ? Promise.resolve([C.mk('browser.launch', '浏览器启动与 WebGL', { status: 'skip', required: false, found: quick ? '--quick：没有启动浏览器' : '前面的依赖或浏览器没装好，先修它们' })])
      : C.checkGpu(root, spec, { env, gpuMode, needWebgl }),
    C.checkFfmpeg(spec, env, { full: !quick }).then(r => r.checks),
    C.checkPython(root, spec, { env, imports: !quick }).then(r => r.checks),
    Promise.resolve(C.checkFonts(root, spec)),
    C.checkGitEol(root).then(c => [c]),
    want('c') && !quick ? C.checkCases(root, env, { required: routes.includes('c') }).then(c => [c]) : Promise.resolve([]),
    C.checkRaea(root, spec, { env, required: routes.includes('b') }).then(c => (want('b') ? [c] : [])),
  ];
  const parallel = (await Promise.all(tasks)).flat();
  const checks = [...sync, ...parallel, C.checkSh(spec, root), C.checkDisk(root, spec), C.checkWritable(root), C.checkSamples(env), C.checkEnvVars(spec, env)];
  const failedRequired = checks.filter(c => c.status === 'fail' && c.required);
  const summary = {
    total: checks.length, passed: checks.filter(c => c.status === 'pass').length,
    failedRequired: failedRequired.length, failedOptional: checks.filter(c => c.status === 'fail' && !c.required).length,
    warnings: checks.filter(c => c.status === 'warn').length, seconds: +((Date.now() - t0) / 1000).toFixed(1),
  };
  return { checks, summary, failedRequired };
}

// 把不合格项的修复命令排成一个可以照着执行的顺序：先装系统级的东西（brew / winget / apt / uv / nvm），
// 再 npm run setup（它包含 npm ci、浏览器与 Python 环境，所以「npm ci」「npm run setup」类的修复合并成这一步），最后是其它。
const SYSTEM = /^(brew|winget|sudo |curl |nvm |export |\$env:|安装 |用 FFmpeg)/;
const SETUP = /^(npm ci|npm run setup)(\s|（|$)/;
export function nextSteps(failed) {
  const system = [], other = [];
  let setup = false;
  for (const c of failed) {
    const fix = (c.fix || '').trim();
    if (!fix) continue;
    if (SETUP.test(fix)) { setup = true; continue; }
    if (c.data?.needUv) { setup = true; system.push(fix.replace(/，再运行 npm run setup.*$/, '')); continue; }
    (SYSTEM.test(fix) ? system : other).push(fix);
  }
  const uniq = a => [...new Set(a)];
  return [...uniq(system), ...(setup ? ['npm run setup'] : []), ...uniq(other)];
}

function human({ checks, summary, failedRequired }, routes) {
  const tag = { pass: 'OK  ', fail: 'FAIL', warn: 'WARN', info: 'INFO', skip: 'SKIP' };
  const head = `北冥仓库 · 环境自检  ${PLATFORM_NAME[process.platform] || process.platform} ${os.arch()} · Node ${process.versions.node} · ${routes.length ? `路线 ${routes.join('、')}` : '通用项'}`;
  const lines = [head, ''];
  for (const c of checks) {
    lines.push(`  ${tag[c.status]}  ${c.id.padEnd(24)} ${c.title}${c.required || c.status !== 'fail' ? '' : '（可选）'}：${c.found ?? ''}`);
    if (c.detail && c.status !== 'pass') lines.push(`        说明：${c.detail}`);
    if (c.fix && c.status !== 'pass') lines.push(`        修复：${c.fix}`);
  }
  lines.push('');
  const again = `npm run env:doctor${routes.length ? ` -- --route ${routes.join(',')}` : ''}`;
  if (failedRequired.length) {
    lines.push(`结论：${failedRequired.length} 项必需检查不合格（exit 3）：${failedRequired.map(c => c.id).join('、')}。`, '按顺序执行：');
    nextSteps(failedRequired).forEach((x, i) => lines.push(`  ${i + 1}. ${x}`));
    lines.push(`  ${nextSteps(failedRequired).length + 1}. ${again}`);
  } else {
    lines.push(`结论：必需项全部通过（${summary.passed}/${summary.total} 项通过，${summary.warnings} 项告警，用时 ${summary.seconds} 秒）。`);
  }
  return lines.join('\n');
}

if (isMain(import.meta.url)) {
  runCli({
    command: 'env:doctor', help: HELP,
    options: { route: { type: 'string', multiple: true }, gpu: { type: 'string' }, quick: { type: 'boolean' }, out: { type: 'string' } },
    run: async (o) => {
      const routes = [...new Set((o.route || []).flatMap(r => r.split(',')).map(r => choice('--route', r.trim(), ['a', 'b', 'c'])))].sort();
      const gpuMode = choice('--gpu', o.gpu, ['required', 'software-ok']) || 'software-ok';
      if (gpuMode === 'required' && o.quick) throw usageError('--gpu required 需要启动浏览器探测，不能和 --quick 一起用');
      log(`环境自检中（${o.quick ? '快速模式' : '会启动一次无头浏览器、导入一次 Python 模块'}）…`);
      const r = await doctor({ routes, gpuMode, quick: !!o.quick });
      const platform = { os: process.platform, arch: os.arch(), release: os.release(), node: process.versions.node };
      const report = { platform, routes, gpuMode, quick: !!o.quick, checks: r.checks, summary: r.summary };
      const outputs = [];
      if (o.out) {
        const p = path.resolve(o.out);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(report, null, 2) + '\n');
        const rel = path.relative(ROOT, p);
        outputs.push({ path: (rel.startsWith('..') || path.isAbsolute(rel) ? p : rel).split(path.sep).join('/'), sha256: createHash('sha256').update(fs.readFileSync(p)).digest('hex'), kind: 'doctor-report' });
      }
      const exitCode = r.failedRequired.length ? EXIT.ENV : EXIT.OK;
      return {
        exitCode, outputs,
        error: exitCode ? { code: 'env-check-failed', message: `${r.failedRequired.length} 项必需检查不合格：${r.failedRequired.map(c => c.id).join('、')}`, hint: `按顺序执行：${nextSteps(r.failedRequired).join('；然后 ')}；最后重跑 npm run env:doctor` } : null,
        nextSteps: exitCode ? nextSteps(r.failedRequired) : [],
        warnings: r.checks.filter(c => c.status === 'warn').map(c => `${c.id}：${c.found}${c.fix ? `（${c.fix}）` : ''}`),
        ...report,
        human: human(r, routes),
      };
    },
  });
}
