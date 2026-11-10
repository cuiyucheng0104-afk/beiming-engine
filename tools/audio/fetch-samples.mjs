#!/usr/bin/env node
// 北冥仓库 · 取配乐采样库：按 engine/audio/samples.json（两套 CC0 库的固定提交、逐文件地址与哈希）下载到 BEIMING_SAMPLES，逐个校验。
//   node tools/audio/fetch-samples.mjs [--dest <目录>] [--instruments violins,cellos] [--dry-run | --verify-only] [--record] [--json]
// 已经在的文件先校验，对得上就跳过（断点续传以文件为单位）；新文件先写 <文件>.part，校验通过才改名，中断时删掉 .part。
// 校验：字节数 + 上游 git blob SHA-1（清单里总有）+ sha256（清单里有值时）。--record 把首次下载算出的 sha256 写回清单里为 null 的条目。
// 退出码（附录 C1）：0 齐全；2 用法；3 网络或目录不可用、--verify-only 时缺文件；4 内容与固定版本不符；130 / 143 被中断（已清理）。
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, rmSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CliError, EXIT, ROOT, isMain, runCli } from './lib/cli.mjs';

const MANIFEST = path.join(ROOT, 'engine', 'audio', 'samples.json');

const HELP = `北冥仓库 · 取配乐采样库（engine/audio/samples.json 列出的两套 CC0 库）

用法：
  node tools/audio/fetch-samples.mjs [选项]

选项：
  --dest <目录>            下载到哪里（默认 $BEIMING_SAMPLES；没设时用 audio/samples/，《北冥》的 score.py 默认读那里）
  --instruments <a,b>      只取这些乐器（默认全部；名字见清单 instruments 的键）
  --dry-run                只列出要下载的文件数与字节数，不联网、不写盘
  --verify-only            不联网，只校验目标目录里已有的文件（缺文件 exit 3，内容不符 exit 4）
  --record                 下载并校验后，把算出的 sha256 写回清单里为 null 的条目（维护者用；不会覆盖已有的值）
  --mirror <前缀>          把 https://raw.githubusercontent.com/ 换成镜像前缀（也可设 BEIMING_SAMPLES_MIRROR）
  --jobs <n>               并行下载数（默认 4）
  --timeout <秒>           单个文件的超时（默认 300）
  --manifest <文件>        换一份清单（测试用）
  --json                   stdout 只输出一个 JSON 信封（附录 C2）
  --quiet                  不打印进度
  -h, --help               本说明（不联网、不写盘）

约 451 MB、224 个文件（--dry-run 可看各乐器大小）。走代理时设 HTTPS_PROXY 并加 NODE_USE_ENV_PROXY=1（Node 24 的内置 fetch 才会读代理）。
许可：两套库都是 CC0-1.0（Versilian Studios），每个库目录里同时放一份上游 LICENSE；署名写在 audio/CREDITS 与 engine/audio/sampler.py 的 credits()。
退出码：0 齐全；2 用法错误；3 网络 / 目录不可用，或 --verify-only 时缺文件；4 内容与固定版本不符；130 / 143 被中断。
`;

const spec = {
  usage: 'node tools/audio/fetch-samples.mjs [--dest <目录>] [--instruments a,b] [--dry-run|--verify-only] [--record] [--json]',
  positionals: 0,
  options: {
    dest: { type: 'string', arg: '<目录>' }, instruments: { type: 'string', arg: '<a,b>' }, 'dry-run': { type: 'boolean' },
    'verify-only': { type: 'boolean' }, record: { type: 'boolean' }, mirror: { type: 'string', arg: '<前缀>' },
    jobs: { type: 'string', arg: '<n>', default: '4' }, timeout: { type: 'string', arg: '<秒>', default: '300' },
    manifest: { type: 'string', arg: '<文件>' },
  },
};

const gitBlobSha1 = b => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const sha256 = b => createHash('sha256').update(b).digest('hex');
const urlOf = (base, rel, mirror) => {
  const u = base + rel.split('/').map(encodeURIComponent).join('/');
  return mirror ? u.replace(/^https:\/\/raw\.githubusercontent\.com\//, mirror.endsWith('/') ? mirror : mirror + '/') : u;
};

/** 清单 → 逐文件任务 [{ key, rel, url, dest, bytes, gitBlobSha1, sha256, entry }] */
export function plan(manifest, { dest, instruments, mirror }) {
  const libs = Object.fromEntries(manifest.libraries.map(l => [l.id, l]));
  const names = instruments?.length ? instruments : Object.keys(manifest.instruments);
  const unknown = names.filter(n => !manifest.instruments[n]);
  if (unknown.length) throw new CliError('usage.unknown-instrument', `清单里没有乐器：${unknown.join('、')}`, { hint: `可用：${Object.keys(manifest.instruments).join('、')}` });
  const tasks = [];
  for (const lib of new Set(names.map(n => manifest.instruments[n].library))) {
    for (const x of libs[lib].extras ?? []) tasks.push({ key: `${libs[lib].dir}/${x.path}`, rel: x.path, lib: libs[lib], entry: x });
  }
  for (const n of names) {
    const it = manifest.instruments[n];
    for (const f of it.files) tasks.push({ key: `${libs[it.library].dir}/${it.dir}/${f.path}`, rel: `${it.dir}/${f.path}`, lib: libs[it.library], entry: f, instrument: n });
  }
  return tasks.map(t => ({ ...t, url: urlOf(t.lib.rawBase, t.rel, mirror), dest: path.join(dest, ...t.key.split('/')), bytes: t.entry.bytes }));
}

/** 校验一段内容：返回 null（对得上）或一句原因 */
export function verifyBytes(b, entry) {
  if (b.length !== entry.bytes) return `${b.length} 字节，清单是 ${entry.bytes}`;
  if (entry.gitBlobSha1 && gitBlobSha1(b) !== entry.gitBlobSha1) return '内容与上游固定提交不符（git blob SHA-1 不同）';
  if (entry.sha256 && sha256(b) !== entry.sha256) return 'sha256 与清单不符';
  return null;
}

async function fetchOne(t, { timeoutSec, onPart }) {
  const part = `${t.dest}.part`;
  const undo = onPart(part);
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutSec * 1000);
    try {
      const r = await fetch(t.url, { signal: ac.signal, redirect: 'follow' });
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
      const b = Buffer.from(await r.arrayBuffer());
      const bad = verifyBytes(b, t.entry);
      if (bad) { undo(); throw new CliError('contract.sample-mismatch', `${t.key}：下载到的${bad}`, { hint: `地址 ${t.url}；镜像不可信时去掉 --mirror 重试` }); }
      await mkdir(path.dirname(t.dest), { recursive: true });
      await new Promise((resolve, reject) => { const w = createWriteStream(part); w.on('error', reject); w.end(b, resolve); });
      await rename(part, t.dest);
      undo();
      return { sha256: sha256(b), bytes: b.length };
    } catch (e) {
      if (e instanceof CliError) throw e;
      lastErr = e.name === 'AbortError' ? new Error(`超过 ${timeoutSec} 秒`) : e;
      await rm(part, { force: true });
      if (e.status && e.status < 500 && e.status !== 429) break;
      await new Promise(r => setTimeout(r, 1500 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  undo();
  throw new CliError('env.network', `下载失败：${t.key}（${lastErr?.message}）`, { hint: `地址 ${t.url}；检查网络，走代理时设 HTTPS_PROXY 与 NODE_USE_ENV_PROXY=1，或用 --mirror` });
}

async function main(ctx) {
  const o = ctx.opts;
  if (o['dry-run'] && o['verify-only']) throw new CliError('usage.conflict', '--dry-run 不能和 --verify-only 一起用');
  if (o.record && (o['dry-run'] || o['verify-only'])) throw new CliError('usage.conflict', '--record 要真的下载并校验，不能和 --dry-run / --verify-only 一起用');
  const jobs = Number(o.jobs), timeoutSec = Number(o.timeout);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 16) throw new CliError('usage.bad-value', `--jobs 要 1–16 的整数，收到 ${o.jobs}`);
  if (!(timeoutSec > 0)) throw new CliError('usage.bad-value', `--timeout 要正数（秒），收到 ${o.timeout}`);
  const mfile = path.resolve(o.manifest || MANIFEST);
  let manifest;
  try { manifest = JSON.parse(await readFile(mfile, 'utf8')); } catch (e) { throw new CliError('env.manifest', `读不出清单 ${mfile}：${e.message}`, { hint: '它随仓库提供（engine/audio/samples.json），被删改过就从版本库恢复' }); }
  if (manifest.schema !== 'beiming.samples/1') throw new CliError('contract.manifest', `${mfile} 的 schema 是 ${manifest.schema}，应为 beiming.samples/1`);
  const dest = path.resolve(o.dest || process.env.BEIMING_SAMPLES || path.join(ROOT, 'audio', 'samples'));
  const instruments = o.instruments ? o.instruments.split(',').map(s => s.trim()).filter(Boolean) : null;
  const mirror = o.mirror || process.env.BEIMING_SAMPLES_MIRROR || null;
  const tasks = plan(manifest, { dest, instruments, mirror });
  const total = tasks.reduce((s, t) => s + t.bytes, 0);
  const data = { dest, manifest: path.relative(ROOT, mfile).split(path.sep).join('/'), files: tasks.length, bytes: total, downloaded: 0, skipped: 0, recorded: 0, problems: [] };

  if (o['dry-run']) {
    const by = {};
    for (const t of tasks) { const k = t.instrument || `${t.lib.id}（许可文件）`; by[k] = (by[k] || 0) + t.bytes; }
    data.byInstrument = by;
    ctx.out(`将下载到 ${dest}：${tasks.length} 个文件，${(total / 1e6).toFixed(1)} MB（不联网、不写盘）`);
    for (const [k, v] of Object.entries(by)) ctx.out(`  ${k.padEnd(18)} ${(v / 1e6).toFixed(1).padStart(6)} MB`);
    return { data };
  }

  // 先校验已有文件
  const todo = [];
  const shaOf = new Map();
  for (const t of tasks) {
    if (!existsSync(t.dest)) { todo.push(t); continue; }
    const b = await readFile(t.dest);
    const bad = verifyBytes(b, t.entry);
    if (bad) { data.problems.push(`${t.key}：已有文件${bad}`); if (!o['verify-only']) todo.push(t); continue; }
    shaOf.set(t, sha256(b));
    data.skipped++;
  }
  if (o['verify-only']) {
    const missing = todo.filter(t => !existsSync(t.dest));
    data.missing = missing.length;
    const msg = `${dest}：${data.skipped}/${tasks.length} 个文件与固定版本一致，缺 ${missing.length} 个，内容不符 ${data.problems.length} 个`;
    ctx.out(msg);
    for (const p of data.problems.slice(0, 20)) ctx.out(`  ✗ ${p}`);
    if (data.problems.length) return { data, error: { code: 'contract.sample-mismatch', message: msg, hint: '删掉不符的文件后不带 --verify-only 重跑，会重新下载' } };
    if (missing.length) return { data, error: { code: 'env.samples-missing', message: msg, hint: '不带 --verify-only 运行即可下载缺的文件' } };
    return { data };
  }

  if (todo.length) ctx.log(`下载 ${todo.length} 个文件（${(todo.reduce((s, t) => s + t.bytes, 0) / 1e6).toFixed(1)} MB）到 ${dest} …`);
  const parts = new Set();
  ctx.onCleanup(() => { for (const p of parts) { try { rmSync(p, { force: true }); } catch { /* 尽力 */ } } });
  const onPart = p => { parts.add(p); return () => parts.delete(p); };
  let i = 0, done = 0;
  const worker = async () => {
    while (i < todo.length) {
      const t = todo[i++];
      const r = await fetchOne(t, { timeoutSec, onPart });
      shaOf.set(t, r.sha256);
      data.downloaded++;
      if (++done % 20 === 0 || done === todo.length) ctx.log(`  ${done}/${todo.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, todo.length) }, worker));

  if (o.record) {
    for (const [t, h] of shaOf) {
      if (t.entry.sha256 == null) { t.entry.sha256 = h; data.recorded++; } else if (t.entry.sha256 !== h) data.problems.push(`${t.key}：sha256 与清单已有的值不符`);
    }
    if (data.recorded) {
      const tmp = `${mfile}.tmp`;
      await writeFile(tmp, JSON.stringify(manifest, null, 1) + '\n', 'utf8');
      await rename(tmp, mfile);
    }
  }
  const msg = `${dest}：${tasks.length} 个文件齐全（新下载 ${data.downloaded}，已有并校验通过 ${data.skipped}${o.record ? `，写回 sha256 ${data.recorded} 条` : ''}）`;
  ctx.out(msg);
  if (data.problems.length) return { data, error: { code: 'contract.sample-mismatch', message: `${data.problems.length} 处与固定版本不符：${data.problems.slice(0, 3).join('；')}` } };
  if (!process.env.BEIMING_SAMPLES || path.resolve(process.env.BEIMING_SAMPLES) !== dest) ctx.log(`提示：配乐重渲（sh audio/build.sh --score）读 BEIMING_SAMPLES；默认位置 audio/samples/ 不用设`);
  return { data, outputs: [{ path: dest, kind: 'directory' }] };
}

if (isMain(import.meta.url)) await runCli({ command: 'audio:fetch-samples', help: HELP, spec, run: main });

export { main, MANIFEST };
