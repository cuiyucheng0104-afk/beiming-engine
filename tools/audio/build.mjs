#!/usr/bin/env node
// 北冥仓库 · 《北冥》声音一键重建（npm run audio:build）：混音 → 门禁自检 → 打印结论。实现在 audio/build.py；
// 这里只做命令约定（严格参数、--help 不起 Python、--json 只出一个信封）和选解释器（tools/env/py.mjs，三个平台同一个）。
//   node tools/audio/build.mjs [--score] [--accept-stale-score] [--no-strict] [--json]
// 退出码（附录 C1）：0 通过；2 用法；3 缺依赖或缺输入；4 门禁不通过或配乐缓存与输入不一致；1 运行失败；130 / 143 被中断。
import { isMain, runCli } from '../lib/cli.mjs';
import { pythonCommand } from './lib/front.mjs';

export const command = pythonCommand({
  name: 'audio:build',
  summary: '《北冥》声音一键重建：混音 → 门禁自检（报告 audio/check/qa.json，附录 C8；硬项不达标退出 4）',
  usage: ['node tools/audio/build.mjs [--score] [--accept-stale-score] [--no-strict] [--json]'],
  script: 'audio/build.py',
  description: [
    '配乐默认读定稿缓存 audio/score_cache.npz（与样片逐样本一致；缓存与乐谱对不上时退出 4，不静默沿用）。',
    '门禁：混音格式与长度、积分响度、真峰值、满幅、直流、单声道兼容、首尾、切点爆音、经 mux.sh 封装后的成片响度、提示音带内信噪比、分轨削波。',
    '改时间：编辑 audio/cues.json 里各事件的 t 与镜头切点后重跑；配乐的时间在 audio/score.py，改了要加 --score。',
  ],
  options: {
    score: { type: 'boolean', describe: '用采样库重渲配乐（需要 BEIMING_SAMPLES 或 audio/samples/；取样：npm run audio:samples）' },
    'accept-stale-score': { type: 'boolean', describe: '配乐缓存与当前乐谱对不上时仍用旧配乐（记进 audio/check/render.json）' },
    'no-strict': { type: 'boolean', describe: '只跑旧口径自检（problems 非空退出 1），不做门禁' },
  },
  examples: ['node tools/audio/build.mjs', 'node tools/audio/build.mjs --json', 'node tools/audio/build.mjs --score'],
  exitCodes: { 0: '通过', 1: '运行失败', 2: '用法错误', 3: '缺依赖（Python 包、ffmpeg）或缺输入', 4: '门禁不通过，或配乐缓存与输入不一致', 130: '收到 SIGINT，已清理', 143: '收到 SIGTERM，已清理' },
});

if (isMain(import.meta.url)) await runCli(command);
