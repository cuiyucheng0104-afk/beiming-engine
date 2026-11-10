// ProjectSpec 接受注册表路线（a / b / c，旧值 beiming / raea 作别名），与 film.json v2 互相映射；
// RenderResult 的评审条目（附录 C8 的 reviews[]）与严格口径。原有 T01 测试见 project.test.mjs，这里只测新增规则。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_ROUTES, ROUTES, canonicalRoute, validateProjectSpec, validateRenderResult } from '../../engine/production/project.js';
import { builtinRegistry, loadRouteRegistry, resolveRoute } from '../../engine/production/routes.js';
import { fromProjectSpec, loadFilm, toProjectSpec, validateFilm } from '../../engine/production/film.js';
import { REPO, minimalFilm } from './helpers.mjs';

const template = name => JSON.parse(readFileSync(join(REPO, 'docs', 'routes', 'templates', name), 'utf8'));
const codes = r => r.diagnostics.map(d => d.code);
const spec = over => Object.assign(template('project-beiming.json'), over);

test('路线：注册表 id 是规范值，旧值与目录名都是别名；未知路线列出合法取值', () => {
  assert.deepEqual(ROUTES, ['a', 'b', 'c']);
  assert.deepEqual(LEGACY_ROUTES, { beiming: 'a', raea: 'b' });
  for (const route of ['a', 'beiming', 'a-webgl', 'A']) assert.deepEqual(validateProjectSpec(spec({ route })).diagnostics, [], route);
  const bad = validateProjectSpec(spec({ route: 'd' }));
  assert.deepEqual(codes(bad), ['route-invalid']);
  assert.match(bad.diagnostics[0].message, /a \/ b \/ c/);
  assert.match(bad.diagnostics[0].message, /beiming（= a）/);
  assert.deepEqual(canonicalRoute({ route: 'raea', backend: 'raea' }), { routeId: 'b', backend: 'native', routeAlias: true });
  assert.equal(resolveRoute('C-Style').id, 'c');
  // 治理骨架的注册表 routes/routes.json 已入库：以它为准；内置三条只是注册表文件缺失时的退路
  assert.equal(loadRouteRegistry().source, existsSync(join(REPO, 'routes', 'routes.json')) ? 'routes/routes.json' : 'builtin');
});

test('内置三条与注册表 routes/routes.json 一致（退路不会和注册表说两套话）', { skip: existsSync(join(REPO, 'routes', 'routes.json')) ? false : '还没有 routes/routes.json' }, () => {
  const reg = JSON.parse(readFileSync(join(REPO, 'routes', 'routes.json'), 'utf8'));
  const builtin = builtinRegistry();
  assert.deepEqual(reg.routes.map(r => r.id), builtin.routes.map(r => r.id));
  for (const r of reg.routes) {
    const b = builtin.routes.find(x => x.id === r.id);
    assert.equal(r.slug, b.slug, `${r.id}.slug`);
    assert.equal(r.brand, b.brand, `${r.id}.brand`);
    assert.equal(r.legacyId ?? null, b.legacyId ?? null, `${r.id}.legacyId`);
    assert.deepEqual(r.backends, b.backends, `${r.id}.backends`);
    assert.equal(r.manual, b.manual, `${r.id}.manual`);
    // 注册表里写的每个别名都能解析到这条路线
    for (const a of r.aliases ?? []) assert.equal(resolveRoute(a).id, r.id, `别名 ${a}`);
  }
});

test('后端按路线校验：b 只能 native（旧写法 raea），c 是页面型后端，a 搬到原生要声明迁移', () => {
  const raea = template('project-raea.json');
  assert.deepEqual(validateProjectSpec(raea).diagnostics, []);
  assert.deepEqual(validateProjectSpec({ ...raea, route: 'b', backend: 'native' }).diagnostics, []);
  assert.deepEqual(codes(validateProjectSpec({ ...raea, route: 'b', backend: 'canvas' })), ['backend-route-unsupported']);
  const c = spec({ route: 'c', backend: 'canvas', style: { id: 'c-ink', version: 'v1', baseline: null } });
  assert.deepEqual(validateProjectSpec(c).diagnostics, []);
  const cThree = spec({ route: 'c', backend: 'three' });
  assert.deepEqual(validateProjectSpec(cThree).diagnostics, []);
  assert.deepEqual(codes(validateProjectSpec(spec({ route: 'c', backend: 'native', runtime: { package: '0.1.0', sourceCommit: 'x' } }))), ['backend-route-unsupported']);
  assert.deepEqual(codes(validateProjectSpec(spec({ backend: 'canvas' }))), ['backend-route-unsupported']);
  assert.deepEqual(codes(validateProjectSpec(spec({ backend: 'vulkan' }))), ['backend-invalid']);
  const migrate = spec({ backend: 'native', runtime: { package: '0.1.0', sourceCommit: 'x' } });
  assert.deepEqual(codes(validateProjectSpec(migrate)), ['style-migration-required']);
  // 原生后端必须记录运行时版本（不论写 native 还是 raea）
  assert.ok(codes(validateProjectSpec({ ...raea, backend: 'native', runtime: { sourceSnapshot: 'x' } })).includes('runtime-incomplete'));
});

test('自定义注册表：options.registry 覆盖内置三条', () => {
  const reg = builtinRegistry();
  reg.routes = reg.routes.filter(r => r.id !== 'c');
  reg.aliases.delete('c'); reg.aliases.delete('c-style');
  assert.deepEqual(codes(validateProjectSpec(spec({ route: 'c', backend: 'canvas', style: { id: 's', version: 'v1', baseline: null } }), { registry: reg })), ['route-invalid', 'backend-invalid']);
});

test('film.json v2 ⇄ ProjectSpec：三条路线都能互相映射，映射结果自检通过', () => {
  const runtimes = { a: { three: '0.170.0', sourceCommit: 'abc1234' }, b: { package: '0.1.0-canary.2', sourceSnapshot: 'abc1234' }, c: { sourceCommit: 'abc1234' } };
  const films = {
    a: minimalFilm({ route: 'a', backend: 'three', style: { id: 'beiming-original', version: 1, baseline: '../../media/shot_7.6.jpg' } }),
    b: minimalFilm({ route: 'b', backend: 'native', audio: { mode: 'native' }, entry: 'film.tsx' }),
    c: minimalFilm(),
  };
  for (const [id, f] of Object.entries(films)) {
    const film = validateFilm(f, { checkFiles: false }).film;
    assert.ok(film, id);
    const { spec: s, diagnostics } = toProjectSpec(film, { runtime: runtimes[id], filmDir: 'films/tfilm' });
    assert.deepEqual(diagnostics, [], id);
    assert.equal(s.route, id);
    assert.equal(s.output.frameCount, 96);
    assert.equal(s.output.outputDir, 'films/tfilm/out/');
    if (id === 'a') assert.equal(s.style.baseline, 'media/shot_7.6.jpg');
    const back = fromProjectSpec(s);
    assert.equal(back.film.route, id);
    assert.equal(back.film.output.profile, 'web-1080p24');
    assert.deepEqual(back.film.shots, [{ id: 'S1', in: 0, out: 96 }]);
  }
  const bm = loadFilm(join(REPO, 'films', 'beiming-10s')).film;
  const r = toProjectSpec(bm, { runtime: runtimes.a });
  assert.deepEqual(r.diagnostics, []);
  assert.equal(r.spec.output.outputDir, 'out/beiming/');
  assert.equal(r.spec.entry, 'index.html');
  // 旧模版（route beiming / raea）也能转成 film.json 骨架
  assert.equal(fromProjectSpec(template('project-beiming.json')).film.route, 'a');
  assert.equal(fromProjectSpec(template('project-raea.json')).film.route, 'b');
});

// RenderResult：已执行、技术通过的结果
const passed = over => Object.assign(JSON.parse(readFileSync(join(REPO, 'docs', 'routes', 'templates', 'render-result.json'), 'utf8')), {
  status: 'passed', projectId: 'p', shotId: 'film', route: 'a', backend: 'three',
  actualDevice: 'Apple M5 Pro', actualGraphicsBackend: 'ANGLE-metal', actualEncoder: 'libx264',
  output: { file: 'web.mp4', sha256: 'a'.repeat(64), width: 1920, height: 1080, fps: 24, frames: 96, duration: 4 },
  technicalAcceptance: { status: 'passed', evidence: ['qa/report.json'] },
}, over);
const human = { reviewerKind: 'human', reviewer: '用户', decision: 'approve', quote: '可以，交付。', source: { kind: 'session', ref: '会话第 12 条消息', at: '2026-11-10T15:00:00+08:00' }, scores: { style: 9 }, evidenceFrames: [12, 60] };
const ai = { reviewerKind: 'ai', reviewer: 'agent', decision: 'comment', summary: '代理检查通过', scores: { rhythm: 7 }, vetoes: [] };

test('评审条目：AI 只能 comment；只有 AI 评审时 accepted 被拒；人工认可要原话与出处', () => {
  const aiOnly = passed({ status: 'accepted', creativeAcceptance: { status: 'accepted', reviews: [ai] } });
  assert.ok(codes(validateRenderResult(aiOnly)).includes('creative-accepted-without-human'));
  assert.deepEqual(codes(validateRenderResult(passed({ creativeAcceptance: { status: 'ai-reviewed', reviews: [ai] } }))), []);
  const aiApprove = passed({ creativeAcceptance: { status: 'ai-reviewed', reviews: [{ ...ai, decision: 'approve' }] } });
  assert.ok(codes(validateRenderResult(aiApprove)).includes('creative-ai-decision'));
  const ok = passed({ status: 'accepted', creativeAcceptance: { status: 'accepted', reviews: [ai, human] } });
  assert.deepEqual(validateRenderResult(ok).diagnostics, []);
  for (const bad of [{ quote: undefined }, { quote: '用户原话' }, { source: undefined }, { source: { kind: 'session', ref: '待补' } }]) {
    const r = passed({ status: 'accepted', creativeAcceptance: { status: 'accepted', reviews: [{ ...human, ...bad }] } });
    assert.ok(codes(validateRenderResult(r)).includes('creative-accepted-without-human'), JSON.stringify(bad));
  }
  assert.ok(codes(validateRenderResult(passed({ creativeAcceptance: { status: 'ai-reviewed', reviews: [{ ...ai, scores: { beauty: 9 } }] } }))).includes('creative-review-scores'));
  assert.ok(codes(validateRenderResult(passed({ creativeAcceptance: { status: 'ai-reviewed', reviews: [{ ...ai, vetoes: ['ugly'] }] } }))).includes('creative-review-vetoes'));
  assert.ok(codes(validateRenderResult(passed({ creativeAcceptance: { status: 'ai-reviewed', reviews: [human].map(h => ({ ...h, decision: 'comment' })) } }))).includes('creative-status-inconsistent'));
  assert.ok(codes(validateRenderResult(passed({ route: 'raea-native' }))).includes('result-route-invalid'));
});

test('严格口径（运行记录）：旧形状的 accepted 不再通过；技术验收要指向 QA 报告', () => {
  const legacy = passed({ status: 'accepted', creativeAcceptance: { status: 'accepted', events: ['girl looks up'], styleComparison: ['shot_7.6.jpg'], issues: [] } });
  assert.deepEqual(validateRenderResult(legacy).diagnostics, []);   // 默认口径：T01 的旧形状照常通过
  assert.ok(codes(validateRenderResult(legacy, { strict: true })).includes('creative-accepted-without-human'));
  const cmd = passed({ technicalAcceptance: { status: 'passed', evidence: ['ffprobe -count_frames web.mp4'] } });
  assert.deepEqual(validateRenderResult(cmd).diagnostics, []);
  assert.deepEqual(codes(validateRenderResult(cmd, { strict: true })), ['technical-evidence-not-qa']);
  assert.deepEqual(validateRenderResult(passed(), { strict: true }).diagnostics, []);
  // rendered：出片完成、待 QA，要实测字段，不要求技术验收
  const rendered = passed({ status: 'rendered', technicalAcceptance: { status: 'not-run', evidence: [] } });
  assert.deepEqual(validateRenderResult(rendered, { strict: true }).diagnostics, []);
  assert.deepEqual(codes(validateRenderResult({ ...rendered, actualEncoder: null }, { strict: true })), ['result-measured-missing']);
});
