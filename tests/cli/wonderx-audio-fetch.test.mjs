import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

const execFileAsync = promisify(execFile);

import {
  parseUstar,
  sha256,
  verifyBundleBuffer,
  verifyLockMatchesManifest,
} from '../../films/wonderx/audio/fetch.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FETCH_SCRIPT = path.join(ROOT, 'films/wonderx/audio/fetch.mjs');

/** 构造标准 512 字节 USTAR 归档（支持自定义 typeflag 与原始路径以便覆盖安全反例）。 */
function makeUstar(entries) {
  const blocks = [];
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '');
    const hdr = Buffer.alloc(512, 0);
    hdr.write(e.path, 0, Math.min(Buffer.byteLength(e.path), 100), 'utf8');
    hdr.write('0000644\0', 100, 8, 'ascii');
    hdr.write('0000000\0', 108, 8, 'ascii');
    hdr.write('0000000\0', 116, 8, 'ascii');
    hdr.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    hdr.write('15241432000\0', 136, 12, 'ascii');
    hdr.fill(0x20, 148, 156);
    hdr[156] = e.typeflag ?? 0x30;
    hdr.write('ustar\0', 257, 6, 'ascii');
    hdr.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += hdr[i];
    hdr.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(hdr);
    if (data.length) {
      blocks.push(data);
      const rem = data.length % 512;
      if (rem) blocks.push(Buffer.alloc(512 - rem, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

function makeFixture() {
  const stem = Buffer.from('OggS-fixture-stem-pad');
  const sfx = Buffer.from('OggS-fixture-sfx-cut');
  const vo = Buffer.from('OggS-fixture-vo-v01');
  const lic = Buffer.from('MIT License fixture\n');
  const notice = Buffer.from('NOTICE fixture\n');
  const baseEntries = [
    { path: 'licenses/Beiming-Engine-MIT-LICENSE.txt', kind: 'license', data: lic },
    { path: 'NOTICE.txt', kind: 'notice', data: notice },
    { path: 'opus/sfx_laser_cut.ogg', kind: 'audio_sfx', data: sfx },
    { path: 'opus/stem_pad.ogg', kind: 'audio_stem', data: stem },
    { path: 'opus/vo_V01.ogg', kind: 'audio_vo_ai', data: vo },
  ].sort((a, b) => a.path.localeCompare(b.path));
  const sumsText = baseEntries.map(e => `${sha256(e.data)}  ${e.path}`).join('\n') + '\n';
  const allEntries = [
    ...baseEntries,
    { path: 'SHA256SUMS.txt', kind: 'checksums', data: Buffer.from(sumsText, 'utf8') },
  ].sort((a, b) => a.path.localeCompare(b.path));
  const gzBuf = gzipSync(makeUstar(allEntries));
  const manifest = {
    assets: baseEntries
      .filter(e => e.path.startsWith('opus/'))
      .map(e => ({ file: e.path, key: `audio/${path.basename(e.path)}`, kind: e.kind, bytes: e.data.length, sha256: sha256(e.data) })),
  };
  const lock = {
    schemaVersion: 1,
    status: 'published',
    filename: 'fixture.tar.gz',
    url: 'http://127.0.0.1/fixture.tar.gz',
    bytes: gzBuf.length,
    sha256: sha256(gzBuf),
    audioCount: manifest.assets.length,
    totalFiles: allEntries.length,
    contents: allEntries.map(e => ({ path: e.path, kind: e.kind, bytes: e.data.length, sha256: sha256(e.data) })),
  };
  return { gzBuf, lock, manifest, allEntries };
}

async function runFetchCli(args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [FETCH_SCRIPT, ...args, '--json'], { encoding: 'utf8' });
    return { status: 0, json: JSON.parse(stdout) };
  } catch (e) {
    const stdout = e.stdout?.toString('utf8') || '';
    return { status: e.code, json: stdout.trim() ? JSON.parse(stdout) : null, stderr: e.stderr?.toString('utf8') || '' };
  }
}

test('仓库内 bundle.lock.json 与 manifest.json 19 项音频（含 10 句导览）及权利清单严格一致', () => {
  const lock = JSON.parse(readFileSync(path.join(ROOT, 'films/wonderx/audio/bundle.lock.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'films/wonderx/audio/manifest.json'), 'utf8'));
  verifyLockMatchesManifest(lock, manifest);
  const audioItems = lock.contents.filter(e => e.path.startsWith('opus/'));
  const voItems = audioItems.filter(e => /^opus\/vo_V\d{2}\.ogg$/.test(e.path));
  const licItems = lock.contents.filter(e => e.path.startsWith('licenses/'));
  assert.equal(audioItems.length, 19);
  assert.equal(voItems.length, 10);
  assert.equal(licItems.length, 4);
  assert.ok(licItems.some(e => e.path === 'licenses/Beiming-Engine-MIT-LICENSE.txt'));
  assert.ok(lock.contents.some(e => e.path === 'NOTICE.txt'));
  assert.ok(lock.contents.some(e => e.path === 'SHA256SUMS.txt'));
  assert.equal(lock.totalFiles, 25);
  for (const e of lock.contents) {
    assert.ok(!/R01|R02|YuE2/i.test(e.path), `不应包含排除素材：${e.path}`);
  }
  const localTar = path.join(ROOT, 'films/wonderx/out/release-bundle', lock.filename);
  if (existsSync(localTar)) {
    const res = verifyBundleBuffer(readFileSync(localTar), lock, manifest);
    assert.equal(res.audioFiles.size, 19);
    assert.equal(res.files.size, 25);
  }
});

test('parseUstar 拒绝路径穿越、绝对路径、符号链接、损坏校验和与重复路径', () => {
  assert.throws(() => parseUstar(makeUstar([{ path: '../escape.ogg', data: 'x' }])), { code: 'contract.audio-bundle-path' });
  assert.throws(() => parseUstar(makeUstar([{ path: '/etc/passwd', data: 'x' }])), { code: 'contract.audio-bundle-path' });
  assert.throws(() => parseUstar(makeUstar([{ path: 'opus/../../evil.ogg', data: 'x' }])), { code: 'contract.audio-bundle-path' });
  assert.throws(() => parseUstar(makeUstar([{ path: 'opus/link.ogg', data: '', typeflag: 0x32 }])), { code: 'contract.audio-bundle-tar' });
  assert.throws(() => parseUstar(makeUstar([{ path: 'opus/a.ogg', data: '1' }, { path: 'opus/a.ogg', data: '2' }])), { code: 'contract.audio-bundle-tar' });
  const badCsum = makeUstar([{ path: 'opus/a.ogg', data: '1' }]);
  badCsum[0] ^= 0xff;
  assert.throws(() => parseUstar(badCsum), { code: 'contract.audio-bundle-tar' });
});

test('verifyBundleBuffer 拦截外层哈希篡改、额外未登记文件、缺失文件与内层逐件篡改', () => {
  const fx = makeFixture();
  assert.equal(verifyBundleBuffer(fx.gzBuf, fx.lock, fx.manifest).audioFiles.size, 3);

  // 1. 外层 1 字节翻转
  const flipped = Buffer.from(fx.gzBuf);
  flipped[flipped.length - 1] ^= 0x01;
  assert.throws(() => verifyBundleBuffer(flipped, fx.lock, fx.manifest), { code: 'contract.audio-bundle-sha256' });

  // 2. 即使外层锁被改成匹配，额外未登记文件仍被拒收
  const extraGz = gzipSync(makeUstar([...fx.allEntries, { path: 'opus/unexpected.ogg', data: 'bad' }]));
  const extraLock = { ...fx.lock, bytes: extraGz.length, sha256: sha256(extraGz) };
  assert.throws(() => verifyBundleBuffer(extraGz, extraLock, fx.manifest), { code: 'contract.audio-bundle-unexpected' });

  // 3. 归档缺少登记文件
  const missingGz = gzipSync(makeUstar(fx.allEntries.filter(e => e.path !== 'opus/vo_V01.ogg')));
  const missingLock = { ...fx.lock, bytes: missingGz.length, sha256: sha256(missingGz) };
  assert.throws(() => verifyBundleBuffer(missingGz, missingLock, fx.manifest), { code: 'contract.audio-bundle-missing' });

  // 4. 内层音频内容被篡改（即使外层哈希匹配伪造锁，contents 与 manifest 仍拦截）
  const tamperedEntries = fx.allEntries.map(e => (e.path === 'opus/vo_V01.ogg' ? { ...e, data: Buffer.from('TAMPERED-VO') } : e));
  const tamperedGz = gzipSync(makeUstar(tamperedEntries));
  const tamperedLock = { ...fx.lock, bytes: tamperedGz.length, sha256: sha256(tamperedGz) };
  assert.throws(() => verifyBundleBuffer(tamperedGz, tamperedLock, fx.manifest), { code: 'contract.audio-file-sha256' });

  // 5. 锁文件与 manifest.json 漂移
  const driftedManifest = { assets: fx.manifest.assets.map((a, i) => (i === 0 ? { ...a, sha256: '0'.repeat(64) } : a)) };
  assert.throws(() => verifyBundleBuffer(fx.gzBuf, fx.lock, driftedManifest), { code: 'contract.audio-lock-drift' });
});

test('CLI 端到端 HTTP 拉取、幂等缓存、完整性失败不落盘、--verify-only 检测损坏与待批门禁', async () => {
  const fx = makeFixture();
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wx-audio-fetch-'));
  let mode = 'good';
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (mode === 'good') {
      res.writeHead(200, { 'Content-Type': 'application/gzip' });
      res.end(fx.gzBuf);
    } else if (mode === 'corrupt') {
      const bad = Buffer.from(fx.gzBuf);
      bad[Math.floor(bad.length / 2)] ^= 0x5a;
      res.writeHead(200, { 'Content-Type': 'application/gzip' });
      res.end(bad);
    } else if (mode === 'truncated') {
      res.writeHead(200, { 'Content-Type': 'application/gzip' });
      res.end(fx.gzBuf.subarray(0, fx.gzBuf.length - 10));
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/bundle.tar.gz`;

  try {
    const lockPath = path.join(tmp, 'bundle.lock.json');
    const manifestPath = path.join(tmp, 'manifest.json');
    writeFileSync(lockPath, JSON.stringify({ ...fx.lock, url: baseUrl }, null, 2));
    writeFileSync(manifestPath, JSON.stringify(fx.manifest, null, 2));

    // 反例 A：下载内容 1 字节篡改 → 退出 4，且目标目录不残留任何音频或 .part 文件
    const badDest = path.join(tmp, 'dest-corrupt');
    mode = 'corrupt';
    const rCorrupt = await runFetchCli(['--lock', lockPath, '--manifest', manifestPath, '--dest', badDest, '--url', baseUrl]);
    assert.equal(rCorrupt.status, 4);
    assert.equal(rCorrupt.json?.error?.code, 'contract.audio-bundle-sha256');
    assert.equal(existsSync(path.join(badDest, 'opus')), false);

    // 反例 B：下载截断 → 退出 4，不落盘
    const truncDest = path.join(tmp, 'dest-trunc');
    mode = 'truncated';
    const rTrunc = await runFetchCli(['--lock', lockPath, '--manifest', manifestPath, '--dest', truncDest, '--url', baseUrl]);
    assert.equal(rTrunc.status, 4);
    assert.equal(rTrunc.json?.error?.code, 'contract.audio-bundle-sha256');
    assert.equal(existsSync(path.join(truncDest, 'opus')), false);

    // 反例 C：pending-owner-release-approval 且未显式指定 --url/--archive → 退出 3，拒绝访问远端
    const pendingLockPath = path.join(tmp, 'pending.lock.json');
    writeFileSync(pendingLockPath, JSON.stringify({ ...fx.lock, status: 'pending-owner-release-approval', url: baseUrl }, null, 2));
    const hitsBeforePending = hits;
    const rPending = await runFetchCli(['--lock', pendingLockPath, '--manifest', manifestPath, '--dest', path.join(tmp, 'dest-pending')]);
    assert.equal(rPending.status, 3);
    assert.equal(rPending.json?.error?.code, 'env.audio-release-pending');
    assert.equal(hits, hitsBeforePending);

    // 正例：HTTP 正常拉取到空目录 → 退出 0，校验全部音频落盘
    const goodDest = path.join(tmp, 'dest-good');
    mode = 'good';
    const rOk = await runFetchCli(['--lock', lockPath, '--manifest', manifestPath, '--dest', goodDest, '--url', baseUrl]);
    assert.equal(rOk.status, 0);
    assert.equal(rOk.json?.data?.state, 'fetched');
    assert.equal(rOk.json?.data?.verified, 3);

    // --verify-only 正常通过
    const rVerifyOk = await runFetchCli(['--lock', lockPath, '--manifest', manifestPath, '--dest', goodDest, '--verify-only']);
    assert.equal(rVerifyOk.status, 0);
    assert.equal(rVerifyOk.json?.data?.verified, 3);

    // 幂等重跑：命中本地缓存，零 HTTP 请求
    const hitsBeforeCache = hits;
    const rCached = await runFetchCli(['--lock', lockPath, '--manifest', manifestPath, '--dest', goodDest, '--url', baseUrl]);
    assert.equal(rCached.status, 0);
    assert.equal(rCached.json?.data?.state, 'cached');
    assert.equal(hits, hitsBeforeCache);

    // 反例 D：本地音频被篡改 1 字节 → --verify-only 退出 4；重跑 fetch 自动修复
    const voFile = path.join(goodDest, 'opus', 'vo_V01.ogg');
    const origVo = readFileSync(voFile);
    const hackedVo = Buffer.from(origVo);
    hackedVo[0] ^= 0x01;
    writeFileSync(voFile, hackedVo);
    const rVerifyBad = await runFetchCli(['--lock', lockPath, '--manifest', manifestPath, '--dest', goodDest, '--verify-only']);
    assert.equal(rVerifyBad.status, 4);
    assert.equal(rVerifyBad.json?.error?.code, 'contract.audio-sha256');
    const rRepair = await runFetchCli(['--lock', lockPath, '--manifest', manifestPath, '--dest', goodDest, '--url', baseUrl]);
    assert.equal(rRepair.status, 0);
    assert.equal(Buffer.compare(readFileSync(voFile), origVo), 0);

    // 反例 E：缺少文件 → --verify-only 退出 3
    rmSync(voFile);
    const rVerifyMiss = await runFetchCli(['--lock', lockPath, '--manifest', manifestPath, '--dest', goodDest, '--verify-only']);
    assert.equal(rVerifyMiss.status, 3);
    assert.equal(rVerifyMiss.json?.error?.code, 'env.audio-missing');
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
