#!/usr/bin/env node
// 北冥仓库 · 情绪导引乐谱与 ACE-Step 1.5 Cover 配乐生成（npm run audio:music）：
// film.json → 程序化情绪导引轨 guide.wav → ACE-Step 1.5 Cover 模式（或 --provider guide 离线确定性轨）→ music.wav。
// 实现在 engine/audio/music_gen.py（python -m engine.audio.music_gen）；这里只做命令约定和选解释器（tools/env/py.mjs）。
//   node tools/audio/music.mjs guide films/<名> [--out <guide.wav>] [--key D] [--scale major] [--bpm 96]
//   node tools/audio/music.mjs build films/<名> [--provider acestep|guide] [--ssh <ssh-alias>] [--offline] [--json]
//   node tools/audio/music.mjs probe [--endpoint https://example.invalid | --ssh <ssh-alias>]
import { isMain, runCli } from '../lib/cli.mjs';
import { pythonCommand } from './lib/front.mjs';

const strOpt = (arg, describe, extra) => (extra ? { type: 'string', arg, describe, ...extra } : { type: 'string', arg, describe });
const numOpt = (arg, describe, extra) => (extra ? { type: 'number', arg, describe, ...extra } : { type: 'number', arg, describe });
const intOpt = (arg, describe, extra) => (extra ? { type: 'integer', arg, describe, ...extra } : { type: 'integer', arg, describe });

export const command = pythonCommand({
  name: 'audio:music',
  summary: '情绪导引乐谱与 ACE-Step 1.5 Cover 配乐生成：film.json → guide.wav → music.wav（锁拍、对齐切点、终章高潮抬升）',
  usage: [
    'node tools/audio/music.mjs guide [<作品目录或 film.json>] [--out <guide.wav>] [--key <调性>] [--scale <音阶>] [--bpm <BPM>] [--json]',
    'node tools/audio/music.mjs build [<作品目录或 film.json>] [--provider <acestep|guide>] [--prompt <提示词>] [--ssh <主机别名>] [--offline] [--json]',
    'node tools/audio/music.mjs probe [--endpoint <URL> | --ssh <主机别名>] [--remote-port <端口>] [--json]',
  ],
  module: 'engine.audio.music_gen',
  positionals: [
    { name: 'action', label: '<guide | build | probe>', describe: 'guide 合成导引乐谱；build 生成 Cover 配乐或离线导引轨；probe 探测 ACE-Step 1.5 连通性' },
    { name: 'film', label: '[作品目录或 film.json]', required: false, describe: '作品目录或 film.json（probe 可省略；build 给了 --guide 时也可省略）' },
  ],
  description: [
    '先依据 film.json 的镜头切点与事件帧确定性合成 48 kHz 立体声情绪导引轨（大提琴/弦乐和声铺底、锁拍竖琴分解琶音、切镜前渐强引子与终章高八度抬升），',
    '再送入 ACE-Step 1.5 Cover 模式（task_type=cover, src_audio, audio_cover_strength）渲染真实配乐，消除纯文生音乐的中段断片与结尾塌陷。',
    '连接顺序：--endpoint → 环境变量 BEIMING_ACESTEP_URL → --ssh 临时本地端口转发（退出自动清理）。缓存键绑定导引轨 PCM16 摘要与全部推理参数。',
    '--offline：只读本地缓存，未命中退出 3；--provider guide：纯本机确定性导引配乐（动态预演与离线 CI 用）。',
  ],
  options: {
    out: strOpt('<文件>', '输出 WAV 路径（默认 <作品>/out/music/guide.wav 或 music.wav）'),
    key: strOpt('<调性>', '调性主音（默认读作品配置，缺省 D）'),
    scale: strOpt('<音阶>', '音阶类型（major / minor / dorian / mixolydian / lydian / pentatonic / minor-pentatonic）'),
    bpm: numOpt('<BPM>', '节拍速度 BPM（默认读作品配置，缺省 96）'),
    dur: numOpt('<秒>', '显式指定配乐时长（秒；没有 film.json 时使用）'),
    prompt: strOpt('<提示词>', 'ACE-Step 1.5 音乐风格与配器提示词（省略时按调性与叙事弧线自动生成）'),
    lyrics: strOpt('<标记>', '歌词或纯器乐标记（默认 [inst]）'),
    guide: strOpt('<文件>', 'build 使用的外部导引轨 WAV（省略时自动从 film.json 合成）'),
    cache: strOpt('<目录>', '缓存目录（默认 <作品>/out/cache/music）'),
    provider: strOpt('<服务>', '生成服务：acestep（ACE-Step 1.5 Cover）或 guide（离线确定性导引轨）', { choices: ['acestep', 'guide'] }),
    endpoint: strOpt('<URL>', 'ACE-Step 1.5 HTTP 服务地址（未传时读环境变量 BEIMING_ACESTEP_URL）'),
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
    'node tools/audio/music.mjs build films/dawn --ssh <ssh-alias> --cover-strength 0.45 --steps 8',
    'node tools/audio/music.mjs probe --endpoint https://example.invalid',
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
