#!/usr/bin/env node
// 一次性取得 fonts/fonts.lock.json 锁定的完整 OFL 原始字体，放进缓存目录（默认 .cache/fonts，不进 git），逐字节核对 sha256。
// 已在缓存且哈希对的跳过；镜像按清单顺序试，Node 下载失败时改用 curl（会走 HTTPS_PROXY 等代理环境变量）。
// 下载先写到 <文件>.part-<进程号>，核对通过才改名；中断、出错都会删掉 .part 文件。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runCli, CliError, EXIT, onCleanup } from '../lookdev/lib/cli.mjs';
import { loadLock, cacheDir, cacheStatus, fontById } from './lock.mjs';

const USAGE = `
用法：node tools/fonts/fetch.mjs [--only <id,...>] [--cache <目录>] [--check] [--json]
  取得字体锁定清单（fonts/fonts.lock.json）里的完整 OFL 字体到缓存目录，并核对 sha256。
  --only    只取这几个 id（默认全部；id 见清单）
  --cache   缓存目录（默认：环境变量 BEIMING_FONT_CACHE，否则仓库根的 .cache/fonts）
  --check   只核对缓存，不联网：缺文件退出码 3，哈希不对退出码 4
  --json    stdout 只输出一个 JSON 对象（附录 C2 信封）
退出码：0 全部就绪；2 用法错误；3 缺文件或下载不了（网络、代理）；4 下载到的内容与锁定的 sha256 不符。
`;

async function viaFetch(url, part, timeoutMs) {
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const h = crypto.createHash('sha256'), fd = fs.openSync(part, 'w');
    let n = 0;
    try { for await (const chunk of r.body) { h.update(chunk); fs.writeSync(fd, chunk); n += chunk.length; } } finally { fs.closeSync(fd); }
    return { sha256: h.digest('hex'), bytes: n };
  } finally { clearTimeout(timer); }
}
function viaCurl(url, part, timeoutMs) {
  const r = spawnSync('curl', ['-fsSL', '--retry', '2', '--max-time', String(Math.ceil(timeoutMs / 1000)), '-o', part, url], { encoding: 'utf8', windowsHide: true });
  if (r.error) throw new Error(r.error.code === 'ENOENT' ? '没有 curl' : r.error.message);
  if (r.status !== 0) throw new Error(`curl 退出码 ${r.status} ${(r.stderr || '').trim().slice(0, 160)}`);
  const buf = fs.readFileSync(part);
  return { sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}

await runCli({
  command: 'fonts:fetch',
  usage: USAGE,
  spec: { only: 'list', cache: 'string', check: 'bool', timeout: 'number' },
  async main({ opts, args, out, log }) {
    if (args.length) throw new CliError(EXIT.USAGE, 'extra-args', `多余的参数：${args.join(' ')}`, '用 --help 看用法');
    const lock = loadLock(), dir = cacheDir(lock, opts.cache);
    const ids = opts.only.length ? opts.only.map(id => fontById(lock, id).id) : null;
    const before = cacheStatus(lock, dir, ids);
    if (opts.check) {
      const bad = before.filter(s => s.state !== 'ok');
      for (const s of before) log(`${s.state === 'ok' ? '✓' : s.state === 'missing' ? '缺' : '✗'} ${s.id}  ${s.path}`);
      const mism = bad.filter(s => s.state === 'mismatch');
      if (mism.length) throw new CliError(EXIT.CONTRACT, 'sha-mismatch', `缓存里的字体与锁定的 sha256 不符：${mism.map(s => s.file).join('、')}`, `删掉这些文件后重跑 node tools/fonts/fetch.mjs（缓存目录 ${dir}）`);
      if (bad.length) throw new CliError(EXIT.ENV, 'fonts-missing', `缓存里缺字体：${bad.map(s => s.file).join('、')}`, '运行 node tools/fonts/fetch.mjs 取得（需要联网，一次即可）');
      return { cache: dir, fonts: before.map(({ id, file, state }) => ({ id, file, state })) };
    }
    fs.mkdirSync(dir, { recursive: true });
    const timeoutMs = (opts.timeout ?? 600) * 1000, result = [], failed = [];
    for (const s of before) {
      const f = fontById(lock, s.id);
      if (s.state === 'ok') { log(`✓ ${f.id} 已在缓存`); result.push({ id: f.id, file: f.file, state: 'cached' }); out(s.path, 'font-source'); continue; }
      if (s.state === 'mismatch') { log(`✗ ${f.id} 缓存文件哈希不对，重新下载`); fs.rmSync(s.path, { force: true }); }
      const part = `${s.path}.part-${process.pid}`;
      onCleanup(() => fs.rmSync(part, { force: true }));
      const tried = [];
      let done = false, wrongContent = false;
      for (const via of [viaFetch, viaCurl]) {
        for (const url of f.urls) {
          try {
            log(`↓ ${f.id}  ${url}${via === viaCurl ? '（curl）' : ''}`);
            const got = await via(url, part, timeoutMs);
            if (got.sha256 !== f.sha256 || got.bytes !== f.bytes) { wrongContent = true; tried.push(`${url}：内容不符（${got.bytes} 字节，sha256 ${got.sha256.slice(0, 12)}…）`); fs.rmSync(part, { force: true }); continue; }
            fs.renameSync(part, s.path); done = true; break;
          } catch (e) { tried.push(`${url}${via === viaCurl ? '（curl）' : ''}：${e.message}`); fs.rmSync(part, { force: true }); }
        }
        if (done) break;
      }
      if (done) { log(`✓ ${f.id} ${f.bytes} 字节，sha256 已核对`); result.push({ id: f.id, file: f.file, state: 'downloaded' }); out(s.path, 'font-source'); }
      else { failed.push({ id: f.id, wrongContent, tried }); result.push({ id: f.id, file: f.file, state: 'failed', tried }); }
    }
    if (failed.length) {
      const wrong = failed.filter(x => x.wrongContent && x.tried.every(t => t.includes('内容不符')));
      const detail = failed.map(x => `${x.id}：${x.tried.join(' | ')}`).join('\n');
      if (wrong.length === failed.length) throw Object.assign(new CliError(EXIT.CONTRACT, 'sha-mismatch', `下载到的字体与锁定的 sha256 不符：\n${detail}`, '镜像内容变了。核实来源后更新 fonts/fonts.lock.json（新版本要重新登记 sha256 与版本号）'), { data: { cache: dir, fonts: result } });
      throw Object.assign(new CliError(EXIT.ENV, 'download-failed', `有字体没下载成功：\n${detail}`, '检查网络或代理（curl 会用 HTTPS_PROXY），或把文件手动放进缓存目录后用 --check 核对'), { data: { cache: dir, fonts: result } });
    }
    return { cache: dir, fonts: result };
  },
});
