// node engine/production/film.js 的命令约定（计划附录 C1 退出码、C2 --json 信封）：
// --help 输出到 stdout、exit 0、不读写作品；未知参数 exit 2；--json 时 stdout 只有一个对象；写文件原子、不留临时文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { REPO, minimalFilm, runFilm, tempFilm } from './helpers.mjs';

const SUBCOMMANDS = ['check', 'validate-result', 'status', 'gate', 'review', 'retime', 'expect', 'export', 'upgrade', 'profiles'];
const ENVELOPE = ['ok', 'exitCode', 'command', 'error', 'outputs', 'runJson', 'warnings'];

/** 目录里每个文件的 sha256 与修改时间（含子目录），用来证明命令没动过它。 */
function snapshot(dir) {
  const out = {};
  const walk = d => {
    for (const name of readdirSync(d)) {
      const p = join(d, name), st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out[p] = `${createHash('sha256').update(readFileSync(p)).digest('hex')}@${st.mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

test('--help：每个子命令都输出到 stdout、exit 0、不碰作品文件', () => {
  const t = tempFilm();
  try {
    const before = snapshot(t.root);
    for (const args of [['--help'], ['help'], ...SUBCOMMANDS.map(c => [c, '--help']), ['retime', t.dir, '--shot', 'S1', '--out', '60', '--write', '--help'], ['review', t.dir, '-h']]) {
      const r = runFilm(args);
      assert.equal(r.status, 0, args.join(' '));
      assert.ok(r.stdout.length > 20, args.join(' '));
      assert.equal(r.stderr, '', args.join(' '));
    }
    assert.deepEqual(snapshot(t.root), before);
  } finally { t.cleanup(); }
});

test('用法错误一律 exit 2：未知子命令、未知参数、缺位置参数、参数缺值、bool 参数带值', () => {
  for (const args of [['nope'], ['check', '.', '--no-such-flag'], ['check'], ['retime', '.', '--shot'], ['check', '.', '--json=1'], ['gate', '.', 'deliverx'], ['retime', 'films/beiming-10s', '--shot', 'B', '--out', '12.5']]) {
    const r = runFilm(args);
    assert.equal(r.status, 2, args.join(' '));
  }
  const j = runFilm(['check', '.', '--no-such-flag', '--json']);
  assert.equal(j.status, 2);
  assert.deepEqual(Object.keys(j.json).slice(0, ENVELOPE.length), ENVELOPE);
  assert.equal(j.json.error.code, 'usage');
  assert.match(j.json.error.hint, /--template/);
  // 没有子命令：给帮助到 stderr，exit 2
  const none = runFilm([]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /用法/);
});

test('check：通过 exit 0、不合格 exit 4、找不到 exit 2、坏 JSON exit 4；--json 只有一个对象', () => {
  const ok = runFilm(['check', 'films/beiming-10s', '--json']);
  assert.equal(ok.status, 0);
  assert.deepEqual(Object.keys(ok.json).slice(0, ENVELOPE.length), ENVELOPE);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.result.summary.frameCount, 240);
  assert.equal(JSON.stringify(JSON.parse(ok.stdout)), JSON.stringify(ok.json));   // stdout 就是一个对象，没有别的
  const missing = runFilm(['check', 'films/no-such-film', '--json']);
  assert.equal(missing.status, 2);
  assert.equal(missing.json.error.code, 'not-found');
  const t = tempFilm(minimalFilm({ shots: [{ id: 'S1', in: 0, out: 50 }, { id: 'S2', in: 48, out: 96 }] }));
  try {
    const bad = runFilm(['check', t.dir, '--json']);
    assert.equal(bad.status, 4);
    assert.equal(bad.json.ok, false);
    assert.equal(bad.json.error.code, 'contract');
    assert.ok(bad.json.result.diagnostics.some(d => d.code === 'shots-not-contiguous'));
    writeFileSync(t.file, '{ "schemaVersion": 2, }');
    const broken = runFilm(['check', t.dir, '--json']);
    assert.equal(broken.status, 4);
    assert.equal(broken.json.error.code, 'json-invalid');
    const human = runFilm(['check', t.dir]);
    assert.equal(human.status, 4);
    assert.match(human.stderr, /不是合法 JSON/);
  } finally { t.cleanup(); }
  // --strict：提示也算失败
  assert.equal(runFilm(['check', 'films/beiming-10s', '--strict']).status, 4);
  for (const slug of ['a-webgl', 'b-native', 'c-style']) assert.equal(runFilm(['check', join('routes', slug, 'template'), '--template', '--json']).status, 0, slug);
});

test('retime：默认只预览；--write 原子写回、不留临时文件；冲突 exit 4 且不写', () => {
  const t = tempFilm();
  try {
    const before = readFileSync(t.file, 'utf8');
    const pre = runFilm(['retime', t.dir, '--shot', 'S1', '--out', '60', '--json']);
    assert.equal(pre.status, 0);
    assert.equal(pre.json.result.written, false);
    assert.deepEqual(pre.json.result.after.cuts, [60]);
    assert.equal(readFileSync(t.file, 'utf8'), before);
    const w = runFilm(['retime', t.dir, '--shot', 'S1', '--out', '60', '--write', '--json']);
    assert.equal(w.status, 0);
    assert.equal(w.json.outputs[0].kind, 'film.json');
    const after = JSON.parse(readFileSync(t.file, 'utf8'));
    assert.equal(after.output.frameCount, 108);
    assert.deepEqual(after.shots.map(s => [s.in, s.out]), [[0, 60], [60, 108]]);
    assert.equal(after.events[0].frame, 72);
    assert.deepEqual(readdirSync(t.dir).filter(n => n.startsWith('.')), []);   // 没有 .film.json.tmp-* 残留
    const conflict = runFilm(['retime', t.dir, '--shot', 'S2', '--out', '70', '--write', '--json']);
    assert.equal(conflict.status, 4);
    assert.equal(conflict.json.error.code, 'retime-conflict');
    assert.equal(JSON.parse(readFileSync(t.file, 'utf8')).output.frameCount, 108);
    assert.equal(runFilm(['retime', t.dir, '--shot', 'S9', '--out', '70']).status, 2);
  } finally { t.cleanup(); }
  // 冻结镜像不许写回
  assert.equal(runFilm(['retime', 'films/beiming-10s', '--shot', 'B', '--out', '132', '--write']).status, 4);
});

test('expect / export / upgrade / profiles / status / validate-result 的输出与退出码', () => {
  const e = runFilm(['expect', 'films/beiming-10s', '--json']);
  assert.equal(e.status, 0);
  assert.equal(e.json.result.video.frameCount, 240);
  assert.deepEqual(e.json.result.cuts.map(c => c.frame), [72, 120]);
  assert.equal(e.json.result.ffprobe.video.color_range, 'tv');
  const p = runFilm(['profiles', '--json']);
  assert.equal(p.status, 0);
  assert.equal(p.json.result.default, 'web-1080p24');
  const s = runFilm(['status', 'films/beiming-10s', '--json']);
  assert.equal(s.status, 0);
  assert.equal(s.json.result.state, 'draft');
  const t = tempFilm({ route: 'c', title: 'x', dur: 3, fps: 24, size: [1920, 1080] });
  try {
    const up = runFilm(['upgrade', t.dir, '--json']);
    assert.equal(up.status, 0);
    assert.equal(up.json.result.film.output.frameCount, 72);
    assert.equal(JSON.parse(readFileSync(t.file, 'utf8')).dur, 3);   // 预览不写
    const ex = runFilm(['export', t.dir, '--out', t.dir, '--json']);
    assert.equal(ex.status, 0);
    assert.deepEqual(ex.json.outputs.map(o => o.kind), ['timeline', 'events']);
    assert.equal(JSON.parse(readFileSync(join(t.dir, 'timeline.json'), 'utf8')).frameCount, 72);
    const vr = runFilm(['validate-result', join(t.dir, 'nope.json'), '--json']);
    assert.equal(vr.status, 2);
    writeFileSync(join(t.dir, 'run.json'), JSON.stringify({ schemaVersion: 1, kind: 'final', status: 'accepted', projectId: 'film', shotId: 'film', route: 'c', backend: 'canvas', creativeAcceptance: { status: 'accepted', events: ['x'], styleComparison: ['y'] } }));
    const v2 = runFilm(['validate-result', join(t.dir, 'run.json'), '--json']);
    assert.equal(v2.status, 4);
    assert.ok(v2.json.result.diagnostics.some(d => d.code === 'creative-accepted-without-human'));
  } finally { t.cleanup(); }
  assert.match(readFileSync(join(REPO, 'engine', 'production', 'film.js'), 'utf8'), /^#!\/usr\/bin\/env node/);
});
