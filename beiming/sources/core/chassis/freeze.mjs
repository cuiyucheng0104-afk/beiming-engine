#!/usr/bin/env node
// 北冥 · 核心帧源内核四样内部结构（材质记录、光线负载、随机维度、输出通道）的冻结检查。
//   node beiming/sources/core/chassis/freeze.mjs            冻结标记在、且与代码一致：退出 0；否则 4
//   node beiming/sources/core/chassis/freeze.mjs --update   按现在的代码重写标记里钉住的值（有意改了结构之后用）
// 冻结标记是 ../path/FREEZE.json，条文是 ../path/STRUCTURES.md。标记里按文件钉住三类东西，这里从着色器源码重算了比：
//   structs    结构的定义：去掉注释与空白之后的 sha256（改注释、改排版不算改结构）
//   constants  具名常数：类型与数值的原文
//   functions  函数的签名原文（参数表与返回类型）
// 另有 families：名字以这些前缀开头的常数是登记过的编号，着色器里声明了而标记里没有就算不一致（加了号没登记）。
// 这一条扫的是内核 shaders/ 下的全部着色器，加共用目录里编进内核的那五个（build.mjs 的 SHADERS）：标记没有钉住的
// 文件里声明了这类常数，同样算不一致。声明怎么写都认：不写类型的（const X = 1u;）、前面带属性的（@if(…) const X…）、
// 一行里第二个、函数里面的；注释里的不算。
// 改了结构而没更新标记，这里不过；更新标记是一次看得见的改动（--update 之后标记的差异进提交），同时要改条文里对应的
// 字段表或登记表，并在标记里升版本号。规矩见条文「改动的规矩」一节。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineCommand, isMain, runCli } from '../../../../tools/lib/cli.mjs';
import { SHADERS } from './build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const KERNEL = path.join(HERE, '..', 'path');
export const MARKER = path.join(KERNEL, 'FREEZE.json');
export const SCHEMA = 'beiming.core.freeze/1';
export const STRUCTURES = ['材质记录', '光线负载', '随机维度', '输出通道'];
const KINDS = ['structs', 'constants', 'functions'];

const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const squeeze = s => s.replace(/\s+/g, ' ').trim();
const sha256 = s => createHash('sha256').update(s).digest('hex');

/** 源码里一个结构、常数或函数现在的「钉住值」；找不到返回 null。`src` 是着色器源码全文 */
export function pinOf(src, kind, name) {
  const code = stripComments(src);
  if (kind === 'structs') {
    const m = new RegExp(`\\bstruct\\s+${name}\\s*\\{([^}]*)\\}`).exec(code);
    return m && sha256(m[1].replace(/\s+/g, '').replace(/,$/, ''));
  }
  if (kind === 'constants') {
    // 钉住值是冒号后面的原文；不写类型的声明没有冒号，从等号起算
    const m = new RegExp(`\\bconst\\s+${name}\\s*(?::\\s*|(?==))([^;]+);`).exec(code);
    return m && squeeze(m[1]);
  }
  const m = new RegExp(`\\bfn\\s+${name}\\s*\\(([^)]*)\\)\\s*(->[^{]*)?\\{`).exec(code);
  return m && squeeze(`(${squeeze(m[1])}) ${m[2] ?? ''}`);
}

/** 源码里名字以 `prefixes` 之一开头的常数。const 是着色语言的保留字，去掉注释之后「const 名字 冒号或等号」只能是声明 */
export function familyConstants(src, prefixes) {
  return [...stripComments(src).matchAll(/\bconst\s+([A-Za-z_][A-Za-z0-9_]*)\s*[:=]/g)].map(m => m[1]).filter(n => prefixes.some(p => n.startsWith(p)));
}

/** 登记类编号要扫的文件（相对内核目录 `dir`）：shaders/ 下的全部着色器，加共用目录里编进内核的五个 */
export function scanFiles(dir) {
  return [...fs.readdirSync(path.join(dir, 'shaders')).filter(f => f.endsWith('.wgsl')).sort().map(f => `shaders/${f}`), ...SHADERS.map(f => `../shaders/${f}`)];
}

/**
 * 标记与代码比。`marker`：解析后的标记；`read(file)`：读内核目录下的一个文件，没有时返回 null；`scan`：除了标记钉住的
 * 文件之外还要扫登记类编号的文件。返回不一致的地方（空数组就是一致）。
 */
export function check(marker, read, scan = []) {
  const problems = [];
  const bad = m => { problems.push(m); };
  if (!marker || typeof marker !== 'object') return ['冻结标记不是一个 JSON 对象'];
  if (marker.schema !== SCHEMA) bad(`schema 应当是 ${SCHEMA}`);
  if (!/^\d+\.\d+\.\d+$/.test(marker.version ?? '')) bad('version 应当是 主.次.修 三段数字');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(marker.frozen ?? '')) bad('frozen 应当是 年-月-日');
  if (JSON.stringify(marker.structures) !== JSON.stringify(STRUCTURES)) bad(`structures 应当是 ${STRUCTURES.join('、')}`);
  if (!Array.isArray(marker.rules) || !marker.rules.length || marker.rules.some(r => typeof r !== 'string' || !r)) bad('rules 应当是一组非空的文字');
  for (const k of ['text', 'registry']) {
    const file = String(marker[k] ?? '').split('#')[0];
    if (!file || read(file) === null) bad(`${k} 指的文件不在：${marker[k]}`);
  }
  const families = Array.isArray(marker.families) ? marker.families : [];
  if (!families.length) bad('families 是空的');
  const pinned = marker.pinned && typeof marker.pinned === 'object' ? marker.pinned : {};
  if (!Object.keys(pinned).length) bad('pinned 是空的：标记没有钉住任何定义');
  for (const [file, kinds] of Object.entries(pinned)) {
    const src = read(file);
    if (src === null) { bad(`${file}：文件不在`); continue; }
    for (const kind of Object.keys(kinds)) if (!KINDS.includes(kind)) bad(`${file}：不认识的类别 ${kind}`);
    for (const kind of KINDS) for (const [name, want] of Object.entries(kinds[kind] ?? {})) {
      const now = pinOf(src, kind, name);
      if (now === null) bad(`${file} 的 ${kind} ${name}：源码里找不到了`);
      else if (now !== want) bad(`${file} 的 ${kind} ${name}：与标记不一致（标记 ${want}，现在 ${now}）`);
    }
  }
  for (const file of new Set([...Object.keys(pinned), ...scan])) {
    const src = read(file);
    if (src === null) { if (!(file in pinned)) bad(`${file}：文件不在`); continue; }
    for (const name of familyConstants(src, families)) if (!(name in (pinned[file]?.constants ?? {}))) bad(`${file} 的常数 ${name}：是登记类的编号，标记里没有`);
  }
  return problems;
}

/** 按现在的代码重算标记里钉住的值（登记类的常数新声明的补进去）；找不到的名字原样留着，由 check 报出来 */
export function refresh(marker, read, scan = []) {
  const out = JSON.parse(JSON.stringify(marker));
  // 标记还没钉住、却声明了登记类常数的文件：先给它开一项
  for (const file of scan) if (!(file in (out.pinned ??= {})) && familyConstants(read(file) ?? '', out.families ?? []).length) out.pinned[file] = {};
  for (const [file, kinds] of Object.entries(out.pinned ?? {})) {
    const src = read(file);
    if (src === null) continue;
    kinds.constants ??= {};
    for (const name of familyConstants(src, out.families ?? [])) kinds.constants[name] ??= '';
    for (const kind of KINDS) for (const name of Object.keys(kinds[kind] ?? {})) kinds[kind][name] = pinOf(src, kind, name) ?? kinds[kind][name];
  }
  return out;
}

const readFrom = dir => file => { try { return fs.readFileSync(path.join(dir, file), 'utf8'); } catch { return null; } };

export const command = defineCommand({
  name: 'core-freeze',
  summary: '核心帧源内核四样内部结构的冻结检查：冻结标记在、且与着色器里的定义一致',
  usage: ['node beiming/sources/core/chassis/freeze.mjs', 'node beiming/sources/core/chassis/freeze.mjs --update'],
  options: {
    marker: { type: 'string', arg: '<文件>', describe: '冻结标记的路径（默认 ../path/FREEZE.json）；它钉住的文件相对它所在的目录找' },
    update: { type: 'boolean', describe: '按现在的代码重写标记里钉住的值。之后要改条文、升标记里的版本号，并把标记的差异一起提交' },
  },
  exitCodes: { 0: '标记在，且与代码一致', 2: '用法错误', 4: '没有标记、标记读不了，或与代码不一致' },
  async run(ctx) {
    const file = path.resolve(ctx.opts.marker ?? MARKER);
    const read = readFrom(path.dirname(file));
    const fail = (message, hint) => ({ error: { code: 'contract.core-freeze', message, hint } });
    let marker;
    try { marker = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fail(`读不了冻结标记 ${file}：${e.message}`, '标记是 beiming/sources/core/path/FREEZE.json'); }
    const scan = scanFiles(path.dirname(file));
    if (ctx.opts.update) {
      marker = refresh(marker, read, scan);
      fs.writeFileSync(file, `${JSON.stringify(marker, null, 2)}\n`);
      ctx.out(`已按现在的代码重写 ${file}`);
    }
    const problems = check(marker, read, scan);
    for (const p of problems) ctx.out(`✗ ${p}`);
    if (problems.length) return { data: { marker: file, problems }, ...fail(`冻结标记与代码有 ${problems.length} 处不一致`, '无意的改动：改回去。有意的改动：照条文「改动的规矩」办，改条文与登记表、升版本号，再运行 freeze.mjs --update') };
    const count = Object.values(marker.pinned).reduce((n, kinds) => n + KINDS.reduce((k, kind) => k + Object.keys(kinds[kind] ?? {}).length, 0), 0);
    ctx.out(`冻结标记 ${marker.version}（${marker.frozen}）与代码一致：钉住的 ${count} 处定义都没变`);
    return { data: { marker: file, version: marker.version, frozen: marker.frozen, pinned: count } };
  },
});

if (isMain(import.meta.url)) await runCli(command);
