// 出片命令的契约测试（不渲染、不启动浏览器，几秒）：node --test tests/film/cli.test.mjs
//   附录 C1 退出码、C2 --json 信封（stdout 只有一个对象）、--help 无副作用；闸门（D08）在不渲染的前提下就拒绝终渲。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, runCli, makeWork, snapshotDir, newEntries, gitStatus, cleanupTestRoot } from './helpers.mjs';

const works = [];
const statusBefore = new Set(gitStatus() || []);
after(() => { for (const w of works) w.cleanup(); cleanupTestRoot(); });

const SUBS = ['new', 'check', 'stills', 'animatic', 'build', 'mix', 'assemble', 'render', 'qa', 'review', 'approve', 'status'];

test('--help：每个子命令都打印用法到 stdout、退出码 0、不建任何目录', () => {
  const films = snapshotDir(path.join(ROOT, 'films')), out = snapshotDir(path.join(ROOT, 'out'));
  const top = runCli(['--help']);
  assert.equal(top.code, 0);
  assert.match(top.stdout, /北冥出片编排/);
  for (const s of SUBS) {
    const r = runCli([s, '--help']);
    assert.equal(r.code, 0, `${s} --help 退出码 ${r.code}：${r.stderr}`);
    assert.match(r.stdout, /用法/, `${s} --help 没有用法文字`);
  }
  assert.deepEqual(newEntries(films, path.join(ROOT, 'films')), []);
  assert.deepEqual(newEntries(out, path.join(ROOT, 'out')), []);
});

test('用法错误：没有子命令、不认识的子命令、未知选项、缺作品目录都是退出码 2；--json 时 stdout 只有一个对象', () => {
  assert.equal(runCli([]).code, 2);
  for (const args of [['bogus', '--json'], ['build', 'films/x', '--bogus', '--json'], ['build', '--json'], ['render', 'films/x', '--frames', '1:0', '--shot', 'S1', '--json']]) {
    const r = runCli(args);
    assert.equal(r.code, 2, `${args.join(' ')} → ${r.code}`);
    assert.equal(r.lines.length, 1, `${args.join(' ')} 的 stdout 应只有一行 JSON：${r.stdout}`);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.exitCode, 2);
    for (const k of ['command', 'error', 'outputs', 'runJson', 'warnings']) assert.ok(k in r.json, `信封缺 ${k}`);
    assert.ok(r.json.error.message && r.json.error.hint !== undefined);
  }
  const missing = runCli(['build', 'films/does-not-exist', '--json']);
  assert.equal(missing.code, 2);
  assert.equal(missing.json.error.code, 'film-dir-missing');
});

test('闸门：没有 look / animatic 记录时 build --final 与 render --final 退出码 4，不建运行目录', () => {
  const w = makeWork('c');
  works.push(w);
  for (const args of [['build', w.rel, '--final', '--profile', 'web-1080p24'], ['render', w.rel, '--final', '--frames', '0:2'], ['render', w.rel, '--final']]) {
    const r = runCli([...args, '--json']);
    assert.equal(r.code, 4, `${args.join(' ')} → ${r.code}：${r.stderr}`);
    assert.equal(r.json.error.code, 'gate-blocked');
    assert.match(r.json.error.hint, /review approve look/);
  }
  assert.ok(!fs.existsSync(path.join(w.dir, 'out')), '拒绝终渲时不该建运行目录');
});

test('审阅记录：approve 要原话、出处与审阅人；agent 的 note 与内部豁免都不放行终渲；final 不能豁免', () => {
  const w = makeWork('a');
  works.push(w);
  assert.equal(runCli(['review', 'approve', 'look', w.rel]).code, 2, '没有原话');
  assert.equal(runCli(['review', 'approve', 'look', w.rel, '--quote', '可以', '--source', '会话']).code, 2, '没有审阅人');
  assert.equal(runCli(['review', 'waive', 'final', w.rel, '--reason', 'x']).code, 2, 'final 不能豁免');
  assert.equal(runCli(['review', 'approve', 'look', w.rel, '--quote', '这版可以', '--source', '会话第 3 条', '--reviewer', '用户']).code, 4, '还没有关键帧运行可审');
  const note = runCli(['review', 'note', 'look', w.rel, '--note', '构图偏左，片名离主体太近', '--json']);
  assert.equal(note.code, 0, note.stderr);
  const waive = runCli(['review', 'waive', 'look,animatic', w.rel, '--reason', '自检', '--json']);
  assert.equal(waive.code, 0, waive.stderr);
  assert.ok(waive.json.warnings.some(x => x.code === 'waiver-internal'));
  const st = runCli(['status', w.rel, '--json']);
  assert.equal(st.code, 0, st.stderr);
  assert.equal(st.json.gates.look.state, 'waived');
  assert.equal(st.json.gates.look.waiverKind, 'internal');
  assert.equal(st.json.gates.look.aiReviews, 1);
  assert.equal(runCli(['build', w.rel, '--final', '--profile', 'web-1080p24', '--json']).code, 4, '内部豁免不放行终渲');
  const rec = JSON.parse(fs.readFileSync(path.join(w.dir, 'review', 'waivers.json'), 'utf8'));
  assert.equal(rec.waivers.length, 2);
  const notes = fs.readdirSync(path.join(w.dir, 'review')).filter(n => n.startsWith('look-'));
  assert.equal(notes.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.dir, 'review', notes[0]), 'utf8')).reviewerKind, 'ai');
  const qa = runCli(['qa', w.rel, '--json']);
  assert.equal(qa.code, 4);
  assert.equal(qa.json.error.code, 'nothing-to-qa');
});

test('仓库卫生：上面这些命令跑完，除了测试作品自己，工作区没有多出任何改动', () => {
  const st = gitStatus(works.map(w => w.rel));
  if (st === null) return;   // 不是 git 检出
  assert.deepEqual(st.filter(l => !statusBefore.has(l)), []);
});
