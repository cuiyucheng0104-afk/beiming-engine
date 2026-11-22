// B8：跑题器（复用 tools/eval 会话隔离与过程观测，一条命令跑完一道题并落盘）+ 默认测试不再跑 eval 域
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { projectPublicQuestion, runExamQuestion } from './index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const RUNNER = join(HERE, 'runner.mjs');
const example = (name) => JSON.parse(readFileSync(join(REPO, 'beiming/kernel/contracts/question-file/examples', name), 'utf8'));
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const allPass = ({ question }) => ({
  metrics: Object.fromEntries(question.scoring.map((s) => [s.metric, { pass: true }])),
  predicates: Object.fromEntries(question.basePredicates.map((p) => [p, true])),
});

// 临时目录里放一道题，回 { dir, qFile, root }；测试结束自动删
async function setup(t, question) {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), 'beiming-b8-')));   // native：Windows 的 8.3 短名也展开，和跑题器算出的路径对得上
  t.after(() => rm(dir, { recursive: true, force: true }));
  const qFile = join(dir, 'q.json');
  await writeFile(qFile, typeof question === 'string' ? question : JSON.stringify(question, null, 2));
  return { dir, qFile, root: join(dir, 'runs') };
}
const cli = (args) => {
  const r = spawnSync(process.execPath, [RUNNER, ...args, '--json'], { encoding: 'utf8' });
  return { code: r.status, stderr: r.stderr, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
};
// 运行目录下全部文件的文本，用来查私有段有没有漏进去
const dump = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name), 'utf8')).join('\n');

test('B8-1 默认测试 node tools/run-tests.mjs 不再跑 eval 评测域，显式 --only eval 仍可运行', () => {
  const def = spawnSync(process.execPath, [join(REPO, 'tools/run-tests.mjs'), '--list', '--json'], { encoding: 'utf8' });
  assert.equal(def.status, 0, def.stderr);
  const parsed = JSON.parse(def.stdout);
  const evalSuite = parsed.suites.find((s) => s.domain === 'eval');
  assert.ok(!evalSuite || evalSuite.status === 'skip', '默认测试中 eval 域不得处于会运行状态');

  const explicit = spawnSync(process.execPath, [join(REPO, 'tools/run-tests.mjs'), '--only', 'eval', '--list', '--json'], { encoding: 'utf8' });
  assert.equal(explicit.status, 0, explicit.stderr);
  const expParsed = JSON.parse(explicit.stdout);
  assert.ok(expParsed.suites.some((s) => s.domain === 'eval' && s.status !== 'skip'), '--only eval 必须会运行 eval 域');
});

test('B8-2 公开题：隔离目录、公开投影题面、过程观测、标准结果落盘', async (t) => {
  const sample = example('full.json');
  const { qFile, root } = await setup(t, { ...sample, ext: { 'lab.note': '私有' } });
  const res = await runExamQuestion({
    questionFile: qFile,
    evalRoot: root,
    source: 'three',
    solver: async ({ worktreeDir, env }) => {
      assert.deepEqual(readdirSync(worktreeDir), ['question.json'], '做题目录里只有题面');
      assert.ok(env.CLAUDE_CONFIG_DIR.startsWith(root) && env.TMPDIR.startsWith(root), '会话配置和临时目录都在运行目录里');
      await writeFile(join(worktreeDir, 'submission.json'), JSON.stringify({ metrics: { 'meta.bbox-limits': true }, predicates: {} }));
      return { tokens: 1200, turns: 1, gpuSeconds: 3 };
    },
  });
  assert.equal(res.runDir, join(root, sample.id, res.runId));
  assert.deepEqual(await readJson(join(res.runDir, 'worktree/question.json')), projectPublicQuestion(sample), '题面是公开投影，ext 已去掉');
  for (const f of ['meta.json', 'observation.json', 'session/settings.json', 'session/mcp.json', 'tmp', 'transcript']) assert.ok(existsSync(join(res.runDir, f)), f);
  const saved = await readJson(res.resultFile);
  assert.deepEqual(Object.keys(saved), ['format', 'questionId', 'level', 'source', 'model', 'runId', 'status', 'score', 'visibility', 'blockedBy', 'assertions', 'cost', 'overBudget', 'artifacts', 'createdAt']);
  assert.deepEqual([saved.format, saved.questionId, saved.level, saved.source, saved.status, saved.score, saved.visibility], ['bench-result/0.1', '28-1', 1, 'three', 'fail', 0.5, 'public']);
  assert.equal(saved.assertions.length, sample.basePredicates.length + sample.scoring.length);
  assert.deepEqual(saved.assertions.filter((a) => a.pass).map((a) => a.name), ['meta.bbox-limits']);
  assert.deepEqual({ ...saved.cost, wallMs: 0 }, { tokens: 1200, turns: 1, toolCalls: null, wallMs: 0, gpuSeconds: 3 });
  assert.deepEqual(saved.artifacts.map((a) => a.path), ['submission.json']);
  assert.match(saved.artifacts[0].sha256, /^sha256:[0-9a-f]{64}$/);
  assert.ok(!dump(res.runDir).includes(qFile), '运行目录里不留原题路径');
});

test('B8-3 隐藏题：做题方和运行目录都见不到私有段，宿主侧判分只落总分', async (t) => {
  const sample = example('full.json');
  const { qFile, root } = await setup(t, { ...sample, flags: { ...sample.flags, hidden: true } });
  const res = await runExamQuestion({ questionFile: qFile, evalRoot: root, solver: async () => ({ tokens: 10 }), judge: allPass });
  assert.deepEqual(Object.keys(await readJson(join(res.runDir, 'worktree/question.json'))), ['id', 'level', 'title', 'brief', 'deliverable', 'assets']);
  assert.deepEqual([res.status, res.score, res.visibility, res.assertions], ['pass', 1, 'hidden', []]);
  const text = dump(res.runDir);
  for (const secret of ['loop.closure-psnr', 'referencePass', 'orbit_total', qFile]) assert.ok(!text.includes(secret), secret);
});

test('B8-4 判分：超预算、做题出错都不算过；expectedFail 默认不实跑', async (t) => {
  const sample = example('minimal.json');
  const { qFile, root, dir } = await setup(t, sample);
  const over = await runExamQuestion({ questionFile: qFile, evalRoot: root, solver: async () => ({ tokens: sample.budget.tokens + 1 }), judge: allPass });
  assert.deepEqual([over.status, over.score, over.overBudget], ['fail', 1, ['tokens']]);
  const boom = await runExamQuestion({ questionFile: qFile, evalRoot: root, solver: async () => { throw new Error('炸了'); }, judge: allPass });
  assert.equal(boom.status, 'error');
  assert.notEqual(boom.runId, over.runId, '同一秒重跑不撞目录');

  const xfFile = join(dir, 'xf.json');
  await writeFile(xfFile, JSON.stringify({ ...sample, flags: { hidden: false, expectedFail: true, blockedBy: ['等 B9'] } }));
  let called = 0;
  const solver = async () => { called++; };
  const xf = await runExamQuestion({ questionFile: xfFile, evalRoot: root, solver });
  assert.deepEqual([xf.status, xf.blockedBy, xf.score, xf.cost.gpuSeconds, called], ['expected-fail', ['等 B9'], 0, 0, 0]);
  const forced = await runExamQuestion({ questionFile: xfFile, evalRoot: root, solver, judge: allPass, forceExpectedFail: true });
  assert.deepEqual([forced.status, called], ['pass', 1]);
});

test('B8-5 命令行：一条命令跑完落盘（exit 0），会话记录里的用量进结果；用法错 2、环境缺 3、题目不合格 4', async (t) => {
  const sample = example('minimal.json');
  const { qFile, root, dir } = await setup(t, sample);
  const solverFile = join(dir, 'solver.mjs');
  await writeFile(solverFile, `import fs from 'node:fs';
const q = JSON.parse(fs.readFileSync('question.json', 'utf8'));
fs.writeFileSync('submission.json', JSON.stringify({ metrics: { [q.scoring[0].metric]: { pass: true } }, predicates: { [q.basePredicates[0]]: true }, cost: { gpuSeconds: 2 } }));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: {} }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 3, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 } }));
`);
  const ok = cli(['run', '--question', qFile, '--root', root, '--solver-cmd', `"${process.execPath}" "${solverFile}"`, '--source', 'core']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual([ok.json.ok, ok.json.data.status, ok.json.data.score, ok.json.data.source], [true, 'pass', 1, 'core']);
  assert.deepEqual({ ...ok.json.data.cost, wallMs: 0 }, { tokens: 125, turns: 3, toolCalls: 1, wallMs: 0, gpuSeconds: 2 });
  assert.deepEqual(ok.json.outputs, [ok.json.data.resultFile]);
  assert.deepEqual((await readJson(join(ok.json.data.runDir, 'observation.json'))).transcript, ['turn-01.jsonl', 'turn-01.stderr.log']);

  // 无头 claude 那条路：桩把收到的参数打出来，核对隔离参数
  const stub = join(dir, 'claude-stub.mjs');
  await writeFile(stub, `console.log(JSON.stringify({ type: 'system', subtype: 'init', model: process.argv.slice(2).join(' ') }));\n`);
  const viaClaude = cli(['run', '--question', qFile, '--root', root, '--model', 'm1', '--claude', stub]);
  assert.equal(viaClaude.code, 0, viaClaude.stderr);
  assert.equal(viaClaude.json.data.model, 'm1');
  const meta = await readJson(join(viaClaude.json.data.runDir, 'transcript/turn-01.jsonl'));
  assert.match(meta.model, /--model m1 .*--setting-sources project --strict-mcp-config --mcp-config .*session[\\/]mcp\.json$/);

  assert.equal(cli(['run', '--question', qFile, '--root', root, '--solver-cmd', `"${process.execPath}" -e process.exit(7)`]).json.data.status, 'error');
  const failed = cli(['run', '--question', qFile, '--root', root, '--solver-cmd', `"${process.execPath}" -e ""`]);
  assert.deepEqual([failed.code, failed.json.data.status, failed.json.data.score], [0, 'fail', 0], '没交 submission.json：跑完了，但不及格');

  assert.equal(cli(['run', '--question', qFile, '--root', root]).code, 2, '没说谁来做题');
  assert.equal(cli(['run', '--question', qFile, '--root', root, '--solver-cmd', ' ']).code, 2, '做题命令是空的');
  assert.equal(cli(['run', '--question', qFile, '--root', root, '--solver-cmd', join(dir, '没有这个程序')]).code, 3);
  assert.equal(cli(['run', '--question', qFile, '--root', join(REPO, 'out/b8-runs'), '--solver-cmd', 'true']).code, 2, '运行根在仓库里');
  assert.equal(cli(['run', '--question', join(dir, '没有.json'), '--root', root, '--solver-cmd', 'true']).code, 2);
  assert.equal(cli(['run', '--question', qFile, '--root', root, '--source', 'unity', '--solver-cmd', 'true']).code, 2);
  assert.equal(cli(['run', '--question', qFile, '--root', root, '--model', 'm1', '--claude', join(dir, '没有这个程序')]).code, 3);
  const badFile = join(dir, 'bad.json');
  await writeFile(badFile, JSON.stringify({ ...sample, scoring: [{ ...sample.scoring[0], weight: 0.5 }] }));
  const bad = cli(['run', '--question', badFile, '--root', root, '--solver-cmd', 'true']);
  assert.deepEqual([bad.code, bad.json.error.code], [4, 'contract.question-invalid']);
  assert.match(bad.json.error.message, /QF1/);
  assert.ok(!existsSync(join(REPO, 'out/b8-runs')));
});
