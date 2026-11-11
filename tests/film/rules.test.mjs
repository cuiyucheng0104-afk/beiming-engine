// 出片规范检查（tools/repo-check/rules/film/）的测试：在临时目录搭小仓库，用 tools/repo-check.mjs --root 跑 film 域，
// 每条规则先过合格样本（exit 0），再各造一种违规（exit 4、报出该规则 id）。不渲染、不启动浏览器。
//   node --test tests/film/rules.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { ROOT } from './helpers.mjs';

const CHECK = path.join(ROOT, 'tools/repo-check.mjs');
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const FILM = { schemaVersion: 2, id: 'ok-film', title: '试映', route: 'c', backend: 'canvas',
  output: { profile: 'web-1080p24', width: 1920, height: 1080, fps: 24, frameCount: 72 }, shots: [{ id: 'S1', in: 0, out: 72 }], events: [],
  audio: { mode: 'none' }, deliveries: ['web-1080p24'], credits: [], aigc: { contains: false }, gates: { look: 'required', animatic: 'required', final: 'required' } };
const REVIEW = { schemaVersion: 1, film: 'ok-film', gate: 'look', decision: 'approve', reviewer: { kind: 'human', name: '用户' }, quote: '这版颜色可以',
  source: { kind: 'session', ref: '会话 2026-11-10 第 3 条', at: '2026-11-10T15:32:00+08:00' }, recordedBy: { kind: 'ai', name: 'agent' },
  recordedAt: '2026-11-10T15:33:00+08:00', reviewed: [{ path: 'out/20261110-073300-abcdef12/contact.jpg', sha256: 'a'.repeat(64), kind: 'image' }] };

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-film-rules-'));
  made.push(dir);
  const w = (rel, text) => { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof text === 'string' ? text : `${JSON.stringify(text, null, 2)}\n`); };
  w('package.json', { name: 'fixture', private: true, type: 'module' });
  w('routes/routes.json', fs.readFileSync(path.join(ROOT, 'routes/routes.json'), 'utf8'));
  for (const [r, rel] of [['a', 'routes/a-webgl/template'], ['b', 'routes/b-native/template'], ['c', 'routes/c-style/template']]) {
    w(`${rel}/film.json`, { route: r, title: '{{TITLE}}', dur: 3, fps: 24, size: [1920, 1080], ...(r === 'b' ? { native: { entry: 'film.tsx' } } : { audio: { mode: 'none' } }) });
    if (r !== 'b') w(`${rel}/index.html`, '<!doctype html>\n');
  }
  w('build.sh', '#!/bin/sh\nexec node "$(dirname "$0")/tools/film/beiming.mjs" "$@"\n');
  w('films/ok-film/film.json', FILM);
  w('films/ok-film/index.html', '<!doctype html>\n');
  w('films/ok-film/review/look-2026-11-10.json', REVIEW);
  return { dir, w };
}

function check(dir, only) {
  const r = spawnSync(process.execPath, [CHECK, '--root', dir, '--only', only, '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 下面断言会报 */ }
  assert.ok(json, `repo-check 的 stdout 要是 JSON：${r.stdout.slice(0, 300)}${r.stderr.slice(0, 300)}`);
  // 别的域的规则文件加载问题（core.loader）不归这里管：只看 film 域的结论
  const all = json.data?.findings || [];
  const mine = all.filter(f => f.rule.startsWith('film.'));
  // 别的域的规则文件加载不了时（core.loader，规则自身出错）整次检查退出 1；那不是 film 域的结论
  const othersBroken = all.some(f => f.rule === 'core.loader' && f.level === 'error');
  return { code: r.status, json, othersBroken, errors: mine.filter(f => f.level === 'error'), warns: mine.filter(f => f.level === 'warn') };
}

/** 有 film 域的错误时，退出码是 4（别的域的规则文件坏了时是 1：规则自身出错优先）。 */
function assertContractFail(r) {
  assert.ok(r.errors.length, 'film 域应报出错误');
  assert.ok(r.code === 4 || (r.othersBroken && r.code === 1), `退出码 ${r.code}`);
}

test('合格的小仓库：film 域全部规则没有错误', () => {
  const { dir } = repo();
  const r = check(dir, 'film');
  assert.deepEqual(r.errors, [], JSON.stringify(r.errors, null, 1));
  const ids = (r.json.data.rules || []).map(x => x.id).filter(id => id.startsWith('film.'));
  assert.deepEqual(ids.sort(), ['film.entrypoints', 'film.loadable', 'film.out-untracked', 'film.review-records', 'film.templates']);
});

test('film.review-records：agent 自己批准、缺原话、final 豁免、旧台账、文件名不对都报错', () => {
  const { dir, w } = repo();
  w('films/ok-film/review/look-2026-11-11.json', { ...REVIEW, reviewer: { kind: 'ai', name: 'agent' } });
  w('films/ok-film/review/animatic-2026-11-11.json', { ...REVIEW, gate: 'animatic', quote: '<用户原话>' });
  w('films/ok-film/review/final-2026-11-11.json', { ...REVIEW, gate: 'final', decision: 'waive' });
  w('films/ok-film/review/waivers.json', { waivers: [] });
  w('films/ok-film/review/approve.json', REVIEW);
  const r = check(dir, 'film.review-records');
  assertContractFail(r);
  const files = r.errors.map(e => e.file);
  for (const f of ['look-2026-11-11.json', 'animatic-2026-11-11.json', 'final-2026-11-11.json', 'waivers.json', 'approve.json']) assert.ok(files.some(x => x.endsWith(f)), `应报出 ${f}：${files.join(' ')}`);
  assert.ok(!files.some(x => x.endsWith('look-2026-11-10.json')), '合格的记录不该报');
});

test('film.loadable：作品读不懂（缺帧数、页面缺 index.html、声音脚本不存在）报错', () => {
  const { dir, w } = repo();
  w('films/bad-a/film.json', { ...FILM, id: 'bad-a', output: { profile: 'web-1080p24', width: 1920, height: 1080, fps: 24 } });
  w('films/bad-b/film.json', { ...FILM, id: 'bad-b' });
  w('films/bad-c/film.json', { ...FILM, id: 'bad-c', audio: { mode: 'script', script: 'sound.py' } });
  w('films/bad-c/index.html', '<!doctype html>\n');
  const r = check(dir, 'film.loadable');
  assertContractFail(r);
  for (const n of ['bad-a', 'bad-b', 'bad-c']) assert.ok(r.errors.some(e => e.file.startsWith(`films/${n}/`)), `应报出 ${n}`);
  assert.ok(!r.errors.some(e => e.file.startsWith('films/ok-film/')));
});

test('film.templates：模版的 route 与目录不符、页面型模版缺 index.html 报错', () => {
  const { dir, w } = repo();
  w('routes/a-webgl/template/film.json', { route: 'c', title: '{{TITLE}}', dur: 3, fps: 24, size: [1920, 1080] });
  fs.rmSync(path.join(dir, 'routes/c-style/template/index.html'));
  const r = check(dir, 'film.templates');
  assertContractFail(r);
  assert.ok(r.errors.some(e => e.file.startsWith('routes/a-webgl/')));
  assert.ok(r.errors.some(e => e.file.startsWith('routes/c-style/')));
});

test('film.entrypoints：根 build.sh 自己拼管线报错；作品自带 build.sh 只提示', () => {
  const { dir, w } = repo();
  w('build.sh', '#!/bin/sh\nnode engine/render/video.mjs . --out out/video.mp4\nsh engine/render/mux.sh out/video.mp4 out/mix.wav out/beiming.mp4\n');
  w('films/ok-film/build.sh', '#!/bin/sh\n');
  const r = check(dir, 'film.entrypoints');
  assertContractFail(r);
  assert.ok(r.errors.some(e => e.file === 'build.sh'));
  assert.ok(r.warns.some(e => e.file === 'films/ok-film/build.sh'));
});

test('film.out-untracked：运行产物进了 git 报错', { skip: spawnSync('git', ['--version']).status === 0 ? false : '没有 git' }, () => {
  const { dir, w } = repo();
  w('films/ok-film/out/20261110-073300-abcdef12/master.mp4', 'x');
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'fixture'); git('config', 'commit.gpgsign', 'false');
  git('add', '-A'); git('commit', '-qm', 'fixture');
  const r = check(dir, 'film.out-untracked');
  assertContractFail(r);
  assert.ok(r.errors.some(e => e.file === 'films/ok-film/out/20261110-073300-abcdef12/master.mp4'));
});
