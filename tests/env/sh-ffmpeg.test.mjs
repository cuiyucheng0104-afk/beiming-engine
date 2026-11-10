// 过渡期找 sh（tools/env/lib/sh.mjs）与 FFmpeg 能力探测的解析（tools/env/lib/ffmpeg.mjs）：全部用替身输入，不依赖本机装了什么。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { findSh, shFix } from '../../tools/env/lib/sh.mjs';
import { parseVersion, parseList, missingComponents, ffmpegBins } from '../../tools/env/lib/ffmpeg.mjs';

const W = path.win32;
const fsWith = files => p => files.has(p);

test('findSh：PATH 里有 sh 就用它；BEIMING_SH 指定的优先，指错了直接报出来', () => {
  const which = n => (n === 'sh' ? '/bin/sh' : null);
  assert.deepEqual(findSh({ env: {}, platform: 'linux', whichFn: which, exists: () => true }), { path: '/bin/sh', source: 'PATH' });
  assert.deepEqual(findSh({ env: { BEIMING_SH: '/opt/sh' }, platform: 'linux', whichFn: which, exists: p => p === '/opt/sh' }), { path: '/opt/sh', source: 'BEIMING_SH' });
  const broken = findSh({ env: { BEIMING_SH: '/opt/none' }, platform: 'linux', whichFn: which, exists: () => false });
  assert.equal(broken.path, null);
  assert.equal(broken.explicitBroken, true);
  const none = findSh({ env: {}, platform: 'darwin', whichFn: () => null, exists: () => false });
  assert.equal(none.path, null);
  assert.deepEqual(none.tried, ['PATH 里没有 sh']);
});

test('findSh（Windows）：从 PATH 里的 git.exe 反推 Git\\bin\\sh.exe；再看 Program Files 与用户级安装；不认 usr\\bin', () => {
  const gitCmd = 'D:\\Tools\\Git\\cmd\\git.exe';
  const shExe = W.join('D:\\Tools\\Git', 'bin', 'sh.exe');
  const which = n => (n === 'git' ? gitCmd : null);
  assert.deepEqual(findSh({ env: {}, platform: 'win32', whichFn: which, exists: fsWith(new Set([shExe])) }), { path: shExe, source: 'Git for Windows（D:\\Tools\\Git）' });
  const pf = W.join('C:\\Program Files', 'Git', 'bin', 'sh.exe');
  const r = findSh({ env: { ProgramFiles: 'C:\\Program Files' }, platform: 'win32', whichFn: () => null, exists: fsWith(new Set([pf])) });
  assert.equal(r.path, pf);
  const user = W.join('C:\\Users\\u\\AppData\\Local', 'Programs', 'Git', 'bin', 'sh.exe');
  assert.equal(findSh({ env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, platform: 'win32', whichFn: () => null, exists: fsWith(new Set([user])) }).path, user);
  // 只有 usr\bin\sh.exe（不带 MSYS 的 PATH 设置）不算
  const usr = W.join('C:\\Program Files', 'Git', 'usr', 'bin', 'sh.exe');
  const miss = findSh({ env: { ProgramFiles: 'C:\\Program Files' }, platform: 'win32', whichFn: () => null, exists: fsWith(new Set([usr])) });
  assert.equal(miss.path, null);
  assert.ok(miss.tried.some(t => t.includes(W.join('Git', 'bin', 'sh.exe'))));
  assert.match(shFix('win32'), /winget install --id Git\.Git -e/);
  assert.match(shFix('win32'), /BEIMING_SH/);
});

test('parseVersion：发行版、带 n 前缀、git 构建与日期型版本号都能得到主版本', () => {
  const rel = parseVersion('ffmpeg version 8.0.1 Copyright (c) 2000-2025 the FFmpeg developers\nbuilt with Apple clang\nconfiguration: --prefix=/opt --enable-libx264 --enable-gpl\nlibavutil      60.  8.100 / 60.  8.100\nlibavcodec     62. 11.100 / 62. 11.100\n');
  assert.equal(rel.version, '8.0.1');
  assert.equal(rel.major, 8);
  assert.equal(rel.libavcodecMajor, 62);
  assert.match(rel.configuration, /--enable-libx264/);
  assert.equal(parseVersion('ffmpeg version n7.1 Copyright\nlibavcodec     61. 19.100 / 61. 19.100').major, 7);
  const git = parseVersion('ffmpeg version N-118000-g1234abcd-20250101 Copyright\nlibavcodec     61. 31.100 / 61. 31.100');
  assert.equal(git.git, true);
  assert.equal(git.major, 7);       // 按 libavcodec 61 换算
  assert.equal(parseVersion('ffmpeg version 2025-01-01-git-abcdef-full_build-www.gyan.dev Copyright\nlibavcodec     62.  3.100 / 62.  3.100').major, 8);
  assert.equal(parseVersion('ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright\nlibavcodec     58.134.100 / 58.134.100').major, 4);
  assert.equal(parseVersion('').major, null);
});

test('parseList 与 missingComponents：按 -encoders / -filters / -muxers 的真实格式解析', () => {
  const encoders = parseList('Encoders:\n V..... = Video\n A..... = Audio\n ------\n V....D libx264              libx264 H.264 / AVC\n A....D aac                  AAC (Advanced Audio Coding)\n V....D png                  PNG image\n');
  assert.ok(encoders.has('libx264') && encoders.has('aac') && encoders.has('png'));
  assert.ok(!encoders.has('Video') && !encoders.has('='));
  const filters = parseList('Filters:\n  T.. = Timeline support\n  ... loudnorm          A->A       EBU R128 loudness normalization\n  ... ebur128           A->N       EBU R128 scanner.\n T.C scale             V->V       Scale the input video size\n');
  assert.ok(filters.has('loudnorm') && filters.has('ebur128') && filters.has('scale'));
  const muxers = parseList('Formats:\n D. = Demuxing supported\n --\n  E mp4             MP4 (MPEG-4 Part 14)\n DE wav,w64         WAV / WAVE\n');
  assert.ok(muxers.has('mp4') && muxers.has('wav') && muxers.has('w64'));
  const probe = { lists: { encoders, filters, muxers } };
  const miss = missingComponents(probe, { required: { encoders: ['libx264', 'aac'], filters: ['loudnorm', 'apad'] }, recommended: { muxers: ['framemd5'] } });
  assert.deepEqual(miss, { required: ['filters:apad'], recommended: ['muxers:framemd5'] });
});

test('ffmpegBins：尊重 FFMPEG / FFPROBE，空白当没设', () => {
  assert.deepEqual(ffmpegBins({}), { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
  assert.deepEqual(ffmpegBins({ FFMPEG: ' /opt/ff/ffmpeg ', FFPROBE: '' }), { ffmpeg: '/opt/ff/ffmpeg', ffprobe: 'ffprobe' });
});
