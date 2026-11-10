// tools/new-film.mjs 的测试：在临时沙盒（复制 tools/new-film.mjs、tools/lib、routes、fonts、package.json）里跑，
// 不碰真实仓库的 films/。覆盖：演练不写盘、v2 film.json（镜头表、海报帧、兼容镜像、稳定排版）、点文件、JSX 花括号、
// 下一步命令、占位符残留、档位与帧率换算、重复生成、字体许可、暂存目录里的校验（不过不落盘）、写盘失败不留残留；
// 仓库里已有作品描述校验器 engine/production/film.js 时，三条路线各生成一部并用它复核（联调）。
//   node --test tests/cli/new-film.test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatFilmJson } from '../../tools/lib/filmspec.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function sandbox({ withEngine = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-newfilm-'));
  made.push(dir);
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tools/new-film.mjs'), path.join(dir, 'tools/new-film.mjs'));
  fs.cpSync(path.join(ROOT, 'tools/lib'), path.join(dir, 'tools/lib'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'routes'), path.join(dir, 'routes'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'fonts'), path.join(dir, 'fonts'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  if (withEngine) {
    // 联调：真实的引擎目录（含作品描述包）复制进来，共享素材 assets/ 用目录链接（Windows 上 junction 不要管理员权限）
    fs.cpSync(path.join(ROOT, 'engine'), path.join(dir, 'engine'), { recursive: true });
    fs.symlinkSync(path.join(ROOT, 'assets'), path.join(dir, 'assets'), 'junction');
  } else {
    fs.mkdirSync(path.join(dir, 'engine/render'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'engine/render/native.mjs'), '// 沙盒占位：注册表要求渲染器入口存在\n');
  }
  return dir;
}

function newFilm(dir, args, env = {}) {
  const r = spawnSync(process.execPath, [path.join(dir, 'tools/new-film.mjs'), ...args], { cwd: dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...env } });
  let json = null;
  if (args.includes('--json')) json = JSON.parse(r.stdout);
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}

const listFilms = dir => (fs.existsSync(path.join(dir, 'films')) ? fs.readdirSync(path.join(dir, 'films')) : null);
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));

/** 假的作品描述校验器：按 P05 的 --json 信封输出（结果在 result.diagnostics），退出码由脚本决定。 */
function fakeValidator(dir, { exit, diagnostics = [], raw = null }) {
  const v = path.join(dir, 'engine/production/film.js');
  fs.mkdirSync(path.dirname(v), { recursive: true });
  const body = raw ?? `const target = process.argv[3];
const diags = ${JSON.stringify(diagnostics)}.map(d => ({ ...d, message: d.message.replace('<目录>', target) }));
diags.push({ level: 'warning', code: 'id-dir-mismatch', path: 'id', message: '暂存目录名带来的提示' });
if (process.argv[2] !== 'check' || !process.argv.includes('--json')) process.exit(2);
const fs = await import('node:fs');
if (!fs.existsSync(target + '/film.json')) process.exit(1);
process.stdout.write(JSON.stringify({ ok: ${exit === 0}, exitCode: ${exit}, command: 'film.js check', error: ${exit === 0 ? 'null' : "{ code: 'contract', message: diags[0]?.message ?? 'x', hint: '' }"}, outputs: [], runJson: null, warnings: [], result: { diagnostics: diags } }));
process.exit(${exit});
`;
  fs.writeFileSync(v, body);
}

test('--help 退出 0、打印路线清单、什么都不写', () => {
  const dir = sandbox();
  const r = newFilm(dir, ['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /a {2}A · 北冥风格路线 · WebGL 三渲二/);
  assert.match(r.out, /--dry-run/);
  assert.equal(listFilms(dir), null);
});

test('--dry-run --json：退出 0、不写盘、给出文件清单、v2 film.json 与下一步', () => {
  const dir = sandbox();
  fakeValidator(dir, { exit: 0 });
  const r = newFilm(dir, ['b', 't8', '--title', '试映', '--json', '--dry-run']);
  assert.equal(r.code, 0, r.err);
  assert.equal(listFilms(dir), null, '演练不能建 films/');
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.outputs, []);
  const files = r.json.data.files.map(f => f.path);
  assert.ok(files.includes('films/t8/.gitignore'), '点文件要复制');
  assert.ok(files.every(f => !f.includes('/media/') && !f.includes('/out/')));
  const fj = r.json.data.filmJson;
  assert.equal(fj.schemaVersion, 2);
  assert.equal(fj.id, 't8');
  assert.equal(fj.title, '试映');
  assert.equal(fj.route, 'b');
  assert.equal(fj.backend, 'native', 'B 的 backend 与作品描述包同口径');
  assert.deepEqual(fj.output, { profile: 'web-1080p24', width: 1920, height: 1080, fps: 24, frameCount: 72 });
  assert.deepEqual(fj.shots, [{ id: 'S1', in: 0, out: 72 }], 'v1 模版没有镜头表：整片一个镜头');
  assert.deepEqual(fj.events, []);
  assert.deepEqual(fj.audio, { mode: 'native' }, 'B 的声音由 native.audio 准备');
  assert.deepEqual(fj.gates, { look: 'required', animatic: 'required', final: 'required' });
  assert.equal(fj.aigc.contains, true);
  assert.equal(fj.native.output, 'out/t8.mp4');
  assert.equal(fj.next, undefined, '生成的 film.json 不保留 next');
  assert.deepEqual(r.json.data.next[0].argv, ['node', 'engine/native/prepare.mjs', 'films/t8'], 'B 的第一步是 prepare');
  assert.equal(r.json.data.validation.status, 'skipped', '演练不调用校验器');
});

test('正式生成 A：v2 + 镜头表 + 风格 + 兼容镜像、稳定排版、占位符替换、可执行位、没有暂存目录残留', () => {
  const dir = sandbox();
  const r = newFilm(dir, ['a', 'dawn', '--title', '破晓', '--json']);
  assert.equal(r.code, 0, r.err);
  const d = path.join(dir, 'films/dawn');
  const text = fs.readFileSync(path.join(d, 'film.json'), 'utf8');
  const fj = JSON.parse(text);
  assert.equal(text, formatFilmJson(fj), '按稳定排版写');
  assert.match(text, /^ {2}"size": \[1920, 1080\]$/m, '短数组写在一行');
  assert.equal(fj.output.profile, 'web-1080p24');
  assert.deepEqual([fj.dur, fj.fps, fj.size], [3, 24, [1920, 1080]], '兼容字段按 output 重写');
  assert.match(fj.$comment, /兼容镜像/);
  assert.equal(fj.backend, 'three');
  assert.deepEqual(fj.shots, [{ id: 'S1', in: 0, out: 72 }]);
  assert.deepEqual(fj.audio, { mode: 'script', script: 'sound.py' }, '响度目标跟档位走，不写死');
  assert.equal(fj.style.id, 'a-template', 'A 路线必须写 style');
  assert.ok(r.json.warnings.some(w => w.code === 'template.size-changed'), '模版 1920×1040 → 档位 1920×1080 要提示');
  assert.match(fs.readFileSync(path.join(d, 'README.md'), 'utf8'), /^# 破晓/);
  assert.doesNotMatch(fs.readFileSync(path.join(d, 'build.sh'), 'utf8'), /\{\{/);
  if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(d, 'build.sh')).mode & 0o100, 'build.sh 保留可执行位');
  assert.deepEqual(listFilms(dir), ['dawn'], '不留 .new-* 暂存目录');
  assert.equal(r.json.outputs.length, r.json.data.files.length);
  assert.ok(r.json.outputs.find(o => o.path === 'films/dawn/film.json').kind === 'film-json');
  assert.match(r.json.data.next[0].display, /^node engine\/render\/still\.mjs films\/dawn 0 1\.5 2\.958 --size 1920x1080/);
});

test('C：v1 的 poster（秒）换成 posterFrame（帧），cuecheck 原样保留', () => {
  const dir = sandbox();
  const r = newFilm(dir, ['c', 'ink', '--json']);
  assert.equal(r.code, 0, r.err);
  const fj = readJson(path.join(dir, 'films/ink/film.json'));
  assert.equal(fj.poster, undefined);
  assert.equal(fj.posterFrame, 66, '2.75 秒 × 24 fps');
  assert.deepEqual(fj.cuecheck, { grid: 2, tolMs: 0.5 });
  assert.equal(fj.backend, 'canvas');
  assert.deepEqual(fj.audio, { mode: 'script', script: 'mix.py' });
});

test('重复生成退出 2 且不动已有目录', () => {
  const dir = sandbox();
  assert.equal(newFilm(dir, ['c', 'ink']).code, 0);
  const before = fs.readFileSync(path.join(dir, 'films/ink/film.json'), 'utf8');
  const r = newFilm(dir, ['c', 'ink', '--title', '别的', '--json']);
  assert.equal(r.code, 2);
  assert.equal(r.json.error.code, 'usage.exists');
  assert.equal(fs.readFileSync(path.join(dir, 'films/ink/film.json'), 'utf8'), before);
});

test('B 模版的 JSX 花括号原样保留，{{TITLE}} 被替换', () => {
  const dir = sandbox();
  assert.equal(newFilm(dir, ['b', 'buoy', '--title', '浮标']).code, 0);
  const tsx = fs.readFileSync(path.join(dir, 'films/buoy/film.tsx'), 'utf8');
  assert.match(tsx, /style=\{\{ background: P\.sky \}\}/);
  assert.match(tsx, /text="浮标"/);
  assert.ok(fs.existsSync(path.join(dir, 'films/buoy/.gitignore')));
});

test('路线、名字、片名、档位不合法都是用法错误（2），什么都不写', () => {
  const dir = sandbox();
  const cases = [
    [['d', 'x'], 'usage.unknown-route'],
    [['b', '我的片子'], 'usage.bad-name'],
    [['b', 'raea-test'], 'usage.bad-name'],
    [['a', 'con'], 'usage.bad-name'],
    [['a', 'x', '--title', 'a"b'], 'usage.bad-title'],
    [['c', 'x', '--title', "it's"], 'usage.bad-title'],
    [['a', 'x', '--profile', 'web-1080p42'], 'usage.bad-profile'],
    [['a'], 'usage.missing-argument'],
    [['a', 'x', 'y'], 'usage.extra-argument'],
    [['a', 'x', '--titel', 't'], 'usage.unknown-option'],
  ];
  for (const [args, code] of cases) {
    const r = newFilm(dir, [...args, '--json']);
    assert.equal(r.code, 2, `${args.join(' ')}：${r.err}`);
    assert.equal(r.json.error.code, code, args.join(' '));
  }
  assert.match(newFilm(dir, ['d', 'x']).err, /a（北冥风格路线 · WebGL 三渲二）、b（北冥原生 · BNE）、c（北冥代码动画风格 · 86 式）/);
  assert.match(newFilm(dir, ['a', 'x', '--profile', 'web-1080p42', '--json']).json.error.hint, /web-1080p24/);
  assert.equal(listFilms(dir), null);
});

test('旧路线名可用但会提示改写', () => {
  const dir = sandbox();
  const r = newFilm(dir, ['beiming', 'old', '--json', '--dry-run']);
  assert.equal(r.code, 0);
  assert.equal(r.json.data.film.route, 'a');
  assert.ok(r.json.warnings.some(w => w.code === 'route.alias'));
});

test('模版里有未知占位符：退出 4，什么都不写', () => {
  const dir = sandbox();
  fs.appendFileSync(path.join(dir, 'routes/c-style/template/README.md'), '\n作者：{{AUTHOR}}\n');
  const r = newFilm(dir, ['c', 'x', '--json']);
  assert.equal(r.code, 4);
  assert.equal(r.json.error.code, 'contract.placeholder');
  assert.match(r.json.error.message, /README\.md:\d+ \{\{AUTHOR\}\}/);
  assert.equal(listFilms(dir), null);
});

test('--profile 换档位：画幅、帧率、帧数、海报帧跟着变，并提示检查节拍与构图', () => {
  const dir = sandbox();
  const r = newFilm(dir, ['c', 'tall', '--profile', 'vertical-1080x1920-30', '--json']);
  assert.equal(r.code, 0, r.err);
  const fj = readJson(path.join(dir, 'films/tall/film.json'));
  assert.deepEqual(fj.output, { profile: 'vertical-1080x1920-30', width: 1080, height: 1920, fps: 30, frameCount: 90 });
  assert.deepEqual(fj.shots, [{ id: 'S1', in: 0, out: 90 }]);
  assert.equal(fj.posterFrame, 83, '2.75 秒 × 30 fps 四舍五入');
  assert.deepEqual([fj.fps, fj.size], [30, [1080, 1920]]);
  assert.deepEqual(fj.deliveries, ['vertical-1080x1920-30']);
  const codes = r.json.warnings.map(w => w.code);
  assert.ok(codes.includes('template.size-changed') && codes.includes('template.fps-changed'));
});

/** 把沙盒里 C 模版的 film.json 换成 v2（可覆盖字段）。 */
function v2Template(dir, extra = {}) {
  const f = path.join(dir, 'routes/c-style/template/film.json');
  const v1 = readJson(f);
  const v2 = {
    schemaVersion: 2, id: '{{NAME}}', title: '{{TITLE}}', route: 'c', backend: 'canvas',
    output: { profile: 'web-1080p24', width: 1920, height: 1080, fps: 24, frameCount: 72 },
    shots: [{ id: 'S1', in: 0, out: 36 }, { id: 'S2', in: 36, out: 72 }],
    events: [{ id: 'title.land', frame: 40, shot: 'S2', visual: '片名落定' }],
    audio: { mode: 'script', script: 'mix.py' }, deliveries: ['web-1080p24'],
    aigc: { contains: false, note: '程序化' }, credits: [], posterFrame: 66, cuecheck: v1.cuecheck,
    ...extra,
  };
  fs.writeFileSync(f, JSON.stringify(v2, null, 2));
  return v2;
}

test('模版是 v2 且声明了档位与 next：按模版走，生成的 film.json 不带 next', () => {
  const dir = sandbox();
  v2Template(dir, {
    output: { profile: 'broadcast-1080p25', width: 1920, height: 1080, fps: 25, frameCount: 75 },
    shots: [{ id: 'S1', in: 0, out: 75 }], events: [], posterFrame: 70, deliveries: ['broadcast-1080p25'],
    next: [{ stage: 'build', title: '模版自己的出片命令', run: ['node', 'engine/render/build.mjs', '{dir}'] }],
  });
  const r = newFilm(dir, ['c', 'bc', '--json']);
  assert.equal(r.code, 0, r.err);
  const fj = readJson(path.join(dir, 'films/bc/film.json'));
  assert.equal(fj.output.profile, 'broadcast-1080p25');
  assert.equal(fj.id, 'bc');
  assert.equal(fj.next, undefined);
  assert.equal(fj.dur, undefined, 'v2 模版没写兼容字段就不加');
  assert.equal(fj.$comment, undefined);
  assert.deepEqual(r.json.data.next.map(s => s.title), ['模版自己的出片命令']);
});

test('v2 模版换帧率：镜头首尾相接按比例换算，事件留在所属镜头；按节拍写的事件拒绝换算', () => {
  const dir = sandbox();
  v2Template(dir);
  const r = newFilm(dir, ['c', 'v30', '--profile', 'vertical-1080x1920-30', '--json']);
  assert.equal(r.code, 0, r.err);
  const fj = readJson(path.join(dir, 'films/v30/film.json'));
  assert.deepEqual(fj.shots, [{ id: 'S1', in: 0, out: 45 }, { id: 'S2', in: 45, out: 90 }]);
  assert.deepEqual(fj.events.map(e => [e.id, e.frame, e.shot]), [['title.land', 50, 'S2']]);
  assert.equal(fj.posterFrame, 83);
  assert.ok(r.json.warnings.find(w => w.code === 'template.fps-changed').message.includes('镜头表按'));
  v2Template(dir, { events: [{ id: 'title.land', frame: 40, shot: 'S2', beat: 3, visual: '片名落定' }], timeline: { sections: [{ id: 'A', bpm: 120 }] } });
  const beat = newFilm(dir, ['c', 'v30b', '--profile', 'vertical-1080x1920-30', '--json']);
  assert.equal(beat.code, 4);
  assert.equal(beat.json.error.code, 'contract.template');
  assert.match(beat.json.error.message, /节拍/);
  assert.ok(!fs.existsSync(path.join(dir, 'films/v30b')));
});

test('模版 backend 不在注册表 backends 里：退出 4', () => {
  const dir = sandbox();
  v2Template(dir, { backend: 'page' });
  const r = newFilm(dir, ['c', 'bk', '--json']);
  assert.equal(r.code, 4);
  assert.equal(r.json.error.code, 'contract.template');
  assert.match(r.json.error.message, /canvas \/ svg \/ dom \/ three \/ webgl/);
});

test('模版带字体：与 fonts/ 同一份时附上 fonts/LICENSE.md；来历不明时退出 4', () => {
  const dir = sandbox();
  const tpl = path.join(dir, 'routes/a-webgl/template');
  fs.mkdirSync(path.join(tpl, 'fonts'));
  fs.copyFileSync(path.join(dir, 'fonts/Barlow-300.woff2'), path.join(tpl, 'fonts/Barlow-300.woff2'));
  const r = newFilm(dir, ['a', 'f1', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.existsSync(path.join(dir, 'films/f1/fonts/LICENSE.md')));
  assert.ok(r.json.warnings.some(w => w.code === 'font.license-added'));
  fs.writeFileSync(path.join(tpl, 'fonts/Other.ttf'), Buffer.from([0, 1, 0, 0, 9, 9]));
  fs.rmSync(path.join(tpl, 'fonts/Barlow-300.woff2'));
  const bad = newFilm(dir, ['a', 'f2', '--json']);
  assert.equal(bad.code, 4);
  assert.equal(bad.json.error.code, 'contract.font-license');
  assert.ok(!fs.existsSync(path.join(dir, 'films/f2')));
});

test('作品描述校验器在暂存目录上跑：通过才落盘；不过退出 4、什么都不留；校验器自身出错退出 1、超时退出 124', () => {
  const dir = sandbox();
  fakeValidator(dir, { exit: 0, diagnostics: [{ level: 'warning', code: 'legacy-mirror', path: '$', message: '<目录> 保留了兼容镜像' }] });
  const ok = newFilm(dir, ['a', 'v1', '--json']);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.json.data.validation.status, 'passed');
  assert.deepEqual(ok.json.data.validation.command, ['node', 'engine/production/film.js', 'check', 'films/v1', '--json']);
  const w = ok.json.warnings.find(x => x.code === 'film-check.legacy-mirror');
  assert.ok(w, '校验器的提示转成警告');
  assert.match(w.message, /films\/v1 保留了兼容镜像/, '暂存目录名换回最终目录名');
  assert.ok(!ok.json.warnings.some(x => x.code === 'film-check.id-dir-mismatch'), '暂存目录名带来的提示要滤掉');

  fakeValidator(dir, { exit: 4, diagnostics: [{ level: 'error', code: 'shots-coverage', path: 'shots[0].out', message: '镜头表没有覆盖整片', hint: '改 out' }] });
  const bad = newFilm(dir, ['a', 'v2', '--json']);
  assert.equal(bad.code, 4);
  assert.equal(bad.json.error.code, 'contract.film-check');
  assert.match(bad.json.error.message, /\[shots-coverage\] shots\[0\]\.out：镜头表没有覆盖整片/);
  assert.equal(bad.json.data.validation.status, 'failed');
  assert.ok(bad.json.data.filmJson, '失败时信封里仍有生成的 film.json，方便定位');
  assert.deepEqual(listFilms(dir).sort(), ['v1'], '不过就不落盘，也不留暂存目录');

  fakeValidator(dir, { exit: 0, raw: "process.stderr.write('校验器崩了'); process.exit(1);\n" });
  const crash = newFilm(dir, ['a', 'v3', '--json']);
  assert.equal(crash.code, 1);
  assert.equal(crash.json.error.code, 'failure.film-check');
  assert.match(crash.json.error.message, /退出码 1：校验器崩了/);
  assert.deepEqual(listFilms(dir).sort(), ['v1']);

  fakeValidator(dir, { exit: 0, raw: 'setTimeout(() => {}, 30000);\n' });
  const slow = newFilm(dir, ['a', 'v4', '--json', '--check-timeout', '0.3']);
  assert.equal(slow.code, 124, '校验器超时按附录 C1 退出 124');
  assert.equal(slow.json.error.code, 'timeout.film-check');
  assert.deepEqual(listFilms(dir).sort(), ['v1']);
});

test('校验中途收到 SIGTERM：先杀掉校验器、删掉暂存目录，再以 143 退出，只输出一个信封', { skip: process.platform === 'win32' ? 'Windows 没有 POSIX 信号' : false }, async () => {
  const dir = sandbox();
  const pidFile = path.join(dir, 'validator.pid');
  fakeValidator(dir, { exit: 0, raw: `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30000);\n` });
  const child = spawn(process.execPath, [path.join(dir, 'tools/new-film.mjs'), 'a', 'sig', '--json'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  const started = Date.now();
  while (!fs.existsSync(pidFile)) {
    assert.ok(Date.now() - started < 15000, '校验器没有启动');
    await new Promise(r => setTimeout(r, 50));
  }
  const vpid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(listFilms(dir).some(n => n.startsWith('.new-sig-')), '校验时暂存目录在');
  child.kill('SIGTERM');
  const code = await new Promise(r => child.on('close', c => r(c)));
  assert.equal(code, 143);
  const env = JSON.parse(out);
  assert.equal(env.exitCode, 143);
  assert.equal(env.error.code, 'signal.sigterm');
  assert.deepEqual(listFilms(dir) ?? [], [], '暂存目录与新建的 films/ 都清掉');
  await new Promise(r => setTimeout(r, 100));
  assert.throws(() => process.kill(vpid, 0), e => e.code === 'ESRCH', '校验器进程不能残留');
});

test('模版 .gitignore 列出的生成物与符号链接不复制', { skip: process.platform === 'win32' ? '建符号链接要管理员权限' : false }, () => {
  const dir = sandbox();
  const tpl = path.join(dir, 'routes/b-native/template');
  fs.mkdirSync(path.join(tpl, 'media'));
  fs.writeFileSync(path.join(tpl, 'media/prop.glb'), 'x');
  fs.symlinkSync('film.tsx', path.join(tpl, 'link.tsx'));
  const r = newFilm(dir, ['b', 's1', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.ok(!fs.existsSync(path.join(dir, 'films/s1/media')));
  assert.ok(!fs.existsSync(path.join(dir, 'films/s1/link.tsx')));
  assert.ok(r.json.warnings.some(w => w.code === 'template.symlink'));
});

test('写盘失败：退出 1，不留半个目录', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? '需要非 root 的 POSIX 权限位' : false }, () => {
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, 'films'));
  fs.chmodSync(path.join(dir, 'films'), 0o555);
  try {
    const r = newFilm(dir, ['a', 'ro', '--json']);
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'failure.io');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'films')), []);
  } finally {
    fs.chmodSync(path.join(dir, 'films'), 0o755);
  }
});

// ───── 与作品描述包联调：仓库里有 engine/production/film.js 时自动启用 ─────
const HAS_VALIDATOR = fs.existsSync(path.join(ROOT, 'engine/production/film.js'));
const HAS_IO = fs.existsSync(path.join(ROOT, 'engine/production/io.js'));

test('联调：三条路线各生成一部，engine/production/film.js check 全部 exit 0', { skip: HAS_VALIDATOR ? false : '仓库里还没有 engine/production/film.js（作品描述包合入后自动启用）' }, () => {
  const dir = sandbox({ withEngine: true });
  for (const r of ['a', 'b', 'c']) {
    const res = newFilm(dir, [r, `ci-${r}`, '--title', '试映', '--json']);
    assert.equal(res.code, 0, `${r}：${res.out}${res.err}`);
    assert.equal(res.json.data.validation.status, 'passed', r);
    const check = spawnSync(process.execPath, ['engine/production/film.js', 'check', `films/ci-${r}`], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    assert.equal(check.status, 0, `${r}：${check.stdout}${check.stderr}`);
  }
  assert.deepEqual(listFilms(dir).sort(), ['ci-a', 'ci-b', 'ci-c'], '不留暂存目录');
});

test('稳定排版与作品描述包的 formatJson 逐字节一致', { skip: HAS_IO ? false : '仓库里还没有 engine/production/io.js（作品描述包合入后自动启用）' }, async () => {
  const { formatJson } = await import(pathToFileURL(path.join(ROOT, 'engine/production/io.js')).href);
  const dir = sandbox();
  for (const r of ['a', 'b', 'c']) {
    const res = newFilm(dir, [r, `fmt-${r}`, '--json', '--dry-run']);
    assert.equal(res.code, 0, res.err);
    assert.equal(formatFilmJson(res.json.data.filmJson), formatJson(res.json.data.filmJson), r);
  }
});
