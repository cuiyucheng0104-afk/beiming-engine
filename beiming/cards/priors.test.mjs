import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PRIOR_DOMAINS,
  PRIOR_EVIDENCE_LEVELS,
  PRIOR_UNITS,
  createPriorsStore,
  scanPriorLeaks,
  validatePriorEntry,
  validatePriorsTable,
} from './priors.mjs';

const validAudioPrior = () => ({
  id: 'audio.master.target-loudness',
  domain: 'audio-music-voice-subs',
  topic: 'audio.master.loudness',
  title: '成片母带目标响度',
  value: -14,
  unit: 'LUFS',
  conditions: {
    appliesWhen: ['网页与流媒体双声道母带'],
    notWhen: ['纯静音测试片'],
  },
  provenance: {
    caseId: '01-remake',
    evidenceLevel: '实测',
    docRef: '[14]',
  },
  verifiedInOurStack: true,
  readbackEvidence: {
    envKey: 'ffmpeg/8.0.1/mac-arm64',
    reportSha256: `sha256:${'a1b2c3d4'.repeat(8)}`,
  },
  conflicts: [
    {
      caseId: '29',
      value: -16,
      unit: 'LUFS',
      evidenceLevel: '实测',
      reason: '播客讲解片留更大口播动态余量',
    },
  ],
});

const validColorPrior = () => ({
  id: 'fx.palette.warm-ember',
  domain: 'fx-particles-ui-2d',
  topic: 'fx.ember.core-color',
  title: '余烬核心场景线性色值',
  value: [2.4, 0.65, 0.12],
  unit: 'rgb-linear',
  colorSpace: 'scene-linear-rec709',
  conditions: {
    appliesWhen: ['HDR 场景参考粒子发光核'],
  },
  provenance: {
    caseId: '外01',
    evidenceLevel: '源码',
    docRef: '[12]',
  },
  verifiedInOurStack: false,
});

test('C9-1 合法先验条目与先验表通过校验，缺单位或未知单位被拒', () => {
  assert.ok(PRIOR_UNITS.includes('LUFS') && PRIOR_UNITS.includes('m') && PRIOR_UNITS.includes('rad/s'));
  assert.ok(PRIOR_EVIDENCE_LEVELS.includes('源码') && PRIOR_EVIDENCE_LEVELS.includes('未读回') === false);
  assert.ok(PRIOR_DOMAINS.length >= 7);

  assert.equal(validatePriorEntry(validAudioPrior()).ok, true);
  assert.equal(validatePriorEntry(validColorPrior()).ok, true);

  const noUnit = validAudioPrior();
  delete noUnit.unit;
  assert.equal(validatePriorEntry(noUnit).ok, false);
  assert.equal(validatePriorEntry({ ...validAudioPrior(), unit: '' }).ok, false);
  assert.equal(validatePriorEntry({ ...validAudioPrior(), unit: 'unknown-unit' }).ok, false);
});

test('C9-2 颜色类先验缺色彩空间被拒，标已读回但缺读回证据被拒，私有路径与裸哈希泄露被拒', () => {
  const missingCs = validColorPrior();
  delete missingCs.colorSpace;
  assert.equal(validatePriorEntry(missingCs).ok, false);

  const fakeVerified = { ...validColorPrior(), verifiedInOurStack: true };
  assert.equal(validatePriorEntry(fakeVerified).ok, false);

  const leaky = validColorPrior();
  leaky.provenance.note = '复刻/外01/工程/原包源码/80_post.js';
  const leakRes = validatePriorEntry(leaky);
  assert.equal(leakRes.ok, false);
  assert.ok(leakRes.leaks.length > 0);
  assert.equal(JSON.stringify(leakRes).includes('80_post.js'), false);
});

test('C9-3 先验表支持同子题同案例防重、汇总行指回明细不重复计数、conflicts 核验与检索库过滤', () => {
  const p1 = validAudioPrior();
  const p2 = validColorPrior();
  const summaryRow = {
    id: 'audio.master.target-loudness-summary',
    domain: 'audio-music-voice-subs',
    topic: 'audio.master.loudness',
    title: '响度跨案例区间汇总',
    value: [-16, -13],
    unit: 'LUFS',
    conditions: { appliesWhen: ['流媒体成片'] },
    provenance: { caseId: 'summary:audio-loudness', evidenceLevel: '实测' },
    verifiedInOurStack: false,
    summaryOf: ['audio.master.target-loudness'],
  };
  const table = { format: 'priors/0.1', entries: [p1, p2, summaryRow] };
  const res = validatePriorsTable(table);
  assert.equal(res.ok, true, JSON.stringify(res));

  const store = createPriorsStore(table);
  assert.equal(store.stats().detailCount, 2);
  assert.equal(store.stats().summaryCount, 1);
  assert.equal(store.query({ onlyVerified: true }).length, 1);
  assert.equal(store.query({ onlyVerified: false, includeSummaries: false }).length, 2);
});

const codes = (res) => res.errors.map((e) => `${e.code}@${e.path}`);
const HEX = 'a1b2c3d4'.repeat(8);

test('C9-4 单位与色彩空间：冲突项缺单位、线性与显示错配、非颜色单位带色彩空间都被拒', () => {
  const c = validAudioPrior();
  delete c.conflicts[0].unit;
  assert.deepEqual(codes(validatePriorEntry(c)), ['prior.missing-unit@/conflicts/0/unit']);
  const c2 = validAudioPrior();
  c2.conflicts[0].unit = 'lufs';
  assert.deepEqual(codes(validatePriorEntry(c2)), ['prior.unknown-unit@/conflicts/0/unit']);
  assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), unit: 'unknown-unit' })), ['prior.unknown-unit@/unit']);
  const noUnit = validAudioPrior();
  delete noUnit.unit;
  assert.deepEqual(codes(validatePriorEntry(noUnit)), ['prior.missing-unit@/unit']);

  assert.deepEqual(codes(validatePriorEntry({ ...validColorPrior(), colorSpace: 'srgb-display' })), ['prior.color-space@/colorSpace']);
  assert.equal(validatePriorEntry({ ...validColorPrior(), unit: 'rgb-display', colorSpace: 'srgb-display' }).ok, true);
  assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), colorSpace: 'srgb-display' })), ['prior.color-space@/colorSpace']);
  assert.deepEqual(codes(validatePriorEntry({ ...validColorPrior(), value: 0.5 })), ['prior.bad-value@/value']);
  assert.deepEqual(codes(validatePriorEntry({ ...validColorPrior(), value: [1, 1, 1, 1, 1] })), ['prior.bad-value@/value']);
  assert.equal(validatePriorEntry({ ...validColorPrior(), value: [1, 1, 1, 0.5] }).ok, true);
  assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), unit: '' })), ['prior.missing-unit@/unit']);

  assert.equal(validatePriorEntry({ ...validAudioPrior(), value: [-16, -13] }).ok, true);
  assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), value: [-13, -16] })), ['prior.bad-value@/value']);
  assert.equal(validatePriorEntry({ ...validAudioPrior(), value: { attack: 0.1, release: 0.4 } }).ok, true);
  for (const value of ['-14', [], {}, [1, 'x'], null, true]) {
    assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), value })), ['prior.bad-value@/value']);
  }
});

test('C9-5 适用条件、出处、读回证据与未知字段', () => {
  const noCond = validAudioPrior();
  delete noCond.conditions;
  assert.deepEqual(codes(validatePriorEntry(noCond)), ['prior.missing-conditions@/conditions']);
  for (const appliesWhen of [[], [''], ['  '], 'x', [1]]) {
    assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), conditions: { appliesWhen } })),
      ['prior.missing-conditions@/conditions/appliesWhen']);
  }
  assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), conditions: { appliesWhen: ['a'], when: 'b' } })),
    ['prior.unknown-key@/conditions']);
  assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), defaultValue: 1 })), ['prior.unknown-key@/']);
  assert.equal(validatePriorEntry({ ...validAudioPrior(), ext: { 'cards.note': 1 } }).ok, true);
  assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), ext: { note: 1 } })), ['prior.unknown-key@/ext']);

  const p = validAudioPrior();
  p.provenance.evidenceLevel = '未读回';
  assert.deepEqual(codes(validatePriorEntry(p)), ['prior.bad-value@/provenance/evidenceLevel']);
  assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), id: 'Audio.X' })), ['prior.bad-value@/id']);
  assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), id: 'audio' })), ['prior.bad-value@/id']);
  assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), topic: 'Loudness' })), ['prior.bad-value@/topic']);
  assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), domain: 'audio' })), ['prior.bad-value@/domain']);
  assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), title: ' ' })), ['prior.bad-value@/title']);
  assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), provenance: { caseId: '', evidenceLevel: '实测' } })),
    ['prior.bad-value@/provenance/caseId']);
  assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), verifiedInOurStack: 'true' })), ['prior.bad-value@/verifiedInOurStack']);

  const noSha = validAudioPrior();
  delete noSha.readbackEvidence.reportSha256;
  assert.deepEqual(codes(validatePriorEntry(noSha)), ['prior.readback@/readbackEvidence/reportSha256']);
  const upper = validAudioPrior();
  upper.readbackEvidence.reportSha256 = `SHA256:${HEX}`;
  const upperRes = validatePriorEntry(upper);
  assert.deepEqual(codes(upperRes), ['prior.readback@/readbackEvidence/reportSha256']);
  assert.deepEqual(upperRes.leaks, [{ code: 'bare-sha256', path: '/readbackEvidence/reportSha256' }]);
  const noEnv = validAudioPrior();
  noEnv.readbackEvidence.envKey = 'ffmpeg';
  assert.deepEqual(codes(validatePriorEntry(noEnv)), ['prior.readback@/readbackEvidence/envKey']);
  // 未读回的条目不得伪带读回证据
  assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), verifiedInOurStack: false })), ['prior.readback@/readbackEvidence']);

  assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), summaryOf: ['audio.master.target-loudness'] })),
    ['prior.self-summary@/summaryOf']);
  assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), summaryOf: [] })), ['prior.bad-value@/summaryOf']);
  const badConflict = validAudioPrior();
  badConflict.conflicts[0].reason = '';
  assert.deepEqual(codes(validatePriorEntry(badConflict)), ['prior.bad-value@/conflicts/0/reason']);
});

test('C9-6 泄露扫描：只回类型码与位置，规范小写 sha256 放行，变体照拦', () => {
  const leakCodesOf = (note) => {
    const e = validColorPrior();
    e.provenance.note = note;
    const res = validatePriorEntry(e);
    assert.equal(res.ok, res.leaks.length === 0);
    assert.equal(JSON.stringify(res).includes(note), false);
    return res.leaks.map((l) => `${l.code}@${l.path}`);
  };
  const at = (code) => [`${code}@/provenance/note`];
  assert.deepEqual(leakCodesOf('见 lab' + '://case/3'), at('lab-url'));
  assert.deepEqual(leakCodesOf('cards' + '-overlay 里的值'), at('private-source-path'));
  assert.deepEqual(leakCodesOf('exams' + '-hidden/q1'), at('private-source-path'));
  assert.deepEqual(leakCodesOf('复刻' + '\\外01'), at('private-source-path'));
  assert.deepEqual(leakCodesOf('/Us' + 'ers/someone/a.blend'), at('local-path'));
  assert.deepEqual(leakCodesOf('/ho' + 'me/someone/a.blend'), at('local-path'));
  assert.deepEqual(leakCodesOf('C' + ':\\work\\a.blend'), at('local-path'));
  assert.deepEqual(leakCodesOf(`报告 ${HEX}`), at('bare-sha256'));
  assert.deepEqual(leakCodesOf(`报告 sha256:${HEX}`), []);
  assert.deepEqual(leakCodesOf(`SHA256:${HEX.toUpperCase()}`), at('bare-sha256'));
  assert.deepEqual(leakCodesOf(`sha256：${HEX}`), at('bare-sha256')); // 全角冒号
  assert.deepEqual(leakCodesOf(`sha256:${HEX.slice(0, 10)}\u200b${HEX.slice(10)}`), at('bare-sha256'));
  assert.deepEqual(leakCodesOf(`ｓｈａ２５６:${HEX}`), at('bare-sha256')); // 全角字母
  assert.deepEqual(leakCodesOf('ｌａｂ:/' + '/x'), at('lab-url'));
  assert.deepEqual(leakCodesOf('比例 16:9，见 [12]'), []);

  // 键名里的泄露：位置里不带键名
  const keyLeak = validColorPrior();
  keyLeak.ext = { ['cards' + '-overlay.secret']: 1 };
  const keyRes = validatePriorEntry(keyLeak);
  assert.deepEqual(keyRes.leaks, [{ code: 'private-source-path', path: '/ext', field: 'key' }]);
  assert.equal(JSON.stringify(keyRes).includes('secret'), false);
});

test('C9-7 文本扫描：CR、LF、CRLF 行号，重复键里被覆盖的内容与转义写法都查得到', () => {
  const leak = 'lab' + '://x';
  assert.deepEqual(scanPriorLeaks(`a\n${leak}\nb`), [{ code: 'lab-url', line: 2 }]);
  assert.deepEqual(scanPriorLeaks(`a\r${leak}`), [{ code: 'lab-url', line: 2 }]);
  assert.deepEqual(scanPriorLeaks(`a\r\n\r\n${leak}`), [{ code: 'lab-url', line: 3 }]);
  assert.deepEqual(scanPriorLeaks('{"n":"lab:\\/\\/x"}'), [{ code: 'lab-url', line: 1 }]);
  assert.deepEqual(scanPriorLeaks('{"n":"\\u590d\\u523b/x"}'), [{ code: 'private-source-path', line: 1 }]);

  const dup = `{"format":"priors/0.1",\n"entries":[],\n"entries":[{"note":"${leak}"}],\n"entries":[]}`;
  const res = validatePriorsTable(dup);
  assert.equal(res.ok, false);
  assert.deepEqual(res.leaks, [{ code: 'lab-url', line: 3 }]);
  assert.equal(JSON.stringify(res).includes(leak), false);

  assert.deepEqual(validatePriorsTable('{"format":').errors, [{ code: 'prior.bad-json', path: '/' }]);
  const text = JSON.stringify({ format: 'priors/0.1', entries: [validAudioPrior(), validColorPrior()] }, null, 2);
  assert.equal(validatePriorsTable(text).ok, true);
  assert.equal(createPriorsStore(text).stats().totalEntries, 2);
  // 文本里的超安全整数解析后仍被拒
  assert.deepEqual(codes(validatePriorsTable(text.replace('-14', '9007199254740993'))), ['prior.non-json@/entries/0/value']);
});

test('C9-8 非纯 JSON：访问器零调用、超安全整数、非有限数、孤立代理码元、环与类实例', () => {
  let calls = 0;
  const withGetter = validAudioPrior();
  Object.defineProperty(withGetter, 'title', { enumerable: true, get() { calls++; return '标题'; } });
  assert.deepEqual(codes(validatePriorEntry(withGetter)), ['prior.non-json@/']);
  assert.deepEqual(scanPriorLeaks(withGetter), []);
  assert.throws(() => createPriorsStore([withGetter]), TypeError);
  assert.equal(calls, 0);

  const nonJson = (patch, path) => assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), ...patch })), [`prior.non-json@${path}`]);
  nonJson({ value: 2 ** 53 }, '/value');
  nonJson({ value: -(2 ** 53) }, '/value');
  nonJson({ value: NaN }, '/value');
  nonJson({ value: Infinity }, '/value');
  nonJson({ value: 10n }, '/value');
  nonJson({ value: undefined }, '/value');
  nonJson({ title: '标题\ud800' }, '/title');
  nonJson({ ext: { 'cards.\udc00x': 1 } }, '/ext');
  nonJson({ value: [1, , 3] }, '/value'); // eslint-disable-line no-sparse-arrays
  nonJson({ value: new Map() }, '/value');
  class Liar extends Array { every() { return true; } }
  nonJson({ value: Liar.from(['x']) }, '/value');
  assert.equal(validatePriorEntry(Object.assign(Object.create(null), validAudioPrior())).ok, true);
  nonJson({ title: new String('标题') }, '/title');
  nonJson({ [Symbol('s')]: 1 }, '/');
  assert.equal(validatePriorEntry({ ...validAudioPrior(), value: 2 ** 53 - 1 }).ok, true);
  assert.equal(validatePriorEntry({ ...validAudioPrior(), value: 0.1 }).ok, true);

  let traps = 0;
  const trap = () => { traps++; throw new Error('secret-from-trap'); };
  const proxy = new Proxy(validAudioPrior(), { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
  assert.deepEqual(codes(validatePriorEntry(proxy)), ['prior.non-json@/']);
  assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), ext: proxy })), ['prior.non-json@/ext']);
  assert.throws(() => createPriorsStore([proxy]), (error) => !error.message.includes('secret'));
  assert.equal(traps, 0);
  let deep = 1;
  for (let i = 0; i < 200000; i++) deep = [deep];
  assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), value: deep })), ['prior.non-json@/']);

  const loop = validAudioPrior();
  loop.ext = { 'cards.self': loop };
  assert.deepEqual(codes(validatePriorEntry(loop)), ['prior.non-json@/ext/[key]']);
  for (const input of [null, undefined, 1, 'x', []]) assert.equal(validatePriorEntry(input).ok, false);
  for (const input of [null, undefined, 1, [], {}, { format: 'priors/0.2', entries: [] }, { format: 'priors/0.1', entries: {} }]) {
    assert.equal(validatePriorsTable(input).ok, false);
  }
  assert.deepEqual(codes(validatePriorsTable({ format: 'priors/0.1', entries: [], extra: 1 })), ['prior.unknown-key@/']);
});

test('C9-9 整表：id 唯一、同子题同案例防重、汇总行悬挂与多层汇总被拒，异常不回显内容', () => {
  const table = (...entries) => ({ format: 'priors/0.1', entries });
  const summary = (patch = {}) => ({
    id: 'audio.master.loudness-summary',
    domain: 'audio-music-voice-subs',
    topic: 'audio.master.loudness',
    title: '响度跨案例区间汇总',
    value: [-16, -13],
    unit: 'LUFS',
    conditions: { appliesWhen: ['流媒体成片'] },
    provenance: { caseId: 'summary:audio-loudness', evidenceLevel: '实测' },
    verifiedInOurStack: false,
    summaryOf: ['audio.master.target-loudness'],
    ...patch,
  });

  assert.deepEqual(codes(validatePriorsTable(table(validAudioPrior(), validAudioPrior()))),
    ['prior.duplicate-id@/entries/1/id', 'prior.duplicate-case@/entries/1']);
  // 换 id 不换适用条件仍算重复；适用条件不同才是另一条
  const second = { ...validAudioPrior(), id: 'audio.master.target-loudness-b' };
  assert.deepEqual(codes(validatePriorsTable(table(validAudioPrior(), second))), ['prior.duplicate-case@/entries/1']);
  second.conditions = { appliesWhen: ['院线 5.1 母带'] };
  assert.equal(validatePriorsTable(table(validAudioPrior(), second)).ok, true);
  // 适用条件只是换了次序，仍是同一条
  const a = { ...validColorPrior(), conditions: { appliesWhen: ['甲', '乙'] } };
  const b = { ...validColorPrior(), id: 'fx.palette.warm-ember-b', conditions: { appliesWhen: ['乙', '甲'] } };
  assert.deepEqual(codes(validatePriorsTable(table(a, b))), ['prior.duplicate-case@/entries/1']);

  assert.deepEqual(codes(validatePriorsTable(table(summary()))), ['prior.dangling-summary@/entries/0/summaryOf/0']);
  const nested = summary({ id: 'audio.master.loudness-summary2', summaryOf: ['audio.master.loudness-summary'] });
  assert.deepEqual(codes(validatePriorsTable(table(validAudioPrior(), summary(), nested))),
    ['prior.nested-summary@/entries/2/summaryOf/0']);
  assert.deepEqual(codes(validatePriorsTable(table(validColorPrior(), { ...validAudioPrior(), unit: 'cm' }))),
    ['prior.unknown-unit@/entries/1/unit']);

  const leaky = validColorPrior();
  leaky.title = '取自 lab' + '://private-case';
  assert.throws(() => createPriorsStore(table(leaky)), (error) => {
    assert.ok(error instanceof TypeError);
    assert.match(error.message, /lab-url@\/entries\/0\/title/);
    assert.equal(error.message.includes('private-case'), false);
    return true;
  });
  assert.throws(() => createPriorsStore([{ ...validAudioPrior(), unit: 'secret-unit' }]), (error) => {
    assert.match(error.message, /prior\.unknown-unit@\/entries\/0\/unit/);
    assert.equal(error.message.includes('secret-unit'), false);
    return true;
  });
});

test('C9-10 检索库：过滤、读回标记、limit、深拷贝与统计不重复计数', () => {
  const summaryRow = {
    id: 'audio.master.loudness-summary',
    domain: 'audio-music-voice-subs',
    topic: 'audio.master.loudness',
    title: '响度跨案例区间汇总',
    value: [-16, -13],
    unit: 'LUFS',
    conditions: { appliesWhen: ['流媒体成片'] },
    provenance: { caseId: 'summary:audio-loudness', evidenceLevel: '实测' },
    verifiedInOurStack: false,
    summaryOf: ['audio.master.target-loudness'],
  };
  const source = [validAudioPrior(), validColorPrior(), summaryRow];
  const store = createPriorsStore(source);
  source[0].value = 0; // 建库后改入参不影响库

  assert.deepEqual(store.stats(), {
    totalEntries: 3, detailCount: 2, summaryCount: 1, verifiedCount: 1, unverifiedCount: 1, conflictCount: 1,
  });
  const ids = (filter) => store.query(filter).map((e) => e.id);
  assert.deepEqual(ids(), ['audio.master.target-loudness', 'fx.palette.warm-ember']);
  assert.deepEqual(ids({ includeSummaries: true }).length, 3);
  assert.deepEqual(ids({ onlyVerified: true }), ['audio.master.target-loudness']);
  assert.deepEqual(ids({ onlyVerified: true, includeSummaries: true }), ['audio.master.target-loudness']);
  assert.deepEqual(ids({ domain: 'fx-particles-ui-2d' }), ['fx.palette.warm-ember']);
  assert.deepEqual(ids({ topic: 'audio.master.loudness' }), ['audio.master.target-loudness']);
  assert.deepEqual(ids({ unit: 'LUFS', includeSummaries: true }), ['audio.master.target-loudness', 'audio.master.loudness-summary']);
  assert.deepEqual(ids({ caseId: '外01' }), ['fx.palette.warm-ember']);
  assert.deepEqual(ids({ unit: 'm' }), []);
  assert.deepEqual(ids({ limit: 1 }), ['audio.master.target-loudness']);
  for (const filter of [{ limit: 0 }, { limit: 1.5 }, { onlyverified: true }, { onlyVerified: 'yes' }]) {
    assert.throws(() => store.query(filter), TypeError);
  }

  assert.equal(store.get('audio.master.target-loudness').readbackLabel, '已在我方读回');
  assert.equal(store.get('audio.master.target-loudness').value, -14);
  assert.equal(store.get('fx.palette.warm-ember').readbackLabel, '未在我方读回');
  assert.equal(store.get('no.such'), undefined);
  const got = store.query({ unit: 'rgb-linear' })[0];
  assert.equal(Object.isFrozen(store), true);
  assert.equal(Object.isFrozen(store.query()), true);
  assert.equal(Object.isFrozen(got), true);
  assert.equal(Object.isFrozen(got.value), true);
  assert.equal(Object.isFrozen(got.conditions), true);
  assert.equal(Object.isFrozen(got.conditions.appliesWhen), true);
  assert.equal(Object.isFrozen(store.stats()), true);
  assert.throws(() => { got.value[0] = 99; }, TypeError);
  assert.throws(() => { got.conditions.appliesWhen.push('x'); }, TypeError);
  assert.deepEqual(store.get('fx.palette.warm-ember').value, [2.4, 0.65, 0.12]);
  assert.deepEqual(store.get('fx.palette.warm-ember').conditions.appliesWhen, ['HDR 场景参考粒子发光核']);
});

test('C9-11 从 index.mjs 导出', async () => {
  const index = await import('./index.mjs');
  for (const name of ['validatePriorEntry', 'validatePriorsTable', 'createPriorsStore', 'scanPriorLeaks']) {
    assert.equal(typeof index[name], 'function');
  }
  assert.equal(index.PRIOR_UNITS, PRIOR_UNITS);
  assert.equal(index.PRIOR_EVIDENCE_LEVELS, PRIOR_EVIDENCE_LEVELS);
  assert.ok(Object.isFrozen(PRIOR_UNITS) && Object.isFrozen(PRIOR_EVIDENCE_LEVELS) && Object.isFrozen(PRIOR_DOMAINS));
});

test('C9-12 G_REV-R1 收口：全覆盖私有/本机路径且不误伤公开 URL、严格字符串类型、数组空洞附加键与保留键拒收、JSON 重复键拦截、只读色彩策略与深冻结及 M12/M13', async () => {
  const { PRIOR_COLOR_SPACES } = await import('./priors.mjs');

  // 1) 私有目录（调研资料/、北冥引擎规划/、实验室/）与本机路径（~/、独立 ~、/tmp/、file:///）在六种位置全拦，且公开 HTTPS /home/ 不误报
  const synthLeaks = [
    ['调研' + '资料/包/a.md', 'private-source-path'],
    ['北冥' + '引擎规划/05.md', 'private-source-path'],
    ['实' + '验室/truth/x', 'private-source-path'],
    ['~' + '/Desktop/x', 'local-path'],
    ['~', 'local-path'],
    ['/' + 'tmp/run/out.json', 'local-path'],
    ['file:' + '///var/tmp/a', 'local-path'],
  ];
  for (const [sample, expectedCode] of synthLeaks) {
    // 位置 1: provenance.note
    const e1 = validColorPrior();
    e1.provenance.note = sample;
    assert.ok(validatePriorEntry(e1).leaks.some((l) => l.code === expectedCode), `provenance.note 漏检 ${sample}`);

    // 位置 2: 嵌套键名
    const e2 = validColorPrior();
    e2.ext = { [`cards.${sample}`]: 1 };
    assert.ok(validatePriorEntry(e2).leaks.some((l) => l.code === expectedCode && l.field === 'key'), `嵌套键漏检 ${sample}`);

    // 位置 3: 数组值
    const e3 = validColorPrior();
    e3.conditions = { appliesWhen: [sample] };
    assert.ok(validatePriorEntry(e3).leaks.some((l) => l.code === expectedCode), `数组值漏检 ${sample}`);

    // 位置 4: 冲突原因
    const e4 = validAudioPrior();
    e4.conflicts[0].reason = sample;
    assert.ok(validatePriorEntry(e4).leaks.some((l) => l.code === expectedCode), `冲突原因漏检 ${sample}`);

    // 位置 5: summaryOf（即便同时有 ID 格式错误，leaks 也必须命中！）
    const e5 = { ...validColorPrior(), summaryOf: [sample] };
    assert.ok(validatePriorEntry(e5).leaks.some((l) => l.code === expectedCode), `summaryOf 漏检 ${sample}`);

    // 位置 6: 原始 JSON 文本扫描
    const txt = JSON.stringify({ format: 'priors/0.1', entries: [e1] });
    assert.ok(scanPriorLeaks(txt).some((l) => l.code === expectedCode), `文本扫描漏检 ${sample}`);
  }
  const publicUrl = validColorPrior();
  publicUrl.provenance.docRef = 'https://docs.example.com/home/guide/Users/overview';
  assert.deepEqual(validatePriorEntry(publicUrl).leaks, []);
  assert.equal(validatePriorEntry(publicUrl).ok, true);

  // 2) 严格字符串类型检查（杜绝数组或对象经正则隐式转字符串或抛原生 TypeError）
  const arrEnv = validAudioPrior();
  arrEnv.readbackEvidence.envKey = ['ffmpeg/8.0.1/mac-arm64'];
  assert.deepEqual(codes(validatePriorEntry(arrEnv)), ['prior.readback@/readbackEvidence/envKey']);
  const arrSha = validAudioPrior();
  arrSha.readbackEvidence.reportSha256 = [`sha256:${HEX}`];
  assert.deepEqual(codes(validatePriorEntry(arrSha)), ['prior.readback@/readbackEvidence/reportSha256']);
  assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), id: ['audio.master.target-loudness'] })), ['prior.bad-value@/id']);
  assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), id: { bad: 1 } })), ['prior.bad-value@/id']);
  assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), topic: ['audio.master.loudness'] })), ['prior.bad-value@/topic']);
  assert.deepEqual(codes(validatePriorEntry({ ...validAudioPrior(), summaryOf: [['audio.master.target-loudness']] })), ['prior.bad-value@/summaryOf']);
  assert.equal(validatePriorsTable(JSON.stringify({ format: 'priors/0.1', entries: [{ ...validAudioPrior(), id: { bad: 1 } }] })).ok, false);

  // 3) 数组空洞+附加属性抵消被拒、诊断绝不回显自定义键名、保留键 __proto__/constructor/prototype 拒收、已撤销 Proxy 统一诊断
  const trickyArr = new Array(2);
  trickyArr[0] = 'HDR 场景参考粒子发光核';
  trickyArr.secretArrayProp = 'x';
  const withHoleAndProp = { ...validColorPrior(), conditions: { appliesWhen: trickyArr } };
  const holeRes = validatePriorEntry(withHoleAndProp);
  assert.equal(holeRes.ok, false);
  assert.equal(JSON.stringify(holeRes).includes('secretArrayProp'), false);

  const customKeyErr = { ...validAudioPrior(), value: { secretUserKey: NaN } };
  const customKeyRes = validatePriorEntry(customKeyErr);
  assert.equal(customKeyRes.ok, false);
  assert.equal(JSON.stringify(customKeyRes).includes('secretUserKey'), false);

  const withProtoObj = JSON.parse('{"format":"priors/0.1","entries":[]}');
  const entryWithOwnProto = { ...validColorPrior(), ext: Object.defineProperty({}, '__proto__', { value: { a: 1 }, enumerable: true, configurable: true, writable: true }) };
  assert.equal(validatePriorEntry(entryWithOwnProto).ok, false);
  assert.equal(validatePriorsTable('{"format":"priors/0.1","entries":[],"__proto__":{"polluted":1}}').ok, false);
  assert.equal(validatePriorsTable(withProtoObj).ok, true);

  const { proxy: revoked, revoke } = Proxy.revocable([validAudioPrior()], {});
  revoke();
  assert.deepEqual(codes(validatePriorEntry(revoked)), ['prior.non-json@/']);
  assert.deepEqual(codes(validatePriorsTable(revoked)), ['prior.non-json@/']);
  assert.throws(() => createPriorsStore(revoked), /先验表未过校验：prior\.non-json@\//);

  // 4) JSON 文本重复键（含 Unicode 转义同名键）本身即报错，禁止后键静默覆盖前键
  const badFirst = JSON.stringify({ ...validAudioPrior(), unit: 'bad-unit' });
  const dupPlain = `{"format":"priors/0.1","entries":[${badFirst}],"entries":[]}`;
  const dupEscaped = `{"format":"priors/0.1","\\u0065ntries":[${badFirst}],"entries":[]}`;
  assert.ok(codes(validatePriorsTable(dupPlain)).includes('prior.duplicate-key@/'));
  assert.ok(codes(validatePriorsTable(dupEscaped)).includes('prior.duplicate-key@/'));

  // 5) PRIOR_COLOR_SPACES 不可篡改，以及 M12（rgb-display 错配线性空间）与 M13（summaryOf 重复引用同一明细）
  assert.equal(Object.isFrozen(PRIOR_COLOR_SPACES.get('rgb-linear')), true);
  assert.equal(Object.isFrozen(PRIOR_COLOR_SPACES.get('rgb-display')), true);
  assert.throws(() => PRIOR_COLOR_SPACES.set('rgb-linear', ['srgb-display']), TypeError);
  assert.throws(() => PRIOR_COLOR_SPACES.delete('rgb-linear'), TypeError);
  assert.throws(() => PRIOR_COLOR_SPACES.clear(), TypeError);

  // M12: rgb-display 配 scene-linear-rec709 必须报错
  assert.deepEqual(
    codes(validatePriorEntry({ ...validColorPrior(), unit: 'rgb-display', colorSpace: 'scene-linear-rec709' })),
    ['prior.color-space@/colorSpace'],
  );
  // M13: summaryOf 内重复引用同一有效明细必须报错
  const dupSummary = {
    id: 'audio.master.dup-summary',
    domain: 'audio-music-voice-subs',
    topic: 'audio.master.loudness',
    title: '重复引用汇总',
    value: [-16, -13],
    unit: 'LUFS',
    conditions: { appliesWhen: ['流媒体成片'] },
    provenance: { caseId: 'summary:dup', evidenceLevel: '实测' },
    verifiedInOurStack: false,
    summaryOf: ['audio.master.target-loudness', 'audio.master.target-loudness'],
  };
  assert.deepEqual(codes(validatePriorEntry(dupSummary)), ['prior.bad-value@/summaryOf']);
  assert.equal(validatePriorsTable({ format: 'priors/0.1', entries: [validAudioPrior(), dupSummary] }).ok, false);
});
