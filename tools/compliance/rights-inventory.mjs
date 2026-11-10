#!/usr/bin/env node
// 北冥仓库 · 授权登记册生成与核对：docs/rights/register.json + cases/catalog.json → docs/rights/register.md
//   node tools/compliance/rights-inventory.mjs                 打印各类受影响的案例、Release 附件与预览（只读）
//   node tools/compliance/rights-inventory.mjs --check         核对 register.md 是否最新、客户与 IP 作品是否全部登记（只读）
//   node tools/compliance/rights-inventory.mjs --write         重新生成 docs/rights/register.md（唯一会写文件的用法）
//   node tools/compliance/rights-inventory.mjs --json [--release-json <gh release view 的输出>]
// --release-json：传入 `gh release view casebook-2026.11 --json assets` 存下的文件，核对 Release 上的每个附件都能在目录里找到归属。
// 退出码（附录 C1）：0 通过；4 登记册过期、漏登或 Release 附件对不上；2 用法错误；3 读不到登记册或案例目录；1 工具自身出错。
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EXIT, parseCli, runMain, wantsHelp, EnvError, UsageError } from './lib/cli.mjs';
import { REPO_ROOT } from './lib/scan.mjs';
import { REGISTER_MD, loadCatalog, loadRegister, computeInventory, renderRegister, rightsReport } from './lib/rights.mjs';

const HELP = `北冥仓库 · 授权登记册（docs/rights/register.md）生成与核对
用法：node tools/compliance/rights-inventory.mjs [--check | --write] [--json] [--root <目录>] [--release-json <文件>]
  （无参数）           打印每一类受影响的案例、Release 附件、预览与海报，不写文件
  --check              核对 register.md 与 register.json、cases/catalog.json 一致，客户与 IP 作品、参考图全部登记
  --write              重新生成 docs/rights/register.md
  --release-json <f>   核对 Release 附件清单（gh release view <标签> --json assets 的输出）
  --json               输出附录 C2 的 JSON 信封
  -h, --help           显示本帮助
退出码：0 通过；4 过期、漏登或附件对不上；2 用法错误；3 读不到登记册或案例目录；1 工具自身出错。`;

const argv = process.argv.slice(2);
const json = argv.includes('--json');

await runMain('compliance.rights-inventory', async () => {
  if (wantsHelp(argv)) return { exitCode: EXIT.OK, text: HELP };
  const { values } = parseCli(argv, { options: { json: { type: 'boolean' }, check: { type: 'boolean' }, write: { type: 'boolean' },
    root: { type: 'string' }, 'release-json': { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (values.check && values.write) throw new UsageError('--check 与 --write 只能二选一');
  const root = values.root ? path.resolve(values.root) : REPO_ROOT;
  let reg, cat;
  try { reg = loadRegister(root); cat = loadCatalog(root); } catch (e) { throw new EnvError(e.message, '在仓库根目录运行，或用 --root 指过去'); }
  const inv = computeInventory(reg, cat, { root });
  const md = renderRegister(reg, inv);
  const outputs = [], problems = [];
  if (values.write) {
    const file = path.join(root, REGISTER_MD);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, md);
    outputs.push({ path: REGISTER_MD, sha256: crypto.createHash('sha256').update(md).digest('hex'), kind: 'doc' });
  }
  if (values.check || values.write) {
    const rep = rightsReport({ root });
    problems.push(...rep.problems);
  }
  if (values['release-json']) {
    let rel;
    try { rel = JSON.parse(fs.readFileSync(values['release-json'], 'utf8')); } catch (e) { throw new EnvError(`读不了 --release-json：${e.message}`, '先运行 gh release view casebook-2026.11 --json assets > 文件'); }
    const known = new Set([...cat.packs.map(p => p.filename), ...cat.cases.map(c => c.preview && c.preview.filename).filter(Boolean), 'SHA256SUMS.txt']);
    for (const a of rel.assets || []) if (!known.has(a.name)) problems.push({ level: 'error', file: values['release-json'], message: `Release 附件 ${a.name} 在案例目录里找不到归属`, hint: '在 cases/catalog.json 登记它，或确认它该不该留在 Release 上' });
  }
  const blocking = problems.filter(p => p.level === 'error');
  const L = [];
  if (values.write) L.push(`已写入 ${REGISTER_MD}`);
  for (const c of reg.categories) {
    const iv = inv.categories.find(x => x.id === c.id);
    if (!iv || !iv.matched) { L.push(`${c.id} ${c.title}：不按案例计算（见登记册正文）`); continue; }
    L.push(`${c.id} ${c.title}`);
    L.push(`  案例 ${iv.cases.length}：${iv.cases.map(k => k.id).join(' ') || '无'}`);
    L.push(`  Release 附件 ${iv.packs.length}：${iv.packs.join(' ') || '无'}；预览 ${iv.previews.length}；仓库海报 ${iv.posters.length}；归档源文件 ${iv.gitFiles.length}`);
  }
  for (const p of problems) L.push(`${p.level === 'error' ? '阻断' : '提示'}：${p.message}${p.hint ? `\n  下一步：${p.hint}` : ''}`);
  if (values.check) L.push(blocking.length ? `核对未通过：${blocking.length} 处` : '核对通过');
  return {
    exitCode: blocking.length ? EXIT.CONTRACT : EXIT.OK,
    error: blocking.length ? { code: 'rights', message: blocking[0].message, hint: blocking[0].hint } : null,
    outputs,
    warnings: problems.filter(p => p.level !== 'error').map(p => p.message),
    result: { problems, inventory: inv },
    text: L.join('\n'),
  };
}, { json });
