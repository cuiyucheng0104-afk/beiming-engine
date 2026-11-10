// 出片端到端测试：三条路线的模版各建一部临时作品，按 G1 自检的命令跑通 build，再验复用、帧段缓存、中断清理。
// 会真的启动浏览器、渲染、编码（A / C 各约 10–20 秒，B 另需原生运行时），所以默认跳过：
//   FILM_E2E=1 node --test tests/film/e2e.test.mjs
// 需要：ffmpeg / ffprobe、装了 requirements.txt 的 Python（PYTHON=…）、Playwright 的 headless shell；B 另需 RAEA_BIN。
// 机器 QA 门：默认用测试替身 tests/film/fixtures/qa-stub.mjs（只验编排器的接线），FILM_E2E_REAL_QA=1 时用仓库里的 tools/qa/cli.mjs。
// 临时作品放在 FILM_TEST_ROOT（默认系统临时目录），films/ 里只留链接（B 例外，见 helpers.mjs），测完删除；FILM_TEST_KEEP=1 保留产物。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, CLI, QA_STUB, TEST_ROOT, runCli, makeWork, gitStatus, cleanupTestRoot } from './helpers.mjs';
import { validateRenderResult } from '../../engine/production/project.js';

const ON = process.env.FILM_E2E === '1';
const skip = ON ? false : '设 FILM_E2E=1 才跑（要渲染）';
const works = [];
const statusBefore = ON ? new Set(gitStatus() || []) : null;
after(() => { for (const w of works) w.cleanup(); cleanupTestRoot(); });

// 每个命令用一个专门的空 TMPDIR：跑完应仍是空的（编排器把子进程的临时文件都放进运行目录并删掉）
function sysTmp() {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(TEST_ROOT, 'tmp-'));
}
function env(tmp) {
  const e = { TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  if (!process.env.FILM_E2E_REAL_QA) e.FILM_QA_CLI = QA_STUB;
  return e;
}
const findSegs = dir => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter(n => String(n).split(/[\\/]/).some(p => p.startsWith('.segs-'))) : []);
const readRun = runJson => JSON.parse(fs.readFileSync(path.join(ROOT, runJson), 'utf8'));

function buildAndCheck(route) {
  const w = makeWork(route);
  works.push(w);
  const tmp = sysTmp();
  const r = runCli(['build', w.rel, '--profile', 'web-1080p24', '--waive', 'look,animatic', '--reason', 'G1 自检，非用户审批', '--json'], { env: env(tmp) });
  assert.equal(r.code, 0, `build 退出码 ${r.code}：${r.stderr.slice(-2000)}`);
  assert.equal(r.lines.length, 1, 'stdout 只有一个 JSON 对象');
  assert.equal(r.json.status, 'passed');
  const runDir = path.join(ROOT, r.json.runDir);
  for (const f of ['master.mp4', 'web.mp4', 'player.html', 'contact.jpg', 'poster.jpg', 'run.json', 'qa/report.json', 'checks/output.json']) {
    assert.ok(fs.existsSync(path.join(runDir, f)), `缺 ${f}`);
  }
  const run = readRun(r.json.runJson);
  assert.equal(run.output.frames, run.expected.frames, '帧数等于 film.json');
  assert.equal(run.output.frames, 72, '模版是 3 秒 × 24 fps');
  assert.deepEqual([run.output.width, run.output.height, run.output.fps], [1920, 1080, 24]);
  assert.deepEqual(run.output.color, { range: 'tv', space: 'bt709', transfer: 'bt709', primaries: 'bt709' });
  assert.equal(run.frameHashes.length, 72);
  assert.equal(run.softwareFallback, false);
  assert.ok(run.rerun.startsWith('node tools/film/cli.mjs build '));
  const v = validateRenderResult(run, { expectedFrameCount: run.expected.frames });
  assert.ok(v.ok, `run.json 过不了 validateRenderResult：${JSON.stringify(v.diagnostics)}`);
  assert.equal(fs.readFileSync(path.join(w.dir, 'out', 'latest'), 'utf8').trim(), r.json.runId);
  assert.deepEqual(findSegs(path.join(w.dir, 'out')), []);
  assert.deepEqual(fs.readdirSync(tmp), [], 'TMPDIR 不该留下文件');
  assert.deepEqual(run.repoTouched, []);
  for (const left of ['events.json', 'timeline.json', 'out/mix.wav', 'out/stems', 'out/native.mp4', 'out/render.json']) {
    assert.ok(!fs.existsSync(path.join(w.dir, left)), `作品目录残留旧位置的 ${left}`);
  }
  return { w, r, run, tmp };
}

test('A 路线：模版作品按 G1 命令出片，--from mux 只重跑封装及之后，帧段第二次 0 帧重渲', { skip, timeout: 900000 }, () => {
  const { w } = buildAndCheck('a');
  const tmp = sysTmp();
  const again = runCli(['build', w.rel, '--profile', 'web-1080p24', '--from', 'mux', '--json'], { env: env(tmp) });
  assert.equal(again.code, 0, again.stderr.slice(-1500));
  const st = Object.fromEntries(again.json.steps.map(s => [s.id, s.status]));
  assert.equal(st.video, 'cached');
  assert.equal(st.mix, 'cached');
  assert.equal(st.mux, 'done');
  const one = runCli(['render', w.rel, '--profile', 'web-1080p24', '--frames', '0:4', '--json'], { env: env(tmp) });
  assert.equal(one.code, 0, one.stderr.slice(-1500));
  assert.equal(one.json.rendered, 4);
  const two = runCli(['render', w.rel, '--profile', 'web-1080p24', '--frames', '0:4', '--json'], { env: env(tmp) });
  assert.equal(two.code, 0);
  assert.equal(two.json.rendered, 0, '第二次应全部复用');
  assert.equal(two.json.reused, 4);
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test('C 路线：模版作品出片（含声画拍点核对），竖屏 30 fps 档位的工作版能出', { skip, timeout: 900000 }, () => {
  const { w, run } = buildAndCheck('c');
  assert.ok(run.steps.some(s => s.id === 'cuecheck' && s.status === 'done'), 'C 模版写了 cuecheck，应当跑');
  const tmp = sysTmp();
  const v = runCli(['build', w.rel, '--profile', 'vertical-1080x1920-30', '--waive', 'look,animatic', '--reason', 'G1 自检', '--json'], { env: env(tmp) });
  assert.equal(v.code, 0, v.stderr.slice(-1500));
  const vr = readRun(v.json.runJson);
  assert.deepEqual([vr.output.width, vr.output.height, vr.output.fps, vr.output.frames], [1080, 1920, 30, 90]);
});

test('B 路线：模版作品经原生运行时出片', { skip: skip || (!process.env.RAEA_BIN && '没设 RAEA_BIN（原生运行时不随仓库分发）'), timeout: 900000 }, () => {
  const { run } = buildAndCheck('b');
  assert.equal(run.route, 'b');
  assert.match(run.tools.raea || '', /^0\.1\.0/);
  assert.ok(run.actualEncoder);
});

test('中断：渲染中收到 SIGINT 退出码 130，run.json 记 interrupted，不留进程、段目录与作品锁', { skip: skip || (process.platform === 'win32' && 'Windows 没有 SIGINT 的等价发送方式'), timeout: 300000 }, async () => {
  const w = makeWork('a');
  works.push(w);
  const tmp = sysTmp();
  const child = spawn(process.execPath, [CLI, 'build', w.rel, '--profile', 'web-1080p24', '--no-cache', '--json'], { cwd: ROOT, env: { ...process.env, ...env(tmp) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', b => { out += b; });
  const started = new Promise(resolve => child.stderr.on('data', b => { err += b; if (/▶ 逐帧渲染/.test(err)) resolve(); }));
  await Promise.race([started, new Promise(r => setTimeout(r, 120000))]);
  await new Promise(r => setTimeout(r, 1500));
  child.kill('SIGINT');
  const code = await new Promise(r => child.on('close', c => r(c)));
  assert.equal(code, 130, err.slice(-1500));
  const env1 = JSON.parse(out.trim().split('\n').at(-1));
  assert.equal(env1.error.code, 'interrupted');
  const run = readRun(env1.runJson);
  assert.equal(run.outcome, 'interrupted');
  assert.ok(!fs.existsSync(path.join(w.dir, 'out', '.lock')), '作品锁没放');
  assert.deepEqual(findSegs(path.join(w.dir, 'out')), []);
  const runDir = path.join(ROOT, run.runDir);
  const ps = spawnSync('ps', ['-A', '-o', 'command'], { encoding: 'utf8' }).stdout || '';
  assert.deepEqual(ps.split('\n').filter(l => l.includes(fs.realpathSync(runDir)) || l.includes(runDir)), [], '还有进程在用这次的运行目录');
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test('仓库卫生：端到端跑完，除了测试作品自己，工作区没有多出任何改动', { skip }, () => {
  const st = gitStatus(works.map(w => w.rel));
  if (st === null) return;
  assert.deepEqual(st.filter(l => !statusBefore.has(l)), []);
});
