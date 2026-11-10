// tools/new-film.mjs 的测试：在临时沙盒（复制 tools/new-film.mjs、tools/lib、routes、fonts、package.json）里跑，
// 不碰真实仓库的 films/。覆盖：演练不写盘、v2 film.json、点文件、JSX 花括号、下一步命令、占位符残留、
// 档位、重复生成、字体许可、校验器、写盘失败不留残留。
//   node --test tests/cli/new-film.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-newfilm-'));
  made.push(dir);
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tools/new-film.mjs'), path.join(dir, 'tools/new-film.mjs'));
  fs.cpSync(path.join(ROOT, 'tools/lib'), path.join(dir, 'tools/lib'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'routes'), path.join(dir, 'routes'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'fonts'), path.join(dir, 'fonts'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  fs.mkdirSync(path.join(dir, 'engine/render'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'engine/render/native.mjs'), '// 沙盒占位：注册表要求渲染器入口存在\n');
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
  assert.deepEqual(fj.output, { profile: 'web-1080p24', width: 1920, height: 1080, fps: 24, frameCount: 72 });
  assert.deepEqual(fj.gates, { look: 'required', animatic: 'required', final: 'required' });
  assert.equal(fj.aigc.contains, true);
  assert.equal(fj.native.output, 'out/t8.mp4');
  assert.equal(fj.next, undefined, '生成的 film.json 不保留 next');
  assert.deepEqual(r.json.data.next[0].argv, ['node', 'engine/native/prepare.mjs', 'films/t8'], 'B 的第一步是 prepare');
  assert.equal(r.json.data.validation.status, 'skipped');
});

test('正式生成 A：film.json v2 + 兼容镜像、占位符替换、可执行位、没有临时目录残留', () => {
  const dir = sandbox();
  const r = newFilm(dir, ['a', 'dawn', '--title', '破晓', '--json']);
  assert.equal(r.code, 0, r.err);
  const d = path.join(dir, 'films/dawn');
  const fj = readJson(path.join(d, 'film.json'));
  assert.equal(fj.output.profile, 'web-1080p24');
  assert.deepEqual([fj.dur, fj.fps, fj.size], [3, 24, [1920, 1080]], '兼容字段按 output 重写');
  assert.equal(fj.backend, 'three');
  assert.equal(fj.audio.script, 'sound.py');
  assert.equal(fj.audio.targetLUFS, -14);
  assert.ok(r.json.warnings.some(w => w.code === 'template.size-changed'), '模版 1920×1040 → 档位 1920×1080 要提示');
  assert.match(fs.readFileSync(path.join(d, 'README.md'), 'utf8'), /^# 破晓/);
  assert.doesNotMatch(fs.readFileSync(path.join(d, 'build.sh'), 'utf8'), /\{\{/);
  if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(d, 'build.sh')).mode & 0o100, 'build.sh 保留可执行位');
  assert.deepEqual(listFilms(dir), ['dawn'], '不留 .new-* 临时目录');
  assert.equal(r.json.outputs.length, r.json.data.files.length);
  assert.ok(r.json.outputs.find(o => o.path === 'films/dawn/film.json').kind === 'film-json');
  assert.match(r.json.data.next[0].display, /^node engine\/render\/still\.mjs films\/dawn 0 1\.5 2\.958 --size 1920x1080/);
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

test('--profile 换档位：画幅、帧率、帧数跟着变，并提示检查节拍与构图', () => {
  const dir = sandbox();
  const r = newFilm(dir, ['c', 'tall', '--profile', 'vertical-1080x1920-30', '--json']);
  assert.equal(r.code, 0, r.err);
  const fj = readJson(path.join(dir, 'films/tall/film.json'));
  assert.deepEqual(fj.output, { profile: 'vertical-1080x1920-30', width: 1080, height: 1920, fps: 30, frameCount: 90 });
  assert.deepEqual([fj.fps, fj.size], [30, [1080, 1920]]);
  assert.deepEqual(fj.deliveries, ['vertical-1080x1920-30']);
  const codes = r.json.warnings.map(w => w.code);
  assert.ok(codes.includes('template.size-changed') && codes.includes('template.fps-changed'));
});

test('模版是 v2 且声明了档位与 next：按模版走，生成的 film.json 不带 next', () => {
  const dir = sandbox();
  const f = path.join(dir, 'routes/c-style/template/film.json');
  const v1 = readJson(f);
  const v2 = {
    schemaVersion: 2, id: '{{NAME}}', title: '{{TITLE}}', route: 'c', backend: 'page',
    output: { profile: 'broadcast-1080p25', width: 1920, height: 1080, fps: 25, frameCount: 75 },
    deliveries: ['broadcast-1080p25'], aigc: { contains: false, note: '程序化' }, credits: [],
    poster: v1.poster, cuecheck: v1.cuecheck,
    next: [{ stage: 'build', title: '模版自己的出片命令', run: ['node', 'engine/render/build.mjs', '{dir}'] }],
  };
  fs.writeFileSync(f, JSON.stringify(v2, null, 2));
  const r = newFilm(dir, ['c', 'bc', '--json']);
  assert.equal(r.code, 0, r.err);
  const fj = readJson(path.join(dir, 'films/bc/film.json'));
  assert.equal(fj.output.profile, 'broadcast-1080p25');
  assert.equal(fj.id, 'bc');
  assert.equal(fj.next, undefined);
  assert.equal(fj.dur, undefined, 'v2 模版没写兼容字段就不加');
  assert.deepEqual(r.json.data.next.map(s => s.title), ['模版自己的出片命令']);
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

test('有作品描述校验器时调用它：不过退出 4 并保留目录；调用方式不符时只提示', () => {
  const dir = sandbox();
  const v = path.join(dir, 'engine/production/film.js');
  fs.mkdirSync(path.dirname(v), { recursive: true });
  fs.writeFileSync(v, "console.error('[spec.demo] output.frameCount 不对'); process.exit(4);\n");
  const r = newFilm(dir, ['a', 'v1', '--json']);
  assert.equal(r.code, 4);
  assert.equal(r.json.error.code, 'contract.film-check');
  assert.match(r.json.error.message, /spec\.demo/);
  assert.ok(fs.existsSync(path.join(dir, 'films/v1/film.json')), '生成的目录留给人检查');
  fs.writeFileSync(v, "if (process.argv[2] !== 'check') process.exit(2); process.exit(0);\n");
  const ok = newFilm(dir, ['a', 'v2', '--json']);
  assert.equal(ok.code, 0);
  assert.equal(ok.json.data.validation.status, 'passed');
  fs.writeFileSync(v, 'process.exit(2);\n');
  const skip = newFilm(dir, ['a', 'v3', '--json']);
  assert.equal(skip.code, 0);
  assert.equal(skip.json.data.validation.status, 'skipped');
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
