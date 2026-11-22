import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  C11_COLLECTIONS,
  getBatch2CardPriors,
  getBatch2MigrationManifest,
  getBatch2Practices,
  loadArchScenePriorsStore,
  loadBatch2PriorsStore,
  loadLightCamPriorsStore,
  loadMotionRigPriorsStore,
} from './priors-batch2.mjs';
import * as cards from './index.mjs';
import { PRIOR_UNITS, createPriorsStore, scanPriorLeaks, validatePriorsTable } from './priors.mjs';

const TOTALS = { 'arch-scene': 526, 'motion-rig': 609, 'light-cam': 687 };
const ROUTES = ['portable', 'card-coupled', 'practice', 'skipped-or-conflict'];
const dataDir = new URL('./priors-data/', import.meta.url);
const raw = (name) => readFileSync(new URL(name, dataDir), 'utf8');
const files = readdirSync(dataDir).filter((f) => C11_COLLECTIONS.some((c) => f.startsWith(`${c}.`))).sort();
const isSummary = (e) => Object.hasOwn(e, 'summaryOf');
const D = Object.fromEntries(C11_COLLECTIONS.map((c) => [c, {
  text: raw(`${c}.json`),
  priors: JSON.parse(raw(`${c}.json`)).entries,
  cardPriors: JSON.parse(raw(`${c}.card-priors.json`)).entries,
  practices: JSON.parse(raw(`${c}.practices.json`)).entries,
  manifest: getBatch2MigrationManifest(c),
}]));
const each = (fn) => { for (const c of C11_COLLECTIONS) fn(c, D[c]); };
const sha16 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

test('C11-Red 三份先验库可加载，接口从 beiming/cards/index.mjs 导出', () => {
  assert.deepEqual([...C11_COLLECTIONS], ['arch-scene', 'motion-rig', 'light-cam']);
  assert.ok(Object.isFrozen(C11_COLLECTIONS));
  for (const name of ['loadArchScenePriorsStore', 'loadMotionRigPriorsStore', 'loadLightCamPriorsStore', 'loadBatch2PriorsStore', 'getBatch2CardPriors', 'getBatch2Practices', 'getBatch2MigrationManifest']) {
    assert.equal(typeof cards[name], 'function', name);
  }
  assert.deepEqual(cards.C11_COLLECTIONS, C11_COLLECTIONS);
  assert.equal(loadArchScenePriorsStore(), loadBatch2PriorsStore('arch-scene'));
  assert.equal(loadMotionRigPriorsStore(), loadBatch2PriorsStore('motion-rig'));
  assert.equal(loadLightCamPriorsStore(), loadBatch2PriorsStore('light-cam'));
  for (const bad of ['audio-subs', '', undefined, '__proto__']) {
    assert.throws(() => loadBatch2PriorsStore(bad), TypeError);
    assert.throws(() => getBatch2MigrationManifest(bad), TypeError);
  }
  assert.throws(() => getBatch2Practices('nope'), TypeError);
  assert.throws(() => getBatch2CardPriors('light.studio', 'nope'), TypeError);
});

test('三份总账严格闭合：526 / 609 / 687，合计 1,822；四路计数与各文件条目一一对上', () => {
  let grand = 0;
  each((c, { priors, cardPriors, practices, manifest: m }) => {
    const { rows } = m;
    grand += rows.length;
    assert.equal(rows.length, TOTALS[c], c);
    assert.equal(m.totalSourceEntries, TOTALS[c], c);
    assert.equal(m.collection, c);
    assert.equal(new Set(rows.map((r) => r.sourceId)).size, rows.length, `${c} sourceId 唯一`);
    const lines = rows.map((r) => r.sourceLine);
    assert.ok(lines.every((n) => Number.isSafeInteger(n) && n > 0), c);
    assert.deepEqual(lines, [...lines].sort((a, b) => a - b), `${c} 按源文行序`);
    assert.equal(new Set(lines).size, rows.length, `${c} 一行一条`);
    for (const r of rows) {
      assert.ok(['detail', 'summary'].includes(r.recordKind) && ROUTES.includes(r.route), r.sourceId);
      assert.match(r.caseId, /^(?:case-\d\d|ext-\d\d)$/, `${c} ${r.sourceId}`);
      assert.ok(typeof r.section === 'string' && Object.hasOwn(m.sections, r.section), `${c} ${r.sourceId} 的节`);
    }
    assert.equal(rows.filter((r) => r.recordKind === 'detail').length, m.detailEntries);
    assert.equal(rows.filter((r) => r.recordKind === 'summary').length, m.summaryRows);
    assert.equal(m.detailEntries + m.summaryRows, TOTALS[c]);
    const counts = { portable: m.portableCount, 'card-coupled': m.cardCoupledCount, practice: m.practiceCount, 'skipped-or-conflict': m.excludedOrConflictCount };
    assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), TOTALS[c]);
    for (const route of ROUTES) {
      assert.equal(rows.filter((r) => r.route === route).length, counts[route], `${c} ${route}`);
      assert.equal((m.detailRouteCounts[route] ?? 0) + (m.summaryRouteCounts[route] ?? 0), counts[route], `${c} ${route} 明细 + 汇总`);
    }
    // 每条产物都能回到总账，且只属于一行。
    const pools = { portable: new Set(priors.map((e) => e.id)), 'card-coupled': new Set(cardPriors.map((e) => e.id)), practice: new Set(practices.map((e) => e.id)) };
    for (const [name, pool] of Object.entries(pools)) assert.equal(pool.size, { portable: priors, 'card-coupled': cardPriors, practice: practices }[name].length, `${c} ${name} id 唯一`);
    const seen = new Set();
    for (const r of rows) {
      if (r.route === 'skipped-or-conflict' || (r.recordKind === 'summary' && r.route !== 'portable')) {
        assert.deepEqual(r.targets, [], `${c} ${r.sourceId}`); // 不迁的行与非可移植明细的汇总行只记账
        continue;
      }
      assert.ok(r.targets.length > 0, `${c} ${r.sourceId}`);
      for (const id of r.targets) {
        assert.ok(pools[r.route].has(id), `${c} ${r.sourceId} → ${id}`);
        assert.ok(!seen.has(id), `${c} 重复去向 ${id}`);
        seen.add(id);
      }
    }
    assert.deepEqual([...pools.portable, ...pools['card-coupled'], ...pools.practice].filter((id) => !seen.has(id)), [], `${c} 没有游离产物`);
    const skippedDetails = rows.filter((r) => r.recordKind === 'detail' && r.route === 'skipped-or-conflict').map((r) => r.sourceId);
    assert.deepEqual(m.excluded.map((x) => x.sourceId), skippedDetails, `${c} 不迁清单`);
    for (const x of m.excluded) assert.ok(x.reason.length >= 6 && x.title, `${c} ${x.sourceId}`);
    assert.ok(m.mergedNotes.sectionNoteLinesNotCounted >= 0 && m.mergedNotes.mergedSubEntriesNotCounted >= 0);
  });
  assert.equal(grand, 1822);
});

test('汇总行 100% 指回同案例、同去向的真实明细，stats 不重复计', () => {
  each((c, { priors, manifest: m }) => {
    const byId = new Map(m.rows.map((r) => [r.sourceId, r]));
    const summaries = m.rows.filter((r) => r.recordKind === 'summary');
    assert.ok(summaries.length > 0, c);
    for (const s of summaries) {
      const d = byId.get(s.summaryOf);
      assert.ok(d && d.recordKind === 'detail', `${c} ${s.sourceId} → ${s.summaryOf}`);
      assert.equal(s.caseId, d.caseId, `${c} ${s.sourceId} 同案例`);
      assert.equal(s.route, d.route, `${c} ${s.sourceId} 同去向`);
      assert.equal(s.target, d.target, `${c} ${s.sourceId} 同目标卡`);
    }
    for (const r of m.rows.filter((x) => x.recordKind === 'detail')) assert.equal(Object.hasOwn(r, 'summaryOf'), false, r.sourceId);
    // 可移植库里的汇总条目：指回的就是那条明细出的先验，案例一致，主值取自其中一条。
    const pById = new Map(priors.map((e) => [e.id, e]));
    const sums = priors.filter(isSummary);
    assert.equal(sums.length, summaries.filter((s) => s.route === 'portable').length, c);
    for (const e of sums) {
      const row = byId.get(e.ext['c11.sourceId']);
      assert.deepEqual(row.targets, [e.id]);
      const mine = new Set(byId.get(row.summaryOf).targets);
      for (const id of e.summaryOf) {
        assert.ok(mine.has(id) && !isSummary(pById.get(id)), `${e.id} → ${id}`);
        assert.equal(pById.get(id).provenance.caseId, e.provenance.caseId, e.id);
      }
      const from = pById.get(e.ext['c11.valueFrom']);
      assert.ok(e.summaryOf.includes(from.id), e.id);
      assert.deepEqual([e.value, e.unit, e.topic], [from.value, from.unit, from.topic], e.id);
    }
    const stats = loadBatch2PriorsStore(c).stats();
    assert.deepEqual([stats.totalEntries, stats.summaryCount, stats.detailCount, stats.verifiedCount], [priors.length, sums.length, priors.length - sums.length, 0], c);
    assert.equal(loadBatch2PriorsStore(c).query({}).length, stats.detailCount, `${c} 默认检索不含汇总`);
  });
});

test('三份可移植表以 JSON 原文过 C9：0 错误、0 泄露、单位合法、全部未读回', () => {
  each((c, { text, priors }) => {
    const checked = validatePriorsTable(text);
    assert.deepEqual(checked.errors, [], c);
    assert.deepEqual(checked.leaks, [], c);
    assert.ok(checked.ok, c);
    assert.ok(priors.filter((e) => !isSummary(e)).length >= 20, `${c} 可移植明细 ${priors.length}`);
    for (const e of priors) {
      assert.ok(PRIOR_UNITS.includes(e.unit), e.id);
      assert.equal(e.verifiedInOurStack, false, e.id);
      assert.equal(Object.hasOwn(e, 'readbackEvidence'), false, e.id);
      assert.equal(Object.hasOwn(e, 'colorSpace'), false, `${e.id}：色值不进可移植表`);
      assert.ok(!['rgb-linear', 'rgb-display'].includes(e.unit), e.id);
      assert.ok(e.id.startsWith(`${c}.`) && e.topic.startsWith(`${c}.`), e.id);
      assert.match(e.provenance.caseId, /^(?:case-\d\d|ext-\d\d)$/, e.id);
    }
    const view = loadBatch2PriorsStore(c).query({ limit: 1 })[0];
    assert.equal(view.readbackLabel, '未在我方读回');
    assert.ok(Object.isFrozen(view));
  });
});

test('可移植量的值精确出现在它的原文片段里，片段出自条目原文', () => {
  const nums = (t) => (t.match(/[−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|[−-]?\.\d+/g) ?? []).map((s) => Number(s.replace('−', '-').replaceAll(',', '').replace(/^(-?)\./, '$10.')));
  // 换算口径：厘米与百分数 ×0.01、毫米→米 ×0.001、千米 ×1000、分钟 ×60、万 ×1e4、百万 ×1e6、每分钟→Hz ÷60；a±b 取两端。
  const factors = [1, 0.01, 0.001, 1000, 60, 1e4, 1e6, 1 / 60];
  const close = (a, b) => Math.abs(a - b) <= 1e-9 + 1e-6 * Math.abs(b);
  const squash = (s) => s.replace(/\s+/g, '');
  each((c, { priors }) => {
    for (const e of priors.filter((p) => !isSummary(p))) {
      const piece = e.ext['c11.raw'];
      assert.ok(typeof piece === 'string' && piece.length > 0, e.id);
      assert.ok(squash(`${e.title} ${e.provenance.note}`).includes(squash(piece)), `${e.id} 的片段「${piece}」不在原文里`);
      const found = nums(piece);
      // value 的三种形状：一个数；[小, 大] 范围；{ first, second } 是原文并列的两个取值。
      const pair = e.value !== null && typeof e.value === 'object' && !Array.isArray(e.value);
      if (pair) {
        assert.deepEqual(Object.keys(e.value), ['first', 'second'], e.id);
        assert.match(piece, /[\d.]\s*[\/、]\s*[−\-.\d]/, `${e.id}：并列取值的片段里要有斜线或顿号`);
      }
      const vals = pair ? Object.values(e.value) : [e.value].flat();
      for (const v of vals) {
        assert.equal(typeof v, 'number', e.id);
        const single = found.some((n) => factors.some((f) => close(Math.abs(n) * f, Math.abs(v))));
        const pm = found.some((a) => found.some((b) => factors.some((f) => close((Math.abs(a) + Math.abs(b)) * f, Math.abs(v)) || close((Math.abs(a) - Math.abs(b)) * f, v))));
        assert.ok(single || pm, `${e.id} 的值 ${v} 不在「${piece}」里`);
      }
      if (Array.isArray(e.value)) assert.ok(e.value.length === 2 && e.value[0] <= e.value[1], e.id);
      if (['s', 'ms', 'frame', 'count', 'fps', 'Hz', 'mm', 'K', 'spp'].includes(e.unit) && !/offset|delta|shift|bias|drop|lead|lag/.test(e.id)) {
        assert.ok(Math.max(...vals) >= 0, `${e.id}：这类量不该是负数`);
      }
    }
  });
});

test('全部 12 份 JSON 原文与解析对象零泄露：无原包路径、lab://、本机路径与裸 sha256', () => {
  assert.equal(files.length, 12);
  assert.deepEqual(files, C11_COLLECTIONS.flatMap((c) => [`${c}.card-priors.json`, `${c}.json`, `${c}.manifest.json`, `${c}.practices.json`]).sort());
  for (const f of files) {
    const text = raw(f);
    assert.deepEqual(scanPriorLeaks(text), [], f);
    assert.deepEqual(scanPriorLeaks(JSON.parse(text)), [], f);
  }
});

// 原作名、角色名、地名、区域名、品牌与人名的 sha256 前 16 位（名字本身不入库，免得测试文件自己泄露专名）。
// 前半是 C10 的同一张表（同一批原作），后半是本批三份汇编新出现的。
const IP_HASHES = new Set(["619df91bac841eda", "0b1df33ea7eef2b2", "86663a1dd8f6b661", "924493ee15e2a68c", "dd9ab072bf740423", "2bf84b0ad08b23b8", "f4a6923996dbeb19", "3f8f01ea269b6cfe", "ecc9bddb65dc4451", "1351704cdc4d32f8", "b6f6732db83b899a", "a590c43e71d44866", "8534cd0426607ce6", "c6661966bce79f30", "419a4461434283fd", "bb1d46105bd704dc", "f27354a69b790eda", "d0b3b3d6c6c14f17", "aa416dab2cc47c86", "1ae0552a12823c54", "98162a1e33275f16", "ff627719813c923a", "40a7e9acb06295d6", "6d588db5b668cf12", "c512ca0c5c1e71be", "f44b7e30470bbf28", "c34305e7b35f6f0b", "965b8a7ec4177224", "1e445d2d4b31efe2", "f1ed891245759d1c", "26dd587fdb6a290c", "ad21b547ce7162c5", "1dd31cd072fdd30f", "b3158331cecc3845", "b9b13e1cd77acbd7", "ee839bf111a7e47a", "aaa1073bd98fd4e7", "07f0bf736c13b81f", "9e70b33fe4edaf5b", "5032f1bea2401f8f", "d4fff627da31250b", "36997f035118cae8", "9fa9e239e047e205", "b1f49128310e2481", "eb7855e04a2006fd", "f5105c9ea0cd361b", "e5a6d6899f2e6e04", "14fc1fd907298aaa", "dc7a4a2cc7e36000", "0b2058635ba3d17f", "1f25b77eea9b8db1", "59ee9ed12f7822d8", "ed818ec233248ae6", "930eaf1684b953a9", "400e436ed3eb0252", "f09bfa2c3c7042e4", "0e377aac3a660698", "d544b0316e19a87b", "dd415e6f13d54a9b", "1fe8ba945043480d", "e5993ec06c2e0d77", "c26804e0eaf84a96", "3d8c28f257964498", "d7834604301b3e8a", "06f8e2ae03f7ec87", "84a6921827058d16", "196cecb58d133eb0", "fba3a504b35a8d53", "a276bb8a748ddb9c", "90dd5db3f1b09545", "42c0b79536f2e4ff", "a7fb0e02239ad9aa", "3e9fd6d71c87b1db", "d2e2586d773f54ee", "9e863d7b36ae5de1", "729090481f813e9e", "b02ea6fe7b71ccf7", "7e8672748ae4410e", "3f33cff3bab2bd6e", "3eef1f7226e1215e", "ed4561f685f13353", "a819d7cd38e9101b", "c8b40f3f8920b8aa", "ca71d3ec52ddc852", "36ad0f15e388a8ce", "d11d3177bb31f0c0", "29f2aef0c51aa28d", "4281b1bc48777893", "0aa9934892ca9cd1", "781de50d4a336ba7", "55e4e874c9f996f1", "40fe6b860770436f", "63dbdfb4c910db1e", "b0be237b71b69a0d", "3d85ee4f370e7579", "75f128184099aaa2", "4fac0361bcb7b771", "bd54e7d6e49bd448", "a624f2d4371bbd82", "bcca17804247899c", "e7620a32095f6909", "dc8331bcb2283e89", "2a7faaf70333cde4", "5f6e7773915655fc", "2f55b64c59eec8e5", "599917fb5a47d4ba", "249993eec332cb78", "bdf4949a46682dc3", "9eebe6aa942221a6", "20b836be6317bc4c", "5f226262ba09e0ec", "75ff6821b8f8a31f", "14e59f423e87958e", "2d94fe98376d814d", "39fabf3d2bf91ace", "8c6e8e8b9a0eb983", "374eebfb2bae1290", "89e1ed6c1d606797", "033fddb8853a1ad0", "04605c208bd7a6bb", "307302c4a4e4ecc6", "d589ef48fd5f55ce", "a309ac16ce1299ea", "e16702398a9a3929", "41bc72708c799dbc", "7edbff10b5f7627e", "95a84911801a7130", "ff7b676cdada9bca", "fd8ecd2d4d814e68", "3cb95ec0c6cc1835", "75d28e035320c596", "f8158a8e962d1201", "f34d80eb22b1490a", "4f594364d6326c96", "6288e70fd4838bbb", "8aec299118b83ebd", "0ededb699a4e223c", "c45770067ec259b6", "b2a4e476bb0cf3df", "b05a020b94ff9f43", "64168e1ca791c61b", "09cf980b5ff304ac", "c857d09db23e6822", "50b2676afbe30c83", "a38188f3bafbcb73", "0871d655983efd56", "4ed91096f08e52f6", "8318900ae631b424", "d4c58781c552db46", "a44a673a8c66e9d7", "6b27eba5652b46d3", "34a533dfd7273a9b", "0a99b793f44bcc55", "42817f456a964a0d"]);

test('零原作专名：拉丁 1–3 词组（拆驼峰）与汉字 2–5 字串都不命中专名黑名单', () => {
  assert.ok(IP_HASHES.size >= 120, `黑名单 ${IP_HASHES.size} 个`);
  const loader = readFileSync(new URL('./priors-batch2.mjs', import.meta.url), 'utf8');
  for (const [name, text0] of [...files.map((f) => [f, raw(f)]), ['priors-batch2.mjs', loader]]) {
    const grams = new Set();
    const text = text0.replace(/['’]s\b/g, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    const words = text.match(/[a-z0-9]+/g) ?? [];
    words.forEach((_, i) => {
      for (let n = 1; n <= 3 && i + n <= words.length; n += 1) grams.add(words.slice(i, i + n).join(' '));
    });
    for (const run of text.match(/[一-鿿]{2,}/g) ?? []) {
      for (let i = 0; i < run.length; i += 1) for (let n = 2; n <= 5 && i + n <= run.length; n += 1) grams.add(run.slice(i, i + n));
    }
    const hit = [...grams].filter((g) => IP_HASHES.has(sha16(g)));
    assert.equal(hit.length, 0, `${name} 命中 ${hit.length} 个专名`);
  }
});

test('零原包源码路径、文件名与内部编号：12 份 JSON 与加载器里没有源码文件、素材文件、文档名、清单号与裸章号', () => {
  const res = {
    path: /\b(?:src|tools|scripts|app|packages|world|core|render|game|fx|player|enemies|levels)\/[A-Za-z0-9_./-]+\.(?:m?js|ts|py)\b/,
    sourceFile: /\b[\w-]+\.(?:m?js|cjs|tsx?|py|sh|glsl|wgsl|blend)\b(?::\d+)?/,
    media: /\b[\w-]+\.(?:mp3|wav|m4a|mp4|mov|png|jpe?g|exr|hdr|glb|gltf|stl|fbx)\b/,
    glob: /[\w-]*\*[\w*-]*\.(?:m?js|cjs|ts|py|sh|glsl)\b/,
    dataPath: /\b[\w.-]+\/[\w*.-]+\.(?:json|ya?ml|tsv|csv|txt)\b/,
    dataFile: /(?<![\w.-])(?!(?:arch-scene|motion-rig|light-cam)\.)[\w*-]+\.(?:json|ya?ml|tsv|csv|txt)\b/,
    doc: /\.md\b|下载\/|原文\/|清单\//,
    wikilink: /\[\[(?:#|复刻|清单|指引|[^\]\[,]*\|)/,
    internalId: /\b(?:RP|TN|FX|MT|CH|AU)-\d+/,
    listId: /(?<![A-Za-z0-9_.])[gr]\d{1,2}[ab]?-[a-z]/,
    bareChapter: /§/,
    caseLabel: /案例：\s*\d+\s|来自案例/,
    hashName: /(?<![0-9a-zA-Z#x])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{12,}(?![0-9a-zA-Z])/,
  };
  for (const f of files) {
    const text = raw(f);
    for (const [name, re] of Object.entries(res)) assert.doesNotMatch(text, re, `${f} ${name}`);
  }
  const loader = readFileSync(new URL('./priors-batch2.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(loader, /lab:\/\/|\/Users\/|案例复刻库|复刻\//);
});

test('05 §8.1 修复一：把章号当案例号的「案例 14」全部记 case-13，出处带第 14 章', () => {
  const fixOf = (c) => D[c].manifest.knownFixes.find((f) => f.issue === 'case13-chapter-label');
  // 光照那份 2 处、动作那份 1 处（源文在文末点名），建筑那份 0 处。
  assert.equal(fixOf('light-cam').occurrencesInSource, 2);
  assert.equal(fixOf('light-cam').sourceIds.length, 2);
  assert.equal(fixOf('motion-rig').occurrencesInSource, 1);
  assert.equal(fixOf('arch-scene').occurrencesInSource, 0);
  const light = D['light-cam'];
  const lightAll = [...light.cardPriors, ...light.practices, ...light.manifest.excluded];
  for (const sid of fixOf('light-cam').sourceIds) {
    const row = light.manifest.rows.find((r) => r.sourceId === sid);
    assert.equal(row.caseId, 'case-13', sid);
    const e = lightAll.find((x) => x.sourceId === sid);
    assert.equal(e.caseId, 'case-13', sid);
    assert.match(e.docRef, /案例 13 第 14 章/, sid);
  }
  // 动作那份：第 13 到 16 章（两个头目与普通敌人）的条目一律 case-13，并带章号。
  assert.ok(fixOf('motion-rig').chapterTaggedRows >= 150, `带章号 ${fixOf('motion-rig').chapterTaggedRows} 行`);
  const motion = D['motion-rig'];
  const tagged = [...motion.cardPriors, ...motion.practices, ...motion.manifest.excluded].filter((e) => /案例 13 第 (?:\d+、)*14(?:、\d+)* 章/.test(e.docRef));
  assert.ok(tagged.length >= 30, `第 14 章 ${tagged.length} 条`);
  for (const e of tagged) assert.equal(e.caseId, 'case-13', e.sourceId);
  each((c, { priors, cardPriors, practices, manifest: m }) => {
    const known = new Set(m.cases.map((x) => x.caseId));
    const ids = [...m.rows.map((r) => r.caseId), ...priors.map((e) => e.provenance.caseId), ...cardPriors.map((e) => e.caseId), ...practices.map((e) => e.caseId), ...m.excluded.map((e) => e.caseId)];
    for (const id of ids) assert.ok(known.has(id), `${c} ${id}`);
    // 「第 N 章」只挂在案例 13 上；真正的案例 14 是另一部片，条目很少，且出处里没有章号。
    for (const e of [...cardPriors, ...practices, ...m.excluded]) if (/第 [\d、]+ 章）/.test(e.docRef)) assert.equal(e.caseId, 'case-13', `${c} ${e.sourceId}`);
    for (const e of priors) if (/第 [\d、]+ 章）/.test(e.provenance.docRef ?? '')) assert.equal(e.provenance.caseId, 'case-13', e.id);
    assert.ok(m.rows.filter((r) => r.caseId === 'case-14').length <= 12, `${c} case-14 ${m.rows.filter((r) => r.caseId === 'case-14').length} 行`);
    assert.ok(m.rows.filter((r) => r.caseId === 'case-13').length >= 200, c);
  });
});

test('05 §8.1 修复二：内部编号展开成中性出处类别，没有 RP-、TN-、清单号、裸章号残留', () => {
  let replaced = 0;
  each((c, { priors, cardPriors, practices, manifest: m }) => {
    const fix = m.knownFixes.find((f) => f.issue === 'internal-ids-expanded');
    assert.ok(fix, c);
    for (const k of ['list-id', 'bare-chapter', 'source-file']) assert.ok(fix.replaced[k] > 0, `${c} ${k}`);
    replaced = Object.values(fix.replaced).reduce((a, b) => a + b, 0);
    const category = /；出处类别：(?:源码拆解|实测读数|原文陈述|推断与说明)·\S/;
    const refs = [...cardPriors.map((e) => e.docRef), ...practices.map((e) => e.docRef), ...m.excluded.map((e) => e.docRef), ...priors.filter((e) => !isSummary(e)).map((e) => e.provenance.docRef)];
    assert.ok(refs.length >= m.detailEntries, c);
    for (const ref of refs) {
      assert.match(ref, category, `${c} ${ref}`);
      assert.doesNotMatch(ref, /\b(?:RP|TN)-\d|(?<![A-Za-z0-9_.])[gr]\d{1,2}[ab]?(?![A-Za-z0-9_(.=])|\.(?:js|py|md|txt)\b|\[\[|复盘 ?[\d.]|分章/, `${c} ${ref}`);
    }
    for (const f of files.filter((x) => x.startsWith(`${c}.`))) assert.doesNotMatch(raw(f), /\b(?:RP|TN)-\d+/, f);
  });
  assert.ok(replaced >= 300, `三份合计展开 ${replaced} 处`);
});

test('05 §8.1 修复三：案例 10 竹林风摆 0.85 / 1.9 / 0.33 的单位从 Hz 改成 rad/s，汇总与明细两处都改', () => {
  const { manifest: m, cardPriors, priors, practices } = D['arch-scene'];
  const fix = m.knownFixes.find((f) => f.issue === 'wind-sway-angular-frequency');
  assert.deepEqual(fix.before, [0.85, 1.9, 0.33].map((value) => ({ value, unit: 'Hz' })));
  assert.deepEqual(fix.after, [0.85, 1.9, 0.33].map((value) => ({ value, unit: 'rad/s' })));
  assert.equal(fix.sourceIds.length, 2);
  const rows = fix.sourceIds.map((sid) => m.rows.find((r) => r.sourceId === sid));
  assert.deepEqual(rows.map((r) => r.recordKind).sort(), ['detail', 'summary']);
  for (const r of rows) {
    assert.equal(r.caseId, 'case-10', r.sourceId);
    assert.deepEqual(r.fixes, ['wind-sway-angular-frequency']);
    assert.deepEqual(r.corrected, fix.after);
  }
  const [detail] = rows.filter((r) => r.recordKind === 'detail');
  assert.equal(rows.find((r) => r.recordKind === 'summary').summaryOf, detail.sourceId);
  // 明细产物里三个频率都是 rad/s，从公开入口按目标卡能读到。
  const produced = [...cardPriors, ...practices].find((e) => e.sourceId === detail.sourceId);
  const qs = produced ? produced.quantities : priors.filter((e) => e.ext?.['c11.sourceId'] === detail.sourceId).map((e) => ({ value: e.value, unit: e.unit }));
  for (const v of [0.85, 1.9, 0.33]) {
    assert.ok(qs.some((q) => q.value === v && q.unit === 'rad/s'), `${v} rad/s`);
    assert.ok(!qs.some((q) => q.value === v && q.unit === 'Hz'), `${v} 不再是 Hz`);
  }
  if (detail.route === 'card-coupled') {
    const viaCard = getBatch2CardPriors(detail.target, 'arch-scene').find((e) => e.sourceId === detail.sourceId);
    assert.match(viaCard.text, /0\.85 rad\/s.*1\.9 rad\/s.*0\.33 rad\/s/);
    assert.deepEqual(viaCard.fixes, ['wind-sway-angular-frequency']);
  }
  // 案例 10 的条目里不再有带 Hz 的这三个数；别的两份没有这一处。
  for (const f of files) assert.doesNotMatch(raw(f), /(?:0\.85|1\.9|0\.33) Hz/, f);
  for (const c of ['motion-rig', 'light-cam']) assert.deepEqual(D[c].manifest.knownFixes.find((f) => f.issue === 'wind-sway-angular-frequency').sourceIds, []);
});

test('挂卡行在总账与挂卡表里都带直读的目标卡 ID，按卡从公开入口查得到', () => {
  const spec = /^(?:time|camera|post|comp|deliver|audio|blender|overlay|layout|page|assembly|asset|light|mat|look|form|particle|fx|motion|rig|blur|three|atmo|shade|wind|sky)\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
  let inSpec = 0;
  each((c, { cardPriors, manifest: m }) => {
    const byId = new Map(cardPriors.map((e) => [e.id, e]));
    const cardOf = new Map(cardPriors.map((e) => [e.sourceId, e.cardId]));
    const menu = new Map(m.cards.map((x) => [x.cardId, x]));
    const coupled = m.rows.filter((r) => r.route === 'card-coupled');
    assert.equal(coupled.filter((r) => r.recordKind === 'detail').length, cardPriors.length, c);
    for (const r of coupled) {
      assert.ok(typeof r.target === 'string' && spec.test(r.target), `${c} ${r.sourceId} 的 target ${r.target}`);
      assert.ok(menu.has(r.target), `${c} ${r.target} 在清单的卡表里`);
      if (r.recordKind === 'detail') {
        assert.equal(r.target, byId.get(r.targets[0]).cardId, `${c} ${r.sourceId}`);
        assert.ok(getBatch2CardPriors(r.target, c).some((e) => e.sourceId === r.sourceId), `${c} ${r.sourceId} 按 target 查不到`);
      } else assert.equal(r.target, cardOf.get(r.summaryOf), `${c} ${r.sourceId}`);
    }
    for (const r of m.rows.filter((x) => x.route !== 'card-coupled')) assert.equal(Object.hasOwn(r, 'target'), false, `${c} ${r.sourceId}`);
    for (const e of cardPriors) {
      assert.equal(e.useAsDefault, false, e.id);
      assert.equal(e.verifiedInOurStack, false, e.id);
      assert.ok(e.cardId && e.coupling && e.recalibrate && e.text && e.docRef && Array.isArray(e.quantities), e.id);
    }
    for (const x of m.cards) {
      assert.equal(getBatch2CardPriors(x.cardId, c).length, x.count, `${c} ${x.cardId}`);
      assert.equal(typeof x.inSpec, 'boolean');
      assert.equal(x.exists, existsSync(new URL(`./${x.cardId.replace('.', '/')}/card.json`, import.meta.url)), `${c} ${x.cardId} exists`);
      assert.ok(x.covers.length >= 2, x.cardId);
      inSpec += x.inSpec ? 1 : 0;
    }
    assert.equal(m.cards.reduce((n, x) => n + x.count, 0), cardPriors.length, c);
  });
  assert.ok(inSpec >= 25, `05 §5 正式卡 ${inSpec} 张次`);
  // 跨批按单卡查：不给集合就三份都查，结果冻结；没有的卡回空。
  const shake = getBatch2CardPriors('camera.shake');
  assert.equal(shake.length, C11_COLLECTIONS.reduce((n, c) => n + getBatch2CardPriors('camera.shake', c).length, 0));
  assert.ok(Object.isFrozen(shake) && Object.isFrozen(getBatch2CardPriors('light.studio', 'light-cam')));
  assert.deepEqual(getBatch2CardPriors('no.such-card'), []);
  assert.equal(getBatch2Practices().length, C11_COLLECTIONS.reduce((n, c) => n + getBatch2Practices(c).length, 0));
  for (const c of C11_COLLECTIONS) {
    assert.ok(Object.isFrozen(getBatch2Practices(c)) && Object.isFrozen(getBatch2MigrationManifest(c).rows));
    for (const e of getBatch2Practices(c)) assert.ok(['method', 'fix'].includes(e.kind) && (e.text.length >= 6 || e.quantities.length > 0), e.id);
  }
});

// 随机记号：rand、rnd、rng()、算式里的裸 rng、r()、Math.random()、随机( 与「随机×」。当参数传的（f(a,rng,b)）不算。
const RAND_TOKEN = /(?<![A-Za-z_.])(?:(?:rand|rnd)(?![A-Za-z])|rng\(\)|rng(?=\s*[×*·+\-−^])|(?<=[×*·+\-−]\s*)rng(?![\w(.])|r\(\)|Math\.random\(\)|随机\(|随机(?=\s*[×*·]))/g;
const NUM_DOT = String.raw`[−+\-]?(?:\d+(?:\.\d+)?|\.\d+)`;
const RAND_CLASSIC = new RegExp(String.raw`(?<![\d.A-Za-z_])(${NUM_DOT})\s*[+＋]\s*\(?\s*(?:rnd|rand|rng\(\)|rng|r\(\)|Math\.random\(\)|随机)(?:\^[\d.]+|²|³)?\s*[·×*]\s*(${NUM_DOT})(?![\d.])`, 'g');
const toNum = (s) => Number(s.replace('−', '-').replace(/^\+/, '').replace(/^(-?)\./, '$10.'));
const spansOf = (text, needle) => {
  const out = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) out.push([i, i + needle.length]);
  return out;
};

test('随机算式全覆盖：每个随机记号都有结构化区间，或登记在清单的例外表里', (t) => {
  assert.deepEqual(['floor(rng×4)', '2·rng', 'rng()^1.3', '.6+rng·.7', '(rnd-0.5)·amp', '0.9+随机×0.25', 'f(a,rng,b)', '搭建 rng 14302', 'holes,rnd,margin'].map((s) => [...s.matchAll(RAND_TOKEN)].length), [1, 1, 1, 1, 1, 1, 0, 0, 1]);
  let tokens = 0;
  let structured = 0;
  each((c, { priors, cardPriors, practices, manifest: m }) => {
    const skipped = m.rules.randomNotStructured;
    assert.ok(Array.isArray(skipped), c);
    const round6 = (x) => Math.round(x * 1e6) / 1e6;
    // 可移植明细：同一条明细的几条先验共用一段原文，区间挂在第一条的 ext["c11.randomRanges"] 上。
    const bySource = Map.groupBy(priors.filter((p) => !isSummary(p)), (p) => p.ext['c11.sourceId']);
    const portableDetails = [...bySource].map(([sourceId, list]) => {
      const note = list[0].provenance.note;
      for (const p of list) assert.equal(p.provenance.note, note, p.id);
      for (const p of list.slice(1)) assert.equal(Object.hasOwn(p.ext, 'c11.randomRanges'), false, p.id);
      return { id: list[0].id, sourceId, text: note, quantities: list[0].ext['c11.randomRanges'] ?? [] };
    });
    for (const e of [...cardPriors, ...practices, ...portableDetails]) {
      const skips = skipped.filter((s) => s.sourceId === e.sourceId);
      const withExpr = e.quantities.filter((q) => q.expr);
      for (const q of withExpr) {
        assert.equal(spansOf(e.text, q.expr).length, 1, `${e.id} 的 expr「${q.expr}」要在原文里恰好出现一次`);
        assert.ok(typeof q.label === 'string' && q.label.length >= 2, `${e.id} ${q.expr} 要有 label`);
        assert.ok(q.expr.match(RAND_TOKEN), `${e.id} ${q.expr} 里要有随机记号`);
      }
      const ranges = e.quantities.filter((q) => 'jitter' in q);
      for (const q of ranges) {
        assert.ok(Array.isArray(q.value) && q.value.length === 2 && q.value[0] <= q.value[1], `${e.id} ${JSON.stringify(q.value)}`);
        assert.ok(q.jitter >= 0 && typeof q.unit === 'string' && q.unit, e.id);
        // 区间两端 = 随机数取 0 与取 1 时的值。
        if (q.expr) assert.deepEqual(q.value, [q.base, round6(q.base + q.jitter)], `${e.id} ${q.expr}`);
        if (q.expr && /floor|ceil|round/.test(q.expr)) assert.equal(q.unit, 'count', `${e.id} ${q.expr}`);
        if ('step' in q) assert.ok(q.unit === 'count' && Number.isInteger(q.step) && q.jitter % q.step === 0, `${e.id} ${q.expr}`);
        if (q.scaleBy) for (const part of q.scaleBy.split(/[×/]/).filter((p) => p && p !== '1')) assert.ok(e.text.includes(part.replace(/^\(|\)$/g, '')), `${e.id} scaleBy=${q.scaleBy}`);
      }
      // 没登记 expr 的区间只能来自带单位的正写算式 A + 随机 × B，两端照算式。
      const classic = [...e.text.matchAll(RAND_CLASSIC)];
      for (const q of ranges.filter((x) => !x.expr)) {
        assert.ok(classic.some((mm) => Math.abs(toNum(mm[1]) - q.base) < 1e-9 || Math.abs(toNum(mm[1]) * 0.01 - q.base) < 1e-9), `${e.id}：区间 ${JSON.stringify(q.value)} 对不上正写算式`);
      }
      const cover = [
        ...withExpr.flatMap((q) => spansOf(e.text, q.expr)),
        ...skips.flatMap((s) => spansOf(e.text, s.expr)),
        ...(ranges.some((q) => !q.expr) ? classic.map((mm) => [mm.index, mm.index + mm[0].length]) : []),
      ];
      const found = [...e.text.matchAll(RAND_TOKEN)];
      for (const mm of found) {
        assert.ok(cover.some(([a, b]) => a <= mm.index && mm.index < b), `${e.id} 的随机量「${e.text.slice(Math.max(0, mm.index - 16), mm.index + 20)}」没有结构化区间`);
      }
      // 一个随机记号一条区间：既不漏，也不把同一个算式拆成两条。
      assert.equal(found.length, ranges.length + skips.length, `${e.id}：随机记号 ${found.length} 个，区间 ${ranges.length} 条，例外 ${skips.length} 个`);
      tokens += found.length;
      structured += ranges.length;
    }
    for (const s of skipped) {
      const e = [...cardPriors, ...practices, ...portableDetails].find((x) => x.sourceId === s.sourceId);
      assert.ok(e && e.text.includes(s.expr) && s.expr.match(RAND_TOKEN) && s.reason.length >= 6, `${c} 例外 ${s.sourceId} ${s.expr}`);
    }
    assert.ok(skipped.length <= 3, `${c} 例外 ${skipped.length} 个`);
    // 可移植先验的主值不取随机算式里的数：它引用的片段里没有随机记号。
    for (const p of priors.filter((x) => !isSummary(x))) assert.equal(p.ext['c11.raw'].match(RAND_TOKEN), null, p.id);
  });
  assert.ok(structured >= 20, `结构化区间 ${structured} 条`);
  t.diagnostic(`三份合计随机记号 ${tokens} 个：结构化区间 ${structured} 条，其余登记为例外`);
});

test('随机算式点名核对：正写、倒写、中心化、省略系数、裸变量与外层乘数', () => {
  const pools = (c) => [...D[c].cardPriors.map((e) => e.quantities), ...D[c].practices.map((e) => e.quantities), ...D[c].priors.map((e) => e.ext?.['c11.randomRanges'] ?? [])];
  const find = (c, expr) => {
    const hit = pools(c).flatMap((list) => list.filter((x) => x.expr === expr));
    assert.equal(hit.length, 1, expr);
    return [hit[0].value, hit[0].unit, hit[0].scaleBy ?? null];
  };
  assert.deepEqual(find('arch-scene', '0.88+rnd·0.06'), [[0.88, 0.94], 'ratio', null]); // 正写
  assert.deepEqual(find('arch-scene', '0.95-rnd·0.06'), [[0.89, 0.95], 'm', null]); // 减号：随机数取 1 时是下界
  assert.deepEqual(find('arch-scene', '0.03+0.06·rnd'), [[0.03, 0.09], 'm', '(0.55–1.25)']); // 倒写，外层再乘一个范围
  assert.deepEqual(find('arch-scene', '0.7+rnd'), [[0.7, 1.7], 'ratio', null]); // 省略系数
  assert.deepEqual(find('arch-scene', '(rnd-0.5)·amp'), [[-0.5, 0.5], 'ratio', 'amp']); // 中心化，变量乘数
  assert.deepEqual(find('arch-scene', '.6+rng·.7'), [[0.6, 1.3], 'm', null]); // 裸 rng、省略前导零
  assert.deepEqual(find('arch-scene', '0.8·rng'), [[0, 0.8], 'm', null]);
  assert.deepEqual(find('arch-scene', '0.9+随机×0.25'), [[0.9, 1.15], 'ratio', '(高/7)']); // 中文写法
  assert.deepEqual(find('arch-scene', '2.39996+(rng-.5)·.7'), [[2.04996, 2.74996], 'rad', null]);
  assert.deepEqual(find('light-cam', '0.12rand'), [[0, 0.12], 'ratio', null]); // 紧贴数字
  assert.deepEqual(find('light-cam', '70+170rand'), [[70, 240], 'm', '(1.35-.2tier)']);
  assert.deepEqual(find('light-cam', '(rand-.5)×.2'), [[-0.1, 0.1], 'ratio', 'Rc']);
  // 带单位的正写算式由提取器直接出区间：1.5+rand·4 秒 → [1.5, 5.5] s。
  const twitch = pools('motion-rig').flatMap((list) => list.filter((x) => 'jitter' in x && !x.expr));
  assert.ok(twitch.some((x) => x.unit === 's' && x.base === 1.5 && x.jitter === 4 && x.value[0] === 1.5 && x.value[1] === 5.5), JSON.stringify(twitch));
  // 同一条里四个随机记号各出一条。
  assert.equal(pools('arch-scene').find((list) => list.some((x) => x.expr === '2.39996+(rng-.5)·.7')).filter((x) => 'jitter' in x).length, 4);
});

test('量提取口径：变量后缀不当单位、指数与乘式里的数不出量、帧数是整数、单位在词表内', () => {
  const UNITS = new Set([...PRIOR_UNITS, 'W', 'rad/m', 'rad/s^2', 'deg/frame', 'rad/frame']);
  let total = 0;
  each((c, { cardPriors, practices }) => {
    for (const e of [...cardPriors, ...practices]) {
      for (const qq of e.quantities) {
        total += 1;
        assert.ok(UNITS.has(qq.unit), `${e.id} 单位 ${qq.unit}`);
        const vals = qq.value !== null && typeof qq.value === 'object' && !Array.isArray(qq.value) ? Object.values(qq.value) : [qq.value].flat();
        assert.ok(vals.length > 0 && vals.every((v) => typeof v === 'number' && Number.isFinite(v)), `${e.id} ${JSON.stringify(qq.value)}`);
        if (Array.isArray(qq.value)) assert.ok(qq.value.length === 2 && qq.value[0] <= qq.value[1], `${e.id} ${JSON.stringify(qq.value)}`);
        if (qq.unit === 'frame' || qq.unit === 'count') assert.ok(vals.every(Number.isInteger), `${e.id} ${qq.unit} ${JSON.stringify(qq.value)}`);
        if (qq.unit === 'K') assert.ok(vals.every((v) => v >= 1000 && v <= 20000), `${e.id}：4K 这类分辨率不是色温`);
        if (qq.unit === 'W') assert.ok(qq.rawUnit === 'W' && vals.every((v) => v >= 0), e.id);
      }
      // 一条里 s 或 m 当变量用（s=…、·s、sin(3s)）时，贴着数字的 s、m 不是秒和米。
      for (const [ch, unit] of [['s', 's'], ['m', 'm']]) {
        const asVar = new RegExp(`(?<![A-Za-z0-9_])${ch}\\s*=(?!=)|[·×*]\\s*${ch}(?![A-Za-z0-9_/])|(?:sin|cos)\\s*\\(?[^()；。]{0,24}[\\d.]${ch}(?![A-Za-z0-9_/])`).test(e.text);
        if (!asVar) continue;
        for (const mm of e.text.matchAll(new RegExp(`(?<![A-Za-z0-9_.])(\\d+(?:\\.\\d+)?)${ch}(?![A-Za-z0-9_/²³])`, 'g'))) {
          assert.ok(!e.quantities.some((x) => x.unit === unit && x.rawUnit === ch && x.value === Number(mm[1])), `${e.id} 把变量后缀「${mm[0]}」当成 ${unit}`);
        }
      }
      // 省略前导零、贴着单字母的写法（.29s、.4m）出自代码，一律不当秒和米。
      for (const mm of e.text.matchAll(/(?<![\d.])\.(\d+)([sm])(?![A-Za-z0-9_/²³])/g)) {
        assert.ok(!e.quantities.some((x) => x.rawUnit === mm[2] && x.value === Number(`0.${mm[1]}`)), `${e.id} 把「${mm[0]}」当成量`);
      }
    }
  });
  assert.ok(total >= 1500, `挂卡与做法条目的量 ${total} 个`);
  // 质检点名的几类：算式里的路径参数、箭头两侧不同的量、关键帧表的「帧」标签、每秒多少米、角加速度。
  const qs = (c, re) => [...D[c].cardPriors, ...D[c].practices].filter((e) => re.test(e.text)).flatMap((e) => e.quantities);
  assert.ok(!qs('arch-scene', /0\.35·sin\(0\.071s/).some((x) => x.unit === 's'), '0.071s 的 s 是沿根的路径参数');
  assert.ok(!qs('light-cam', /sin\(0\.13W\+31s\)/).some((x) => x.unit === 'W' || (x.unit === 's' && x.value === 31)), '0.13W+31s 都是变量');
  assert.ok(qs('motion-rig', /每秒最多 8 米推出/).some((x) => x.unit === 'm/s' && x.value === 8), '每秒最多 8 米是 m/s');
  for (const x of qs('motion-rig', /米\/秒²/)) assert.ok(!(x.rawUnit === '米/秒'), '米/秒² 不截成米/秒');
  assert.ok(qs('arch-scene', /44°-52°/).some((x) => x.unit === 'deg' && x.value[0] === 44 && x.value[1] === 52), '44°-52° 是范围，不是 −52°');
  assert.ok(qs('arch-scene', /15,983\.75 m/).some((x) => x.unit === 'm' && [x.value].flat().includes(15983.75)), '千分位 15,983.75 不截断');
});

test('冲突两边都保留：明细里的冲突全部进清单，能对上单位的写进 conflicts', () => {
  let n = 0;
  each((c, { priors, manifest: m }) => {
    const byId = new Map(priors.map((e) => [e.id, e]));
    const rows = new Map(m.rows.map((r) => [r.sourceId, r]));
    for (const x of m.conflicts) {
      n += 1;
      assert.ok(rows.has(x.sourceId) && x.text.length >= 6 && x.route === rows.get(x.sourceId).route, `${c} ${x.sourceId}`);
      for (const id of x.attachedTo) assert.ok(byId.get(id)?.conflicts?.length, id);
      if (!x.attachedTo.length) assert.ok(x.note, `${c} ${x.sourceId}`);
    }
    assert.equal(priors.filter((e) => e.conflicts).length, new Set(m.conflicts.flatMap((x) => x.attachedTo)).size, c);
  });
  assert.ok(n >= 20, `冲突 ${n} 条`);
  // 动作那份文末的 8 行冲突对账表都在清单里。
  assert.ok(D['motion-rig'].manifest.conflicts.length >= 8);
});

test('公开加载器把原文交给 C9：重复键在 loadBatch2PriorsStore 入口就被拦下', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c11-priors-'));
  try {
    cpSync(new URL('./priors.mjs', import.meta.url), join(dir, 'priors.mjs'));
    cpSync(new URL('./priors-batch2.mjs', import.meta.url), join(dir, 'priors-batch2.mjs'));
    cpSync(dataDir, join(dir, 'priors-data'), { recursive: true });
    for (const c of C11_COLLECTIONS) {
      const dup = D[c].text.replace('{', '{\n  "format": "priors/0.1",');
      assert.notEqual(dup, D[c].text);
      assert.equal(validatePriorsTable(dup).errors.some((e) => e.code === 'prior.duplicate-key'), true);
      assert.throws(() => createPriorsStore(dup), /prior\.duplicate-key/);
      writeFileSync(join(dir, 'priors-data', `${c}.json`), dup);
    }
    const mod = await import(pathToFileURL(join(dir, 'priors-batch2.mjs')).href);
    for (const c of C11_COLLECTIONS) assert.throws(() => mod.loadBatch2PriorsStore(c), /prior\.duplicate-key/, c);
    assert.throws(() => mod.loadArchScenePriorsStore(), /prior\.duplicate-key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 固定算法的伪随机：种子相同，抽样相同。
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

test('独立盲判覆盖全部明细；每份及合并任取随机种子抽 ≥ 10%（明细与汇总各 ≥ 10%），分歧都不超一成', (t) => {
  const merged = { details: [], summaries: [], differs: new Map() };
  each((c, { manifest: m }) => {
    const { audit, rows } = m;
    const details = rows.filter((r) => r.recordKind === 'detail');
    const summaries = rows.filter((r) => r.recordKind === 'summary');
    const independent = new Map(audit.sample.map((s) => [s.sourceId, s.independentRoute]));
    assert.equal(audit.sample.length, audit.sampleSize);
    assert.deepEqual([...independent.keys()].sort(), details.map((r) => r.sourceId).sort(), `${c} 盲判一条不缺`);
    for (const s of audit.sample) assert.ok(ROUTES.includes(s.independentRoute) && s.why.length >= 4 && typeof s.rubric === 'string', `${c} ${s.sourceId}`);
    // 主判与盲判不一致的条目照实留底：两人原判都在，裁决标 v3-tiebreak，条数与清单记的一致。
    const tied = audit.sample.filter((s) => 'blindRoute' in s);
    assert.equal(tied.length, audit.firstRoundDisagreements, c);
    for (const s of tied) assert.ok(s.primaryRoute !== s.blindRoute && ROUTES.includes(s.primaryRoute) && ROUTES.includes(s.blindRoute) && s.rubric === 'v3-tiebreak', `${c} ${s.sourceId}`);
    for (const s of audit.sample.filter((x) => !('blindRoute' in x))) assert.equal(s.rubric, 'v3', `${c} ${s.sourceId}`);
    assert.equal(Object.values(audit.tiebreakSidedWith).reduce((a, b) => a + b, 0), tied.length, c);
    const route = new Map(rows.map((r) => [r.sourceId, r.route]));
    const differs = (r) => independent.get(r.summaryOf ?? r.sourceId) !== route.get(r.sourceId); // 汇总行的独立去向随它指回的明细
    assert.deepEqual(audit.disagreements, details.filter(differs).map((r) => r.sourceId), `${c} 分歧照实列出`);
    const total = rows.filter(differs).length;
    assert.ok(total / rows.length <= 0.07, `${c} 全表分歧 ${total}/${rows.length}`);
    const nd = Math.ceil(details.length * 0.1);
    const ns = Math.ceil(summaries.length * 0.1);
    assert.ok((nd + ns) / rows.length >= 0.1);
    let worst = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const rand = rng(Math.imul(seed, 0x9e3779b1));
      const picked = [...draw(details, nd, rand), ...draw(summaries, ns, rand)];
      const n = picked.filter(differs).length;
      worst = Math.max(worst, n);
      assert.ok(n / picked.length <= 0.1, `${c} 种子 ${seed}：分歧 ${n}/${picked.length}`);
    }
    t.diagnostic(`${c}：全表分歧 ${total}/${rows.length}；首轮两人不一致 ${audit.firstRoundDisagreements} 条；200 组种子里最差一组 ${worst}/${nd + ns}`);
    merged.details.push(...details.map((r) => [c, r]));
    merged.summaries.push(...summaries.map((r) => [c, r]));
    merged.differs.set(c, differs);
  });
  // 三份合并再抽一遍。
  const nd = Math.ceil(merged.details.length * 0.1);
  const ns = Math.ceil(merged.summaries.length * 0.1);
  assert.ok(nd + ns >= 183, `合并抽样 ${nd + ns} 条`);
  let worst = 0;
  for (let seed = 1; seed <= 200; seed += 1) {
    const rand = rng(Math.imul(seed, 0x85ebca6b));
    const picked = [...draw(merged.details, nd, rand), ...draw(merged.summaries, ns, rand)];
    const n = picked.filter(([c, r]) => merged.differs.get(c)(r)).length;
    worst = Math.max(worst, n);
    assert.ok(n / picked.length <= 0.1, `合并种子 ${seed}：分歧 ${n}/${picked.length}`);
  }
  t.diagnostic(`三份合并：200 组种子里最差一组 ${worst}/${nd + ns}`);
});

test('定稿后的独立终验抽检：每份随机抽 ≥ 10% 明细再判一遍，与总账的分歧 ≤ 10%，照实列出', (t) => {
  let all = 0;
  let bad = 0;
  each((c, { manifest: m }) => {
    const v = m.audit.verification;
    assert.ok(v, `${c} 要有终验抽检`);
    const route = new Map(m.rows.filter((r) => r.recordKind === 'detail').map((r) => [r.sourceId, r.route]));
    assert.equal(v.sample.length, v.sampleSize);
    assert.equal(new Set(v.sample.map((s) => s.sourceId)).size, v.sample.length);
    assert.ok(v.sample.length >= Math.ceil(m.detailEntries * 0.1), `${c} 抽 ${v.sample.length}/${m.detailEntries}`);
    for (const s of v.sample) assert.ok(route.has(s.sourceId) && ROUTES.includes(s.independentRoute), `${c} ${s.sourceId}`);
    const dis = v.sample.filter((s) => route.get(s.sourceId) !== s.independentRoute).map((s) => s.sourceId);
    assert.deepEqual(v.disagreements, dis, c);
    assert.ok(dis.length / v.sample.length <= 0.1, `${c} 终验分歧 ${dis.length}/${v.sample.length}`);
    all += v.sample.length;
    bad += dis.length;
    t.diagnostic(`${c}：终验抽 ${v.sample.length} 条，分歧 ${dis.length}（${dis.join(',')}）`);
  });
  assert.ok(bad / all <= 0.1, `合并终验分歧 ${bad}/${all}`);
});
