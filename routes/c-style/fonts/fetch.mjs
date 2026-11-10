#!/usr/bin/env node
// C 路线 · 片名字体（马善政毛笔楷书，SIL OFL 1.1）的分片：生成与核对。
//   node routes/c-style/fonts/fetch.mjs --check     离线核对（默认就是它）：每片的 sha256、大小、cmap 正好覆盖清单里的码位，OFL.txt 在
//   node routes/c-style/fonts/fetch.mjs --fetch     联网重新生成：取固定提交的原始 TTF（校验 sha256）→ 读 cmap → 按码位排序切成若干片
//                                                    → 每片用 Google Fonts CSS2 API 的 &text= 取官方子集（woff2）→ 核对覆盖 → 写文件与 fonts.json
// 为什么分片：完整字体 7015 个字（GB 2312 的 6763 个汉字全在）约 3.5 MB；按码位区间切成 13 片、每片带 unicode-range，
//   页面只加载片名与印文真正用到的那几片（document.fonts.load 按 unicode-range 取），也不超过 D10 的单文件上限。
// 为什么用 Google Fonts 的子集服务：仓库 fonts/ 下现有子集也是这样取的（fonts/LICENSE.md），不需要在本机装 fontTools；
//   生成物的来源、原始字体的固定提交与 sha256 都记在 fonts.json。
// 退出码（docs/CLI.md）：0 通过；2 用法错误；3 缺文件或联网失败；4 核对不通过。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CliError, defineCommand, isMain, runCli } from '../../../tools/lib/cli.mjs';
import { parseFont } from '../../../tools/qa/lib/font.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
export const MANIFEST = 'routes/c-style/fonts/fonts.json';
const SOURCE = {
  family: 'Ma Shan Zheng',
  url: 'https://raw.githubusercontent.com/google/fonts/406197b91ff39a93061c2c2eeaee67ddf2ae1f0d/ofl/mashanzheng/MaShanZheng-Regular.ttf',
  sha256: '6d2546bb189c732a8ca29af9e22457b152387d158aa459e4ac2ce1e51788b7fb',
  license: 'https://raw.githubusercontent.com/google/fonts/406197b91ff39a93061c2c2eeaee67ddf2ae1f0d/ofl/mashanzheng/OFL.txt',
};
const PER_CHUNK = 540;          // 每片字数：&text= 的地址再长 Google 会拒绝（实测 600 字约 5.5 KB 可用、1000 字不行）
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const hex = cp => cp.toString(16).toUpperCase().padStart(4, '0');
const toRange = list => `U+${hex(list[0])}-${hex(list.at(-1))}`;

/** 把排好序的码位列表压成区间串，"20-7E,A0-FF,..."（十六进制），清单里记它，核对时展开 */
export function packCodepoints(cps) {
  const out = [];
  for (let i = 0; i < cps.length;) {
    let j = i;
    while (j + 1 < cps.length && cps[j + 1] === cps[j] + 1) j++;
    out.push(i === j ? hex(cps[i]) : `${hex(cps[i])}-${hex(cps[j])}`);
    i = j + 1;
  }
  return out.join(',');
}
export function unpackCodepoints(s) {
  const out = [];
  for (const part of String(s).split(',').filter(Boolean)) {
    const [a, b = a] = part.split('-').map(x => parseInt(x, 16));
    for (let c = a; c <= b; c++) out.push(c);
  }
  return out;
}

/** 离线核对：返回问题列表（空 = 通过）。repo-check 的 route-c.fonts 规则也调它。 */
export function verifyFonts(root = ROOT) {
  const problems = [];
  const mf = path.join(root, MANIFEST);
  if (!fs.existsSync(mf)) return [`缺少 ${MANIFEST}`];
  let m;
  try { m = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch (e) { return [`${MANIFEST} 不是合法 JSON（${e.message}）`]; }
  const dir = path.dirname(mf);
  if (!fs.existsSync(path.join(dir, 'OFL.txt'))) problems.push('routes/c-style/fonts/OFL.txt 缺失：OFL 字体随作品分发时必须附许可全文');
  if (!Array.isArray(m.chunks) || !m.chunks.length) return [...problems, `${MANIFEST} 没有 chunks`];
  let total = 0, prevHi = -1;
  for (const c of m.chunks) {
    const f = path.join(dir, c.file);
    if (!fs.existsSync(f)) { problems.push(`缺少分片 ${c.file}`); continue; }
    const buf = fs.readFileSync(f);
    if (buf.length !== c.size) problems.push(`${c.file} 大小 ${buf.length}，清单写 ${c.size}`);
    if (sha256(buf) !== c.sha256) problems.push(`${c.file} 的 sha256 与清单不符（被改过或换过）`);
    const want = unpackCodepoints(c.codepoints);
    total += want.length;
    let have;
    try { have = parseFont(buf).cps; } catch (e) { problems.push(`${c.file} 解析不了（${e.message}）`); continue; }
    const lack = want.filter(cp => !have.has(cp));
    if (lack.length) problems.push(`${c.file} 少了 ${lack.length} 个字（如 U+${hex(lack[0])}）`);
    const [lo, hi] = c.unicodeRange.replace(/^U\+/, '').split('-').map(x => parseInt(x, 16));
    if (!(lo <= want[0] && want.at(-1) <= hi)) problems.push(`${c.file} 的 unicode-range ${c.unicodeRange} 没盖住它自己的码位`);
    if (lo <= prevHi) problems.push(`${c.file} 的 unicode-range 与上一片重叠`);
    prevHi = hi;
  }
  if (m.codepointCount !== total) problems.push(`清单 codepointCount = ${m.codepointCount}，各片合计 ${total}`);
  return problems;
}

async function get(url, what) {
  let r;
  try { r = await fetch(url, { headers: { 'User-Agent': UA } }); } catch (e) {
    throw new CliError('env.network', `下载${what}失败（${e.cause?.code ?? e.message}）`, '检查网络或代理后重跑；只核对现有文件用 --check（不联网）');
  }
  if (!r.ok) throw new CliError('env.network', `下载${what}失败：HTTP ${r.status}`, '换个时间重试；Google Fonts 改了接口就按 README 的说明改本脚本');
  return Buffer.from(await r.arrayBuffer());
}

async function regenerate(ctx) {
  const ttf = await get(SOURCE.url, '原始字体');
  if (sha256(ttf) !== SOURCE.sha256) throw new CliError('contract.source', '原始字体的 sha256 与固定值不同', '上游在这个固定提交下的文件不该变：先查清原因，不要直接改 SOURCE.sha256');
  const ofl = await get(SOURCE.license, 'OFL 许可文本');
  const cps = [...parseFont(ttf).cps].filter(c => c >= 0x20).sort((a, b) => a - b);
  const groups = [];
  for (let i = 0; i < cps.length; i += PER_CHUNK) groups.push(cps.slice(i, i + PER_CHUNK));
  const dir = path.join(ROOT, path.dirname(MANIFEST));
  const chunks = [];
  for (const [i, g] of groups.entries()) {
    const text = String.fromCodePoint(...g);
    const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(SOURCE.family).replace(/%20/g, '+')}&text=${encodeURIComponent(text)}`;
    const css = (await get(cssUrl, `第 ${i} 片的 CSS`)).toString('utf8');
    const m = /src:\s*url\((https:[^)]+)\)\s*format\('woff2'\)/.exec(css);
    if (!m) throw new CliError('contract.service', `第 ${i} 片：Google Fonts 没有返回 woff2`, '接口变了：看返回的 CSS，按 README 改本脚本');
    const buf = await get(m[1], `第 ${i} 片`);
    const have = parseFont(buf).cps, lack = g.filter(cp => !have.has(cp));
    if (lack.length) throw new CliError('contract.service', `第 ${i} 片少了 ${lack.length} 个字（如 U+${hex(lack[0])}）`, '服务端子集不完整：缩小 PER_CHUNK 重跑');
    const file = `mashanzheng-${String(i).padStart(2, '0')}.woff2`;
    fs.writeFileSync(path.join(dir, file), buf);
    chunks.push({ file, unicodeRange: toRange(g), count: g.length, size: buf.length, sha256: sha256(buf), codepoints: packCodepoints(g) });
    ctx.log.info(`  ${file}  ${toRange(g)}  ${g.length} 字  ${(buf.length / 1024).toFixed(0)} KB`);
  }
  fs.writeFileSync(path.join(dir, 'OFL.txt'), ofl);
  const manifest = {
    schemaVersion: 1,
    about: 'C 路线片名字体：马善政毛笔楷书全部字符（含 GB 2312 的 6763 个汉字），按码位区间分片，每片配 unicode-range；由 node routes/c-style/fonts/fetch.mjs --fetch 生成，不要手改',
    family: SOURCE.family, cssFamily: 'BM Brush', weight: 400, style: 'normal',
    license: 'OFL-1.1', licenseFile: 'routes/c-style/fonts/OFL.txt',
    copyright: 'Copyright 2018 The Ma Shan Zheng Project Authors (https://github.com/googlefonts/mashanzheng)',
    reservedFontName: null,
    source: { ...SOURCE, method: `原始 TTF 的 cmap 按码位排序，每 ${PER_CHUNK} 个字一片，每片用 Google Fonts CSS2 API 的 &text= 取官方子集（woff2）` },
    codepointCount: cps.length,
    chunks,
  };
  fs.writeFileSync(path.join(ROOT, MANIFEST), JSON.stringify(manifest, null, 1) + '\n');
  return { manifest };
}

const cmd = defineCommand({
  name: 'c-fonts',
  summary: 'C 路线片名字体（马善政毛笔楷书分片）的离线核对与联网重新生成',
  usage: ['node routes/c-style/fonts/fetch.mjs [--check | --fetch] [--json]'],
  options: {
    check: { type: 'boolean', describe: '离线核对现有分片（默认）' },
    fetch: { type: 'boolean', describe: '联网重新生成分片与 fonts.json（会覆盖现有文件）' },
  },
  exitCodes: { 0: '通过', 2: '用法错误', 3: '缺文件或联网失败', 4: '核对不通过' },
  examples: ['node routes/c-style/fonts/fetch.mjs --check --json'],
  async run(ctx) {
    if (ctx.opts.check && ctx.opts.fetch) throw new CliError('usage.conflict', '--check 与 --fetch 只能选一个', '只核对用 --check；重新生成用 --fetch');
    if (ctx.opts.fetch) {
      const { manifest } = await regenerate(ctx);
      const problems = verifyFonts();
      if (problems.length) throw new CliError('contract.fonts', `生成后核对不通过：${problems.join('；')}`, null);
      ctx.out(`已生成 ${manifest.chunks.length} 片，共 ${manifest.codepointCount} 个字`);
      return { data: { chunks: manifest.chunks.length, codepoints: manifest.codepointCount }, outputs: manifest.chunks.map(c => ({ path: `routes/c-style/fonts/${c.file}`, sha256: c.sha256, kind: 'font' })) };
    }
    const problems = verifyFonts();
    if (problems.length) {
      const env = problems.some(p => /^缺少/.test(p));
      throw new CliError(env ? 'env.missing' : 'contract.fonts', `片名字体核对不通过：${problems.join('；')}`, env ? '完整检出仓库；或联网重新生成：node routes/c-style/fonts/fetch.mjs --fetch' : '不要手改分片；需要更新就 --fetch 重新生成并提交');
    }
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST), 'utf8'));
    ctx.out(`片名字体核对通过：${m.chunks.length} 片、${m.codepointCount} 个字（${m.family}，${m.license}）`);
    return { data: { chunks: m.chunks.length, codepoints: m.codepointCount } };
  },
});

if (isMain(import.meta.url)) runCli(cmd);
