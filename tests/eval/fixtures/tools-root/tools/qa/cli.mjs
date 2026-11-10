#!/usr/bin/env node
// 测试桩：模拟 P07 tools/qa/cli.mjs 的命令面（附录 C1 退出码、C2 --json 信封），只供 tests/eval/ 使用。
//
//   node cli.mjs <delivery|visual|texts|plates> <成片> --film <film.json> --profile <档位> --json
//
// 行为由环境变量 EVAL_STUB_QA（JSON）控制：{ "<子命令>": "pass" | "fail" | "usage" | "env" | "double" | "crash" }，缺省 pass。
//   delivery 另外用 ffprobe 核对成片与 film.json 的 output（尺寸、帧率、帧数），不符判 fail，口径与真 QA 一致。
//   double：stdout 先多打一行 JSON（模拟违反 C2 的工具），结论照常。
// 真正的 QA 门由 P07 实现；这里只为让 gates.mjs 的判定逻辑可以离线测试。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const [sub, file, ...rest] = argv;
const opt = name => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : null; };
const modes = JSON.parse(process.env.EVAL_STUB_QA || '{}');
const mode = modes[sub] ?? 'pass';
const envelope = (ok, exitCode, checks, error = null) => ({ ok, exitCode, command: `qa ${sub}`, error, outputs: [], runJson: null, warnings: [], data: { checks } });
const emit = (value, code) => { process.stdout.write(JSON.stringify(value) + '\n'); process.exit(code); };

if (argv.includes('--help')) { process.stdout.write('测试桩：qa <delivery|visual|texts|plates> <成片> --film <film.json> --profile <档位> --json\n'); process.exit(0); }
if (!['delivery', 'visual', 'texts', 'plates'].includes(sub)) emit(envelope(false, 2, [], { code: 'usage', message: `未知子命令 ${sub}`, hint: null }), 2);
if (mode === 'usage') emit(envelope(false, 2, [], { code: 'usage', message: '未知参数 --film', hint: '加 --help 查看用法' }), 2);
if (mode === 'env') emit(envelope(false, 3, [], { code: 'ffmpeg-missing', message: '找不到 ffprobe', hint: '安装 FFmpeg ≥ 7' }), 3);
if (mode === 'crash') { process.stderr.write('Error: 桩模拟的内部错误\n'); process.exit(1); }
if (!file || !fs.existsSync(file)) emit(envelope(false, 2, [], { code: 'usage', message: `成片不存在：${file}`, hint: null }), 2);

const checks = [];
if (sub === 'delivery') {
  const film = JSON.parse(fs.readFileSync(opt('film'), 'utf8'));
  const probe = spawnSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,nb_read_packets', '-of', 'json', file], { encoding: 'utf8' });
  if (probe.status !== 0) emit(envelope(false, 3, [], { code: 'ffprobe-failed', message: 'ffprobe 失败', hint: null }), 3);
  const s = JSON.parse(probe.stdout).streams[0];
  const [n, d] = String(s.r_frame_rate).split('/').map(Number);
  const o = film.output ?? {};
  checks.push({ id: 'delivery.size', status: s.width === o.width && s.height === o.height ? 'pass' : 'fail', value: `${s.width}x${s.height}`, expected: `${o.width}x${o.height}` });
  checks.push({ id: 'delivery.fps', status: n / (d || 1) === o.fps ? 'pass' : 'fail', value: n / (d || 1), expected: o.fps });
  checks.push({ id: 'delivery.frames', status: Number(s.nb_read_packets) === o.frameCount ? 'pass' : 'fail', value: Number(s.nb_read_packets), expected: o.frameCount });
  if (mode === 'fail') checks.push({ id: 'delivery.loudness', status: 'fail', value: -20.1, expected: '-14±1 LUFS' });
} else {
  checks.push({ id: `${sub}.stub`, status: mode === 'fail' ? 'fail' : 'pass' });
}
const ok = checks.every(c => c.status !== 'fail');
if (mode === 'double') process.stdout.write(JSON.stringify({ progress: 1 }) + '\n');
emit(envelope(ok, ok ? 0 : 4, checks, ok ? null : { code: 'qa-failed', message: 'QA 硬门不通过', hint: '按报告逐项修正' }), ok ? 0 : 4);
