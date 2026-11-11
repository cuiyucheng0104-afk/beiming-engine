#!/usr/bin/env node
// 北冥仓库 · 配音、字幕与口型（npm run audio:voice）：dialogue.json → 配音轨 voice.wav、字幕 subtitles.srt / .vtt / .ass、
// texts.json（window.TEXTS 的数据，排版用 engine/audio/voice/texts.mjs）、lips.json（口型）、onsets.json（开口时刻，cuecheck 可读）。
// 实现在 engine/audio/voice（python -m engine.audio.voice）；这里只做命令约定和选解释器（tools/env/py.mjs）。
//   node tools/audio/voice.mjs build films/<名> [--offline] [--provider synthetic] [--json]
//   node tools/audio/voice.mjs check films/<名>/dialogue.json
//   node tools/audio/voice.mjs providers
import { isMain, runCli } from '../lib/cli.mjs';
import { pythonCommand } from './lib/front.mjs';

export const command = pythonCommand({
  name: 'audio:voice',
  summary: '配音、字幕与口型：dialogue.json → voice.wav、subtitles.srt / .vtt / .ass、texts.json、lips.json（三者同一份时间）',
  usage: ['node tools/audio/voice.mjs <build | check | providers> [<作品目录或 dialogue.json>] [--offline] [--provider <服务>] [--json]'],
  module: 'engine.audio.voice',
  positionals: [
    { name: 'action', label: '<build | check | providers>', describe: 'build 合成并导出；check 只校验对白文件；providers 列出配音服务与本机能否使用' },
    { name: 'dialogue', label: '[作品目录或 dialogue.json]', required: false, describe: '作品目录时读其中的 dialogue.json' },
  ],
  description: [
    '写法见 engine/audio/voice/README.md。密钥只从环境变量或系统钥匙串读（MINIMAX_API_KEY 或钥匙串 beiming-minimax），仓库不读任何密钥文件。',
    '缓存键 = sha256(服务, 模型, 音色, 参数, 原话)：同一句只合成一次（付费服务不重复计费）；缓存目录默认 <作品>/out/cache/voice，付费服务的长片建议用 --cache 指到仓库外。',
    '--offline：联网的服务只读缓存；--provider synthetic：确定的临时配音（动态预演用，不是真人声，不能交付）。',
  ],
  options: {
    film: { type: 'string', arg: '<作品>', describe: 'film.json 或作品目录（默认在对白文件所在目录与上一级找）：帧率、片长、切点、画幅' },
    out: { type: 'string', arg: '<目录>', describe: '输出目录（默认 <作品>/out/dialogue）' },
    cache: { type: 'string', arg: '<目录>', describe: '缓存目录（默认 <作品>/out/cache/voice；付费服务的长片指到仓库外的固定目录）' },
    offline: { type: 'boolean', describe: '联网的服务（minimax、edge）只读缓存，缓存没有就退出 3' },
    provider: { type: 'string', arg: '<服务>', choices: ['synthetic', 'say', 'command', 'minimax', 'edge'], describe: '把所有说话人换成这个服务' },
  },
  examples: ['node tools/audio/voice.mjs providers', 'node tools/audio/voice.mjs build films/dawn --provider synthetic', 'node tools/audio/voice.mjs build films/dawn --offline --json'],
  exitCodes: { 0: '成功', 1: '运行失败', 2: '用法错误', 3: '缺依赖、缺密钥、离线时缓存里没有、找不到文件', 4: '对白文件不合规，或台词放不下、叠在一起', 130: '收到 SIGINT，已清理', 143: '收到 SIGTERM，已清理' },
});

if (isMain(import.meta.url)) await runCli(command);
