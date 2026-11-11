// 渲染管线回归测试：真的启动无头 Chrome 与 FFmpeg，用 tests/production/fixtures/film 注入失败。
// 没装 FFmpeg / ffprobe 或 Playwright 的 chromium-headless-shell 时整组跳过（npm run setup 会装浏览器）。
// 每个失败场景都要在有限时间内以非零码退出，并删掉 <输出目录>/.segs-*；成功时帧数与色彩标记正确。
// 另外覆盖：页面帧率检查（没声明按 24、--any-fps）、指向仓库外的影片目录链接、mux.sh 的各种输入色彩矩阵、
// CRLF 检出时脚本去掉 CR 自行重跑、UTF-8 区域设置下中文提示不被吞字。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findSh } from '../../tools/env/lib/sh.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FILM = 'tests/production/fixtures/film';
// 同步子进程一律限时：spawnSync / execFileSync 会阻塞事件循环，node:test 的用例超时打断不了它，卡住的子进程只能靠这里的 timeout 收掉
const PROBE_MS = 10_000, TOOL_MS = 60_000, SCRIPT_MS = 120_000;
const has = cmd => spawnSync(cmd, ['-version'], { stdio: 'ignore', timeout: PROBE_MS }).status === 0;
const browserOk = (() => { try { return Boolean(process.env.BEIMING_CHROME) || existsSync(chromium.executablePath()); } catch { return false; } })();
const skip = !has('ffmpeg') || !has('ffprobe') ? '没有 FFmpeg / ffprobe' : !browserOk ? '没有 Playwright 浏览器（npm run setup）' : false;
const posix = process.platform !== 'win32';
// mux.sh 与 build.sh 要 POSIX sh：Windows 上用 Git for Windows 的 sh（tools/env/lib/sh.mjs 的 findSh），找不到才跳过
const SH = findSh().path;
const shSkip = SH ? false : '没有 POSIX sh（Windows 装 Git for Windows，或用 BEIMING_SH 指定 sh.exe）';

const tmp = () => mkdtempSync(join(tmpdir(), 'beiming-render-'));
const segs = dir => readdirSync(dir).filter(n => n.startsWith('.segs-'));
const probe = (file, entries) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', entries,
  '-of', 'default=nw=1', file], { encoding: 'utf8', timeout: TOOL_MS });

// 跑一个脚本并等它退出；超时就杀掉整个进程组并判失败（失败路径必须有限时间退出）
function run(script, args, { env = {}, timeout = 30000, onStart } = {}) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [script, ...args], { cwd: ROOT, env: { ...process.env, ...env }, detached: posix, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    p.stdout.on('data', d => { log += d; });
    p.stderr.on('data', d => { log += d; });
    const timer = setTimeout(() => { try { process.kill(posix ? -p.pid : p.pid, 'SIGKILL'); } catch {} }, timeout);
    onStart?.(p);
    p.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, log, ms: Date.now() - t0 }); });
  });
}
const video = (out, ...args) => ['engine/render/video.mjs', [FILM, '--size', '64x64', '--workers', '2', '--out', out, ...args]];

test('video.mjs：各种失败都在有限时间内非零退出，且不留 .segs-*', { skip, timeout: 240000 }, async t => {
  const cases = [
    ['render 抛错', ['--query', 'fail=throw&at=5'], {}, 1, /render 出错/],
    ['页面未捕获异常', ['--query', 'fail=pageerror&at=5'], {}, 1, /页面错误/],
    ['缺少必需脚本', ['--query', 'fail=missing'], {}, 1, /缺少必需文件/],
    ['等 READY 超时', ['--query', 'fail=never'], { BEIMING_READY_TIMEOUT: '1' }, 1, /超时/],
    ['render 卡死（单帧超时）', ['--query', 'fail=hang&at=5'], { BEIMING_FRAME_TIMEOUT: '1' }, 1, /没有返回/],
    ['DUR 不是正数', ['--query', 'dur=0'], {}, 1, /window\.DUR/],
    ['DUR 是 NaN：报错照实写出 NaN', ['--query', 'dur=abc'], {}, 1, /window\.DUR 必须是正数（秒），收到 NaN/],
    ['FPS 是 NaN：报错照实写出 NaN', ['--query', 'fps=abc'], {}, 1, /window\.FPS 必须是正数，收到 NaN/],
    ['--fps 与页面声明的 FPS 不一致', ['--query', 'fps=30', '--fps', '24'], {}, 2, /不一致/],
    ['页面没声明 FPS（按 24 量化）时 --fps 30 报错', ['--fps', '30'], {}, 2, /页面没有声明 window\.FPS[\s\S]*--any-fps/],
    ['找不到影片页面', [], {}, 2, /找不到影片页面/, 'tests/production/fixtures/nope'],
    ['--workers 不是正整数', ['--workers', 'abc'], {}, 2, /正整数/],
  ];
  for (const [name, extra, env, code, pattern, film] of cases) {
    await t.test(name, async () => {
      const dir = tmp();
      try {
        const [script, args] = video(join(dir, 'v.mp4'), ...extra);
        if (film) args[0] = film;
        const r = await run(script, args, { env });
        assert.equal(r.signal, null, `${name}：被超时杀掉（挂住了）\n${r.log}`);
        assert.equal(r.code, code, r.log);
        assert.match(r.log, pattern);
        assert.deepEqual(segs(dir), [], '临时目录没删');
        assert.equal(existsSync(join(dir, 'v.mp4')), false);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});

test('video.mjs：FFmpeg 中途被杀、收到 SIGTERM 都能收尾退出', { skip: skip || (!posix && '需要 POSIX 信号与 pgrep'), timeout: 120000 }, async t => {
  const ffmpegChild = pid => {
    try { return Number(execFileSync('pgrep', ['-P', String(pid), 'ffmpeg'], { encoding: 'utf8', timeout: PROBE_MS }).trim().split('\n')[0]) || null; } catch { return null; }
  };
  for (const [name, inject, code, pattern] of [
    ['FFmpeg 被 SIGKILL', p => { const ff = ffmpegChild(p.pid); if (ff) { process.kill(ff, 'SIGKILL'); return true; } return false; }, 1, /FFmpeg 在第 \d 段中途退出/],
    ['SIGTERM', p => { process.kill(p.pid, 'SIGTERM'); return true; }, 143, /收到 SIGTERM/],
  ]) {
    await t.test(name, async () => {
      const dir = tmp();
      try {
        let injected = false;
        const [script, args] = video(join(dir, 'v.mp4'), '--query', 'dur=3&slow=40');
        const r = await run(script, args, {
          onStart: p => {
            const poll = setInterval(() => { if (!injected && ffmpegChild(p.pid)) { injected = inject(p); } if (injected || p.exitCode !== null) clearInterval(poll); }, 100);
          },
        });
        assert.ok(injected, '没注入成功');
        assert.equal(r.signal, null, `挂住了\n${r.log}`);
        assert.equal(r.code, code, r.log);
        assert.match(r.log, pattern);
        assert.deepEqual(segs(dir), []);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});

test('video.mjs：成功时帧数 = round(DUR × fps)，输出有限范围 BT.709 并写明标记；页面声明的 FPS 被采用', { skip, timeout: 60000 }, async () => {
  const dir = tmp();
  try {
    let r = await run(...video(join(dir, 'v.mp4'), '--query', 'dur=1'));
    assert.equal(r.code, 0, r.log);
    const info = probe(join(dir, 'v.mp4'), 'stream=nb_read_packets,color_range,color_space,color_primaries,color_transfer');
    for (const want of ['nb_read_packets=24', 'color_range=tv', 'color_space=bt709', 'color_primaries=bt709', 'color_transfer=bt709']) assert.ok(info.includes(want), info);
    r = await run(...video(join(dir, 'v30.mp4'), '--query', 'dur=1&fps=30'));
    assert.equal(r.code, 0, r.log);
    const fps30 = /r_frame_rate=30\/1[\s\S]*nb_read_packets=30|nb_read_packets=30[\s\S]*r_frame_rate=30\/1/;
    assert.match(probe(join(dir, 'v30.mp4'), 'stream=nb_read_packets,r_frame_rate'), fps30);
    // 页面没声明 FPS：--any-fps 明确跳过检查才按 30 fps 渲，并打印提示
    r = await run(...video(join(dir, 'any30.mp4'), '--query', 'dur=1', '--fps', '30', '--any-fps'));
    assert.equal(r.code, 0, r.log);
    assert.match(r.log, /\[提示\] --any-fps/);
    assert.match(probe(join(dir, 'any30.mp4'), 'stream=nb_read_packets,r_frame_rate'), fps30);
    assert.deepEqual(segs(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('still.mjs：--range 写错立即报错（不启动浏览器）；经符号链接的路径也认得出仓库', { skip, timeout: 60000 }, async t => {
  for (const bad of [['--range', '0:9.5:0'], ['--range', '0:9.5'], ['--sizee', '64x64'], ['abc']]) {
    await t.test(bad.join(' '), async () => {
      const r = await run('engine/render/still.mjs', [FILM, ...bad, '--out', join(tmpdir(), 'beiming-still-unused')], { timeout: 10000 });
      assert.equal(r.code, 2, r.log);
    });
  }
  if (!posix) return;
  await t.test('符号链接', async () => {
    const dir = tmp();
    try {
      const link = join(dir, 'link');
      symlinkSync(ROOT, link);
      const r = await run(join(link, 'engine/render/still.mjs'), [join(link, FILM), '0', '0.5', '--size', '64x64', '--out', join(dir, 'stills')]);
      assert.equal(r.code, 0, r.log);
      assert.deepEqual(readdirSync(join(dir, 'stills')).sort(), ['s_0.5.jpg', 's_0.jpg']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  // 仓库里的影片目录本身是指向仓库外的链接：照样能渲（静态服务器跟随链接）；仓库外的目录仍然拒绝。
  // 用临时“迷你仓库”（engine/render 的脚本 + 指向本仓库 node_modules 的链接），不在本仓库里建链接
  await t.test('影片目录是指向仓库外的链接', async () => {
    const dir = tmp();
    try {
      const repo = join(dir, 'repo'), outside = join(dir, 'outside', 'film');
      mkdirSync(join(repo, 'engine', 'render'), { recursive: true });
      for (const f of ['page.mjs', 'still.mjs', 'args.mjs']) copyFileSync(join(ROOT, 'engine/render', f), join(repo, 'engine/render', f));
      symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'));
      mkdirSync(outside, { recursive: true });
      copyFileSync(join(ROOT, FILM, 'index.html'), join(outside, 'index.html'));
      mkdirSync(join(repo, 'films'));
      symlinkSync(outside, join(repo, 'films', 'ext'));
      const still = join(repo, 'engine/render/still.mjs');
      let r = await run(still, [join(repo, 'films', 'ext'), '0', '--size', '64x64', '--out', join(dir, 'stills')]);
      assert.equal(r.code, 0, r.log);
      assert.deepEqual(readdirSync(join(dir, 'stills')), ['s_0.jpg']);
      r = await run(still, [outside, '0', '--size', '64x64', '--out', join(dir, 'stills2')]);
      assert.equal(r.code, 2, r.log);
      assert.match(r.log, /找不到影片页面/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

test('mux.sh：音频短几毫秒也不丢末帧；线性增益到 −14 LUFS、LRA 不变；帧率不符报错；输出 BT.709 标记', { skip: skip || shSkip, timeout: 120000 }, async () => {
  const dir = tmp();
  const ff = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a], { timeout: TOOL_MS });
  const mux = (...a) => spawnSync(SH, [join(ROOT, 'engine/render/mux.sh'), ...a], { encoding: 'utf8', timeout: SCRIPT_MS });
  const loud = file => {
    const m = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8', timeout: TOOL_MS }).stderr;
    const get = k => Number([...m.matchAll(new RegExp(`^\\s+${k}:\\s+(-?[\\d.]+)`, 'gm'))].at(-1)?.[1]);
    return { I: get('I'), LRA: get('LRA'), TP: get('Peak') };
  };
  try {
    ff('-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=24', '-frames:v', '101', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', join(dir, 'v101.mp4'));
    // 调制正弦（LRA 约 2–3），比 101 帧画面（4.208333 s）短 10 ms
    ff('-f', 'lavfi', '-i', 'aevalsrc=0.1*sin(2*PI*440*t)*(0.6+0.4*sin(2*PI*0.7*t)):s=48000:d=4.198333:c=stereo', join(dir, 'a.wav'));
    const r = mux(join(dir, 'v101.mp4'), join(dir, 'a.wav'), join(dir, 'o.mp4'));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const info = probe(join(dir, 'o.mp4'), 'stream=nb_read_packets,color_range,color_space,color_primaries,color_transfer');
    for (const want of ['nb_read_packets=101', 'color_range=tv', 'color_space=bt709', 'color_primaries=bt709', 'color_transfer=bt709']) assert.ok(info.includes(want), info);
    const src = loud(join(dir, 'a.wav')), out = loud(join(dir, 'o.mp4'));
    assert.ok(Math.abs(out.I + 14) <= 0.5, `I=${out.I}`);
    assert.ok(out.TP <= -1.2, `TP=${out.TP}`);
    assert.ok(Math.abs(out.LRA - src.LRA) <= 0.5, `线性增益不改 LRA：${src.LRA} → ${out.LRA}`);
    const bad = mux(join(dir, 'v101.mp4'), join(dir, 'a.wav'), join(dir, 'x.mp4'), '30');
    assert.equal(bad.status, 2, bad.stderr);
    // 输入没有范围标记（H.264 默认有限范围）：不能当全范围再压一次（那样黑会抬到约 16、白会掉到约 235）。
    // 用左黑右白的平涂画面，避开中间的边，逐像素比解码后的电平
    ff('-f', 'lavfi', '-i', 'color=c=black:s=32x64:r=24[a];color=c=white:s=32x64:r=24[b];[a][b]hstack[out0]', '-frames:v', '24',
      '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', join(dir, 'bw.mp4'));
    assert.ok(probe(join(dir, 'bw.mp4'), 'stream=color_range').includes('color_range=unknown'));
    assert.equal(mux(join(dir, 'bw.mp4'), join(dir, 'a.wav'), join(dir, 'bw-out.mp4')).status, 0);
    const rgb = (file, matrix) => execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf',
      `scale=flags=accurate_rnd+full_chroma_int:in_range=limited:in_color_matrix=${matrix},format=rgb24`, '-f', 'rawvideo', '-'], { timeout: TOOL_MS });
    const a = rgb(join(dir, 'bw.mp4'), 'bt601'), b = rgb(join(dir, 'bw-out.mp4'), 'bt709');
    let worst = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      if (x >= 24 && x < 40) continue;
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(a[(y * 64 + x) * 3 + c] - b[(y * 64 + x) * 3 + c]));
    }
    assert.ok(worst <= 2, `黑白平涂区解码后最大差 ${worst} 级`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 平涂四色块（32×32 一块）编成指定矩阵的输入，经 mux.sh 后按成片标记精确解码，比色块内部（离块边 6 像素以上）
const PATCHES = [[0xC0, 0x30, 0x20], [0x20, 0xA0, 0x40], [0x30, 0x50, 0xC0], [0xE0, 0xD0, 0xB0]];
const PATCH_SRC = 'color=c=0xC03020:s=32x32:r=24[a];color=c=0x20A040:s=32x32:r=24[b];color=c=0x3050C0:s=32x32:r=24[c];'
  + 'color=c=0xE0D0B0:s=32x32:r=24[d];[a][b]hstack[t];[c][d]hstack[u];[t][u]vstack,format=rgb24[out0]';
function patchError(rgb) {
  let worst = 0;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    if (x % 32 < 6 || x % 32 >= 26 || y % 32 < 6 || y % 32 >= 26) continue;
    const want = PATCHES[(y >= 32 ? 2 : 0) + (x >= 32 ? 1 : 0)];
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(rgb[(y * 64 + x) * 3 + c] - want[c]));
  }
  return worst;
}

test('mux.sh：bt2020nc、fcc、smpte240m、RGB（libx264rgb）输入换算成 BT.709 并保留原色 / 传递特性；换算不了的矩阵原样透传', { skip: skip || shSkip, timeout: 120000 }, async t => {
  const dir = tmp();
  const ff = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a], { timeout: TOOL_MS });
  const SW = 'flags=accurate_rnd+full_chroma_int';
  try {
    ff('-f', 'lavfi', '-i', 'aevalsrc=0.1*sin(2*PI*440*t)*(0.6+0.4*sin(2*PI*0.7*t)):s=48000:d=1:c=stereo', join(dir, 'a.wav'));
    const make = (name, ...enc) => { ff('-f', 'lavfi', '-i', PATCH_SRC, '-frames:v', '24', ...enc, join(dir, `${name}.mp4`)); return join(dir, `${name}.mp4`); };
    const tags = file => probe(file, 'stream=color_range,color_space,color_primaries,color_transfer');
    const mux = (input, name) => spawnSync(SH, [join(ROOT, 'engine/render/mux.sh'), input, join(dir, 'a.wav'), join(dir, `${name}-out.mp4`)], { encoding: 'utf8', timeout: SCRIPT_MS });
    const decode709 = file => execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf',
      `scale=in_range=limited:in_color_matrix=bt709:${SW},format=rgb24`, '-f', 'rawvideo', '-'], { timeout: TOOL_MS });
    for (const [name, enc, primaries, transfer] of [
      ['bt2020nc', ['-vf', `scale=out_color_matrix=bt2020:out_range=tv:${SW},format=yuv420p,setparams=colorspace=bt2020nc:range=tv:color_primaries=bt2020:color_trc=bt709`,
        '-c:v', 'libx264', '-qp', '0'], 'bt2020', 'bt709'],
      ['fcc', ['-vf', `scale=out_color_matrix=fcc:out_range=tv:${SW},format=yuv420p,setparams=colorspace=fcc:range=tv`, '-c:v', 'libx264', '-qp', '0'], 'bt709', 'bt709'],
      ['smpte240m', ['-vf', `scale=out_color_matrix=smpte240m:out_range=tv:${SW},format=yuv420p,setparams=colorspace=smpte240m:range=tv:color_primaries=smpte240m:color_trc=smpte240m`,
        '-c:v', 'libx264', '-qp', '0'], 'smpte240m', 'smpte240m'],
      ['rgb', ['-c:v', 'libx264rgb', '-qp', '0', '-pix_fmt', 'rgb24'], 'bt709', 'bt709'],
    ]) {
      await t.test(name, () => {
        const r = mux(make(name, ...enc), name);
        assert.equal(r.status, 0, r.stdout + r.stderr);
        const info = tags(join(dir, `${name}-out.mp4`));
        for (const want of ['color_range=tv', 'color_space=bt709', `color_primaries=${primaries}`, `color_transfer=${transfer}`]) assert.ok(info.includes(want), info);
        const worst = patchError(decode709(join(dir, `${name}-out.mp4`)));
        assert.ok(worst <= 3, `色块内部最大差 ${worst} 级`);
      });
    }
    await t.test('ycgco：原样透传，码值与标记不变', () => {
      const input = make('ycgco', '-vf', `scale=out_color_matrix=bt709:out_range=tv:${SW},format=yuv420p,setparams=colorspace=bt709:range=tv,`
        + 'colorspace=iall=bt709:irange=tv:space=ycgco:trc=bt709:primaries=bt709:range=tv:format=yuv420p', '-c:v', 'libx264', '-qp', '0');
      const r = mux(input, 'ycgco');
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stderr, /换算不了/);
      assert.ok(tags(join(dir, 'ycgco-out.mp4')).includes('color_space=ycgco'));
      const raw = file => execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { timeout: TOOL_MS });
      const a = raw(input), b = raw(join(dir, 'ycgco-out.mp4'));
      let worst = 0;
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
        if (x % 32 < 6 || x % 32 >= 26 || y % 32 < 6 || y % 32 >= 26) continue;
        worst = Math.max(worst, Math.abs(a[y * 64 + x] - b[y * 64 + x]));
      }
      assert.ok(worst <= 2, `亮度码值最大差 ${worst}`);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CRLF 检出：mux.sh 去掉 CR 后照常封装，build.sh 跑到参数解析；UTF-8 区域设置下中文提示不被吞字', { skip: skip || shSkip, timeout: 120000 }, async () => {
  const dir = tmp();
  const ff = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a], { timeout: TOOL_MS });
  const crlf = (src, dst) => { mkdirSync(join(dst, '..'), { recursive: true }); writeFileSync(dst, readFileSync(src, 'utf8').replace(/\n/g, '\r\n')); };
  try {
    crlf(join(ROOT, 'engine/render/mux.sh'), join(dir, 'engine/render/mux.sh'));
    crlf(join(ROOT, 'build.sh'), join(dir, 'build.sh'));
    ff('-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=24', '-frames:v', '24', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', join(dir, 'v.mp4'));
    ff('-f', 'lavfi', '-i', 'aevalsrc=0.1*sin(2*PI*440*t)*(0.6+0.4*sin(2*PI*0.7*t)):s=48000:d=1:c=stereo', join(dir, 'a.wav'));
    // macOS 的 /bin/sh（bash 3.2）在 UTF-8 区域设置下会把紧跟在 $变量 后面的中文首字节当成变量名的一部分
    const env = { ...process.env, LC_ALL: 'en_US.UTF-8' };
    const r = spawnSync(SH, ['engine/render/mux.sh', 'v.mp4', 'a.wav', 'o.mp4', '24'], { cwd: dir, encoding: 'utf8', env, timeout: SCRIPT_MS });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /CRLF 换行：已去掉 CR 后运行/);
    assert.match(r.stdout, /原色 bt709、传递特性 bt709）/);
    assert.ok(probe(join(dir, 'o.mp4'), 'stream=nb_read_packets').includes('nb_read_packets=24'));
    const b = spawnSync(SH, ['build.sh', '--bogus'], { cwd: dir, encoding: 'utf8', env: { ...env, WORKERS: 'abc' }, timeout: SCRIPT_MS });
    assert.equal(b.status, 2, b.stdout + b.stderr);
    assert.match(b.stderr, /不认识的参数：--bogus（可用/);
    const w = spawnSync(SH, ['build.sh'], { cwd: dir, encoding: 'utf8', env: { ...env, WORKERS: 'abc' }, timeout: SCRIPT_MS });
    assert.equal(w.status, 2, w.stdout + w.stderr);
    assert.match(w.stderr, /（收到 abc）/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
