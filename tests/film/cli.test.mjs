// 出片命令的契约测试（不渲染、不启动浏览器，几秒）：node --test tests/film/cli.test.mjs
//   附录 C1 退出码、C2 --json 信封（命令约定库 tools/lib/cli.mjs：stdout 只有一个对象，带 schemaVersion）、--help 无副作用；
//   闸门（D08）在不渲染的前提下就拒绝终渲；审片记录的格式与作品描述包 engine/production/review.js 一致。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, runCli, makeWork, snapshotDir, newEntries, gitStatus, cleanupTestRoot } from './helpers.mjs';

const works = [];
const statusBefore = new Set(gitStatus() || []);
after(() => { for (const w of works) w.cleanup(); cleanupTestRoot(); });

const SUBS = ['new', 'check', 'stills', 'animatic', 'build', 'mix', 'assemble', 'render', 'qa', 'review', 'approve', 'status'];
const ENVELOPE_KEYS = ['schemaVersion', 'ok', 'exitCode', 'command', 'error', 'outputs', 'runJson', 'warnings', 'data'];

test('--help：总帮助与每个子命令都打印用法与退出码到 stdout、退出码 0、不建任何目录', () => {
  const films = snapshotDir(path.join(ROOT, 'films')), out = snapshotDir(path.join(ROOT, 'out'));
  const top = runCli(['--help']);
  assert.equal(top.code, 0);
  assert.match(top.stdout, /北冥出片编排/);
  assert.match(top.stdout, /退出码/);
  for (const s of SUBS) {
    for (const h of ['--help', '-h']) {
      const r = runCli([s, h]);
      assert.equal(r.code, 0, `${s} ${h} 退出码 ${r.code}：${r.stderr}`);
      assert.match(r.stdout, /用法/, `${s} ${h} 没有用法文字`);
      assert.match(r.stdout, /退出码/, `${s} ${h} 没有退出码说明`);
    }
  }
  // --help 优先于一切：带着错参数、不存在的作品也只打印帮助
  const odd = runCli(['build', 'films/does-not-exist', '--final', '--bogus', '--help']);
  assert.equal(odd.code, 0);
  assert.deepEqual(newEntries(films, path.join(ROOT, 'films')), []);
  assert.deepEqual(newEntries(out, path.join(ROOT, 'out')), []);
});

test('用法错误：没有子命令、不认识的子命令、未知选项、缺作品目录、互斥选项都是退出码 2；--json 时 stdout 只有一个信封对象', () => {
  assert.equal(runCli([]).code, 2);
  const cases = [
    [['bogus', '--json'], 'usage.unknown-subcommand'],
    [['--no-such-flag', '--json'], 'usage.unknown-option'],
    [['build', 'films/x', '--no-such-flag', '--json'], 'usage.unknown-option'],
    [['build', '--json'], 'usage.missing-argument'],
    [['build', 'films/x', '--workers', 'abc', '--json'], 'usage.bad-value'],
    [['build', 'films/x', '--gpu', 'maybe', '--json'], 'usage.bad-value'],
    [['render', 'films/x', '--frames', '1:0', '--shot', 'S1', '--json'], null],
  ];
  for (const [args, code] of cases) {
    const r = runCli(args);
    assert.equal(r.code, 2, `${args.join(' ')} → ${r.code}：${r.stderr}`);
    assert.ok(r.json, `${args.join(' ')} 的 stdout 应是单个 JSON 对象：${r.stdout.slice(0, 200)}`);
    for (const k of ENVELOPE_KEYS) assert.ok(k in r.json, `信封缺 ${k}`);
    assert.equal(r.json.schemaVersion, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.exitCode, 2);
    assert.match(r.json.error.code, /^usage\./);
    if (code) assert.equal(r.json.error.code, code, args.join(' '));
    assert.ok(r.json.error.message);
  }
  const unknown = runCli(['--no-such-flag']);
  assert.match(unknown.stderr, /不认识的选项 --no-such-flag/);
  const missing = runCli(['build', 'films/does-not-exist', '--json']);
  assert.equal(missing.code, 2);
  assert.equal(missing.json.error.code, 'usage.film-dir-missing');
  assert.equal(missing.json.command, 'film build');
});

test('闸门：没有 look / animatic 认可时 build --final 与 render --final 退出码 4，不建运行目录', () => {
  const w = makeWork('c');
  works.push(w);
  for (const args of [['build', w.rel, '--final', '--profile', 'web-1080p24'], ['render', w.rel, '--final', '--frames', '0:2'], ['render', w.rel, '--final']]) {
    const r = runCli([...args, '--json']);
    assert.equal(r.code, 4, `${args.join(' ')} → ${r.code}：${r.stderr}`);
    assert.equal(r.json.error.code, 'contract.gate-blocked');
    assert.match(r.json.error.hint, /review approve look/);
  }
  assert.ok(!fs.existsSync(path.join(w.dir, 'out')), '拒绝终渲时不该建运行目录');
});

test('审阅记录：approve 要原话、出处与审阅人；agent 的 note 与没有原话的豁免只记 comment、不放行终渲；final 不能豁免', () => {
  // 这条只测审阅记录与闸门，用 C 模版：A 模版要先生成字体子集（要 Python fontTools 与字体缓存），秒级单元测试不该依赖它
  const w = makeWork('c');
  works.push(w);
  assert.equal(runCli(['review', 'approve', 'look', w.rel]).code, 2, '没有原话');
  assert.equal(runCli(['review', 'approve', 'look', w.rel, '--quote', '可以', '--source', '会话']).code, 2, '没有审阅人');
  assert.equal(runCli(['review', 'waive', 'final', w.rel, '--reason', 'x']).code, 2, 'final 不能豁免');
  assert.equal(runCli(['review', 'approve', 'look', w.rel, '--quote', '这版可以', '--source', '会话第 3 条', '--reviewer', '用户', '--said-at', '昨天']).code, 2, '--said-at 不是 ISO 时间');
  assert.equal(runCli(['review', 'approve', 'look', w.rel, '--quote', '这版可以', '--source', '会话第 3 条', '--reviewer', '用户']).code, 4, '还没有关键帧运行可审');
  const note = runCli(['review', 'note', 'look', w.rel, '--note', '代理检查：构图偏左，片名离主体太近', '--issues', '36: 片名压到鲲背', '--json']);
  assert.equal(note.code, 0, note.stderr);
  const waive = runCli(['review', 'waive', 'look,animatic', w.rel, '--reason', '自检', '--json']);
  assert.equal(waive.code, 0, waive.stderr);
  assert.equal(waive.json.data.kind, 'internal');
  assert.ok(waive.json.warnings.some(x => x.code === 'waiver-internal'));
  const st = runCli(['status', w.rel, '--json']);
  assert.equal(st.code, 0, st.stderr);
  assert.equal(st.json.data.gates.look.state, 'missing', '代理审片与内部豁免说明都不算数');
  assert.equal(st.json.data.gates.look.comments, 2);
  assert.deepEqual(st.json.data.invalidRecords, []);
  const fin = runCli(['build', w.rel, '--final', '--profile', 'web-1080p24', '--json']);
  assert.equal(fin.code, 4, '内部豁免不放行终渲');
  assert.match(fin.json.error.message, /只有代理审片或内部豁免说明/);
  const names = fs.readdirSync(path.join(w.dir, 'review')).sort();
  assert.ok(names.every(n => /^(look|animatic)-\d{4}-\d{2}-\d{2}(-\d+)?\.json$/.test(n)), names.join(' '));
  const recs = names.map(n => JSON.parse(fs.readFileSync(path.join(w.dir, 'review', n), 'utf8')));
  assert.ok(recs.every(r => r.schemaVersion === 1 && r.film === w.name && r.decision === 'comment' && r.reviewer.kind === 'ai'));
  assert.deepEqual(recs.find(r => r.summary.startsWith('代理检查')).evidenceFrames, [36]);
  // 用户豁免（带原话与出处）才放行：记成 waive、reviewer = human、source = { kind, ref, at }
  const uw = runCli(['review', 'waive', 'look,animatic', w.rel, '--reason', '用户说不用看', '--quote', '不用给我看预演了，直接出', '--source', '会话 2026-11-10 第 9 条', '--json']);
  assert.equal(uw.code, 0, uw.stderr);
  const st2 = runCli(['status', w.rel, '--json']);
  assert.equal(st2.json.data.gates.look.state, 'waived');
  assert.equal(st2.json.data.gates.animatic.state, 'waived');
  const rec = JSON.parse(fs.readFileSync(path.join(ROOT, uw.json.data.records[0]), 'utf8'));
  assert.equal(rec.decision, 'waive');
  assert.equal(rec.reviewer.kind, 'human');
  assert.equal(rec.source.kind, 'session');
  assert.match(rec.source.at, /^\d{4}-\d{2}-\d{2}T/);
  const qa = runCli(['qa', w.rel, '--json']);
  assert.equal(qa.code, 4);
  assert.equal(qa.json.error.code, 'contract.nothing-to-qa');
});

test('film new：参数先按同一套规则检查，再交给 new-film；--dry-run 不写文件', () => {
  const films = snapshotDir(path.join(ROOT, 'films'));
  assert.equal(runCli(['new', 'c', 'p06-dry', '--bogus']).code, 2);
  const dry = runCli(['new', 'c', 'p06-dry', '--title', '试映', '--dry-run', '--json']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(dry.json.command, 'film new');
  assert.equal(dry.json.data.film.dir, 'films/p06-dry');
  assert.deepEqual(newEntries(films, path.join(ROOT, 'films')), []);
  const bad = runCli(['new', 'z', 'p06-dry', '--json']);
  assert.equal(bad.code, 2);
});

test('build --waive：用法或契约有错时（档位拼错、坏画幅、--size 配 --final、步骤名不对、终渲档位不在 deliveries、终渲豁免没有原话）先退出，不写审片记录、不建运行目录', () => {
  const w = makeWork('c');
  works.push(w);
  const waive = ['--waive', 'look,animatic', '--reason', '复核用例'];
  const cases = [
    [['--profile', 'no-such-profile'], 2, 'usage.profile-unknown'],
    [['--size', '1921x1080'], 2, null],
    [['--size', '960x540', '--final', '--quote', '直接出', '--source', '测试'], 2, 'usage.size-final'],
    [['--from', 'no-such-step'], 2, 'usage.step-unknown'],
    [['--from', 'qa', '--to', 'mix'], 2, 'usage.step-order'],
    [['--final'], 2, 'usage.bad-usage'],
    [['--final', '--profile', 'vertical-1080x1920-30', '--quote', '直接出', '--source', '测试'], 4, 'contract.profile-not-delivery'],
  ];
  for (const [extra, code, err] of cases) {
    const r = runCli(['build', w.rel, ...waive, ...extra, '--json']);
    assert.equal(r.code, code, `${extra.join(' ')} → ${r.code}：${r.stderr.slice(-400)}`);
    if (err) assert.equal(r.json?.error?.code, err, extra.join(' '));
    assert.ok(!fs.existsSync(path.join(w.dir, 'review')), `${extra.join(' ')}：不该写审片记录`);
    assert.ok(!fs.existsSync(path.join(w.dir, 'out')), `${extra.join(' ')}：不该建运行目录`);
  }
});

test('仓库卫生：上面这些命令跑完，除了测试作品自己，工作区没有多出任何改动', () => {
  const st = gitStatus(works.map(w => w.rel));
  if (st === null) return;   // 不是 git 检出
  assert.deepEqual(st.filter(l => !statusBefore.has(l)), []);
});
