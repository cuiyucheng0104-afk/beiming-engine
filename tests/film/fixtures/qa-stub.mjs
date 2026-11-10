#!/usr/bin/env node
// 测试夹具 · 机器 QA 门的替身（只给 tests/film 用，不是交付 QA）：命令行与输出按 tools/qa/cli.mjs report 的约定
//   node tests/film/fixtures/qa-stub.mjs report <成片> --film <film.json> --out <目录> [--page <目录>] [--profile <档位>] --json
// stdout 是附录 C2 的信封，result 是附录 C8 的报告（含 technicalAcceptance）；报告同时写进 <目录>/report.json。
// 编排器通过环境变量 FILM_QA_CLI 指到这里，用来把「出片链本身」与「模版画面是否过得了真 QA」分开测。
// 只做最基本的三项（帧数、色彩标签、音轨）；QA_STUB_FAIL=1 时故意让「帧数」一项不通过；QA_STUB_EXIT 指定退出码（测缺环境、参数不匹配）。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const a = process.argv.slice(2);
if (a.includes('--help')) { console.log('用法：node tests/film/fixtures/qa-stub.mjs report <成片> --film <film.json> --out <目录> [--profile <档位>] --json\n退出码：0 通过、4 不通过'); process.exit(0); }
const envelope = (exitCode, result, error = null, outputs = []) => JSON.stringify({ schemaVersion: 1, ok: exitCode === 0, exitCode, command: 'qa report', error, outputs, runJson: null, warnings: [], result });
if (process.env.QA_STUB_EXIT) {
  const code = Number(process.env.QA_STUB_EXIT);
  process.stdout.write(envelope(code, null, { code: code === 3 ? 'env' : 'usage', message: `qa-stub：按 QA_STUB_EXIT=${code} 退出`, hint: null }) + '\n');
  process.exit(code);
}
const opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
const [sub, file] = a;
if (sub !== 'report' || !file || !opt('--film') || !opt('--out')) { console.error('qa-stub：用法错误'); process.exit(2); }
const film = JSON.parse(fs.readFileSync(opt('--film'), 'utf8'));
const filmFps = film.output?.fps ?? film.fps;
const filmFrames = film.output?.frameCount ?? Math.round(film.dur * filmFps);
// 按档位出片时帧率可能与 film.json 不同：期望帧数按时长换算（与编排器同口径）
const { BUILTIN } = await import('../../../tools/film/lib/profiles.mjs');
const fps = opt('--profile') && BUILTIN[opt('--profile')] ? BUILTIN[opt('--profile')].fps : filmFps;
const want = Math.round(filmFrames * fps / filmFps);
const j = JSON.parse(execFileSync(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-count_frames', '-show_entries',
  'stream=codec_type,nb_read_frames,color_range,color_space,color_transfer,color_primaries', '-of', 'json', file], { encoding: 'utf8' }));
const v = j.streams.find(s => s.codec_type === 'video');
const au = j.streams.find(s => s.codec_type === 'audio');
const frames = Number(v.nb_read_frames);
const color = [v.color_range, v.color_space, v.color_transfer, v.color_primaries].join('/');
const checks = [
  { id: 'delivery.frames', status: frames === want && !process.env.QA_STUB_FAIL ? 'pass' : 'fail', value: frames, expected: want },
  { id: 'delivery.color', status: color === 'tv/bt709/bt709/bt709' ? 'pass' : 'fail', value: color, expected: 'tv/bt709/bt709/bt709' },
  { id: 'delivery.audio', status: au ? 'pass' : 'fail', value: !!au, expected: true },
];
const ok = checks.every(c => c.status !== 'fail');
const out = path.resolve(opt('--out'));
fs.mkdirSync(out, { recursive: true });
const reportPath = path.join(out, 'report.json');
const report = {
  schemaVersion: 1, film: film.id || null, input: { path: file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') },
  profile: opt('--profile'), checks, ok, skipped: [], warnings: [],
  summary: { pass: checks.filter(c => c.status === 'pass').length, warn: 0, fail: checks.filter(c => c.status === 'fail').length, waived: 0, hardFailures: checks.filter(c => c.status === 'fail').map(c => c.id) },
  technicalAcceptance: { status: ok ? 'passed' : 'failed', evidence: [reportPath] }, by: 'tests/film/fixtures/qa-stub.mjs（测试替身）',
};
fs.writeFileSync(reportPath, JSON.stringify(report, null, 1) + '\n');
process.stdout.write(envelope(ok ? 0 : 4, report, ok ? null : { code: 'qa.gate', message: `硬门不通过：${report.summary.hardFailures.join('、')}`, hint: null }, [{ path: reportPath, sha256: null, kind: 'qa-report' }]) + '\n');
process.exit(ok ? 0 : 4);
