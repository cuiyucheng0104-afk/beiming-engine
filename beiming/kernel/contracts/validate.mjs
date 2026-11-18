#!/usr/bin/env node
// 契约的可执行校验：把正例和反例真的跑一遍。
// 两层：结构（schema/ 里的 JSON Schema 2020-12，用 ajv 判）加行为（各契约目录里的 check.mjs，
// 每条不变量一个函数，照 CONTRACT.md 第 4 节「怎么查」一栏写）。
// 用法：node beiming/kernel/contracts/validate.mjs [契约目录 …]；不带参数跑本目录下全部契约。
// 退出码 1：正例被拒，或者写了判定函数的不变量没拒掉它的反例、多拒了别的条。还没写判定函数的只计数，不算失败。
import Ajv2020 from 'ajv/dist/2020.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// schema 的 $id 写成相对路径（time/fps.schema.json），装进 ajv 前统一挂到这个基址上
const BASE = 'https://contracts.invalid/';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const contractDirs = (root) => readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'CONTRACT.md')))
  .map((e) => join(root, e.name));

/** 装入全部契约的结构定义和判定函数。返回 { validate(obj), contracts: Map<目录名, {checks, formats}> } */
export async function loadContracts(root = HERE) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const byFormat = new Map(); // 格式标识 → { contract, id }
  const embedded = new Map(); // 契约目录名 → 不带 format 的内嵌值的 schema id
  const contracts = new Map();
  for (const dir of contractDirs(root)) {
    const name = basename(dir);
    const formats = [];
    const schemaDir = join(dir, 'schema');
    for (const f of existsSync(schemaDir) ? readdirSync(schemaDir).filter((n) => n.endsWith('.json')) : []) {
      const schema = readJson(join(schemaDir, f));
      const id = BASE + schema.$id;
      ajv.addSchema({ ...schema, $id: id });
      const format = schema.properties?.format?.const;
      if (typeof format === 'string') {
        byFormat.set(format, { contract: name, id });
        formats.push(format);
      } else {
        embedded.set(name, [...(embedded.get(name) ?? []), id]);
      }
    }
    const checkPath = join(dir, 'check.mjs');
    const checks = existsSync(checkPath) ? (await import(pathToFileURL(checkPath))).checks : {};
    contracts.set(name, { dir, checks, formats });
  }

  /** 判一个顶层对象。schemaErrors：结构上哪里不对；violations：违反了哪几条不变量（只含写了判定函数的）。 */
  function validate(obj, contract) {
    const hit = byFormat.get(obj?.format);
    if (!hit && obj?.format === undefined && embedded.has(contract)) {
      // shortcut: 内嵌值不带 format，例子文件也没写它是哪个对象，这里只要本契约有一份内嵌值的结构定义收它就算过；
      // 等例子目录有了「文件对哪份结构定义」的登记再改成精确对应
      const ok = embedded.get(contract).some((id) => ajv.getSchema(id)(obj));
      return { contract, schemaErrors: ok ? [] : ['本契约里没有一份内嵌值的结构定义收它'], violations: {} };
    }
    if (!hit) return { contract: null, schemaErrors: [`不认识的格式标识：${JSON.stringify(obj?.format)}`], violations: {} };
    const fn = ajv.getSchema(hit.id);
    const schemaErrors = fn(obj) ? [] : fn.errors.map((e) => `${e.instancePath || '/'} ${e.message}`);
    const violations = {};
    for (const [id, check] of Object.entries(contracts.get(hit.contract).checks)) {
      let problems;
      try {
        problems = check(obj);
      } catch (e) {
        problems = [`判定函数出错：${e.message}`]; // 结构已经坏了时判定函数可能读不到字段
      }
      if (problems.length) violations[id] = problems;
    }
    return { contract: hit.contract, schemaErrors, violations };
  }

  return { validate, contracts };
}

/** 跑一份契约的全部正例和反例。返回逐个文件的结果和汇总。 */
export function runContract(loaded, name) {
  const { dir, checks } = loaded.contracts.get(name);
  const rows = [];
  const exDir = join(dir, 'examples');
  for (const f of existsSync(exDir) ? readdirSync(exDir).filter((n) => n.endsWith('.json')).sort() : []) {
    const r = loaded.validate(readJson(join(exDir, f)), name);
    const bad = [...r.schemaErrors, ...Object.entries(r.violations).map(([id, p]) => `${id}：${p[0]}`)];
    rows.push({ kind: 'example', file: f, ok: bad.length === 0, detail: bad });
  }
  const idxPath = join(dir, 'counterexamples', 'index.json');
  for (const entry of existsSync(idxPath) ? readJson(idxPath) : []) {
    const want = entry.violates[0];
    const r = loaded.validate(readJson(join(dir, 'counterexamples', entry.file)), name);
    const got = Object.keys(r.violations);
    const extra = got.filter((id) => id !== want);
    let verdict;
    if (extra.length) verdict = 'wrong'; // 一个反例只该违反一条
    else if (got.includes(want)) verdict = 'by-check';
    else if (want in checks) verdict = 'wrong'; // 写了判定函数却没拒掉
    else if (r.schemaErrors.length) verdict = 'by-schema';
    else verdict = 'unchecked'; // 结构合法，这条还没有判定函数：现在没有任何东西会拒它
    rows.push({
      kind: 'counterexample', file: entry.file, want, verdict, ok: verdict !== 'wrong',
      detail: verdict === 'wrong' ? [`应该只违反 ${want}，实际判出 ${got.join('、') || '没有'}`, ...extra.map((id) => `${id}：${r.violations[id][0]}`)] : r.schemaErrors.slice(0, 1),
    });
  }
  const count = (pred) => rows.filter(pred).length;
  return {
    rows,
    summary: {
      examples: count((r) => r.kind === 'example'),
      examplesBad: count((r) => r.kind === 'example' && !r.ok),
      byCheck: count((r) => r.verdict === 'by-check'),
      bySchema: count((r) => r.verdict === 'by-schema'),
      unchecked: count((r) => r.verdict === 'unchecked'),
      wrong: count((r) => r.verdict === 'wrong'),
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const loaded = await loadContracts();
  const names = process.argv.length > 2 ? process.argv.slice(2).map((d) => basename(d)) : [...loaded.contracts.keys()];
  const total = { examples: 0, examplesBad: 0, byCheck: 0, bySchema: 0, unchecked: 0, wrong: 0 };
  for (const name of names) {
    const { rows, summary: s } = runContract(loaded, name);
    for (const k of Object.keys(total)) total[k] += s[k];
    const failed = s.examplesBad + s.wrong;
    console.log(`${failed ? '✗' : '✓'} ${name}：正例 ${s.examples - s.examplesBad}/${s.examples} 通过；反例 判定函数拒 ${s.byCheck}，只被结构拒 ${s.bySchema}，没人拒 ${s.unchecked}，判错 ${s.wrong}`);
    for (const r of rows.filter((x) => !x.ok)) console.log(`    ${r.file}：${r.detail.join('；')}`);
  }
  console.log(`共 ${names.length} 份契约：正例 ${total.examples - total.examplesBad}/${total.examples} 通过；反例 判定函数拒 ${total.byCheck}，只被结构拒 ${total.bySchema}，没人拒 ${total.unchecked}，判错 ${total.wrong}`);
  process.exit(total.examplesBad + total.wrong ? 1 : 0);
}
