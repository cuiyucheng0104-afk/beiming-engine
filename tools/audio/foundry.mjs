#!/usr/bin/env node
// 北冥仓库 · L2 声源铸造厂（npm run audio:foundry）：按需拉起 MOSS-SoundEffect-v2.0 推理子进程，生成 48 kHz / 24 bit 单声道干声，
// 以规范化请求的 SHA256 为键落盘缓存，生成物过 L3 物理取证（sfx_judge）。主控不 import torch，推理子进程用隔离 venv，跑完或空闲即退出归还显存。
// 实现在 engine/audio/foundry.py（python -m engine.audio.foundry）与 foundry_worker.py（推理子进程）；这里只做命令约定和选解释器（tools/env/py.mjs）。
//   node tools/audio/foundry.mjs gen --prompt "<描述>" [--duration 2] [--steps 100] [--seed 0] [--out <目录>] [--strict] [--ssh <ssh-alias>] [--json]
//   node tools/audio/foundry.mjs gen --jobs <请求.json> --dry-run
//   node tools/audio/foundry.mjs serve [--idle-timeout 300]     （stdin 每行一个 JSON 请求，stdout 每行一个 JSON 回应）
//   node tools/audio/foundry.mjs probe [--ssh <ssh-alias>]
import { isMain, runCli } from '../lib/cli.mjs';
import { pythonCommand } from './lib/front.mjs';

const str = (arg, describe) => ({ type: 'string', arg, describe });
const int = (arg, describe, extra) => ({ type: 'integer', arg, describe, ...extra });
const num = (arg, describe, extra) => ({ type: 'number', arg, describe, ...extra });
const flag = describe => ({ type: 'boolean', describe });

export const command = pythonCommand({
  name: 'audio:foundry',
  summary: 'L2 声源铸造厂：按需拉起 MOSS-SoundEffect-v2.0 生成 48 kHz / 24 bit 干声，SHA256 缓存，L3 取证，空闲自动卸载',
  usage: [
    'node tools/audio/foundry.mjs gen --prompt <描述> [--duration <秒>] [--steps <步>] [--seed <种子>] [--out <目录>] [--strict] [--dry-run] [--json]',
    'node tools/audio/foundry.mjs gen --jobs <请求.json> [--out <目录>] [--cache <目录>] [--ssh <主机别名>] [--min-free-gib <GiB>]',
    'node tools/audio/foundry.mjs serve [--idle-timeout <秒>] [--cache <目录>]',
    'node tools/audio/foundry.mjs probe [--ssh <主机别名>] [--min-free-gib <GiB>] [--json]',
  ],
  module: 'engine.audio.foundry',
  stdin: 'inherit',
  positionals: [{ name: 'action', label: '<gen | serve | probe>', describe: 'gen 批处理（跑完本批就退出推理子进程）；serve 常驻调度器（stdin 每行一个 JSON 请求，空闲自动卸载）；probe 只查显存守门与配置' }],
  description: [
    '0C 实测（rog-5090）：峰值显存 15.4 GiB，100 步约 6.8 秒、50 步约 3.5 秒一条；进程内卸载后仍残留约 1 GiB，只有子进程退出才全部归还；同参数跨会话不逐字节相同。',
    '所以：① 拉起前查空闲显存，低于 --min-free-gib（默认 18）退出 5，查不到退出 3，只有 --skip-vram-check 才跳过；② 用「子进程退出」卸载（gen 跑完本批，serve 空闲 --idle-timeout 秒）；',
    '③ 缓存以规范化请求（模型、版本、prompt、negative_prompt、duration、steps、cfg、sigma_shift、seed）的 SHA256 为键，保存生成产物 <键>.wav + <键>.json，命中不拉起子进程，损坏或含 NaN/Inf 按未命中重生成；',
    '④ 新产物过 sfx_judge，verdict（pass / suspect / reject）与指标写进 json；默认只标注，--strict 只收 pass，其余整批退出 4。波形不压缩不归一化，仅在峰值超过 0.999 满幅时线性衰减防截断。',
    '推理环境：--python（BEIMING_AUDIO_L2_PYTHON）是装了 torch 与上游 moss_soundeffect_v2 的隔离 venv 的解释器，--model-dir（BEIMING_AUDIO_L2_MODEL_DIR）是权重目录，--pkg-dir（BEIMING_AUDIO_L2_PKG）是上游克隆目录；全命中缓存时都不需要。',
    '--ssh：经免密 ssh 在远端拉起推理子进程（列表形式启动，不经本机 shell；主机名不能以 - 开头），此时 --python、--model-dir、--pkg-dir 与显存查询都在远端。',
    'serve 的 stdout 是协议流：请求 {"op":"gen","id":1,"prompt":"…"}，回应 {"id":1,"ok":true,"result":{…}}；还有 {"op":"status"}、{"op":"shutdown"}；空闲卸载时回 {"event":"idle-release"}；不接受 --json。',
    '产物不写进仓库：缓存默认在 .cache/audio-foundry（BEIMING_AUDIO_L2_CACHE 或 --cache 改）。含 AI 生成内容，入作品要按 docs/rights/aigc.md 标识。',
  ],
  options: {
    prompt: str('<描述>', '要生成的声音的描述（中英文都行）'),
    'negative-prompt': str('<描述>', '反向描述（默认空）'),
    duration: num('<秒>', '时长（默认 2，最长 30）'),
    steps: int('<步数>', '去噪步数（默认 100；50 步约快一倍）'),
    cfg: num('<系数>', 'CFG 引导系数（默认 4）'),
    'sigma-shift': num('<值>', 'sigma shift（默认 5）'),
    seed: int('<种子>', '种子（默认 0）；跨会话不逐字节相同，要靠缓存复用'),
    name: str('<名>', '单条请求的输出名（--out 时写 <名>.wav；默认键的前 12 位）'),
    jobs: str('<文件>', '批量请求文件：JSON 数组，或 {"jobs": […]}，每条可写 prompt、negative_prompt、duration、steps、cfg、sigma_shift、seed、name'),
    out: str('<目录>', '把产物另存一份到这个目录（缓存里的那份始终保留）'),
    cache: str('<目录>', '缓存目录（默认 .cache/audio-foundry，BEIMING_AUDIO_L2_CACHE）'),
    strict: flag('L3 取证只收 pass：suspect 与 reject 这条算不通过，整批退出 4（默认只标注、照常落盘）'),
    archetype: str('<原型>', 'L3 的物理原型（默认 auto：按 prompt 推断）'),
    'dry-run': flag('只报告每条的键与命中与否，不拉起子进程、不写盘'),
    python: str('<解释器>', '隔离 venv 的解释器（BEIMING_AUDIO_L2_PYTHON）；不要用主仓 .venv'),
    'model-dir': str('<目录>', 'MOSS-SoundEffect-v2.0 权重目录（BEIMING_AUDIO_L2_MODEL_DIR）'),
    'pkg-dir': str('<目录>', '上游 MOSS-TTS 克隆目录（BEIMING_AUDIO_L2_PKG）'),
    'model-id': str('<标识>', '写进键与元数据的模型标识（默认 OpenMOSS-Team/MOSS-SoundEffect-v2.0）'),
    revision: str('<版本>', '写进键与元数据的模型版本（默认 unpinned；要让缓存跟着权重版本走就给 HF 的 commit）'),
    ssh: str('<主机别名>', '免密 SSH 主机别名：在远端拉起推理子进程（不能以 - 开头）'),
    gpu: int('<序号>', 'GPU 序号（默认 0）', { min: 0 }),
    'min-free-gib': num('<GiB>', '拉起前要求的空闲显存（默认 18；0C 实测峰值 15.4）', { min: 0 }),
    'skip-vram-check': flag('明确跳过显存守门（默认查不到或不足就拒绝）'),
    'idle-timeout': num('<秒>', 'serve 的推理子进程空闲多少秒后退出（默认 300）', { min: 0 }),
    timeout: num('<秒>', '子进程握手与每条请求的等待上限（默认 600）', { min: 0 }),
  },
  examples: [
    'node tools/audio/foundry.mjs gen --prompt "宣纸被剪刀干脆地裁断" --duration 2 --out films/demo/audio/sfx --name paper_cut',
    'node tools/audio/foundry.mjs gen --jobs jobs.json --dry-run --json',
    'node tools/audio/foundry.mjs gen --prompt "青铜编钟敲击" --strict --ssh <ssh-alias>',
    'node tools/audio/foundry.mjs probe --ssh <ssh-alias>',
  ],
  exitCodes: {
    0: '成功',
    1: '运行失败（推理子进程崩溃、写盘失败）',
    2: '用法错误（参数、请求字段、主机名不合法）',
    3: '环境缺失（没有推理环境配置、nvidia-smi 或 ssh 查不到空闲显存、子进程报缺依赖）',
    4: '取证或契约不过（--strict 下 L3 verdict 不是 pass、子进程交回含 NaN/Inf 的音频）',
    5: '资源忙（空闲显存低于 --min-free-gib，拒绝拉起）',
    124: '推理子进程超时（已结束并回收）',
    130: '收到 SIGINT，已卸载子进程并清理',
    143: '收到 SIGTERM，已卸载子进程并清理',
  },
});

if (isMain(import.meta.url)) await runCli(command);
