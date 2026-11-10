#!/usr/bin/env node
// 底板准入检查：按 assets/plates/plates.schema.json 核对登记表，再逐张读 PNG 核对尺寸、透明、色彩配置、四条边的 alpha
// （硬截断、直线淡出）与边策略是否相符，并按交付档位算纹素密度。判据与阈值见 tools/plates/lib.mjs 头注释。
// 退出码：0 通过（可以有提示）；2 用法错误；4 有不合格项（附录 C1）。--json 输出附录 C2 信封，data 里是逐张结果。
import path from 'node:path';
import fs from 'node:fs';
import { runCli, CliError, EXIT, ROOT, rel } from '../lookdev/lib/cli.mjs';
import { checkPlates, loadProfiles } from './lib.mjs';

const USAGE = `
用法：node tools/plates/check.mjs [<plates.json> ...] [--only <名字,...>] [--profile <档位,...>] [--quick] [--json]
  底板准入检查。默认检查 assets/plates/plates.json；作品自带底板时传 films/<名>/plates/plates.json。
  每张底板：字段（schema）→ 文件与尺寸 → 透明与色彩配置 → 四条边（硬截断、直线淡出）对得上 edgePolicy → 纹素密度。
  --only     只查这几张（按 name）
  --profile  纹素密度按哪些交付档位算（默认全部档位；档位表见 engine/production/profiles.json，缺省用决定 D07 的表）
  --quick    不逐像素读图（只核对字段、文件头与密度），给仓库规范检查用
  --json     stdout 只输出一个 JSON 对象
退出码：0 通过；2 用法错误；4 有不合格项。
`;

await runCli({
  command: 'plates:check',
  usage: USAGE,
  spec: { only: 'list', profile: 'list', quick: 'bool' },
  async main({ opts, args, log, warn }) {
    const files = (args.length ? args : [path.join(ROOT, 'assets', 'plates', 'plates.json')]).map(f => path.resolve(f));
    for (const f of files) if (!fs.existsSync(f)) throw new CliError(EXIT.USAGE, 'no-file', `找不到 ${f}`, '给 plates.json 的路径，例如 assets/plates/plates.json');
    const all = loadProfiles(ROOT);
    let profiles = all;
    if (opts.profile.length) {
      const bad = opts.profile.filter(p => !all[p]);
      if (bad.length) throw new CliError(EXIT.USAGE, 'bad-profile', `不认识的交付档位：${bad.join('、')}`, `可用：${Object.keys(all).join('、')}`);
      profiles = Object.fromEntries(opts.profile.map(p => [p, all[p]]));
    }
    const results = files.map(f => checkPlates(f, { decode: !opts.quick, profiles, only: opts.only.length ? opts.only : null }));
    let nErr = 0;
    for (const r of results) {
      log(`${rel(r.file)}：${r.plates.length} 张`);
      for (const p of r.plates) log(`  ${p.errors.length ? '✗' : '✓'} ${p.name}${p.errors.length ? `：${p.errors.join('；')}` : ''}`);
      for (const w of r.warnings) warn(w);
      for (const e of r.errors.filter(e => !r.plates.some(p => e.startsWith(`${p.name}：`)))) log(`  ✗ ${e}`);
      nErr += r.errors.length;
    }
    const data = results.map(r => ({ file: rel(r.file), errors: r.errors, warnings: r.warnings, plates: r.plates.map(({ name, errors, warnings, edges }) => ({ name, ok: !errors.length, errors, warnings, edges })) }));
    if (nErr) throw Object.assign(new CliError(EXIT.CONTRACT, 'plates-invalid', `${nErr} 项不合格`, '按每张后面的说明改 plates.json 或底板文件；边策略含义见 assets/plates/plates.schema.json'), { data });
    return data;
  },
});
