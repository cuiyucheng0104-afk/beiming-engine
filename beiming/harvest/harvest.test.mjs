import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBoard } from '../bench/board.mjs';
import { createCardRegistry } from '../cards/registry.mjs';
import { validateCard } from '../cards/validate-card.mjs';
import { HARVEST_FORMAT, draftHarvestCandidates, computeCandidateKey, isSameThing,
  createHarvestQueue, createPromotionProposal, promoteCandidateCard, MAX_QUEUE_SIZE, EXPIRY_DAYS, PROMOTION_MIN_FILMS } from './index.mjs';

const asOf = '2024-02-20';
const film = { filmId: 'film-a', authorSessionId: 'author-a', mode: 'native-code', scope: 'team',
  rendered: true, readbackVerified: true, basePredicatesPassed: true, filmType: 'assembly',
  sceneScale: '1 m', fps: 24, viewTransform: 'sRGB' };
const nativeModule = { sourceCode: 'function ripple(a = 1, b = 2) { return a + b }', shotPredicatesPassed: true };
const draft = (overrides = {}, options = {}) => draftHarvestCandidates({ ...film, nativeModules: [nativeModule], ...overrides }, options);
const check = (assertion) => ({ format: HARVEST_FORMAT, kind: 'check', assertion });
const prior = (name) => ({ format: HARVEST_FORMAT, kind: 'prior', cardId: 'motion.ripple', paramName: name });
const use = (filmId = 'film-a', date = asOf, unlocksExams = []) => ({ asOf: date, filmId, unlocksExams });
const evidence = { harvestAgentSessionId: 'reviewer', selftestPassed: true, calibrationPassed: true, pureFunctionGatePassed: true,
  confirmedUnits: { a: 'm', b: 'm' }, host: 'node', source: 'three', gpu: 'software' };

async function twoFilms() {
  const queue = createHarvestQueue();
  const [a] = (await draft()).candidates;
  const [b] = (await draft({ filmId: 'film-b', authorSessionId: 'author-b' })).candidates;
  queue.enqueue(a, use('film-a', asOf, ['1-1']));
  const item = queue.enqueue(b, use('film-b', asOf, ['1-2']));
  return { queue, proposal: item.promotionProposal };
}

test('H1 团队、渲染、读回与基础谓词是起草四类候选的共同前提', async () => {
  for (const override of [{ scope: 'external' }, { scope: undefined }, { rendered: false }, { readbackVerified: false }, { basePredicatesPassed: false }]) {
    const result = await draft({ ...override, passedExtraPredicates: ['visible(hero)'] }, { runCalibration() { assert.fail('未准入却触发校准'); } });
    assert.deepEqual(result.candidates, []);
    assert.ok(result.skippedReason);
  }
  for (const override of [{ mode: 'cards-data' }, { nativeModules: [{ ...nativeModule, belongsToCard: 'motion.ripple' }] },
    { nativeModules: [{ ...nativeModule, shotPredicatesPassed: false }] }]) {
    const result = await draft(override);
    assert.ok(!result.candidates.some((c) => c.kind === 'module'));
  }
});

test('H1 从 JS、对象解构与 Python 抽取参数和默认值，每个模块校准一次', async () => {
  for (const sourceCode of [nativeModule.sourceCode, 'function ripple({ a = 1, b = 2 }) { return a + b }', 'def ripple(a=1.0, b=2):\n    return a + b']) {
    let calls = 0;
    const result = await draft({ nativeModules: [{ ...nativeModule, sourceCode }] }, { runCalibration() { calls++; return { passed: true }; } });
    assert.equal(result.format, 'harvest-candidate/0.1');
    assert.equal(result.candidates.length, 1);
    const [c] = result.candidates;
    assert.equal(c.kind, 'module');
    assert.match(c.entrySignature, /ripple/);
    assert.deepEqual(Object.keys(c.params).sort(), ['a', 'b']);
    assert.deepEqual([c.params.a.default, c.params.b.default], [1, 2]);
    assert.equal(c.params.a.unit, '待确认');
    assert.equal(c.params.b.unitUnconfirmed, true);
    assert.equal(calls, 1);
    assert.ok(c.calibrationCheck);
    assert.equal(c.cardDraft.ext['registry.candidate'], true);
  }
});

test('H1 源码去注释与空白后命中现有卡时只起草变体', async () => {
  const [original] = (await draft()).candidates;
  const result = await draft({ existingCards: [{ id: 'motion.ripple', contentHash: original.contentHash }],
    nativeModules: [{ ...nativeModule, sourceCode: 'function ripple(a=1,b=2){ /* example */ return a+b }' }] });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].mergeIntoCard, 'motion.ripple');
  assert.ok(!result.candidates[0].cardDraft);
});

test('H1 与正式卡按入口和八成参数重合查重，低于八成不合并', async () => {
  const [a] = (await draft({ nativeModules: [{ ...nativeModule, sourceCode: 'function wave(a=1,b=1,c=1,d=1,e=1){}' }] })).candidates;
  const existingCards = [a.cardDraft];
  const variant = async (args) => (await draft({ existingCards, nativeModules: [{ ...nativeModule, sourceCode: `function wave(${args}){ return 1 }` }] })).candidates[0];
  assert.equal((await variant('a,b,c,d,f')).mergeIntoCard, a.cardDraft.id);
  const distinct = await variant('a,b,c,f,g');
  assert.ok(distinct.cardDraft && !distinct.mergeIntoCard);
  assert.notEqual(distinct.cardDraft.id, a.cardDraft.id);
});

test('H1 片中零值可补全无默认值的参数，校准失败不伪造通过', async () => {
  const [c] = (await draft({ nativeModules: [{ ...nativeModule, sourceCode: 'function wave(count){}', paramValues: { count: 0 } }] },
    { runCalibration: async () => { throw new Error('未通过'); } })).candidates;
  assert.equal(c.params.count.default, 0);
  assert.equal(c.calibrationCheck.ok, false);
});

test('H2 cards-data 可起草两种来源的谓词，拒绝未登记和语法错误的断言', async () => {
  for (const filmType of ['assembly', 'delivery-web']) {
    const { candidates, rejected } = await draft({ mode: 'cards-data', filmType, passedExtraPredicates: ['inside_frame(hero, margin=0.05)', 'invented(hero)'],
      reviewSuggestedPredicates: ['visible(hero) >= 0.8', 'visible('] });
    assert.deepEqual(candidates.map((c) => c.kind), ['check', 'check']);
    assert.deepEqual(candidates.map((c) => c.assertion).sort(), ['inside_frame(hero, margin=0.05)', 'visible(hero) >= 0.8']);
    assert.ok(candidates.every((c) => c.targetTemplate === `template:${filmType}@1`));
    assert.equal(rejected.length, 2);
  }
});

test('H2 先验保留量测和上下文，缺单位、缺尺度或有泄露时拒收', async () => {
  const valid = { cardId: 'motion.ripple', paramName: 'width', value: 0.5, unit: 'm', readback: 0.52,
    sceneScale: '1 m', fps: 24, viewTransform: 'sRGB' };
  const rows = [valid, { ...valid, unit: '' }, { ...valid, sceneScale: '' }, { ...valid, fps: 0 }, { ...valid, viewTransform: '' },
    { ...valid, readback: null }, { ...valid, readback: NaN }, { ...valid, comment: ['lab', '//private'].join(':') }];
  const { candidates, rejected } = await draft({ mode: 'cards-data', sceneScale: undefined, cardParamReadbacks: rows });
  assert.equal(rejected.length, rows.length - 1);
  assert.equal(candidates.length, 1);
  const [p] = candidates;
  assert.equal(p.kind, 'prior');
  for (const key of ['cardId', 'paramName', 'value', 'unit', 'readback', 'sceneScale', 'fps', 'viewTransform']) assert.deepEqual(p[key], valid[key], key);
  assert.equal(p.verifiedInOurStack, true);
});

test('H2 返修记录按类别和码聚合；两种重复故障形成 L1 规则', async () => {
  const reworkRecords = ['色彩标签错', 'AAC 峰值反弹'].flatMap((category, i) => [
    { category, filmId: 'film-a' }, { code: ['color-tag-mismatch', 'aac-true-peak-bounce'][i], filmId: 'film-b' }]);
  const { candidates } = await draft({ mode: 'cards-data', reworkRecords });
  assert.deepEqual(candidates.map((c) => c.errorCode).sort(), ['aac-true-peak-bounce', 'color-tag-mismatch']);
  for (const c of candidates) {
    assert.equal(c.kind, 'pitfall');
    assert.ok(c.ruleId && c.checkTarget && c.fixHint);
    assert.equal(c.occurrences, 2);
    assert.deepEqual([...c.sampleFilms].sort(), ['film-a', 'film-b']);
  }
  const strict = await draft({ mode: 'cards-data', reworkRecords }, { minOccurrences: 3 });
  assert.deepEqual(strict.candidates, []);
});

test('H3 阈值不同的同物合并片号、用量与考题，第二片仅生成一次提案', () => {
  const q = createHarvestQueue();
  const a = check('inside_frame(hero, margin=0.05)'), b = check('inside_frame(hero, margin=0.08)');
  assert.equal(computeCandidateKey(a), computeCandidateKey(b));
  assert.ok(!isSameThing(a, check('visible(hero)')));
  const first = q.enqueue(a, use());
  assert.equal(first.promotionProposal, null);
  q.enqueue(b, use('film-a', asOf, ['1-1']));
  const second = q.enqueue(b, use('film-b', asOf, ['1-1', '1-2']));
  assert.deepEqual(second.usedByFilms, ['film-a', 'film-b']);
  assert.deepEqual(second.unlocksExams, ['1-1', '1-2']);
  assert.equal(second.usedCount, PROMOTION_MIN_FILMS);
  assert.ok(second.promotionEligible && second.promotionProposal.ok);
  assert.deepEqual(q.enqueue(a, use('film-c', '2024-02-21')).promotionProposal, second.promotionProposal);
  assert.deepEqual(q.getBoardHarvestStats(), { drafted: 1, promoted: 0, archived: 0, reproducedPromotions: 0 });
});

test('H3 模块参数名恰有八成重合即复用；入口不同且内容不同另起', async () => {
  async function moduleFor(name, args) {
    const sourceCode = `function ${name}(${args}) { return a }`;
    return (await draft({ nativeModules: [{ ...nativeModule, sourceCode }] })).candidates[0];
  }
  const q = createHarvestQueue();
  const a = await moduleFor('wave', 'a=1,b=2,c=3,d=4,e=5');
  const b = await moduleFor('wave', 'a=1,b=2,c=3,d=4,f=6');
  const c = await moduleFor('fold', 'a=1,b=2,c=3,d=4,f=6');
  assert.ok(isSameThing(a, b));
  assert.ok(!isSameThing(a, c));
  q.enqueue(a, use());
  assert.ok(q.enqueue(b, use('film-b')).promotionProposal);
  assert.equal(q.enqueue(c, use()).usedCount, 1);
});

test('H3 同卡同参的先验去重，坑按错误码或规则号任一相同去重', () => {
  assert.ok(isSameThing(prior('speed'), { ...prior('speed'), value: 12 }));
  assert.ok(!isSameThing(prior('speed'), prior('width')));
  const pit = { kind: 'pitfall', errorCode: 'alpha', ruleId: 'l1.alpha' };
  assert.ok(isSameThing(pit, { ...pit, ruleId: 'l1.other' }));
  assert.ok(isSameThing(pit, { ...pit, errorCode: 'beta' }));
});

test('H3 满 30 张先查重，再按最近使用、创建日、id 淘汰', () => {
  const q = createHarvestQueue();
  assert.equal(MAX_QUEUE_SIZE, 30);
  const old = q.enqueue(prior('old'), use());
  const recent = q.enqueue(prior('recent'), use());
  q.enqueue(prior('recent'), use('film-a', '2024-02-22'));
  for (let i = 2; i < 30; i++) q.enqueue(prior(`p${i}`), use('film-a', '2024-02-21'));
  q.enqueue(prior('old'), use('film-a', '2024-02-21'));
  assert.deepEqual(q.getState().archived, []);
  q.enqueue(prior('new'), use('film-b', '2024-02-22'));
  const { archived, pending } = q.getState();
  assert.equal(pending.length, 30);
  assert.equal(archived[0].id, old.id);
  assert.equal(archived[0].archivedReason, 'evicted-lru');
  assert.ok(pending.some((r) => r.id === recent.id));
  const expected = pending.filter((r) => r.lastUsedAt === '2024-02-21').map((r) => r.id).sort()[0];
  q.enqueue(prior('extra'), use('film-b', '2024-02-22'));
  assert.equal(q.getState().archived[1].id, expected);
});

test('H3 按创建日过期，跨闰日第 14 天保留、第 15 天归档，复用项保留', () => {
  const q = createHarvestQueue();
  assert.equal(EXPIRY_DAYS, 14);
  for (const name of ['single', 'reused']) q.enqueue(prior(name), use());
  q.enqueue(prior('reused'), use('film-b', '2024-03-01'));
  q.enqueue(prior('single'), use('film-a', '2024-03-05'));
  assert.deepEqual(q.pruneExpired({ asOf: '2024-03-05' }), []);
  const [pruned] = q.pruneExpired({ asOf: '2024-03-06' });
  assert.equal(pruned.archivedReason, 'expired-14d');
  assert.equal(pruned.candidate.paramName, 'single');
  assert.deepEqual(q.pruneExpired({ asOf: '2024-03-07' }), []);
  const stats = createHarvestQueue(q.getState()).getBoardHarvestStats();
  assert.deepEqual(stats, { drafted: 2, promoted: 0, archived: 1, reproducedPromotions: 0 });
  assert.deepEqual(buildBoard({ asOf, harvest: stats }).integrationProgress.harvest, stats);
  for (const date of [undefined, '2024-02-30', '2024-2-2']) {
    assert.throws(() => q.pruneExpired({ asOf: date }), RangeError);
    assert.throws(() => q.enqueue(prior('x'), use('film-b', date ?? '')), RangeError);
  }
});

test('H3 候选进入真实 registry 后，即使允许 reproduced 也检索不到', async () => {
  const { queue } = await twoFilms();
  const cards = queue.listCandidateCards();
  assert.equal(cards.length, 1);
  // 给候选足够的检索等级，隔离验证 candidate 标志本身。
  cards[0].status = [{ level: 'measured', host: 'node', source: 'three', gpu: 'software', date: asOf }];
  const registry = createCardRegistry(cards, { allowReproduced: true });
  assert.equal(registry.getCard(cards[0].id).ext['registry.candidate'], true);
  assert.deepEqual(registry.searchCards(), []);
  delete cards[0].ext['registry.candidate'];
  assert.equal(createCardRegistry(cards).searchCards().length, 1);
  assert.ok(queue.listCandidateCards()[0].ext['registry.candidate']);
});

test('H4 两个不同片号才可提案，单片或重复片号硬拒', async () => {
  const q = createHarvestQueue();
  const [c] = (await draft()).candidates;
  const first = q.enqueue(c, use());
  for (const item of [first, { ...first, usedByFilms: ['film-a', 'film-b'] }, { ...first, usedCount: 2, usedByFilms: ['film-a', 'film-a'] }]) {
    assert.equal(createPromotionProposal(item, { asOf }).code, 'harvest.insufficient-reuse');
    assert.equal(promoteCandidateCard(item, evidence, { asOf }).code, 'harvest.insufficient-reuse');
  }
});

test('H4 原作者、复用片作者、空会话以及篡改提案无法通过队列的独立门', async () => {
  const { queue, proposal } = await twoFilms();
  const before = queue.getState();
  for (const harvestAgentSessionId of ['author-a', 'author-b', ' ', undefined]) {
    const modified = structuredClone(proposal);
    modified.candidate.authorSessionId = 'other';
    modified.authorSessionIds = [];
    const result = promoteCandidateCard(modified, { ...evidence, harvestAgentSessionId }, { asOf, queue });
    assert.equal(result.code, 'harvest.independent-agent-required');
  }
  assert.deepEqual(queue.getState(), before);
});

test('H4 三项证据、每个未确认单位逐项报缺，非法卡不计晋升', async () => {
  const { queue, proposal } = await twoFilms();
  const res = queue.promote(proposal, { ...evidence, selftestPassed: false, calibrationPassed: undefined, pureFunctionGatePassed: 'true', confirmedUnits: { a: '待确认' } }, { asOf });
  assert.equal(res.code, 'harvest.missing-evidence');
  assert.deepEqual(res.missing, ['selftestPassed', 'calibrationPassed', 'pureFunctionGatePassed', 'params.a.unit', 'params.b.unit']);
  assert.equal(queue.promote(proposal, { ...evidence, confirmedUnits: { a: 'rad', b: 'm' } }, { asOf }).code, 'harvest.invalid-card');
  assert.equal(queue.getState().pending.length, 1);
});

test('H4 独立晋升写入合法 reproduced 卡、移出队列，重试保持看板计数', async () => {
  const { queue: origin, proposal } = await twoFilms();
  const queue = createHarvestQueue(JSON.parse(JSON.stringify(origin.getState())));
  const result = promoteCandidateCard(proposal, evidence, { asOf, queue });
  assert.equal(result.ok, true, JSON.stringify(result));
  const card = result.promotedCard;
  assert.deepEqual(card.status, [{ level: 'reproduced', host: evidence.host, source: evidence.source, gpu: evidence.gpu, date: asOf }]);
  assert.ok(!Object.hasOwn(card.ext ?? {}, 'registry.candidate'));
  assert.ok(card.exams.includes('1-1') && card.exams.includes('1-2'));
  assert.ok(validateCard(card).ok);
  assert.equal(createCardRegistry([card], { allowReproduced: true }).searchCards()[0].id, card.id);
  assert.deepEqual(queue.listCandidateCards(), []);
  assert.equal(queue.promote(proposal, evidence, { asOf }).code, 'harvest.not-pending');
  const stats = queue.getBoardHarvestStats();
  assert.deepEqual(stats, { drafted: 1, promoted: 1, archived: 0, reproducedPromotions: 1 });
  assert.deepEqual(buildBoard({ asOf, harvest: stats }).integrationProgress.harvest, stats);
});
