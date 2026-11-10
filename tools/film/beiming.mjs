#!/usr/bin/env node
// 北冥仓库 · 《北冥》10 秒样片的一键重建（npm run beiming:build；sh build.sh 是它的兼容壳）：转调统一出片命令，再按旧文件名放进 out/。
//   node tools/film/beiming.mjs [--4k|--uhd] [--no-audio] [--workers N] [--json]
// 等价于：node tools/film/cli.mjs build films/beiming-10s --page . --out-root out/beiming --profile beiming-1040p24 --audio audio/build.sh
//   作品描述 films/beiming-10s/film.json（作品描述包维护的镜像：路径相对仓库根，页面是仓库根的 index.html + src/）；
//   声音是《北冥》自己的 audio/build.sh（混音 + 自检）；产物在 out/beiming/<run-id>/（run.json、QA 报告、联系表、播放页），
//   最近一次在 out/beiming/latest。
// 旧文件名（老文档、脚本引用的位置）从本次运行目录放过去（同一文件系统上用硬链接，不占双份空间）：
//   out/video[_4k].mp4  逐帧中间件      out/beiming[_4k].mp4  成片（画面逐位复制中间件 + AAC）   out/beiming_web.mp4  网页版
//   out/beiming.html    单文件播放页    out/contact_sheet.jpg  联系表（本次运行的帧）            out/mix.wav          混音
// 旧版另有的 out/stills/s_*.jpg（0.5 秒一张的样张）不再单独出：联系表直接从本次成片按 0.5 秒取帧。
// 机器 QA 门不通过（退出码 4）时，画面与声音是好的，旧文件名照样放好，退出码仍是 4、并说明是哪几项硬门。
// --4k（--uhd）出的是 3840×2080 的工作版，不是交付件：档位 beiming-1040p24 要 1920×1040，交付 QA 必然不过，所以不跑 QA，
// 只核对帧数、画幅、帧率与音轨（不符退出码 4）；符合时退出码 0，run.json 记 rendered（作品描述包合入前记 blocked），与旧版 --4k 的 0 一致。
// 参数与退出码遵守命令约定（tools/lib/cli.mjs，docs/CLI.md）：--help 无副作用、未知参数退出 2、--json 时 stdout 只有一个信封。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CliError, defineCommand, isMain, runCli, sha256 } from '../lib/cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FILM = 'films/beiming-10s';
const CLI = path.join(ROOT, 'tools/film/cli.mjs');

export const command = defineCommand({
  name: 'beiming:build',
  summary: '重建《北冥》10 秒样片：转调统一出片命令，再按旧文件名放进 out/',
  usage: ['npm run beiming:build -- [--4k] [--no-audio] [--workers N] [--json]', 'node tools/film/beiming.mjs [选项]', 'sh build.sh [选项]（POSIX 兼容壳，参数相同）'],
  description: [
    `等价于 node tools/film/cli.mjs build ${FILM} --page . --out-root out/beiming --profile beiming-1040p24 --audio audio/build.sh；`,
    '产物在 out/beiming/<run-id>/（run.json、qa/report.json、联系表、播放页），再按旧文件名放到 out/：',
    '  out/video[_4k].mp4 · out/beiming[_4k].mp4 · out/beiming_web.mp4 · out/beiming.html · out/contact_sheet.jpg · out/mix.wav',
    '机器 QA 门不通过时旧文件名照样放好，退出码 4（报告在运行目录的 qa/）。新作品不要用这个命令：npm run new，再 npm run film -- build。',
    '--4k / --uhd：3840×2080 工作版，不是交付件——不跑机器 QA（档位要 1920×1040，交付规格必然不过），只核对帧数、画幅、帧率与音轨；',
    '  符合时退出码 0（run.json 记 rendered，作品描述包合入前记 blocked），不符退出码 4。',
    '环境变量：WORKERS / WORKERS_4K（并行路数，默认 1080p 4 路、4K 8 路；--workers 优先）、PYTHON、BEIMING_ANGLE、BEIMING_CHROME。',
  ],
  options: {
    uhd: { type: 'boolean', describe: '原生 3840×2080 工作版（构图不变，引擎按高度放大；旧写法 --4k 同样认）：不是交付件，不跑机器 QA，只核对规格' },
    'no-audio': { type: 'boolean', describe: '不重新混音，沿用 out/mix.wav' },
    workers: { type: 'integer', min: 1, max: 32, arg: '<N>', describe: '逐帧渲染并行路数（默认 WORKERS，或 1080p 4 / 4K 8）' },
  },
  examples: ['npm run beiming:build', 'npm run beiming:build -- --4k', 'sh build.sh --no-audio', 'node tools/film/beiming.mjs --json'],
  exitCodes: { 0: '成功（--4k 时：工作版出完且规格核对通过）', 1: '运行失败', 2: '用法错误', 3: '缺环境（或作品描述 films/beiming-10s 还没就位）', 4: '契约 / 机器 QA 不通过（旧文件名照样放好）；--4k 时是规格核对不符', 5: '样片正被另一次运行占用', 124: '超时', 130: '收到 SIGINT，已清理', 143: '收到 SIGTERM，已清理' },
  async run(ctx) {
    if (ctx.env.npm_lifecycle_event === 'build') ctx.warn('renamed', 'npm run build 已改名为 npm run beiming:build（旧名保留一个版本）');
    const fourK = ctx.opts.uhd, noAudio = ctx.opts['no-audio'];
    const envWorkers = ctx.env.WORKERS ?? (fourK ? ctx.env.WORKERS_4K ?? '8' : '4');
    const workers = ctx.opts.workers ?? envWorkers;
    if (!/^[1-9]\d*$/.test(String(workers))) throw new CliError('usage.bad-workers', `WORKERS / WORKERS_4K 必须是正整数（收到 ${workers}）`, { hint: '例：WORKERS=4 sh build.sh，或 --workers 4' });
    if (!fs.existsSync(path.join(ROOT, FILM, 'film.json'))) {
      throw new CliError('env.film-description-missing', `${FILM}/film.json 不存在：《北冥》样片的作品描述还没就位`, { hint: '它由作品描述包维护（films/beiming-10s/）；检出包含它的提交后重跑' });
    }
    const mixWav = path.join(ROOT, 'out', 'mix.wav');
    if (noAudio && !fs.existsSync(mixWav)) throw new CliError('usage.no-mix', '--no-audio 要沿用 out/mix.wav，但它不存在', { hint: '先不加 --no-audio 跑一次（会重新混音）' });

    const tag = fourK ? '_4k' : '';
    const args = [CLI, 'build', FILM, '--page', '.', '--out-root', 'out/beiming', '--profile', 'beiming-1040p24',
      '--workers', String(workers), '--audio', noAudio ? 'out/mix.wav' : 'audio/build.sh', '--json'];
    if (fourK) args.push('--size', '3840x2080');
    if (ctx.quiet) args.push('--quiet');

    // 统一出片命令：过程日志照常走 stderr，stdout 的 JSON 信封收下来。POSIX 上子进程自成进程组：终端的 Ctrl-C 只到这里，
    // 由这里的清理转发一次（转发两次会让它跳过清理直接退出）；Windows 的控制台 Ctrl-C 本来就同时送到子进程，这里只等它收尾。
    const posix = process.platform !== 'win32';
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], detached: posix, windowsHide: true });
    let out = '';
    child.stdout.on('data', b => { out += b; });
    const closed = new Promise(resolve => child.on('close', (c, s) => resolve(c ?? (s === 'SIGINT' ? 130 : 143))));
    ctx.onCleanup(async () => {
      if (posix && child.exitCode === null) { try { child.kill('SIGINT'); } catch { /* 已退出 */ } }
      await Promise.race([closed, new Promise(r => setTimeout(r, 4500))]);
    });
    const code = await closed;
    let env = null;
    try { env = JSON.parse(out); } catch { /* 下面按失败处理 */ }
    if (!env) throw new CliError('failure.film-cli', `统一出片命令没有给出 JSON 信封（退出码 ${code}）`, { hint: '看上面 stderr 的输出；单独跑 node tools/film/cli.mjs build films/beiming-10s --page . --out-root out/beiming 定位' });
    for (const w of env.warnings || []) ctx.warn(w);
    const runDir = env.data?.runDir || (env.runJson ? path.posix.dirname(env.runJson) : null);
    const qaOnly = code === 4 && /qa-failed$/.test(env.error?.code || '');
    if (code !== 0 && !qaOnly) return { exitCode: code || 1, error: env.error, outputs: env.outputs, runJson: env.runJson, data: env.data };

    // 旧文件名：从本次运行目录放过去
    const run = path.join(ROOT, runDir);
    const legacy = [
      ['work/video.mp4', `video${tag}.mp4`], ['master.mp4', `beiming${tag}.mp4`], ['web.mp4', 'beiming_web.mp4'],
      ['player.html', 'beiming.html'], ['contact.jpg', 'contact_sheet.jpg'], ...(noAudio ? [] : [['audio/mix.wav', 'mix.wav']]),
    ];
    fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
    const placed = [];
    for (const [from, to] of legacy) {
      const src = path.join(run, from), dst = path.join(ROOT, 'out', to);
      if (!fs.existsSync(src)) throw new CliError('failure.run-incomplete', `运行目录里缺 ${from}：${runDir}`, { hint: '看本次运行的 run.json 与 logs/' });
      const tmp = `${dst}.${process.pid}.tmp`;
      try { fs.rmSync(tmp, { force: true }); fs.linkSync(src, tmp); } catch { fs.copyFileSync(src, tmp); }
      fs.renameSync(tmp, dst);
      placed.push({ path: `out/${to}`, sha256: sha256(fs.readFileSync(dst)), kind: `legacy:${from}` });
    }
    ctx.out(`《北冥》样片：${runDir}/（run.json、QA 报告、联系表都在这里）\n旧文件名：${placed.map(p => p.path).join('  ')}`);
    const data = { ...(env.data || {}), legacy: placed.map(p => p.path) };
    if (qaOnly) {
      ctx.warn('qa-failed', `${env.error.message}：画面与声音照常输出、旧文件名已放好；报告见 ${runDir}/qa/report.md`);
      return { exitCode: 4, error: env.error, outputs: [...env.outputs, ...placed], runJson: env.runJson, data };
    }
    return { outputs: [...env.outputs, ...placed], runJson: env.runJson, data };
  },
});

// --4k 是旧参数名（命令约定的选项名不能以数字开头）：换成 --uhd 再解析；`--` 之后的不动
export function mapLegacyArgs(argv) {
  const i = argv.indexOf('--');
  const head = i < 0 ? argv : argv.slice(0, i);
  return [...head.map(a => (a === '--4k' ? '--uhd' : a)), ...(i < 0 ? [] : argv.slice(i))];
}

if (isMain(import.meta.url)) await runCli(command, mapLegacyArgs(process.argv.slice(2)));
