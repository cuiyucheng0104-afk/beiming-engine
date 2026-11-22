import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  formatMetricRef,
  normalizeQuestionDraft,
  parseMetricRef,
  projectPublicQuestion,
  scanQuestionLeaks,
  validateQuestion,
} from './index.mjs';

const contractDir = fileURLToPath(new URL('../kernel/contracts/question-file/', import.meta.url));
const readText = (name) => fs.readFileSync(contractDir + name, 'utf8');
const fullText = readText('examples/full.json');
const q28 = JSON.parse(fullText);
/** 28-1 的副本，改一处再交给校验 */
const variant = (edit) => {
  const q = structuredClone(q28);
  edit(q);
  return q;
};
const violationIds = (q) => Object.keys(validateQuestion(q).violations);

// 05 第 6.1 节的起草形态（YAML 照抄成对象）。私有的参考路径、原作量测数和出处照冻结样例换成示意值
const draft28 = () => ({
  id: '28-1',
  level: 1,
  title: '环绕取景',
  brief: q28.brief,
  deliverable: { width: 1920, height: 824, fps: 24, frames: 288, audio: 'none' },
  assets: { subject: 'calib/mech-head-proxy@1' },
  refs: ['bench/refs/28-1/negative-measure.txt'],
  base_predicates: [
    'delivery(width=1920, height=824, fps=24, frames=288)',
    'bbox_w(subject) <= 0.60 @ all',
    'bbox_h(subject) <= 0.70 @ all',
    'margin_lr(subject) >= 0.20 @ all',
    'margin_tb(subject) >= 0.15 @ all',
    'orbit_total(camera, subject) in [359, 361] deg',
    'no_cut @ all',
  ],
  scoring: [
    { metric: 'meta.bbox-limits', source: 'frame-meta', pass: '四条限制 100% 的帧满足', weight: 0.5 },
    { metric: 'loop.closure-psnr', args: { a: 0, b: 287, ref: [0, 1] }, pass: 'psnr(0,287) >= psnr(0,1) - 1 dB', weight: 0.3 },
    { metric: 'pixel.bbox', args: { tol_px: 8 }, pass: '像素估出的包围盒和元数据相差不超过 8 像素', weight: 0.2 },
  ],
  controls: { reference_pass: '标准答案工程必须得满分', negative: q28.controls.negative },
  needs: ['camera.orbit', 'camera.fit', 'deliver.encode'],
  budget: { tokens: 300000, wall_s: 600, gpu_s: 120 },
  flags: { hidden: false, expected_fail: false, blocked_by: [] },
  calibration: { status: '初值未校准', source: '示意', noise_floor: null, version: 0 },
});

test('B1-1: 28-1 样题通过 validateQuestion 校验，且独立指标引用强制要求 metric: 前缀', async () => {
  const bench = await import('./index.mjs');
  assert.equal(typeof bench.validateQuestion, 'function');
  assert.equal(typeof bench.parseMetricRef, 'function');
  assert.equal(typeof bench.formatMetricRef, 'function');
  assert.equal(typeof bench.normalizeQuestionDraft, 'function');
  assert.equal(typeof bench.projectPublicQuestion, 'function');

  const res = bench.validateQuestion(q28);
  assert.equal(res.ok, true);
  assert.equal(bench.formatMetricRef('loop.closure-psnr'), 'metric:loop.closure-psnr');
  assert.equal(bench.parseMetricRef('metric:loop.closure-psnr'), 'loop.closure-psnr');
  assert.throws(() => bench.parseMetricRef('loop.closure-psnr'), TypeError);
});

test('B1-2: 契约的两个正例按对象和按原文都过，结果干净', () => {
  for (const name of ['examples/full.json', 'examples/minimal.json']) {
    const text = readText(name);
    for (const input of [text, JSON.parse(text)]) {
      assert.deepEqual(validateQuestion(input), { ok: true, schemaErrors: [], violations: {}, leaks: [] }, name);
    }
  }
});

test('B1-3: 契约的全部反例被拒，报的正好是登记的那条不变量', () => {
  const index = JSON.parse(readText('counterexamples/index.json'));
  assert.ok(index.length >= 4);
  for (const { file, violates } of index) {
    const res = validateQuestion(readText(`counterexamples/${file}`));
    assert.equal(res.ok, false, file);
    assert.deepEqual(Object.keys(res.violations), violates, file);
  }
});

test('B1-4: 05 第 6.1 节的 28-1 起草形态归一后过校验，不改传入的草稿', () => {
  const draft = draft28();
  const question = normalizeQuestionDraft(draft);
  assert.deepEqual(draft, draft28());
  assert.deepEqual(validateQuestion(question), { ok: true, schemaErrors: [], violations: {}, leaks: [] });
  // 和冻结样例只差它多出的那条 text_matches 和示意的出处
  assert.deepEqual(question, { ...q28, basePredicates: q28.basePredicates.slice(0, 7) });
  assert.equal(Object.keys(question)[0], 'format');

  // scoring[].metric 带 metric: 前缀的草稿归一成同一份
  const prefixed = draft28();
  for (const item of prefixed.scoring) item.metric = formatMetricRef(item.metric);
  assert.deepEqual(normalizeQuestionDraft(prefixed), question);
  // 标准形态原样通过归一
  assert.deepEqual(normalizeQuestionDraft(q28), q28);
});

test('B1-5: 草稿里保留原作拆解路径会被泄露门禁拦下', () => {
  const draft = draft28();
  draft.refs = [['复刻', '28-示意案例', '工程', '量测结果.txt'].join('/')];
  const res = validateQuestion(normalizeQuestionDraft(draft));
  assert.equal(res.ok, false);
  assert.deepEqual(res.leaks, [{ code: 'case-library-path', path: '/refs/0' }]);
});

test('B1-6: 归一不猜：两种拼法并存报错，换不了的值留给校验去拒', () => {
  assert.throws(() => normalizeQuestionDraft({ ...draft28(), basePredicates: [] }), /basePredicates 写了两种拼法/);
  for (const bad of [null, [], 'x', 1]) assert.throws(() => normalizeQuestionDraft(bad), TypeError);

  const edited = (edit) => {
    const draft = draft28();
    edit(draft);
    return validateQuestion(normalizeQuestionDraft(draft));
  };
  // 非整数帧率要自己写成分数
  assert.match(edited((d) => { d.deliverable.fps = 23.976; }).schemaErrors.join('\n'), /\/deliverable\/fps must be string/);
  // size 和 width 都写了：不覆盖，报多余的键
  assert.match(edited((d) => { d.deliverable.size = [1, 1]; }).schemaErrors.join('\n'), /\/deliverable must NOT have additional properties："width"/);
  assert.match(edited((d) => { d.budget.wallMs = 1; }).schemaErrors.join('\n'), /\/budget must NOT have additional properties："wallS"/);
  assert.match(edited((d) => { d.calibration.status = '已校准'; }).schemaErrors.join('\n'), /\/calibration\/status must match pattern/);
  assert.match(edited((d) => { d.scoring[0].metric = 'metric:metric:meta.bbox-limits'; }).schemaErrors.join('\n'), /\/scoring\/0\/metric must match pattern/);
  // 资产别名里的下划线不动；args 里的键照通用口径换成小驼峰
  const kept = normalizeQuestionDraft({ ...draft28(), assets: { mech_head: 'calib/mech-head-proxy@1' }, ext: { 'bench.note_x': { a_b: 1 } } });
  assert.deepEqual(kept.assets, { mech_head: 'calib/mech-head-proxy@1' });
  assert.deepEqual(kept.ext, { 'bench.note_x': { a_b: 1 } });
  assert.deepEqual(kept.scoring[2].args, { tolPx: 8 });
  // args 第一层往下是数据（实体名之类），键不动
  const deep = draft28();
  deep.scoring[2].args = { per_entity: { hero_head: 0.6, fan_L: 1 }, list: [{ a_b: 1 }] };
  assert.deepEqual(normalizeQuestionDraft(deep).scoring[2].args, { perEntity: { hero_head: 0.6, fan_L: 1 }, list: [{ a_b: 1 }] });
  // 1.005 * 1000 是 1004.9999999999999
  assert.equal(normalizeQuestionDraft({ ...draft28(), budget: { tokens: 1, wall_s: 1.005, gpu_s: 0.5 } }).budget.wallMs, 1005);
  // 报错不回显命中泄露规则的键
  const leakyKey = { ...draft28(), ext: { 'bench.x': { 'lab://synthetic/0': undefined } } };
  assert.throws(() => normalizeQuestionDraft(leakyKey), (error) => error instanceof TypeError && error.message === '[redacted] 不是 JSON 数据');
});

test('B1-7: 指标引用只认 metric: 加点分小写的指标名', () => {
  for (const name of ['loop.closure-psnr', 'audio.loudness', 'meta.bbox-limits', 'a1.b2.c3']) {
    assert.equal(formatMetricRef(name), `metric:${name}`);
    assert.equal(parseMetricRef(`metric:${name}`), name);
  }
  const badRefs = [
    'loop.closure-psnr', 'metric:', 'metric:metric:loop.closure-psnr', 'metric:Loop.closure', 'metric:loop', 'metric:loop.closure-psnr@1',
    'metric: loop.closure-psnr', 'Metric:loop.closure-psnr', 'metric:loop..psnr', 'metric:loop.closure-psnr\n', '', null, undefined, 7, {},
  ];
  for (const ref of badRefs) assert.throws(() => parseMetricRef(ref), TypeError, String(ref));
  const badNames = ['metric:loop.closure-psnr', 'Loop.closure', 'loop', 'loop.closure_psnr', 'loop.closure-psnr@1', '', null, undefined, 7n];
  for (const name of badNames) assert.throws(() => formatMetricRef(name), TypeError, String(name));
});

test('B1-8: 基础谓词的名字、语法和实参都对登记表核', () => {
  const withPredicate = (text) => variant((q) => { q.basePredicates[6] = text; });
  const pass = [
    'no_cut',
    'text_matches("BEIMING;01") @ all',
    'text_matches("x in [1, 2] deg") @ all',
    'inside_frame(subject, margin=0.05) @ [0,10)',
    'visible(subject) >= 0.5 @ cut(12) + 2',
    'orbit_total(camera, subject) in [359, 361] deg @ all',
    'contact(a, b, max=0.3mm) <= 1 mm',
    // 引号里长得像比较的文字不碰，后面真正的比较照常认
    'text_matches("x >= 1 s @ y") >= 0.5 deg @ all',
    'delivery(output)',
  ];
  for (const text of pass) assert.deepEqual(validateQuestion(withPredicate(text)).violations, {}, text);

  const syntax = [
    'delivery(foo=1)',
    'bbox_w(subject <= 0.6',
    'bbox_w() <= 0.6',
    'bbox_w(subject, other) <= 0.6',
    'bbox_w(subject) <= 0.6 @ sometimes',
    'bbox_w(subject) <= 0.6 px',
    'visible(subject) >= 0.5 deg trailing',
    // 单位后面还粘着字：不摘，否则会拼成 0.55
    'visible(subject) >= 0.5 s5',
    'cut_at(1.5)',
    'no_cut @ [10,2)',
  ];
  for (const text of syntax) assert.deepEqual(violationIds(withPredicate(text)), ['B1_PREDICATE_SYNTAX'], text);
  assert.match(validateQuestion(withPredicate('delivery(foo=1)')).violations.B1_PREDICATE_SYNTAX[0], /^basePredicates 第 7 条：谓词 delivery 没有参数 foo$/);

  for (const text of ['head_width(subject) <= 0.6', 'no_cut@all', 'No_cut', 'no_cut ; no_cut @ [0,10)', 'no_cut;no_cut', 'text_matches("a) ; no_cut']) {
    assert.ok(violationIds(withPredicate(text)).includes('QF2'), text);
  }
});

test('B1-9: 泄露扫描只回类型和位置，不回显内容', () => {
  const localPaths = ['/' + 'Users/synthetic/q.json', '/' + 'home/synthetic', 'C:' + '\\synthetic'];
  const cases = [
    ['lab-url', 'lab://synthetic/0'],
    ['private-source-path', '原包源码'],
    ['private-source-path', 'cards-overlay'],
    ['case-library-path', ['复刻', '示意', '量测结果.txt'].join('/')],
    ['case-library-path', '复刻' + '\\示意'],
    ['hidden-exam-path', ['实验室', 'exams-hidden', '28-1a.json'].join('/')],
    ...localPaths.map((path) => ['local-path', path]),
    ['bare-sha256', 'a'.repeat(64)],
    ['bare-sha256', `sha256:${'0F'.repeat(32)}`],
    // 全角写法
    ['lab-url', 'ｌａｂ：／／synthetic'],
    ['case-library-path', '复刻／示意'],
    ['bare-sha256', '１'.repeat(64)],
    // 夹了零宽字符
    ['lab-url', 'lab\u200b://synthetic'],
  ];
  for (const [code, secret] of cases) {
    for (const edit of [(q) => { q.brief = `见 ${secret}`; }, (q) => { q.refs = [secret]; }, (q) => { q.ext = { 'bench.note': { deep: [secret] } }; }]) {
      const res = validateQuestion(variant(edit));
      assert.equal(res.ok, false, secret);
      assert.deepEqual(res.leaks.map((leak) => leak.code), [code], secret);
      for (const shown of [secret, JSON.stringify(secret).slice(1, -1)]) assert.ok(!JSON.stringify(res).includes(shown), secret);
    }
  }
  assert.deepEqual(scanQuestionLeaks(variant((q) => { q.brief = 'lab://synthetic/0'; })), [{ code: 'lab-url', path: '/brief' }]);
  // 键里的泄露：路径上那一段不回显
  assert.deepEqual(scanQuestionLeaks({ ext: { 'lab://synthetic/0': { x: 1 } } }), [{ code: 'lab-url', path: '/ext', field: 'key' }]);
  assert.deepEqual(scanQuestionLeaks({ ext: { 'lab://synthetic/0': 'cards-overlay' } }), [
    { code: 'lab-url', path: '/ext', field: 'key' },
    { code: 'private-source-path', path: '/ext/[redacted]' },
  ]);
  // 没有泄露的词：复刻题、65 位十六进制、带环的对象
  assert.deepEqual(scanQuestionLeaks({ brief: `M4 的复刻题 ${'a'.repeat(65)}` }), []);
  const ring = { brief: 'ok' };
  ring.self = ring;
  assert.deepEqual(scanQuestionLeaks(ring), []);
  for (const clean of [q28, fullText, null, undefined, 3]) assert.deepEqual(scanQuestionLeaks(clean), []);
});

test('B1-10: 按原文校验能查出重复键和转义里夹带的泄露', () => {
  const shadowed = fullText.replace('"id": "28-1",', '"id": "lab://synthetic/0",\n  "id": "28-1",');
  assert.equal(JSON.parse(shadowed).id, '28-1');
  assert.equal(validateQuestion(JSON.parse(shadowed)).ok, true);
  assert.deepEqual(validateQuestion(shadowed), { ok: false, schemaErrors: [], violations: {}, leaks: [{ code: 'lab-url', line: 3 }] });

  const escaped = fullText.replace('"环绕取景"', '"\\u006cab:\\/\\/synthetic"');
  assert.deepEqual(validateQuestion(escaped).leaks, [{ code: 'lab-url', line: 5 }]);
  const digits = fullText.replace('"level": 1,', `"level": ${'1'.repeat(64)},`);
  assert.deepEqual(validateQuestion(digits).leaks, [{ code: 'bare-sha256', line: 4 }]);
  // 文字里的「a:」加换行不是盘符
  assert.equal(validateQuestion(fullText.replace('"环绕取景"', '"规格 a' + ':\\n环绕"')).ok, true);

  // 不是 JSON：有泄露先报泄露，没有才报语法
  assert.deepEqual(validateQuestion('{ "brief": "lab://synthetic/0"'), { ok: false, schemaErrors: [], violations: {}, leaks: [{ code: 'lab-url', line: 1 }] });
  assert.deepEqual(validateQuestion('{\n"a": "cards-overlay",\n"b": "lab://x lab://y"').leaks, [{ code: 'private-source-path', line: 2 }, { code: 'lab-url', line: 3 }]);
  const broken = validateQuestion('{ "id": ');
  assert.deepEqual({ ...broken, parseError: typeof broken.parseError }, { ok: false, schemaErrors: ['/ 不是有效的 JSON'], violations: {}, leaks: [], parseError: 'string' });
});

test('B1-10b: 原文里同一个对象的键写了不止一次不收；超长词元不抛错', () => {
  // 取前一个键的解析器会把它当隐藏题，取后一个的当公开题
  const twice = fullText.replace('"hidden": false,', '"hidden": true,\n    "hidden": false,');
  assert.equal(JSON.parse(twice).flags.hidden, false);
  assert.deepEqual(validateQuestion(twice), { ok: false, schemaErrors: ['/ 第 77 行的键 "hidden" 写了不止一次'], violations: {}, leaks: [] });
  assert.throws(() => projectPublicQuestion(twice), /写了不止一次/);
  assert.deepEqual(validateQuestion('{"a":{"b":1,"c":[{"b":1},{"b":2}],"b":2}}').schemaErrors, ['/ 第 1 行的键 "b" 写了不止一次']);

  // 8M 字符的词元在 V8 上会让词元正则爆栈：回结果，不抛给调用方
  const huge = validateQuestion(fullText.replace('"环绕取景"', JSON.stringify('环'.repeat(8 * 1024 * 1024))));
  assert.equal(typeof huge.ok, 'boolean');
  if (!huge.ok) assert.match(huge.schemaErrors[0], /^\/ 校验不了：/);
});

test('B1-11: 不是纯 JSON 数据的输入一律拒，不抛错', () => {
  class Question { constructor() { Object.assign(this, structuredClone(q28)); } }
  const ring = variant((q) => { q.ext = { 'bench.ring': {} }; });
  ring.ext['bench.ring'].self = ring;
  const moving = variant((q) => {
    let reads = 0;
    Object.defineProperty(q, 'brief', { enumerable: true, get: () => (reads++ ? 'lab://synthetic/0' : 'ok') });
  });
  const cases = [
    [null, /^\/ must be object$/],
    [[], /^\/ must be object$/],
    [42, /^\/ must be object$/],
    [undefined, /^\/ 不是 JSON 数据（undefined）$/],
    [() => q28, /^\/ 不是 JSON 数据（function）$/],
    [new Question(), /^\/ 不是普通对象$/],
    [variant((q) => { q.calibration.noiseFloor = NaN; }), /^\/calibration\/noiseFloor 不是有限数$/],
    [variant((q) => { q.scoring[1].args.a = Infinity; }), /^\/scoring\/1\/args\/a 不是有限数$/],
    [variant((q) => { q.scoring[1].args.when = new Date(0); }), /^\/scoring\/1\/args\/when 不是普通对象$/],
    [variant((q) => { q.needs = new Array(2); }), /^\/needs 的 0 不是数据属性$/],
    [ring, /^\/ext\/bench\.ring\/self 有环$/],
    [moving, /^\/ 的 brief 不是数据属性$/],
    [fullText.replace('"a": 0', '"a": 1e999'), /^\/scoring\/1\/args\/a 不是有限数$/],
    // 键名命中泄露规则时，报错不带位置
    [variant((q) => { q.ext = { 'bench.x': { 'lab://synthetic/0': NaN } }; }), /^\[redacted\] 不是 JSON 数据$/],
    [variant((q) => { q.ext = { 'bench.x': { ['/' + 'Users/synthetic/x.blend']: undefined } }; }), /^\[redacted\] 不是 JSON 数据$/],
  ];
  for (const [input, expected] of cases) {
    const res = validateQuestion(input);
    assert.equal(res.ok, false, String(expected));
    assert.equal(res.schemaErrors.length, 1, String(expected));
    assert.match(res.schemaErrors[0], expected);
  }
  // 没有原型的对象、别的上下文那种根原型的对象照常收
  assert.equal(validateQuestion(Object.assign(Object.create(null), q28)).ok, true);
  assert.equal(validateQuestion(Object.assign(Object.create(Object.create(null)), q28)).ok, true);
});

test('B1-12: 结构错误带路径；多余的键报出键名', () => {
  const errors = (edit) => validateQuestion(variant(edit)).schemaErrors;
  assert.deepEqual(errors((q) => { q.base_predicates = q.basePredicates; }), ['/ must NOT have additional properties："base_predicates"']);
  assert.deepEqual(errors((q) => { delete q.controls.negative; }), ["/controls must have required property 'negative'"]);
  assert.match(errors((q) => { q.id = '028-1'; })[0], /^\/id must match pattern/);
  assert.match(errors((q) => { q.deliverable.fps = 24; })[0], /^\/deliverable\/fps must be string/);
  // 帧率照时间键契约 3.2：分子分母互质
  assert.deepEqual(validateQuestion(variant((q) => { q.deliverable.fps = '48/2'; })).violations, { B1_FPS: ['deliverable.fps 是 48/2，分子分母必须互质'] });
  assert.equal(validateQuestion(variant((q) => { q.deliverable.fps = '24000/1001'; })).ok, true);
  // 指标名和卡名两个名字空间：scoring[].metric 不带前缀，needs 不收带前缀的
  assert.match(errors((q) => { q.scoring[0].metric = 'metric:meta.bbox-limits'; })[0], /^\/scoring\/0\/metric must match pattern/);
  assert.match(errors((q) => { q.needs.push('metric:loop.closure-psnr'); })[0], /^\/needs\/3 must match pattern/);
  assert.match(errors((q) => { q.needs[0] = 'camera.orbit@1'; })[0], /^\/needs\/0 must match pattern/);
  // 原型上的同名属性不算数
  const inherited = variant((q) => { delete q.brief; });
  assert.deepEqual(validateQuestion(Object.assign(Object.create({ brief: 'x' }), inherited)).schemaErrors, ['/ 不是普通对象']);
});

test('B1-13: 指标名混进 needs，或在文字里单独出现没带 metric: 前缀，都报 B1_METRIC_NAMESPACE', () => {
  assert.deepEqual(validateQuestion(variant((q) => { q.needs.push('loop.closure-psnr'); })).violations, {
    B1_METRIC_NAMESPACE: ['needs 里的 loop.closure-psnr 是这道题的指标名，needs 只写卡名'],
  });
  const bare = [
    (q) => { q.brief += '判分看 loop.closure-psnr。'; },
    (q) => { q.title = 'pixel.bbox'; },
    (q) => { q.scoring[1].pass = 'loop.closure-psnr 不低于 30 dB'; },
    (q) => { q.controls.negative += '（Metric:pixel.bbox 不过）'; },
    (q) => { q.brief += '另见 xmetric:pixel.bbox。'; },
    (q) => { q.controls.random = '任取一帧的 meta.bbox-limits 命中率当基线'; },
    (q) => { q.calibration.source = '示意，见 pixel.bbox.'; },
    (q) => { q.flags.expectedFail = true; q.flags.blockedBy = ['pixel.bbox 还没实现']; },
  ];
  for (const edit of bare) assert.deepEqual(violationIds(variant(edit)), ['B1_METRIC_NAMESPACE'], String(edit));
  assert.deepEqual(validateQuestion(variant(bare[2])).violations.B1_METRIC_NAMESPACE, ['scoring/1/pass 里单独提到指标 loop.closure-psnr，要写成 metric:loop.closure-psnr']);

  const fine = [
    (q) => { q.brief += '判分看 metric:loop.closure-psnr。'; },
    (q) => { q.scoring[1].pass = 'metric:loop.closure-psnr 不低于 metric:pixel.bbox'; },
    // 更长的名字、别的卡名不是这道题的指标
    (q) => { q.brief += '用 camera.orbit 卡，另见 loop.closure-psnr-v2、xpixel.bbox、pixel.bbox.raw、pixelxbbox。'; },
    // 路径里的一段不算提到指标
    (q) => { q.calibration.source = '示意，见 bench/refs/28-1/pixel.bbox/readme.txt、pixel.bbox/x 和 notes/pixel.bbox'; },
  ];
  for (const edit of fine) assert.equal(validateQuestion(variant(edit)).ok, true, String(edit));
});

test('B1-14: 预期失败和 blockedBy 必须对上', () => {
  assert.deepEqual(validateQuestion(variant((q) => { q.flags.expectedFail = true; })).violations, {
    B1_BLOCKED_BY: ['flags.expectedFail 是 true，blockedBy 至少写一项挡住它的东西'],
  });
  assert.deepEqual(validateQuestion(variant((q) => { q.flags.blockedBy = ['缺 camera.fit']; })).violations, {
    B1_BLOCKED_BY: ['flags.expectedFail 是 false，blockedBy 必须是空数组'],
  });
  assert.equal(validateQuestion(variant((q) => { q.flags.expectedFail = true; q.flags.blockedBy = ['缺 camera.fit']; })).ok, true);
});

test('B1-15: 一道题同时违反几条时逐条都报', () => {
  const res = validateQuestion(variant((q) => {
    q.scoring[0].weight = 0.6;
    q.basePredicates[1] = 'head_width(subject) <= 0.6';
    q.basePredicates[2] = 'delivery(foo=1)';
    q.needs.push('pixel.bbox');
    q.flags.expectedFail = true;
  }));
  assert.equal(res.ok, false);
  assert.deepEqual(Object.keys(res.violations), ['QF1', 'QF2', 'B1_PREDICATE_SYNTAX', 'B1_METRIC_NAMESPACE', 'B1_BLOCKED_BY']);
});

test('B1-16: 隐藏题的公开投影只留题面、交付规格和资产', () => {
  const hidden = variant((q) => { q.flags.hidden = true; q.ext = { 'bench.note': '出题备注' }; });
  const view = projectPublicQuestion(hidden);
  assert.deepEqual(view, {
    id: '28-1', level: 1, title: q28.title, brief: q28.brief, deliverable: q28.deliverable, assets: q28.assets,
  });
  const text = JSON.stringify(view);
  const secrets = [
    ...q28.scoring.flatMap((item) => [item.metric, item.pass]), ...Object.values(q28.controls), ...q28.needs, ...q28.refs,
    ...q28.basePredicates, '出题备注', 'uncalibrated', 'tolPx', 'gpuSeconds', 'blockedBy',
  ];
  for (const secret of secrets) assert.ok(!text.includes(secret), secret);
  // 原文输入一样；返回的是副本，改它不动原对象
  assert.deepEqual(projectPublicQuestion(JSON.stringify(hidden)), view);
  view.deliverable.size[0] = 1;
  view.assets.subject = 'x';
  assert.deepEqual(hidden.deliverable.size, [1920, 824]);
  assert.equal(hidden.assets.subject, 'calib/mech-head-proxy@1');
});

test('B1-17: 公开题的投影留全部字段、去掉 ext；没过校验的题不投影', () => {
  const open = variant((q) => { q.ext = { 'bench.note': '出题备注' }; });
  const view = projectPublicQuestion(open);
  assert.deepEqual(view, q28);
  assert.notEqual(view.scoring, open.scoring);
  assert.ok(Object.hasOwn(open, 'ext'));

  assert.throws(() => projectPublicQuestion(variant((q) => { q.scoring[0].weight = 0.6; })), /题目没过校验，不做投影：QF1/);
  assert.throws(() => projectPublicQuestion(variant((q) => { q.flags.hidden = 'yes'; })), /\/flags\/hidden must be boolean/);
  assert.throws(() => projectPublicQuestion(null), TypeError);
  const badKey = variant((q) => { q.flags.hidden = true; q.ext = { 'bench.x': { 'lab://synthetic/0': NaN } }; });
  assert.throws(() => projectPublicQuestion(badKey), (error) => error instanceof TypeError && !error.message.includes('synthetic'));
  const leaky = variant((q) => { q.flags.hidden = true; q.brief = 'lab://synthetic/0'; });
  assert.throws(() => projectPublicQuestion(leaky), (error) => error instanceof TypeError && /lab-url/.test(error.message) && !error.message.includes('synthetic'));
});

test('B1-R2-Red 一审收口：规范 sha256: 摘要放行、JSON 语法诊断不回显原文、不执行自有 getter、拒绝数组附加属性与含冒号 refs 及裸指标 source，并锁死 QF1 两侧容差与重复参数', () => {
  const validSha = `sha256:${'a1b2c3d4'.repeat(8)}`;
  const bareSha = 'e5f60718'.repeat(8);
  // 1) 规范小写 sha256: 放行，同串混入裸哈希仍拦截
  assert.equal(validateQuestion(variant((q) => { q.ext = { 'bench.digest': validSha }; })).ok, true);
  assert.equal(validateQuestion(JSON.stringify(variant((q) => { q.ext = { 'bench.digest': validSha }; }))).ok, true);
  assert.equal(validateQuestion(variant((q) => { q.ext = { 'bench.digest': `${validSha} ${bareSha}` }; })).ok, false);

  // 2) JSON 语法错误诊断脱敏：隐藏题原文含未加引号的秘密评分词 SECRET_SCORE_TOKEN 时，返回结果绝不回显该词
  const badJson = '{"format":"question/0.1","flags":{"hidden":true},"scoring":[{"pass":SECRET_SCORE_TOKEN}]}';
  const badRes = validateQuestion(badJson);
  assert.equal(badRes.ok, false);
  assert.equal(JSON.stringify(badRes).includes('SECRET_SCORE_TOKEN'), false);

  // 3) 自有 getter 零调用且两个入口一致拒收；数组附加可枚举属性一致拒收
  let getterCalls = 0;
  const withGetter = variant(() => {});
  Object.defineProperty(withGetter, 'brief', { enumerable: true, get() { getterCalls += 1; return 'boom'; } });
  assert.ok(scanQuestionLeaks(withGetter).length > 0);
  assert.equal(validateQuestion(withGetter).ok, false);
  assert.equal(getterCalls, 0);

  const arrProp = variant(() => {});
  arrProp.needs.extraNote = 'clean';
  assert.equal(validateQuestion(arrProp).ok, false);

  // 4) refs 含冒号被拒，正常相对路径通过；scoring[].source 裸写已知指标名被拒，带 metric: 或 frame-meta 通过
  assert.equal(validateQuestion(variant((q) => { q.refs = ['bench/refs/note-en.txt']; })).ok, true);
  assert.equal(validateQuestion(variant((q) => { q.refs = ['bench/refs/note:en.txt']; })).ok, false);
  assert.equal(validateQuestion(variant((q) => { q.scoring[0].source = 'pixel.bbox'; })).ok, false);
  assert.equal(validateQuestion(variant((q) => { q.scoring[0].source = 'metric:pixel.bbox'; })).ok, true);
  assert.equal(validateQuestion(variant((q) => { q.scoring[0].source = 'frame-meta'; })).ok, true);

  // 5) 杀灭 M01/M15（QF1 1e-9 两侧）、M10（重复参数绑定）、M14（直接调 scanQuestionLeaks(rawJson)）
  assert.equal(validateQuestion(variant((q) => { q.scoring[0].weight += 1e-6; })).ok, false);
  assert.equal(validateQuestion(variant((q) => { q.scoring[0].weight += 5e-10; })).ok, true);
  assert.equal(validateQuestion(variant((q) => { q.basePredicates[0] = 'delivery(width=1920, width=1920)'; })).ok, false);
  // 6) 补边界：全角或夹零宽字符的 sha256: 写法照拦；扫描给取值器记 accessor-property、给 Symbol 键记 symbol-key；不可枚举属性、refs 的空段和 . 段不收
  for (const sneaky of [`ｓｈａ２５６：${'a1b2c3d4'.repeat(8)}`, `sha256:${'a1b2'}\u200b${'c3d4a1b2'.repeat(7)}c3d4`, `SHA256:${'a1b2c3d4'.repeat(8)}`]) {
    assert.deepEqual(validateQuestion(variant((q) => { q.ext = { 'bench.digest': sneaky }; })).leaks.map((leak) => leak.code), ['bare-sha256']);
  }
  assert.deepEqual(scanQuestionLeaks(withGetter).filter((leak) => leak.code === 'accessor-property'), [{ code: 'accessor-property', path: '/brief' }]);
  const withSymbol = variant((q) => { q.ext = { 'bench.x': { [Symbol('s')]: 1 } }; });
  assert.deepEqual(scanQuestionLeaks(withSymbol), [{ code: 'symbol-key', path: '/ext/bench.x' }]);
  assert.deepEqual(validateQuestion(withSymbol).schemaErrors, ['/ext/bench.x 带了 Symbol 键']);
  assert.deepEqual(validateQuestion(arrProp).schemaErrors, ['/needs 带了下标以外的属性']);
  const hiddenProp = variant((q) => { Object.defineProperty(q, 'note', { value: 'x', enumerable: false }); });
  assert.deepEqual(validateQuestion(hiddenProp).schemaErrors, ['/ 的 note 不是数据属性']);
  for (const ref of ['bench/refs/', 'bench//refs', './bench', 'bench/./refs', 'bench/re\u0007fs']) {
    assert.deepEqual(Object.keys(validateQuestion(variant((q) => { q.refs = [ref]; })).violations), ['B1_REF_PATH'], ref);
  }
  assert.match(validateQuestion('{"id": SECRET}').parseError, /^无效的 JSON 语法(（位置 \d+）)?$/);
  const directLeaks = scanQuestionLeaks('{"id":"28-1","refs":["cards-overlay/secret.yaml"],"refs":["bench/ok.txt"]}');
  assert.ok(directLeaks.length > 0 && !JSON.stringify(directLeaks).includes('secret'));
});

test('B1-R3-Red 二审收口：JSON 语法错误不回显原文伪造 position 数字、非法数组双入口一致识别、安全整数上限与孤立代理码元拒收、杀灭 R15/P01/P02', () => {
  // 1) F1: 原文伪装 "position 42" 时，parseError 绝不提取原文里的 42
  const fakePosRes = validateQuestion('position 42');
  assert.equal(fakePosRes.ok, false);
  assert.equal(fakePosRes.parseError, '无效的 JSON 语法');
  assert.equal(JSON.stringify(fakePosRes).includes('42'), false);

  // 2) F2 + P01: 数组带普通附加属性、稀疏空洞在 scanQuestionLeaks 与 validateQuestion 双入口一致报出；附加属性值含泄露标记时同步报出内容命中
  const arrCleanExtra = variant(() => {});
  arrCleanExtra.needs.extraNote = 'clean';
  assert.ok(scanQuestionLeaks(arrCleanExtra).length > 0, '独立扫描必须识别带普通附加属性的非法数组');
  assert.equal(validateQuestion(arrCleanExtra).ok, false);

  const arrSparse = variant(() => {});
  delete arrSparse.needs[0];
  assert.ok(scanQuestionLeaks(arrSparse).length > 0, '独立扫描必须识别稀疏数组空洞');
  assert.equal(validateQuestion(arrSparse).ok, false);

  const arrLeakyExtra = variant(() => {});
  arrLeakyExtra.needs.reviewNote = 'cards-overlay/secret.yaml';
  const arrLeakHits = scanQuestionLeaks(arrLeakyExtra);
  assert.ok(arrLeakHits.some((item) => item.code === 'private-source-path' && item.path === '/needs/reviewNote'));

  // 3) P02: 多行重复键原文直接调 scanQuestionLeaks 精确断言完整 { code, line }
  assert.deepEqual(
    scanQuestionLeaks('{\n  "id": "28-1",\n  "refs": ["cards-overlay/secret.yaml"],\n  "refs": ["bench/ok.txt"]\n}'),
    [{ code: 'private-source-path', line: 3 }],
  );

  // 4) R15: 非 TypeError 异常兜底只回错误名，绝不带出异常 message 中的敏感词
  const hostileProxy = new Proxy({}, {
    getOwnPropertyDescriptor() {
      throw new Error('review fixture secret');
    },
    ownKeys() {
      throw new Error('review fixture secret');
    },
  });
  const proxyRes = validateQuestion(hostileProxy);
  assert.equal(proxyRes.ok, false);
  assert.deepEqual(proxyRes.schemaErrors, ['/ 校验不了：Error']);
  assert.equal(JSON.stringify(proxyRes).includes('review fixture'), false);

  // 5) 契约通用口径：整数型字段最大为 MAX_SAFE_INTEGER (9007199254740991)，+1 在对象与原文双入口均拒收；合法浮点字段不受影响
  const maxSafeQ = variant((q) => { q.deliverable.frames = Number.MAX_SAFE_INTEGER; });
  assert.equal(validateQuestion(maxSafeQ).ok, true);
  assert.equal(validateQuestion(JSON.stringify(maxSafeQ)).ok, true);
  const unsafeFramesObj = variant((q) => { q.deliverable.frames = Number.MAX_SAFE_INTEGER + 1; });
  assert.equal(validateQuestion(unsafeFramesObj).ok, false);
  assert.equal(validateQuestion(JSON.stringify(unsafeFramesObj)).ok, false);
  assert.equal(validateQuestion(variant((q) => { q.budget.tokens = Number.MAX_SAFE_INTEGER + 1; })).ok, false);
  assert.equal(validateQuestion(variant((q) => { q.deliverable.size = [Number.MAX_SAFE_INTEGER + 1, 824]; })).ok, false);

  // 6) 契约通用口径：合法补充平面代理对通过，孤立高/低代理码元与 UTF-8 BOM 在对象与原文双入口均拒收
  const emojiQ = variant((q) => { q.title = '测试 😀 镜头'; });
  assert.equal(validateQuestion(emojiQ).ok, true);
  assert.equal(validateQuestion(JSON.stringify(emojiQ).replace('😀', '\\uD83D\\uDE00')).ok, true);
  for (const lone of ['标题\uD800尾', '标题\uDC00尾']) {
    const loneQ = variant((q) => { q.title = lone; });
    assert.equal(validateQuestion(loneQ).ok, false);
  }
  for (const rawLoneEsc of ['\\uD800', '\\uDFFF']) {
    const rawJson = JSON.stringify(variant((q) => { q.title = '__SURR__'; })).replace('__SURR__', rawLoneEsc);
    assert.equal(validateQuestion(rawJson).ok, false);
  }
  assert.equal(validateQuestion(`\uFEFF${JSON.stringify(q28)}`).ok, false);
});
