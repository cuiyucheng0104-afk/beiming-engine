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
const IP_HASHES = new Set(["86663a1dd8f6b661", "924493ee15e2a68c", "dd9ab072bf740423", "2bf84b0ad08b23b8", "f4a6923996dbeb19", "3f8f01ea269b6cfe", "ecc9bddb65dc4451", "1351704cdc4d32f8", "b6f6732db83b899a", "a590c43e71d44866", "8534cd0426607ce6", "c6661966bce79f30", "419a4461434283fd", "bb1d46105bd704dc", "f27354a69b790eda", "d0b3b3d6c6c14f17", "aa416dab2cc47c86", "1ae0552a12823c54", "98162a1e33275f16", "ff627719813c923a", "40a7e9acb06295d6", "6d588db5b668cf12", "c512ca0c5c1e71be", "f44b7e30470bbf28", "c34305e7b35f6f0b", "965b8a7ec4177224", "1e445d2d4b31efe2", "f1ed891245759d1c", "26dd587fdb6a290c", "ad21b547ce7162c5", "1dd31cd072fdd30f", "b3158331cecc3845", "b9b13e1cd77acbd7", "ee839bf111a7e47a", "aaa1073bd98fd4e7", "07f0bf736c13b81f", "9e70b33fe4edaf5b", "5032f1bea2401f8f", "d4fff627da31250b", "36997f035118cae8", "9fa9e239e047e205", "b1f49128310e2481", "eb7855e04a2006fd", "f5105c9ea0cd361b", "e5a6d6899f2e6e04", "14fc1fd907298aaa", "dc7a4a2cc7e36000", "0b2058635ba3d17f", "1f25b77eea9b8db1", "59ee9ed12f7822d8", "ed818ec233248ae6", "930eaf1684b953a9", "400e436ed3eb0252", "f09bfa2c3c7042e4", "0e377aac3a660698", "d544b0316e19a87b", "dd415e6f13d54a9b", "1fe8ba945043480d", "e5993ec06c2e0d77", "c26804e0eaf84a96", "3d8c28f257964498", "d7834604301b3e8a", "06f8e2ae03f7ec87", "84a6921827058d16", "196cecb58d133eb0", "fba3a504b35a8d53", "a276bb8a748ddb9c", "90dd5db3f1b09545", "42c0b79536f2e4ff", "a7fb0e02239ad9aa", "3e9fd6d71c87b1db", "d2e2586d773f54ee", "9e863d7b36ae5de1", "729090481f813e9e", "b02ea6fe7b71ccf7", "7e8672748ae4410e", "3f33cff3bab2bd6e", "3eef1f7226e1215e", "619df91bac841eda", "0b1df33ea7eef2b2", "ed4561f685f13353", "a819d7cd38e9101b", "c8b40f3f8920b8aa", "ca71d3ec52ddc852", "36ad0f15e388a8ce"]);

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
  // 带通配符的源码文件模式（music*.js）与「目录/文件.数据扩展名」形式的原实现相对路径（audio/tts_ready.json）。
  const globRe = /[\w-]*\*[\w*-]*\.(?:m?js|cjs|ts|py|sh|glsl)\b/;
  const dataPathRe = /\b[\w.-]+\/[\w*.-]+\.(?:json|ya?ml|tsv|csv|wav|mp3|ogg|flac)\b/;
  const dataFileRe = /(?<![\w.-])(?!audio-subs\.)[\w*-]+\.(?:json|ya?ml|tsv|csv)\b/; // 裸 events.json 一类；本库自己的 audio-subs.*.json 除外
  // 案例库内部的 .md 文档名与「下载/<指纹>/」「原文/」路径形态（三审）：出处只留中性类别（原文档:skill-spec 一类）。
  const docRe = /\.md\b|下载\/|原文\//;
  for (const f of files) {
    for (const re of [pathRe, fileRe, mediaRe, globRe, dataPathRe, dataFileRe, docRe]) assert.doesNotMatch(raw(f), re, f);
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
  // e299：5.97 s 段长要在，起点 173.2 s 不能当成时长（四审起它是可移植条目，起止时刻另有名字）。
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
    const vals = typeof e.value === 'number' ? [e.value] : Object.values(e.value);
    for (const v of vals) {
      // 换算口径：kHz→Hz（×1000）、百分数→ratio（×0.01）、±a→[−a, a]。
      const ok = found.some((n) => close(n, v) || close(n, -v) || close(n * 1000, v) || close(n / 100, v));
      assert.ok(ok, `${e.id} 的值 ${v} 不在原文里`);
    }
  }
});

// 二审（G_REV-R2）点名的物理量偏差：分数、跨量纲箭头、公式变量 px、时刻与时长、误差与 LRA、字幕淡入帧数。
test('物理量语义：分数按值算、MIDI→Hz 只取频率、px= 变量不当像素、时刻不叫时长', () => {
  const store = loadAudioSubsPriorsStore();
  const all = [...priors, ...cardPriors, ...practices];
  const qs = (sid) => all.filter((e) => e.id.split('.')[1] === sid && !isSummary(e))
    .flatMap((e) => e.quantities ?? [{ value: e.value, unit: e.unit }]);
  // 1/30 s 是 0.033333 s，不是 30 s。
  assert.ok(qs('e216').some((q) => q.unit === 's' && q.value === 0.033333), 'e216 1/30 s');
  assert.ok(!qs('e216').some((q) => q.value === 30), 'e216 不能出现 30 s');
  // MIDI 音符号 36、38 到频率的换算只取频率；距离 d≥300 到 2000 Hz 也只取频率。
  assert.ok(qs('e95').some((q) => q.unit === 'Hz' && q.value === 65.4), 'e95 65.4 Hz');
  assert.ok(qs('e116').some((q) => q.unit === 'Hz' && q.value === 73.4), 'e116 73.4 Hz');
  assert.ok(qs('e13').some((q) => q.unit === 'Hz' && q.value === 2000), 'e13 2000 Hz');
  const midi = (m) => 440 * 2 ** ((m - 69) / 12);
  for (const e of all) {
    for (const q of e.quantities ?? [{ value: e.value, unit: e.unit }]) {
      if (q.unit !== 'Hz' || q.value === null || typeof q.value !== 'object' || Array.isArray(q.value)) continue;
      assert.ok(Math.abs(midi(q.value.from) - q.value.to) > 0.01 * q.value.to, `${e.id} 把 MIDI 音符号当成 Hz 起点`);
    }
  }
  assert.ok(![300, 36, 38].some((v) => [...qs('e13'), ...qs('e95'), ...qs('e116')].some((q) => q.value?.from === v)));
  // px=clamp(...) 里的 px 是距离因子变量，420、1500 不是像素。
  assert.ok(!qs('e251').some((q) => q.unit === 'px'), 'e251 不出像素量');
  for (const e of all) if (/\bpx\s*=/.test(e.text ?? e.provenance?.note ?? '')) {
    assert.ok(!(e.quantities ?? [e]).some((q) => q.unit === 'px'), `${e.id} 把变量 px 当像素`);
  }
  // e352：5.48 s 是配乐起点，拉伸系数 1.009 与放慢量 0.009 分开。
  assert.equal(store.get('audio-subs.e352.duration'), undefined);
  for (const [id, value, unit] of [
    ['audio-subs.e352.start-offset', 5.48, 's'],
    ['audio-subs.e352.stretch-factor', 1.009, 'ratio'],
    ['audio-subs.e352.slowdown', 0.009, 'ratio'],
    ['audio-subs.e348.duration', 30.041, 's'],
    ['audio-subs.e348.event-time', 10, 's'],
    ['audio-subs.e422.loudnorm-error', 0.9, 'LU'],
    ['audio-subs.e422.event-time', 12, 's'],
    ['audio-subs.e367.event-time', 6.375, 's'],
    ['audio-subs.e288.event-time', 11.20169, 's'],
    ['audio-subs.e316.time-window', [0.3, 4.6], 's'],
    ['audio-subs.e316.analysis-frame', 40, 'ms'],
    ['audio-subs.e456.offset', [-0.4, 0.4], 's'],
    ['audio-subs.e455.fade-in-frames', { median: 1, min: 0, max: 19 }, 'frame'],
  ]) {
    const e = store.get(id);
    assert.ok(e, id);
    assert.equal(e.unit, unit, id);
    assert.deepEqual(e.value, value, id);
  }
  assert.equal(store.get('audio-subs.e422.loudness-range'), undefined, '单遍 loudnorm 误差不进 LRA');
  for (const sid of ['e348', 'e422', 'e367', 'e288', 'e316', 'e456', 'e311', 'e452']) {
    const d = store.get(`audio-subs.${sid}.duration`);
    if (sid !== 'e348') assert.equal(d, undefined, `${sid} 不是时长`);
  }
  // 时长不能是负数；按 frame 能查到字幕淡入耗时，汇总行也跟着给帧数。
  for (const e of priors.filter((p) => /\.duration$/.test(p.topic))) {
    assert.ok((typeof e.value === 'number' ? [e.value] : Object.values(e.value)).every((v) => v >= 0), e.id);
  }
  const fade = store.query({ unit: 'frame', caseId: 'case-18', includeSummaries: true }).map((e) => e.id);
  assert.ok(fade.includes('audio-subs.e455.fade-in-frames'));
  const sum = priors.find((p) => isSummary(p) && p.summaryOf.includes('audio-subs.e455.fade-in-frames'));
  assert.ok(sum && sum.unit === 'frame', 'e455 汇总行给帧数');
});

// 三审（G_REV-R3）：区域键、出处文件名、分析步长、随机区间算式、指定与实测时长口径、拍点汇总主值、两条归类边界。
const REGION_KEY_HASHES = new Set(['ed4561f685f13353', 'a819d7cd38e9101b', 'c8b40f3f8920b8aa', 'ca71d3ec52ddc852', '36ad0f15e388a8ce', 'dc8331bcb2283e89']);
const caseOf = (e) => e.caseId ?? e.provenance?.caseId;
const qsOf = (e) => e.quantities ?? [{ value: e.value, unit: e.unit }];

test('三审：案例 13 区域键全部换成中性区域编号，三张区域表编号一致', () => {
  const all = [...priors, ...cardPriors, ...practices];
  for (const e of all.filter((x) => caseOf(x) === 'case-13')) {
    const words = JSON.stringify(e).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z]+/g) ?? [];
    const hit = words.filter((w) => REGION_KEY_HASHES.has(createHash('sha256').update(w).digest('hex').slice(0, 16)));
    assert.deepEqual(hit, [], e.id);
  }
  const zones = (sid) => new Set(cardPriors.find((e) => e.sourceId === sid).text.match(/zone_\d\d/g));
  const [a, b, c] = ['e170', 'e187', 'e188'].map(zones);
  const shared = [...a].filter((z) => b.has(z) && c.has(z));
  assert.ok(shared.length >= 16, `三张表共有区域编号 ${shared.length}`);
  assert.doesNotMatch(cardPriors.find((e) => e.sourceId === 'e187').text, /zone_\d{3}/, '键名接数要隔开，zone_01 0 不能读成 zone_010');
  for (const e of all.filter((x) => caseOf(x) !== 'case-13')) assert.doesNotMatch(JSON.stringify(e), /zone_\d\d/, e.id);
});

test('三审：出处里的 .md 文件名归成中性类别', () => {
  const refs = [...cardPriors, ...practices].filter((e) => ['e416', 'e418', 'e255', 'e470'].includes(e.sourceId)).map((e) => e.docRef);
  assert.equal(refs.length, 4);
  for (const r of refs) assert.match(r, /原文档:(?:skill-spec|runtime-reading|integration-audit)/, r);
});

test('三审：分析步长、随机区间、指定与实测时长、A ± B 都按物理量取值', () => {
  const store = loadAudioSubsPriorsStore();
  for (const [id, value, unit] of [
    ['audio-subs.e297.duration', { median: 0.44, min: 0.25, max: 0.89 }, 's'],
    ['audio-subs.e297.analysis-step', 10, 'ms'],
    ['audio-subs.e349.duration', 25.051, 's'],
    ['audio-subs.e350.duration', 20.036, 's'],
    ['audio-subs.e352.analysis-lowpass', 150, 'Hz'],
    ['audio-subs.e353.intro-duration', 5.5, 's'],
    ['audio-subs.e0.autocorr-period', 0.8, 's'],
  ]) {
    const e = store.get(id);
    assert.ok(e, id);
    assert.equal(e.unit, unit, id);
    assert.deepEqual(e.value, value, id);
  }
  for (const gone of ['e352.frequency', 'e0.duration', 'e313.duration', 'e324.duration', 'e339.duration', 'e353.duration', 'e308.duration']) {
    assert.equal(store.get(`audio-subs.${gone}`), undefined, gone);
  }
  // 指定与实测并存时，.duration 一律取实测。
  for (const e of priors.filter((p) => !isSummary(p) && p.id.endsWith('.duration'))) {
    const m = e.provenance.note.match(/指定\s*([\d.]+)\s*s，\s*实测\s*([\d.]+)\s*s/);
    if (m) assert.equal(e.value, Number(m[2]), e.id);
  }
  // 12 + rnd × 8 s 是 [12, 20] s，基础 12、跨度 8；全表的随机区间都满足 max = base + jitter。
  const e163 = cardPriors.find((e) => e.sourceId === 'e163').quantities.find((q) => q.unit === 's');
  assert.deepEqual(e163, { value: [12, 20], unit: 's', rawUnit: 's', base: 12, jitter: 8 });
  const rnd = [...cardPriors, ...practices].flatMap((e) => e.quantities.filter((q) => 'jitter' in q));
  assert.ok(rnd.length >= 20, `随机区间 ${rnd.length} 个`);
  for (const q of rnd) assert.deepEqual(q.value, [q.base, Math.round((q.base + q.jitter) * 1e6) / 1e6]);
  assert.ok(!cardPriors.find((e) => e.sourceId === 'e163').quantities.some((q) => q.value === 8), 'e163 不再只给系数 8 s');
  // −14±0.3 LUFS 是 [−14.3, −13.7]，不是 [−0.3, 0.3]。
  const e290 = [...cardPriors, ...practices].find((e) => e.sourceId === 'e290');
  assert.ok(e290.quantities.some((q) => q.unit === 'LUFS' && q.value[0] === -14.3 && q.value[1] === -13.7));
});

test('三审：BPM 与拍点汇总主值取拍点类的量，主题随对照表所在节', () => {
  const beat = priors.filter((p) => isSummary(p) && p.title.includes('BPM 与拍点'));
  assert.ok(beat.length >= 5);
  for (const e of beat) {
    assert.ok(!['Hz', 'LUFS', 'LU', 'dBTP', 'dB'].includes(e.unit), `${e.id} ${e.unit}`);
    assert.match(e.topic, /^audio-subs\.beat-sync\./, e.id);
  }
  const s = (id) => priors.find((p) => p.id === id);
  assert.deepEqual([s('audio-subs.sum.s11-t1-r03').value, s('audio-subs.sum.s11-t1-r03').unit], [5.48, 's']);
  assert.deepEqual([s('audio-subs.sum.s11-t1-r10').value, s('audio-subs.sum.s11-t1-r10').unit], [12, 's']);
  assert.match(s('audio-subs.sum.s11-t1-r10').topic, /event-time$/);
});

test('三审：§8.1 两条边界——带实现参数表的源码条目挂卡、成片直接量出的读数可移植，汇总随明细', () => {
  const route = new Map(manifest.ledger.map((r) => [r.sourceId, r.route]));
  for (const id of ['e25', 'e24', 'e118', 'e133', 'e69', 'e310', 'e184', 'e207', 'e254', 'e3', 'e343', 'e257']) {
    assert.equal(route.get(id), 'card-coupled', id);
  }
  for (const id of ['e325', 'e327', 'e337', 'e378']) assert.equal(route.get(id), 'portable', id); // e304 十审改判挂卡，见文末
  assert.equal(route.get('sum.s01-t1-r09'), 'portable');
  for (const r of manifest.ledger.filter((x) => x.kind === 'summary')) assert.equal(r.route, route.get(r.summaryOf), r.sourceId);
  const sum = priors.find((p) => p.id === 'audio-subs.sum.s01-t1-r09');
  assert.deepEqual(sum.summaryOf, priors.filter((p) => p.id.startsWith('audio-subs.e378.')).map((p) => p.id));
  for (const id of ['e325', 'e337']) assert.ok(loadAudioSubsPriorsStore().get(`audio-subs.${id}.beat-interval`)?.unit === 'ms', id);
});

// 四审（G_REV-R4）：同一行多个随机算式、外层变量乘数、米制距离、年龄词误当秒数；§8.1 归类再收紧。
const coupledOrPractice = [...cardPriors, ...practices];
const quantitiesOf = (sid) => coupledOrPractice.find((e) => e.sourceId === sid).quantities;
const RAND_SRC = String.raw`(?:rnd|rand)(?:\^[\d.]+|²)?\s*[·×*]\s*`;
const NUM_SRC = String.raw`[−-]?\d*\.?\d+`;
const toNum = (s) => Number(s.replace('−', '-'));
const NUM_DOT_SRC = String.raw`[−+\-]?(?:\d+(?:\.\d+)?|\.\d+)`;
const RAND_CLASSIC = new RegExp(String.raw`(?<![\d.])(${NUM_DOT_SRC})\s*[+＋]\s*\(?\s*${RAND_SRC}(${NUM_DOT_SRC})(?![\d.])`, 'g');
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('四审：点名四条按源式取值（重置区间、外层乘数、距离区间、年龄词）', () => {
  // e163：同一个计时器先 12+rnd×8 s，触发后重置为 24+rnd×14，两段区间都要在。
  assert.deepEqual(quantitiesOf('e163').filter((q) => 'jitter' in q), [
    { value: [12, 20], unit: 's', rawUnit: 's', base: 12, jitter: 8 },
    { value: [24, 38], unit: 's', rawUnit: 's', base: 24, jitter: 14 },
  ]);
  // e115：creak·(0.6+rand·0.9) s 的上下界都乘 creak，不是无条件的 [0.6, 1.5] s。
  assert.deepEqual(quantitiesOf('e115').find((q) => q.base === 0.6), { value: [0.6, 1.5], unit: 's', rawUnit: 's', base: 0.6, jitter: 0.9, scaleBy: 'creak' });
  assert.ok(!quantitiesOf('e115').some((q) => !q.scaleBy && q.unit === 's' && q.value[0] === 0.6), 'e115 不给无条件秒数');
  // e271：雷声间隔 8+rand·12 s 与距离 1500+rand·3500 m 各一条，高度 +300 m 也在。
  const thunder = quantitiesOf('e271');
  assert.deepEqual(thunder.find((q) => q.base === 8), { value: [8, 20], unit: 's', rawUnit: 's', base: 8, jitter: 12 });
  assert.deepEqual(thunder.find((q) => q.unit === 'm' && 'jitter' in q), { value: [1500, 5000], unit: 'm', rawUnit: 'm', base: 1500, jitter: 3500 });
  assert.ok(thunder.some((q) => q.unit === 'm' && q.value === 300), 'e271 高度 300 m');
  // e392：early 30s 是年龄，不是 30 s；秒数只有语音窗、音乐窗与 2.6 s。
  assert.deepEqual(quantitiesOf('e392').filter((q) => q.unit === 's').map((q) => q.value), [[0, 2.6], [0, 10], 2.6]);
});

test('四审：全表带单位的随机算式一个不漏，外层乘数都标 scaleBy', () => {
  const unitOf = { s: 's', ms: 'ms', Hz: 'Hz', m: 'm', 音分: 'cent' };
  const rand = new RegExp(String.raw`(?:([A-Za-z_]\w*)\s*[·×*]\s*\(\s*)?(${NUM_SRC})\s*[+＋]\s*${RAND_SRC}(${NUM_SRC})\)?\s*(ms|s|Hz|m|音分)(?![A-Za-z/])`, 'g');
  let seen = 0;
  for (const e of coupledOrPractice) {
    for (const m of e.text.matchAll(rand)) {
      const [, scale, base, jitter, unit] = m;
      seen += 1;
      const hit = e.quantities.find((q) => q.unit === unitOf[unit] && near(q.base, toNum(base)) && near(q.jitter, toNum(jitter)));
      assert.ok(hit, `${e.sourceId} 漏了 ${m[0]}`);
      assert.equal(hit.scaleBy, scale, `${e.sourceId} ${m[0]} 的外层乘数`);
    }
    for (const q of e.quantities.filter((x) => x.scaleBy)) {
      // 变量名要在原文里贴着乘号；表达式乘数（vib[0]、1.7−0.22i、.63×(.7+.5g)）的每个因子都要是原文里的字面片段。
      // 六审：乘数写在算式后面的（rng()^1.3·earlySpan、(rand−0.5)·2·jit）乘号在变量左边；除数（(0.3+1.4rnd)/rate）记 1/rate，按 /rate 核对。
      if (/^[A-Za-z_]\w*$/.test(q.scaleBy)) assert.match(e.text, new RegExp(String.raw`(?<![A-Za-z0-9_])${q.scaleBy}\s*[·×*]|[·×*]\s*${q.scaleBy}(?![A-Za-z0-9_])`), `${e.sourceId} scaleBy=${q.scaleBy}`);
      else for (const f of q.scaleBy.split('×')) assert.ok(e.text.includes(f.replace(/^1(?=\/)/, '')), `${e.sourceId} scaleBy=${q.scaleBy} 的因子 ${f}`);
    }
  }
  assert.ok(seen >= 26, `带单位的随机算式 ${seen} 个`);
  // 没有自带单位、但能从上下文认出单位的三种写法：同一变量再次赋值、紧跟的括号变体、「A 与 B 单位」并列。
  assert.ok(quantitiesOf('e114').some((q) => q.unit === 's' && q.base === 12 && q.jitter === 18), 'e114 括号里的 12+rand·18 也是秒');
  assert.ok(quantitiesOf('e137').some((q) => q.unit === 'cent' && q.base === -9 && q.jitter === 3), 'e137 −9+rand×3 与 +7+rand×3 都是音分');
  assert.ok(quantitiesOf('e244').some((q) => q.unit === 'Hz' && q.value === 60 && q.scaleBy === 'rj'), 'e244 rj·60 Hz 带乘数');
});

test('四审：源文写了单位的量在产物里都有对应单位，年代与年龄词不当秒数', () => {
  const unitOf = { 'm/s': 'm/s', m: 'm', Hz: 'Hz', kHz: 'Hz', dB: 'dB', dBFS: 'dB', ms: 'ms', s: 's', LUFS: 'LUFS', BPM: 'bpm', bpm: 'bpm' };
  const age = /\b(?:early|mid|late)[ -]\d0s\b|(?<![\d.–~-])(?:19|20)\d0s\b/g;
  const stated = new RegExp(String.raw`(?<![A-Za-z0-9_.])\d+(?:\.\d+)?\s?(m\/s|kHz|Hz|dBFS|dB|ms|LUFS|BPM|bpm|s|m)(?![A-Za-z/])`, 'g');
  for (const e of coupledOrPractice) {
    const text = e.text.replace(age, ' ');
    const have = new Set(e.quantities.map((q) => q.unit));
    for (const m of text.matchAll(stated)) {
      if (/\bpx\s*=/.test(text) && m[1] === 'px') continue;
      assert.ok(have.has(unitOf[m[1]]), `${e.sourceId} 写了「${m[0]}」，产物里没有 ${unitOf[m[1]]} 的量`);
    }
    for (const m of e.text.matchAll(age)) {
      const n = Number(m[0].match(/\d+/)[0]);
      assert.ok(!e.quantities.some((q) => q.unit === 's' && q.value === n), `${e.sourceId} 把「${m[0]}」当成 ${n} s`);
    }
  }
  // 等号右边带单位的量、逗号元组里的量、同质频率列表都要取到。
  assert.ok(quantitiesOf('e149').some((q) => q.unit === 's' && q.value === 4) && quantitiesOf('e149').some((q) => q.unit === 's' && q.value === 20), 'e149 dwell=4 s、gap=20 s');
  assert.ok(quantitiesOf('e180').filter((q) => q.unit === 'Hz' && [110, 145].includes(q.value)).length >= 4, 'e180 鼓点元组里的 110/145 Hz');
  assert.deepEqual(quantitiesOf('e284').filter((q) => q.unit === 'Hz').slice(0, 4).map((q) => q.value), [98, 147, 233, 392], 'e284 金属簇四个频率');
  assert.ok(quantitiesOf('e261').some((q) => q.unit === 'm/s' && q.value === 343), 'e261 声速 343 m/s');
  for (const e of coupledOrPractice.filter((x) => /near=0\.5/.test(x.text))) assert.ok(!e.quantities.some((q) => q.value === 0.5 || q.value?.from === 0.5), 'near=0.5 仍不当秒');
});

test('四审：§8.1 再收紧——实现或片内固定配置挂卡、成片量出的读数可移植、空泛一句话不迁', () => {
  const route = new Map(manifest.ledger.map((r) => [r.sourceId, r.route]));
  for (const id of ['e9', 'e126', 'e134', 'e190', 'e290', 'e390', 'e370', 'sum.s01-t1-r06']) assert.equal(route.get(id), 'card-coupled', id);
  for (const id of ['e299', 'e400', 'sum.s11-t1-r08']) assert.equal(route.get(id), 'portable', id);
  assert.equal(route.get('e411'), 'skipped-or-conflict');
  const store = loadAudioSubsPriorsStore();
  assert.deepEqual([store.get('audio-subs.e299.duration').value, store.get('audio-subs.e299.duration').unit], [5.97, 's']);
  assert.deepEqual([store.get('audio-subs.e400.event-time').value, store.get('audio-subs.e400.event-time').unit], [0.44, 's']);
  assert.deepEqual(priors.find((p) => p.id === 'audio-subs.sum.s11-t1-r08').summaryOf, priors.filter((p) => p.id.startsWith('audio-subs.e400.')).map((p) => p.id));
  // 做法表里不留没有步骤、判据、参数的空泛短句。
  for (const e of practices) assert.ok(e.text.length >= 20 || e.quantities.length > 0, `${e.sourceId} 只有一句概述`);
});

test('四审：独立盲判覆盖全部明细，任取随机种子抽 ≥ 10%（54 明细 + 13 汇总）分歧都不超一成', (t) => {
  const { audit, ledger } = manifest;
  const details = ledger.filter((r) => r.kind === 'detail');
  const summaries = ledger.filter((r) => r.kind === 'summary');
  const independent = new Map(audit.sample.map((s) => [s.sourceId, s.independentRoute]));
  assert.deepEqual([...independent.keys()].sort(), details.map((r) => r.sourceId).sort(), '盲判一条不缺');
  const route = new Map(ledger.map((r) => [r.sourceId, r.route]));
  const differs = (r) => independent.get(r.summaryOf ?? r.sourceId) !== route.get(r.sourceId); // 汇总行的独立去向随它指回的明细
  assert.deepEqual(audit.disagreements, details.filter(differs).map((r) => r.sourceId));
  const total = ledger.filter(differs).length;
  assert.ok(total / ledger.length < 0.06, `全表分歧 ${total}/${ledger.length}`);
  // 固定算法的伪随机（mulberry32）：200 组种子各按源文行序无放回抽 54 条明细、13 条汇总。
  const rng = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const draw = (pool, n, rand) => {
    const a = [...pool];
    for (let i = 0; i < n; i += 1) {
      const j = i + Math.floor(rand() * (a.length - i));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, n);
  };
  let worst = 0;
  for (let seed = 1; seed <= 200; seed += 1) {
    const rand = rng(Math.imul(seed, 0x9e3779b1));
    const picked = [...draw(details, 54, rand), ...draw(summaries, 13, rand)];
    const n = picked.filter(differs).length;
    worst = Math.max(worst, n);
    assert.ok(n / picked.length <= 0.1, `种子 ${seed}：分歧 ${n}/${picked.length}`);
  }
  t.diagnostic(`全表分歧 ${total}/${ledger.length}；200 组种子里最差一组 ${worst}/67；四审前旧样本 ${audit.legacy.disagreements.length}/${audit.legacy.sampleSize}（旧口径，只记数）`);
});

test('五审：正写随机算式与带 jitter 的量一一对应，上下文定单位的 12 个逐个核对', () => {
  // 正写的 A + rnd × B（含幂次、省略前导零的 .07+rnd×.05），单位贴不贴着都算：五审时全表 41 个，分在 20 条里。
  const expr = RAND_CLASSIC;
  const key = (base, jitter) => `${Math.round(base * 1e6)}+${Math.round(jitter * 1e6)}`;
  let exprs = 0;
  let entries = 0;
  for (const e of coupledOrPractice) {
    const want = [...e.text.matchAll(expr)].map((m) => key(toNum(m[1]), toNum(m[2])));
    // 六审起，正写以外的写法也出 base/jitter，那些量带 expr（算式原文），在下面的六审测试里对。
    const have = e.quantities.filter((q) => 'jitter' in q && !q.expr).map((q) => key(q.base, q.jitter));
    assert.deepEqual(have.sort(), want.sort(), `${e.sourceId} 的随机算式与 base/jitter 没有一一对上`);
    exprs += want.length;
    entries += want.length > 0;
  }
  assert.ok(exprs >= 41 && entries >= 20, `正写随机算式 ${exprs} 个，分在 ${entries} 条里`);
  for (const p of priors) assert.equal(p.provenance.note.match(expr), null, `${p.id}：带随机算式的条目都在挂卡与做法里，可移植条目没有 quantities 可对`);
  // 没贴单位的 12 个：单位读上下文定（基频 Hz、起点 s、detune 音分，rate、vel、增益与幅度系数无量纲记 ratio），外层乘数记 scaleBy。
  const context = [
    ['e35', 0.035, 0.02, 's'], ['e38', 1300, 300, 'Hz'], ['e40', 0.38, 0.02, 's'], ['e40', 700, 700, 'Hz'], ['e41', 640, 120, 'Hz'],
    ['e114', 0.9, 0.15, 'ratio'], ['e139', 5, 2, 'cent'], ['e139', 0.25, 0.75, 'ratio'], ['e165', 0.07, 0.05, 'ratio'],
    ['e169', 0.3, 0.2, 'ratio', '.63×(.7+.5g)'], ['e271', 0.7, 0.5, 'ratio', '1.7−0.22i'], ['e428', 0.95, 0.1, 'Hz', 'vib[0]'],
  ];
  for (const [sid, base, jitter, unit, scaleBy] of context) {
    const hit = quantitiesOf(sid).filter((q) => q.base === base && q.jitter === jitter);
    assert.equal(hit.length, 1, `${sid} ${base}+rand×${jitter}`);
    assert.deepEqual([hit[0].value, hit[0].unit, hit[0].scaleBy], [[base, Math.round((base + jitter) * 1e6) / 1e6], unit, scaleBy], `${sid} ${base}+rand×${jitter}`);
  }
  // 五审点名三例，从公开入口按卡读。
  const byCard = (cardId, sid) => getAudioSubsCardPriors(cardId).find((e) => e.sourceId === sid).quantities.filter((q) => 'jitter' in q);
  assert.deepEqual(byCard('audio.sfx-bank', 'e40').find((q) => q.unit === 'Hz'), { value: [700, 1400], unit: 'Hz', rawUnit: 'Hz', base: 700, jitter: 700 });
  assert.deepEqual(byCard('audio.sfx-bank', 'e41'), [{ value: [640, 760], unit: 'Hz', rawUnit: 'Hz', base: 640, jitter: 120 }]);
  assert.deepEqual(byCard('audio.voice-synth', 'e428').filter((q) => !q.expr), [{ value: [0.95, 1.05], unit: 'Hz', rawUnit: 'Hz', base: 0.95, jitter: 0.1, scaleBy: 'vib[0]' }]);
});

test('五审：按画面帧号放音效的做法留在做法表，点名的三条边界随终审裁定', () => {
  const route = new Map(manifest.ledger.map((r) => [r.sourceId, r.route]));
  assert.equal(getAudioSubsPractices().filter((e) => e.sourceId === 'e331').length, 1);
  for (const id of ['e331', 'sum.s01-t1-r04', 'e351', 'sum.s01-t1-r13']) assert.equal(route.get(id), 'practice', id);
  for (const id of ['e359', 'sum.s04-t1-r06', 'e215']) assert.equal(route.get(id), 'card-coupled', id);
  assert.ok(!manifest.excluded.some((x) => x.sourceId === 'e331'), 'e331 不在不迁表里');
  // e351 的母带目标仍可从做法条目的 quantities 读到。
  assert.ok(quantitiesOf('e351').some((q) => q.unit === 'LUFS' && q.value === -14) && quantitiesOf('e351').some((q) => q.unit === 'dBTP' && q.value === -1));
});

// 六审（G_REV-R6）：正写以外的随机写法也要出结构化区间——倒写（0.15+0.05·rand）、省略系数（0.15+rand²）、
// 中心化（(rnd−0.5)×0.05）、纯幂次（rand³·0.6）、除法（(0.3+1.4rnd)/rate）、紧贴数字（.4rand），
// 以及同一类的调用写法 r()、rng()、Math.random()、随机(−1,1)。这些量带 expr（算式原文）与 label（它是什么）。
const RAND_TOKEN = /(?<![A-Za-z_])(?:(?:rand|rnd)(?![A-Za-z])|rng\(\)|r\(\)|Math\.random\(\)|随机\()/g;
const spansOf = (text, needle) => {
  const out = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) out.push([i, i + needle.length]);
  return out;
};

test('六审：全表每个随机记号都有结构化区间，或登记在清单的例外表里', (t) => {
  const skipped = manifest.rules.randomNotStructured;
  assert.ok(Array.isArray(skipped), '清单要列出不出区间的随机写法与理由');
  let tokens = 0;
  let structured = 0;
  for (const e of coupledOrPractice) {
    const skips = skipped.filter((s) => s.sourceId === e.sourceId);
    const withExpr = e.quantities.filter((q) => q.expr);
    for (const q of withExpr) {
      assert.ok(e.text.includes(q.expr), `${e.sourceId} 的 expr「${q.expr}」不是原文片段`);
      assert.ok(typeof q.label === 'string' && q.label.length >= 2, `${e.sourceId} ${q.expr} 要有 label`);
    }
    const cover = [
      ...[...e.text.matchAll(RAND_CLASSIC)].map((m) => [m.index, m.index + m[0].length]),
      ...withExpr.flatMap((q) => spansOf(e.text, q.expr)),
      ...skips.flatMap((s) => spansOf(e.text, s.expr)),
    ];
    const found = [...e.text.matchAll(RAND_TOKEN)];
    for (const m of found) {
      assert.ok(cover.some(([a, b]) => a <= m.index && m.index < b), `${e.sourceId} 的随机量「${e.text.slice(Math.max(0, m.index - 14), m.index + 18)}」没有结构化区间`);
    }
    const jitters = e.quantities.filter((q) => 'jitter' in q).length;
    // 一个随机记号一条区间：既不漏，也不把同一个算式拆成两条。
    assert.equal(found.length, jitters + skips.length, `${e.sourceId}：随机记号 ${found.length} 个，区间 ${jitters} 条，例外 ${skips.length} 个`);
    tokens += found.length;
    structured += jitters;
  }
  for (const s of skipped) {
    const e = coupledOrPractice.find((x) => x.sourceId === s.sourceId);
    assert.ok(e && e.text.includes(s.expr) && s.expr.match(RAND_TOKEN) && s.reason.length >= 6, `例外 ${s.sourceId} ${s.expr}`);
  }
  assert.ok(skipped.length <= 4, `例外只留指数写法、生成器定义与没给范围的，现有 ${skipped.length} 个`);
  for (const p of priors) assert.equal(p.provenance.note.match(RAND_TOKEN), null, `${p.id}：可移植条目里不该有随机算式`);
  t.diagnostic(`随机记号 ${tokens} 个：结构化区间 ${structured} 条，例外 ${skipped.length} 个`);
});

// 十审（G_REV-R10）校准后新挂卡的 8 条与各自的卡；其中 4 条不随所在节的默认卡，登记在清单的 cardOverrides。
const R11_CARDS = {
  e304: 'audio.voice-synth', e306: 'audio.voice-synth', e308: 'audio.voice-synth', e467: 'time.narration',
  e436: 'audio.sfx-bank', e395: 'audio.event-mix', e376: 'audio.scene-events', e383: 'audio.scene-events',
};
const R11_CARD_OVERRIDES = { e436: 'audio.sfx-bank', e395: 'audio.event-mix', e376: 'audio.scene-events', e383: 'audio.scene-events' };

// 七审（G_REV-R7）：点名 11 条从公开入口按指定的卡读；卡挂错了，按卡检索就是空。
const NAMED_CARD = {
  e32: 'audio.dsp', e42: 'audio.sfx-bank', e54: 'audio.voice-synth', e98: 'audio.sfx-bank', e112: 'audio.sfx-bank', e134: 'audio.music-seq',
  e156: 'audio.sfx-bank', e230: 'audio.sfx-bank', e250: 'audio.sfx-bank', e259: 'audio.sfx-bank', e428: 'audio.voice-synth',
};
const namedQuantities = (sid) => {
  const hit = getAudioSubsCardPriors(NAMED_CARD[sid]).filter((e) => e.sourceId === sid);
  assert.equal(hit.length, 1, `${sid} 要能从 ${NAMED_CARD[sid]} 读到`);
  return hit[0].quantities;
};

test('六审：点名 11 条与同类调用写法逐条按源式取区间', () => {
  // [区间, 单位, 外层乘数]；按原文出现的先后。区间 = 随机数取 0 与 1 时算式的两端。
  const want = {
    e32: [[[0.3, 1], 'ratio', 'amp']], // amp·(0.3+0.7·rand²)
    e42: [[[0, 0.6], 'ratio']], // 幅度 rand³·0.6
    e54: [[[0.15, 0.2], 's']], // 时长 (0.15+0.05·rand)
    e98: [[[0, 0.6], 's', '时长']], // 起点 = (近0.05/远0.3) + rand^1.5·0.6·时长
    e112: [[[0.15, 1.15], 'ratio']], // 幅度 0.15+rand²
    e134: [[[-0.025, 0.025], 'ratio']], // (rnd−0.5)×0.05
    e156: [[[0.06, 0.1], 'ratio']], // vel .1×(.6+.4rand)
    e230: [[[0.3, 1.7], 's', '1/rate']], // (0.3+1.4rnd)/rate
    e250: [[[0.25, 2.85], 's']], // 0.25+2.6·rnd^1.4
    e259: [[[0, 1], 'ratio'], [[-0.8, 0.8], 'ratio'], [[0, 1], 's', 'max(0,时长−0.5)']], // rnd^1.6、rnd·1.6−0.8、Math.random()·max(0,时长−0.5)
    e428: [[[-1, 1], 'ratio', 'jit']], // 1+(rand−0.5)·2·jit：jit 是说话人参数，原文没有默认值
    e19: [[[0, 1], 's', 'earlySpan'], [[0.5, 1], 'ratio', '(0.9−0.6·t/(earlySpan+pre))']],
    e24: [[[-1, 1], 'ratio']], // 白噪 r()*2−1
    e90: [[[850, 1050], 'Hz'], [[0.035, 0.055], 's']],
    e91: [[[330, 420], 'Hz']],
    e92: [[[290, 350], 'Hz'], [[760, 900], 'Hz'], [[0.32, 0.37], 's'], [[1350, 1550], 'Hz'], [[2050, 2170], 'Hz']],
    e94: [[[2, 3], 'count'], [[0.18, 0.28], 's'], [[470, 560], 'Hz'], [[0.14, 0.26], 's']], // 叫声次数是整数个数，不是比例（七审）
    e103: [[[3.1, 4.1], 'ms']],
    e137: [[[-1, 1], 'cent']], // detune ±随机(−1,1)
    e229: [[[0.98, 1.02], 'Hz', '61×1.205^k']], // 61×1.205^k×(1+(rnd−0.5)×0.04)
  };
  for (const [sid, rows] of Object.entries(want)) {
    const got = (NAMED_CARD[sid] ? namedQuantities(sid) : quantitiesOf(sid)).filter((q) => q.expr && 'jitter' in q);
    assert.ok(got.length > 0, `${sid} 的 quantities 里要有随机区间`);
    assert.deepEqual(got.map((q) => [q.value, q.unit, ...(q.scaleBy ? [q.scaleBy] : [])]), rows, sid);
    for (const q of got) assert.deepEqual(q.value, [q.base, Math.round((q.base + q.jitter) * 1e6) / 1e6], `${sid} ${q.expr}`);
  }
  assert.deepEqual(coupledOrPractice.filter((e) => e.quantities.some((q) => q.expr)).map((e) => e.sourceId).sort(), Object.keys(want).sort(), '带 expr 的条目就是上面这些');
  // 六审的最小复现：从公开入口按卡读 e32。
  const e32 = getAudioSubsCardPriors('audio.dsp').find((e) => e.sourceId === 'e32').quantities;
  assert.equal(e32.length, 1);
  assert.deepEqual({ ...e32[0], label: undefined }, { value: [0.3, 1], unit: 'ratio', rawUnit: '无量纲', base: 0.3, jitter: 0.7, scaleBy: 'amp', expr: '0.3+0.7·rand²', label: undefined });
  // e54 原有的辅音与停顿常量还在；e98 两种基础起点另记成标量；e428 的颤音频率不动，音高抖动注明 jit 是参数。
  for (const v of [0.035, 0.05, 0.22, 0.42]) assert.ok(quantitiesOf('e54').some((q) => q.unit === 's' && q.value === v), `e54 ${v} s`);
  assert.deepEqual(quantitiesOf('e98').filter((q) => q.expr && !('jitter' in q)).map((q) => [q.value, q.unit]), [[0.05, 's'], [0.3, 's']]);
  assert.match(quantitiesOf('e428').find((q) => q.scaleBy === 'jit').label, /jit=0\.1.*0\.9.*1\.1/);
  // 对数均匀的两处（1500·5^rand、1900×5.6^((p+rnd)/96)）不出 base/jitter，原文写明的区间仍是一条量。
  assert.ok(quantitiesOf('e42').some((q) => q.unit === 'Hz' && q.value[0] === 1500 && q.value[1] === 7500));
  assert.ok(quantitiesOf('e228').some((q) => q.unit === 'Hz' && q.value[0] === 1900 && q.value[1] === 10640));
});

test('七审：离散个数记 count，点名五条挂到功能对应的卡并登记在清单', () => {
  const calls = getAudioSubsCardPriors('audio.sfx-bank').find((e) => e.sourceId === 'e94').quantities.filter((q) => q.unit === 'count');
  assert.deepEqual(calls, [{ value: [2, 3], unit: 'count', rawUnit: '次', base: 2, jitter: 1, expr: '2+floor(r()·2)', label: calls[0]?.label }]);
  for (const e of coupledOrPractice) for (const q of e.quantities) {
    // 取整的随机算式出的是个数；个数的两端都是整数。
    if (q.expr && /floor|ceil|round/.test(q.expr)) assert.equal(q.unit, 'count', `${e.sourceId} ${q.expr}`);
    if (q.unit === 'count') assert.ok([q.value].flat().every(Number.isInteger), `${e.sourceId} ${q.expr ?? q.value}`);
  }
  const moved = { e134: 'audio.music-seq', e156: 'audio.sfx-bank', e230: 'audio.sfx-bank', e250: 'audio.sfx-bank', e259: 'audio.sfx-bank' };
  for (const [sid, cardId] of Object.entries(moved)) {
    assert.equal(cardPriors.find((e) => e.sourceId === sid).cardId, cardId, sid);
    assert.equal(getAudioSubsCardPriors('audio.music-gen').filter((e) => e.sourceId === sid).length, 0, `${sid} 不再挂配乐生成卡`);
  }
  // 十审又按功能挂了四条（R11_CARD_OVERRIDES，见文末），清单里两批都登记。
  assert.deepEqual(Object.fromEntries(manifest.cardOverrides.map((o) => [o.sourceId, o.cardId])), { ...moved, ...R11_CARD_OVERRIDES });
  for (const o of manifest.cardOverrides) assert.ok(o.sectionCard !== o.cardId && o.reason.length >= 6, o.sourceId);
  for (const o of manifest.cardOverrides.filter((x) => x.sourceId in moved)) assert.equal(o.sectionCard, 'audio.music-gen', o.sourceId);
  for (const sid of Object.keys(NAMED_CARD)) assert.ok(namedQuantities(sid).some((q) => 'jitter' in q), sid);
});

// 八审（G_REV-R8）：总账的挂卡行直接带目标卡 target，不用再拿 targets 里的条目 ID 去查；
// 龙战时压低配乐是混音动作，跟同名的区域键不是一回事，不套区域编号。
test('八审：总账挂卡行带直读目标卡 target，龙战配乐压低不写成区域编号', () => {
  const byId = new Map(cardPriors.map((e) => [e.id, e]));
  const cardOf = new Map(cardPriors.map((e) => [e.sourceId, e.cardId]));
  const coupled = manifest.ledger.filter((r) => r.route === 'card-coupled');
  const detail = coupled.filter((r) => r.kind === 'detail');
  assert.equal(detail.length, 309); // 十审校准后 301 + 8
  for (const r of detail) {
    assert.ok(typeof r.target === 'string' && r.target.length > 0, `${r.sourceId} 缺 target`);
    assert.equal(r.target, byId.get(r.targets[0]).cardId, r.sourceId);
    assert.ok(getAudioSubsCardPriors(r.target).some((e) => e.sourceId === r.sourceId), `${r.sourceId} 按 target 从公开入口查不到`);
  }
  const summary = coupled.filter((r) => r.kind === 'summary');
  assert.equal(summary.length, 74); // 十审校准后 68 + 6
  for (const r of summary) assert.equal(r.target, cardOf.get(r.summaryOf), r.sourceId); // 汇总行只指回一条明细，目标卡跟它
  for (const [sid, cardId] of Object.entries(NAMED_CARD)) assert.equal(manifest.ledger.find((r) => r.sourceId === sid).target, cardId, sid);

  const text = (sid) => cardPriors.find((e) => e.sourceId === sid).text;
  for (const sid of ['e150', 'e185']) {
    assert.doesNotMatch(text(sid), /zone_18/, sid);
    assert.match(text(sid), /龙战配乐压低/, sid);
  }
  assert.match(text('e150'), /龙战配乐压低闪避拉到0\.03 0\.12 s降、结束后0\.3–0\.35 s/); // 数值原样
  assert.match(text('e185'), /龙战配乐压低到0\.03 0\.12 s入0\.3–0\.35 s出/);
  for (const f of files) assert.doesNotMatch(raw(f), /(?:dragon|龙)zone_18/u, f);
  // 三张区域表不受影响：18 个区域键、56 处映射。
  const zones = ['e170', 'e187', 'e188'].flatMap((sid) => text(sid).match(/zone_\d\d/g));
  assert.deepEqual([new Set(zones).size, zones.length], [18, 56]);
});

// 九审（G_REV-R9）：变量名 s01 的首字母不是秒。单位后面紧跟数字或下划线的是标识符（0.3s01、0.25s01），不出量。
test('九审：e64 的 0.3s01、0.25s01 是算式里的变量，不记成秒', () => {
  const e64 = getAudioSubsCardPriors('audio.event-mix').find((x) => x.sourceId === 'e64');
  assert.match(e64.text, /0\.8\+0\.3s01.*0\.75\+0\.25s01.*s01=\(speed−0\.4\)\/1\.4/); // 正文算式原样
  const has = (value, unit) => e64.quantities.some((q) => q.value === value && q.unit === unit);
  assert.ok(!has(0.3, 's') && !has(0.25, 's'), JSON.stringify(e64.quantities.slice(0, 3)));
  assert.ok(has(2.6, 's'), '真实时长 2.6 s 要留着');
  assert.deepEqual(
    e64.quantities.map((q) => [q.value, q.unit]),
    [[2.6, 's'], [0.03, 's'], [3.2, 's'], [0.97, 's'], [0.12, 'ratio'], [[40, 70], 's'], [0.035, 's']],
  );
  // 全表没有别的量是从「单位紧跟数字或下划线」的标识符里抽出来的：除 e64.quantities 外，挂卡表与上一版（4e68d78）逐字相同。
  // 十审校准新挂卡的 8 条（R11_CARDS）不算在内：原有 301 条一字未动。
  const rest = cardPriors.filter((e) => !(e.sourceId in R11_CARDS)).map((e) => (e.sourceId === 'e64' ? { ...e, quantities: null } : e));
  assert.equal(rest.length, 301);
  assert.equal(createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 16), '04e295e02cd6b342');
});

// 十审（G_REV-R10）：九审、十审两次独立抽检点名的边界条目按判定校准去向，汇总行跟着所指明细。
test('十审：合成器内部参数、声源倍率、事件清单与交接协议挂卡，元音占比可移植，分工与声画对位归做法', () => {
  const row = new Map(manifest.ledger.map((r) => [r.sourceId, r]));
  for (const [sid, cardId] of Object.entries(R11_CARDS)) {
    assert.deepEqual([row.get(sid).route, row.get(sid).target], ['card-coupled', cardId], sid);
    assert.equal(getAudioSubsCardPriors(cardId).filter((e) => e.sourceId === sid).length, 1, `${sid} 要能从 ${cardId} 读到`);
  }
  const sums = { 'sum.s07-t2-r02': 'e304', 'sum.s07-t2-r04': 'e306', 'sum.s07-t2-r06': 'e308', 'sum.s13-t1-r02': 'e467', 'sum.s01-t1-r10': 'e376', 'sum.s01-t1-r11': 'e383' };
  for (const [sid, ref] of Object.entries(sums)) {
    const r = row.get(sid);
    assert.deepEqual([r.summaryOf, r.route, r.target, r.targets], [ref, 'card-coupled', R11_CARDS[ref], []], sid);
  }
  const q = (sid) => getAudioSubsCardPriors(R11_CARDS[sid]).find((e) => e.sourceId === sid).quantities.map((x) => [x.value, x.unit]);
  assert.deepEqual(q('e304'), [[0.004, 'ratio'], [0.03, 'ratio']]); // 指定声带脉冲模型的抖动 0.4%、闪烁 3%
  assert.deepEqual(q('e308'), [[0.36, 's']]); // 该合成器触发吸气的停顿阈值
  assert.deepEqual(q('e306'), [[11500, 'Hz']]); // 固定极点到 11.5 kHz
  assert.deepEqual(q('e436'), [[[-0.06, 0.06], 'ratio']]); // 整条音高线 ×(1±6%)
  assert.deepEqual(q('e395'), [[120, 'bpm']]);
  assert.ok(q('e467').some(([v, u]) => v === 30 && u === 's'), 'e467 轮询周期 30 s');
  // 改判挂卡或做法的三条不再留在可移植库（连同两条汇总）。
  assert.deepEqual(priors.filter((p) => /^audio-subs\.(?:e304|e308|e413|sum\.s07-t2-r0[26])(?:\.|$)/.test(p.id)).map((p) => p.id), []);
  // e303：元音至少占音符的 42%，跨实现可用。
  const store = loadAudioSubsPriorsStore();
  const share = store.get('audio-subs.e303.min-vowel-share');
  assert.ok(share, 'e303 进可移植库');
  assert.deepEqual([share.value, share.unit, share.verifiedInOurStack, row.get('e303').route], [0.42, 'ratio', false, 'portable']);
  assert.deepEqual(row.get('e303').targets, ['audio-subs.e303.min-vowel-share']);
  // e413 的主体是制作分工、e335 是声画对位条件：归做法；e413 顺带提的混音响度仍在 quantities。
  for (const sid of ['e413', 'e335']) {
    assert.equal(row.get(sid).route, 'practice', sid);
    assert.equal(practices.filter((e) => e.sourceId === sid).length, 1, sid);
  }
  assert.deepEqual(quantitiesOf('e413').map((x) => [x.value, x.unit]), [[-14, 'LUFS']]);
  assert.match(quantitiesOf('e335').length === 0 && practices.find((e) => e.sourceId === 'e335').text, /配乐停顿时地板铺开/);
  for (const sid of ['e335', 'e376', 'e383']) assert.ok(!manifest.excluded.some((x) => x.sourceId === sid), `${sid} 不在不迁表里`);
  for (const sid of ['e303', 'e306', 'e436', 'e395', 'e467']) assert.ok(!practices.some((e) => e.sourceId === sid), `${sid} 不在做法表里`);
  // 不迁的只剩没有做法也没有参数的陈述与对账行。
  assert.deepEqual(manifest.excluded.map((x) => x.sourceId).sort(), ['e295', 'e300', 'e317', 'e321', 'e336', 'e340', 'e354', 'e356', 'e364', 'e377', 'e411', 'e433']);
  // 四路计数：明细 417、汇总 123，合计 540。
  assert.deepEqual(manifest.detailRouteCounts, { 'skipped-or-conflict': 12, 'card-coupled': 309, practice: 46, portable: 50 });
  assert.deepEqual(manifest.summaryRouteCounts, { 'card-coupled': 74, portable: 33, practice: 15, 'skipped-or-conflict': 1 });
  assert.deepEqual([manifest.portableCount, manifest.cardCoupledCount, manifest.practiceCount, manifest.excludedOrConflictCount], [83, 383, 61, 13]);
});

test('十审：终审独立抽检判过的 11 条以终审判定为独立去向，原盲判留底，其余盲判不动', () => {
  const { audit, ledger } = manifest;
  const route = new Map(ledger.map((r) => [r.sourceId, r.route]));
  const ruled = audit.sample.filter((s) => 'blindRoute' in s);
  assert.deepEqual(ruled.map((s) => s.sourceId).sort(), ['e303', 'e304', 'e306', 'e308', 'e335', 'e376', 'e383', 'e395', 'e413', 'e436', 'e467']);
  for (const s of ruled) {
    assert.match(s.rubric, /^g-rev-r(?:9|10)$/, s.sourceId);
    assert.equal(s.independentRoute, route.get(s.sourceId), s.sourceId);
    assert.ok(['portable', 'card-coupled', 'practice', 'skipped-or-conflict'].includes(s.blindRoute) && s.why.length >= 6, s.sourceId);
  }
  assert.equal(audit.finalReviewRulings, ruled.length);
  for (const s of audit.sample.filter((x) => !('blindRoute' in x))) assert.match(s.rubric, /^v[12]$/, s.sourceId);
  // 与盲判仍不一致的 12 条照实列着（五审点名的 e359、e215、e331 等），不因终审改判而抹掉。
  assert.deepEqual(audit.disagreements, ['e359', 'e362', 'e314', 'e424', 'e432', 'e215', 'e375', 'e404', 'e330', 'e331', 'e374', 'e449']);
});
