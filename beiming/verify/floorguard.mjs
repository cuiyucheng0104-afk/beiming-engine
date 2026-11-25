#!/usr/bin/env node
// 合并门：阈值写死、回归集只许涨。node beiming/verify/floorguard.mjs [--base <基准>] [--repo <目录>]
// 与 merge-base 比四件事（工作区里没提交的改动也查）：
//   1. 受保护的文件（PROTECTED）改了或删了，这个 PR 新追加的签字里必须有一条 from / to 对上改前、改后内容的 sha256；
//   2. 回归集只许加项：merge-base 上的每一项，现在必须原样还在；id 不许重复；
//   3. 签字记录只许追加：merge-base 上的每一条，现在必须原样在原位；
//   4. 第 2 级的数学门：chassis/level2.mjs 里的 GATES 必须和阈值文件的 math.level2 逐项相同。
// 只用 node 内置模块：check-all 从 merge-base 取出基准上的这一份来跑，同一个 PR 改这个文件本身放不了自己的行。
// 基准：--base，否则环境变量 BEIMING_FLOORGATE_BASE（全零的提交号当没给），否则 origin/main。
// 退出码：0 过；4 被拦；3 取不到基准（缺 git、基准解析不出来）；2 用法错误。
// 命令行（--repo、--base）和退出码以后不能改：check-all 会拿新的自己去调基准上旧的这一份。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const THRESHOLDS = 'beiming/verify/floor-gate.json';
export const REGRESS_SET = 'beiming/verify/regress-set.json';
export const SIGNOFFS = 'beiming/verify/signoffs.json';
export const LEVEL2 = 'beiming/sources/core/chassis/level2.mjs';
export const PROTECTED = [THRESHOLDS, 'beiming/sources/core/GATES.md', 'beiming/verify/floorgate.mjs', 'beiming/verify/floorguard.mjs'];
const SIGNOFF_FIELDS = ['path', 'from', 'to', 'change', 'readingsSeen', 'signer', 'review'];

export class GuardError extends Error {
  constructor(exitCode, message) { super(message); this.exitCode = exitCode; }
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
// 只换了换行不算改动：仓库检出一律 LF，本机编辑器存成 CRLF 时不误拦；哈希也照 LF 算，CI 与本机一致
const lf = (text) => text.replace(/\r\n/g, '\n');

function git(root, args, allowFail = false) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (r.error) throw new GuardError(3, `跑不了 git：${r.error.message}`);
  if (r.status !== 0) {
    if (allowFail) return null;
    throw new GuardError(3, `git ${args.join(' ')} 失败：${r.stderr.trim()}（在完整克隆里跑，CI 要 fetch-depth: 0；或用 --base 指一个存在的提交）`);
  }
  return r.stdout;
}

const readJson = (text, where) => {
  try { return JSON.parse(text); } catch (e) { throw new GuardError(4, `${where} 不是合法 JSON：${e.message}`); }
};

export function defaultBase(env = process.env) {
  const b = env.BEIMING_FLOORGATE_BASE?.trim();
  return b && !/^0+$/.test(b) ? b : 'origin/main';
}

/** merge-base 的提交号 */
export function mergeBase(root, base) {
  const top = git(root, ['rev-parse', '--show-toplevel']).trim();
  return { top, mb: git(top, ['merge-base', base, 'HEAD']).trim() };
}

// 从 level2.mjs 的源码里抠出 `export const GATES = { … };` 的数；找不到返回 null（判不过）
export function level2Gates(src) {
  const m = /export const GATES = \{([^}]*)\};/.exec(src ?? '');
  if (!m) return null;
  const out = {};
  for (const part of m[1].split(',')) {
    const kv = /^\s*(\w+)\s*:\s*([-+0-9.eE]+)\s*$/.exec(part);
    if (!kv) return null;
    out[kv[1]] = Number(kv[2]);
  }
  return out;
}

/** 与 base 的 merge-base 比，返回 { base, problems }；problems 空表示过 */
export function guard({ root, base = defaultBase() }) {
  const { top, mb } = mergeBase(root, base);
  // `git cat-file -e` 先判在不在，免得把别的失败当成「基准上没有这个文件」
  const atBase = (p) => (git(top, ['cat-file', '-e', `${mb}:${p}`], true) === null ? null : lf(git(top, ['show', `${mb}:${p}`])));
  const problems = [];
  // 每一级都用 lstat 查：中间的目录换成符号链接，同样判不过（不然挪走真目录、留个链接，基准上的路径就「不在了」）
  const now = (p) => {
    const parts = p.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join('/');
      let st;
      try { st = fs.lstatSync(path.join(top, sub)); } catch { return null; }
      if (st.isSymbolicLink() || (i === parts.length ? !st.isFile() : !st.isDirectory())) {
        problems.push(`${sub} 不是普通${i === parts.length ? '文件' : '目录'}（符号链接或别的东西）`);
        return null;
      }
    }
    return lf(fs.readFileSync(path.join(top, p), 'utf8'));
  };

  const signoffsNow = now(SIGNOFFS);
  const entriesNow = signoffsNow === null ? [] : readJson(signoffsNow, SIGNOFFS).entries ?? [];
  const signoffsBase = atBase(SIGNOFFS);
  const old = signoffsBase === null ? [] : readJson(signoffsBase, `merge-base 上的 ${SIGNOFFS}`).entries ?? [];
  if (signoffsBase !== null && signoffsNow === null) problems.push(`${SIGNOFFS} 被删了：签字记录只许追加`);
  old.forEach((e, i) => {
    if (JSON.stringify(entriesNow[i]) !== JSON.stringify(e)) problems.push(`${SIGNOFFS} 第 ${i + 1} 条被删或被改了：签字记录只许在末尾追加`);
  });
  const fresh = entriesNow.slice(old.length); // 只认这个 PR 新加的签字：旧签字不能拿来重放
  fresh.forEach((e, i) => {
    const empty = SIGNOFF_FIELDS.filter((f) => !(typeof e?.[f] === 'string' && e[f].trim()));
    if (empty.length) problems.push(`${SIGNOFFS} 第 ${old.length + i + 1} 条缺 ${empty.join('、')}`);
  });

  for (const p of PROTECTED) {
    const before = atBase(p);
    if (before === null) continue; // 第一次写进来，不是「改」
    const after = now(p);
    if (after === before) continue;
    const from = sha256(before), to = after === null ? 'deleted' : sha256(after);
    if (!fresh.some((e) => e?.path === p && e.from === from && e.to === to)) {
      problems.push(`${p} 改了，没有对得上的签字：要在 ${SIGNOFFS} 末尾加一条 path=${p}、from=${from}、to=${to}，写明改了什么、改的时候看到了哪些读数、谁签的、复核记录在哪`);
    }
  }

  const setNow = now(REGRESS_SET);
  const itemsNow = setNow === null ? [] : readJson(setNow, REGRESS_SET).items ?? [];
  const ids = itemsNow.map((it) => it?.id);
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) problems.push(`回归集里 ${id} 出现了不止一次`);
  const setBase = atBase(REGRESS_SET);
  if (setBase !== null) {
    if (setNow === null) problems.push(`${REGRESS_SET} 被删了：回归集只许涨`);
    const byId = new Map(itemsNow.map((it) => [it?.id, it]));
    for (const it of readJson(setBase, `merge-base 上的 ${REGRESS_SET}`).items ?? []) {
      if (!byId.has(it.id)) problems.push(`回归集删了 ${it.id}：回归集只许涨`);
      else if (JSON.stringify(byId.get(it.id)) !== JSON.stringify(it)) problems.push(`回归集改了 ${it.id}：已登记的项不许改，要换做法就加一项新的`);
    }
  }

  const thresholdsNow = now(THRESHOLDS);
  if (thresholdsNow !== null) {
    const want = readJson(thresholdsNow, THRESHOLDS).math?.level2;
    const got = level2Gates(now(LEVEL2));
    if (!got) problems.push(`${LEVEL2} 里找不到 \`export const GATES = { … };\`，第 2 级的数学门核对不了`);
    else if (JSON.stringify(Object.entries(got).sort()) !== JSON.stringify(Object.entries(want ?? {}).sort())) {
      problems.push(`${LEVEL2} 的 GATES ${JSON.stringify(got)} 和 ${THRESHOLDS} 的 math.level2 ${JSON.stringify(want)} 不一致：改第 2 级的门要同时改阈值文件并签字`);
    }
  }
  return { base: mb, problems };
}

function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--base' || a === '--repo') && argv[i + 1] !== undefined) opts[a.slice(2)] = argv[++i];
    else if (a === '--help' || a === '-h') { process.stdout.write('用法：node beiming/verify/floorguard.mjs [--base <基准>] [--repo <目录>]\n'); return 0; }
    else { process.stderr.write(`floorguard: 不认识的参数 ${a}\n`); return 2; }
  }
  try {
    const { base, problems } = guard({ root: path.resolve(opts.repo ?? '.'), base: opts.base ?? defaultBase() });
    for (const p of problems) process.stdout.write(`✗ ${p}\n`);
    if (problems.length) {
      process.stdout.write(`合并门拦下 ${problems.length} 处：阈值改动照 beiming/verify/DETAILS.md「噪声地板乘 k」一节补签字；回归集与签字记录的旧项改回原样\n`);
      return 4;
    }
    process.stdout.write(`合并门过：与 ${base.slice(0, 12)} 比，阈值没有未签字的改动，回归集与签字记录只加不减\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof GuardError)) throw e;
    process.stderr.write(`floorguard: ${e.message}\n`);
    return e.exitCode;
  }
}

// 比真实路径：macOS 上 /tmp 是 /private/tmp 的链接，import.meta.url 给的是真实路径
const entry = process.argv[1] && (() => { try { return fs.realpathSync(process.argv[1]); } catch { return null; } })();
if (entry && entry === fs.realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2));
