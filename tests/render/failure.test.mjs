// 渲染器 v2 · 失败语义（R1）：每个失败夹具都要在 30 秒内按退出码表（engine/render/README.md「退出码」）退出，
// 报错里点名原因与下一步，不留 .segs-* / 锁 / 半成品，不留子进程（POSIX 上逐个查运行期间出现过的子孙进程），
// 没有成片文件；--json 时 stdout 是一个信封对象，error.code 是稳定标识。
// 真的启动无头 Chrome 与 FFmpeg；没装时整组跳过。夹具在 tests/render/fixtures/。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { run, skip, tmp, segs, FIX, posix } from './helpers.mjs';

const PAGE = `${FIX}/page`, WEBGL = `${FIX}/webgl`;
const video = (out, film, ...args) => ['engine/render/video.mjs', [film, '--size', '64x64', '--workers', '2', '--out', out, '--json', ...args]];

// [名字, 影片, 额外参数, 环境变量, 期望退出码, 期望 error.code, 日志里应出现的话]
const CASES = [
  ['render 同步抛错', PAGE, ['--query', 'fail=throw&at=5'], {}, 1, 'render-throw', /render 出错：Error: 注入的渲染错误：第 5 帧/],
  ['render 返回 reject 的 Promise', PAGE, ['--query', 'fail=reject&at=3'], {}, 1, 'render-throw', /注入的异步渲染错误/],
  ['页面未捕获的异步异常', PAGE, ['--query', 'fail=pageerror&at=5'], {}, 1, 'page-error', /页面错误：注入的页面错误/],
  ['缺必需的脚本（404）', PAGE, ['--query', 'fail=missing-script'], {}, 1, 'asset-missing', /缺少文件 \/tests\/render\/fixtures\/page\/does-not-exist\.js（script，HTTP 404）/],
  ['缺图片（404，严格模式默认判失败）', PAGE, ['--query', 'fail=missing-image'], {}, 1, 'asset-missing', /does-not-exist\.png（image，HTTP 404）/],
  ['页面访问外网（默认拦截）', PAGE, ['--query', 'fail=network'], {}, 1, 'network-blocked', /example\.invalid[\s\S]*--allow-network/],
  ['着色器编译失败', WEBGL, ['--query', 'fail=shader'], {}, 1, 'shader-error', /着色器编译失败：THREE\.WebGLProgram: Shader Error/],
  ['渲染中途 WebGL 上下文丢失', WEBGL, ['--query', 'fail=ctxlost&at=5'], {}, 1, 'context-lost', /WebGL 上下文丢失/],
  ['永不置 READY（等就绪超时）', PAGE, ['--query', 'fail=never', '--ready-timeout', '2'], {}, 124, 'ready-timeout', /没有置 window\.READY = true/],
  ['render 卡死（单帧超时）', PAGE, ['--query', 'fail=hang&at=5', '--frame-timeout', '1'], {}, 124, 'frame-timeout', /render\(t\) 超过 1 秒没有返回/],
  ['缺 window.DUR', PAGE, ['--query', 'dur=none'], {}, 4, 'contract-dur', /window\.DUR 必须是正数（秒），收到 undefined/],
  ['DUR 是 NaN：照实写出 NaN', PAGE, ['--query', 'dur=abc'], {}, 4, 'contract-dur', /收到 NaN/],
  ['window.render 不是函数', PAGE, ['--query', 'fail=norender'], {}, 4, 'contract-render', /window\.render 必须是函数/],
  ['window.TEXTS 不是函数', PAGE, ['--query', 'fail=texts'], {}, 4, 'contract-texts', /window\.TEXTS 必须是函数/],
  ['页面约定版本不认识', PAGE, ['--query', 'fail=version'], {}, 4, 'contract-version', /BEIMING_CONTRACT=2/],
  ['页面 FPS 是 NaN', PAGE, ['--query', 'fps=abc'], {}, 4, 'contract-fps', /window\.FPS 必须是正数，收到 NaN/],
  ['--fps 与页面声明的 FPS 不一致', PAGE, ['--query', 'fps=30', '--fps', '24'], {}, 4, 'contract-fps-mismatch', /与页面声明的 window\.FPS=30 不一致/],
  ['页面没声明 FPS（按 24）时 --fps 30', PAGE, ['--fps', '30'], {}, 4, 'contract-fps-mismatch', /页面没有声明 window\.FPS[\s\S]*--any-fps/],
  ['要求 GPU 却落到软件渲染', PAGE, [], { BEIMING_GPU: 'required', BEIMING_ANGLE: 'swiftshader' }, 3, 'software-gl', /软件渲染[\s\S]*--gpu software-ok/],
  ['ANGLE 后端写错', PAGE, [], { BEIMING_ANGLE: 'metla' }, 2, 'usage', /BEIMING_ANGLE=metla/],
  ['找不到 FFmpeg', PAGE, [], { FFMPEG: '/nonexistent/ffmpeg' }, 3, 'ffmpeg-missing', /找不到能运行的 FFmpeg/],
  ['找不到影片页面', 'tests/render/fixtures/nope', [], {}, 2, 'film-not-found', /找不到影片页面/],
  ['不认识的选项', PAGE, ['--sizee', '64x64'], {}, 2, 'usage', /不认识的选项 --sizee/],
  ['--workers 不是正整数', PAGE, ['--workers', 'abc'], {}, 2, 'usage', /--workers 必须是整数/],
  ['--frames 超出片长', PAGE, ['--frames', '0:99'], {}, 2, 'usage', /超出片长/],
];

test('video.mjs：失败夹具都在 30 秒内按退出码表退出，不留临时文件、锁、半成品与子进程', { skip, timeout: 600000 }, async t => {
  for (const [name, film, extra, env, code, errCode, pattern] of CASES) {
    await t.test(name, async () => {
      const dir = tmp();
      try {
        const [script, args] = video(join(dir, 'v.mp4'), film, ...extra);
        const r = await run(script, args, { env });
        assert.equal(r.signal, null, `${name}：被超时杀掉（挂住了）\n${r.log}`);
        assert.ok(r.ms < 30000, `${name}：用了 ${r.ms} ms`);
        assert.equal(r.code, code, r.log);
        const env1 = JSON.parse(r.stdout);
        assert.equal(env1.ok, false);
        assert.equal(env1.exitCode, code);
        assert.equal(env1.error.code, errCode, r.log);
        assert.ok(env1.error.hint, '要给出下一步');
        assert.match(r.log, pattern);
        assert.deepEqual(segs(dir), [], '临时目录、锁或半成品没删');
        assert.equal(existsSync(join(dir, 'v.mp4')), false, '失败时不能留下成片');
        assert.deepEqual(r.leftovers, [], '残留子进程');
        if (existsSync(join(dir, 'v.mp4.run.json'))) {
          const rec = JSON.parse(readFileSync(join(dir, 'v.mp4.run.json'), 'utf8'));
          assert.equal(rec.status, 'failed');
          assert.equal(rec.error.code, errCode);
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});

test('still.mjs：页面报错、着色器错误、参数写错都以约定的退出码退出，不留半成品', { skip, timeout: 120000 }, async t => {
  const cases = [
    ['render 抛错', [PAGE, '--frame', '5', '--query', 'fail=throw&at=5'], 1, /render 出错/],
    ['着色器编译失败', [WEBGL, '--frame', '0', '--query', 'fail=shader'], 1, /着色器编译失败/],
    ['--range 步长为 0（不死循环）', [PAGE, '--range', '0:9.5:0'], 2, /步长/],
    ['--range 漏写步长', [PAGE, '--range', '0:9.5'], 2, /三段/],
    ['时刻不是数字', [PAGE, 'abc'], 2, /时刻/],
    ['帧号超出片长', [PAGE, '--frame', '99'], 2, /超出片长/],
    ['不认识的选项', [PAGE, '--sizee', '64x64'], 2, /不认识的选项/],
  ];
  for (const [name, args, code, pattern] of cases) {
    await t.test(name, async () => {
      const dir = tmp();
      try {
        const r = await run('engine/render/still.mjs', [...args, '--size', '64x64', '--out', join(dir, 's')], { timeout: 30000 });
        assert.equal(r.signal, null, r.log);
        assert.equal(r.code, code, r.log);
        assert.match(r.log, pattern);
        assert.deepEqual(segs(join(dir, 's')), []);
        assert.deepEqual(r.leftovers, []);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});

test('video.mjs：收到 SIGTERM / SIGINT、FFmpeg 中途被杀，都能收尾退出（143 / 130 / 1）', { skip: skip || (!posix && '需要 POSIX 信号与 pgrep'), timeout: 180000 }, async t => {
  const isFfmpeg = pid => { try { return /ffmpeg/.test(execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })); } catch { return false; } };
  for (const [name, code, pattern] of [['SIGTERM', 143, /收到 SIGTERM/], ['SIGINT', 130, /收到 SIGINT/], ['FFmpeg 被 SIGKILL', 1, /FFmpeg/]]) {
    await t.test(name, async () => {
      const dir = tmp();
      try {
        let injected = false;
        const [script, args] = video(join(dir, 'v.mp4'), PAGE, '--query', 'dur=4&slow=30');
        const r = await run(script, args, {
          onStart: (p, kids) => {
            const poll = setInterval(() => {
              if (injected || p.exitCode !== null) return clearInterval(poll);
              const ff = kids().find(isFfmpeg);
              if (!ff) return;                       // 等到 FFmpeg 起来（正在渲染）再注入
              if (name === 'FFmpeg 被 SIGKILL') process.kill(ff, 'SIGKILL'); else process.kill(p.pid, name);
              injected = true;
            }, 100);
          },
        });
        assert.ok(injected, `没注入成功\n${r.log}`);
        assert.equal(r.signal, null, `挂住了\n${r.log}`);
        assert.equal(r.code, code, r.log);
        assert.match(r.log, pattern);
        assert.deepEqual(segs(dir), []);
        assert.equal(existsSync(join(dir, 'v.mp4')), false);
        assert.deepEqual(r.leftovers, [], '残留子进程');
        assert.equal(JSON.parse(readFileSync(join(dir, 'v.mp4.run.json'), 'utf8')).status, 'failed');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});

test('输出锁：同一个 --out 并发第二个渲染退出码 5，第一个照常完成', { skip, timeout: 120000 }, async () => {
  const dir = tmp();
  try {
    const out = join(dir, 'v.mp4');
    const first = run('engine/render/video.mjs', [PAGE, '--size', '64x64', '--out', out, '--query', 'dur=3&slow=20', '--progress', 'none']);
    // 等第一个拿到锁
    for (let i = 0; i < 100 && !existsSync(`${out}.lock`); i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(existsSync(`${out}.lock`), '第一个渲染没建锁');
    const second = await run('engine/render/video.mjs', [PAGE, '--size', '64x64', '--out', out, '--json']);
    assert.equal(second.code, 5, second.log);
    assert.equal(JSON.parse(second.stdout).error.code, 'output-locked');
    assert.match(second.log, /换一个 --out/);
    const a = await first;
    assert.equal(a.code, 0, a.log);
    assert.equal(existsSync(`${out}.lock`), false, '锁要在结束时释放');
    assert.equal(JSON.parse(readFileSync(`${out}.run.json`, 'utf8')).status, 'rendered', '第二个不能覆盖第一个的运行记录');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--help 输出用法、退出码 0、不启动浏览器也不写任何文件', { timeout: 60000 }, async () => {
  for (const script of ['engine/render/video.mjs', 'engine/render/still.mjs', 'engine/render/shots.mjs', 'engine/render/serve.mjs', 'engine/render/lib/mux.mjs', 'tools/rtx/gpucheck.mjs']) {
    const dir = tmp();
    try {
      const r = await run(script, ['--help', '--out', join(dir, 'x', 'v.mp4')], { timeout: 15000 });
      assert.equal(r.code, 0, `${script}\n${r.log}`);
      assert.match(r.stdout, /^用法：/, script);
      assert.match(r.stdout, /退出码：0 成功/);
      assert.equal(existsSync(join(dir, 'x')), false, `${script} --help 不能建目录`);
      assert.deepEqual(r.leftovers, []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
