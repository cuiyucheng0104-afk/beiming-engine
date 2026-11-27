import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getRoleVegCardPriors, getRoleVegMigrationManifest } from './priors-role-veg.mjs';
import * as cards from './index.mjs';
import { scanPriorLeaks } from './priors.mjs';

const raw = (name) => readFileSync(new URL(`./priors-data/role-veg.${name}.json`, import.meta.url), 'utf8');
const entries = JSON.parse(raw('card-priors')).entries;
const manifest = getRoleVegMigrationManifest();
const details = manifest.ledger.filter((e) => e.kind === 'detail');
const summaries = manifest.ledger.filter((e) => e.kind === 'summary');
const bySource = new Map(details.map((e) => [e.sourceId, e]));
// Same formal catalog used by C12; existence/promotion of executable cards is a separate task.
const official = new Set([
  'asset.glb-bridge', 'form.primitives', 'form.sdf-nets', 'form.superloft',
  'fx.streak-ring', 'mat.library', 'motion.ik2', 'motion.roll-bank',
  'motion.spring-chain', 'motion.sweep-body', 'motion.swim', 'motion.wing',
  'rig.rigid-ik', 'shade.px-lod', 'shade.scales', 'shade.shell-fur',
  'shade.thin-line', 'wind.gust-wake', 'particle.ambient',
]);

const sha = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const expected = {
  'card-priors': 'sha256:6d4967c339760b98f5e38bcb3f28ac0c5050f1aff4172410809cf2297788bc58',
  manifest: 'sha256:a736d9b280a469d315540f105a1882a512b076e7d6db9c149f34187707505f57',
};

test('C13 两份原文固定且通过C9泄露扫描', () => {
  for (const name of Object.keys(expected)) {
    assert.equal(sha(raw(name)), expected[name], name);
    assert.deepEqual(scanPriorLeaks(raw(name)), [], name);
  }
});

test('C13 514行闭合：388明细、126汇总，历史516有显式校正', () => {
  assert.equal(manifest.format, 'priors-migration/0.1');
  assert.equal(manifest.collection, 'role-veg');
  assert.equal(manifest.totalSourceEntries, 514);
  assert.equal(manifest.detailEntries, 388);
  assert.equal(manifest.summaryRows, 126);
  assert.equal(details.length, 388);
  assert.equal(summaries.length, 126);
  assert.equal(entries.length, 388);
  assert.equal(new Set(manifest.ledger.map((e) => e.sourceId)).size, 514);
  assert.equal(new Set(manifest.ledger.map((e) => e.sourceLine)).size, 514);
  assert.equal(new Set(entries.map((e) => e.id)).size, 388);
  assert.equal(details.filter((e) => e.section === '18').length, 57);
  assert.equal(manifest.portableCount, 0);
  assert.equal(manifest.practiceCount, 0);
  assert.equal(manifest.cardCoupledCount, 514);
  assert.equal(manifest.emittedCounts.cardPriors, 388);
  assert.equal(manifest.historicalCount.planned, 516);
  assert.equal(manifest.historicalCount.difference, 2);
  assert.deepEqual(manifest.historicalCount.excludedGuidance.map((e) => e.sourceLine), [3223, 3224]);
  assert.ok(manifest.ledger.every((e, i, all) => i === 0 || e.sourceLine > all[i - 1].sourceLine));
  assert.deepEqual(manifest.cards, [...official].sort());
  for (const e of manifest.ledger) {
    assert.equal(e.route, 'card-coupled', e.sourceId);
    assert.equal(e.cardId, e.target);
    assert.ok(official.has(e.cardId), e.sourceId);
  }
  for (const e of entries) {
    const row = bySource.get(e.sourceId);
    assert.ok(row, e.id);
    assert.deepEqual(row.targets, [e.id]);
    assert.equal(row.cardId, e.cardId);
    assert.equal(row.section, e.section);
    assert.equal(row.caseId, e.caseId);
  }
});

test('C13 汇总引用同案例真实明细，不重复发出或把gist冒充值等价', () => {
  for (const row of summaries) {
    const parent = bySource.get(row.summaryOf);
    assert.ok(parent, row.sourceId);
    assert.equal(row.caseId, parent.caseId, row.sourceId);
    assert.equal(row.cardId, parent.cardId, row.sourceId);
    assert.equal(row.target, parent.target, row.sourceId);
    assert.deepEqual(row.targets, []);
    assert.equal(row.link, 'gist');
    assert.ok(row.text.length > 0);
    assert.ok(row.evidenceLabel.length > 0);
    assert.ok(row.verificationLabel.length > 0);
    if (row.section !== parent.section) assert.ok(row.crossSectionReason, row.sourceId);
    for (const extra of row.alsoSummarizes ?? []) {
      assert.notEqual(extra, row.summaryOf);
      assert.equal(bySource.get(extra)?.caseId, row.caseId, `${row.sourceId} -> ${extra}`);
    }
  }
  assert.equal(summaries.find((e) => e.sourceId === 's040').summaryOf, 'd249');
  assert.equal(summaries.find((e) => e.sourceId === 's044').summaryOf, 'd253');
  assert.equal(summaries.find((e) => e.sourceId === 's024').summaryOf, 'd298');
  assert.equal(summaries.find((e) => e.sourceId === 's092').summaryOf, 'd271');
});

test('C13 全部参考、0默认、0我方读回，冲突不被静默裁决', () => {
  for (const e of entries) {
    assert.equal(e.useAsDefault, false);
    assert.equal(e.verifiedInOurStack, false);
    assert.equal(Object.hasOwn(e, 'readbackEvidence'), false);
    assert.deepEqual(e.quantities, []);
    assert.equal(e.target, e.cardId);
    assert.ok(['实测', '源码', '文档', '推断'].includes(e.evidenceLevel));
    assert.ok(e.evidenceLabel.length > 0);
    assert.ok(e.verificationLabel.length > 0);
    assert.match(e.docRef, new RegExp(`${e.sourceId}$`));
    assert.ok(e.text.length > 0);
    assert.match(e.recalibrate, /重新标定并读回/);
  }
  for (const conflict of manifest.conflicts) {
    const e = entries.find((row) => row.sourceId === conflict.sourceId);
    assert.ok(e);
    assert.equal(e.useAsDefault, false);
  }
  assert.match(entries.find((e) => e.sourceId === 'd105').text, /31/);
  assert.match(entries.find((e) => e.sourceId === 'd105').text, /32/);
  assert.match(entries.find((e) => e.sourceId === 'd378').text, /rad\/s|弧度/);
  // Nested coordinate arrays are parameters, not wiki links to redact.
  assert.ok(entries.find((e) => e.sourceId === 'd200').text.includes('[[1.24,.05],[1.04,.24]]'));
  assert.equal(entries.find((e) => e.sourceId === 'd267').cardId, 'mat.library');
  assert.equal(entries.find((e) => e.sourceId === 'd371').cardId, 'particle.ambient');
});

test('C13 公开API与前七卷隔离，结果递归不可变', () => {
  assert.equal(cards.getRoleVegCardPriors, getRoleVegCardPriors);
  assert.equal(cards.getRoleVegMigrationManifest, getRoleVegMigrationManifest);
  assert.equal(getRoleVegMigrationManifest(), manifest);
  assert.equal(Object.isFrozen(manifest.ledger[0].targets), true);
  assert.throws(() => { manifest.ledger[0].cardId = 'audio.master'; }, TypeError);
  const refs = getRoleVegCardPriors('form.sdf-nets');
  assert.ok(refs.length > 0);
  assert.equal(Object.isFrozen(refs), true);
  assert.equal(Object.isFrozen(refs[0].quantities), true);
  assert.throws(() => { refs[0].useAsDefault = true; }, TypeError);
  for (const invalid of ['', null, undefined, 42, {}, 'constructor', 'audio.master']) {
    assert.deepEqual(getRoleVegCardPriors(invalid), []);
  }
  assert.equal(manifest.cards.flatMap(getRoleVegCardPriors).length, 388);
});

test('C13 独立复核样本与分歧记录可追溯，不冒充Fable签字', () => {
  const audit = manifest.blindAudit;
  assert.equal(audit.reviewer, 'Codex integration review');
  assert.equal(audit.fullyBlind, false);
  assert.equal(audit.sampleIds.length, 52);
  assert.equal(new Set(audit.sampleIds).size, 52);
  assert.ok(audit.sampleIds.length >= Math.ceil(manifest.totalSourceEntries * 0.1));
  const sampled = audit.sampleIds.map((id) => manifest.ledger.find((row) => row.sourceId === id));
  assert.ok(sampled.every(Boolean));
  assert.equal(new Set(sampled.map((row) => row.section)).size, 18);
  assert.equal(sampled.filter((row) => row.kind === 'detail').length, 34);
  assert.equal(audit.originalDisagreementRate, 5 / 52);
  assert.ok(audit.originalDisagreementRate <= 0.1);
  assert.equal(audit.findings.length, 5);
  assert.equal(audit.corrected, 5);
  assert.equal(audit.uncorrected, 0);
});

// No private path is embedded in repository tests. A caller may explicitly provide the local document.
const sourcePath = process.env.BEIMING_C13_SOURCE;
test('C13 本地源文逐行结构、主要参数数值与证据标签对账', { skip: !sourcePath && '未提供案例库源文；设置 BEIMING_C13_SOURCE 可复核' }, () => {
  const lines = readFileSync(sourcePath, 'utf8').split('\n');
  const expectedLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^## 本份/.test(lines[i])) break;
    if (/^#{3,4} /.test(lines[i])) {
      let end = i + 1;
      while (end < lines.length && !/^#{1,4} /.test(lines[end])) end++;
      if (lines.slice(i + 1, end).some((e) => e.startsWith('- 参数与做法：'))) expectedLines.push(i + 1);
    }
    if (lines[i].startsWith('| 案例 |')) {
      for (let j = i + 2; lines[j]?.startsWith('|'); j++) expectedLines.push(j + 1);
    }
  }
  assert.deepEqual(expectedLines.sort((a, b) => a - b), manifest.ledger.map((e) => e.sourceLine));
  const numberTokens = (text) => text.replace(/\[\[(?:复刻|案例|指引|阅读|参数)\/.*?\]\]/g, '')
    .replace(/(?:[\w.-]+\/)*[\w.-]+\.(?:js|mjs|py|glb|blend|obj|fbx|txt|md|png|jpg|jpeg)(?::[\d,、–\- ]+)?/gi, '')
    .replace(/\b[a-f0-9]{8,64}\b/gi, '').replace(/RTX\s*5090/gi, 'GPU')
    .match(/-?\d+(?:\.\d+)?/g) ?? [];
  for (const row of manifest.ledger) {
    let original;
    let emitted;
    if (row.kind === 'summary') {
      original = lines[row.sourceLine - 1].slice(1, -1).split(/(?<!\\)\|/)[2];
      emitted = row.text;
    } else {
      let end = row.sourceLine;
      while (end < lines.length && !/^#{1,4} /.test(lines[end])) end++;
      const block = lines.slice(row.sourceLine, end);
      original = block.find((s) => s.startsWith('- 参数与做法：')).slice(8);
      const entry = entries.find((e) => e.sourceId === row.sourceId);
      emitted = entry.text;
      const label = block.find((s) => s.startsWith('- 证据：'))?.slice(5) ?? '未标注';
      const weakest = /推断|推算/.test(label) ? '推断'
        : /原文|画面|陈述/.test(label) ? '文档'
          : /源码|脚本/.test(label) ? '源码'
            : /实测/.test(label) ? '实测' : '文档';
      assert.equal(entry.evidenceLevel, weakest, `${row.sourceId} 证据不得升级`);
    }
    const available = numberTokens(emitted);
    for (const token of numberTokens(original)) {
      const index = available.indexOf(token);
      assert.notEqual(index, -1, `${row.sourceId} L${row.sourceLine} 缺源文数字 ${token}`);
      available.splice(index, 1);
    }
  }
});
