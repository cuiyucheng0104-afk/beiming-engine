#!/usr/bin/env node
/* global AbortController, Buffer, clearTimeout, fetch, process, setTimeout */
// WonderX Phase 2 v4 · D10 音频资产拉取与完整校验脚本。
// 19 个获审查 Opus 音频与权利声明按 D10 存放在 Release 资产包（不进 git），经本脚本下载并逐字节校验。
import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { CliError, defineCommand, isMain, runCli } from '../../../tools/lib/cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOCK = path.join(HERE, 'bundle.lock.json');
const DEFAULT_MANIFEST = path.join(HERE, 'manifest.json');
const MAX_TAR_BYTES = 16 * 1024 * 1024;

export const sha256 = buf => createHash('sha256').update(buf).digest('hex');

function readCString(buf, start, len) {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString('utf8');
}

function readOctal(buf, start, len) {
  const s = readCString(buf, start, len).trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw new CliError('contract.audio-bundle-tar', `tar 头部八进制字段非法：${JSON.stringify(s)}`);
  return Number.parseInt(s, 8);
}

export function assertSafeRelPath(rel) {
  if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.includes('\0') || /^[A-Za-z]:/.test(rel)) {
    throw new CliError('contract.audio-bundle-path', `归档内路径不安全：${JSON.stringify(rel)}`);
  }
  const segs = rel.split('/');
  if (segs.some(s => !s || s === '.' || s === '..')) {
    throw new CliError('contract.audio-bundle-path', `归档内路径包含越界段：${JSON.stringify(rel)}`);
  }
  return rel;
}

/** 严格 USTAR 解析：仅允许常规文件，校验头部校验和、拒绝符号链接/目录穿越/重复路径。 */
export function parseUstar(tarBuf) {
  if (!Buffer.isBuffer(tarBuf) || tarBuf.length < 512 || tarBuf.length % 512 !== 0) {
    throw new CliError('contract.audio-bundle-tar', `tar 长度异常（${tarBuf?.length ?? 0} 字节）`);
  }
  const files = new Map();
  let off = 0;
  while (off + 512 <= tarBuf.length) {
    const hdr = tarBuf.subarray(off, off + 512);
    if (hdr.every(b => b === 0)) break;
    const expectedSum = readOctal(hdr, 148, 8);
    let actualSum = 0;
    for (let i = 0; i < 512; i++) actualSum += (i >= 148 && i < 156) ? 32 : hdr[i];
    if (actualSum !== expectedSum) {
      throw new CliError('contract.audio-bundle-tar', `tar 头部校验和不符（offset ${off}）`);
    }
    const typeflag = hdr[156];
    if (typeflag !== 0x30 && typeflag !== 0x00) {
      throw new CliError('contract.audio-bundle-tar', `归档含非常规文件条目（typeflag=0x${typeflag.toString(16)}）`);
    }
    const name = readCString(hdr, 0, 100);
    const prefix = readCString(hdr, 345, 155);
    const rel = assertSafeRelPath(prefix ? `${prefix}/${name}` : name);
    if (files.has(rel)) {
      throw new CliError('contract.audio-bundle-tar', `归档含重复路径：${rel}`);
    }
    const size = readOctal(hdr, 124, 12);
    const dataStart = off + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tarBuf.length) {
      throw new CliError('contract.audio-bundle-tar', `归档条目截断：${rel}`);
    }
    files.set(rel, Buffer.from(tarBuf.subarray(dataStart, dataEnd)));
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** 核对 bundle.lock.json 与 manifest.json 的 19 个音频条目完全一致。 */
export function verifyLockMatchesManifest(lock, manifest) {
  if (!lock || lock.schemaVersion !== 1 || !Array.isArray(lock.contents)) {
    throw new CliError('contract.audio-lock', 'bundle.lock.json 缺少有效的 schemaVersion 或 contents');
  }
  if (!manifest || !Array.isArray(manifest.assets) || !manifest.assets.length) {
    throw new CliError('contract.audio-manifest', 'manifest.json 缺少有效的 assets 列表');
  }
  const lockAudio = new Map(lock.contents.filter(e => e.path.startsWith('opus/')).map(e => [e.path, e]));
  if (lockAudio.size !== manifest.assets.length || lock.audioCount !== manifest.assets.length) {
    throw new CliError('contract.audio-lock-drift', `锁文件音频数（${lockAudio.size}/${lock.audioCount}）与 manifest（${manifest.assets.length}）不一致`);
  }
  for (const a of manifest.assets) {
    const e = lockAudio.get(a.file);
    if (!e) throw new CliError('contract.audio-lock-drift', `锁文件缺少 manifest 音频：${a.file}`);
    if (e.bytes !== a.bytes || e.sha256 !== a.sha256) {
      throw new CliError('contract.audio-lock-drift', `锁文件与 manifest 在 ${a.file} 上字节/哈希不一致`);
    }
  }
}

/** 完整校验压缩包外层哈希、USTAR 安全性、全部 25 个文件逐件哈希与 manifest 19 项交叉校验。 */
export function verifyBundleBuffer(gzBuf, lock, manifest) {
  verifyLockMatchesManifest(lock, manifest);
  const actualSha = sha256(gzBuf);
  if (gzBuf.length !== lock.bytes || actualSha !== lock.sha256) {
    throw new CliError(
      'contract.audio-bundle-sha256',
      `资产包完整性校验失败：期望 ${lock.bytes} B / ${lock.sha256}，实测 ${gzBuf.length} B / ${actualSha}`,
      { hint: '删除损坏的下载文件或核实 Release 地址后重试' },
    );
  }
  let tarBuf;
  try {
    tarBuf = gunzipSync(gzBuf, { maxOutputLength: MAX_TAR_BYTES });
  } catch (e) {
    throw new CliError('contract.audio-bundle-gzip', `资产包 gzip 解压失败：${e.message}`);
  }
  const files = parseUstar(tarBuf);
  const expectedMap = new Map(lock.contents.map(e => [e.path, e]));
  for (const rel of files.keys()) {
    if (!expectedMap.has(rel)) {
      throw new CliError('contract.audio-bundle-unexpected', `归档包含未登记文件：${rel}`);
    }
  }
  for (const entry of lock.contents) {
    const buf = files.get(entry.path);
    if (!buf) throw new CliError('contract.audio-bundle-missing', `归档缺少登记文件：${entry.path}`);
    const h = sha256(buf);
    if (buf.length !== entry.bytes || h !== entry.sha256) {
      throw new CliError('contract.audio-file-sha256', `归档内 ${entry.path} 校验失败：期望 ${entry.bytes} B / ${entry.sha256}，实测 ${buf.length} B / ${h}`);
    }
  }
  // 校验归档内 SHA256SUMS.txt 与各文件一致
  const sumsBuf = files.get('SHA256SUMS.txt');
  if (sumsBuf) {
    const lines = sumsBuf.toString('utf8').trim().split('\n').filter(Boolean);
    const seen = new Map();
    for (const line of lines) {
      const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
      if (!m) throw new CliError('contract.audio-bundle-sums', `SHA256SUMS.txt 行格式错误：${line}`);
      seen.set(m[2], m[1]);
    }
    for (const entry of lock.contents) {
      if (entry.path === 'SHA256SUMS.txt') continue;
      if (seen.get(entry.path) !== entry.sha256) {
        throw new CliError('contract.audio-bundle-sums', `SHA256SUMS.txt 与 ${entry.path} 哈希不一致`);
      }
    }
  }
  const audioFiles = new Map();
  for (const a of manifest.assets) {
    const buf = files.get(a.file);
    if (!buf || buf.length !== a.bytes || sha256(buf) !== a.sha256) {
      throw new CliError('contract.audio-manifest-mismatch', `归档内音频 ${a.file} 与 manifest.json 不符`);
    }
    audioFiles.set(a.file, buf);
  }
  return { files, audioFiles };
}

/** 校验目标目录中已有 opus/*.ogg 状态。 */
export async function inspectDestAudio(destDir, manifest) {
  const verified = [];
  const missing = [];
  const mismatched = [];
  for (const a of manifest.assets) {
    const abs = path.join(destDir, ...a.file.split('/'));
    if (!existsSync(abs)) { missing.push(a.file); continue; }
    const buf = await readFile(abs);
    const h = sha256(buf);
    if (buf.length !== a.bytes || h !== a.sha256) {
      mismatched.push({ file: a.file, expectedBytes: a.bytes, actualBytes: buf.length, expectedSha256: a.sha256, actualSha256: h });
    } else {
      verified.push(a.file);
    }
  }
  return { verified, missing, mismatched };
}

async function downloadToPart(url, partPath, maxBytes, timeoutMs, onCleanup) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`超过 ${Math.round(timeoutMs / 1000)} 秒`)), timeoutMs);
  const undo = onCleanup(() => ac.abort(new Error('被中断')));
  try {
    const resp = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!resp.ok) throw new CliError('env.audio-download', `下载资产包失败：HTTP ${resp.status}（${url}）`, { hint: '检查网络、代理（HTTPS_PROXY + NODE_USE_ENV_PROXY=1）或改用 --archive <本地包>' });
    const chunks = [];
    let total = 0;
    for await (const chunk of resp.body) {
      total += chunk.length;
      if (total > maxBytes) {
        throw new CliError('contract.audio-bundle-size', `下载内容超过上限 ${maxBytes} 字节（已收 ${total} 字节）`);
      }
      chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks, total);
    await writeFile(partPath, buf);
    return buf;
  } catch (e) {
    if (e instanceof CliError) throw e;
    const msg = e?.name === 'AbortError' ? (ac.signal.reason?.message || '超时') : e.message;
    throw new CliError('env.audio-download', `下载资产包失败（${url}）：${msg}`, { hint: '检查网络与代理设置，或用 --archive <本地包> 进行离线验证' });
  } finally {
    clearTimeout(timer);
    undo();
  }
}

export const command = defineCommand({
  name: 'wonderx-audio-fetch',
  summary: '拉取并逐字节校验 WonderX Phase 2 v4 的 19 项获审查 Opus 音频与权利声明包（D10）',
  usage: ['node films/wonderx/audio/fetch.mjs [--url <地址> | --archive <本地包>] [--dest <目录>] [--verify-only] [--json]'],
  options: {
    url: { type: 'string', arg: '<地址>', describe: '指定资产包下载地址（默认读取 bundle.lock.json 的 url）' },
    archive: { type: 'string', arg: '<文件>', describe: '直接从本地 .tar.gz 资产包校验并解包（不联网）' },
    dest: { type: 'string', arg: '<目录>', describe: '音频目标目录（默认 films/wonderx/audio，写入 <目录>/opus/）' },
    lock: { type: 'string', arg: '<文件>', describe: '覆盖 bundle.lock.json 路径' },
    manifest: { type: 'string', arg: '<文件>', describe: '覆盖 manifest.json 路径' },
    'verify-only': { type: 'boolean', describe: '只核对本地 opus/*.ogg 与锁/清单一致性，不下载也不写盘' },
    timeout: { type: 'number', arg: '<秒>', min: 1, describe: '下载超时秒数，默认 300' },
  },
  exitCodes: {
    0: '19 项音频齐全且校验一致',
    2: '用法错误',
    3: '缺文件、Release 尚待主人批准发布，或下载失败',
    4: '锁文件/清单漂移、资产包哈希或归档安全/逐件哈希不符',
    130: '被中断，已清理临时文件',
  },
  async run(ctx) {
    const o = ctx.opts;
    if (o.url && o.archive) throw new CliError('usage.conflict', '--url 与 --archive 不能同时使用');
    if (o['verify-only'] && (o.url || o.archive)) throw new CliError('usage.conflict', '--verify-only 不能与 --url / --archive 同时使用');

    const lockPath = path.resolve(o.lock || DEFAULT_LOCK);
    const manifestPath = path.resolve(o.manifest || DEFAULT_MANIFEST);
    const destDir = path.resolve(o.dest || HERE);

    let lock, manifest;
    try { lock = JSON.parse(await readFile(lockPath, 'utf8')); } catch (e) { throw new CliError('env.audio-lock', `读不出锁文件 ${lockPath}：${e.message}`); }
    try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch (e) { throw new CliError('env.audio-manifest', `读不出清单 ${manifestPath}：${e.message}`); }

    verifyLockMatchesManifest(lock, manifest);
    const before = await inspectDestAudio(destDir, manifest);

    if (o['verify-only']) {
      const data = { dest: destDir, total: manifest.assets.length, verified: before.verified.length, missing: before.missing, mismatched: before.mismatched };
      if (before.mismatched.length) {
        throw new CliError('contract.audio-sha256', `本地音频校验不符（${before.mismatched.length} 项）：${before.mismatched.map(m => m.file).join('、')}`, { hint: '删除损坏文件后重新运行 fetch.mjs', data });
      }
      if (before.missing.length) {
        throw new CliError('env.audio-missing', `缺少 ${before.missing.length} 项音频：${before.missing.join('、')}`, { hint: '运行 node films/wonderx/audio/fetch.mjs（或 --archive <本地包>）拉取', data });
      }
      ctx.out(`✓ ${before.verified.length}/${manifest.assets.length} 项音频与锁文件及 manifest.json 逐字节一致`);
      return { data };
    }

    if (before.missing.length === 0 && before.mismatched.length === 0) {
      ctx.out(`✓ ${before.verified.length}/${manifest.assets.length} 项音频已在本地且校验通过（跳过下载）`);
      return { data: { dest: destDir, state: 'cached', verified: before.verified.length, downloaded: 0, bundleSha256: lock.sha256 } };
    }

    const parts = new Set();
    const undoCleanup = ctx.onCleanup(() => {
      for (const p of parts) { try { rmSync(p, { force: true }); } catch { /* ignore */ } }
    });

    let gzBuf;
    let sourceLabel;
    if (o.archive) {
      const archivePath = path.resolve(o.archive);
      sourceLabel = archivePath;
      try { gzBuf = await readFile(archivePath); } catch (e) { throw new CliError('env.audio-archive', `读不出本地资产包 ${archivePath}：${e.message}`); }
    } else {
      const targetUrl = o.url || lock.url;
      if (!o.url && lock.status && lock.status !== 'published') {
        throw new CliError(
          'env.audio-release-pending',
          `默认 Release 资产包当前状态为 ${lock.status}（尚未经主人授权公开发布），拒绝请求未发布地址 ${targetUrl}`,
          { hint: '本地复演请显式传入 --archive <本地包> 或 --url <本地 HTTP 地址>；主人批准发布后更新 bundle.lock.json 状态为 published' },
        );
      }
      sourceLabel = targetUrl;
      await mkdir(destDir, { recursive: true });
      const dlPart = path.join(destDir, `.bundle.part-${process.pid}`);
      parts.add(dlPart);
      try {
        ctx.log.info(`↓ ${targetUrl}`);
        gzBuf = await downloadToPart(targetUrl, dlPart, Math.max(lock.bytes * 2, MAX_TAR_BYTES), (o.timeout ?? 300) * 1000, ctx.onCleanup);
      } finally {
        parts.delete(dlPart);
        await rm(dlPart, { force: true });
      }
    }

    const { files, audioFiles } = verifyBundleBuffer(gzBuf, lock, manifest);

    // 若目标目录已有随仓库跟踪的 licenses/*.txt，核对与归档内许可全文一致（不覆盖仓库文件）
    for (const [rel, buf] of files.entries()) {
      if (!rel.startsWith('licenses/')) continue;
      const existing = path.join(destDir, ...rel.split('/'));
      if (existsSync(existing)) {
        const cur = await readFile(existing);
        if (sha256(cur) !== sha256(buf)) {
          throw new CliError('contract.audio-license-drift', `本地许可文件 ${rel} 与资产包内副本不一致`);
        }
      }
    }

    const opusDir = path.join(destDir, 'opus');
    await mkdir(opusDir, { recursive: true });
    const outputs = [];
    for (const a of manifest.assets) {
      const target = path.join(destDir, ...a.file.split('/'));
      const part = `${target}.part-${process.pid}`;
      parts.add(part);
      try {
        await writeFile(part, audioFiles.get(a.file));
        await rename(part, target);
      } finally {
        parts.delete(part);
        await rm(part, { force: true });
      }
      outputs.push({ path: a.file, sha256: a.sha256, bytes: a.bytes, kind: a.kind });
    }
    undoCleanup();

    const after = await inspectDestAudio(destDir, manifest);
    if (after.missing.length || after.mismatched.length) {
      throw new CliError('contract.audio-post-verify', '写入后二次校验失败');
    }
    ctx.out(`✓ 已从 ${sourceLabel} 校验并解包 ${after.verified.length}/${manifest.assets.length} 项音频（包 SHA-256 ${lock.sha256.slice(0, 12)}…）`);
    return { data: { dest: destDir, state: 'fetched', source: sourceLabel, verified: after.verified.length, downloaded: after.verified.length, bundleBytes: lock.bytes, bundleSha256: lock.sha256 }, outputs };
  },
});

if (isMain(import.meta.url)) await runCli(command);
