// 《北冥》10 秒样片的镜像 films/beiming-10s/film.json 与冻结源码、声音表的一致性（计划 P05·M1「《北冥》镜像」）。
// 在临时副本里改样片的镜头起点、显示层时刻、声音表或写法，检查就失败；仓库里的源码一字不动。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertValidFilm, loadFilm } from '../../engine/production/film.js';
import { SOURCE_FILES, checkMirror, evalSeconds, parseSources, readSources } from '../../films/beiming-10s/mirror-check.mjs';
import { REPO } from './helpers.mjs';

const MIRROR = join(REPO, 'films', 'beiming-10s');
const CHECK = join(MIRROR, 'mirror-check.mjs');
const film = () => assertValidFilm(loadFilm(MIRROR));

/** 把样片源码复制到临时目录，按 edits 改字（{ 文件: [[旧, 新], …] }，旧文本必须存在），返回 { root, cleanup }。 */
function copySources(edits = {}) {
  const root = mkdtempSync(join(tmpdir(), 'beiming-mirror-'));
  for (const rel of SOURCE_FILES) {
    let text = readFileSync(join(REPO, ...rel.split('/')), 'utf8');
    for (const [from, to] of edits[rel] ?? []) {
      assert.ok(text.includes(from), `${rel} 里找不到要改的「${from}」：样片源码的写法变了，同步改这条测试`);
      text = text.replace(from, to);
    }
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const drift = (edits) => {
  const c = copySources(edits);
  try {
    const r = checkMirror(film(), readSources(c.root), { root: c.root, assetRoot: REPO });
    return { ok: r.ok, codes: [...new Set(r.diagnostics.map(d => d.code))], diagnostics: r.diagnostics };
  } finally { c.cleanup(); }
};

test('仓库里的镜像与样片一致：3 镜 A 0–72、B 72–120、C 120–240，34 个事件', () => {
  const r = checkMirror(film(), readSources(REPO), { root: REPO });
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(r.expected.shots, [{ id: 'A', in: 0, out: 72 }, { id: 'B', in: 72, out: 120 }, { id: 'C', in: 120, out: 240 }]);
  assert.equal(r.expected.events.size, 34);
  // 原样复制的副本也一致（证明副本法本身不引入差异）
  assert.deepEqual(drift({}).codes, []);
});

test('改 src/timeline.js 的镜头 B 起点（临时副本）：镜头表、GIRL_SHOT 与镜像对不上，检查失败', () => {
  const r = drift({ 'src/timeline.js': [['export const TIMELINE = Object.freeze({ A: 0, B: 3, C: 5, end: 10 });', 'export const TIMELINE = Object.freeze({ A: 0, B: 3.5, C: 5, end: 10 });']] });
  assert.equal(r.ok, false);
  assert.ok(r.codes.includes('mirror-shots'), r.codes.join());
  assert.ok(r.codes.includes('mirror-girl-shot'), r.codes.join());
  assert.ok(r.diagnostics.some(d => /\[84, 120\)/.test(d.message)));
});

test('改 src/main.js 的镜头起点写法（临时副本）：at 写死成别的秒数也会被发现', () => {
  const r = drift({ 'src/main.js': [['{ at: TIMELINE.B, shot: shotB }', '{ at: 3.25, shot: shotB }']] });
  assert.equal(r.ok, false);
  assert.ok(r.codes.includes('mirror-shots'), r.codes.join());
});

test('改镜头 C 的起点：镜头表、C_START、显示层与片名事件整体漂移', () => {
  const r = drift({ 'src/timeline.js': [['export const TIMELINE = Object.freeze({ A: 0, B: 3, C: 5, end: 10 });', 'export const TIMELINE = Object.freeze({ A: 0, B: 3, C: 5.5, end: 10 });']] });
  assert.equal(r.ok, false);
  for (const code of ['mirror-shots', 'mirror-event-frame']) assert.ok(r.codes.includes(code), `${code} ∉ ${r.codes.join()}`);
  assert.ok(r.diagnostics.some(d => d.path === 'events.hud.scan'));
});

test('只改声音表或只改画面阈值：同一时刻两处写成不同的数会被指出', () => {
  const horn = drift({ 'audio/cues.json': [['"t": 0.4,', '"t": 0.5,']] });
  assert.equal(horn.ok, false);
  assert.ok(horn.codes.includes('mirror-event-frame'), horn.codes.join());
  const scan = drift({ 'src/hud.js': [['scan: 5.45', 'scan: 5.5']] });
  assert.equal(scan.ok, false);
  assert.ok(scan.codes.includes('mirror-av-split'), scan.codes.join());
});

test('源码写法超出检查认得的范围：报 mirror-parse，不去猜', () => {
  const r = drift({ 'src/main.js': [['{ at: TIMELINE.B, shot: shotB }', '{ at: startOf(\'B\'), shot: shotB }']] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.codes, ['mirror-parse']);
  assert.equal(evalSeconds('TIMELINE.C - DESIGN.C + 0.5', { TIMELINE: { C: 5 }, DESIGN: { C: 5 } }), 0.5);
  assert.throws(() => evalSeconds('Math.max(1, 2)'), /不认识/);
  assert.equal(parseSources(readSources(REPO)).values.shiftC, 0);
});

test('命令行：一致 exit 0；临时副本漂移 exit 4（--json 信封）；参数错 exit 2；镜像文件被改也失败', () => {
  const run = args => spawnSync(process.execPath, [CHECK, ...args], { encoding: 'utf8', timeout: 60_000 });
  const ok = run(['--json']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).ok, true);
  const c = copySources({ 'src/timeline.js': [['B: 3, C: 5, end: 10 });\nexport const DESIGN', 'B: 3.25, C: 5, end: 10 });\nexport const DESIGN']] });
  try {
    const bad = run(['--root', c.root, '--asset-root', REPO, '--json']);
    assert.equal(bad.status, 4, bad.stderr);
    const env = JSON.parse(bad.stdout);
    assert.equal(env.ok, false);
    assert.equal(env.error.code, 'contract.mirror-drift');
    assert.equal(env.schemaVersion, 1);
    // 镜像自己被改：事件帧号不对
    const f = JSON.parse(readFileSync(join(MIRROR, 'film.json'), 'utf8'));
    f.events.find(e => e.id === 'hud.scan').frame = 132;
    const filmCopy = join(c.root, 'film.json');
    writeFileSync(filmCopy, JSON.stringify(f));
    const self = run(['--film', filmCopy, '--json']);
    assert.equal(self.status, 4);
    assert.ok(JSON.parse(self.stdout).data.diagnostics.some(d => d.code === 'mirror-event-frame' || d.code === 'mirror-av-sync'));
  } finally { c.cleanup(); }
  assert.equal(run(['--nope']).status, 2);
  assert.equal(JSON.parse(run(['--nope', '--json']).stdout).error.code, 'usage.unknown-option');
  assert.equal(run(['--film', join(MIRROR, 'nope.json')]).status, 2);
  assert.equal(run(['--help']).status, 0);
});
