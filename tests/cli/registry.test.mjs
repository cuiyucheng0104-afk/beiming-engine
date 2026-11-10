// 路线注册表 routes/routes.json 与 tools/lib/routes.mjs、profiles.mjs、filmspec.mjs 的测试。
//   node --test tests/cli/registry.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FALLBACK_PROFILES, PROFILES_PATH, loadProfiles } from '../../tools/lib/profiles.mjs';
import { expandSteps, filmVars, formatStep, loadRegistry, validateRegistry, validateSteps } from '../../tools/lib/routes.mjs';
import { filmJsonProblems, findPlaceholders, nameProblem, titleProblem } from '../../tools/lib/filmspec.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'routes/routes.json'), 'utf8'));

test('注册表合格，三条路线按 D01 / D04 登记', () => {
  assert.deepEqual(validateRegistry(raw, { root: ROOT }), []);
  const reg = loadRegistry(ROOT);
  assert.deepEqual(reg.ids, ['a', 'b', 'c']);
  assert.deepEqual(reg.routes.map(r => r.slug), ['a-webgl', 'b-native', 'c-style']);
  assert.deepEqual(reg.routes.map(r => r.brand), ['北冥风格路线 · WebGL 三渲二', '北冥原生 · BNE', '北冥代码动画风格 · 86 式']);
  assert.equal(reg.defaultProfile, 'web-1080p24');
  for (const r of reg.routes) {
    assert.doesNotMatch(r.brand, /RTX|raea/i, '品牌名不带 RTX、不用上游名');
    assert.ok(fs.existsSync(path.join(ROOT, r.manual)), r.manual);
    assert.ok(fs.existsSync(path.join(ROOT, r.template, 'film.json')), r.template);
  }
  const b = reg.get('b');
  assert.match(b.summary, /render anything/);
  assert.equal(b.upstream[0].name, 'RAEA');
  assert.equal(b.upstream[0].license, 'FSL-1.1-ALv2');
  assert.equal(b.upstream[0].distributed, false);
  assert.match(reg.get('c').summary, /不是第三个 GPU 后端/);
  assert.deepEqual(reg.get('c').renderer, ['page'], 'C 与 A 共用页面渲染器（D01）');
  assert.deepEqual(reg.routes.map(r => r.legacyId), ['beiming', 'raea', null], '计划 M1 的 legacyId');
  assert.deepEqual(reg.routes.map(r => r.backend), ['three', 'native', 'canvas'], 'backend 默认值与 engine/production/film.js 同口径');
  for (const r of reg.routes) assert.ok(r.backends.includes(r.backend), r.id);
  assert.deepEqual(reg.get('c').backends, ['canvas', 'svg', 'dom', 'three', 'webgl']);
});

test('id 与别名都能找到路线；旧名是别名；找不到返回 null', () => {
  const reg = loadRegistry(ROOT);
  assert.equal(reg.resolve('a').via, 'id');
  assert.equal(reg.resolve('beiming').route.id, 'a');
  assert.equal(reg.resolve('RAEA').route.id, 'b');
  assert.equal(reg.resolve('c-style').route.id, 'c');
  assert.equal(reg.resolve('nope'), null);
});

test('注册表校验能抓出常见错误', () => {
  const bad = structuredClone(raw);
  bad.routes[1].id = 'a';
  bad.routes[0].aliases.push('c');
  bad.routes[2].brand = '北冥原生 · BNE · RTX 工具链';
  bad.routes[2].renderer = ['gpu3'];
  bad.routes[0].next[0].run = 'node x.mjs';
  bad.routes[0].next[1].run = ['node', '{nope}'];
  bad.routes[1].backend = 'raea';
  bad.routes[2].legacyId = 'style';
  delete bad.routes[0].legacyId;
  const msgs = validateRegistry(bad, { root: ROOT }).map(d => `${d.path} ${d.message}`).join('\n');
  for (const s of ['重复', '撞车', 'RTX', 'gpu3', 'argv', '{nope}', '不在 backends 里', 'legacyId "style"', '没有就写 null']) assert.ok(msgs.includes(s), `应报出「${s}」：\n${msgs}`);
});

test('下一步命令：B 的 prepare 在第一步；变量展开；POSIX 与 PowerShell 写法', () => {
  const reg = loadRegistry(ROOT);
  const vars = filmVars({ dir: 'films/t8', name: 't8', dur: 3, fps: 24, width: 1920, height: 1080 });
  assert.deepEqual([vars.mid, vars.last, vars.midFrame, vars.lastFrame, vars.size], ['1.5', '2.958', '36', '71', '1920x1080']);
  const b = expandSteps(reg.get('b').next, vars);
  assert.deepEqual(b[0].argv, ['node', 'engine/native/prepare.mjs', 'films/t8']);
  assert.deepEqual(b.find(s => s.argv.includes('--at')).argv.at(-1), '0,36,71');
  const a = expandSteps(reg.get('a').next, vars);
  assert.equal(formatStep(a[0], { platform: 'linux' }).command, 'node engine/render/still.mjs films/t8 0 1.5 2.958 --size 1920x1080 --out films/t8/out/stills');
  const nix = formatStep(b[1], { platform: 'darwin' }).notes.join('\n');
  const win = formatStep(b[1], { platform: 'win32' }).notes.join('\n');
  assert.match(nix, /export RAEA_BIN=/);
  assert.match(win, /\$env:RAEA_BIN = /);
  assert.match(formatStep(a[1], { platform: 'win32' }).notes.join('\n'), /Git Bash/);
  for (const r of reg.routes) assert.deepEqual(validateSteps(r.next), [], r.id);
});

test('交付档位：兜底表与 D07 一致；有 profiles.json 时两边画幅帧率不冲突', () => {
  assert.deepEqual(Object.keys(FALLBACK_PROFILES), ['web-1080p24', 'master-1080p24', 'uhd-2160p24', 'vertical-1080x1920-30', 'broadcast-1080p25', 'beiming-1040p24']);
  assert.deepEqual([FALLBACK_PROFILES['web-1080p24'].width, FALLBACK_PROFILES['web-1080p24'].height, FALLBACK_PROFILES['web-1080p24'].fps], [1920, 1080, 24]);
  assert.equal(FALLBACK_PROFILES['broadcast-1080p25'].targetLUFS, -23);
  const p = loadProfiles(ROOT);
  if (p.source === PROFILES_PATH) {
    for (const [id, f] of Object.entries(FALLBACK_PROFILES)) {
      const real = p.profiles.get(id);
      if (!real) continue;
      assert.deepEqual([real.width, real.height, real.fps], [f.width, f.height, f.fps], `${id} 与 ${PROFILES_PATH} 不一致：以 profiles.json 为准改兜底表`);
    }
  } else {
    assert.equal(p.source, 'fallback');
    assert.equal(p.profiles.get('web-1080p24').width, 1920);
  }
});

test('交付档位：读得懂作品描述包 profiles.json 的正式写法（video / audio.loudness / default）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-profiles-'));
  try {
    fs.mkdirSync(path.join(root, 'engine/production'), { recursive: true });
    fs.writeFileSync(path.join(root, PROFILES_PATH), JSON.stringify({
      schemaVersion: 1, default: 'web-1080p24', ffprobeFields: { 'video.width': 'width' },
      profiles: {
        'web-1080p24': { label: '网页', video: { width: 1920, height: 1080, fps: 24 }, audio: { loudness: { integratedLUFS: -14, toleranceLU: 1 }, truePeakMaxDbTP: -1 } },
        'beiming-1040p24': { label: '样片', video: { width: 1920, height: 1040, fps: 24 }, audio: { loudness: { integratedLUFS: -14 }, truePeakMaxDbTP: -1.2 } },
        broken: { label: '缺画幅' },
      },
    }));
    const p = loadProfiles(root);
    assert.equal(p.source, PROFILES_PATH);
    assert.equal(p.defaultId, 'web-1080p24');
    assert.deepEqual(p.profiles.get('web-1080p24'), { id: 'web-1080p24', label: '网页', width: 1920, height: 1080, fps: 24, targetLUFS: -14, truePeakDbTP: -1 });
    assert.match(p.profiles.get('beiming-1040p24').reserved, /样片专用/);
    assert.equal(p.profiles.get('beiming-1040p24').truePeakDbTP, -1.2);
    assert.ok(p.warnings.some(w => w.includes('broken')), '读不出的档位要提示');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('占位符只认两层花括号里的大写标识符，JSX 不算', () => {
  const jsx = '<Caption text="{{TITLE}}" style={{ color: P.caption, fontSize: 56 }} />\n<div style={{}}>{{a}}</div> {{ NAME }} films/{{NAME}}/out {{AUTHOR}}';
  assert.deepEqual(findPlaceholders(jsx).map(p => p.name), ['TITLE', 'NAME', 'AUTHOR']);
  assert.equal(findPlaceholders('x\ny {{TITLE}}')[0].line, 2);
});

test('作品名与片名的规则', () => {
  for (const ok of ['t8', 'dawn-test', 'kun-2', 'a']) assert.equal(nameProblem(ok), null, ok);
  for (const bad of ['我的片子', 'My-Film', '-x', 'con', 'nul', 'raea-test', 'a'.repeat(65), 'a b']) assert.ok(nameProblem(bad), bad);
  for (const ok of ['破晓', '《北冥》', 'Kun & Ferry', '晨渡 · 第一版']) assert.equal(titleProblem(ok), null, ok);
  for (const bad of ['', '  ', 'a"b', "it's", 'a`b', 'a\\b', '<x>', '换\n行', '{{TITLE}}', '长'.repeat(81)]) assert.ok(titleProblem(bad), JSON.stringify(bad));
});

test('film.json 结构自检：模版、v1 作品、v2 作品与兼容镜像一致性', () => {
  const ids = ['a', 'b', 'c'];
  for (const r of ['a-webgl', 'b-native', 'c-style']) {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'routes', r, 'template/film.json'), 'utf8'));
    assert.deepEqual(filmJsonProblems(j, { mode: 'template', route: r[0] }), [], r);
  }
  const v2 = { schemaVersion: 2, id: 't8', title: '试映', route: 'a', backend: 'three', output: { profile: 'web-1080p24', width: 1920, height: 1080, fps: 24, frameCount: 72 }, deliveries: ['web-1080p24'], aigc: { contains: false, note: '' }, dur: 3, fps: 24, size: [1920, 1080] };
  assert.deepEqual(filmJsonProblems(v2, { mode: 'film', routeIds: ids, dirName: 't8' }), []);
  const drift = { ...v2, dur: 4, size: [1920, 1040] };
  const probs = filmJsonProblems(drift, { mode: 'film', routeIds: ids, dirName: 't8' }).join('\n');
  assert.match(probs, /dur（兼容字段）/);
  assert.match(probs, /size（兼容字段）/);
  assert.match(filmJsonProblems({ ...v2, id: 'other' }, { mode: 'film', routeIds: ids, dirName: 't8' }).join(), /目录名/);
  assert.match(filmJsonProblems({ ...v2, route: 'beiming' }, { mode: 'film', routeIds: ids }).join(), /route 应为/);
  assert.match(filmJsonProblems({ ...v2, schemaVersion: 3 }, { mode: 'film', routeIds: ids }).join(), /schemaVersion/);
});
