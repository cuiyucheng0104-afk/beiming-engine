#!/usr/bin/env node
// 北冥仓库 · ERB 再合成（npm run audio:erb）：从一段录音渲染 N 个新 take（同一件东西的另一下），有 nvcc 与 NVIDIA GPU 就整批上 GPU，
// 否则走 CPU。实现在 engine/audio/erb/（CPU 参考实现 core.py、GPU 内核 erb_cuda.cu、用法见 engine/audio/erb/README.md）；
// 这里只做命令约定和选解释器（tools/env/py.mjs）。
//   node tools/audio/erb.mjs <录音> --out <目录> [--n 8] [--vary 1] [--exact 8] [--seed 0] [--device auto|gpu|cpu] [--json]
import { isMain, runCli } from '../lib/cli.mjs';
import { pythonCommand } from './lib/front.mjs';

const num = (arg, describe) => ({ type: 'number', arg, describe });

export const command = pythonCommand({
  name: 'audio:erb',
  summary: '从一段录音渲染 N 个新 take（96 带 ERB 再合成，有 GPU 就用 GPU，没有退回 CPU）',
  usage: ['node tools/audio/erb.mjs <录音> --out <目录> [--n <下数>] [--vary <强度>] [--exact <轮数>] [--seed <种子>] [--device auto|gpu|cpu] [--json]'],
  module: 'engine.audio.erb',
  positionals: [{ name: 'input', label: '<录音>', describe: 'soundfile 能读的格式，单声道或立体声，不超过 60 秒；不是 48 kHz 会先重采样' }],
  description: [
    '从录音学出一个不含原始波形的 ERB 模型，再按新种子合成「同一件东西的另一下」：起音一样脆，细节是新抽的，连敲时每下不同。',
    '输出 <目录>/take_01.wav …（48 kHz、24 bit）；第 k 下用种子 seed + k，同一台设备上重跑结果逐比特相同（CPU 与 GPU 的随机数不是同一组）。',
    '--device auto 有 nvcc 与 GPU 就用 GPU（第一次会现场编译内核，约 10 秒，缓存在 .cache/erb/），否则 CPU；nvcc 不在 PATH 时设 BEIMING_NVCC。',
  ],
  options: {
    out: { type: 'string', arg: '<目录>', describe: '输出目录（必填）' },
    n: num('<下数>', '渲染几下（默认 8，最多 1024）'),
    seed: num('<种子>', '第 k 下用种子 seed + k（默认 0）'),
    vary: num('<强度>', 'take 之间的变化强度：0 = 同一下的干净再合成，1 = 同一件东西连敲的典型差异（默认 1）'),
    exact: num('<轮数>', '交替投影轮数，越多越贴合模型也越慢（默认 8）'),
    dur: num('<倍率>', '时长倍率（默认 1）；起音段保持原速'),
    size: num('<倍率>', '物理尺寸倍率（>1 更大更低沉，默认 1）'),
    pitch: num('<半音>', '音高微调（默认 0）'),
    bright: num('<dB/八度>', '频谱倾斜，以 1.5 kHz 为支点（默认 0）'),
    device: { type: 'string', arg: 'auto|gpu|cpu', describe: 'auto = 有 nvcc 与 GPU 就用 GPU，否则 CPU（默认）；gpu 没有 GPU 时退出 3' },
  },
  examples: ['node tools/audio/erb.mjs films/drum/audio/hit.wav --out films/drum/out/takes --n 8', 'node tools/audio/erb.mjs hit.wav --out takes --device cpu --json'],
  exitCodes: { 0: '成功', 1: '运行失败', 2: '用法错误', 3: '缺输入文件，或指定 --device gpu 但没有可用的 nvcc 与 GPU（也含显存不够）', 130: '收到 SIGINT，已清理', 143: '收到 SIGTERM，已清理' },
});

if (isMain(import.meta.url)) await runCli(command);
