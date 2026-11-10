#!/usr/bin/env node
// 底板准入检查：按 assets/plates/plates.schema.json 核对登记表，再逐张读 PNG 核对尺寸、透明、色彩配置、四条边的 alpha
// （硬截断、直线淡出）与边策略是否相符，按交付档位算纹素密度（文件像素）与细节密度（原图像素），并核对 AI 底板的来源链。
// 判据与阈值见 tools/plates/lib.mjs 头注释；画内逐帧的露边与密度由 QA 门 node tools/qa/cli.mjs plates 在渲出的画面上复查。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CliError, defineCommand, isMain, runCli } from '../lib/cli.mjs';
import { checkPlates, loadProfiles } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const rel = p => { const r = path.relative(ROOT, path.resolve(p)); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : path.resolve(p); };

export const command = defineCommand({
  name: 'plates:check',
  summary: '底板准入检查：登记字段与来源链 → 文件与尺寸 → 透明与色彩配置 → 四条边对得上 edgePolicy → 纹素密度',
  usage: ['node tools/plates/check.mjs [<plates.json> …] [--only <名字,…>] [--profile <档位,…>] [--quick] [--json]'],
  description: [
    '默认检查 assets/plates/plates.json；作品自带底板时传 films/<名>/plates/plates.json。字段说明见 assets/plates/plates.schema.json，',
    '做底板的配方与六道后处理见 assets/plates/RECIPE.md；AI 生成的底板按 docs/rights/aigc.md 写「来源」（不知道的写「待补」）。',
  ],
  positionals: [{ name: 'files', label: '<plates.json>', describe: '登记表路径，可写多个', required: false, variadic: true }],
  options: {
    only: { type: 'list', split: ',', arg: '<名字,…>', describe: '只查这几张（按 name）' },
    profile: { type: 'list', split: ',', arg: '<档位,…>', describe: '纹素密度按哪些交付档位算（默认全部；档位表 engine/production/profiles.json，缺省用 D07 的表）' },
    quick: { type: 'boolean', describe: '不逐像素读图（只核对字段、文件头与密度），给仓库规范检查用' },
  },
  examples: ['node tools/plates/check.mjs', 'node tools/plates/check.mjs films/my-film/plates/plates.json --profile web-1080p24', 'node tools/plates/check.mjs --only sky_dawn,river --json'],
  exitCodes: { 0: '通过（可以有提示）', 2: '用法错误', 4: '有不合格项' },
  run(ctx) {
    const files = (ctx.args.files.length ? ctx.args.files : [path.join(ROOT, 'assets', 'plates', 'plates.json')]).map(f => path.resolve(f));
    for (const f of files) if (!fs.existsSync(f)) throw new CliError('usage.no-file', `找不到 ${f}`, '给 plates.json 的路径，例如 assets/plates/plates.json');
    const all = loadProfiles(ROOT);
    let profiles = all;
    if (ctx.opts.profile.length) {
      const bad = ctx.opts.profile.filter(p => !all[p]);
      if (bad.length) throw new CliError('usage.bad-profile', `不认识的交付档位：${bad.join('、')}`, `可用：${Object.keys(all).join('、')}`);
      profiles = Object.fromEntries(ctx.opts.profile.map(p => [p, all[p]]));
    }
    const results = files.map(f => checkPlates(f, { decode: !ctx.opts.quick, profiles, only: ctx.opts.only.length ? ctx.opts.only : null }));
    let nErr = 0;
    for (const r of results) {
      ctx.log.info(`${rel(r.file)}：${r.plates.length} 张`);
      for (const p of r.plates) ctx.log.info(`  ${p.errors.length ? '✗' : '✓'} ${p.name}${p.errors.length ? `：${p.errors.join('；')}` : ''}`);
      for (const e of r.errors.filter(e => !r.plates.some(p => e.startsWith(`${p.name}：`)))) ctx.log.info(`  ✗ ${e}`);
      for (const w of r.warnings) ctx.warn('plates.warning', w);
      for (const i of r.info) ctx.log.info(`  · ${i}`);
      nErr += r.errors.length;
    }
    const data = results.map(r => ({ file: rel(r.file), errors: r.errors, warnings: r.warnings, info: r.info, plates: r.plates.map(({ name, errors, warnings, info, edges }) => ({ name, ok: !errors.length, errors, warnings, info, edges })) }));
    if (nErr) throw new CliError('contract.plates', `${nErr} 项不合格`, { hint: '按每张后面的说明改 plates.json 或底板文件；边策略含义见 assets/plates/plates.schema.json', data });
    ctx.out(`✓ ${results.reduce((n, r) => n + r.plates.length, 0)} 张底板通过准入`);
    return { data };
  },
});

if (isMain(import.meta.url)) await runCli(command);
