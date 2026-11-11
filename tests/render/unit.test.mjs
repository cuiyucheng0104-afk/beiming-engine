// 渲染器 v2 · 不开浏览器、不跑 FFmpeg 的单元测试：GPU 后端与策略的校验、参数取值、块切分、文字报告核对、
// AIGC 标识、错误归类、交付档位、加固过的静态服务器（真的起 HTTP，只在 127.0.0.1）。
//   node --test tests/render/unit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAngle, resolveGpuPolicy, enforceGpu, chromeArgs, platformDefaultAngle, isSoftwareRenderer } from '../../engine/render/lib/gpu.mjs';
import { parseSize, parseFrames, positiveNumber } from '../../engine/render/lib/command.mjs';
import { planChunks, planFilmChunks } from '../../engine/render/lib/chunks.mjs';
import { checkTexts } from '../../engine/render/lib/contract.mjs';
import { aigcMetadata, AIGC_PRODUCER } from '../../engine/render/lib/mux.mjs';
import { describeError, RenderError, EXIT } from '../../engine/render/lib/errors.mjs';
import { loadProfiles, resolveProfile } from '../../engine/render/lib/profiles.mjs';
import { resolveRequest, createServer } from '../../engine/render/lib/server.mjs';
import { runId, repoPath } from '../../engine/render/lib/record.mjs';
import { acquireLock, lockPath } from '../../engine/render/lib/lock.mjs';
import { tryTake, slotCount } from '../../engine/render/lib/slots.mjs';
import { spawnSync } from 'node:child_process';
import { parseImplicitLabel } from '../../tools/compliance/lib/aigc.mjs';
import { exitCodeFor } from '../../tools/lib/cli.mjs';

const throwsCode = (fn, code) => assert.throws(fn, e => e instanceof RenderError && e.code === code && e.exitCode === exitCodeFor(code), `应抛 ${code}`);

test('ANGLE 后端：先转小写再按平台校验；Mac 上的 vulkan、Windows 上的 metal 直接报错；平台默认 macOS metal、Windows vulkan、Linux default', () => {
  assert.equal(resolveAngle(undefined, { platform: 'darwin', env: {} }).angle, 'metal');
  assert.equal(resolveAngle(undefined, { platform: 'win32', env: {} }).angle, 'vulkan');
  assert.equal(resolveAngle(undefined, { platform: 'linux', env: {} }).angle, 'default');
  assert.deepEqual(resolveAngle(undefined, { platform: 'win32', env: { BEIMING_ANGLE: ' Vulkan ' } }), { angle: 'vulkan', source: 'BEIMING_ANGLE' });
  assert.deepEqual(resolveAngle('D3D11', { platform: 'win32', env: { BEIMING_ANGLE: 'vulkan' } }), { angle: 'd3d11', source: '--angle' });
  throwsCode(() => resolveAngle(undefined, { platform: 'darwin', env: { BEIMING_ANGLE: 'vulkan' } }), 'usage.angle');
  throwsCode(() => resolveAngle('metal', { platform: 'win32', env: {} }), 'usage.angle');
  throwsCode(() => resolveAngle(undefined, { platform: 'linux', env: { BEIMING_ANGLE: 'vulcan' } }), 'usage.angle');
  assert.equal(platformDefaultAngle('freebsd'), 'default');
  assert.deepEqual(chromeArgs('default').filter(a => a.startsWith('--use-angle')), [], 'default 不传 --use-angle');
  assert.ok(chromeArgs('metal').includes('--use-angle=metal'));
});

test('GPU 策略：--gpu 优先于 BEIMING_GPU，默认 required；写错是用法错误；software-ok 时软件渲染不报错也不提示', () => {
  assert.equal(resolveGpuPolicy(undefined, { env: {} }), 'required');
  assert.equal(resolveGpuPolicy(undefined, { env: { BEIMING_GPU: 'software-ok' } }), 'software-ok');
  assert.equal(resolveGpuPolicy('required', { env: { BEIMING_GPU: 'software-ok' } }), 'required');
  assert.equal(resolveGpuPolicy(null, { env: { BEIMING_GPU: ' ANY ' } }), 'any');
  throwsCode(() => resolveGpuPolicy(undefined, { env: { BEIMING_GPU: 'softwareok' } }), 'usage.gpu-policy');
  const sw = { renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', webgl2: true };
  const hw = { renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0, D3D11)', webgl2: true };
  throwsCode(() => enforceGpu(sw, 'required', { angle: 'swiftshader' }), 'env.software-gl');
  assert.deepEqual(enforceGpu(sw, 'software-ok', { angle: 'swiftshader' }), { software: true, warnings: [] });
  assert.equal(enforceGpu(sw, 'any', { angle: 'swiftshader' }).warnings.length, 1);
  assert.deepEqual(enforceGpu(hw, 'required', { angle: 'd3d11' }), { software: false, warnings: [] });
  throwsCode(() => enforceGpu({ renderer: '', webgl2: false }, 'required', { angle: 'gl' }), 'env.webgl-unavailable');
  for (const s of ['llvmpipe (LLVM 15.0.7, 256 bits)', 'Microsoft Basic Render Driver', 'Google SwiftShader']) assert.ok(isSoftwareRenderer(s), s);
  assert.ok(!isSoftwareRenderer('ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)'));
});

test('参数取值：--size 宽高是 16–8192 的偶数；--frames 含头不含尾、止大于起；数值要大于 0', () => {
  assert.deepEqual(parseSize('1920x1080'), { w: 1920, h: 1080 });
  for (const bad of ['1920X1080', '1921x1080', '8x8', '9000x2', 'abc', '']) throwsCode(() => parseSize(bad), 'usage.bad-value');
  assert.deepEqual(parseFrames('72:120'), { a: 72, b: 120, step: 1 });
  assert.deepEqual(parseFrames('0:240:24', { allowStep: true }), { a: 0, b: 240, step: 24 });
  for (const bad of ['9:3', '5:5', '0:240:24', '-1:5', '1.5:3', 'a:b', '3']) throwsCode(() => parseFrames(bad), 'usage.bad-value');
  throwsCode(() => parseFrames('0:9:0', { allowStep: true }), 'usage.bad-value');
  assert.equal(positiveNumber(null, '--fps'), null);
  assert.equal(positiveNumber(24, '--fps'), 24);
  throwsCode(() => positiveNumber(0, '--fps'), 'usage.bad-value');
  throwsCode(() => positiveNumber(-1, '--ready-timeout'), 'usage.bad-value');
});

test('块切分与 --workers 无关：只由区间与帧率决定；覆盖整个区间、不重叠；sequential 镜头整段一块、不能从中间起渲', () => {
  const cover = (chunks, a, b) => {
    assert.equal(chunks[0][0], a); assert.equal(chunks.at(-1)[1], b);
    for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i][0], chunks[i - 1][1]);
    for (const [x, y] of chunks) assert.ok(y > x);
  };
  const c240 = planChunks(0, 240, { fps: 24 });
  cover(c240, 0, 240);
  assert.equal(c240.length, 8, '240 帧按总帧 / 8 切成 8 块');
  cover(planChunks(0, 2400, { fps: 24 }), 0, 2400);
  assert.ok(planChunks(0, 2400, { fps: 24 }).every(([x, y]) => y - x <= 240), '块长不超过 10 秒');
  assert.deepEqual(planChunks(72, 90, { fps: 24 }), [[72, 90]], '不到 1 秒的区间整段一块');
  assert.deepEqual(planChunks(72, 120, { fps: 24 }), [[72, 96], [96, 120]], '块长至少 1 秒');
  assert.deepEqual(planChunks(5, 5, { fps: 24 }), []);
  const shots = [{ id: 'S1', in: 0, out: 100 }, { id: 'S2', in: 100, out: 160, raw: { evaluation: 'sequential' } }, { id: 'S3', in: 160, out: 240 }];
  const film = planFilmChunks(0, 240, { shots, fps: 24 });
  cover(film, 0, 240);
  assert.ok(film.some(([x, y]) => x === 100 && y === 160), 'sequential 镜头整段一块');
  assert.ok(film.every(([x, y]) => !(x < 100 && y > 100) && !(x < 160 && y > 160)), '块不跨镜头边界');
  throwsCode(() => planFilmChunks(120, 200, { shots, fps: 24 }), 'usage.sequential-partial');
  // 区间在后面的镜头之前结束：空隙不能补到区间之外（前任实现的缺陷：--frames 30:90 会渲到第 160 帧）
  cover(planFilmChunks(30, 90, { shots, fps: 24 }), 30, 90);
  cover(planFilmChunks(170, 200, { shots, fps: 24 }), 170, 200);
  // 镜头表有空隙、有重叠：照样覆盖整个区间、不重复
  const gappy = [{ id: 'A', in: 10, out: 50 }, { id: 'B', in: 40, out: 80 }, { id: 'C', in: 120, out: 150 }];
  cover(planFilmChunks(0, 200, { shots: gappy, fps: 24 }), 0, 200);
});

test('文字报告：推荐写法通过；旧写法 x0/y0/x1/y1 换算成 box 并提示补 alpha 与 font；不是数组、抛错、缺字都点名', () => {
  const ok = checkTexts({ value: [{ text: '北冥', box: [10, 20, 100, 40], alpha: 1, font: '700 64px "Noto Serif SC"' }] }, { w: 1920, h: 1080 });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.entries[0].box, [10, 20, 100, 40]);
  const legacy = checkTexts({ value: [{ id: 'title', text: '北冥', x0: 10, y0: 20, x1: 110, y1: 60 }] });
  assert.deepEqual(legacy.entries[0].box, [10, 20, 100, 40]);
  assert.ok(legacy.problems.some(p => /旧写法/.test(p)) && legacy.problems.some(p => /缺 alpha/.test(p)) && legacy.problems.some(p => /缺 font/.test(p)));
  assert.match(checkTexts({ value: 42 }).problems[0], /应返回数组/);
  assert.match(checkTexts({ error: 'boom' }).problems[0], /抛错：boom/);
  assert.match(checkTexts({ missing: true }).problems[0], /没有 window\.TEXTS/);
  const bad = checkTexts({ value: [{ box: [0, 0, 1, 1], alpha: 2, font: '' }] }, { w: 64, h: 64 });
  assert.ok(bad.problems.some(p => /缺 text/.test(p)) && bad.problems.some(p => /alpha 要是 0–1/.test(p)) && bad.problems.some(p => /font 要是/.test(p)));
  assert.ok(checkTexts({ value: [{ text: 'x', box: [500, 500, 10, 10], alpha: 1, font: '10px a' }] }, { w: 64, h: 64 }).problems.some(p => /画面外/.test(p)));
});

test('AIGC 隐式标识：film.json 声明含 AI 生成内容时用 P01 的写法（AIGC{…} + 人读说明），ProduceID 是 <作品>@<运行号>；不含不写', () => {
  const film = { id: 'chendu', aigc: { contains: true, note: '底板 AI 生成', kinds: ['visual', 'voice'], tools: ['Midjourney V8'] } };
  const m = aigcMetadata({ film, runId: '20261110-120000-abc1234' });
  assert.equal(m.args[0], '-metadata');
  assert.ok(m.args[1].startsWith('comment=AIGC{'));
  const p = parseImplicitLabel(m.comment);
  assert.equal(p.ok, true, p.problems.join('；'));
  assert.equal(p.fields.ProduceID, 'chendu@20261110-120000-abc1234');
  assert.equal(p.fields.ContentProducer, AIGC_PRODUCER);
  assert.match(p.statement, /含 AI 生成画面；配音为 AI 合成（生成工具：Midjourney V8）/);
  assert.deepEqual(aigcMetadata({ film: { id: 'x', aigc: { contains: false } } }).args, []);
  assert.deepEqual(aigcMetadata({ film: { id: 'x' } }).args, []);
  assert.deepEqual(aigcMetadata({ film, kinds: ['none'] }).args, [], '--aigc none 压过 film.json');
  assert.equal(parseImplicitLabel(aigcMetadata({ kinds: ['music'], produceId: 'beiming@r1' }).comment).fields.ProduceID, 'beiming@r1');
  throwsCode(() => aigcMetadata({ kinds: ['video'] }), 'usage.bad-value');
  throwsCode(() => aigcMetadata({ kinds: ['none', 'visual'] }), 'usage.bad-value');
});

test('错误归类：错误码前缀决定退出码；别处带数字退出码的错误照退出码归类；未预期的记为 failure.internal', () => {
  for (const [code, exit] of [['usage.x', 2], ['env.x', 3], ['contract.x', 4], ['busy.x', 5], ['timeout.x', 124], ['failure.x', 1], ['signal.sigint', 130], ['signal.sigterm', 143]]) {
    assert.equal(new RenderError(code, 'm').exitCode, exit, code);
  }
  const legacy = Object.assign(new Error('--range 要写成 起:止:步长'), { name: 'UsageError', exitCode: 2 });
  assert.deepEqual(describeError(legacy), { code: 'usage.bad-value', message: '--range 要写成 起:止:步长', hint: '完整写法见 --help', exitCode: 2 });
  const d = describeError(new TypeError('x is not a function'));
  assert.equal(d.code, 'failure.internal');
  assert.equal(d.exitCode, EXIT.FAILURE);
  assert.match(d.hint, /BEIMING_DEBUG=1/);
});

test('交付档位：读取与兜底走 tools/lib/profiles.mjs（profiles.json 落地前用 D07 兜底表）；不认识的档位列出可用值；运行号符合附录 C4', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-prof-'));
  try {
    const { profiles, source } = loadProfiles(tmp);
    assert.equal(source, 'fallback');
    assert.deepEqual([...profiles.keys()].sort(), ['beiming-1040p24', 'broadcast-1080p25', 'master-1080p24', 'uhd-2160p24', 'vertical-1080x1920-30', 'web-1080p24']);
    assert.deepEqual([profiles.get('master-1080p24').video.crf, profiles.get('web-1080p24').video.crf], [10, 14], 'master-* 档位默认高码率母版');
    assert.equal(profiles.get('web-1080p24').audio.toleranceLU, 1);
    assert.deepEqual([profiles.get('vertical-1080x1920-30').width, profiles.get('vertical-1080x1920-30').height, profiles.get('vertical-1080x1920-30').fps], [1080, 1920, 30]);
    assert.equal(profiles.get('broadcast-1080p25').audio.targetLUFS, -23);
    assert.equal(profiles.get('beiming-1040p24').height, 1040);
    throwsCode(() => resolveProfile('web-1080p23', tmp), 'usage.profile-unknown');
    // profiles.json 的正式写法（作品描述包）：{ default, profiles: { id: { video: { width, height, fps }, audio: { loudness: { integratedLUFS } } } } }
    fs.mkdirSync(path.join(tmp, 'engine', 'production'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'engine', 'production', 'profiles.json'), JSON.stringify({ default: 'web-1080p24', profiles: { 'web-1080p24': { video: { width: 1920, height: 1080, fps: 24, crf: 16 }, audio: { loudness: { integratedLUFS: -16, toleranceLU: 0.5 }, truePeakMaxDbTP: -2 } } } }));
    const p = resolveProfile('web-1080p24', tmp);
    assert.equal(p.source, 'engine/production/profiles.json');
    assert.deepEqual([p.width, p.height, p.fps, p.video.crf, p.video.preset], [1920, 1080, 24, 16, 'medium']);
    assert.deepEqual([p.audio.targetLUFS, p.audio.toleranceLU, p.audio.truePeakDbTP], [-16, 0.5, -2]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  assert.match(runId({ sourceCommit: 'abcdef0123456789', dirty: true }, new Date(2026, 10, 10, 9, 5, 7)), /^20261110-090507-abcdef0-dirty$/);
  assert.match(runId({ sourceCommit: 'abcdef0123456789', dirty: false }), /^\d{8}-\d{6}-[0-9a-f]{7}$/);
});

test('静态服务器：只听 127.0.0.1；点文件 404、越界与链接逃逸 403、Host 不对 403、只收 GET / HEAD、目录给 index.html、支持 Range', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-srv-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-srv-out-')));
  try {
    fs.mkdirSync(path.join(root, 'films', 'x'), { recursive: true });
    fs.writeFileSync(path.join(root, 'films', 'x', 'index.html'), '<p>x</p>');
    fs.writeFileSync(path.join(root, 'clip.bin'), Buffer.from('0123456789'));
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, '.git', 'config'), '[core]');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
    assert.equal(resolveRequest(root, '/.git/config').status, 404);
    assert.equal(resolveRequest(root, '/films/../.env').status, 403);
    assert.equal(resolveRequest(root, '/%2e%2e/secret').status, 403);
    assert.equal(resolveRequest(root, '/a%00b').status, 400);
    assert.equal(resolveRequest(root, '/escape.txt').status, 403);
    assert.equal(resolveRequest(root, '/films/x/index.html').file, path.join(root, 'films', 'x', 'index.html'));

    const srv = createServer({ root });
    const { port, url } = await srv.listen(0);
    assert.equal(url, `http://127.0.0.1:${port}/`);
    const get = (p, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end();
    });
    try {
      assert.equal((await get('/films/x/')).body, '<p>x</p>', '目录给 index.html');
      assert.equal((await get('/films/x/')).headers['cache-control'], 'no-store');
      assert.equal((await get('/.git/config')).status, 404);
      assert.equal((await get('/.env')).status, 404);
      assert.equal((await get('/escape.txt')).status, 403);
      assert.equal((await get('/films/x/index.html', { headers: { Host: `evil.example:${port}` } })).status, 403, 'DNS 重绑定：Host 不对');
      assert.equal((await get('/films/x/index.html', { headers: { Host: `localhost:${port}` } })).status, 200);
      assert.equal((await get('/films/x/index.html', { method: 'POST' })).status, 405);
      assert.equal((await get('/favicon.ico')).status, 204);
      assert.equal((await get('/films/')).status, 404, '不列目录');
      const r = await get('/clip.bin', { headers: { Range: 'bytes=2-5' } });
      assert.equal(r.status, 206);
      assert.equal(r.body, '2345');
      assert.equal((await get('/clip.bin', { headers: { Range: 'bytes=20-' } })).status, 416);
      // 不听其他网卡：用本机的非回环地址连不上
      const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal);
      if (lan) {
        const refused = await new Promise(resolve => {
          const req = http.request({ host: lan.address, port, path: '/', timeout: 2000 }, () => resolve(false));
          req.on('error', () => resolve(true)); req.on('timeout', () => { req.destroy(); resolve(true); });
          req.end();
        });
        assert.ok(refused, `${lan.address}:${port} 不应能连上`);
      }
    } finally { await srv.close(); }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('输出锁：同一进程第二次取同一个锁是资源忙（5）；pid 已不在的残留锁直接接管；释放只删自己的锁', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-lock-'));
  try {
    const target = path.join(dir, 'v.mp4');
    const release = acquireLock(target);
    assert.ok(fs.existsSync(lockPath(target)));
    throwsCode(() => acquireLock(target), 'busy.output-locked');
    release();
    assert.equal(fs.existsSync(lockPath(target)), false);
    // 残留锁：写锁的进程已经退出（拿一个跑完的子进程的 pid）
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(lockPath(target), JSON.stringify({ pid: Number(dead), host: os.hostname(), started: '2026-11-10T00:00:00Z', nonce: 'old' }));
    const again = acquireLock(target);
    assert.notEqual(JSON.parse(fs.readFileSync(lockPath(target), 'utf8')).nonce, 'old', '残留锁要被接管');
    // 别人接管后，旧的释放函数不删新主人的锁
    fs.writeFileSync(lockPath(target), JSON.stringify({ pid: process.pid, host: os.hostname(), nonce: 'someone-else' }));
    again();
    assert.ok(fs.existsSync(lockPath(target)), '只删自己的锁');
    // 别人刚用 open('wx') 建出锁、内容还没写进去：读到空文件也算有人持有（10 秒宽限，与渲染槽位同口径），不能抢
    fs.writeFileSync(lockPath(target), '');
    throwsCode(() => acquireLock(target), 'busy.output-locked');
    // 空锁放了超过宽限（建锁的进程在写入前崩了）：按残留接管
    const old = new Date(Date.now() - 20000);
    fs.utimesSync(lockPath(target), old, old);
    acquireLock(target)();
    assert.equal(fs.existsSync(lockPath(target)), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('渲染槽位：满了返回 null；持有者已不在的槽位可以接管；RENDER_SLOTS 写错是用法错误', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-slots-'));
  try {
    const a = tryTake(dir, 1, 'a');
    assert.ok(a);
    assert.equal(tryTake(dir, 1, 'b'), null, '一个槽位已占，第二个拿不到');
    assert.ok(tryTake(dir, 2, 'b'), '两个槽位时第二个能拿到');
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(path.join(a, 'owner.json'), JSON.stringify({ pid: Number(dead), host: os.hostname(), started: '2026-11-10T00:00:00Z' }));
    assert.ok(tryTake(dir, 1, 'c'), '持有者已退出：接管');
    assert.equal(slotCount(''), null);
    assert.equal(slotCount('3'), 3);
    throwsCode(() => slotCount('0'), 'usage.bad-value');
    throwsCode(() => slotCount('two'), 'usage.bad-value');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('运行记录里的路径：仓库内写相对路径（经 /var → /private/var 这类别名也认得出），仓库外写绝对路径', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-rp-')));
  try {
    fs.mkdirSync(path.join(root, 'films', 'x', 'out'), { recursive: true });
    assert.equal(repoPath(root, path.join(root, 'films', 'x', 'out', 'master.mp4')), 'films/x/out/master.mp4');
    // 仓库外的别名路径指回仓库（macOS 的 /var → /private/var、Windows 的目录联接同理）
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-rp-alias-'));
    try {
      fs.symlinkSync(root, path.join(outside, 'repo'), 'junction');
      assert.equal(repoPath(root, path.join(outside, 'repo', 'films', 'x', 'out', 'not-yet.mp4')), 'films/x/out/not-yet.mp4', '经别名、文件还没写出来也认得出');
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
    assert.equal(repoPath(root, os.homedir()), path.resolve(os.homedir()));
    assert.equal(repoPath(root, root), '.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('serve.mjs：一启动就输出信封（地址、端口），只听 127.0.0.1，.git 不出；SIGTERM 时关掉服务以 143 退出；端口被占退出 5', { timeout: 30000 }, async () => {
  const { spawn } = await import('node:child_process');
  const ROOT = fileURLToPath(new URL('../../', import.meta.url));
  const p = spawn(process.execPath, [path.join(ROOT, 'engine/render/serve.mjs'), '--port', '0', '--json'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', d => { out += d; });
  const exited = new Promise(r => p.on('exit', (code, sig) => r({ code, sig })));
  for (let i = 0; i < 100 && !out.trim().endsWith('}'); i++) await new Promise(r => setTimeout(r, 50));
  const env = JSON.parse(out);
  assert.equal(env.ok, true);
  assert.match(env.data.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const status = u => new Promise((resolve, reject) => http.get(u, res => { res.resume(); resolve(res.statusCode); }).on('error', reject));
  assert.equal(await status(env.data.url), 200, '仓库根的 index.html（《北冥》样片）');
  assert.equal(await status(`${env.data.url}.git/HEAD`), 404);
  // 同一个端口再起一个：退出 5
  const busy = spawn(process.execPath, [path.join(ROOT, 'engine/render/serve.mjs'), '--port', String(env.data.port), '--json'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let bout = '';
  busy.stdout.on('data', d => { bout += d; });
  const bcode = await new Promise(r => busy.on('exit', c => r(c)));
  assert.equal(bcode, 5);
  assert.equal(JSON.parse(bout).error.code, 'busy.port');
  if (process.platform !== 'win32') {
    p.kill('SIGTERM');
    assert.equal((await exited).code, 143);
  } else { p.kill(); await exited; }
});
