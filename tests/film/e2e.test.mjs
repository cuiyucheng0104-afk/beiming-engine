// 出片端到端测试：三条路线的模版各建一部临时作品，按 G1 自检的命令跑通 build，再验复用、帧段缓存、中断清理。
// 会真的启动浏览器、渲染、编码（A / C 各约 10–20 秒，B 另需原生运行时），所以默认跳过：
//   FILM_E2E=1 node --test tests/film/e2e.test.mjs
// 需要：ffmpeg / ffprobe、装了 requirements.txt 的 Python（PYTHON=…）、Playwright 的 headless shell；B 另需 RAEA_BIN。
// 机器 QA 门：默认用测试替身 tests/film/fixtures/qa-stub.mjs（只验编排器的接线：模版画面能不能过真 QA 是各路线模版的事），
// FILM_E2E_REAL_QA=1 时用仓库里的 tools/qa/cli.mjs（模版过不了硬门时 build 退出码 4，测试会如实失败），并加跑「竖屏档位交给真 QA 的口径」：
//   它只要求交付规格四项与文字视口按档位判，不要求模版过全部硬门；单跑它：FILM_E2E=1 FILM_E2E_REAL_QA=1 node --test --test-name-pattern 口径 tests/film/e2e.test.mjs
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
  assert.ok(r.json, 'stdout 只有一个 JSON 对象（附录 C2 信封）');
  assert.equal(r.json.schemaVersion, 1);
  assert.equal(r.json.data.status, 'passed');
  const runDir = path.join(ROOT, r.json.data.runDir);
  for (const f of ['master.mp4', 'web.mp4', 'player.html', 'contact.jpg', 'poster.jpg', 'run.json', 'qa/report.json', 'checks/output.json']) {
    assert.ok(fs.existsSync(path.join(runDir, f)), `缺 ${f}`);
  }
  // 信封的 outputs：仓库相对路径、带 sha256，含成片、run.json 与 QA 报告（远程出片据此取回并核对）
  const kinds = new Set(r.json.outputs.map(o => o.kind));
  for (const k of ['master', 'web', 'player', 'contact', 'qa-report', 'run-json']) assert.ok(kinds.has(k), `信封 outputs 缺 ${k}`);
  for (const o of r.json.outputs) {
    assert.ok(!path.isAbsolute(o.path) && !o.path.includes('\\'), `路径要仓库相对、正斜杠：${o.path}`);
    assert.match(o.sha256 || '', /^[0-9a-f]{64}$/, `${o.path} 缺 sha256`);
  }
  assert.equal(r.json.runJson, `${w.rel}/out/${r.json.data.runId}/run.json`);
  const run = readRun(r.json.runJson);
  assert.equal(run.kind, 'preview', '工作版出片记为 preview（作品描述包的运行类别）');
  assert.equal(run.job, 'build');
  assert.equal(run.technicalAcceptance.status, 'passed');
  assert.deepEqual(run.technicalAcceptance.evidence, ['qa/report.json'], '技术验收证据相对运行目录');
  assert.ok(run.preflight?.ok, '渲染前跑过环境预检');
  assert.equal(run.output.frames, run.expected.frames, '帧数等于 film.json');
  assert.equal(run.output.frames, 72, '模版是 3 秒 × 24 fps');
  assert.deepEqual([run.output.width, run.output.height, run.output.fps], [1920, 1080, 24]);
  assert.deepEqual(run.output.color, { range: 'tv', space: 'bt709', transfer: 'bt709', primaries: 'bt709' });
  assert.equal(run.frameHashes.length, 72);
  assert.equal(run.softwareFallback, false);
  assert.ok(run.rerun.startsWith('node tools/film/cli.mjs build '));
  const v = validateRenderResult(run, { strict: true, runDir, expectedFrameCount: run.expected.frames });
  assert.ok(v.ok, `run.json 过不了 validateRenderResult：${JSON.stringify(v.diagnostics)}`);
  assert.equal(fs.readFileSync(path.join(w.dir, 'out', 'latest'), 'utf8').trim(), r.json.data.runId);
  // film.json 声明含 AI 生成内容时，成片与网页版的 comment 写了隐式标识（D11），run.json 记下写入的字符串
  const raw = JSON.parse(fs.readFileSync(path.join(w.dir, 'film.json'), 'utf8'));
  if (raw.aigc?.contains) {
    assert.match(run.aigc?.comment || '', /^AIGC\{.*"ProduceID":"[^"]+@[^"]+".*\} 含 AI 生成画面/);
    for (const f of ['master.mp4', 'web.mp4']) {
      const c = spawnSync(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-show_entries', 'format_tags=comment', '-of', 'default=nw=1:nk=1', path.join(runDir, f)], { encoding: 'utf8' }).stdout.trim();
      assert.equal(c, run.aigc.comment, `${f} 的 comment`);
    }
  } else assert.ok(!run.aigc?.comment, '没有声明含 AI 生成内容时不写标识');
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
  const st = Object.fromEntries(again.json.data.steps.map(s => [s.id, s.status]));
  assert.equal(st.video, 'cached');
  assert.equal(st.mix, 'cached');
  assert.equal(st.mux, 'done');
  const one = runCli(['render', w.rel, '--profile', 'web-1080p24', '--frames', '0:4', '--json'], { env: env(tmp) });
  assert.equal(one.code, 0, one.stderr.slice(-1500));
  assert.equal(one.json.data.rendered, 4);
  const two = runCli(['render', w.rel, '--profile', 'web-1080p24', '--frames', '0:4', '--json'], { env: env(tmp) });
  assert.equal(two.code, 0);
  assert.equal(two.json.data.rendered, 0, '第二次应全部复用');
  assert.equal(two.json.data.reused, 4);
  const fr = readRun(two.json.runJson);
  assert.equal(fr.kind, 'still');
  assert.ok(['rendered', 'passed'].includes(fr.status), `帧段运行的状态 ${fr.status}`);
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test('C 路线：模版作品出片（含声画拍点核对），竖屏 30 fps 档位的工作版能出；用户豁免后终渲，用户认可后 accepted', { skip, timeout: 900000 }, () => {
  const { w, run } = buildAndCheck('c');
  assert.ok(run.steps.some(s => s.id === 'cuecheck' && s.status === 'done'), 'C 模版写了 cuecheck，应当跑');
  const tmp = sysTmp();
  const v = runCli(['build', w.rel, '--profile', 'vertical-1080x1920-30', '--waive', 'look,animatic', '--reason', 'G1 自检', '--json'], { env: env(tmp) });
  assert.equal(v.code, 0, v.stderr.slice(-1500));
  const vr = readRun(v.json.runJson);
  assert.deepEqual([vr.output.width, vr.output.height, vr.output.fps, vr.output.frames], [1080, 1920, 30, 90]);
  // 档位与 film.json 不同：QA 拿到的是运行目录里换算好的生效描述（帧数、帧率、画幅与档位一致），视口是竖屏；film.json 没改
  const vDir = path.join(ROOT, vr.runDir);
  assert.equal(vr.filmEffective?.path, `${vr.runDir}/film.effective.json`);
  assert.equal(v.json.data.filmEffective, vr.filmEffective.path);
  const eff = JSON.parse(fs.readFileSync(path.join(vDir, 'film.effective.json'), 'utf8'));
  assert.deepEqual(eff.output, { profile: 'vertical-1080x1920-30', width: 1080, height: 1920, fps: 30, frameCount: 90 });
  assert.equal(eff.id, w.name);
  assert.equal(eff.shots.at(-1).out, 90);
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.dir, 'film.json'), 'utf8')).output.width, 1920, 'film.json 不改');
  const vq = JSON.parse(fs.readFileSync(path.join(vDir, 'qa', 'report.json'), 'utf8'));
  if (vq.stubArgs) {
    assert.equal(vq.stubArgs.film, path.join(vDir, 'film.effective.json'));
    assert.equal(vq.stubArgs.size, '1080x1920');
    assert.equal(vq.stubArgs.profile, 'vertical-1080x1920-30');
    assert.equal(vq.stubArgs.events, path.join(vDir, 'events.json'), 'film.json 没写 events：页面导出的事件表交给声画同步');
  }
  assert.equal(vr.technicalAcceptance.film, `${vr.runDir}/film.effective.json`);
  // 内部豁免不放行终渲；带用户原话的豁免放行；终渲的 run.json 记 kind = final 与放行依据
  assert.equal(runCli(['build', w.rel, '--final', '--json'], { env: env(tmp) }).code, 4);
  const uw = runCli(['review', 'waive', 'look,animatic', w.rel, '--reason', '用户说直接出', '--quote', '不用给我看预演了，直接出成片', '--source', '端到端测试会话 第 1 条', '--json'], { env: env(tmp) });
  assert.equal(uw.code, 0, uw.stderr);
  const fin = runCli(['build', w.rel, '--final', '--json'], { env: env(tmp) });
  assert.equal(fin.code, 0, fin.stderr.slice(-1500));
  const fr = readRun(fin.json.runJson);
  assert.equal(fr.kind, 'final');
  assert.equal(fr.final, true);
  assert.deepEqual(fr.gates.basis.map(g => g.state), ['waived', 'waived']);
  const st = Object.fromEntries(fin.json.data.steps.map(s => [s.id, s.status]));
  assert.equal(st.video, 'cached', '画面输入没变：终渲复用工作版的逐帧视频');
  // 用户认可成片 → accepted（「已交付」的唯一来源）
  const styleRef = path.join(w.dir, 'film.json');
  const ok = runCli(['review', 'approve', 'final', w.rel, '--quote', '可以，就这版', '--source', '端到端测试会话 第 2 条', '--reviewer', '测试用户', '--events', '片名出现', '--style-ref', styleRef, '--json'], { env: env(tmp) });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.json.data.accepted, true, JSON.stringify(ok.json.warnings));
  const acc = readRun(fin.json.runJson);
  assert.equal(acc.status, 'accepted');
  assert.equal(acc.creativeAcceptance.reviews.at(-1).reviewerKind, 'human');
  const status = runCli(['status', w.rel, '--json'], { env: env(tmp) });
  assert.equal(status.json.data.lastFinal.delivered, true);
  // --size 改画幅：工作版、不是交付件——不跑交付 QA，规格核对通过即退出码 0。放在最后：步骤缓存每步只留 2 份，
  // 夹在工作版与终渲之间会把工作版的逐帧视频挤出缓存，终渲就复用不到了
  const sz = runCli(['build', w.rel, '--size', '960x540', '--json'], { env: env(tmp) });
  assert.equal(sz.code, 0, sz.stderr.slice(-1500));
  assert.equal(sz.json.data.deliverable, false);
  assert.ok(sz.json.warnings.some(x => x.code === 'size-not-deliverable'));
  const sr = readRun(sz.json.runJson);
  assert.ok(['rendered', 'blocked'].includes(sr.status), `--size 工作版的状态 ${sr.status}`);
  assert.equal(sr.technicalAcceptance.status, 'not-run');
  assert.equal(sr.specCheck?.status, 'passed');
  assert.deepEqual([sr.output.width, sr.output.height], [960, 540]);
  assert.equal(sr.steps.find(s => s.id === 'qa')?.status, 'skipped');
  assert.ok(!fs.existsSync(path.join(ROOT, sr.runDir, 'qa', 'report.json')));
  assert.equal(runCli(['qa', w.rel, '--run', sr.runId, '--json'], { env: env(tmp) }).code, 2, 'film qa 不审 --size 的工作版');
});

test('竖屏档位交给真 QA 的口径（FILM_E2E_REAL_QA=1）：C 模版按竖屏 30 fps 出片，交付规格四项与文字视口都按档位判', { skip: skip || (!process.env.FILM_E2E_REAL_QA && '设 FILM_E2E_REAL_QA=1 才跑（真 QA，约 1–2 分钟）'), timeout: 900000 }, () => {
  // 模版画面能不能过全部硬门是路线模版的事（P12 / P15）；这里只要求编排器交给 QA 的口径对：
  // 作品描述是换算好的生效描述 → delivery.frame-count / frame-rate / duration / size 通过，文字组的视口是 1080×1920
  const w = makeWork('c');
  works.push(w);
  const tmp = sysTmp();
  const r = runCli(['build', w.rel, '--profile', 'vertical-1080x1920-30', '--waive', 'look,animatic', '--reason', 'G1 自检', '--json'], { env: env(tmp) });
  assert.ok([0, 4].includes(r.code), `退出码 ${r.code}：${r.stderr.slice(-1500)}`);
  assert.ok(r.json?.runJson, '信封要给出 run.json');
  const run = readRun(r.json.runJson);
  const rep = JSON.parse(fs.readFileSync(path.join(ROOT, run.runDir, 'qa', 'report.json'), 'utf8'));
  assert.ok(!rep.stubArgs, '这条用例要用真 QA（tools/qa/cli.mjs）');
  const st = Object.fromEntries(rep.checks.map(c => [c.id, c]));
  const SPEC = ['delivery.frame-count', 'delivery.frame-rate', 'delivery.duration', 'delivery.size'];
  for (const id of SPEC) assert.equal(st[id]?.status, 'pass', `${id}：${JSON.stringify(st[id]?.findings || st[id])}`);
  if (st['texts.contract']) assert.deepEqual(st['texts.contract'].evidence?.viewport, [1080, 1920], '文字组要在竖屏视口上量');
  if (r.code === 4) assert.ok(!rep.summary.hardFailures.some(id => SPEC.includes(id)), `交付规格不该再失败：${rep.summary.hardFailures.join('、')}`);
  assert.deepEqual(fs.readdirSync(tmp), []);
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
  // 最多等 2 分钟渲染开始；race 之后清掉定时器（不清的话 node --test 跑完还要空等到它到点）
  let guard;
  await Promise.race([started, new Promise(r => { guard = setTimeout(r, 120000); })]);
  clearTimeout(guard);
  await new Promise(r => setTimeout(r, 1500));
  child.kill('SIGINT');
  const code = await new Promise(r => child.on('close', c => r(c)));
  assert.equal(code, 130, err.slice(-1500));
  const env1 = JSON.parse(out);
  assert.equal(env1.exitCode, 130);
  assert.equal(env1.error.code, 'signal.sigint');
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
