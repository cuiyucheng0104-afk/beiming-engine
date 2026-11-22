// B8：跑题器（复用 tools/eval 会话隔离与过程观测，一条命令跑完一道题并落盘）+ 默认测试不再跑 eval 域
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { contractError, envError } from '../../tools/eval/lib/cli.mjs';
import { hasFfmpeg } from '../../tools/eval/lib/synth.mjs';
import { projectPublicQuestion, runExamQuestion } from './index.mjs';
import { solverEnv } from './runner.mjs';

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
const NEED_FFMPEG = { skip: !hasFfmpeg() && '环境缺少 ffmpeg / ffprobe' };
const POSIX = process.platform !== 'win32';
const SEATBELT = process.platform === 'darwin' && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;
// 用 ffmpeg 现做一条小片：默认 24 帧、1280×720、24 帧每秒、没有音轨（正好是 minimal.json 要的规格）
function video(file, { frames = 24, cut = false, audio = false } = {}) {
  const src = (d = '') => ['-f', 'lavfi', '-i', `testsrc=s=1280x720:r=24${d}`];
  const args = cut
    ? [...src(':d=0.5'), '-f', 'lavfi', '-i', 'color=c=white:s=1280x720:r=24:d=0.5', '-filter_complex', '[0:v][1:v]concat=n=2:v=1']
    : [...src(), ...(audio ? ['-f', 'lavfi', '-i', 'sine=f=440:r=48000', '-shortest'] : []), '-frames:v', String(frames)];
  const r = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, '-pix_fmt', 'yuv420p', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return file;
}
// 做题进程看得到的环境变量名。win32 多出来的是 libuv 必选的那几个：不传它就从父进程补，所以由跑题器填成隔离值
const ENV_POSIX = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'TERM', 'NODE_PATH', 'TMPDIR', 'TMP', 'TEMP', 'CLAUDE_CONFIG_DIR', 'PLAYWRIGHT_BROWSERS_PATH'];
const ENV_WIN = [...ENV_POSIX, 'WINDIR', 'SYSTEMDRIVE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'LOGONSERVER'];
const LIBUV_REQUIRED = ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'];
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
    judge: () => ({ metrics: { 'meta.bbox-limits': true } }),
    solver: async ({ worktreeDir, env }) => {
      assert.deepEqual(readdirSync(worktreeDir), ['question.json'], '做题目录里只有题面');
      assert.ok(env.CLAUDE_CONFIG_DIR.startsWith(root) && env.TMPDIR.startsWith(root), '会话配置和临时目录都在运行目录里');
      await writeFile(join(worktreeDir, 'submission.json'), '{}');
      return { tokens: 1200, turns: 1, gpuSeconds: 3 };
    },
  });
  assert.equal(res.runDir, join(root, sample.id, res.runId));
  assert.deepEqual(await readJson(join(res.runDir, 'worktree/question.json')), projectPublicQuestion(sample), '题面是公开投影，ext 已去掉');
  for (const f of ['meta.json', 'observation.json', 'session/settings.json', 'session/mcp.json', 'tmp', 'transcript']) assert.ok(existsSync(join(res.runDir, f)), f);
  const saved = await readJson(res.resultFile);
  assert.deepEqual(Object.keys(saved), ['format', 'questionId', 'level', 'source', 'model', 'runId', 'status', 'score', 'error', 'visibility', 'blockedBy', 'unmeasured', 'assertions', 'cost', 'overBudget', 'artifacts', 'createdAt']);
  assert.deepEqual([saved.format, saved.questionId, saved.level, saved.source, saved.status, saved.score, saved.visibility], ['bench-result/0.1', '28-1', 1, 'three', 'fail', 0.5, 'public']);
  assert.deepEqual([res.error, saved.error], [null, null], '没出错时 error 是 null');
  assert.equal(saved.assertions.length, sample.basePredicates.length + sample.scoring.length);
  assert.deepEqual(saved.assertions.filter((a) => a.pass).map((a) => a.name), ['meta.bbox-limits']);
  assert.deepEqual([[...new Set(saved.assertions.map((a) => a.basis))], saved.unmeasured], [['judge'], 0]);
  assert.equal((await readJson(join(res.runDir, 'observation.json'))).isolation, 'in-process');
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
  assert.deepEqual([boom.status, boom.error, (await readJson(boom.resultFile)).error], ['error', '炸了', '炸了']);
  assert.notEqual(boom.runId, over.runId, '同一秒重跑不撞目录');
  // 出没出错不看诊断文本：抛空消息（new Error()、''）照样是 error，记下的原因不是空的；返回值、result.json、observation.json 三处原因一致
  for (const [thrown, reason] of [[new Error(), 'Error'], ['', '原因不明']]) {
    const res = await runExamQuestion({ questionFile: qFile, evalRoot: root, solver: async () => { throw thrown; }, judge: allPass });
    assert.deepEqual([res.status, res.score, res.assertions], ['error', 0, []], `抛 ${JSON.stringify(String(thrown))}`);
    assert.deepEqual([res.error, (await readJson(res.resultFile)).error, (await readJson(join(res.runDir, 'observation.json'))).error], [reason, reason, reason]);
  }
  // 做完了但判分器自己抛错：照样落 error；只有环境缺失（错误码 env.*）照常往上抛，别的结构化错误和普通报错一样记进结果
  const badJudge = await runExamQuestion({ questionFile: qFile, evalRoot: root, solver: async () => ({}), judge: () => { throw new Error('量测器坏了'); } });
  assert.deepEqual((({ status, score, assertions, error }) => [status, score, assertions, error])(await readJson(badJudge.resultFile)), ['error', 0, [], '判分出错：量测器坏了']);
  assert.equal((await readJson(join(badJudge.runDir, 'observation.json'))).error, '判分出错：量测器坏了');
  await assert.rejects(runExamQuestion({ questionFile: qFile, evalRoot: root, solver: async () => ({}), judge: () => { throw envError('env.ffmpeg-missing', '没有 ffprobe', '装 FFmpeg'); } }), { code: 'env.ffmpeg-missing', exitCode: 3, message: '没有 ffprobe', hint: '装 FFmpeg' });
  const contract = await runExamQuestion({ questionFile: qFile, evalRoot: root, solver: async () => { throw contractError('contract.bad-value', '值不对'); }, judge: allPass });
  assert.deepEqual([contract.status, contract.score, contract.error, (await readJson(contract.resultFile)).error], ['error', 0, '值不对', '值不对']);

  const xfFile = join(dir, 'xf.json');
  await writeFile(xfFile, JSON.stringify({ ...sample, flags: { hidden: false, expectedFail: true, blockedBy: ['等 B9'] } }));
  let called = 0;
  const solver = async () => { called++; };
  const xf = await runExamQuestion({ questionFile: xfFile, evalRoot: root, solver });
  assert.deepEqual([xf.status, xf.blockedBy, xf.score, xf.cost.gpuSeconds, called], ['expected-fail', ['等 B9'], 0, 0, 0]);
  const forced = await runExamQuestion({ questionFile: xfFile, evalRoot: root, solver, judge: allPass, forceExpectedFail: true });
  assert.deepEqual([forced.status, called], ['pass', 1]);
});

test('B8-5 命令行：一条命令跑完落盘（exit 0），宿主用 ffprobe 实测成片判分，自报不算', NEED_FFMPEG, async (t) => {
  const sample = example('minimal.json');
  const { qFile, root, dir } = await setup(t, sample);
  const good = video(join(dir, 'good.mp4'));
  const short = video(join(dir, 'short.mp4'), { frames: 23 });
  // 做题替身：给了成片就拷成 deliverable.mp4；submission.json 里自报全过（宿主不认）；再打两行会话记录
  const solverFile = join(dir, 'solver.mjs');
  await writeFile(solverFile, `import fs from 'node:fs';
const q = JSON.parse(fs.readFileSync('question.json', 'utf8'));
if (process.argv[2]) fs.copyFileSync(process.argv[2], 'deliverable.mp4');
fs.writeFileSync('submission.json', JSON.stringify({ metrics: { 'delivery.spec': { pass: true } }, predicates: { 'delivery(width=1280, height=720, fps=24, frames=24)': true }, cost: { gpuSeconds: 2 } }));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: {} }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 3, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 } }));
`);
  const solve = (file, clip, ...more) => cli(['run', '--question', file, '--root', root, '--solver-cmd', `"${process.execPath}" "${solverFile}"${clip ? ` "${clip}"` : ''}`, ...more]);
  const ok = solve(qFile, good, '--source', 'core');
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual([ok.json.ok, ok.json.data.status, ok.json.data.score, ok.json.data.source, ok.json.data.unmeasured], [true, 'pass', 1, 'core', 0]);
  assert.deepEqual(ok.json.data.assertions.map((a) => [a.kind, a.pass, a.basis]), [['base', true, 'host'], ['scoring', true, 'host']]);
  assert.deepEqual({ ...ok.json.data.cost, wallMs: 0 }, { tokens: 125, turns: 3, toolCalls: 1, wallMs: 0, gpuSeconds: 2 });
  assert.deepEqual(ok.json.outputs, [ok.json.data.resultFile]);
  assert.deepEqual((await readJson(join(ok.json.data.runDir, 'observation.json'))).transcript, ['turn-01.jsonl', 'turn-01.stderr.log']);

  const few = solve(qFile, short);
  assert.deepEqual([few.code, few.json.data.status, few.json.data.score], [0, 'fail', 0], '少一帧（题目的负对照）');
  const none = solve(qFile, null);
  assert.deepEqual([none.code, none.json.data.status, none.json.data.score], [0, 'fail', 0], '只写 submission.json 不交片');
  const hiddenFile = join(dir, 'hidden.json');
  await writeFile(hiddenFile, JSON.stringify({ ...sample, flags: { ...sample.flags, hidden: true } }));
  const hid = solve(hiddenFile, good);
  assert.deepEqual([hid.json.data.status, hid.json.data.score, hid.json.data.assertions], ['pass', 1, []], '隐藏题交了合规成片也得满分');

  // 无头 claude 那条路：桩把收到的参数打出来，核对隔离参数
  const stub = join(dir, 'claude-stub.mjs');
  await writeFile(stub, `console.log(JSON.stringify({ type: 'system', subtype: 'init', model: process.argv.slice(2).join(' ') }));\n`);
  const viaClaude = cli(['run', '--question', qFile, '--root', root, '--model', 'm1', '--claude', stub]);
  assert.equal(viaClaude.code, 0, viaClaude.stderr);
  assert.equal(viaClaude.json.data.model, 'm1');
  const meta = await readJson(join(viaClaude.json.data.runDir, 'transcript/turn-01.jsonl'));
  assert.match(meta.model, /--model m1 .*--setting-sources project --strict-mcp-config --mcp-config .*session[\\/]mcp\.json$/);

  assert.equal(cli(['run', '--question', qFile, '--root', root, '--solver-cmd', `"${process.execPath}" -e process.exit(7)`]).json.data.status, 'error');
  if (POSIX) {   // 从软链启动也认得出自己是主入口
    const link = join(dir, 'runner-link.mjs');
    symlinkSync(RUNNER, link);
    const r = spawnSync(process.execPath, [link, 'run', '--question', qFile, '--root', root, '--solver-cmd', `"${process.execPath}" "${solverFile}" "${good}"`, '--json'], { encoding: 'utf8' });
    assert.deepEqual([r.status, JSON.parse(r.stdout).data.status], [0, 'pass'], r.stderr);
  }
  assert.doesNotMatch(readFileSync(RUNNER, 'utf8'), /tools\/lib\//, '跑题器只引 tools/eval/');
});

test('B8-6 默认判分：成片怎么找、切点实测、没有量测器的指标不采信自报', NEED_FFMPEG, async (t) => {
  const sample = example('minimal.json');
  const { qFile, root, dir } = await setup(t, {
    ...sample, basePredicates: [...sample.basePredicates, 'no_cut @ all'],
    scoring: [{ metric: 'delivery.spec', pass: '规格都对', weight: 0.5 }, { metric: 'meta.bbox-limits', pass: '全片不超限', weight: 0.5 }],
  });
  const clips = { good: video(join(dir, 'good.mp4')), cut: video(join(dir, 'cut.mp4'), { cut: true }), audio: video(join(dir, 'audio.mp4'), { audio: true }) };
  const claim = { metrics: { 'delivery.spec': true, 'meta.bbox-limits': true }, predicates: { 'no_cut @ all': true } };
  // 每个用例：solver 往做题目录里摆文件，回 [delivery, no_cut, delivery.spec, meta.bbox-limits] 四项过没过
  const judged = async (place) => {
    const res = await runExamQuestion({ questionFile: qFile, evalRoot: root, solver: ({ worktreeDir }) => { place(worktreeDir); } });
    return [res.assertions.map((a) => a.pass), res];
  };
  const [byName, res] = await judged((w) => { copyFileSync(clips.good, join(w, 'final.mp4')); writeFileSync(join(w, 'submission.json'), JSON.stringify(claim)); });
  assert.deepEqual(byName, [true, true, true, false], '做题目录里唯一的视频就是成片；自报的 meta.bbox-limits 不算');
  assert.deepEqual([res.status, res.score, res.unmeasured, res.assertions.map((a) => a.basis)], ['fail', 0.5, 1, ['host', 'host', 'host', 'unmeasured']]);

  const named = (w) => { mkdirSync(join(w, 'sub')); copyFileSync(clips.good, join(w, 'sub/clip.mp4')); copyFileSync(clips.cut, join(w, 'other.mp4')); };
  assert.deepEqual((await judged((w) => { named(w); writeFileSync(join(w, 'submission.json'), JSON.stringify({ video: 'sub/clip.mp4' })); }))[0], [true, true, true, false], 'submission.json 点名的相对路径');
  assert.deepEqual((await judged(named))[0], [false, false, false, false], '两条视频又没点名：认不出成片');
  assert.deepEqual((await judged((w) => copyFileSync(clips.cut, join(w, 'out.mp4'))))[0], [true, false, true, false], '有切点');
  assert.deepEqual((await judged((w) => copyFileSync(clips.audio, join(w, 'deliverable.mp4'))))[0], [false, false, false, false], '题目要无声，成片带音轨');
  assert.deepEqual((await judged((w) => writeFileSync(join(w, 'submission.json'), JSON.stringify({ ...claim, video: clips.good }))))[0], [false, false, false, false], '点名做题目录外面的文件');
  if (POSIX) assert.deepEqual((await judged((w) => symlinkSync(clips.good, join(w, 'deliverable.mp4'))))[0], [false, false, false, false], '软链指到做题目录外面');
});

test('B8-7 做题进程被信号杀掉：产物写完了也判 error，记 0 分', async (t) => {
  const { qFile, root, dir } = await setup(t, example('minimal.json'));
  const killer = join(dir, 'killed.mjs');
  await writeFile(killer, `import fs from 'node:fs';\nif (process.argv[2]) fs.copyFileSync(process.argv[2], 'deliverable.mp4');\nfs.writeFileSync('done.txt', 'ok');\nprocess.kill(process.pid, 'SIGTERM');\nsetTimeout(() => {}, 30000);\n`);
  const res = await runExamQuestion({ questionFile: qFile, evalRoot: root, solverCmd: `"${process.execPath}" "${killer}"`, judge: allPass });
  const obs = await readJson(join(res.runDir, 'observation.json'));
  assert.deepEqual([res.status, res.score, res.assertions, res.artifacts.map((a) => a.path)], ['error', 0, [], ['done.txt']], '判分全过也不采信');
  assert.deepEqual((({ status, score }) => [status, score])(await readJson(res.resultFile)), ['error', 0]);
  if (POSIX) assert.deepEqual([obs.exitCode, obs.timedOut, obs.error], [null, false, '做题进程异常终止（无退出码，可能被信号中断）']);
  assert.ok(obs.error);
  assert.deepEqual([res.error, (await readJson(res.resultFile)).error], [obs.error, obs.error]);
  // 已经知道没做完就不再判分：判分器要的量测文件没写出来（读它抛 ENOENT），这条失败记录也照样落盘
  const noJudge = await runExamQuestion({ questionFile: qFile, evalRoot: root, solverCmd: `"${process.execPath}" "${killer}"`, judge: ({ worktreeDir }) => JSON.parse(readFileSync(join(worktreeDir, 'measurements.json'), 'utf8')) });
  assert.deepEqual((({ status, score, assertions }) => [status, score, assertions])(await readJson(noJudge.resultFile)), ['error', 0, []]);
  assert.ok(existsSync(join(noJudge.runDir, 'observation.json')));
  if (!hasFfmpeg()) return;
  const good = video(join(dir, 'good.mp4'));
  // 做题函数交完合规的真片再抛 new Error()（消息是空的），默认判分：还是 error、0 分
  const threw = await runExamQuestion({ questionFile: qFile, evalRoot: root, solver: ({ worktreeDir }) => { copyFileSync(good, join(worktreeDir, 'deliverable.mp4')); throw new Error(); } });
  assert.deepEqual((({ status, score, assertions }) => [status, score, assertions])(await readJson(threw.resultFile)), ['error', 0, []]);
  assert.deepEqual(threw.artifacts.map((a) => a.path), ['deliverable.mp4']);
  // 交完合规的真片再被杀：命令行信封和落盘都是 error、0 分
  const killed = cli(['run', '--question', qFile, '--root', root, '--solver-cmd', `"${process.execPath}" "${killer}" "${good}"`]);
  const disk = await readJson(killed.json.data.resultFile);
  assert.deepEqual([killed.code, killed.json.data.status, killed.json.data.score, disk.status, disk.score], [0, 'error', 0, 'error', 0], killed.stderr);
  assert.ok(disk.error && killed.json.data.error === disk.error, '命令行信封和落盘都带原因');
  assert.ok(disk.artifacts.some((a) => a.path === 'deliverable.mp4'));
});

test('B8-8 隐藏题：blockedBy 原文和精确的墙钟预算不回显', async (t) => {
  const sample = example('minimal.json');
  const { qFile, root, dir } = await setup(t, { ...sample, flags: { hidden: true, expectedFail: true, blockedBy: ['阈值 41.5 dB 还没校准'] } });
  const xf = cli(['run', '--question', qFile, '--root', root]);
  assert.deepEqual([xf.code, xf.json.data.status, xf.json.data.blockedBy], [0, 'expected-fail', ['[hidden]']]);
  assert.ok(!JSON.stringify(xf.json).includes('还没校准') && !dump(xf.json.data.runDir).includes('还没校准'));

  const slow = `"${process.execPath}" -e "setTimeout(()=>{},30000)"`;
  const timeout = async (hidden) => {
    const file = join(dir, `slow-${hidden}.json`);
    await writeFile(file, JSON.stringify({ ...sample, budget: { ...sample.budget, wallMs: 317 }, flags: { ...sample.flags, hidden } }));
    const res = await runExamQuestion({ questionFile: file, evalRoot: root, solverCmd: slow, judge: allPass });
    assert.equal((await readJson(res.resultFile)).error, res.error);
    return [res.status, res.overBudget, res.error, dump(res.runDir).includes('317 ms')];
  };
  assert.deepEqual(await timeout(true), ['error', ['wallMs'], '超过墙钟预算，已结束', false]);
  assert.deepEqual(await timeout(false), ['error', ['wallMs'], '超过墙钟预算 317 ms，已结束', true]);
  // 隐藏题的判分器抛错：原因里可能带指标名和阈值，不落盘
  const leaky = await runExamQuestion({ questionFile: qFile, evalRoot: root, forceExpectedFail: true, solver: async () => ({}), judge: () => { throw new Error('loop.closure-psnr 低于 41.5'); } });
  assert.deepEqual([leaky.status, leaky.error, (await readJson(leaky.resultFile)).error, dump(leaky.runDir).includes('41.5')], ['error', '判分出错', '判分出错', false]);
  // 同一类诊断从做题这头抛出来也一样：做题函数和宿主同进程，报错里可能带私有段和隐藏题目录，三处都只留固定的一句
  const viaSolver = await runExamQuestion({ questionFile: qFile, evalRoot: root, forceExpectedFail: true, solver: async () => { throw new Error(`controls.referencePass 读不到：${dir}`); }, judge: allPass });
  const reasons = [viaSolver.error, (await readJson(viaSolver.resultFile)).error, (await readJson(join(viaSolver.runDir, 'observation.json'))).error];
  assert.deepEqual([viaSolver.status, viaSolver.score, ...reasons], ['error', 0, '做题出错', '做题出错', '做题出错']);
  assert.ok(!reasons.join().includes(dir) && !dump(viaSolver.runDir).includes('referencePass'));
  // 结构化错误（EvalError）也不例外：别的错误码照样记成这次运行出错并落盘；环境缺失（env.*）往上抛、退出码 3、不落成绩，但只剩错误码。两条路上私有标记和隐藏题目录都不外露
  const diagnostic = `controls.referencePass=PRIVATE-9f3 读不到：${dir}`;
  const leaks = (...texts) => ['PRIVATE-9f3', dir].filter((x) => texts.join('\n').includes(x));
  for (const [who, reason] of [['solver', '做题出错'], ['judge', '判分出错']]) {
    const run = (err) => runExamQuestion({ questionFile: qFile, evalRoot: root, forceExpectedFail: true, solver: async () => { if (who === 'solver') throw err; return {}; }, judge: (ctx) => { if (who === 'judge') throw err; return allPass(ctx); } });
    // 错误码不是「env. 加短横线小写」的不算环境缺失：错误码本身也可能带私有文字
    for (const err of [contractError('contract.bad-value', diagnostic, diagnostic), envError(`env.${dir}`, diagnostic)]) {
      const res = await run(err);
      const errors = [res.error, (await readJson(res.resultFile)).error, (await readJson(join(res.runDir, 'observation.json'))).error];
      assert.deepEqual([res.status, res.score, ...errors], ['error', 0, reason, reason, reason], `${who} ${err.exitCode}`);
      assert.deepEqual([leaks(...errors), dump(res.runDir).includes('PRIVATE-9f3')], [[], false], `${who} ${err.exitCode}`);
    }
    const env = await run(envError('env.ffmpeg-missing', diagnostic, diagnostic)).then(() => null, (e) => e);
    assert.deepEqual([env?.exitCode, env?.code, leaks(env?.message, env?.stack, env?.hint, JSON.stringify(env))], [3, 'env.ffmpeg-missing', []], who);
  }
  // 命令做题的失败原因只有退出码
  const exit7 = await runExamQuestion({ questionFile: qFile, evalRoot: root, forceExpectedFail: true, solverCmd: `"${process.execPath}" -e "process.exit(7)"`, judge: allPass });
  assert.deepEqual([exit7.status, exit7.error, (await readJson(exit7.resultFile)).error], ['error', '做题命令 exit 7', '做题命令 exit 7']);
});

test('B8-9 做题进程：环境变量只有白名单；有系统沙箱时读不到原题、隐藏题目录、meta.json 和别的运行', async (t) => {
  const sample = example('minimal.json');
  const { root, dir } = await setup(t, sample);
  mkdirSync(join(dir, 'hidden'));
  const qFile = join(dir, 'hidden/q.json');
  const answers = join(dir, 'hidden/answers.txt');
  await writeFile(qFile, JSON.stringify({ ...sample, flags: { ...sample.flags, hidden: true } }));
  await writeFile(answers, 'ANSWER-KEY');
  const saved = { B8_HOST_SECRET: process.env.B8_HOST_SECRET, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  Object.assign(process.env, { B8_HOST_SECRET: 'host-only', ANTHROPIC_API_KEY: 'dummy' });

  const prev = await runExamQuestion({ questionFile: qFile, evalRoot: root, solver: ({ worktreeDir }) => { writeFileSync(join(worktreeDir, 'prev.txt'), 'PREV'); }, judge: allPass });
  const probe = join(dir, 'probe.mjs');
  await writeFile(probe, `import fs from 'node:fs';
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return 'DENIED:' + e.code; } };
const [q, sibling, prev] = process.argv.slice(2);
const write = (f) => { try { fs.writeFileSync(f, '{"status":"pass","score":1}'); return 'WROTE'; } catch (e) { return 'DENIED:' + e.code; } };
fs.writeFileSync('probe.json', JSON.stringify({ env: process.env, own: read('question.json'), nearby: read(process.argv[1]),
  secrets: [read(q), read(sibling), read('../meta.json'), read(prev), write('../result.json'), write('../observation.json')] }));
`);
  const res = await runExamQuestion({ questionFile: qFile, evalRoot: root, solverCmd: `"${process.execPath}" "${probe}" "${qFile}" "${answers}" "${join(prev.runDir, 'worktree/prev.txt')}"`, judge: allPass });
  const seen = await readJson(join(res.runDir, 'worktree/probe.json'));
  // __CF_USER_TEXT_ENCODING 是 macOS 自己给每个进程补的，不是宿主传的
  assert.deepEqual(Object.keys(seen.env).filter((k) => !(POSIX ? ENV_POSIX : ENV_WIN).includes(k.toUpperCase()) && k !== '__CF_USER_TEXT_ENCODING'), [], '命令做题：只有白名单里的环境变量');
  assert.ok(seen.env.TMPDIR && seen.env.CLAUDE_CONFIG_DIR && !JSON.stringify(seen.env).includes(process.env.B8_HOST_SECRET));
  // Windows：libuv 必选的变量是跑题器自己填的隔离值，不是从宿主补进来的真实身份
  if (!POSIX) assert.deepEqual([seen.env.USERNAME, seen.env.USERPROFILE], ['bench', join(res.runDir, 'worktree')]);
  assert.deepEqual(Object.keys(JSON.parse(seen.own)), ['id', 'level', 'title', 'brief', 'deliverable', 'assets']);
  const { isolation } = await readJson(join(res.runDir, 'observation.json'));
  assert.equal(isolation, SEATBELT ? 'seatbelt' : 'process-cwd', '实际的隔离级别照实记');
  assert.match(seen.nearby, /^import fs/, '不相干的文件（做题脚本自己）照常读得到');
  assert.deepEqual([res.status, (await readJson(res.resultFile)).score], ['pass', 1], '结果文件是宿主写的那一份');
  if (SEATBELT) assert.deepEqual(seen.secrets.map((s) => s.slice(0, 7)), Array(6).fill('DENIED:'), '原题、隐藏题目录、meta.json、别的运行读不到；结果和观测改不了');
  else t.diagnostic('这台机器没有可用的 sandbox-exec：文件边界没测，隔离级别是 process-cwd');

  // --model 那条路：模型的凭据透传，宿主别的变量照样不传
  const stub = join(dir, 'env-stub.mjs');
  await writeFile(stub, `console.log(JSON.stringify({ type: 'system', subtype: 'init', model: Object.keys(process.env).join(' ') }));\n`);
  const viaModel = await runExamQuestion({ questionFile: qFile, evalRoot: root, model: 'm1', claude: stub, judge: allPass });
  const keys = (await readJson(join(viaModel.runDir, 'transcript/turn-01.jsonl'))).model.split(' ');
  assert.deepEqual([keys.includes('ANTHROPIC_API_KEY'), keys.includes('B8_HOST_SECRET')], [true, false]);
});

test('B8-9b 做题进程的环境变量按平台构造：POSIX 只过滤；win32 把 libuv 必选的变量全部显式填上，宿主身份一个不漏', () => {
  const run = { worktree: 'D:\\ProgramData\\runs\\r1\\worktree', tmpDir: 'D:\\ProgramData\\runs\\r1\\tmp' };
  // Windows 的变量名大小写不定（Path、SystemRoot、windir…）；alice 那几个值代表宿主的真实身份和家目录（放在 ProgramData 下只是为了不像本机路径）
  const host = { Path: 'C:\\Windows\\System32', SystemRoot: 'D:\\Windows', windir: 'D:\\Windows', SystemDrive: 'D:', ComSpec: 'D:\\Windows\\System32\\cmd.exe', PATHEXT: '.EXE',
    USERNAME: 'alice', UserDomain: 'CORP', LOGONSERVER: '\\\\DC01', USERPROFILE: 'C:\\ProgramData\\alice', HOME: 'C:\\ProgramData\\alice', HOMEDRIVE: 'C:', HOMEPATH: '\\ProgramData\\alice',
    Temp: 'C:\\ProgramData\\alice\\Temp', TEMP: 'C:\\ProgramData\\alice\\Temp', APPDATA: 'C:\\ProgramData\\alice\\AppData', B8_HOST_SECRET: 's3', ANTHROPIC_API_KEY: 'k', https_proxy: 'http://p' };
  const win = solverEnv(run, false, 'win32', host);
  assert.deepEqual(win, {
    PATH: 'C:\\Windows\\System32', SYSTEMROOT: 'D:\\Windows', WINDIR: 'D:\\Windows', SYSTEMDRIVE: 'D:', COMSPEC: 'D:\\Windows\\System32\\cmd.exe', PATHEXT: '.EXE',
    HOME: run.worktree, USERPROFILE: run.worktree, HOMEDRIVE: 'D:', HOMEPATH: '\\', TEMP: run.tmpDir, TMP: run.tmpDir, TMPDIR: run.tmpDir,
    USERNAME: 'bench', USERDOMAIN: 'BENCH', LOGONSERVER: '\\\\LOCALHOST',
  });
  // 少一个，libuv 就从父进程补一个
  for (const k of LIBUV_REQUIRED) assert.ok(win[k], `win32 缺 ${k}`);
  assert.deepEqual(Object.keys(win).filter((k) => !ENV_WIN.includes(k)), []);
  assert.ok(!/alice|CORP|DC01|s3/.test(JSON.stringify(win)));
  // 宿主没有的系统目录给默认值；--model 时凭据和代理照传，名字同样收成大写
  const bare = solverEnv(run, true, 'win32', { Path: 'C:\\Windows\\System32', ANTHROPIC_API_KEY: 'k', https_proxy: 'http://p', B8_HOST_SECRET: 's3' });
  assert.deepEqual([bare.SYSTEMROOT, bare.WINDIR, bare.SYSTEMDRIVE, bare.COMSPEC, bare.PATHEXT], ['C:\\Windows', 'C:\\Windows', 'C:', 'C:\\Windows\\System32\\cmd.exe', '.COM;.EXE;.BAT;.CMD']);
  assert.deepEqual([bare.ANTHROPIC_API_KEY, bare.HTTPS_PROXY, 'B8_HOST_SECRET' in bare, 'https_proxy' in bare], ['k', 'http://p', false, false]);
  // 宿主一个变量都没有（连 PATH 也没有）：11 个必选的照样一个不缺，PATH 给系统目录；宿主的 PATH 是空串就留空串
  const empty = solverEnv(run, false, 'win32', {});
  assert.deepEqual(LIBUV_REQUIRED.filter((k) => !Object.hasOwn(empty, k)), []);
  assert.equal(empty.PATH, 'C:\\Windows\\System32');
  assert.equal(solverEnv(run, false, 'win32', { Path: '' }).PATH, '');

  // POSIX：名字分大小写，原样过滤，不补 Windows 的那些
  const posixHost = { PATH: '/bin', HOME: '/Users/alice', TMPDIR: '/runs/tmp', USER: 'alice', USERNAME: 'alice', LOGNAME: 'alice', SHELL: '/bin/zsh', B8_HOST_SECRET: 's3', ANTHROPIC_API_KEY: 'k', https_proxy: 'http://p' };
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(solverEnv(run, false, platform, posixHost), { PATH: '/bin', HOME: '/Users/alice', TMPDIR: '/runs/tmp' });
    assert.deepEqual(solverEnv(run, true, platform, posixHost), { PATH: '/bin', HOME: '/Users/alice', TMPDIR: '/runs/tmp', ANTHROPIC_API_KEY: 'k', https_proxy: 'http://p' });
  }
});

test('B8-10 命令行退出码：用法错 2、环境缺 3、题目不合格 4', async (t) => {
  const sample = example('minimal.json');
  const { qFile, root, dir } = await setup(t, sample);
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

test('B8-11 从标准输入跑的脚本（node -）也能导入公共入口', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-'], { cwd: REPO, encoding: 'utf8', input: "import { validateQuestion } from './beiming/bench/index.mjs';\nconsole.log(typeof validateQuestion);\n" });
  assert.deepEqual([r.status, r.stdout.trim()], [0, 'function'], r.stderr);
});
