#!/usr/bin/env node
// 北冥仓库 · AI 生成内容标识（决定 D11）：生成隐式标识、核对成片与底板。规范见 docs/rights/aigc.md。
//   node tools/compliance/aigc.mjs label --id <作品> [--run <run-id>] [--producer <制作方>] [--kinds visual,voice,music] [--tool <名>]…
//       打印要写进 mp4 comment 的隐式标识与对应的 ffmpeg 参数（只打印，不写文件）
//   node tools/compliance/aigc.mjs check <成片.mp4>…        核对成片的 comment 里有合规的隐式标识（只读，调用 ffprobe）
//   node tools/compliance/aigc.mjs plates [<plates.json>…]  逐张列出底板的 C2PA 与来源记录（默认 assets/plates/plates.json）
// 退出码（附录 C1）：0 通过；4 有成片缺隐式标识或标识不合规；2 用法错误；3 找不到 ffprobe 或文件；1 工具自身出错。
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, parseCli, runMain, wantsHelp, UsageError, EnvError } from './lib/cli.mjs';
import { REPO_ROOT } from './lib/scan.mjs';
import { EXPLICIT, implicitLabel, ffmpegMetadataArgs, parseImplicitLabel, readMp4Comment, platesProvenance } from './lib/aigc.mjs';

const HELP = `北冥仓库 · AI 生成内容标识（D11，规范见 docs/rights/aigc.md）
用法：
  node tools/compliance/aigc.mjs label --id <作品> [--run <run-id>] [--producer <制作方>] [--kinds visual,voice,music] [--tool <名>]…
  node tools/compliance/aigc.mjs check <成片.mp4>…
  node tools/compliance/aigc.mjs plates [<plates.json>…]
子命令：
  label    打印隐式标识（写进 mp4 的 comment）与 ffmpeg 参数，不写文件
  check    用 ffprobe 读成片的 comment，核对 AIGC{…} 隐式标识与人读说明
  plates   逐张列出底板有没有 C2PA 清单、有没有来源记录
选项：
  --id <作品>          作品 id（film.json 的 id），label 必填
  --run <run-id>       运行 id（films/<名>/out/<run-id>/ 的目录名），写进 ProduceID
  --producer <名>      制作方，默认「北冥引擎 Beiming Engine」（法律主体待补，见 docs/rights/register.md R12）
  --kinds <列表>       含哪类 AI 生成内容：visual（画面）、voice（配音）、music（配乐），默认 visual
  --tool <名>          生成工具，可写多次，如 --tool "Midjourney V8" --tool "GPT Image 2.5"
  --json               输出附录 C2 的 JSON 信封
  -h, --help           显示本帮助
环境变量：FFPROBE 指定 ffprobe 路径（默认在 PATH 里找）。
退出码：0 通过；4 有成片缺标识或标识不合规；2 用法错误；3 找不到 ffprobe 或文件；1 工具自身出错。
显式标识的固定文字：${Object.values(EXPLICIT).join('、')}（片尾与作品说明里写）。`;

const argv = process.argv.slice(2);
const json = argv.includes('--json');

await runMain('compliance.aigc', async () => {
  if (wantsHelp(argv)) return { exitCode: EXIT.OK, text: HELP };
  const { values, positionals } = parseCli(argv, {
    options: { json: { type: 'boolean' }, id: { type: 'string' }, run: { type: 'string' }, producer: { type: 'string' }, kinds: { type: 'string' },
      tool: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
  });
  const [cmd, ...rest] = positionals;
  if (!cmd) throw new UsageError('缺子命令', '子命令有 label、check、plates；加 --help 查看用法');
  if (!['label', 'check', 'plates'].includes(cmd)) throw new UsageError(`不认识的子命令 ${cmd}`, '子命令有 label、check、plates');

  if (cmd === 'label') {
    if (rest.length) throw new UsageError(`label 不收位置参数：${rest.join(' ')}`);
    if (!values.id) throw new UsageError('label 要写 --id <作品>');
    const kinds = (values.kinds || 'visual').split(',').map(s => s.trim()).filter(Boolean);
    const bad = kinds.filter(k => !EXPLICIT[k]);
    if (bad.length) throw new UsageError(`--kinds 不认识：${bad.join(',')}`, `可选：${Object.keys(EXPLICIT).join('、')}`);
    const opts = { producer: values.producer || '北冥引擎 Beiming Engine', produceId: values.run ? `${values.id}@${values.run}` : values.id, kinds, tools: values.tool || [] };
    const comment = implicitLabel(opts);
    const args = ffmpegMetadataArgs(opts);
    const explicit = kinds.map(k => EXPLICIT[k]);
    return { exitCode: EXIT.OK, result: { comment, ffmpegArgs: args, explicit },
      text: [`隐式标识（mp4 comment）：\n  ${comment}`, `ffmpeg 参数（按数组传给 spawn，不经过 shell）：\n  ${JSON.stringify(args)}`, `显式标识（片尾与作品说明）：${explicit.join('；')}`].join('\n') };
  }

  if (cmd === 'check') {
    if (!rest.length) throw new UsageError('check 要给至少一个成片路径');
    const items = [];
    for (const f of rest) {
      const r = readMp4Comment(f);
      if (r.error && r.error.code === 'env') throw new EnvError(r.error.message, '安装 FFmpeg 7 以上（带 ffprobe），或用 FFPROBE 环境变量指向它；见 npm run env:doctor');
      if (r.error && r.error.code === 'missing') throw new EnvError(r.error.message, '检查路径；成片在 films/<名>/out/<run-id>/ 下');
      if (r.error) { items.push({ file: f, ok: false, problems: [r.error.message] }); continue; }
      const p = parseImplicitLabel(r.comment);
      items.push({ file: f, ok: p.ok, label: p.label, statement: p.statement, problems: p.problems });
    }
    const bad = items.filter(i => !i.ok);
    return {
      exitCode: bad.length ? EXIT.CONTRACT : EXIT.OK,
      error: bad.length ? { code: 'aigc', message: `${bad.length} 个成片的隐式标识缺失或不合规`, hint: '编码时加 node tools/compliance/aigc.mjs label 给出的 ffmpeg 参数；已发布的成片不覆盖（D05），重渲后另发版本' } : null,
      result: { items },
      text: items.map(i => `${i.ok ? '通过' : '不通过'}  ${i.file}${i.ok ? `（Label ${i.label}：${i.statement}）` : `\n  ${i.problems.join('\n  ')}`}`).join('\n'),
    };
  }

  // plates
  const files = rest.length ? rest : [path.join(REPO_ROOT, 'assets/plates/plates.json')];
  const reports = [];
  for (const f of files) {
    if (!fs.existsSync(f)) throw new EnvError(`找不到底板清单：${f}`);
    let man;
    try { man = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { throw new UsageError(`${f} 不是合法 JSON：${e.message}`); }
    reports.push({ manifest: path.relative(process.cwd(), f) || f, ...platesProvenance(man, path.dirname(f)) });
  }
  const L = [];
  for (const r of reports) {
    L.push(`${r.manifest}：清单级来源记录 ${r.record ? `有（字段「${r.record}」）` : '没有'}${r.contains ? '' : '；声明不含 AI 生成内容'}`);
    for (const p of r.plates) L.push(`  ${p.file.padEnd(28)} C2PA ${p.c2pa ? `有（${p.c2pa}）` : '无'}  逐张来源 ${p.record ? `有（「${p.record}」）` : '无'}${p.exists ? '' : '  文件不存在'}`);
  }
  return { exitCode: EXIT.OK, result: { reports }, text: L.join('\n') };
}, { json });
