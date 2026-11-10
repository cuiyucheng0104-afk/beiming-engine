// 共享资产注册表（engine/assets/manifest.js，T02；差距 ORCH-15）：稳定 id、sha256、改一个字节就能查出。
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  KINDS, assetFingerprint, buildLock, checkAssets, hashAsset, loadRegistry, moduleClosure, readLock, resolveAsset,
} from '../../engine/assets/manifest.js';
import { loadFilm, validateFilm } from '../../engine/production/film.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const CLI = join(REPO, 'engine', 'assets', 'manifest.js');
const codes = r => r.diagnostics.map(d => d.code);

/** 只含 src/ 的临时仓库副本（底板、字体照常从真仓库核对时不需要它们）。 */
function srcCopy() {
  const root = mkdtempSync(join(tmpdir(), 'beiming-assets-'));
  cpSync(join(REPO, 'src'), join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'assets', 'plates'), { recursive: true });
  cpSync(join(REPO, 'assets', 'plates', 'plates.json'), join(root, 'assets', 'plates', 'plates.json'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('注册表：造型、角色、材质、底板、字体、风格参考都有 id；底板取自 plates.json', () => {
  const reg = loadRegistry();
  assert.deepEqual(reg.problems, []);
  for (const id of ['model:kun', 'model:kun_qinglv', 'model:ferry', 'character:girl', 'character:birds', 'material:toon', 'plate:sky_dawn', 'plate:paper', 'font:noto-sans-sc', 'font:barlow', 'font:ma-shan-zheng', 'ref:sky_test']) {
    assert.ok(reg.assets.has(id), id);
  }
  const plates = JSON.parse(readFileSync(join(REPO, 'assets', 'plates', 'plates.json'), 'utf8')).plates;
  assert.equal([...reg.assets.keys()].filter(k => k.startsWith('plate:')).length, plates.length);
  for (const e of reg.assets.values()) {
    assert.ok(KINDS.includes(e.kind), e.id);
    assert.ok(e.license && e.owner && e.source, e.id);
  }
  assert.equal(reg.assets.get('font:barlow').license, 'OFL-1.1');
});

test('资产 id 的解析：种类、版本、只写名字时唯一才算、local 指作品自带文件', () => {
  const reg = loadRegistry();
  assert.equal(resolveAsset('model:kun@v1', reg).id, 'model:kun');
  assert.equal(resolveAsset('kun@v1', reg).id, 'model:kun');
  assert.equal(resolveAsset('plate:sky_dawn', reg).version, 1);
  assert.equal(resolveAsset('kun@v2', reg).error, 'asset-version-unknown');
  assert.equal(resolveAsset('model:kun_gold', reg).error, 'asset-unknown');
  assert.equal(resolveAsset('mesh:kun', reg).error, 'asset-kind-unknown');
  assert.equal(resolveAsset('model:a/b', reg).error, 'asset-id-invalid');
  assert.equal(resolveAsset('local:assets/hero.png', reg).kind, 'local');
  assert.equal(resolveAsset('', reg).error, 'asset-id-invalid');
});

test('JS 模块的哈希覆盖 src/ 里的 import 闭包，不含 engine/', () => {
  assert.deepEqual(moduleClosure('src/kun.js'), ['src/eye_shade.js', 'src/kun.js', 'src/shadow.js', 'src/toon.js']);
  assert.deepEqual(moduleClosure('src/girl.js'), ['src/girl.js', 'src/timeline.js']);
  assert.ok(moduleClosure('src/kun_qinglv.js').includes('src/toon_qinglv.js'));
  const reg = loadRegistry();
  const h = hashAsset(reg.assets.get('model:kun'));
  assert.match(h.sha256, /^[0-9a-f]{64}$/);
  assert.equal(h.files.length, 4);
});

test('改 src/kun.js 一个字节：资产哈希变了，check 提示依赖它的镜头缓存失效；锁文件与仓库现状一致', () => {
  const lock = readLock();
  assert.ok(lock, '缺 engine/assets/assets.lock.json：node engine/assets/manifest.js lock --write');
  const fresh = buildLock();
  assert.deepEqual(Object.keys(fresh.assets).sort(), Object.keys(lock.assets).sort());
  for (const [id, v] of Object.entries(fresh.assets)) assert.equal(v.sha256, lock.assets[id].sha256, `${id} 与锁文件不符：资产改过却没更新锁文件`);
  const c = srcCopy();
  try {
    const p = join(c.root, 'src', 'kun.js');
    writeFileSync(p, `${readFileSync(p, 'utf8')} `);
    const r = checkAssets(['model:kun@v1', 'character:girl@v1'], { root: c.root, lock });
    assert.equal(r.ok, true);
    assert.deepEqual(codes(r), ['asset-changed']);
    assert.match(r.diagnostics[0].message, /src\/kun\.js/);
    assert.match(r.diagnostics[0].message, /缓存失效/);
    // 被依赖的 toon.js 改了，用到它的 kun 也变
    const t = join(c.root, 'src', 'toon.js');
    writeFileSync(p, readFileSync(join(REPO, 'src', 'kun.js')));
    writeFileSync(t, `${readFileSync(t, 'utf8')}\n// x\n`);
    assert.deepEqual(codes(checkAssets(['model:kun@v1'], { root: c.root, lock })), ['asset-changed']);
    // 换行改成 CRLF 不算改动（Windows 检出与 macOS 同一个哈希）
    writeFileSync(t, readFileSync(join(REPO, 'src', 'toon.js'), 'utf8').replace(/\n/g, '\r\n'));
    assert.deepEqual(codes(checkAssets(['model:kun@v1'], { root: c.root, lock })), []);
    // 文件被删：判错
    rmSync(join(c.root, 'src', 'shadow.js'));
    assert.deepEqual(codes(checkAssets(['model:kun@v1'], { root: c.root, lock })), ['asset-file-missing']);
  } finally { c.cleanup(); }
});

test('缓存键：资产指纹随资产内容变，顺序无关；不认识的资产抛错', () => {
  const a = assetFingerprint(['model:kun@v1', 'plate:sky_dawn']);
  assert.equal(assetFingerprint(['plate:sky_dawn', 'model:kun@v1']), a);
  assert.notEqual(assetFingerprint(['model:kun@v1']), a);
  assert.throws(() => assetFingerprint(['model:nope']), e => e.code === 'asset-unknown');
});

test('film.json 的 assets 按注册表核对：不认识判错，local 文件按作品目录核对', () => {
  const base = { schemaVersion: 2, id: 'x', title: 'x', route: 'c', backend: 'canvas', output: { profile: 'web-1080p24', width: 1920, height: 1080, fps: 24, frameCount: 24 }, shots: [{ id: 'S1', in: 0, out: 24 }], credits: [], aigc: { contains: false }, audio: { mode: 'none' } };
  assert.deepEqual(validateFilm({ ...base, assets: ['model:kun@v1', 'plate:sky_dawn', 'font:barlow@v1'] }, { checkFiles: false }).diagnostics.filter(d => d.level === 'error'), []);
  assert.ok(validateFilm({ ...base, assets: ['model:kun_gold'] }, { checkFiles: false }).diagnostics.some(d => d.code === 'asset-unknown'));
  const root = mkdtempSync(join(tmpdir(), 'beiming-assets-film-'));
  try {
    const dir = join(root, 'x');
    mkdirSync(dir);
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    writeFileSync(join(dir, 'film.json'), JSON.stringify({ ...base, assets: ['local:assets/hero.png', 'model:kun@v1'] }));
    assert.ok(loadFilm(dir).diagnostics.some(d => d.code === 'asset-file-missing'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'hero.png'), 'PNG');
    assert.deepEqual(loadFilm(dir).diagnostics.filter(d => d.level === 'error'), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
  assert.deepEqual(loadFilm(join(REPO, 'films', 'beiming-10s')).diagnostics.filter(d => d.code.startsWith('asset')), []);
});

test('命令行：list / check / lock 的退出码与 --json 信封；--help 无副作用', () => {
  const run = args => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60_000 });
  const before = readFileSync(join(REPO, 'engine', 'assets', 'assets.lock.json'), 'utf8');
  assert.equal(run(['--help']).status, 0);
  const list = run(['list', '--kind', 'font', '--json']);
  assert.equal(list.status, 0);
  assert.deepEqual(JSON.parse(list.stdout).result.assets.map(a => a.id), ['font:noto-sans-sc@v1', 'font:barlow@v1', 'font:ma-shan-zheng@v1']);
  assert.equal(run(['check', '--film', join(REPO, 'films', 'beiming-10s')]).status, 0);
  const bad = run(['check', 'model:nope', '--json']);
  assert.equal(bad.status, 4);
  assert.equal(JSON.parse(bad.stdout).error.code, 'asset-unknown');
  assert.equal(run(['lock', '--json']).status, 0);
  assert.equal(run(['nope']).status, 2);
  assert.equal(run(['list', '--kind']).status, 2);
  assert.equal(run(['check', '--bogus']).status, 2);
  assert.equal(readFileSync(join(REPO, 'engine', 'assets', 'assets.lock.json'), 'utf8'), before);
});
