#!/usr/bin/env node
// 测试夹具 · 机器 QA 门的替身（只给 tests/film 用，不是交付 QA）：按加固计划附录 C8 的报告格式回答
//   node tests/film/fixtures/qa-stub.mjs delivery <成片> --film <film.json> [--profile <档位>] --json
// 真正的 QA 门由 P07 提供（tools/qa/cli.mjs）；编排器通过环境变量 FILM_QA_CLI 指到这里，用来测 passed / failed 两条路。
// 只做最基本的三项（帧数、色彩标签、音轨）；QA_STUB_FAIL=1 时故意让「帧数」一项不通过；QA_STUB_EXIT 指定退出码（测参数不匹配等）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const a = process.argv.slice(2);
if (a.includes('--help')) { console.log('用法：node tests/film/fixtures/qa-stub.mjs delivery <成片> --film <film.json> [--profile <档位>] --json'); process.exit(0); }
if (process.env.QA_STUB_EXIT) { console.error('qa-stub：按 QA_STUB_EXIT 退出'); process.exit(Number(process.env.QA_STUB_EXIT)); }
const [sub, file] = a;
const fi = a.indexOf('--film');
if (sub !== 'delivery' || !file || fi < 0) { console.error('qa-stub：用法错误'); process.exit(2); }
const film = JSON.parse(fs.readFileSync(a[fi + 1], 'utf8'));
const filmFps = film.output?.fps ?? film.fps;
const filmFrames = film.output?.frameCount ?? Math.round(film.dur * filmFps);
// 按档位出片时帧率可能与 film.json 不同：期望帧数按时长换算（与编排器同口径）
const pi = a.indexOf('--profile');
const { BUILTIN } = await import('../../../tools/film/lib/profiles.mjs');
const fps = pi >= 0 && BUILTIN[a[pi + 1]] ? BUILTIN[a[pi + 1]].fps : filmFps;
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
const report = { schemaVersion: 1, film: film.id || null, input: { path: file, sha256: null }, profile: a.includes('--profile') ? a[a.indexOf('--profile') + 1] : null, checks, ok: checks.every(c => c.status !== 'fail'), by: 'tests/film/fixtures/qa-stub.mjs（测试替身）' };
process.stdout.write(JSON.stringify(report) + '\n');
process.exit(report.ok ? 0 : 4);
