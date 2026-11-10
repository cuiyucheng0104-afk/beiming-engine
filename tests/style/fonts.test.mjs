// 字体链路：node --test tests/style/fonts.test.mjs
// 不联网。码位与 unicode-range、清单解析与缺字、锁定清单校验、缓存核对、解释器缺 fontTools 时的退出码、subset.mjs 的用法错误与 --check 过期判定；
// 真正的子集化要装了 fontTools、brotli 的 Python（npm run setup，或设 BEIMING_PYTHON）和字体缓存（node tools/fonts/fetch.mjs，
// 或设 BEIMING_FONT_CACHE），没有就跳过并写明原因。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codepointsOf, missingChars, unicodeRange, parseFontsManifest, GlyphError } from '../../engine/style/fonts.js';
import { validateLock, loadLock, cacheStatus, cacheDir, findFontPython } from '../../tools/fonts/lock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SUBSET = path.join(ROOT, 'tools/fonts/subset.mjs');
const run = (args, env = {}) => spawnSync(process.execPath, [SUBSET, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
const tmpFilm = (film) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-fonts-'));
  fs.writeFileSync(path.join(d, 'film.json'), JSON.stringify(film));
  return d;
};
const FILM = {
  schemaVersion: 2, id: 'tst', title: '晨渡', route: 'a',
  fonts: [{ family: 'BM Title', source: 'ma-shan-zheng' }, { family: 'BM Text', source: 'noto-sans-sc', weight: 400 }],
  texts: [{ id: 'title', text: '晨渡', font: 'BM Title' }, { id: 'sub', text: '北冥风格 · 概念短片', font: 'BM Text' }],
};

test('码位：去重、NFC、去掉控制字符；unicode-range 合并相邻码位', () => {
  assert.deepEqual(codepointsOf('晨晨渡\n'), [0x6668, 0x6e21]);
  assert.deepEqual(codepointsOf('é'), [0xe9], 'NFC：e + 组合重音 = é');
  assert.equal(unicodeRange(new Set([0x41, 0x42, 0x43, 0x45, 0x6668])), 'U+0041-43, U+0045, U+6668');
});

test('清单解析与缺字：缺的字逐个列出', () => {
  const M = parseFontsManifest({ schemaVersion: 1, fonts: [{ family: 'BM Title', file: 'a.woff2', chars: '北冥' }] });
  assert.deepEqual(missingChars(M.fonts[0], '北冥你好'), ['你', '好']);
  assert.deepEqual(missingChars(M.fonts[0], '北冥\n'), []);
  assert.throws(() => parseFontsManifest({ schemaVersion: 2, fonts: [] }), GlyphError);
  assert.throws(() => parseFontsManifest({ schemaVersion: 1, fonts: [{ family: 'x' }] }), /缺 family \/ file \/ chars/);
});

test('字体锁定清单：仓库里的清单合格；反例逐条报出', () => {
  const lock = loadLock();
  assert.deepEqual(validateLock(lock), []);
  for (const f of lock.fonts) assert.equal(f.license, 'OFL-1.1');
  const bad = structuredClone(lock);
  bad.fonts[0].sha256 = 'abc';
  bad.fonts[1].license = 'Apache-2.0';
  bad.fonts[2].urls = ['http://example.com/x.ttf'];
  bad.fonts.push({ ...bad.fonts[3] });
  const p = validateLock(bad).join('\n');
  assert.match(p, /sha256/);
  assert.match(p, /只收 OFL-1\.1/);
  assert.match(p, /https/);
  assert.match(p, /重复/);
});

test('解释器：--python 当作 BEIMING_PYTHON；指向坏解释器时退出码 3（env.*），不悄悄换别的', async () => {
  await assert.rejects(findFontPython({ python: path.join(os.tmpdir(), 'no-such-python-p12') }), e => e.exitCode === 3 && /^env\./.test(e.code));
  const d = tmpFilm(FILM);
  try {
    const lock = loadLock(), cache = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-fcache-'));
    try {
      // 缓存里没有原始字体：退出码 3，提示先跑 fetch
      const r = run([d, '--cache', cache, '--json']);
      assert.equal(r.status, 3);
      const env = JSON.parse(r.stdout);
      assert.equal(env.error.code, 'env.font-source-missing');
      assert.match(env.error.hint, /tools\/fonts\/fetch\.mjs/);
      assert.equal(cacheStatus(lock, cache).every(s => s.state === 'missing'), true);
    } finally { fs.rmSync(cache, { recursive: true, force: true }); }
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('fetch.mjs --check：缓存缺文件退出 3、哈希不对退出 4；信封里不写本机绝对路径', () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-fcache-'));
  const fetch = a => spawnSync(process.execPath, [path.join(ROOT, 'tools/fonts/fetch.mjs'), ...a], { encoding: 'utf8', env: { ...process.env, BEIMING_FONT_CACHE: cache } });
  try {
    let r = fetch(['--check', '--only', 'barlow-light', '--json']);
    assert.equal(r.status, 3);
    fs.writeFileSync(path.join(cache, 'Barlow-Light.ttf'), 'not a font');
    r = fetch(['--check', '--only', 'barlow-light', '--json']);
    assert.equal(r.status, 4);
    const env = JSON.parse(r.stdout);
    assert.equal(env.error.code, 'contract.font-sha256');
    assert.equal(env.data.cache, '$BEIMING_FONT_CACHE');
    assert.ok(!r.stdout.includes(cache), 'stdout 的信封里没有缓存目录的绝对路径');
    assert.equal(fetch(['--only', 'no-such-font']).status, 4, '不认识的字体 id 是契约错误');
  } finally { fs.rmSync(cache, { recursive: true, force: true }); }
});

test('subset.mjs：--help 无副作用退出 0；用法错误退出 2；film.json 不合格退出 4', () => {
  const h = run(['--help']);
  assert.equal(h.status, 0); assert.match(h.stdout, /用法/);
  assert.equal(run([]).status, 2);
  assert.equal(run(['a', 'b']).status, 2);
  assert.equal(run(['x', '--nope']).status, 2);
  const d = tmpFilm({ ...FILM, texts: [{ id: 'title', text: '{{TITLE}}', font: 'BM Title' }] });
  try {
    const r = run([d, '--json']);
    assert.equal(r.status, 4);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, false); assert.equal(j.exitCode, 4); assert.match(j.error.message, /占位符/);
    assert.ok(!fs.existsSync(path.join(d, 'fonts')), '失败时不写任何文件');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
  const d2 = tmpFilm({ ...FILM, texts: [{ id: 't', text: '晨', font: '没声明的字族' }] });
  try { assert.equal(run([d2]).status, 4); } finally { fs.rmSync(d2, { recursive: true, force: true }); }
});

test('subset.mjs --check：清单缺字、文件被改都判过期（退出码 4），并指出是哪个字', () => {
  const lock = loadLock(), src = lock.fonts.find(f => f.id === 'ma-shan-zheng');
  const d = tmpFilm({ ...FILM, fonts: [FILM.fonts[0]], texts: [FILM.texts[0]] });
  try {
    fs.mkdirSync(path.join(d, 'fonts'));
    const woff = Buffer.from('不是真的字体，只用来算哈希');
    fs.writeFileSync(path.join(d, 'fonts', 'bm-title-400.woff2'), woff);
    const manifest = chars => ({ schemaVersion: 1, fonts: [{ family: 'BM Title', file: 'bm-title-400.woff2', weight: '400', chars, sha256: crypto.createHash('sha256').update(woff).digest('hex'), source: { id: src.id, sha256: src.sha256 } }] });
    fs.writeFileSync(path.join(d, 'fonts', 'fonts.json'), JSON.stringify(manifest('晨渡')));
    assert.equal(run([d, '--check']).status, 0, '覆盖全部文字时 --check 通过');
    fs.writeFileSync(path.join(d, 'fonts', 'fonts.json'), JSON.stringify(manifest('晨')));
    const r = run([d, '--check', '--json']);
    assert.equal(r.status, 4);
    assert.match(JSON.parse(r.stdout).error.message, /缺\s*「渡」/);
    fs.writeFileSync(path.join(d, 'fonts', 'fonts.json'), JSON.stringify(manifest('晨渡')));
    fs.writeFileSync(path.join(d, 'fonts', 'bm-title-400.woff2'), 'changed');
    assert.match(JSON.parse(run([d, '--check', '--json']).stdout).error.message, /sha256 不一致/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('真正子集化：缺字立即失败；成功时子集覆盖全部文字、两次结果逐字节相同（需要 fontTools 与字体缓存）', async t => {
  const lock = loadLock(), dir = cacheDir(lock);
  const ready = cacheStatus(lock, dir, ['ma-shan-zheng', 'noto-sans-sc']).every(s => s.state === 'ok');
  let py = null;
  try { py = await findFontPython(); } catch { py = null; }
  if (!ready || !py) return t.skip(`跳过：${!ready ? `字体缓存 ${dir} 不全（先跑 node tools/fonts/fetch.mjs，或设 BEIMING_FONT_CACHE）` : ''}${!py ? '没有装了 fontTools 与 brotli 的 Python（npm run setup，或设 BEIMING_PYTHON）' : ''}`);
  const env = {};
  const d = tmpFilm(FILM);
  try {
    const r = run([d, '--json'], env);
    assert.equal(r.status, 0, r.stderr);
    const first = JSON.parse(r.stdout).outputs.map(o => o.sha256);
    const M = JSON.parse(fs.readFileSync(path.join(d, 'fonts', 'fonts.json'), 'utf8'));
    assert.equal(M.fonts.length, 2);
    assert.deepEqual(M.coverage.map(c => [c.text, c.covered === c.chars]), [['title', true], ['sub', true]], '覆盖率报告逐条文字');
    assert.deepEqual(JSON.parse(run([d, '--json'], env).stdout).outputs.map(o => o.sha256), first, '同样的输入，子集与清单逐字节相同');
    assert.deepEqual(missingChars(parseFontsManifest(M).fonts[0], '晨渡'), []);
    assert.ok(fs.existsSync(path.join(d, 'fonts', 'OFL-mashanzheng.txt')), '许可全文随子集复制');
    assert.equal(run([d, '--check'], env).status, 0);
    // 片名字体（马善政）没有的字：缺字立即失败、列出该字
    const film2 = { ...FILM, texts: [{ id: 'title', text: '晨𠀀', font: 'BM Title' }] };
    fs.writeFileSync(path.join(d, 'film.json'), JSON.stringify(film2));
    const r2 = run([d, '--json'], env);
    assert.equal(r2.status, 4);
    assert.match(JSON.parse(r2.stdout).error.message, /缺字.*𠀀/);
    assert.equal(JSON.parse(r2.stdout).error.code, 'contract.missing-glyphs');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
