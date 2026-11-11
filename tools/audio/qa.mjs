#!/usr/bin/env node
// 北冥仓库 · 声音 QA 门（npm run audio:qa）：按 film.json 与交付档位逐项判定混音，写附录 C8 的报告，硬项不达标退出 4。
// 实现在 engine/audio/qa.py（python -m engine.audio.qa）；这里只做命令约定和选解释器（tools/env/py.mjs）。
//   node tools/audio/qa.mjs --film films/<名> [--wav <混音>] [--report <报告>] [--json]
//   node tools/audio/qa.mjs --wav out/mix.wav --profile web-1080p24 --frames 240 --fps 24
// 成片（最终 AAC）的响度、声画同步另由 tools/qa（npm run qa -- delivery / sync）判；这里判的是封装前的混音。
import { isMain, runCli } from '../lib/cli.mjs';
import { pythonCommand } from './lib/front.mjs';

const str = (arg, describe) => ({ type: 'string', arg, describe });
const int = (arg, describe) => ({ type: 'integer', arg, describe });
const num = (arg, describe) => ({ type: 'number', arg, describe });
const flag = describe => ({ type: 'boolean', describe });

export const command = pythonCommand({
  name: 'audio:qa',
  summary: '声音 QA 门：按 film.json 与交付档位逐项判定混音（格式、长度、满幅、积分响度、真峰值、直流、单声道兼容、首尾、切点爆音、频段）',
  usage: ['node tools/audio/qa.mjs --film <作品目录或 film.json> [--wav <混音>] [--report <报告>] [--json]',
    'node tools/audio/qa.mjs --wav <混音> [--profile <档位>] [--frames <帧数> --fps <帧率>]'],
  module: 'engine.audio.qa',
  description: [
    '目标响度与真峰值上限依次取：命令行 → film.json 的 audio.targetLUFS / truePeakDbTP → 交付档位（engine/production/profiles.json，没有时用决策 D07 的兜底表）。',
    '报告默认写在混音旁边的 <名>.qa.json，结构与 tools/qa 的 qa/report.json 相同（schemaVersion 1、checks[{id, status, value, expected, evidence}]、ok）。',
    '整段按 10 秒一块读盘，十分钟级的混音也只占几十 MB 内存。',
  ],
  options: {
    film: str('<作品>', '作品目录或 film.json（给出时长、帧率、镜头切点、混音目标与档位）'),
    wav: str('<混音>', '要查的混音（默认按作品找：audio.wav、out/latest 指向的运行目录、out/mix.wav、media/mix.wav）'),
    profile: str('<档位>', '交付档位（默认 film.json 的 output.profile，再缺省 web-1080p24）'),
    frames: int('<帧数>', '画面帧数（没有 film.json 时用来查长度，与 --fps 一起给）'),
    fps: int('<帧率>', '帧率（与 --frames 一起给）'),
    'target-lufs': num('<LUFS>', '混音目标积分响度'),
    'tol-lu': num('<LU>', '积分响度容差（默认 0.5，不会宽于档位）'),
    'max-tp': num('<dBTP>', '真峰值上限'),
    report: str('<文件>', '报告写到哪里（默认混音旁边的 <名>.qa.json）'),
    'no-report': flag('不写报告文件（只打印 / --json）'),
    'fail-on-warn': flag('告警也算不通过'),
    'loudness-at': { type: 'string', arg: '<mix|deliver>', choices: ['mix', 'deliver'], describe: '响度在哪一步定：mix 声音脚本自己母带（查响度、真峰值）；deliver 封装时线性增益（查峰值余量）。默认自动' },
  },
  examples: ['node tools/audio/qa.mjs --film films/dawn --json', 'node tools/audio/qa.mjs --wav out/mix.wav --profile beiming-1040p24 --frames 240 --fps 24'],
});

if (isMain(import.meta.url)) await runCli(command);
