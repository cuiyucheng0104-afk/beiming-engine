// qa report / validate 与命令约定：报告 schema（附录 C8）、写到运行目录、technicalAcceptance、--help 无副作用、退出码（附录 C1）、
// 豁免规则（D08）、档位兜底（D07 / 附录 C7）、字体 cmap 解析。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { haveFfmpeg, tmp, cleanup, clip, qa, check, writeJson, ROOT, CLI } from './helpers.mjs';
import { spawnSync } from 'node:child_process';
import { validateReport, buildReport, technicalAcceptanceFrom, REPORT_SCHEMA_VERSION } from '../../tools/qa/lib/report.mjs';
import { validateWaiver, applyWaivers, collectWaivers } from '../../tools/qa/lib/waivers.mjs';
import { makeCheck, finding, settle, CHECKS } from '../../tools/qa/lib/checks.mjs';
import { loadProfiles, resolveProfile } from '../../tools/qa/lib/profiles.mjs';
import { parseArgs } from '../../tools/qa/lib/cli-kit.mjs';
import { parseFont, parseUnicodeRange, inRanges } from '../../tools/qa/lib/font.mjs';
import { normalizeFilm, findFilm, runDirOf } from '../../tools/qa/lib/film.mjs';

const skip = haveFfmpeg ? false : '没有 FFmpeg ≥ 7（D09），跳过';
after(cleanup);
let dir;
before(() => { dir = tmp(); });

const SUBS = ['delivery', 'visual', 'texts', 'sync', 'report', 'profiles', 'validate'];

test('--help：每个子命令 exit 0、用法打到 stdout、不写任何文件', () => {
  const before0 = fs.readdirSync(dir);
  for (const sub of [null, ...SUBS]) {
    const args = sub ? [CLI, sub, '--help'] : [CLI, '--help'];
    const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `${sub}: ${r.stderr}`);
    assert.match(r.stdout, /用法/);
  }
  assert.deepEqual(fs.readdirSync(dir), before0);
});

test('用法错误 exit 2：未知参数、缺成片、成片不存在、未知子命令；--json 时 stdout 只有一个信封', () => {
  for (const args of [['delivery', 'x.mp4', '--no-such-flag'], ['delivery'], ['delivery', path.join(dir, 'nope.mp4')], ['nosuch'], ['visual', 'x.mp4', '--timeout', 'abc']]) {
    const r = qa(args, { cwd: dir });
    assert.equal(r.code, 2, `${args.join(' ')} → ${r.code} ${r.stderr}`);
    assert.equal(r.env.exitCode, 2);
    assert.equal(r.env.error.code, 'usage');
    assert.ok(r.env.error.hint, '要给出下一步提示');
    assert.equal(r.stdout.trim().split('\n').length, 1);
  }
});

test('report：写 report.json / report.md / contact.jpg，报告结构合格、technicalAcceptance 指向报告', { skip }, () => {
  const d = path.join(dir, 'rep');
  fs.mkdirSync(d);
  const f = clip(path.join(d, 'film.mp4'), { size: '1920x1080' });
  writeJson(path.join(d, 'film.json'), { schemaVersion: 2, id: 'qa-report', title: '报告夹具', route: 'a', output: { profile: 'web-1080p24', width: 1920, height: 1080, fps: 24, frameCount: 96 }, shots: [{ id: 'S1', in: 0, out: 96 }], aigc: { contains: false } });
  const out = path.join(d, 'qa');
  const r = qa(['report', f, '--out', out]);
  assert.equal(r.code, 0, JSON.stringify(r.env?.result?.summary));
  assert.deepEqual(r.env.outputs.map(o => o.kind), ['qa-report', 'qa-markdown', 'qa-contact-sheet']);
  for (const o of r.env.outputs) assert.match(o.sha256, /^[0-9a-f]{64}$/);
  const rep = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.equal(rep.schemaVersion, REPORT_SCHEMA_VERSION);
  assert.deepEqual(validateReport(rep), { ok: true, errors: [] });
  assert.equal(rep.technicalAcceptance.status, 'passed');
  assert.match(rep.technicalAcceptance.evidence[0], /report\.json$/);
  assert.ok(rep.skipped.some(s => s.group === 'texts'), '没有页面时 texts 记为未执行，不假装通过');
  assert.ok(fs.statSync(path.join(out, 'contact.jpg')).size > 10000);
  assert.match(fs.readFileSync(path.join(out, 'report.md'), 'utf8'), /不能写成「已交付」/);
  const v = qa(['validate', path.join(out, 'report.json')]);
  assert.equal(v.code, 0);
});

test('运行目录：films/<名>/out/<run-id>/master.mp4 的报告默认写进同目录 qa/，信封带上 run.json', { skip }, () => {
  const repo = path.join(dir, 'repo');
  const run = path.join(repo, 'films', 'demo', 'out', '20261110-120000-abc1234');
  fs.mkdirSync(path.join(repo, 'engine'), { recursive: true });
  fs.mkdirSync(run, { recursive: true });
  writeJson(path.join(repo, 'package.json'), { name: 'fake-repo', private: true });
  writeJson(path.join(repo, 'films', 'demo', 'film.json'), { schemaVersion: 2, id: 'demo', title: '运行目录夹具', route: 'c', output: { profile: 'web-1080p24', width: 1920, height: 1080, fps: 24, frameCount: 96 }, shots: [{ id: 'S1', in: 0, out: 96 }], aigc: { contains: false } });
  writeJson(path.join(run, 'run.json'), { schemaVersion: 1, status: 'rendered' });
  const f = clip(path.join(run, 'master.mp4'));
  assert.equal(runDirOf(f), run);
  assert.equal(findFilm({ input: f }), path.join(repo, 'films', 'demo', 'film.json'));
  const r = qa(['report', f, '--no-sheet'], { cwd: repo });
  assert.equal(r.code, 0, JSON.stringify(r.env?.result?.summary));
  assert.equal(r.env.runJson, 'films/demo/out/20261110-120000-abc1234/run.json');
  assert.ok(fs.existsSync(path.join(run, 'qa', 'report.json')));
  assert.equal(r.env.result.film.id, 'demo');
});

test('报告 schema：不合格的报告逐条指出问题', () => {
  const c = settle(makeCheck('delivery.size', { expected: '1920×1080' }));
  c.value = '1920×1080';
  const good = buildReport({ input: { path: 'a.mp4', sha256: 'a'.repeat(64) }, profile: { id: 'web-1080p24', source: 'x' }, checks: [c] });
  assert.equal(validateReport(good).ok, true);
  const bad = structuredClone(good);
  bad.ok = true; bad.checks[0].status = 'fail';
  bad.input.sha256 = 'xyz';
  bad.checks.push({ ...bad.checks[0] });
  const v = validateReport(bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => /sha256/.test(e)));
  assert.ok(v.errors.some(e => /重复/.test(e)));
  assert.ok(v.errors.some(e => /有 fail 时 ok 必须是 false/.test(e)));
  assert.deepEqual(technicalAcceptanceFrom({ ok: false }, 'qa/report.json'), { status: 'failed', evidence: ['qa/report.json'] });
});

test('豁免：必须有 check、reason、approvedBy、quote、source；agent 不能自己批准；只放行匹配的对象与帧段', () => {
  assert.deepEqual(validateWaiver({ check: 'texts.duration', reason: 'r', approvedBy: '用户', quote: 'q', source: 's' }), []);
  assert.ok(validateWaiver({ check: 'texts.duration', reason: 'r', approvedBy: 'Claude', quote: 'q', source: 's' }).some(p => /agent/.test(p)));
  assert.ok(validateWaiver({ check: 'x' }).length >= 4);
  const c = makeCheck('texts.duration');
  finding(c, { key: 'a', target: 'sub', frames: [228, 240], message: '短' });
  finding(c, { key: 'b', target: 'other', frames: [10, 20], message: '短' });
  settle(c);
  applyWaivers(c, [{ check: 'texts.duration', target: 'sub', frames: [230, 240], reason: 'r', approvedBy: '用户', quote: 'q', source: 's' }]);
  assert.deepEqual(c.findings.map(f => f.status), ['waived', 'fail']);
  assert.equal(c.status, 'fail', '还有一条没放行，整项仍不通过');
  const { waivers, warnings } = collectWaivers({ film: { id: 'none', qa: { waivers: [{ check: 'texts.duration', reason: 'r', approvedBy: 'agent', quote: 'q', source: 's' }] } }, files: [], root: ROOT });
  assert.equal(waivers.length, 0);
  assert.equal(warnings.length, 1);
});

test('每个检查项都写进了 docs/quality/QA-GATE.md', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/quality/QA-GATE.md'), 'utf8');
  const missing = Object.keys(CHECKS).filter(id => !doc.includes(`\`${id}\``));
  assert.deepEqual(missing, []);
});

test('档位：权威表缺失或缺字段时用内置值并报 warn；film.json 的 qa 覆盖项叠加上去', () => {
  const t = path.join(dir, 'profiles-p05.json');
  writeJson(t, { profiles: { 'web-1080p24': { size: [1920, 1080], fps: 24, video: { pixFmt: 'yuv420p', color: { range: 'tv', matrix: 'bt709', primaries: 'bt709', transfer: 'bt709' } }, audio: { sampleRate: 48000, channels: 2, loudness: { integrated: -14, tolerance: 1, truePeak: -1 } } } } });
  const store = loadProfiles({ file: t });
  const p = resolveProfile(store, 'web-1080p24', null);
  assert.equal(p.width, 1920);
  assert.equal(p.audio.integratedLufs, -14);
  assert.ok(p.warnings.some(w => /safeArea\.title/.test(w)), '缺安全区，用内置值并说明');
  const inner = resolveProfile(store, 'uhd-2160p24', null);
  assert.ok(inner.warnings.some(w => /不在/.test(w)), '外部表里没有的档位用内置值并说明');
  const film = normalizeFilm({ route: 'c', title: 't', dur: 2, fps: 24, size: [1080, 1920], qa: { safeArea: { title: { bottom: 0.25 } }, texts: { minHoldSec: 1.2 } } });
  assert.equal(film.frameCount, 48, 'v1 记录：frameCount = round(dur × fps)');
  const v = resolveProfile(store, 'vertical-1080x1920-30', film);
  assert.equal(v.safeArea.title.bottom, 0.25);
  assert.equal(v.texts.minHoldSec, 1.2);
  assert.throws(() => resolveProfile(store, 'no-such', null), /没有档位/);
});

test('参数解析：未知参数、缺值、数字、列表', () => {
  const spec = { options: { '--n': { type: 'number', min: 1 }, '--l': { type: 'list' }, '--b': { type: 'boolean' } }, positionals: { min: 0, max: 1 } };
  assert.deepEqual(parseArgs(['--n', '3', '--l', 'a,b', '--l=c', '--b', 'x'], spec), { opts: { n: 3, l: ['a', 'b', 'c'], b: true }, positionals: ['x'] });
  assert.throws(() => parseArgs(['--zz'], spec), /未知参数/);
  assert.throws(() => parseArgs(['--n'], spec), /要跟一个值/);
  assert.throws(() => parseArgs(['--n', '0'], spec), /不能小于/);
  assert.throws(() => parseArgs(['a', 'b'], spec), /多余/);
});

test('字体 cmap：仓库字体子集的字数与 fonts/LICENSE.md 的说明一致；unicode-range 解析', () => {
  const n = f => parseFont(fs.readFileSync(path.join(ROOT, 'fonts', f))).cps;
  assert.deepEqual([...n('MaShanZheng-400.woff2')].filter(c => c > 0x2e80).map(c => String.fromCodePoint(c)).sort(), ['冥', '北']);
  assert.ok(n('NotoSansSC-var.woff2').has('聘'.codePointAt(0)));
  assert.ok(!n('NotoSansSC-var.woff2').has('图'.codePointAt(0)));
  assert.ok(n('Barlow-500.woff2').has('5'.codePointAt(0)));
  assert.ok(!n('Barlow-500.woff2').has('B'.codePointAt(0)), 'Barlow 子集只有数字与少数字母，没有 B');
  const r = parseUnicodeRange('U+0000-00FF, U+4E??');
  assert.ok(inRanges(0x41, r) && inRanges(0x4e2d, r) && !inRanges(0x5000, r));
});
