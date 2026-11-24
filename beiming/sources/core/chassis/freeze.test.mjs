// 冻结检查（freeze.mjs）的测试：仓库里的冻结标记与代码一致；检查认得出该认的改动；条文提到了标记钉住的每个名字；
// 照 Cycles 取值的常数对 Cycles 的头文件（本机有 Cycles 源码缓存时才比，没有就跳过；BEIMING_FNCHECK_E2E=1 时缺了算失败）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureSource } from '../fncheck/cycles/build.mjs';
import { SHADERS } from './build.mjs';
import { KERNEL, MARKER, STRUCTURES, check, familyConstants, pinOf, refresh, scanFiles } from './freeze.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const marker = () => JSON.parse(fs.readFileSync(MARKER, 'utf8'));
const read = file => { try { return fs.readFileSync(path.join(KERNEL, file), 'utf8'); } catch { return null; } };

test('仓库里的冻结标记：四样结构、版本、日期、条文与登记表、改动的规矩都在，钉住的定义与代码一致', () => {
  const m = marker();
  assert.deepEqual(check(m, read, scanFiles(KERNEL)), []);
  // 登记类编号扫的是内核的全部着色器加共用目录里编进内核的四个，不只是标记钉住的那几个文件
  const scan = scanFiles(KERNEL);
  for (const f of fs.readdirSync(path.join(KERNEL, 'shaders')).filter(f => f.endsWith('.wgsl'))) assert.ok(scan.includes(`shaders/${f}`), f);
  for (const f of SHADERS) assert.ok(scan.includes(`../shaders/${f}`), f);
  assert.ok(SHADERS.length === 4 && scan.length > Object.keys(m.pinned).length);
  for (const n of ['LABEL_NONE', 'LABEL_REFLECT', 'LABEL_DIFFUSE', 'LABEL_GLOSSY', 'LABEL_SINGULAR']) assert.ok(n in m.pinned['../shaders/util.wgsl'].constants, n);
  assert.deepEqual(m.structures, STRUCTURES);
  assert.equal(m.text, 'STRUCTURES.md');
  assert.ok(m.registry.startsWith('STRUCTURES.md#'));
  // 登记表那一节的标题在条文里
  assert.ok(read('STRUCTURES.md').split('\n').some(l => /^#+ /.test(l) && l.replace(/^#+ /, '') === m.registry.split('#')[1]), m.registry);
  // 四样结构各自的定义都钉住了
  for (const [file, names] of Object.entries({
    'shaders/pathtrace.wgsl': ['Material', 'Params', 'KernelIntegrator', 'KernelFilm', 'ObjectExt'],
    'shaders/shader.wgsl': ['ShadingPoint', 'Closure', 'ShaderInputs'],
    'shaders/integrator.wgsl': ['PathState', 'Ray'],
    'shaders/film.wgsl': ['SampleResult', 'AuxSample'],
  })) for (const n of names) assert.match(m.pinned[file].structs[n], /^[0-9a-f]{64}$/, `${file} ${n}`);
  for (const n of ['PRNG_TERMINATE', 'PRNG_SURFACE_BSDF', 'D_BSDF']) assert.ok(n in m.pinned['shaders/sample.wgsl'].constants, n);
  for (const n of ['FILM_COMBINED', 'FILM_FIXED']) assert.ok(n in m.pinned['shaders/film.wgsl'].constants, n);
  assert.doesNotMatch(JSON.stringify(m), /\/Users\/|\/home\/|[A-Z]:\\|192\.168\./);
});

test('条文：标记钉住的每个结构、常数、函数的名字都在条文里出现；不含本机路径', () => {
  const text = read('STRUCTURES.md');
  for (const [file, kinds] of Object.entries(marker().pinned)) for (const [kind, names] of Object.entries(kinds)) for (const name of Object.keys(names)) {
    assert.ok(new RegExp(`\`${name}\``).test(text) || new RegExp(`\\b${name}\\b`).test(text), `条文里没有 ${file} 的 ${kind} ${name}`);
  }
  assert.doesNotMatch(text, /\/Users\/|\/home\/[a-z]|[A-Z]:\\|192\.168\./);
});

test('钉住值：改注释与排版不算改结构；改字段、改常数的值、改函数的参数表都认得出来', () => {
  const a = 'struct S {\n    a: u32,   // 甲\n    b: vec3<f32>,\n};\nconst K_ONE: u32 = 1u << 3u; // 说明\nfn f(x: S, y: f32) -> vec3<f32> { return x.b * y; }\n';
  const b = '// 换了排版\nstruct S { a: u32, b: vec3<f32> };\n    const K_ONE : u32 = 1u  <<  3u;\nfn f(x: S,\n     y: f32) -> vec3<f32> {\n    return x.b * y;\n}\n';
  for (const [kind, name] of [['structs', 'S'], ['constants', 'K_ONE'], ['functions', 'f']]) {
    assert.ok(pinOf(a, kind, name));
    assert.equal(pinOf(a, kind, name), pinOf(b, kind, name), `${kind} ${name}`);
    assert.equal(pinOf(a, kind, 'nope'), null);
  }
  assert.equal(pinOf(a, 'constants', 'K_ONE'), 'u32 = 1u << 3u');
  assert.equal(pinOf(a, 'functions', 'f'), '(x: S, y: f32) -> vec3<f32>');
  assert.notEqual(pinOf(a.replace('a: u32', 'a: i32'), 'structs', 'S'), pinOf(a, 'structs', 'S'));
  assert.notEqual(pinOf(a.replace('b: vec3<f32>,', 'b: vec3<f32>, c: f32,'), 'structs', 'S'), pinOf(a, 'structs', 'S'));
  assert.notEqual(pinOf(a.replace('1u << 3u', '1u << 4u'), 'constants', 'K_ONE'), pinOf(a, 'constants', 'K_ONE'));
  assert.notEqual(pinOf(a.replace('y: f32', 'y: f32, z: f32'), 'functions', 'f'), pinOf(a, 'functions', 'f'));
  // 名字是别的名字的前半截不算
  assert.equal(pinOf('struct SS { a: u32 };\nconst K_ONE_MORE: u32 = 2u;\nfn ff() {}\n', 'structs', 'S'), null);
  assert.equal(pinOf('const K_ONE_MORE: u32 = 2u;', 'constants', 'K_ONE'), null);
  assert.equal(pinOf('fn ff() {}', 'functions', 'f'), null);
  assert.deepEqual(familyConstants('const K_ONE: u32 = 1u;\n// const K_GONE: u32 = 9u;\n    const K_TWO: u32 = 2u;\nconst OTHER: u32 = 3u;', ['K_']), ['K_ONE', 'K_TWO']);
  // 声明的三种别的写法：不写类型、前面带属性、一行里第二个。各自都认得出来，钉住值也取得到
  assert.deepEqual(familyConstants('const K_BARE = 3u;', ['K_']), ['K_BARE']);
  assert.equal(pinOf('const K_BARE = 3u;', 'constants', 'K_BARE'), '= 3u');
  assert.deepEqual(familyConstants('@if(hwrt) const K_GATED: u32 = 15u;\n@if(!hwrt)\n@must_use const K_SPLIT: u32 = 1u;', ['K_']), ['K_GATED', 'K_SPLIT']);
  assert.equal(pinOf('@if(hwrt) const K_GATED: u32 = 15u;', 'constants', 'K_GATED'), 'u32 = 15u');
  assert.deepEqual(familyConstants('const OTHER: u32 = 1u; const K_SECOND: u32 = 3u;', ['K_']), ['K_SECOND']);
  assert.equal(pinOf('const OTHER: u32 = 1u; const K_SECOND: u32 = 3u;', 'constants', 'K_SECOND'), 'u32 = 3u');
  // 块注释里的不算，块注释挡在前面的照认；const_assert 不是声明
  assert.deepEqual(familyConstants('/* const K_GONE: u32 = 9u; */ /* 说明 */ const K_KEPT: u32 = 1u;\nconst_assert K_KEPT == 1u;', ['K_']), ['K_KEPT']);
});

test('检查：改了结构而没更新标记不过；加了登记类的编号而没进标记不过；标记缺字段不过；更新之后过', () => {
  const files = { 'a.wgsl': 'struct S { a: u32 };\nconst K_ONE: u32 = 1u;\nfn f(x: S) -> u32 { return x.a; }\n', 'TEXT.md': '# 条文\n' };
  const from = fs => file => fs[file] ?? null;
  const base = { schema: 'beiming.core.freeze/1', version: '1.0.0', frozen: '2026-11-24', structures: STRUCTURES, text: 'TEXT.md', registry: 'TEXT.md#表', rules: ['规矩'], families: ['K_'], pinned: { 'a.wgsl': { structs: { S: '' }, constants: {}, functions: { f: '' } } } };
  const m = refresh(base, from(files));
  assert.deepEqual(m.pinned['a.wgsl'].constants, { K_ONE: 'u32 = 1u' });
  assert.deepEqual(check(m, from(files)), []);
  assert.equal(check(base, from(files)).length, 3, '没填值的标记：两处不一致，加一个没登记的编号');
  const changed = (edit, pattern) => {
    const problems = check(m, from({ ...files, 'a.wgsl': edit(files['a.wgsl']) }));
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0], pattern);
  };
  changed(s => s.replace('a: u32', 'a: u32, b: f32'), /structs S：与标记不一致/);
  changed(s => s.replace('= 1u', '= 2u'), /constants K_ONE：与标记不一致/);
  changed(s => s.replace('x: S', 'x: S, y: u32'), /functions f：与标记不一致/);
  changed(s => s.replace('struct S', 'struct T'), /structs S：源码里找不到了/);
  changed(s => `${s}const K_TWO: u32 = 2u;\n`, /常数 K_TWO：是登记类的编号，标记里没有/);
  changed(s => `${s}const K_TWO = 2u;\n`, /常数 K_TWO：是登记类的编号，标记里没有/);
  changed(s => `${s}@if(hwrt) const K_TWO: u32 = 2u;\n`, /常数 K_TWO：是登记类的编号，标记里没有/);
  changed(s => `${s}const OTHER: u32 = 2u; const K_TWO: u32 = 2u;\n`, /常数 K_TWO：是登记类的编号，标记里没有/);
  changed(s => `// 只加注释\n${s}const OTHER: u32 = 2u;\n`.replace('K_ONE: u32 = 1u', 'OOPS: u32 = 1u'), /constants K_ONE：源码里找不到了/);
  // 加注释、加不在登记类里的常数：不算
  assert.deepEqual(check(m, from({ ...files, 'a.wgsl': `// 注释\n${files['a.wgsl']}const OTHER: u32 = 2u;\n` })), []);
  for (const [k, v] of [['schema', 'x'], ['version', '1.0'], ['frozen', '昨天'], ['structures', ['材质记录']], ['rules', []], ['text', 'NOPE.md'], ['registry', ''], ['families', []], ['pinned', {}]]) {
    assert.ok(check({ ...m, [k]: v }, from(files)).length >= 1, k);
  }
  assert.deepEqual(check({ ...m, pinned: { 'gone.wgsl': {} } }, from(files)), ['gone.wgsl：文件不在']);
  assert.equal(check(null, from(files)).length, 1);
});

test('检查：标记没钉住的文件里声明了登记类的编号也不过；更新时给这个文件开一项', () => {
  const files = { 'a.wgsl': 'const K_ONE: u32 = 1u;\n', 'b.wgsl': 'fn g() {}\nconst OTHER: u32 = 7u;\n', 'TEXT.md': '# 条文\n' };
  const from = fs => file => fs[file] ?? null;
  const m = { schema: 'beiming.core.freeze/1', version: '1.0.0', frozen: '2026-11-24', structures: STRUCTURES, text: 'TEXT.md', registry: 'TEXT.md#表', rules: ['规矩'], families: ['K_'], pinned: { 'a.wgsl': { constants: { K_ONE: 'u32 = 1u' } } } };
  const scan = ['a.wgsl', 'b.wgsl'];
  assert.deepEqual(check(m, from(files), scan), []);
  const added = { ...files, 'b.wgsl': `${files['b.wgsl']}const K_TWO: u32 = 2u;\n` };
  assert.deepEqual(check(m, from(added)), [], '不给要扫的文件时只看钉住的');
  assert.deepEqual(check(m, from(added), scan), ['b.wgsl 的常数 K_TWO：是登记类的编号，标记里没有']);
  assert.deepEqual(check(m, from(files), [...scan, 'c.wgsl']), ['c.wgsl：文件不在']);
  const updated = refresh(m, from(added), scan);
  assert.deepEqual(updated.pinned['b.wgsl'], { constants: { K_TWO: 'u32 = 2u' } });
  assert.deepEqual(check(updated, from(added), scan), []);
  assert.deepEqual(refresh(m, from(files), scan).pinned, m.pinned, '没有登记类常数的文件不开项');
});

test('命令：标记与代码一致退出 0；没有标记、标记与代码不一致退出 4', () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(HERE, 'freeze.mjs'), ...args], { encoding: 'utf8' });
  const ok = run();
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout + ok.stderr, /与代码一致/);
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beiming-freeze-test-'));
  try {
    // 照内核目录的样子拷：path/ 下是标记、条文与着色器，旁边的 shaders/ 是共用目录
    const kernel = path.join(tmp, 'path'), copy = path.join(kernel, 'FREEZE.json');
    fs.mkdirSync(kernel);
    assert.equal(run('--marker', copy).status, 4, '没有标记');
    fs.cpSync(path.join(KERNEL, 'shaders'), path.join(kernel, 'shaders'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'shaders'));
    for (const f of SHADERS) fs.copyFileSync(path.join(KERNEL, '..', 'shaders', f), path.join(tmp, 'shaders', f));
    for (const f of ['FREEZE.json', 'STRUCTURES.md']) fs.copyFileSync(path.join(KERNEL, f), path.join(kernel, f));
    assert.equal(run('--marker', copy).status, 0, '原样拷出来的一份');
    // 标记没钉住的文件（体积那一段）里加一个登记类的编号
    const volume = path.join(kernel, 'shaders', 'volume.wgsl'), before = fs.readFileSync(volume, 'utf8');
    assert.ok(!('shaders/volume.wgsl' in marker().pinned));
    fs.writeFileSync(volume, `${before}\nconst PRNG_VOLUME_PHASE: u32 = 3u;\n`);
    const unpinned = run('--marker', copy);
    assert.equal(unpinned.status, 4, '没钉住的文件里加了登记类的编号');
    assert.match(unpinned.stdout + unpinned.stderr, /shaders\/volume\.wgsl 的常数 PRNG_VOLUME_PHASE/);
    fs.writeFileSync(volume, before);
    // 共用目录里不放采样标签的那几个着色器（移植闭包的人往那里写）同样扫
    const micro = path.join(tmp, 'shaders', 'microfacet.wgsl'), microBefore = fs.readFileSync(micro, 'utf8');
    fs.writeFileSync(micro, `${microBefore}\nconst LABEL_FOO: i32 = 32;\n`);
    const shared = run('--marker', copy);
    assert.equal(shared.status, 4, '共用目录的着色器里加了登记类的编号');
    assert.match(shared.stdout + shared.stderr, /\.\.\/shaders\/microfacet\.wgsl 的常数 LABEL_FOO/);
    fs.writeFileSync(micro, microBefore);
    const film = path.join(kernel, 'shaders', 'film.wgsl');
    fs.writeFileSync(film, fs.readFileSync(film, 'utf8').replace('const FILM_AUX_NORMAL: u32 = 7u;', 'const FILM_AUX_NORMAL: u32 = 8u;'));
    const bad = run('--marker', copy);
    assert.equal(bad.status, 4, '改了一个位置常数');
    assert.match(bad.stdout + bad.stderr, /FILM_AUX_NORMAL/);
    fs.writeFileSync(copy, '{ 不是 JSON');
    assert.equal(run('--marker', copy).status, 4, '标记读不了');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 照 Cycles 取值的常数 ──
// 内核里名字以这些前缀开头的常数，数值都照 Cycles 的同名枚举（kernel/types.h）：路径标志位与可见类、随机维度的枚举与
// 每次弹射的个数、着色点与物体的标志、采样标签。菲涅耳种类照 closure/bsdf_microfacet.h 的 enum MicrofacetFresnel 的次序。
const CYCLES_PREFIXES = ['PATH_RAY_', 'PRNG_', 'SD_', 'LABEL_'];
const KERNEL_FILES = scanFiles(KERNEL);

/** `1u << 7u`、`(1U << 7U)`、`0x10`、`16` 这类整数式的值；认不出来返回 null */
function intOf(text) {
  const t = text.replace(/[()\s]/g, '').replace(/(?<=[0-9a-fA-F])[uU]\b/g, '');
  const num = s => (/^(0x[0-9a-fA-F]+|\d+)$/.test(s) ? Number(s) : null);
  const [a, b, ...more] = t.split('<<').map(num);
  if (more.length || a === null || b === null) return null;
  return b === undefined ? a : a * 2 ** b;
}

test('整数式求值：十进制、十六进制、带 u 后缀、移位、括号', () => {
  assert.deepEqual(['16', '16u', '0x10', '1u << 7u', '(1U << 25U)', '(1 << 0)', '0xfu << 8u', 'A | B', '1 << 2 << 3'].map(intOf), [16, 16, 16, 128, 33554432, 1, 3840, null, null]);
});

test('照 Cycles 取值的常数：与 Cycles 头文件里的同名枚举逐个相等（本机没有 Cycles 源码缓存时跳过）', t => {
  const E2E = process.env.BEIMING_FNCHECK_E2E === '1';
  let src;
  try { src = ensureSource({ allowFetch: E2E }); } catch (e) {
    if (e.missing && !E2E) { t.skip(`没有 Cycles 源码：${e.missing}`); return; }
    throw e;
  }
  const header = f => fs.readFileSync(path.join(src, 'intern', 'cycles', f), 'utf8');
  // types.h 里全部「名字 = 整数式」的枚举项（式子跨行或引用别的名字的认不出来，记成 null）
  const cycles = new Map([...header('kernel/types.h').matchAll(/^\s*([A-Z][A-Z0-9_]+)\s*=\s*([^,\n]*?)\s*,?\s*(?:\/[/*].*)?$/gm)].map(m => [m[1], intOf(m[2])]));
  const fresnel = /enum MicrofacetFresnel\s*\{([^}]*)\}/.exec(header('kernel/closure/bsdf_microfacet.h'))[1].replace(/\/\*.*?\*\//g, '').split(',').map(s => s.trim()).filter(Boolean);
  assert.equal(fresnel[0], 'NONE = 0');
  fresnel[0] = 'NONE';
  const ours = [];
  for (const file of KERNEL_FILES) {
    const code = read(file);
    for (const name of familyConstants(code, [...CYCLES_PREFIXES, 'FRESNEL_'])) ours.push([file, name, intOf(pinOf(code, 'constants', name).split('=')[1])]);
  }
  // Rust 一侧的那一个
  const rust = /^pub const PRNG_BOUNCE_NUM: u32 = (\d+);$/m.exec(read('src/sample.rs'));
  ours.push(['src/sample.rs', 'PRNG_BOUNCE_NUM', Number(rust[1])]);
  for (const [file, name, value] of ours) {
    assert.notEqual(value, null, `${file} 的 ${name}：认不出它的值`);
    if (name.startsWith('FRESNEL_')) {
      assert.equal(value, fresnel.indexOf(name.slice('FRESNEL_'.length)), `${file} 的 ${name} 与 Cycles 的 MicrofacetFresnel 次序不同`);
    } else {
      assert.ok(cycles.has(name), `${file} 的 ${name}：Cycles 的 kernel/types.h 里没有这个名字`);
      assert.equal(value, cycles.get(name), `${file} 的 ${name} 与 Cycles 的数值不同`);
    }
  }
  // 该比的都比到了：四类各有代表，两个着色点标志、两侧的 PRNG_BOUNCE_NUM 都在
  const names = ours.map(o => `${o[0]} ${o[1]}`);
  for (const n of ['shaders/integrator.wgsl PATH_RAY_MIS_SKIP', 'shaders/integrator.wgsl PATH_RAY_VISIBILITY_CAMERA', 'shaders/integrator.wgsl PRNG_BOUNCE_NUM', 'src/sample.rs PRNG_BOUNCE_NUM',
    'shaders/sample.wgsl PRNG_FILTER', 'shaders/sample.wgsl PRNG_SURFACE_BSDF', 'shaders/shader.wgsl FRESNEL_F82_TINT', 'shaders/shader.wgsl SD_BACKFACING', 'shaders/pathtrace.wgsl SD_OBJECT_NEGATIVE_SCALE',
    'shaders/closure.wgsl LABEL_TRANSMIT', '../shaders/util.wgsl LABEL_DIFFUSE', '../shaders/util.wgsl LABEL_SINGULAR']) assert.ok(names.includes(n), n);
  t.diagnostic(`比了 ${ours.length} 个常数`);
});
