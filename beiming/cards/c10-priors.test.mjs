import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import {
  loadAudioSubsPriorsStore,
  getAudioSubsCardPriors,
  getAudioSubsPractices,
  getAudioSubsMigrationManifest,
} from './priors-audio-subs.mjs';
import * as cards from './index.mjs';
import { PRIOR_UNITS, scanPriorLeaks, validatePriorsTable } from './priors.mjs';

const dataDir = new URL('./priors-data/', import.meta.url);
const raw = (name) => readFileSync(new URL(name, dataDir), 'utf8');
const files = readdirSync(dataDir).filter((f) => f.startsWith('audio-subs.'));
const priorsText = raw('audio-subs.json');
const priors = JSON.parse(priorsText).entries;
const manifest = getAudioSubsMigrationManifest();
const cardPriors = JSON.parse(raw('audio-subs.card-priors.json')).entries;
const practices = getAudioSubsPractices();
const isSummary = (e) => Object.hasOwn(e, 'summaryOf');

test('C10-Red 声音配乐配音与字幕 540 条先验库可加载、过 C9 校验且汇总行指回明细不重复计', () => {
  const store = loadAudioSubsPriorsStore();
  assert.equal(manifest.totalSourceEntries, 540);
  assert.ok(store.stats().detailCount > 100);
  assert.ok(Array.isArray(getAudioSubsCardPriors('audio.master')));
  assert.ok(Array.isArray(getAudioSubsPractices()));
});

test('加载接口从 beiming/cards/index.mjs 导出', () => {
  for (const name of ['loadAudioSubsPriorsStore', 'getAudioSubsCardPriors', 'getAudioSubsPractices', 'getAudioSubsMigrationManifest']) {
    assert.equal(typeof cards[name], 'function', name);
  }
});

test('可移植先验整表过 C9：0 错误、0 泄露、单位合法、全部未读回', () => {
  const checked = validatePriorsTable(priorsText);
  assert.deepEqual(checked.errors, []);
  assert.deepEqual(checked.leaks, []);
  assert.ok(checked.ok);
  for (const e of priors) {
    assert.ok(PRIOR_UNITS.includes(e.unit), e.id);
    assert.equal(e.verifiedInOurStack, false, e.id);
    assert.equal(Object.hasOwn(e, 'readbackEvidence'), false, e.id);
  }
  const view = loadAudioSubsPriorsStore().query({ limit: 1 })[0];
  assert.equal(view.readbackLabel, '未在我方读回');
});

test('四份 JSON 原文零泄露：无原包路径、lab://、本机路径与裸 sha256', () => {
  assert.equal(files.length, 4);
  for (const f of files) assert.deepEqual(scanPriorLeaks(raw(f)), [], f);
});

test('汇总行全部指回真实明细，stats 不重复计数', () => {
  const byId = new Map(priors.map((e) => [e.id, e]));
  const summaries = priors.filter(isSummary);
  assert.ok(summaries.length > 0);
  for (const s of summaries) {
    for (const id of s.summaryOf) {
      assert.ok(byId.has(id), `${s.id} → ${id}`);
      assert.equal(isSummary(byId.get(id)), false);
    }
  }
  const stats = loadAudioSubsPriorsStore().stats();
  assert.equal(stats.detailCount, priors.length - summaries.length);
  assert.equal(stats.summaryCount, summaries.length);
  assert.equal(stats.totalEntries, priors.length);
  assert.equal(stats.verifiedCount, 0);
});

test('540 条总账闭合：四路计数之和、每行去向与各文件条目一一对上', () => {
  const { ledger } = manifest;
  assert.equal(ledger.length, 540);
  assert.equal(new Set(ledger.map((r) => r.sourceId)).size, 540);
  assert.equal(ledger.filter((r) => r.kind === 'detail').length, manifest.detailEntries);
  assert.equal(ledger.filter((r) => r.kind === 'summary').length, manifest.summaryRows);
  assert.equal(manifest.detailEntries + manifest.summaryRows, 540);
  const counts = { portable: manifest.portableCount, 'card-coupled': manifest.cardCoupledCount, practice: manifest.practiceCount, 'skipped-or-conflict': manifest.excludedOrConflictCount };
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 540);
  for (const [route, n] of Object.entries(counts)) assert.equal(ledger.filter((r) => r.route === route).length, n, route);

  const detail = new Map(ledger.filter((r) => r.kind === 'detail').map((r) => [r.sourceId, r]));
  const pools = {
    portable: new Set(priors.map((e) => e.id)),
    'card-coupled': new Set(cardPriors.map((e) => e.id)),
    practice: new Set(practices.map((e) => e.id)),
  };
  const seen = new Set();
  for (const r of ledger) {
    if (r.kind === 'summary') {
      const d = detail.get(r.summaryOf);
      assert.ok(d, `${r.sourceId} 指回 ${r.summaryOf}`);
      assert.equal(r.route, d.route, r.sourceId);
    }
    if (r.route === 'skipped-or-conflict') {
      assert.deepEqual(r.targets, []);
      if (r.kind === 'detail') assert.ok(manifest.excluded.some((x) => x.sourceId === r.sourceId), r.sourceId);
      continue;
    }
    if (r.kind === 'summary' && r.route !== 'portable') {
      assert.deepEqual(r.targets, [], r.sourceId); // 非可移植明细的汇总行只记账，不另生条目
      continue;
    }
    assert.ok(r.targets.length > 0, r.sourceId);
    for (const id of r.targets) {
      assert.ok(pools[r.route].has(id), `${r.sourceId} → ${id}`);
      assert.ok(!seen.has(id), `重复去向 ${id}`);
      seen.add(id);
    }
  }
  const all = [...pools.portable, ...pools['card-coupled'], ...pools.practice];
  assert.deepEqual(all.filter((id) => !seen.has(id)), [], '每条产物都能回到总账');
  assert.equal(manifest.excluded.length, ledger.filter((r) => r.kind === 'detail' && r.route === 'skipped-or-conflict').length);
});

test('挂卡先验不当默认值，按卡可查', () => {
  for (const e of cardPriors) {
    assert.equal(e.useAsDefault, false, e.id);
    assert.equal(e.verifiedInOurStack, false, e.id);
    assert.ok(e.cardId && e.coupling && e.recalibrate, e.id);
  }
  for (const { cardId, count } of manifest.cards) assert.equal(getAudioSubsCardPriors(cardId).length, count, cardId);
  assert.deepEqual(getAudioSubsCardPriors('no.such-card'), []);
  assert.ok(Object.isFrozen(getAudioSubsCardPriors('audio.master')));
});

test('冲突两边都保留：明细里的冲突全部进总账，能对上单位的写进 conflicts', () => {
  assert.ok(manifest.conflicts.length > 0);
  const byId = new Map(priors.map((e) => [e.id, e]));
  for (const c of manifest.conflicts) {
    for (const id of c.attachedTo) assert.ok(byId.get(id)?.conflicts?.length, id);
  }
  const attached = priors.filter((e) => e.conflicts).length;
  assert.equal(attached, new Set(manifest.conflicts.flatMap((c) => c.attachedTo)).size);
});

test('顺手修复生效：案例 13 章号误标、案例标签统一成脱敏编号', () => {
  const fix = manifest.fixes.find((f) => f.issue === 'case13-chapter-label');
  assert.ok(fix);
  assert.equal(fix.occurrencesInSource, 0);
  const known = new Set(manifest.cases.map((c) => c.caseId));
  const caseIds = [
    ...manifest.ledger.map((r) => r.caseId),
    ...priors.map((e) => e.provenance.caseId),
    ...cardPriors.map((e) => e.caseId),
    ...practices.map((e) => e.caseId),
  ];
  for (const id of caseIds) assert.ok(known.has(id) && /^case-[a-z0-9-]+$/.test(id), id);
  // 原始「案例：NN 名字」标签不再出现；案例 14 只剩真正的案例 14。
  for (const f of files) assert.doesNotMatch(raw(f), /案例：\s*\d+\s/, f);
  assert.ok(manifest.ledger.filter((r) => r.caseId === 'case-14').length < 5);
  assert.ok(manifest.ledger.filter((r) => r.caseId === 'case-13').length > 200);
});

// 原作名、角色名、地名、人名的 sha256 前 16 位（名字本身不入库）。
const IP_HASHES = new Set(['86663a1dd8f6b661', '924493ee15e2a68c', 'dd9ab072bf740423', '2bf84b0ad08b23b8', 'f4a6923996dbeb19', '3f8f01ea269b6cfe', 'ecc9bddb65dc4451', '1351704cdc4d32f8', 'b6f6732db83b899a', 'a590c43e71d44866', '8534cd0426607ce6', 'c6661966bce79f30', '419a4461434283fd', 'bb1d46105bd704dc', 'f27354a69b790eda', 'd0b3b3d6c6c14f17', 'aa416dab2cc47c86', '1ae0552a12823c54', '98162a1e33275f16', 'ff627719813c923a', '40a7e9acb06295d6', '6d588db5b668cf12', 'c512ca0c5c1e71be', 'f44b7e30470bbf28', 'c34305e7b35f6f0b', '965b8a7ec4177224', '1e445d2d4b31efe2', 'f1ed891245759d1c', '26dd587fdb6a290c', 'ad21b547ce7162c5', '1dd31cd072fdd30f', 'b3158331cecc3845', 'b9b13e1cd77acbd7', 'ee839bf111a7e47a', 'aaa1073bd98fd4e7', '07f0bf736c13b81f', '9e70b33fe4edaf5b', '5032f1bea2401f8f', 'd4fff627da31250b', '36997f035118cae8', '9fa9e239e047e205', 'b1f49128310e2481', 'eb7855e04a2006fd', 'f5105c9ea0cd361b', 'e5a6d6899f2e6e04', '14fc1fd907298aaa', 'dc7a4a2cc7e36000', '0b2058635ba3d17f', '1f25b77eea9b8db1', '59ee9ed12f7822d8', 'ed818ec233248ae6', '930eaf1684b953a9', '400e436ed3eb0252', 'f09bfa2c3c7042e4', '0e377aac3a660698', 'd544b0316e19a87b', 'dd415e6f13d54a9b', '1fe8ba945043480d', 'e5993ec06c2e0d77', 'c26804e0eaf84a96', '3d8c28f257964498']);

test('零原作 IP 名：拉丁 1–3 词组（拆驼峰）与汉字 2–3 字串都不命中专名哈希表', () => {
  const grams = new Set();
  for (const f of files) {
    const text = raw(f).replace(/['’]s\b/g, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    const words = text.match(/[a-z0-9]+/g) ?? [];
    words.forEach((_, i) => {
      for (let n = 1; n <= 3 && i + n <= words.length; n += 1) grams.add(words.slice(i, i + n).join(' '));
    });
    for (const run of text.match(/[一-鿿]{2,}/g) ?? []) {
      for (let i = 0; i < run.length; i += 1) for (let n = 2; n <= 3 && i + n <= run.length; n += 1) grams.add(run.slice(i, i + n));
    }
  }
  const hit = [...grams].filter((g) => IP_HASHES.has(createHash('sha256').update(g).digest('hex').slice(0, 16)));
  assert.equal(hit.length, 0, `命中 ${hit.length} 个专名`);
});

// 独立规则核查：不复用转换器的正则，只按条目自带原文重判去向，再与总账比对。
function independentRoute(text, evidenceLabel) {
  const units = [...text.matchAll(/\d\s*(LUFS|LRA|LU|dBTP|dBFS|dB|kHz|Hz|ms|s|秒|fps|帧|%|BPM|音分|半音)(?![A-Za-z])/g)].map((m) => m[1]);
  const portableUnits = units.filter((u) => !['BPM', '音分', '半音'].includes(u));
  const digits = (text.match(/(?<![A-Za-z_])\d+(?:\.\d+)?/g) ?? []).length;
  const code = /`|\.(?:js|mjs|py|glsl)\b|\b[a-z]{2,}[A-Z][a-z]|\b[a-z_]\w*\(|\b[a-z_]\w*\s*=|\b[A-Z]{2,}_[A-Z]/.test(text);
  if (!units.length && (/未公开|无音轨|没有提|未提|无声音/.test(text) || evidenceLabel === '未公开')) return 'skipped-or-conflict';
  if ((code && digits >= 6) || (!units.length && digits >= 6) || (units.length && !portableUnits.length)) return 'card-coupled';
  return portableUnits.length ? 'portable' : 'practice';
}

test('独立规则核查 ≥10% 分层抽样（≥ 54 条），归类分歧率 ≤ 10%，可移植量的值与单位能在原文里找到', (t) => {
  const textOf = new Map();
  for (const e of priors.filter((p) => !isSummary(p))) {
    const [labels, ...rest] = e.provenance.note.split('。');
    textOf.set(e.id, { text: rest.join('。'), ev: labels.match(/原证据：(.*?)；/)[1] });
  }
  for (const e of cardPriors) textOf.set(e.id, { text: e.text, ev: e.evidenceLabel });
  for (const e of practices) textOf.set(e.id, { text: e.text, ev: e.evidenceLabel });
  const excluded = new Map(manifest.excluded.map((x) => [x.sourceId, { text: x.text, ev: x.evidenceLabel }]));

  const details = manifest.ledger.filter((r) => r.kind === 'detail');
  const byRoute = Object.groupBy(details, (r) => r.route);
  const sample = [];
  for (const rows of Object.values(byRoute)) {
    const take = Math.max(Math.min(5, rows.length), Math.ceil(rows.length * 0.15));
    const step = rows.length / take;
    for (let i = 0; i < take; i += 1) sample.push(rows[Math.floor(i * step)]);
  }
  assert.ok(sample.length >= 54, `抽样 ${sample.length} 条`);

  const disagree = sample.filter((r) => {
    const src = r.targets.length ? textOf.get(r.targets[0]) : excluded.get(r.sourceId);
    return independentRoute(src.text, src.ev) !== r.route;
  });
  t.diagnostic(`抽样 ${sample.length}/${details.length} 条明细，分歧 ${disagree.length}${disagree.length ? `（${disagree.map((r) => r.sourceId).join(',')}）` : ''}`);
  assert.ok(disagree.length / sample.length <= 0.1, `分歧 ${disagree.length}/${sample.length}：${disagree.map((r) => r.sourceId).join(',')}`);

  const unitText = { LUFS: /LUFS/, LU: /LU|LRA/, dBTP: /dBTP/, dB: /dB/, Hz: /Hz/, ms: /ms/, s: /\d\s*s(?![A-Za-z])|秒/, fps: /fps/, frame: /帧/, ratio: /%/ };
  const sampledPriors = sample.filter((r) => r.route === 'portable').flatMap((r) => r.targets);
  for (const id of sampledPriors) {
    const e = priors.find((p) => p.id === id);
    const { text } = textOf.get(id);
    assert.match(text, unitText[e.unit], id);
    const first = typeof e.value === 'number' ? e.value : Object.values(e.value)[0];
    const shown = [first, first * 100, first / 1000].map((x) => String(Math.abs(Math.round(x * 1e6) / 1e6)));
    assert.ok(shown.some((s) => text.includes(s)), `${id} 的值 ${first} 不在原文里`);
  }
});
