#!/usr/bin/env node
// 测试夹具 · 机器 QA 门的替身（只给 tests/film 用，不是交付 QA）：命令行与输出按 tools/qa/cli.mjs report 的约定
//   node tests/film/fixtures/qa-stub.mjs report <成片> --film <作品描述> --out <目录> [--page <目录>] [--size <宽x高>] [--events <事件表>] [--profile <档位>] --json
// stdout 是附录 C2 的信封，result 是附录 C8 的报告（含 technicalAcceptance）；报告同时写进 <目录>/report.json。
// 测试进程用预加载钩子 qa-stub-hook.mjs 把编排器对 tools/qa/cli.mjs 的调用换到这里（编排器里没有换 QA 的开关），
// 用来把「出片链本身」与「模版画面是否过得了真 QA」分开测。
//
// 口径与真 QA 一致（docs/quality/QA-GATE.md §4.1），而且直接用真 QA 自己的库读作品描述与档位（tools/qa/lib/film.mjs、profiles.mjs），
// 不按编排器的算法另算一遍——否则替身会和编排器一起错（上一版就把期望帧数按档位帧率换算，正好盖住了「竖屏档位交给 QA 的仍是
// 原 film.json」的问题）：
//   delivery.frame-count  解码帧数 = 作品描述的 frameCount
//   delivery.frame-rate   成片帧率 = 档位帧率，且作品描述的 fps = 档位帧率
//   delivery.duration     视频时长 = frameCount ÷ 档位帧率（误差 ≤ 1 帧）
//   delivery.size         成片画幅 = 档位画幅，且作品描述的画幅 = 档位画幅
//   delivery.color        tv / bt709 ×3        delivery.audio-stream  有音轨（audio.mode = none 时不要求）
//   texts.contract        只记视口：--size，缺省取作品描述的画幅、再缺省档位（与 tools/qa/checks/texts.mjs 相同）——不开页面
// 收到的参数原样记在报告的 stubArgs 里，端到端测试据此核对编排器交给 QA 的作品描述、视口与事件表。
// QA_STUB_FAIL=1 时故意让「帧数」一项不通过；QA_STUB_EXIT 指定退出码（测缺环境、参数不匹配）。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const a = process.argv.slice(2);
if (a.includes('--help')) { console.log('用法：node tests/film/fixtures/qa-stub.mjs report <成片> --film <作品描述> --out <目录> [--page <目录>] [--size <宽x高>] [--events <事件表>] [--profile <档位>] --json\n退出码：0 通过、4 不通过'); process.exit(0); }
const envelope = (exitCode, result, error = null, outputs = []) => JSON.stringify({ schemaVersion: 1, ok: exitCode === 0, exitCode, command: 'qa report', error, outputs, runJson: null, warnings: [], result });
if (process.env.QA_STUB_EXIT) {
  const code = Number(process.env.QA_STUB_EXIT);
  process.stdout.write(envelope(code, null, { code: code === 3 ? 'env' : 'usage', message: `qa-stub：按 QA_STUB_EXIT=${code} 退出`, hint: null }) + '\n');
  process.exit(code);
}
const opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
const [sub, file] = a;
if (sub !== 'report' || !file || !opt('--film') || !opt('--out')) { console.error('qa-stub：用法错误'); process.exit(2); }

// 作品描述与档位：用真 QA 的库读（同一把尺子）
const { loadFilm } = await import(new URL('../../../tools/qa/lib/film.mjs', import.meta.url).href);
const { loadProfiles, resolveProfile, fpsOf } = await import(new URL('../../../tools/qa/lib/profiles.mjs', import.meta.url).href);
const film = loadFilm(path.resolve(opt('--film')));
const profile = resolveProfile(loadProfiles({ root: ROOT }), opt('--profile'), film);
const pfps = fpsOf(profile).value;

const j = JSON.parse(execFileSync(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-count_frames', '-show_entries',
  'stream=codec_type,nb_read_frames,width,height,r_frame_rate,duration,color_range,color_space,color_transfer,color_primaries', '-of', 'json', file], { encoding: 'utf8' }));
const v = j.streams.find(s => s.codec_type === 'video');
const au = j.streams.find(s => s.codec_type === 'audio');
const frames = Number(v.nb_read_frames);
const [rn, rd] = String(v.r_frame_rate).split('/').map(Number);
const rate = rn / (rd || 1);
const color = [v.color_range, v.color_space, v.color_transfer, v.color_primaries].join('/');
const want = film.frameCount;
const fail = (id, problems, value, expected) => ({ id, status: problems.length ? 'fail' : 'pass', value, expected, findings: problems.map(message => ({ status: 'fail', message })) });
const filmFps = film.fps?.value ?? null;
const viewport = opt('--size') ? opt('--size').split('x').map(Number) : [film.width || profile.width, film.height || profile.height];
const checks = [
  fail('delivery.frame-count', [...(frames !== want ? [`实际 ${frames} 帧，作品描述要求 ${want} 帧`] : []), ...(process.env.QA_STUB_FAIL ? ['QA_STUB_FAIL=1：故意不通过'] : [])], frames, want),
  fail('delivery.frame-rate', [...(Math.abs(rate - pfps) > 1e-6 ? [`成片帧率 ${v.r_frame_rate}，档位要求 ${pfps}`] : []), ...(filmFps !== null && Math.abs(filmFps - pfps) > 1e-6 ? [`作品描述的 fps（${filmFps}）与档位（${pfps}）不一致`] : [])], v.r_frame_rate, pfps),
  fail('delivery.duration', Math.abs(Number(v.duration) - want / pfps) > 1 / pfps + 1e-6 ? [`视频时长 ${v.duration} 秒，应为 ${(want / pfps).toFixed(4)} 秒`] : [], Number(v.duration), want / pfps),
  fail('delivery.size', [...(v.width !== profile.width || v.height !== profile.height ? [`画幅 ${v.width}×${v.height}，档位 ${profile.id} 要求 ${profile.width}×${profile.height}`] : []),
    ...(film.width && film.height && (film.width !== profile.width || film.height !== profile.height) ? [`作品描述的画幅 ${film.width}×${film.height} 与档位 ${profile.id} 不一致`] : [])], `${v.width}×${v.height}`, `${profile.width}×${profile.height}`),
  fail('delivery.color', color === 'tv/bt709/bt709/bt709' ? [] : [`色彩标记 ${color}`], color, 'tv/bt709/bt709/bt709'),
  fail('delivery.audio-stream', au || film.audioMode === 'none' ? [] : ['没有音轨'], !!au, film.audioMode === 'none' ? '不要求' : true),
  ...(opt('--page') ? [{ id: 'texts.contract', status: 'pass', value: '替身不开页面，只记视口', evidence: { viewport } }] : []),
];
const ok = checks.every(c => c.status !== 'fail');
const out = path.resolve(opt('--out'));
fs.mkdirSync(out, { recursive: true });
const reportPath = path.join(out, 'report.json');
const report = {
  schemaVersion: 1, film: film.id || null, input: { path: file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') },
  profile: profile.id, checks, ok, skipped: opt('--page') ? [] : [{ group: 'texts', reason: '没有页面' }], warnings: [],
  summary: { pass: checks.filter(c => c.status === 'pass').length, warn: 0, fail: checks.filter(c => c.status === 'fail').length, waived: 0, hardFailures: checks.filter(c => c.status === 'fail').map(c => c.id) },
  stubArgs: { film: opt('--film'), page: opt('--page'), size: opt('--size'), events: opt('--events'), profile: opt('--profile') },
  technicalAcceptance: { status: ok ? 'passed' : 'failed', evidence: [reportPath] }, by: 'tests/film/fixtures/qa-stub.mjs（测试替身）',
};
fs.writeFileSync(reportPath, JSON.stringify(report, null, 1) + '\n');
process.stdout.write(envelope(ok ? 0 : 4, report, ok ? null : { code: 'qa.gate', message: `硬门不通过：${report.summary.hardFailures.join('、')}`, hint: null }, [{ path: reportPath, sha256: null, kind: 'qa-report' }]) + '\n');
process.exit(ok ? 0 : 4);
