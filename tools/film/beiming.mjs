#!/usr/bin/env node
// 北冥仓库 · 《北冥》10 秒样片的一键重建（build.sh 与 npm run beiming:build 的实现）：转调统一出片命令，再按旧文件名放进 out/。
//   node tools/film/beiming.mjs [--4k] [--no-audio] [--json]
// 等价于：node tools/film/cli.mjs build films/beiming-10s --page . --out-root out/beiming --profile beiming-1040p24 --audio audio/build.sh
//   作品描述 films/beiming-10s/film.json（P05 维护，镜头表与样片代码一致由它的测试保证）；页面是仓库根的 index.html（src/）；
//   声音是《北冥》自己的 audio/build.sh（混音 + 自检）；产物在 out/beiming/<run-id>/（含 run.json），最近一次在 out/beiming/latest。
// 旧文件名（老文档、脚本、作品站引用的位置）从本次运行目录复制过去（能硬链接就硬链接）：
//   out/video[_4k].mp4  逐帧中间件      out/beiming[_4k].mp4  成片（画面逐位复制中间件 + AAC）   out/beiming_web.mp4  网页版
//   out/beiming.html    单文件播放页    out/contact_sheet.jpg  联系表（本次运行的帧）            out/mix.wav          混音
// 旧版另有的 out/stills/s_*.jpg（0.5 秒一张的样张）不再单独出：联系表直接从本次成片按 0.5 秒取帧。
// 参数：--4k 原生 3840×2080（构图不变，引擎按高度放大）；--no-audio 不重新混音，沿用 out/mix.wav；--json 把统一出片命令的信封原样打到 stdout。
// 环境变量：WORKERS（并行路数；设了就以它为准）、WORKERS_4K（--4k 且没设 WORKERS 时，默认 8）、PYTHON、BEIMING_ANGLE / BEIMING_CHROME。
// 退出码与统一出片命令相同（0 成功 · 1 运行失败 · 2 用法错误 · 3 缺环境 · 4 契约 / QA 不通过 · 5 被占用 · 124 超时 · 130/143 中断）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FILM = 'films/beiming-10s';
const USAGE = `用法：sh build.sh [--4k] [--no-audio] [--json]        （等价：node tools/film/beiming.mjs …，npm run beiming:build）
重建《北冥》10 秒样片：转调 node tools/film/cli.mjs build ${FILM} --page . --out-root out/beiming --profile beiming-1040p24，
产物在 out/beiming/<run-id>/（run.json、QA 报告、联系表、播放页），再按旧文件名复制到 out/：
  out/video[_4k].mp4 · out/beiming[_4k].mp4 · out/beiming_web.mp4 · out/beiming.html · out/contact_sheet.jpg · out/mix.wav
  --4k         原生 3840×2080（构图不变）
  --no-audio   不重新混音，沿用 out/mix.wav
  --json       stdout 只输出统一出片命令的 JSON 信封
环境变量：WORKERS / WORKERS_4K（并行路数，默认 1080p 4 路、4K 8 路）、PYTHON、BEIMING_ANGLE、BEIMING_CHROME
退出码：0 成功 · 1 运行失败 · 2 用法错误 · 3 缺环境 · 4 契约 / QA 不通过 · 5 被占用 · 124 超时 · 130/143 中断`;

const fail = (code, msg, hint) => { process.stderr.write(`✗ ${msg}\n${hint ? `  下一步：${hint}\n` : ''}`); process.exit(code); };

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { process.stdout.write(USAGE + '\n'); process.exit(0); }
let fourK = false, noAudio = false, json = false;
for (const a of args) {
  if (a === '--4k') fourK = true;
  else if (a === '--no-audio') noAudio = true;
  else if (a === '--json') json = true;
  else fail(2, `不认识的参数：${a}（可用：--4k --no-audio --json）`, 'sh build.sh --help 看用法');
}
let workers = process.env.WORKERS ?? (fourK ? process.env.WORKERS_4K ?? '8' : '4');
if (!/^[1-9]\d*$/.test(String(workers))) fail(2, `WORKERS / WORKERS_4K 必须是正整数（收到 ${workers}）`);
if (!fs.existsSync(path.join(ROOT, FILM, 'film.json'))) {
  fail(3, `${FILM}/film.json 不存在：《北冥》样片的作品描述还没就位`, '它由作品描述包（P05）维护；检出完整的仓库后重跑');
}
const mixWav = path.join(ROOT, 'out', 'mix.wav');
if (noAudio && !fs.existsSync(mixWav)) fail(2, '--no-audio 要沿用 out/mix.wav，但它不存在', '先不加 --no-audio 跑一次（会重新混音）');

const tag = fourK ? '_4k' : '';
const cli = ['tools/film/cli.mjs', 'build', FILM, '--page', '.', '--out-root', 'out/beiming', '--profile', 'beiming-1040p24',
  '--workers', String(workers), '--audio', noAudio ? 'out/mix.wav' : 'audio/build.sh', '--json'];
if (fourK) cli.push('--size', '3840x2080');

// 统一出片命令：过程日志照常走 stderr，stdout 的 JSON 信封收下来（--json 时原样转交）。
// POSIX 上子进程自成进程组，终端的 Ctrl-C 只到这里，由这里转发一次（转发两次会让它跳过清理直接退出）；
// Windows 的控制台 Ctrl-C 本来就同时送到子进程，这里只等它收尾。
const posix = process.platform !== 'win32';
const child = spawn(process.execPath, cli, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], detached: posix, windowsHide: true });
let out = '';
child.stdout.on('data', b => { out += b; });
let forwarded = false;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (!posix || forwarded) return;
    forwarded = true;
    try { child.kill(sig === 'SIGHUP' ? 'SIGTERM' : sig); } catch { /* 已退出 */ }
  });
}
const code = await new Promise(resolve => child.on('close', (c, s) => resolve(c ?? (s === 'SIGINT' ? 130 : 143))));
let env = null;
try { env = JSON.parse(out.trim().split('\n').filter(Boolean).at(-1)); } catch { /* 下面按失败处理 */ }
if (json) process.stdout.write((env ? JSON.stringify(env) : out.trim()) + '\n');
if (code !== 0 || !env?.ok) {
  if (!json && env?.error) process.stderr.write(`\n✗ ${env.error.message}\n${env.error.hint ? `  下一步：${env.error.hint}\n` : ''}  退出码 ${code}\n`);
  process.exit(code || 1);
}

// 旧文件名：从本次运行目录复制（同一文件系统上用硬链接，不占双份空间）
const run = path.join(ROOT, env.runDir);
const legacy = [
  ['work/video.mp4', `video${tag}.mp4`], ['master.mp4', `beiming${tag}.mp4`], ['web.mp4', 'beiming_web.mp4'],
  ['player.html', 'beiming.html'], ['contact.jpg', 'contact_sheet.jpg'], ...(noAudio ? [] : [['audio/mix.wav', 'mix.wav']]),
];
fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
const placed = [];
for (const [from, to] of legacy) {
  const src = path.join(run, from), dst = path.join(ROOT, 'out', to);
  if (!fs.existsSync(src)) fail(1, `运行目录里缺 ${from}：${env.runDir}`, '看本次运行的 run.json 与 logs/');
  const tmp = `${dst}.${process.pid}.tmp`;
  try { fs.rmSync(tmp, { force: true }); fs.linkSync(src, tmp); } catch { fs.copyFileSync(src, tmp); }
  fs.renameSync(tmp, dst);
  placed.push(`out/${to}`);
}
if (!json) {
  process.stdout.write(`《北冥》样片已重建：${env.runDir}/（run.json、QA 报告、联系表都在这里）\n`);
  process.stdout.write(`旧文件名：${placed.join('  ')}\n`);
}
