import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  checkVersionBump, createCardRegistry, estimateTokens, getCardStatus, hashCardContents,
  makeStatusKey, mergeOverlay, scanCardLeaks, statusLevels, validateCard, verifyCardLock,
  verifyStatusUpdateAuthor,
} from './index.mjs';
import fullCard from '../kernel/contracts/card-file/examples/full.json' with { type: 'json' };
import minimalCard from '../kernel/contracts/card-file/examples/minimal.json' with { type: 'json' };
import typedCard from '../kernel/contracts/card-file/examples/typed-params.json' with { type: 'json' };
import counterexamples from '../kernel/contracts/card-file/counterexamples/index.json' with { type: 'json' };

const labUrl = 'lab://synthetic-test/0';
const syntheticHash = 'a'.repeat(64);
const parityReport = `sha256:${syntheticHash}`;
const statusDate = '2024-02-29';
const environment = { host: 'page', source: '0.187.0', gpu: 'none' };
const environmentKey = makeStatusKey(environment);
const levelNames = Object.keys(statusLevels);
const status = (level, overrides = {}) => ({ ...environment, level: levelNames[level], date: statusDate, ...overrides });
const baseCard = {
  format: 'card/0.1',
  version: '1.0.0',
  title: '合成技术卡',
  livesIn: ['data'],
  impl: [{ livesIn: 'data', entry: 'kernel/eval/synthetic.mjs', shape: 'evaluate', hosts: [], selftest: 'kernel/eval/synthetic.test.mjs' }],
  params: {},
  ports: { in: [], out: [{ name: 'value', type: 'tracks.synthetic' }], order: { before: [], after: [] }, requires: [] },
  conditions: { appliesWhen: [], notWhen: [] },
  calibration: 'synthetic',
  verify: { selftest: '检查合成固定值', predicates: [] },
  provenance: { cases: [], note: '合成夹具' },
};

function fixture(name, level, scores, msPerFrame, overrides = {}) {
  return {
    ...baseCard,
    id: `synthetic.${name}`,
    intent: '用于合成夹具检索',
    kind: 'camera',
    status: [status(level)],
    exams: ['1-1', '1-2'],
    ext: { 'registry.examScores': { '1-1': scores[0], '1-2': scores[1], '2-1': 10000 } },
    cost: [{ host: 'page', msPerFrame }],
    ...overrides,
  };
}

const sourceLanding = {
  livesIn: ['source:three'],
  impl: [{ livesIn: 'source:three', entry: 'sources/three/synthetic.mjs', shape: 'create', hosts: [{ host: 'page', version: '0.187.0' }], selftest: 'sources/three/synthetic.test.mjs' }],
};
const cards = [
  fixture('rank-level', 3, [1, 1], 100),
  fixture('rank-score', 2, [100, 80], 100),
  fixture('rank-uses', 2, [95, 75], 90),
  fixture('rank-cost', 2, [85, 85], 5),
  fixture('rank-tie-z', 2, [85, 85], 10),
  fixture('rank-tie-a', 2, [85, 85], 10),
  fixture('rank-lower-score', 2, [100, 60], 1),
  fixture('rank-missing-score', 2, [], 1, { ext: {} }),
  fixture('reproduced', 1, [100, 100], 1, { intent: '窗口检查' }),
  fixture('read', 0, [100, 100], 1, { intent: '窗口检查' }),
  fixture('mechanism', 3, [100, 100], 1, { kind: 'mechanism', intent: '可见性检查' }),
  fixture('visible-mechanism', 3, [100, 100], 1, { kind: 'mechanism', visibleToAgent: true, intent: '可见性检查' }),
  fixture('hidden', 3, [100, 100], 1, { visibleToAgent: false, intent: '可见性检查' }),
  fixture('candidate', 3, [100, 100], 1, { ext: { 'registry.candidate': true }, intent: '可见性检查' }),
  fixture('three', 2, [1, 1], 1, { ...sourceLanding, kind: 'two-d', intent: '镜头叠加' }),
  fixture('long-summary', 2, [1, 1], 1, { title: '🚀标题\n"'.repeat(100), intent: '合成预算\t🧪\\'.repeat(100) }),
  fixture('recent', 2, [1, 1], 1, { intent: '最近使用' }),
  fixture('versions', 2, [1, 1], 1, { version: '1.2.99' }),
  fixture('versions', 2, [1, 1], 1, { version: '1.10.0' }),
  fixture('versions', 2, [1, 1], 1, { version: '1.11.0', ext: { 'registry.deprecated': true } }),
];
const usageRecords = [
  ...Array.from({ length: 12 }, (_, index) => ({ filmId: `film-${index + 1}` })),
  ...[1, 2, 3, 3].map((number) => ({ filmId: `film-${number}`, cardId: 'synthetic.rank-uses' })),
  ...['rank-cost', 'rank-tie-z', 'rank-tie-a'].map((name) => ({ filmId: 'film-3', cardId: `synthetic.${name}` })),
  ...[1, 2, 3, 3, 12].map((number) => ({ filmId: `film-${number}`, cardId: 'synthetic.recent' })),
  { filmId: 'film-12', cardId: 'synthetic.recent', version: '9.0.0' },
];
const registry = createCardRegistry(cards, { usageRecords });
const ids = (rows) => rows.map(({ id }) => id);

test('卡文件契约全部三个正例通过', () => {
  for (const card of [fullCard, minimalCard, typedCard]) assert.equal(validateCard(card).ok, true);
});

for (const { file, violates } of counterexamples) {
  test(`卡文件反例 ${file} 命中指定不变量`, () => {
    const card = JSON.parse(readFileSync(new URL(`../kernel/contracts/card-file/counterexamples/${file}`, import.meta.url), 'utf8'));
    const result = validateCard(card);
    assert.equal(result.ok, false);
    assert.deepEqual(result.schemaErrors, []);
    assert.deepEqual(result.leaks, []);
    assert.deepEqual(Object.keys(result.violations), violates);
  });
}

test('拒绝版本结构错误和其他契约格式', () => {
  const invalid = validateCard({ ...fullCard, version: '1.0' });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.schemaErrors.some((error) => error.startsWith('/version ')));
  assert.equal(validateCard({ format: 'card-check/0.1' }).ok, false);
});

test('嵌套合成地址由公开门禁先拦截且不回显', () => {
  const card = { ...fullCard, ext: { 'test.metadata': { items: [labUrl] } } };
  const result = validateCard(card);
  assert.deepEqual(result, { ok: false, schemaErrors: [], violations: {}, leaks: [{ code: 'lab-url', path: '/ext/test.metadata/items/0' }] });
  assert.equal(JSON.stringify(result).includes(labUrl), false);
});

test('扫描 JSON 转义后的字段及裸文本', () => {
  const json = JSON.stringify({ intent: labUrl }).replace(':/' + '/', ':\\/\\/');
  assert.deepEqual(scanCardLeaks(json), [{ code: 'lab-url', path: '/intent' }]);
  assert.deepEqual(scanCardLeaks(`合成地址 ${labUrl}`), [{ code: 'lab-url', path: '/' }]);
});

test('拦截原包路径特征和合成的三类本机绝对路径', () => {
  for (const text of ['原包源码', 'cards-overlay']) {
    assert.deepEqual(scanCardLeaks({ title: text }), [{ code: 'private-source-path', path: '/title' }]);
  }
  const paths = ['/' + 'Users/synthetic', '/' + 'home/synthetic', 'C:' + '\\synthetic'];
  for (const path of paths) assert.deepEqual(scanCardLeaks({ title: path }), [{ code: 'local-path', path: '/title' }]);
});

test('裸 SHA-256 被拦，只有合法状态报告字段豁免', () => {
  assert.deepEqual(scanCardLeaks({ title: `来源 ${syntheticHash.toUpperCase()}` }), [{ code: 'bare-sha256', path: '/title' }]);
  assert.deepEqual(scanCardLeaks({ status: [{ parityReport }] }), []);
  assert.deepEqual(scanCardLeaks({ status: [{ parityReport: syntheticHash }] }), [{ code: 'bare-sha256', path: '/status/0/parityReport' }]);
  assert.deepEqual(scanCardLeaks({ title: parityReport }), [{ code: 'bare-sha256', path: '/title' }]);
});

test('门禁会拦截并遮盖含私有标记的键', () => {
  const leaks = scanCardLeaks({ ext: { [labUrl]: syntheticHash } });
  assert.deepEqual(leaks, [
    { code: 'lab-url', path: '/ext', field: 'key' },
    { code: 'bare-sha256', path: '/ext/[redacted]' },
  ]);
});

test('未提供覆盖层目录或覆盖层文件缺失时跳过', (t) => {
  const read = t.mock.method(fs, 'readFileSync', () => { throw Object.assign(new Error('缺少合成覆盖层'), { code: 'ENOENT' }); });
  const expected = { card: fullCard, hasTruth: false, skipParity: true };
  assert.deepEqual(mergeOverlay(fullCard), expected);
  assert.equal(read.mock.callCount(), 0);
  assert.deepEqual(mergeOverlay(fullCard, 'synthetic-overlay'), expected);
  assert.equal(read.mock.callCount(), 1);
});

test('覆盖层合并真值并保留公共字段和输入数据', (t) => {
  const read = t.mock.method(fs, 'readFileSync', () => JSON.stringify({
    id: 'synthetic.ignored',
    provenance: { lab: labUrl, note: '忽略覆盖' },
    verify: { parity: { truth: labUrl, gates: ['忽略覆盖'] } },
    priors: [{ source: 'synthetic.txt' }],
  }));
  const { card, hasTruth, skipParity } = mergeOverlay(fullCard, 'synthetic-overlay');
  assert.match(read.mock.calls[0].arguments[0], /camera\.fit\.json$/);
  assert.equal(hasTruth, true);
  assert.equal(skipParity, false);
  assert.equal(card.id, fullCard.id);
  assert.equal(card.provenance.lab, labUrl);
  assert.equal(card.provenance.note, fullCard.provenance.note);
  assert.equal(card.priors[0].source, 'synthetic.txt');
  assert.deepEqual(card.verify.parity, { ...fullCard.verify.parity, truth: labUrl });
  assert.equal(Object.hasOwn(fullCard.verify.parity, 'truth'), false);
  assert.equal(validateCard(card).ok, false);
});

test('无真值的覆盖层仍跳过对拍', (t) => {
  t.mock.method(fs, 'readFileSync', () => JSON.stringify({ provenance: { studied: 'synthetic.txt' } }));
  const result = mergeOverlay(fullCard, 'synthetic-overlay');
  assert.equal(result.card.provenance.studied, 'synthetic.txt');
  assert.equal(result.hasTruth, false);
  assert.equal(result.skipParity, true);
});

test('覆盖层存在但损坏时报告错误，不回显内容', (t) => {
  t.mock.method(fs, 'readFileSync', () => `{"truth":${labUrl}}`);
  assert.throws(() => mergeOverlay(fullCard, 'synthetic-overlay'), { message: '私有覆盖层必须是有效的 JSON' });
});

test('覆盖层拒绝非法卡名且不尝试读取', (t) => {
  const read = t.mock.method(fs, 'readFileSync');
  assert.throws(() => mergeOverlay({ ...fullCard, id: '../synthetic' }, 'synthetic-overlay'), TypeError);
  assert.equal(read.mock.callCount(), 0);
});

test('20 张合成卡均为合法卡文件', () => {
  assert.equal(cards.length, 20);
  for (const card of cards) assert.equal(validateCard(card).ok, true, card.id);
});

test('精确卡名和主版本引用走数字排序，主版本引用跳过弃用项', () => {
  assert.equal(registry.getCard('synthetic.versions').version, '1.11.0');
  assert.equal(registry.getCard('synthetic.versions@1').version, '1.10.0');
  assert.equal(registry.getCard('synthetic.versions@01').version, '1.10.0');
  assert.equal(registry.getCard('synthetic.versions@2'), null);
  assert.equal(registry.getCard('synthetic.versions@1.10.0'), null);
  assert.equal(registry.getCard('synthetic.missing'), null);
});

test('筛选类别、落点、帧源、关键词和最低等级', () => {
  assert.deepEqual(ids(registry.searchCards({ kind: 'two-d', livesIn: 'source:three', source: 'three', q: '叠加', minLevel: 2 })), ['synthetic.three']);
  assert.deepEqual(registry.searchCards({ kind: 'two-d', source: 'core' }), []);
  assert.deepEqual(registry.searchCards({ kind: 'two-d', livesIn: 'data' }), []);
  assert.deepEqual(registry.searchCards({ kind: 'two-d', minLevel: 3 }), []);
  assert.deepEqual(ids(registry.searchCards({ q: '  SYNTHETIC.THREE  ' })), ['synthetic.three']);
  assert.throws(() => registry.searchCards({ minLevel: NaN }), RangeError);
  const contextual = fixture('contextual', 2, [1, 1], 1, { conditions: { appliesWhen: ['顶点混合'], notWhen: [] } });
  assert.deepEqual(ids(createCardRegistry([contextual]).searchCards({ q: '顶点' })), [contextual.id]);
});

test('默认隐藏机制、显式隐藏和候选，仍可精确取卡', () => {
  assert.deepEqual(ids(registry.searchCards({ q: '可见性检查' })), ['synthetic.visible-mechanism']);
  assert.equal(registry.getCard('synthetic.mechanism').kind, 'mechanism');
  assert.equal(registry.getCard('synthetic.candidate').id, 'synthetic.candidate');
  const legacy = fixture('legacy-hidden', 3, [100, 100], 1, { visible_to_agent: false });
  assert.deepEqual(createCardRegistry([legacy]).searchCards(), []);
});

test('起步放宽窗口含截止日，次日切回量测门槛', () => {
  const allowReproducedUntilDate = '2026-01-10';
  for (const nowDate of ['2026-01-09', '2026-01-10']) {
    const inside = createCardRegistry(cards, { nowDate, allowReproducedUntilDate });
    const hits = inside.searchCards({ q: '窗口检查', minLevel: 0 });
    assert.deepEqual(hits.map(({ id, statusLevel }) => [id, statusLevel]), [['synthetic.reproduced', 1]]);
  }
  const outside = createCardRegistry(cards, { nowDate: '2026-01-11', allowReproducedUntilDate });
  assert.deepEqual(outside.searchCards({ q: '窗口检查', minLevel: 0 }), []);
});

test('显式放宽允许复现卡并保留查询的更高门槛', () => {
  assert.deepEqual(ids(registry.searchCards({ q: '窗口检查', allowReproduced: true })), ['synthetic.reproduced']);
  const relaxed = createCardRegistry(cards, { allowReproduced: true });
  assert.deepEqual(ids(relaxed.searchCards({ q: '窗口检查' })), ['synthetic.reproduced']);
  assert.deepEqual(relaxed.searchCards({ q: '窗口检查', minLevel: 2 }), []);
});

test('四维排序逐级打破交叉指标平手且最多返回 5 张', () => {
  const hits = registry.searchCards({ q: 'rank' });
  assert.deepEqual(ids(hits), ['rank-level', 'rank-score', 'rank-uses', 'rank-cost', 'rank-tie-a'].map((name) => `synthetic.${name}`));
  assert.equal(hits.length, 5);
  assert.deepEqual(ids(registry.searchCards({ q: 'rank-tie' })), ['synthetic.rank-tie-a', 'synthetic.rank-tie-z']);
});

test('关键词参与过滤且不为文本重复次数加权', () => {
  const first = fixture('keyword-a', 2, [90, 90], 1, { intent: '旋转' });
  const second = fixture('keyword-z', 2, [80, 80], 1, { intent: '旋转旋转旋转' });
  assert.deepEqual(ids(createCardRegistry([second, first]).searchCards({ q: '旋转' })), [first.id, second.id]);
});

test('检索指定环境时等级与单帧成本均来自该环境', () => {
  const unrelated = status(3, { gpu: 'synthetic-gpu' });
  const a = fixture('environment-a', 2, [1, 1], 8, { status: [status(2), unrelated], cost: [{ host: 'page', msPerFrame: 8 }, { host: 'other', msPerFrame: 1 }] });
  const b = fixture('environment-b', 2, [1, 1], 4);
  const sample = createCardRegistry([a, b]);
  assert.deepEqual(ids(sample.searchCards()), [a.id, b.id]);
  assert.deepEqual(ids(sample.searchCards({ environmentKey })), [b.id, a.id]);
  assert.deepEqual(sample.searchCards({ environmentKey: 'page/0.187.1/none' }), []);
});

test('摘要限制为 300 token，处理多字节、引号与控制字符', () => {
  const [summary] = registry.searchCards({ q: 'long-summary' });
  assert.deepEqual(Object.keys(summary), ['id', 'version', 'kind', 'title', 'intent', 'lives_in', 'statusLevel', 'recentUsesInLast10Films']);
  const serialized = JSON.stringify(summary);
  assert.equal(estimateTokens(summary), Buffer.byteLength(serialized, 'utf8'));
  assert.equal(estimateTokens(serialized), estimateTokens(summary));
  assert.ok(estimateTokens(summary) <= 300);
  assert.ok(estimateTokens(summary) >= 290);
  assert.ok(summary.title.startsWith('🚀标题'));
  assert.ok(summary.intent.startsWith('合成预算'));
  assert.equal(JSON.parse(serialized).title, summary.title);
  assert.equal(/[\uD800-\uDFFF]/u.test(summary.title + summary.intent), false);
});

test('不可缩短的字段超预算时，从后续候选继续填充', () => {
  const oversized = fixture(`oversized-${'x'.repeat(300)}`, 3, [100, 100], 1);
  assert.ok(validateCard(oversized).ok);
  const hits = createCardRegistry([oversized, ...cards]).searchCards({ q: '合成夹具检索' });
  assert.equal(hits.length, 5);
  assert.ok(hits.every((hit) => hit.id !== oversized.id && estimateTokens(hit) <= 300));
});

test('最近十部按不同成片计数，并排除窗口前影片及其他版本', () => {
  const recentUses = (options) => createCardRegistry(cards, { usageRecords, ...options }).searchCards({ q: '最近使用' })[0].recentUsesInLast10Films;
  assert.equal(recentUses({}), 2);
  assert.equal(recentUses({ recentFilmsWindow: 1 }), 1);
  assert.equal(recentUses({ recentFilmsWindow: 0 }), 0);
});

test('四级状态按宿主、版本和显卡精确查询', () => {
  const entries = levelNames.map((_, level) => status(level, { gpu: `synthetic-gpu-${level}` }));
  const card = { status: entries };
  for (const [level, entry] of entries.entries()) {
    assert.deepEqual(getCardStatus(card, makeStatusKey(entry)), { ...entry, statusLevel: level });
  }
  assert.deepEqual(getCardStatus(card, environmentKey), { level: 'unverified', statusLevel: null });
  assert.equal(getCardStatus(card, 'other/0.187.0/synthetic-gpu-3').level, 'unverified');
  assert.equal(getCardStatus(card, 'page/0.187.1/synthetic-gpu-3').level, 'unverified');
});

test('环境键内含斜杠时保持不同三元组互相独立', () => {
  const a = status(2, { host: 'page/core', source: '1' });
  const b = status(3, { host: 'page', source: 'core/1' });
  assert.notEqual(makeStatusKey(a), makeStatusKey(b));
  assert.equal(getCardStatus({ status: [a, b] }, makeStatusKey(b)).statusLevel, 3);
});

const implPath = 'kernel/eval/synthetic.mjs';
const originalHashes = { [implPath]: syntheticHash };
const changedHashes = { [implPath]: 'b'.repeat(64) };
const versionCard = { ...baseCard, params: { sample: { default: 0 } } };
const versionCheck = (next, hashes = originalHashes) => checkVersionBump(versionCard, originalHashes, { ...versionCard, ...next }, hashes);

test('实现哈希改动、删除或回退版本时判红', () => {
  const want = [{ code: 'implementation-version-bump-required' }];
  assert.deepEqual(versionCheck({}, changedHashes).violations, want);
  assert.deepEqual(versionCheck({}, {}).violations, want);
  assert.deepEqual(versionCheck({ version: '0.10.10' }, changedHashes).violations, want);
  assert.deepEqual(versionCheck({ version: '01.00.00' }, changedHashes).violations, want);
  assert.equal(versionCheck({ version: '1.0' }).ok, false);
  assert.equal(versionCheck({ version: '1.0.1' }, changedHashes).ok, true);
});

test('输出端口或必填参数删除需要升主版本', () => {
  const next = { ports: { ...versionCard.ports, out: [] }, params: {}, version: '1.1.0' };
  assert.deepEqual(versionCheck(next).violations, [
    { code: 'parity-output-major-bump-required' },
    { code: 'parameter-removal-major-bump-required', param: 'sample' },
  ]);
  assert.equal(versionCheck({ ...next, version: '2.0.0' }).ok, true);
});

test('卡的对拍门改动和帧源移入求值核需要升主版本', () => {
  const prev = { ...fullCard, version: '9.9.9', livesIn: ['source:blender'] };
  const next = structuredClone(prev);
  next.version = '9.10.0';
  next.verify.parity.gates = [];
  next.livesIn = ['data'];
  assert.deepEqual(checkVersionBump(prev, originalHashes, next, originalHashes).violations, [
    { code: 'parity-output-major-bump-required' },
    { code: 'data-landing-major-bump-required' },
  ]);
});

test('锁哈希按相对路径 UTF-8 字节序和固定换行计算', () => {
  const hashes = { 'é.json': 'c'.repeat(64), 'z.mjs': 'b'.repeat(64), 'a/card.json': syntheticHash };
  const expected = createHash('sha256').update(`a/card.json\n${syntheticHash}\nz.mjs\n${'b'.repeat(64)}\né.json\n${'c'.repeat(64)}\n`).digest('hex');
  assert.equal(hashCardContents(hashes), expected);
  assert.equal(verifyCardLock(versionCard, hashes, { version: '1.0.0', sha256: expected }).ok, true);
  assert.deepEqual(verifyCardLock(versionCard, hashes, { version: '1.0.1', sha256: syntheticHash }).violations, [
    { code: 'lock-version-mismatch' }, { code: 'lock-hash-mismatch' },
  ]);
  assert.throws(() => hashCardContents({ '../synthetic.mjs': syntheticHash }), TypeError);
});

test('实现者及其他非复核角色自改状态被拦', () => {
  const before = { status: [status(1)] };
  const after = { status: [status(2, { parityReport })] };
  for (const actorRole of ['implementer', 'integrator', undefined]) {
    assert.deepEqual(verifyStatusUpdateAuthor(before, after, { actorRole }).violations, [{ code: 'status-reviewer-required' }]);
  }
  assert.equal(verifyStatusUpdateAuthor(before, structuredClone(before), { actorRole: 'implementer' }).ok, true);
});

test('复核者晋级时每个环境都要合法哈希和日历日期', () => {
  const before = { status: [status(1)] };
  const good = status(2, { parityReport });
  const bad = status(3, { gpu: 'synthetic-gpu', parityReport: syntheticHash, date: '2025-02-29' });
  const audit = (entries) => verifyStatusUpdateAuthor(before, { status: entries }, { actorRole: 'reviewer' });
  assert.deepEqual(audit([good, bad]).violations, [
    { code: 'parity-report-required', key: makeStatusKey(bad) },
    { code: 'invalid-status-date', key: makeStatusKey(bad) },
  ]);
  assert.equal(audit([good, { ...bad, parityReport, date: statusDate }]).ok, true);
});

test('复核者不能借用另一环境的状态，低级变更不需要对拍报告', () => {
  const before = { status: [status(3, { parityReport })] };
  const another = status(2, { source: '0.188.0' });
  const audit = (entries) => verifyStatusUpdateAuthor(before, { status: entries }, { actorRole: 'reviewer' });
  assert.deepEqual(audit([...before.status, another]).violations, [{ code: 'parity-report-required', key: makeStatusKey(another) }]);
  assert.equal(audit([...before.status, { ...another, level: 'reproduced' }]).ok, true);
});

test('M1 原文的纯数字摘要在 JSON 数值转换前被拦截', () => {
  const digits = '1'.repeat(64);
  const leak = { code: 'bare-sha256', path: '/' };
  for (const text of [digits, JSON.stringify(digits)]) assert.deepEqual(scanCardLeaks(text), [leak]);
  assert.deepEqual(scanCardLeaks(`{"note":${digits},"note":0}`), [{ ...leak, path: '/note' }]);
  const report = JSON.stringify({ status: [{ parityReport: `sha256:${digits}` }] });
  assert.deepEqual(scanCardLeaks(report), []);
  assert.deepEqual(scanCardLeaks(`[${report},${digits}]`).map(({ path }) => path), ['/0/status/0/parityReport', '/1']);
});

test('M2 注册输入及两种查询返回的嵌套对象与索引隔离', () => {
  const input = structuredClone(fullCard);
  const sample = createCardRegistry([input]);
  for (const card of [input, sample.getCard(input.id), sample.getCard(`${input.id}@1`)]) {
    card.version = '2.0.0';
    card.status[0].level = 'read';
    card.livesIn.pop();
    assert.deepEqual(sample.getCard(`${input.id}@1`), fullCard);
    assert.equal(sample.getCard(`${input.id}@2`), null);
    assert.equal(sample.searchCards({ livesIn: 'source:blender' })[0].version, fullCard.version);
  }
});

test('M3 新增或改动环境条目必须有合法等级、日历日期及对应量测证据', () => {
  const original = fullCard.status[0];
  function audit(previous, entry) {
    return verifyStatusUpdateAuthor({ status: previous }, { status: [entry] }, { actorRole: 'reviewer' });
  }
  for (const previous of [[], [original]]) {
    for (const level of levelNames) {
      const entry = { ...original, level, date: '2026-02-31' };
      assert.deepEqual(audit(previous, entry).violations, [{ code: 'invalid-status-date', key: makeStatusKey(entry) }]);
      delete entry.date;
      assert.equal(audit(previous, entry).ok, false);
      entry.date = statusDate;
      assert.equal(audit(previous, entry).ok, true);
      delete entry.parityReport;
      assert.equal(audit(previous, entry).ok, statusLevels[level] < statusLevels.measured);
      entry.parityReport = syntheticHash;
      if (statusLevels[level] >= statusLevels.measured) assert.equal(audit(previous, entry).ok, false);
    }
    for (const level of [['measured'], 2, 'unknown']) assert.equal(audit(previous, { ...original, level }).ok, false);
  }
});

test('M4 多落点迁入已有求值核以及任一旧落点删减都须升主版本', () => {
  const before = { ...fullCard, id: 'assembly.audit', kind: 'assembly', impl: [baseCard.impl[0], fullCard.impl[1]] };
  const [data, source] = before.impl;
  const hashes = { [data.entry]: syntheticHash, [source.entry]: 'b'.repeat(64) };
  assert.ok(validateCard(before).ok);
  for (const remaining of [data, source]) {
    const next = { ...before, version: '1.0.1', impl: [remaining], livesIn: [remaining.livesIn] };
    const moved = { [remaining.entry]: hashes[source.entry] };
    assert.ok(validateCard(next).ok);
    assert.equal(checkVersionBump(before, hashes, next, moved).ok, false);
    assert.ok(checkVersionBump(before, hashes, { ...next, version: '2.0.0' }, moved).ok);
    assert.ok(checkVersionBump(next, moved, { ...before, version: '1.0.2' }, hashes).ok);
  }
});

test('M5 空清单即使匹配空字节摘要也无法核锁', () => {
  const lock = { version: fullCard.version, sha256: createHash('sha256').digest('hex') };
  assert.throws(() => hashCardContents({}), TypeError);
  assert.deepEqual(verifyCardLock(fullCard, {}, lock), { ok: false, violations: [{ code: 'invalid-file-manifest' }] });
});

test('S1 每个主版本只推荐可按同一引用取回的生效版', () => {
  const versions = ['1.0.0', '1.1.0', '1.2.0', '2.0.0', '3.0.0'].map((version) => ({
    ...fullCard, version, title: version,
    ext: { 'registry.deprecated': ['1.2.0', '3.0.0'].includes(version) },
  }));
  const sample = createCardRegistry(versions);
  const hits = sample.searchCards();
  assert.deepEqual(hits.map(({ version }) => version).sort(), ['1.1.0', '2.0.0']);
  for (const hit of hits) assert.equal(sample.getCard(`${hit.id}@${hit.version.split('.')[0]}`).title, hit.title);
  const historical = createCardRegistry([{ ...versions[0], title: '仅旧版可见' }, versions[1]]);
  assert.deepEqual(historical.searchCards({ q: '仅旧版' }), []);
});

test('S2 固定字段占 299、300、301 字节时可区分缺字、超额与无匹配', () => {
  const base = fixture('budget', 2, [1, 1], 1, { intent: 'a' });
  const [summary] = createCardRegistry([base]).searchCards();
  const minimum = estimateTokens({ ...summary, title: '', intent: '' });
  for (const fixedBytes of [299, 300, 301]) {
    const card = { ...base, id: base.id + 'x'.repeat(fixedBytes - minimum) };
    assert.ok(validateCard(card).ok);
    const sample = createCardRegistry([card]);
    const diagnostics = [];
    const onDiagnostic = (issue) => diagnostics.push(issue);
    assert.deepEqual(sample.searchCards({ q: '无匹配', onDiagnostic }), []);
    assert.deepEqual(diagnostics, []);
    const hits = sample.searchCards({ onDiagnostic });
    assert.equal(hits.length, fixedBytes <= 300 ? 1 : 0);
    assert.ok(hits.every((item) => estimateTokens(item) <= 300));
    assert.deepEqual(diagnostics, [{ code: 'summary-budget', id: card.id, version: card.version,
      fixedBytes, budgetBytes: 300, omitted: fixedBytes > 300 }]);
  }
});

test('S3 两个锁入口均拒绝 Windows 盘符绝对路径', () => {
  for (const path of [['C', ':/synthetic.mjs'].join(''), ['d', ':/nested/synthetic.mjs'].join(''), ['D', ':\\synthetic.mjs'].join('')]) {
    const files = { [path]: syntheticHash };
    const lock = { version: fullCard.version, sha256: createHash('sha256').update(`${path}\n${syntheticHash}\n`).digest('hex') };
    assert.throws(() => hashCardContents(files), TypeError);
    assert.deepEqual(verifyCardLock(fullCard, files, lock).violations, [{ code: 'invalid-file-manifest' }]);
  }
});
