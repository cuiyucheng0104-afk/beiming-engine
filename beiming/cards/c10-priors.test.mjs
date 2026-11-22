import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadAudioSubsPriorsStore,
  getAudioSubsCardPriors,
  getAudioSubsPractices,
  getAudioSubsMigrationManifest,
} from './priors-audio-subs.mjs';
import * as cards from './index.mjs';
import { PRIOR_UNITS, createPriorsStore, scanPriorLeaks, validatePriorsTable } from './priors.mjs';

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
  assert.ok(store.stats().detailCount > 30);
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

// 原作名、角色名、地名、曲名、人名的 sha256 前 16 位（名字本身不入库，免得测试文件自己泄露专名）。
const IP_HASHES = new Set(["86663a1dd8f6b661", "924493ee15e2a68c", "dd9ab072bf740423", "2bf84b0ad08b23b8", "f4a6923996dbeb19", "3f8f01ea269b6cfe", "ecc9bddb65dc4451", "1351704cdc4d32f8", "b6f6732db83b899a", "a590c43e71d44866", "8534cd0426607ce6", "c6661966bce79f30", "419a4461434283fd", "bb1d46105bd704dc", "f27354a69b790eda", "d0b3b3d6c6c14f17", "aa416dab2cc47c86", "1ae0552a12823c54", "98162a1e33275f16", "ff627719813c923a", "40a7e9acb06295d6", "6d588db5b668cf12", "c512ca0c5c1e71be", "f44b7e30470bbf28", "c34305e7b35f6f0b", "965b8a7ec4177224", "1e445d2d4b31efe2", "f1ed891245759d1c", "26dd587fdb6a290c", "ad21b547ce7162c5", "1dd31cd072fdd30f", "b3158331cecc3845", "b9b13e1cd77acbd7", "ee839bf111a7e47a", "aaa1073bd98fd4e7", "07f0bf736c13b81f", "9e70b33fe4edaf5b", "5032f1bea2401f8f", "d4fff627da31250b", "36997f035118cae8", "9fa9e239e047e205", "b1f49128310e2481", "eb7855e04a2006fd", "f5105c9ea0cd361b", "e5a6d6899f2e6e04", "14fc1fd907298aaa", "dc7a4a2cc7e36000", "0b2058635ba3d17f", "1f25b77eea9b8db1", "59ee9ed12f7822d8", "ed818ec233248ae6", "930eaf1684b953a9", "400e436ed3eb0252", "f09bfa2c3c7042e4", "0e377aac3a660698", "d544b0316e19a87b", "dd415e6f13d54a9b", "1fe8ba945043480d", "e5993ec06c2e0d77", "c26804e0eaf84a96", "3d8c28f257964498", "d7834604301b3e8a", "06f8e2ae03f7ec87", "84a6921827058d16", "196cecb58d133eb0", "fba3a504b35a8d53", "a276bb8a748ddb9c", "90dd5db3f1b09545", "42c0b79536f2e4ff", "a7fb0e02239ad9aa", "3e9fd6d71c87b1db", "d2e2586d773f54ee", "9e863d7b36ae5de1", "729090481f813e9e", "b02ea6fe7b71ccf7", "7e8672748ae4410e", "3f33cff3bab2bd6e", "3eef1f7226e1215e"]);

test('零原作 IP 名：拉丁 1–3 词组（拆驼峰）与汉字 2–5 字串都不命中专名黑名单', () => {
  const grams = new Set();
  for (const f of files) {
    const text = raw(f).replace(/['’]s\b/g, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    const words = text.match(/[a-z0-9]+/g) ?? [];
    words.forEach((_, i) => {
      for (let n = 1; n <= 3 && i + n <= words.length; n += 1) grams.add(words.slice(i, i + n).join(' '));
    });
    for (const run of text.match(/[一-鿿]{2,}/g) ?? []) {
      for (let i = 0; i < run.length; i += 1) for (let n = 2; n <= 5 && i + n <= run.length; n += 1) grams.add(run.slice(i, i + n));
    }
  }
  const hit = [...grams].filter((g) => IP_HASHES.has(createHash('sha256').update(g).digest('hex').slice(0, 16)));
  assert.equal(hit.length, 0, `命中 ${hit.length} 个专名`);
});

test('零原包源码路径：四份 JSON 与加载器里没有 src/…、tools/… 或裸 *.js:行号 一类引用', () => {
  const pathRe = /\b(?:src|tools|scripts|app|packages)\/[A-Za-z0-9_./-]+\.(?:m?js|ts|py)\b/;
  const fileRe = /\b[\w-]+\.(?:m?js|cjs|ts|py|sh|glsl)\b(?::\d+)?/;
  const mediaRe = /\b[\w-]+\.(?:mp3|wav|m4a|mp4|mov)\b/;
  for (const f of files) {
    assert.doesNotMatch(raw(f), pathRe, f);
    assert.doesNotMatch(raw(f), fileRe, f);
    assert.doesNotMatch(raw(f), mediaRe, f);
  }
  const loader = readFileSync(new URL('./priors-audio-subs.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(loader, /lab:\/\/|\/Users\/|案例复刻库/);
});

// 一审指出的数值硬错误：期望值逐条从源文读出（小数、千分位、物理量对位），用精确相等比较，'3' 混不过 '3.9'。
const EXPECT = [
  ['audio-subs.e329.loudness-range', 3.9, 'LU'],
  ['audio-subs.e338.loudness-range', 1.1, 'LU'],
  ['audio-subs.e323.loudness-range', 6.4, 'LU'],
  ['audio-subs.e312.loudness-range', 2.3, 'LU'],
  ['audio-subs.e345.loudness-range', 6.8, 'LU'],
  ['audio-subs.e294.loudness-range', 2.6, 'LU'],
  ['audio-subs.e333.loudness-range', 1.6, 'LU'],
  ['audio-subs.e329.loudness', -8.7, 'LUFS'],
  ['audio-subs.sum.s10-t1-r03', -15.2, 'LUFS'],
  ['audio-subs.e451.pixels', [-10, 10], 'px'],
];

test('数值精确：小数不截断、千分位不吞、物理量不错配、px 量提取', () => {
  const store = loadAudioSubsPriorsStore();
  for (const [id, value, unit] of EXPECT) {
    const e = store.get(id);
    assert.ok(e, id);
    assert.equal(e.unit, unit, id);
    assert.deepEqual(e.value, value, id);
  }
  const all = [...priors, ...cardPriors, ...practices];
  // e299 是挂卡条目：5.97 s 时长要在，起点 173.2 s 不能当成可移植的时长。
  const tail = all.filter((e) => /\be299\b/.test(e.id));
  assert.ok(tail.some((e) => (e.quantities ?? [{ value: e.value, unit: e.unit }]).some((q) => q.unit === 's' && q.value === 5.97)), 'e299 5.97 s');
  const tailDur = store.get('audio-subs.e299.duration');
  if (tailDur) assert.equal(tailDur.value, 5.97);
  // 千分位：1,134 帧是 1134 帧（37.8 s × 30 fps），不是 134。
  const frames = all.filter((e) => /\be406\b/.test(e.id)).flatMap((e) => (e.unit ? [{ value: e.value, unit: e.unit }] : e.quantities ?? []));
  assert.ok(frames.some((q) => q.unit === 'frame' && q.value === 1134), 'e406 1134 frame');
  assert.ok(!frames.some((q) => q.value === 134), 'e406 不能出现 134');
  // 字幕量测带高 56 px 要能取到。
  const band = all.find((e) => /\be458\b/.test(e.id));
  assert.ok((band.quantities ?? [{ value: band.value, unit: band.unit }]).some((q) => q.unit === 'px' && q.value === 56), 'e458 56 px');
  // near=0.5 是无量纲输入，不能和 0.206 s 写成同一秒数区间。
  for (const e of all.filter((x) => /\be430\b/.test(x.id))) {
    for (const q of e.quantities ?? [{ value: e.value, unit: e.unit }]) {
      assert.ok(!(Array.isArray(q.value) && q.value.includes(0.5)), 'e430 不把 near=0.5 当秒');
    }
  }
  // 配乐时长冲突（请求 25 s、实际 42 s）不挂到首个重音 0.44 s 上。
  const accent = store.get('audio-subs.e400.duration');
  if (accent) for (const c of accent.conflicts ?? []) assert.notEqual(c.value, 25);
  // 响度汇总行的主值不取采样率。
  for (const e of priors.filter((p) => isSummary(p) && /响度/.test(p.title))) assert.notEqual(e.unit, 'Hz', e.id);
});

test('总账按源文自然行序排列，带源行号', () => {
  const lines = manifest.ledger.map((r) => r.sourceLine);
  assert.ok(lines.every((n) => Number.isSafeInteger(n) && n > 0));
  assert.deepEqual(lines, [...lines].sort((a, b) => a - b));
  assert.equal(new Set(lines).size, 540);
});

test('公开加载器把原文交给 C9：重复键在 loadAudioSubsPriorsStore 入口就被拦下', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c10-dupkey-'));
  try {
    cpSync(new URL('./priors.mjs', import.meta.url), join(dir, 'priors.mjs'));
    cpSync(new URL('./priors-audio-subs.mjs', import.meta.url), join(dir, 'priors-audio-subs.mjs'));
    const dup = priorsText.replace('{', '{\n  "format": "priors/0.1",');
    assert.notEqual(dup, priorsText);
    assert.equal(validatePriorsTable(dup).errors.some((e) => e.code === 'prior.duplicate-key'), true);
    cpSync(dataDir, join(dir, 'priors-data'), { recursive: true });
    writeFileSync(join(dir, 'priors-data', 'audio-subs.json'), dup);
    const mod = await import(pathToFileURL(join(dir, 'priors-audio-subs.mjs')).href);
    assert.throws(() => mod.loadAudioSubsPriorsStore(), /prior\.duplicate-key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => createPriorsStore(priorsText.replace('{', '{\n  "format": "priors/0.1",')), /prior\.duplicate-key/);
});

test('独立复核：≥ 10% 随机抽样（≥ 54 条明细）与总账去向分歧率 ≤ 10%', (t) => {
  const { audit } = manifest;
  const route = new Map(manifest.ledger.filter((r) => r.kind === 'detail').map((r) => [r.sourceId, r.route]));
  assert.equal(audit.sample.length, audit.sampleSize);
  assert.equal(new Set(audit.sample.map((s) => s.sourceId)).size, audit.sample.length);
  assert.ok(audit.sample.length >= 54, `抽样 ${audit.sample.length} 条`);
  assert.ok(audit.sample.length / manifest.totalSourceEntries >= 0.1);
  const disagree = audit.sample.filter((s) => {
    assert.ok(route.has(s.sourceId), s.sourceId);
    return route.get(s.sourceId) !== s.independentRoute;
  });
  t.diagnostic(`抽样 ${audit.sample.length}/${route.size} 条明细，分歧 ${disagree.length}（${disagree.map((s) => s.sourceId).join(',')}）`);
  assert.ok(disagree.length / audit.sample.length <= 0.1, `分歧 ${disagree.length}/${audit.sample.length}`);
});

test('可移植量的值精确出现在条目原文里（数值比较，不是子串）', () => {
  // 普通数与严格千分位（逗号三位组、前后不再接数字或逗号）都收；600,1040 这种列表按普通数拆开。
  const nums = (text) => {
    const t = text.replaceAll('−', '-');
    return [...t.matchAll(/-?\d+(?:\.\d+)?/g), ...t.matchAll(/(?<![\d,.])-?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\d,])/g)].map((m) => Number(m[0].replaceAll(',', '')));
  };
  const close = (a, b) => Math.abs(a - b) < 1e-9;
  for (const e of priors.filter((p) => !isSummary(p))) {
    const found = nums(e.provenance.note);
    const vals = typeof e.value === 'number' ? [e.value] : Array.isArray(e.value) ? e.value : [e.value.from, e.value.to];
    for (const v of vals) {
      // 换算口径：kHz→Hz（×1000）、百分数→ratio（×0.01）、±a→[−a, a]。
      const ok = found.some((n) => close(n, v) || close(n, -v) || close(n * 1000, v) || close(n / 100, v));
      assert.ok(ok, `${e.id} 的值 ${v} 不在原文里`);
    }
  }
});
