#!/usr/bin/env node
// 北冥引擎 · dstack 机队远端 GPU 渲染器
//   node tools/dstack-render.mjs [<影片目录>] [--out <文件.mp4>] [--workers 16] [--frames a:b] [--samples 4] [--shutter 0.65] [--no-mux]
//
// 流程：
//   1. 增量 rsync 本机北冥源码与当前影片 media/ 到目标算力机宿主缓存目录（日常改代码仅 <1s）
//   2. 生成 dstack 任务配置（开区间资源声明、NVIDIA_DRIVER_CAPABILITIES=all、BEIMING_ANGLE=vulkan、no-capacity 排队重试）
//   3. 经 dstack 控制面提交任务，并以 dstack ps -a 判成败（规避 dstack apply 日志流偶发断连误报）
//   4. 远端完成渲染（及可选响度归一 mux）后，经 rsync 拉回成片到本地 --out
// 默认节点参数可写在仓库外的 $XDG_CONFIG_HOME/beiming/dstack.json（未设 XDG_CONFIG_HOME 时为 ~/.config/beiming/dstack.json）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineCommand, isMain, runCli, CliError } from './lib/cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function loadUserDefaults() {
  const cfgBase = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const cfgPath = path.join(cfgBase, 'beiming', 'dstack.json');
  try {
    return fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  } catch {
    return {};
  }
}

function sh(cmd, args, { label, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0 && !allowFail) {
    const errText = (r.stderr || r.stdout || '').trim().split('\n').slice(-6).join('\n');
    throw new CliError('failure.remote', `${label || cmd} 失败（退出码 ${r.status}）：${errText}`, '检查 SSH 别名连接与 dstack-server 状态');
  }
  return r;
}

export const command = defineCommand({
  name: 'tools/dstack-render.mjs',
  summary: '经 dstack 算力池远端并行渲染北冥影片并拉回本地',
  usage: ['node tools/dstack-render.mjs [<影片目录>] [--out <文件.mp4>] [选项]'],
  positionals: [
    { name: 'dir', label: '<影片目录>', describe: '仓库内的影片目录（例如 films/beiming-10s）', required: false, default: 'films/beiming-10s' },
  ],
  options: {
    out: { type: 'string', arg: '<文件.mp4>', describe: '本地输出 MP4 路径（默认 out/dstack_<影片名>.mp4）' },
    host: { type: 'string', arg: '<ssh别名>', describe: '算力节点 SSH 别名（未传时读 ~/.config/beiming/dstack.json）' },
    server: { type: 'string', arg: '<ssh别名>', describe: 'dstack 控制面 SSH 别名（未传时读 ~/.config/beiming/dstack.json）' },
    backends: { type: 'string', default: 'ssh', arg: '<列表>', describe: '允许调度的 dstack 后端列表，逗号分隔（默认仅 ssh 自有机队，防止误触云端计费实例）' },
    gpu: { type: 'string', arg: '<规格>', describe: 'dstack GPU 资源声明（默认 RTX5090:1；传 none 可不设显存下界以适配 UMA 节点）' },
    image: { type: 'string', arg: '<镜像>', describe: 'dstack 容器镜像（可指定 tools/dstack/Dockerfile 构建推送后的预装镜像，0s 冷启）' },
    workers: { type: 'integer', min: 1, max: 64, default: 16, arg: '<n>', describe: '远端无头浏览器并发路数（默认 16）' },
    frames: { type: 'string', arg: 'a:b', describe: '只渲染指定帧区间 a:b（用于预览或跨机分片联渲）' },
    profile: { type: 'string', default: 'web-1080p24', arg: '<档位>', describe: '交付档位（默认 web-1080p24）' },
    capture: { type: 'string', choices: ['yuv420', 'png', 'jpeg'], default: 'yuv420', arg: '<格式>', describe: '帧捕获通道（默认 yuv420）' },
    samples: { type: 'integer', min: 1, max: 16, default: 4, arg: '<n>', describe: '时间超采样数（默认 4）' },
    shutter: { type: 'number', default: 0.65, arg: '<0–1>', describe: '运动模糊快门比例（默认 0.65）' },
    crf: { type: 'number', min: 0, max: 51, arg: '<0–51>', describe: '覆盖 x264 CRF（默认按档位 14 母版；日常审片/回传建议 --crf 20 体积小 8 倍、跨网秒拉）' },
    'no-mux': { type: 'boolean', describe: '只输出纯画面视频，不做音频响度归一封装' },
    'work-root': { type: 'string', arg: '<远端目录>', describe: '算力机宿主挂载根目录（未传时读 ~/.config/beiming/dstack.json）' },
  },
  examples: [
    'node tools/dstack-render.mjs films/beiming-10s --out out/beiming_remote.mp4',
    'node tools/dstack-render.mjs films/beiming-10s --crf 20 --out out/preview.mp4',
    'node tools/dstack-render.mjs films/beiming-10s --frames 0:120 --no-mux --out out/clip.mp4',
  ],
  run: async ctx => {
    const tStart = Date.now();
    const userCfg = loadUserDefaults();
    const filmRel = path.relative(ROOT, path.resolve(ROOT, ctx.args.dir));
    const filmAbs = path.join(ROOT, filmRel);
    if (!fs.existsSync(path.join(filmAbs, 'index.html'))) {
      throw new CliError('usage.film-not-found', `找不到影片入口 ${filmRel}/index.html`, '传入包含 index.html 的仓库内影片目录');
    }

    const filmName = path.basename(filmAbs);
    const localOut = path.resolve(ctx.opts.out || path.join(ROOT, 'out', `dstack_${filmName}.mp4`));
    fs.mkdirSync(path.dirname(localOut), { recursive: true });

    const host = ctx.opts.host || userCfg.host;
    const server = ctx.opts.server || userCfg.server;
    const workRoot = ctx.opts['work-root'] || userCfg.workRoot || '/var/tmp/beiming-dstack';
    const backendsList = (ctx.opts.backends || userCfg.backends || 'ssh').split(',').map(s => s.trim()).filter(Boolean);
    const gpuSpec = ctx.opts.gpu || userCfg.gpu || 'RTX5090:1';
    const imageSpec = ctx.opts.image || userCfg.image || 'nvidia/cuda:13.0.0-base-ubuntu24.04';
    if (!host || !server) {
      throw new CliError('usage.missing-host', '未指定算力节点 (--host) 或控制面 (--server)', '通过命令行传入 --host / --server，或在 ~/.config/beiming/dstack.json 中配置 host / server / workRoot');
    }
    const runSlug = Date.now().toString(36).slice(-5);
    const taskName = `bm-${filmName.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 12)}-${runSlug}`;

    // 1. 增量同步源码与音频素材
    ctx.log.info(`1/4 增量同步工作区至 ${host}:${workRoot} …`);
    sh('ssh', ['-o', 'BatchMode=yes', host, `mkdir -p ${workRoot}/{repo,ms-playwright,cache,out}`], { label: '创建远端目录' });
    sh('rsync', [
      '-az', '--delete',
      '--exclude=.git/', '--exclude=out/', '--exclude=cases/', '--exclude=films/*/media/', '--exclude=*.mp4',
      `${ROOT}/`, `${host}:${workRoot}/repo/`,
    ], { label: 'rsync 源码' });

    const mediaDir = path.join(filmAbs, 'media');
    let hasSongWav = false;
    if (fs.existsSync(mediaDir)) {
      sh('ssh', ['-o', 'BatchMode=yes', host, `mkdir -p ${workRoot}/repo/${filmRel}/media`], { label: '创建远端 media 目录' });
      sh('rsync', ['-azL', `${mediaDir}/`, `${host}:${workRoot}/repo/${filmRel}/media/`], { label: 'rsync 音频素材' });
      hasSongWav = fs.existsSync(path.join(mediaDir, 'song.wav'));
    }

    // 2. 生成远端执行脚本与 dstack 任务 YAML
    const doMux = !ctx.opts['no-mux'] && !ctx.opts.frames && hasSongWav;
    const remoteTarget = doMux ? '/work/out/master_dstack.mp4' : '/work/out/raw_dstack.mp4';
    const framesArg = ctx.opts.frames ? `--frames ${ctx.opts.frames}` : '';
    const crfArg = ctx.opts.crf !== undefined ? `--crf ${ctx.opts.crf}` : '';
    const filmJsonPath = path.join(filmAbs, 'film.json');
    const filmMeta = fs.existsSync(filmJsonPath) ? JSON.parse(fs.readFileSync(filmJsonPath, 'utf8')) : null;
    const totalFrames = filmMeta?.output?.frameCount || 4794;
    const fps = filmMeta?.output?.fps || 24;

    const runnerScript = `#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if ! command -v ffmpeg >/dev/null 2>&1 || ! ldconfig -p | grep -q libnss3; then
  if [ -s /work/cache/runtime-layer.tar ]; then
    tar -xf /work/cache/runtime-layer.tar -C / --keep-directory-symlink --skip-old-files 2>/dev/null || true
  else
    apt-get update -qq && apt-get install -y -qq --no-install-recommends \\
      ca-certificates ffmpeg fonts-noto-cjk \\
      libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 \\
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \\
      libpango-1.0-0 libcairo2 libasound2t64 libvulkan1 libgl1 libegl1 libx11-xcb1 libxcb1
  fi
fi
echo "/usr/lib" > /etc/ld.so.conf.d/nvidia-host.conf
ldconfig
export PATH="/work/cache/node/bin:$PATH"
export NODE_OPTIONS="--max-old-space-size=16384"
export PLAYWRIGHT_BROWSERS_PATH="/work/ms-playwright"
export BEIMING_ANGLE=vulkan
mkdir -p /work/out
rm -rf /work/out/raw_dstack* /work/out/master_dstack*
cd /work/repo
node engine/render/video.mjs ${filmRel} \\
  --profile ${ctx.opts.profile} --angle vulkan --settle none \\
  --workers ${ctx.opts.workers} --capture ${ctx.opts.capture} \\
  --samples ${ctx.opts.samples} --shutter ${ctx.opts.shutter} \\
  ${crfArg} ${framesArg} --no-guard --gpu required \\
  --out /work/out/raw_dstack.mp4
${doMux ? `node engine/render/lib/mux.mjs /work/out/raw_dstack.mp4 ${filmRel}/media/song.wav /work/out/master_dstack.mp4 ${fps} 0 --frames ${totalFrames} --profile ${ctx.opts.profile} --json` : ''}
`;

    const gpuYamlLine = gpuSpec && gpuSpec !== 'none' ? `\n  gpu: ${gpuSpec}` : '';
    const taskYaml = `type: task
name: ${taskName}
image: ${imageSpec}
backends: [${backendsList.join(', ')}]
env:
  - NVIDIA_DRIVER_CAPABILITIES=all
  - BEIMING_ANGLE=vulkan
volumes:
  - ${workRoot}:/work
commands:
  - bash /work/run_job.sh
resources:
  cpu: 16..
  memory: 32GB..${gpuYamlLine}
retry:
  on_events: [no-capacity]
  duration: 10m
`;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-dstack-'));
    try {
      const shFile = path.join(tmpDir, 'run_job.sh');
      const ymlFile = path.join(tmpDir, `${taskName}.dstack.yml`);
      fs.writeFileSync(shFile, runnerScript, { mode: 0o755 });
      fs.writeFileSync(ymlFile, taskYaml);

      sh('scp', ['-q', shFile, `${host}:${workRoot}/run_job.sh`], { label: '上传远端脚本' });
      sh('ssh', ['-o', 'BatchMode=yes', server, 'mkdir -p ~/dstack-beiming'], { label: '创建控制面目录' });
      sh('scp', ['-q', ymlFile, `${server}:~/dstack-beiming/${taskName}.dstack.yml`], { label: '上传 dstack YAML' });

      // 3. 异步提交并按 dstack ps 轮询判终态（加 -d 避免 dstack apply 末尾日志流断连卡顿 25–30s）
      ctx.log.info(`2/4 提交 dstack 任务 ${taskName}（backends=[${backendsList.join(',')}], GPU=${gpuSpec}, workers=${ctx.opts.workers}）…`);
      sh('ssh', ['-o', 'BatchMode=yes', server, `cd ~/dstack-beiming && sudo -n -H /opt/dstack-venv/bin/dstack apply -f ${taskName}.dstack.yml -y -d && rm -f ${taskName}.dstack.yml`], { label: 'dstack apply -d' });

      let psOut = '';
      for (let poll = 0; poll < 400; poll++) {
        psOut = sh('ssh', ['-o', 'BatchMode=yes', server, `sudo -n -H /opt/dstack-venv/bin/dstack ps -a | awk '$1=="${taskName}" {print; exit}'`], { label: '查询任务状态', allowFail: true }).stdout.trim();
        if (psOut && !/\b(submitted|provisioning|pulling|running|terminating)\b/i.test(psOut)) break;
        spawnSync('sleep', ['3']);
      }
      if (!/exited\s*\(0\)|done/i.test(psOut)) {
        const tailLog = sh('ssh', ['-o', 'BatchMode=yes', server, `sudo -n -H /opt/dstack-venv/bin/dstack logs ${taskName} | tail -n 30`], { allowFail: true }).stdout;
        throw new CliError('failure.dstack-task', `远端渲染任务状态异常：${psOut || '未知'}`, tailLog.trim() || `运行 ssh ${server} 'sudo -H /opt/dstack-venv/bin/dstack logs ${taskName}' 查看详情`);
      }

      // 读取远端 run.json 中的纯渲染耗时与 GPU 信息
      const remoteRecRaw = sh('ssh', ['-o', 'BatchMode=yes', host, `cat ${workRoot}/out/raw_dstack.mp4.run.json 2>/dev/null || true`], { allowFail: true }).stdout.trim();
      let remoteRec = null;
      try { remoteRec = remoteRecRaw ? JSON.parse(remoteRecRaw) : null; } catch { /* ignore */ }

      // 4. 拉回成片（H.264 已高度压缩，不加 -z 避免跨网传输时白耗 CPU 二次压缩）
      ctx.log.info(`3/4 从 ${host} 拉回成片至 ${localOut} …`);
      sh('rsync', ['-a', `${host}:${workRoot}${remoteTarget.replace(/^\/work/, '')}`, localOut], { label: '拉回成片' });

      const elapsedSec = +((Date.now() - tStart) / 1000).toFixed(2);
      const renderSec = remoteRec?.timing?.renderSeconds ?? null;
      const actualFrames = remoteRec?.output?.frames || totalFrames;
      return {
        data: {
          film: filmRel,
          host,
          gpu: remoteRec?.gpu?.renderer || gpuSpec,
          workers: ctx.opts.workers,
          muxed: doMux,
          frames: actualFrames,
          renderSeconds: renderSec,
          renderFps: renderSec ? +(actualFrames / renderSec).toFixed(2) : null,
          totalWallSeconds: elapsedSec,
          out: localOut,
        },
        outputs: [{ path: localOut, kind: doMux ? 'master' : 'video' }],
      };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },
});

if (isMain(import.meta.url)) runCli(command);
