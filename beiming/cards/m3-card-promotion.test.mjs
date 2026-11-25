import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { globSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import test from 'node:test';
import { buildBoard } from '../bench/board.mjs';
import { createCardRegistry } from './registry.mjs';
import { statusLevels, verifyStatusUpdateAuthor } from './status.mjs';
import { scanCardLeaks, validateCard } from './validate-card.mjs';

const HERE = import.meta.dirname;
const BENCH = join(HERE, '../bench');
const PROMOTION_DATE = '2026-11-25';
const readText = (path) => readFileSync(path, 'utf8');

// 升级前的真实 status[0]，按相同的宿主、版本、显卡和日期归组；不从新状态反推。
const priorStatuses = new Map([
  ['node', '24.13.1', 'none', '2026-11-21', ['audio.master', 'deliver.encode']],
  ['node', '24.13.1', 'none', '2026-11-22', ['audio.align', 'audio.event-mix', 'overlay.cursor', 'overlay.subs']],
  ['node', '24.13.1', 'none', '2026-11-23', ['layout.panels']],
  ['kernel-eval', '0.1.0', 'none', '2026-11-21', ['time.envelope', 'time.events', 'time.timeline']],
  ['kernel-eval', '0.1.0', 'none', '2026-11-22', ['time.cut-grid', 'time.narration']],
  ['kernel-eval', '0.1.0', 'none', '2026-11-23', ['camera.cue-kf', 'camera.drift', 'camera.fit', 'camera.orbit']],
  ['page', '0.187.0', 'apple-m5-pro', '2026-11-23', ['page.det2d']],
].flatMap(([host, source, gpu, date, ids]) => ids.map((id) => [id, { level: 'reproduced', host, source, gpu, date }])));
const promotedIds = [...priorStatuses.keys()].sort();
const cardFiles = globSync('**/card.json', { cwd: HERE }).map((path) => {
  const raw = readText(join(HERE, path));
  return { raw, card: JSON.parse(raw) };
});
const cards = cardFiles.map(({ card }) => card);

function publicEvidence() {
  const questions = [];
  for (const group of ['level-1', 'level-2-a', 'level-2-b']) {
    const dir = join(BENCH, 'questions', group);
    for (const name of globSync('*.json', { cwd: dir })) {
      const question = JSON.parse(readText(join(dir, name)));
      if (question.format !== 'question/0.1' || !question.scoring?.length) continue;
      questions.push({ group, slug: basename(name, '.json'), question });
    }
  }
  assert.equal(questions.length, 12);
  assert.equal(new Set(questions.map(({ question }) => question.id)).size, 12);
  questions.sort(({ question: a }, { question: b }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const normalize = (path) => readText(path).replaceAll('\r\n', '\n');
  const byCard = new Map();
  for (const { group, slug, question } of questions) {
    const recordText = normalize(join(BENCH, 'calibration/records', `${slug}.json`));
    const filmText = normalize(join(BENCH, 'solutions', group, slug, 'film.json'));
    assert.equal(JSON.parse(recordText).questionId, question.id);
    assert.equal(JSON.parse(filmText).exam, question.id);
    for (const id of question.needs) {
      if (!byCard.has(id)) byCard.set(id, []);
      byCard.get(id).push([question.id, recordText, filmText]);
    }
  }
  return byCard;
}

test('M3：准确升级指定的 17 张 B20+B7 实证卡为 measured，且卡名全局唯一', () => {
  assert.ok(cards.length >= 30);
  assert.equal(new Set(cards.map(({ id }) => id)).size, cards.length);
  assert.equal(promotedIds.length, 17);
  const byId = new Map(cards.map((card) => [card.id, card]));
  for (const id of promotedIds) {
    const card = byId.get(id);
    assert.ok(card, `缺少应晋升的卡: ${id}`);
    assert.deepEqual(card.status.map(({ level }) => level), ['measured'], id);
  }
  for (const { id, status } of cards) {
    if (!priorStatuses.has(id)) {
      assert.ok(status.length >= 1, id);
    }
  }
});

test('M3：升级卡过结构、CF 和泄露检查，对拍摘要能从公开证据重算', () => {
  const evidence = publicEvidence();
  assert.deepEqual([...evidence.keys()].sort(), promotedIds);
  for (const { raw, card } of cardFiles) {
    const tuples = evidence.get(card.id);
    if (!tuples) continue;
    assert.deepEqual(scanCardLeaks(raw), [], card.id);
    assert.deepEqual(validateCard(card), { ok: true, schemaErrors: [], violations: {}, leaks: [] }, card.id);
    // 固定编码：按题目 id 的 UTF-16 码元字典序排列 [id, B7 记录原文, B20 film 原文]。
    // 原文以 UTF-8 读取，仅 CRLF→LF（保留末尾换行）；对整个数组紧凑 JSON.stringify，
    // 不追加换行，再对 UTF-8 字节算 SHA-256。题号用 id 而非文件名（1-1，不是 01-1）。
    const digest = createHash('sha256').update(JSON.stringify(tuples), 'utf8').digest('hex');
    assert.equal(card.status[0].parityReport, `sha256:${digest}`, card.id);
  }
});

test('M3：升级保留原宿主环境，复核方可改状态，实现方不可', () => {
  for (const card of cards) {
    const prior = priorStatuses.get(card.id);
    if (!prior) continue;
    const previous = { ...card, status: [prior] };
    const { host, source, gpu, date } = card.status[0];
    assert.deepEqual([host, source, gpu, date], [prior.host, prior.source, prior.gpu, PROMOTION_DATE], card.id);
    assert.deepEqual(verifyStatusUpdateAuthor(previous, card, { actorRole: 'reviewer' }), { ok: true, violations: [] }, card.id);
    assert.deepEqual(verifyStatusUpdateAuthor(previous, card, { actorRole: 'implementer' }), {
      ok: false, violations: [{ code: 'status-reviewer-required' }],
    }, card.id);
  }
});

test('M3：全量看板计入至少 17 张量测通过的卡且总数对齐当前卡库', () => {
  const { cards: progress } = buildBoard({ asOf: PROMOTION_DATE, cards }).integrationProgress;
  const expectedVerified = cards.filter(({ status }) => status.some(({ level }) => level === 'measured' || level === 'calibrated')).length;
  assert.equal(progress.total, cards.length);
  assert.ok(expectedVerified >= 17);
  assert.equal(progress.verifiedOrAbove, expectedVerified);
  assert.equal(progress.byStatus.verified, cards.filter(({ status }) => status.some(({ level }) => level === 'measured')).length);
});

test('M3：D14 窗口结束后能逐张搜到可见的升级卡，机制卡仍只按名取', () => {
  const registry = createCardRegistry(cards, { nowDate: '2026-12-01', allowReproducedUntilDate: '2026-11-30' });
  for (const { id, status } of cards) {
    // 逐张查，避免检索最多只回五条遮住已升级的卡。
    const result = registry.searchCards({ q: id }).find((row) => row.id === id);
    if (id === 'page.det2d') {
      assert.equal(registry.getCard(id)?.status[0].level, 'measured');
      assert.equal(result, undefined, id);
    } else if (priorStatuses.has(id)) {
      assert.equal(result?.statusLevel, statusLevels.measured, id);
    } else if (status.every(({ level }) => level === 'reproduced')) {
      assert.equal(result, undefined, id);
    }
  }
});
