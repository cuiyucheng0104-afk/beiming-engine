#!/usr/bin/env node
// 一次性取得 fonts/fonts.lock.json 锁定的完整 OFL 原始字体，放进缓存目录（默认 .cache/fonts，不进 git，决定 D10），逐字节核对 sha256。
// 只用 Node 自带的 fetch 与 node:crypto（三个平台一样，不依赖 curl / sh）；已在缓存且哈希对的跳过；镜像按清单顺序试。
// 要走代理：设 HTTPS_PROXY 并加 NODE_USE_ENV_PROXY=1（Node ≥ 24 的内置 fetch 才会读代理变量）；内网可以把清单里的文件
// 拷进缓存目录再跑 --check（哈希对就行）。下载先写 <文件>.part-<进程号>，核对通过才改名；中断、出错都会删掉 .part 文件。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CliError, defineCommand, isMain, runCli } from '../lib/cli.mjs';
import { loadLock, cacheDir, cacheLabel, cacheStatus, fontById } from './lock.mjs';

const PROXY_HINT = '要走代理时设 HTTPS_PROXY 并加 NODE_USE_ENV_PROXY=1（Node 内置 fetch 只在这时读代理变量）；内网可把清单里的文件拷进缓存目录后跑 --check';

async function download(url, part, timeoutMs, onCleanup) {
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(new Error(`超过 ${Math.round(timeoutMs / 1000)} 秒`)), timeoutMs);
  const undo = onCleanup(() => ac.abort(new Error('被中断')));
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const h = crypto.createHash('sha256'), fd = fs.openSync(part, 'w');
    let n = 0;
    try { for await (const chunk of r.body) { h.update(chunk); fs.writeSync(fd, chunk); n += chunk.length; } } finally { fs.closeSync(fd); }
    return { sha256: h.digest('hex'), bytes: n };
  } catch (e) {
    const cause = e?.cause?.code || e?.cause?.message;
    throw new Error(`${e?.name === 'AbortError' ? (ac.signal.reason?.message || '超时') : e.message}${cause ? `（${cause}）` : ''}`);
  } finally { clearTimeout(timer); undo(); }
}

export const command = defineCommand({
  name: 'fonts:fetch',
  summary: '取得字体锁定清单（fonts/fonts.lock.json）里的完整 OFL 字体到缓存目录，并逐字节核对 sha256',
  usage: ['node tools/fonts/fetch.mjs [--only <id,…>] [--cache <目录>] [--check] [--timeout <秒>] [--json]'],
  description: [
    '字体本体不进 git（决定 D10）：按清单的 urls 依次下载到缓存目录，内容必须与锁定的 sha256、字节数一致；已就绪的跳过。',
    `只用 Node 内置 fetch。${PROXY_HINT}。`,
    '缓存目录：--cache > 环境变量 BEIMING_FONT_CACHE > 清单的 cacheDir（仓库根的 .cache/fonts，已被 git 忽略）；多个检出可以共用一份。',
  ],
  options: {
    only: { type: 'list', split: ',', arg: '<id,…>', describe: '只取这几个 id（默认全部；id 见 fonts/fonts.lock.json）' },
    cache: { type: 'string', arg: '<目录>', describe: '缓存目录' },
    check: { type: 'boolean', describe: '只核对缓存、不联网：缺文件退出 3，哈希不对退出 4' },
    timeout: { type: 'number', arg: '<秒>', min: 1, describe: '每个文件的下载超时，默认 600 秒' },
  },
  examples: ['node tools/fonts/fetch.mjs', 'node tools/fonts/fetch.mjs --only ma-shan-zheng,noto-sans-sc', 'node tools/fonts/fetch.mjs --check --json'],
  exitCodes: { 0: '全部就绪', 2: '用法错误', 3: '缺文件或下载不了（网络、代理）', 4: '清单不合格，或下载到的内容与锁定的 sha256 不符', 130: '被 Ctrl+C 中断，已删掉半截文件' },
  async run(ctx) {
    const { opts } = ctx;
    const lock = loadLock(), dir = cacheDir(lock, opts.cache, ctx.env), label = cacheLabel(dir, { override: opts.cache, env: ctx.env });
    const ids = opts.only.length ? opts.only.map(id => fontById(lock, id).id) : null;
    const before = cacheStatus(lock, dir, ids);
    const outputs = [];
    const fontOut = s => outputs.push({ path: `${label}/${s.file}`, sha256: fontById(lock, s.id).sha256, kind: 'font-source' });
    if (opts.check) {
      for (const s of before) ctx.log.info(`${s.state === 'ok' ? '✓' : s.state === 'missing' ? '缺' : '✗'} ${s.id}  ${s.path}`);
      const mism = before.filter(s => s.state === 'mismatch'), miss = before.filter(s => s.state === 'missing');
      const data = { cache: label, fonts: before.map(({ id, file, state }) => ({ id, file, state })) };
      if (mism.length) throw new CliError('contract.font-sha256', `缓存里的字体与锁定的 sha256 不符：${mism.map(s => s.file).join('、')}`, { hint: `删掉缓存目录 ${label} 里的这些文件后重跑 node tools/fonts/fetch.mjs`, data });
      if (miss.length) throw new CliError('env.fonts-missing', `缓存里缺字体：${miss.map(s => s.file).join('、')}`, { hint: `运行 node tools/fonts/fetch.mjs${ids ? ` --only ${ids.join(',')}` : ''}（要联网，一次即可）`, data });
      before.forEach(fontOut);
      return { data, outputs };
    }
    fs.mkdirSync(dir, { recursive: true });
    const timeoutMs = (opts.timeout ?? 600) * 1000, result = [], failed = [];
    for (const s of before) {
      const f = fontById(lock, s.id);
      if (s.state === 'ok') { ctx.log.info(`✓ ${f.id} 已在缓存`); result.push({ id: f.id, file: f.file, state: 'cached' }); fontOut(s); continue; }
      if (s.state === 'mismatch') { ctx.log.info(`✗ ${f.id} 缓存文件哈希不对，重新下载`); fs.rmSync(s.path, { force: true }); }
      const part = `${s.path}.part-${process.pid}`;
      const undo = ctx.onCleanup(() => fs.rmSync(part, { force: true }));
      const tried = [];
      let done = false;
      for (const url of f.urls) {
        try {
          ctx.log.info(`↓ ${f.id}  ${url}`);
          const got = await download(url, part, timeoutMs, ctx.onCleanup);
          if (got.sha256 !== f.sha256 || got.bytes !== f.bytes) {
            tried.push({ url, wrong: true, why: `内容不符（${got.bytes} 字节，sha256 ${got.sha256.slice(0, 12)}…）` });
            fs.rmSync(part, { force: true });
            continue;
          }
          fs.renameSync(part, s.path);
          done = true;
          break;
        } catch (e) { tried.push({ url, wrong: false, why: e.message }); fs.rmSync(part, { force: true }); }
      }
      undo();
      if (done) { ctx.log.info(`✓ ${f.id} ${f.bytes} 字节，sha256 已核对`); result.push({ id: f.id, file: f.file, state: 'downloaded' }); fontOut(s); }
      else { failed.push({ id: f.id, tried }); result.push({ id: f.id, file: f.file, state: 'failed', tried: tried.map(t => `${t.url}：${t.why}`) }); }
    }
    const data = { cache: label, fonts: result };
    if (failed.length) {
      const detail = failed.map(x => `${x.id}：${x.tried.map(t => `${t.url} ${t.why}`).join(' | ')}`).join('；');
      if (failed.every(x => x.tried.length && x.tried.every(t => t.wrong))) {
        throw new CliError('contract.font-sha256', `下载到的字体与锁定的 sha256 不符：${detail}`, { hint: '镜像内容变了：核实来源后更新 fonts/fonts.lock.json（新版本要重新登记版本号、字节数与 sha256）', data });
      }
      throw new CliError('env.font-download', `有字体没下载成功：${detail}`, { hint: `检查网络；${PROXY_HINT}`, data });
    }
    return { data, outputs };
  },
});

if (isMain(import.meta.url)) await runCli(command);
