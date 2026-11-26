import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkArchitecture } from './guard.mjs';

const tableFile = 'beiming/kernel/contracts/ownership/ownership.json';
const guardFile = fileURLToPath(new URL('./guard.mjs', import.meta.url));
const registered = ['.', 'api', 'kernel', 'kernel/contracts', 'kernel/eval', 'sources', 'sources/core', 'api/nested'];

function withFixture(check) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'beiming-guard-'));
  const put = (file, source) => {
    const destination = path.join(root, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, source);
  };
  const setOwnership = (entries) => put(tableFile, JSON.stringify({ entries: entries.map((entry) => ({ path: entry })) }));
  try {
    setOwnership(registered);
    mkdirSync(path.join(root, 'beiming/sources/core'), { recursive: true });
    put('engine/example.cjs', "// require('../beiming/api/public.mjs');\nrequire('./core/clock.cjs');\n");
    put('engine/sub/activity.py', '"""import beiming\nfrom beiming import api"""\n# import beiming\nimport os\n');
    put('cases/vendor/example.mjs', "import '../../beiming/api/public.mjs';\n");
    put('cases/source/example.py', 'from beiming import api\n');
    put('beiming/api/public.mjs', [
      "import '../kernel/eval/frame.mjs';",
      "import 'node:fs';",
      "import 'external-package';",
    ].join('\n'));
    put('beiming/kernel/eval/frame.mjs', [
      "// import 'three'; const material = 0;",
      "const label = true ? 'material' : '';",
      'const pattern = () => /shader/;',
      'const record = { value: label };',
      'const description = `material ${record.value}`;',
    ].join('\n'));
    put('beiming/kernel/eval/frame.test.mjs', "import 'three'; const material = 0;\n");
    put('beiming/kernel/eval/tests/test_frame.py', 'import bpy\nroughness = 0\n');
    check({ root, put, setOwnership });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function problemsFor(root, rule) {
  const result = checkArchitecture(root);
  assert.equal(result.ok, false);
  assert.ok(result.scannedFiles > 0);
  assert.ok(result.problems.length > 0);
  for (const problem of result.problems) {
    assert.equal(problem.rule, rule);
    assert.ok(problem.message.length > 0);
  }
  return result.problems;
}

test('正向夹具通过，归档区不计入扫描', () => {
  withFixture(({ root }) => {
    assert.deepEqual(checkArchitecture(root), { ok: true, problems: [], scannedFiles: 6 });
  });
});

test('目录归属守卫双向检查指定层级', () => {
  withFixture(({ root, put, setOwnership }) => {
    setOwnership([...registered, 'jobs', 'sources/blender', 'kernel/extra']);
    put('beiming/unregistered/README.md', '');
    put('beiming/kernel/unregistered/README.md', '');
    put('beiming/sources/unregistered/README.md', '');
    put('beiming/api/local/deeper/README.md', '');
    const problems = problemsFor(root, 'ownership-dirs');
    assert.deepEqual(problems.map(({ file }) => file).sort(), [
      'beiming/jobs',
      'beiming/kernel/extra',
      'beiming/kernel/unregistered',
      'beiming/sources/blender',
      'beiming/sources/unregistered',
      'beiming/unregistered',
    ]);
    assert.match(problems.find(({ file }) => file === 'beiming/jobs').message, /已登记的目录不存在/);
    assert.match(problems.find(({ file }) => file === 'beiming/unregistered').message, /目录未登记归属/);
  });
});

test('旧目录反向引用涵盖各类导入和重导出', () => {
  withFixture(({ root, put }) => {
    put('engine/static.js', "import local, { name as other } /* 注释 */ from '../beiming/api/public.mjs';\n");
    put('tools/dynamic.mjs', "const api = import /* 注释 */ (`../beiming/api/public.mjs`);\n");
    put('tools/dynamic-joined.mjs', "const api = import('../beiming/' + 'api/public.mjs');\n");
    put('routes/require.cjs', "const api = require('../beiming/api/public.mjs');\n");
    put('films/side-effect.mjs', "import '../beiming/api/public.mjs';\n");
    put('site/reexport.mjs', "export * as api from '/beiming/api/public.mjs';\n");
    put('cases/vendor-copy.py', 'import os, beiming.api as api\n');
    put('engine/from.py', 'from ..beiming.api import public\n');
    put('engine/from-parent.py', 'from .. import (os, beiming as api)\n');
    put('engine/from-absolute.py', 'from beiming import api\n');
    assert.deepEqual(problemsFor(root, 'no-reverse-import').map(({ file }) => file).sort(), [
      'cases/vendor-copy.py',
      'engine/from-absolute.py',
      'engine/from-parent.py',
      'engine/from.py',
      'engine/static.js',
      'films/side-effect.mjs',
      'routes/require.cjs',
      'site/reexport.mjs',
      'tools/dynamic-joined.mjs',
      'tools/dynamic.mjs',
    ]);
  });
});

test('新目录禁止引用仓库内的任何外部模块', () => {
  withFixture(({ root, put }) => {
    put('beiming/api/outside.mjs', [
      "import '../../engine/core-extra/clock.mjs';",
      "import '../../engine/render/lib/errors.mjs.backup';",
      "import '../../tools/qa/../other/check.mjs';",
      "import '../../package.json';",
    ].join('\n'));
    put('beiming/api/outside.py', 'from tools.private import helpers\n');
    const problems = problemsFor(root, 'no-legacy-import');
    assert.equal(problems.length, 5);
    for (const target of ['engine/core-extra/clock.mjs', 'engine/render/lib/errors.mjs.backup', 'tools/other/check.mjs', 'package.json', 'tools/private']) {
      assert.ok(problems.some(({ message }) => message.endsWith(`（${target}）`)), target);
    }
  });
});

test('求值核禁止图形库、帧源、宿主以及材质和灯光字段', () => {
  withFixture(({ root, put }) => {
    put('beiming/kernel/eval/unsafe.mjs', [
      "import 'three/addons/node.js';",
      "import('playwright');",
      "export * from '../../sources/core/index.mjs';",
      "import '../../host/index.mjs';",
      "const surfaceMaterial = { 'shader': '', ['roughness']: 0, metalness: 0 };",
      'const output = `result ${lightIntensity}`;',
    ].join('\n'));
    put('beiming/kernel/eval/unsafe.py', 'from bpy import data\noutput = {"material": None}\n');
    const problems = problemsFor(root, 'eval-pure');
    assert.equal(problems.length, 11);
    for (const value of ['three/addons/node.js', 'playwright', '../../sources/core/index.mjs', '../../host/index.mjs', 'surfaceMaterial', 'shader', 'roughness', 'metalness', 'lightIntensity', 'bpy', 'material']) {
      assert.ok(problems.some(({ message }) => message.endsWith(`（${value}）`)), value);
    }
  });
});

test('CLI 的 --root 和 --json 反映通过与违例的退出状态', () => {
  withFixture(({ root, put }) => {
    const run = () => spawnSync(process.execPath, [guardFile, '--root', root, '--json'], { encoding: 'utf8' });
    const clean = run();
    assert.equal(clean.status, 0, clean.stderr);
    assert.deepEqual(JSON.parse(clean.stdout), { ok: true, problems: [], scannedFiles: 6 });
    put('tools/reverse.mjs', "import '../beiming/api/public.mjs';\n");
    const violation = run();
    assert.equal(violation.status, 1, violation.stderr);
    const result = JSON.parse(violation.stdout);
    assert.equal(result.ok, false);
    assert.equal(result.scannedFiles, 7);
    assert.equal(result.problems.length, 1);
    assert.equal(result.problems[0].rule, 'no-reverse-import');
  });
});

test('日常守卫仅容许冻结工具的精确引用；拆仓守卫逐条报出', () => {
  withFixture(({ root, put }) => {
    const coreTool = 'beiming/sources/core/chassis/freeze.mjs';
    put(coreTool, "import '../../../../tools/lib/cli.mjs';");
    assert.deepEqual(checkArchitecture(root).problems, []);
    const strict = spawnSync(process.execPath, [guardFile, '--root', root, '--json', '--standalone'], { encoding: 'utf8' });
    const [problem] = JSON.parse(strict.stdout).problems;
    assert.equal(strict.status, 1);
    assert.equal(problem.file, coreTool);
    assert.equal(problem.rule, 'no-legacy-import');
    put(coreTool, "import '../../../../tools/lib/other.mjs';");
    put('beiming/sources/core/chassis/extra.mjs', "import '../../../../tools/lib/cli.mjs';");
    assert.equal(problemsFor(root, 'no-legacy-import').length, 2);
  });
});

test('锁卡自测只保留原来的浏览器依赖，拆仓检查区分其签名影响', () => {
  withFixture(({ root, put, setOwnership }) => {
    setOwnership([...registered, 'cards']);
    const spec = '../../../../engine/render/lib/gpu.mjs';
    const file = 'beiming/cards/post/bloom/selftest.test.mjs';
    put(file, `import '${spec}';`);
    assert.deepEqual(checkArchitecture(root).problems, []);
    const strict = checkArchitecture(root, { standalone: true });
    assert.deepEqual(strict.problems.map(p => [p.file, p.rule]), [[file, 'locked-card-test-import']]);
    put(file, "import '../../../../tools/lib/cli.mjs';");
    put('beiming/cards/post/bloom/runtime.mjs', `import '${spec}';`);
    assert.equal(problemsFor(root, 'no-legacy-import').length, 2);
  });
});

test('真实仓库架构守卫通过', () => {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const result = checkArchitecture(repoRoot);
  assert.ok(result.scannedFiles > 0);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
});

// 复核独立夹具：每组单独建最小归属表和源码，经命令行比对规则名与归责文件。
const reviewDirs = ['api', 'verify', 'host', 'kernel', 'kernel/contracts', 'kernel/eval', 'sources', 'sources/legacy-page'];
const legacyFile = 'engine/run.mjs';
const apiFile = 'beiming/api/run.mjs';
const apiPython = 'beiming/api/run.py';
const evalFile = 'beiming/kernel/eval/frame.mjs';
const evalPython = 'beiming/kernel/eval/frame.py';
const pageFile = 'beiming/sources/legacy-page/use.mjs';
const valueModule = { 'beiming/api/value.mjs': 'export {}' };
const qaPackage = { 'tools/qa/checks.py': 'ok = True' };
const [W, R, E] = ['no-legacy-import', 'no-reverse-import', 'eval-pure'];
const reviewCases = [
  ['M1', pageFile, "import '../../../engine/render/still.mjs'", W, { 'engine/render/still.mjs': 'export {}' }],
  ['M1', pageFile, "import '../../../engine/render/video.mjs'", W, { 'engine/render/video.mjs': 'export {}' }],
  ['M2', legacyFile, "await import(('../beiming/api/value.mjs'))", R, valueModule],
  ['M2', legacyFile, "await import(`../beiming/${'api'}/value.mjs`)", R, valueModule],
  ['M3', 'engine/run.cjs', "const spec={require(x){return x}}; spec.require('../beiming/api/value.mjs')", '', {}],
  ['M4', 'beiming/verify/run.cjs', "require('../../tools/qa')", W, { 'tools/qa/index.js': 'exports.ok=true' }],
  ['M4', apiPython, 'from tools.qa import checks', W, qaPackage],
  ['M5', apiPython, 'from tools import qa', W, qaPackage],
  ['M5', evalPython, 'from beiming import host', E, { 'beiming/host/adapter.py': 'ok=True' }],
  ['M6', apiPython, 'import site', '', { 'site/local.py': '' }],
  ['M6', apiFile, "import 'tools/helpers.mjs'", '', { 'node_modules/tools/package.json': '{"name":"tools"}', 'node_modules/tools/helpers.mjs': 'export {}' }],
  ['M7', evalFile, "const frame={}; frame['roughness']=1", E, {}],
  ['M7', evalPython, "frame={}\nframe['roughness']=1", E, {}],
  ['M8', evalFile, "if (true) /shader/.test('text')", '', {}],
  ['M9', evalFile, "import * as THREE from 'https://esm.sh/three@0.170.0'", E, {}],
];

// 判断标准库模块需要 Python 3.10 及以上；没有时只跳过依赖它的一组。
const pythonReady = [...['BEIMING_PYTHON', 'BEIMING_PY', 'PYTHON'].map((name) => process.env[name]).filter(Boolean), 'python3', 'python']
  .some((command) => spawnSync(command, ['-I', '-c', 'import sys; sys.exit(sys.version_info < (3, 10))'], { timeout: 30_000, windowsHide: true }).status === 0);

function withReviewFixture(files, check) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'beiming-guard-review-'));
  try {
    for (const directory of reviewDirs) mkdirSync(path.join(root, 'beiming', directory), { recursive: true });
    const all = { [tableFile]: JSON.stringify({ entries: reviewDirs.map((entry) => ({ path: entry })) }), ...files };
    for (const [file, source] of Object.entries(all)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), source);
    }
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('复核独立夹具 15 组经命令行逐一符合期望', async (t) => {
  for (const [issue, file, source, rule, support] of reviewCases) {
    const skip = source === 'import site' && !pythonReady && '缺少 Python 3.10 及以上，无法判定标准库模块';
    await t.test(`${issue} ${source.replaceAll("\n", "; ")}`, { skip }, () => {
      withReviewFixture({ ...support, [file]: source }, (root) => {
        const run = spawnSync(process.execPath, [guardFile, '--root', root, '--json'], { encoding: 'utf8' });
        const actual = JSON.parse(run.stdout).problems.map((problem) => [problem.rule, problem.file]);
        assert.deepEqual(actual, rule ? [[rule, file]] : []);
        assert.equal(run.status, actual.length ? 1 : 0, run.stderr);
      });
    });
  }
});

test('不调用 Python 时按词法解析，复核夹具结论不变', () => {
  for (const [issue, file, source, rule, support] of reviewCases) {
    if (source === 'import site') continue;
    withReviewFixture({ ...support, [file]: source }, (root) => {
      const actual = checkArchitecture(root, { python: false }).problems.map((problem) => [problem.rule, problem.file]);
      assert.deepEqual(actual, rule ? [[rule, file]] : [], `${issue} ${source}`);
    });
  }
});

test('补充边界：成员调用、正则与除号、目录入口、网址包名和下标读写', () => {
  const cases = [
    [legacyFile, "module.require('../beiming/api/value.mjs')", [R]],
    [legacyFile, "import(prefix + '../beiming/api/value.mjs'); require(`../beiming/${name}`)", []],
    [legacyFile, "import(`${'../beiming/'}${`api/${'value'}`}.mjs`)", [R]],
    [apiFile, "require('../../engine/render/still'); import '../../engine/render/video/encode.mjs'", [W, W]],
    [apiFile, "import '../../engine/look/layers.js'", [W]],
    [apiFile, "const script = new URL('../../tools/env/py.mjs', import.meta.url);", [W]],
    ['beiming/api/run.ts', "import type Input from '../../tools/types';", [W]],
    ['beiming/api/run.tsx', "export type { Input } from '../../tools/types';", [W]],
    [apiFile, "await import(new URL('../../tools/lib/cli.mjs', import.meta.url))", [W]],
    [apiFile, "await import(new URL('../../tools/' + 'lib/cli.mjs', import.meta.url).href)", [W]],
    [apiFile, "const document = new URL('../../tools/guide.md', import.meta.url)", []],
    [apiFile, "import '../../engine/render/stills.mjs'", [W]],
    [apiFile, "import '../../engine/render'", [W]],
    [apiPython, 'from tools import private', [W]],
    [apiPython, "import importlib\nimportlib.import_module('engine.secret')", [W]],
    [evalFile, 'const ratio = width / height / 2; const fixed = /x/g;', []],
    [evalFile, 'for (const item of list) /material/.test(item)', []],
    [evalFile, 'const label = `${/shader/.source}`;', []],
    [evalFile, "if (frame['roughness'] === 1) frame.ok = true;", []],
    [evalFile, "frame['rough' + 'ness'] += 1", [E]],
    [evalFile, "import 'https://cdn.jsdelivr.net/npm/three@0.170/build/three.module.js'", [E]],
    [evalFile, "import 'https://unpkg.com/@react-three/fiber@8'", [E]],
    [evalFile, "import 'https://esm.sh/lodash@4'", []],
    [evalPython, "value = frame['roughness']", []],
    [evalPython, 'def apply(material):\n    return 1', [E]],
  ];
  const support = { ...valueModule, 'engine/render/still.mjs': '', 'engine/look/layers.js': '', 'tools/private/__init__.py': '' };
  for (const options of [{}, { python: false }]) {
    for (const [file, source, rules] of cases) {
      withReviewFixture({ ...support, [file]: source }, (root) => {
        const actual = checkArchitecture(root, options).problems.map((problem) => [problem.rule, problem.file]);
        assert.deepEqual(actual, rules.map((rule) => [rule, file]), `${JSON.stringify(options)} ${source}`);
      });
    }
  }
});

test('二审八组边界：数字插值、可选链、同名文件与包优先级、标准库覆盖、拼接写键、of 除号与协议相对 URL', () => {
  const cases = [
    // M2: 数字字面量模板插值与算术拼接
    [legacyFile, 'await import(`../beiming/api/v${1}.mjs`)', [R], { 'beiming/api/v1.mjs': 'export const id = "v1";' }],
    [legacyFile, 'await import(`../beiming/api/v${0 + 1}.mjs`)', [R], { 'beiming/api/v1.mjs': 'export const id = "v1";' }],
    // M3: 可选链 module?.require 加载模块 vs 自定义对象可选链放行
    ['engine/run.cjs', "module?.require('../beiming/api/value.cjs')", [R], { 'beiming/api/value.cjs': 'module.exports = 1;' }],
    ['engine/run.cjs', "const spec = { require(x) { return x; } }; spec?.require('../beiming/api/value.cjs')", [], {}],
    // M4: CommonJS 同名文件 tools/qa.js 优先于目录 tools/qa/index.js
    ['beiming/api/run.cjs', "require('../../tools/qa')", [W], { 'tools/qa.js': 'module.exports = 1;', 'tools/qa/index.js': 'module.exports = 2;' }],
    ['beiming/api/run.cjs', "require('../../tools/qa/')", [W], { 'tools/qa.js': 'module.exports = 1;', 'tools/qa/index.js': 'module.exports = 2;' }],
    // M5: Python 常规包 tools/qa/__init__.py 优先于同名 tools/qa.py；仅有 tools/qa.py 时拒绝
    [apiPython, 'from tools import qa', [W], { 'tools/__init__.py': '', 'tools/qa.py': '', 'tools/qa/__init__.py': '' }],
    [apiPython, 'from tools import qa', [W], { 'tools/__init__.py': '', 'tools/qa.py': '' }],
    // M7: Python 常量拼接写键在 AST 与词法模式下均拦下，只读放行
    [evalPython, "frame = {}\nframe['rough' + 'ness'] = 1", [E], {}],
    [evalPython, "frame = {}\nvalue = frame['rough' + 'ness']", [], {}],
    // M8: 合法标识符 of 后的除法保留后续禁用字段识别
    [evalFile, 'const of = 12; const frame = JSON.parse(\'{"shader":2}\'); const out = of / frame.shader / 2;', [E], {}],
    // M9: 浏览器协议相对 // URL 导入按网络包名判定，不误归为仓库路径
    [evalFile, "import '//esm.sh/three@0.170.0'", [E], {}],
    [evalFile, "import '//esm.sh/lodash@4'", [], {}],
  ];
  for (const options of [{}, { python: false }]) {
    for (const [file, source, rules, extra] of cases) {
      withReviewFixture({ ...valueModule, ...extra, [file]: source }, (root) => {
        const actual = checkArchitecture(root, options).problems.map((problem) => [problem.rule, problem.file]);
        assert.deepEqual(actual, rules.map((rule) => [rule, file]), `${JSON.stringify(options)} ${source}`);
      });
    }
  }
  if (pythonReady) {
    // M6: 仓库根存在常规包 statistics/__init__.py 时覆盖标准库应报白名单违例；仅存在命名空间目录 statistics/local.py 时走标准库放行
    withReviewFixture({ [apiPython]: 'import statistics', 'statistics/__init__.py': '' }, (root) => {
      const actual = checkArchitecture(root).problems.map((problem) => [problem.rule, problem.file]);
      assert.deepEqual(actual, [[W, apiPython]]);
    });
    withReviewFixture({ [apiPython]: 'import statistics', 'statistics/local.py': '' }, (root) => {
      const actual = checkArchitecture(root).problems.map((problem) => [problem.rule, problem.file]);
      assert.deepEqual(actual, []);
    });
  }
});
