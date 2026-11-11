#!/usr/bin/env node
// 北冥仓库 · 声画拍点核对（npm run audio:cuecheck）：三条路线通用的事件表（events.json / film.json v2 events / 声音表），
// 画面打点离整帧、离节拍网格（八分、三连、十六分……）、离时间线、离音乐起音；关键事件集合必须有同拍的音乐起音；声音表时刻对画面结果帧按
// 不对称同步容差判；可选实测混音里的起音。实现在 engine/audio/cuecheck.py；这里只做命令约定和选解释器（tools/env/py.mjs）。
//   node tools/audio/cuecheck.mjs <作品目录> [--grid 4] [--keys hit,boom] [--report <文件>] [--json]
import { isMain, runCli } from '../lib/cli.mjs';
import { pythonCommand } from './lib/front.mjs';

const num = (arg, describe) => ({ type: 'number', arg, describe });
const file = describe => ({ type: 'string', arg: '<文件>', describe });

export const command = pythonCommand({
  name: 'audio:cuecheck',
  summary: '声画拍点核对：画面打点对整帧 / 节拍网格 / 时间线 / 音乐起音，声音事件对画面结果帧（超差退出 4）',
  usage: ['node tools/audio/cuecheck.mjs <作品目录> [--grid <细分>] [--tol-ms <毫秒>] [--keys <类型或 id,…>] [--measure] [--report <文件>] [--json]'],
  module: 'engine.audio.cuecheck',
  positionals: [{ name: 'film', label: '<作品目录>', describe: '读 events.json、timeline.json、film.json、out/score_onsets.json、out/mix.wav' }],
  description: [
    '事件表与路线无关：C 路线页面导出的 events.json（node engine/render/events.mjs <作品>），film.json v2 的 events[]（cue: true 是画面打点；',
    'audio 引用声音表或声音脚本登记的起音），A 路线的声音表（film.json audio.cues，例如《北冥》的 audio/cues.json）。',
    '同步容差（routes/directing/craft/animation.md §5.7）：声音晚 0 – 1 帧、早不超过 0.25 帧；sync: "lip" 允许晚 2 帧，"soft" 只告警，"none" 不查。',
  ],
  options: {
    'tol-ms': num('<毫秒>', '打点对整帧 / 网格 / 时间线 / 音乐起音的容差（默认 0.5）'),
    grid: num('<细分>', '一拍细分：2 八分（默认）、3 三连、4 十六分……'),
    keys: { type: 'string', arg: '<a,b>', describe: '关键事件集合：事件类型或 cue / id，逗号分隔（也可写在 film.json cuecheck.keys 或 timeline.json keys）' },
    silence: { type: 'string', arg: '<段,段>', describe: '要求安静的段落 id（timeline.json 的 secs），逗号分隔' },
    'quiet-db': num('<dB>', '静默段至少比全片 RMS 低多少 dB（默认 15）'),
    'film-json': file('film.json（默认 <作品>/film.json）'),
    events: file('events.json（默认 <作品>/events.json）'),
    timeline: file('timeline.json（默认 <作品>/timeline.json）'),
    onsets: file('score_onsets.json（默认 <作品>/out/score_onsets.json；配音的开口时刻用 out/dialogue/onsets.json）'),
    mix: { type: 'string', arg: '<混音>', describe: '混音（--measure 与 --silence 用；默认 <作品>/out/mix.wav）' },
    measure: { type: 'boolean', describe: '在混音里实测声音事件的起音，按同步容差再看一遍（只告警）' },
    'early-ms': num('<毫秒>', '声音最多可以比画面早多少毫秒（默认 0.25 帧）'),
    'late-frames': num('<帧>', '声音最多可以比画面晚几帧（默认 1；sync: "lip" 的事件按 2）'),
    report: file('把报告写成 JSON（附录 C8 的 checks + 逐事件明细）'),
  },
  examples: ['node tools/audio/cuecheck.mjs films/drum --grid 4 --keys boom', 'node tools/audio/cuecheck.mjs . --film-json <film.json> --measure --json'],
  exitCodes: { 0: '全部通过', 1: '运行失败', 2: '用法错误', 3: '缺事件表、时间表或混音', 4: '有超差', 130: '收到 SIGINT，已清理', 143: '收到 SIGTERM，已清理' },
});

if (isMain(import.meta.url)) await runCli(command);
