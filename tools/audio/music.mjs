#!/usr/bin/env node
// 北冥仓库 · 情绪导引乐谱与 ACE-Step 1.5 / Suno v6 Cover 配乐生成（npm run audio:music）：
// film.json → 程序化情绪导引轨 guide.wav → ACE-Step 1.5 / Suno v6 Cover 模式（或 --provider guide 离线确定性轨）→ music.wav。
// 实现在 engine/audio/music_gen.py（python -m engine.audio.music_gen）；这里只做命令约定和选解释器（tools/env/py.mjs）。
//   node tools/audio/music.mjs guide films/<名> [--out <guide.wav>] [--key D] [--scale major] [--bpm 96]
//   node tools/audio/music.mjs build films/<名> [--provider acestep|suno|guide] [--model v6] [--negative-style <词>] [--ssh <ssh-alias>] [--offline] [--json]
//   node tools/audio/music.mjs probe [--provider acestep|suno] [--endpoint https://example.invalid | --ssh <ssh-alias>]
import { isMain, runCli } from '../lib/cli.mjs';
import { pythonCommand } from './lib/front.mjs';

const strOpt = (arg, describe, extra) => (extra ? { type: 'string', arg, describe, ...extra } : { type: 'string', arg, describe });
const numOpt = (arg, describe, extra) => (extra ? { type: 'number', arg, describe, ...extra } : { type: 'number', arg, describe });
const intOpt = (arg, describe, extra) => (extra ? { type: 'integer', arg, describe, ...extra } : { type: 'integer', arg, describe });

export const command = pythonCommand({
  name: 'audio:music',
  summary: '情绪导引乐谱与 ACE-Step 1.5 / Suno v6 Cover 配乐生成：film.json → guide.wav → music.wav（锁拍、对齐切点、终章高潮抬升）',
  usage: [
    'node tools/audio/music.mjs guide [<作品目录或 film.json>] [--out <guide.wav>] [--midi-out <guide.mid>] [--style <风格>] [--key <调性>] [--scale <音阶>] [--bpm <BPM>] [--json]',
    'node tools/audio/music.mjs build [<作品目录或 film.json>] [--provider <acestep|suno|guide>] [--style <风格>] [--model <模型>] [--negative-style <排除词>] [--prompt <提示词>] [--pad-tail <秒>] [--align-guide] [--ssh <主机别名>] [--offline] [--json]',
    'node tools/audio/music.mjs probe [--provider <acestep|suno>] [--endpoint <URL> | --ssh <主机别名>] [--remote-port <端口>] [--json]',
  ],
  module: 'engine.audio.music_gen',
  positionals: [
    { name: 'action', label: '<guide | build | probe>', describe: 'guide 合成导引乐谱；build 生成 Cover 配乐或离线导引轨；probe 探测 ACE-Step 1.5 或 Suno MCP 连通性' },
    { name: 'film', label: '[作品目录或 film.json]', required: false, describe: '作品目录或 film.json（probe 可省略；build 给了 --guide 时也可省略）' },
  ],
  description: [
    '先依据 film.json 的镜头切点与事件帧确定性合成 48 kHz 立体声情绪导引轨（大提琴/弦乐和声铺底、锁拍竖琴分解琶音、切镜前渐强引子与终章高八度抬升），',
    '再送入 ACE-Step 1.5 Cover 模式（--provider acestep）或本地 Magpie Suno MCP（--provider suno，默认 model=v6）渲染真实配乐，消除纯文生音乐的中段断片与结尾塌陷。',
    '连接顺序：acestep 按 --endpoint → BEIMING_ACESTEP_URL → --ssh 临时端口转发；suno 按 --endpoint → BEIMING_SUNO_MCP_URL → http://127.0.0.1:3425/mcp/suno。缓存键绑定导引轨 PCM16 摘要与推理参数。',
    '--offline：只读本地缓存，未命中退出 3；--provider guide：纯本机确定性导引配乐（动态预演与离线 CI 用）。',
  ],
  options: {
    out: strOpt('<文件>', '输出 WAV 路径（默认 <作品>/out/music/guide.wav 或 music.wav）'),
    'midi-out': strOpt('<文件>', '可选导出标准 SMF Type-1 多轨 MIDI 文件路径（.mid）'),
    key: strOpt('<调性>', '调性主音（默认读作品配置，缺省 D）'),
    scale: strOpt('<音阶>', '音阶类型（major / minor / dorian / mixolydian / lydian / pentatonic / minor-pentatonic）'),
    bpm: numOpt('<BPM>', '节拍速度 BPM（默认读作品配置，缺省 96）'),
    style: strOpt('<风格>', '作曲风格原型（cinematic_orchestral / chinese_chamber / anime_nostalgic / hitech_minimal / ink_poetic / playful_folk）', {
      choices: ['cinematic_orchestral', 'chinese_chamber', 'anime_nostalgic', 'hitech_minimal', 'ink_poetic', 'playful_folk'],
    }),
    dur: numOpt('<秒>', '显式指定配乐时长（秒；没有 film.json 时使用）'),
    'pad-tail': numOpt('<秒>', 'Cover 上传前延续片尾主和弦余韵的秒数（如 4.0，防 AI Cover 提前淡出，下载后精裁回片长）', { min: 0 }),
    'align-guide': { type: 'boolean', describe: '显式启用零跑调（0.0 cents）锁相声码器 Cover 拍点对齐' },
    prompt: strOpt('<提示词>', '音乐风格与配器提示词（省略时按调性与叙事弧线自动生成）'),
    lyrics: strOpt('<标记>', '歌词或纯器乐标记（默认 [inst]；Suno 纯器乐自动省略 lyrics）'),
    guide: strOpt('<文件>', 'build 使用的外部导引轨 WAV（省略时自动从 film.json 合成）'),
    cache: strOpt('<目录>', '缓存目录（默认 <作品>/out/cache/music）'),
    provider: strOpt('<服务>', '生成服务：acestep（ACE-Step 1.5 Cover）、suno（本地 Magpie Suno MCP Cover）或 guide（离线确定性导引轨）', { choices: ['acestep', 'suno', 'guide'] }),
    model: strOpt('<模型>', 'Suno 生成模型标签（默认 v6；仅 --provider suno 使用）'),
    'negative-style': strOpt('<排除风格>', 'Suno 反向排除风格标签（仅 --provider suno 使用）'),
    endpoint: strOpt('<URL>', '服务端地址（acestep 读 BEIMING_ACESTEP_URL；suno 默认 http://127.0.0.1:3425/mcp/suno 或读 BEIMING_SUNO_MCP_URL）'),
    ssh: strOpt('<主机别名>', '免密 SSH 主机别名（建立临时本地端口转发并在退出时清理）'),
    'remote-port': intOpt('<端口>', 'SSH 转发的远端 ACE-Step 端口（默认 8001）', { min: 1, max: 65535 }),
    'cover-strength': numOpt('<0..1>', 'Cover 导引强度 0..1（默认 0.45）', { min: 0, max: 1 }),
    steps: intOpt('<步数>', '扩散推理步数（默认 8）', { min: 1 }),
    'guidance-scale': numOpt('<系数>', 'CFG 引导系数（默认 4.5）', { min: 0 }),
    seed: intOpt('<种子>', '确定性随机种子（默认 42）'),
    timeout: numOpt('<秒>', '网络探测或生成超时秒数（默认 300）', { min: 1 }),
    offline: { type: 'boolean', describe: '只读本地缓存，缓存未命中退出 3（不发起网络连接）' },
  },
  examples: [
    'node tools/audio/music.mjs guide films/dawn --key D --scale major --bpm 96',
    'node tools/audio/music.mjs build films/dawn --provider guide --json',
    'node tools/audio/music.mjs build films/dawn --provider suno --model v6 --negative-style "vocals, singing, synthesizer" --cover-strength 0.65 --json',
    'node tools/audio/music.mjs build films/dawn --ssh <ssh-alias> --cover-strength 0.45 --steps 8',
    'node tools/audio/music.mjs probe --provider suno --json',
  ],
  exitCodes: {
    0: '成功',
    1: '运行或生成失败',
    2: '用法错误',
    3: '缺依赖、未配置服务端地址、服务端不可达、离线时缓存未命中、找不到导引文件',
    4: '作品描述或配乐配置不合规',
    124: '生成超时',
    130: '收到 SIGINT，已清理',
    143: '收到 SIGTERM，已清理',
  },
});

if (isMain(import.meta.url)) await runCli(command);
