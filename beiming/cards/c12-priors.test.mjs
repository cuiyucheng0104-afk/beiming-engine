import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  C12_COLLECTIONS,
  loadFxUiPriorsStore,
  loadMatHardsurfPriorsStore,
  loadRenderPipePriorsStore,
  loadBatch3PriorsStore,
  getBatch3CardPriors,
  getBatch3Practices,
  getBatch3MigrationManifest,
} from './priors-batch3.mjs';
import * as cards from './index.mjs';
import { PRIOR_UNITS, createPriorsStore, scanPriorLeaks, validatePriorsTable } from './priors.mjs';

const dataDir = new URL('./priors-data/', import.meta.url);
const raw = (name) => readFileSync(new URL(name, dataDir), 'utf8');
const isSummary = (e) => Object.hasOwn(e, 'summaryOf');

const EXPECTED_TOTALS = Object.freeze({
  'fx-ui': { total: 528, detail: 388, summary: 140 },
  'mat-hardsurf': { total: 759, detail: 656, summary: 103 },
  'render-pipe': { total: 287, detail: 186, summary: 101 },
});

const EXPECTED_SHA256 = Object.freeze({
  'fx-ui.json': 'ccbf199238b4ea1aafdfa32bfc0d8a707330643f9a58e1986ec825de4c37f0ab',
  'fx-ui.card-priors.json': '018ecd90ec657435edb004816883ce49c20a438fb7d26ea4c16c756380290e70',
  'fx-ui.practices.json': '16c7e6e911db890133313116e35a6f9466e8cbd4909513508cfcc4bf7443bfb0',
  'fx-ui.manifest.json': 'b7641254de9ad8508be81e1a453b5a0fdd06a4f6836c967323df33078c6151a3',
  'mat-hardsurf.json': '7acb3bc145ad78eeaf00eaf43b65040eba058d056da67bed5c73ba57c557c274',
  'mat-hardsurf.card-priors.json': '762c3c8a0fd87de4d9af80da47330ac0712d516431a704c2790febcfc3ed19ec',
  'mat-hardsurf.practices.json': '4b45fb71a2a6441e214a66b7132c55749f2b8aac874ffccec633a8e7f77fc71a',
  'mat-hardsurf.manifest.json': '002dc1d1d56859d72678a3f7f24ba4641c7b0ec80b87cb976fcb2836bb598005',
  'render-pipe.json': '77c74d80376243d28044073726e84bd41e550be0096c6fe38ec136336605fd95',
  'render-pipe.card-priors.json': '1e124637a52af64e7711e992390187c783cb13b95b05bc1fea65b754f7a79831',
  'render-pipe.practices.json': 'c6d54b574250d22c8b4794ac8c3e3eaef62db14ff289e0547cceea4888b146ac',
  'render-pipe.manifest.json': '3a4c082f6bd2be829aaf52ec5f6955bb0cdf64aac64acb50696bc025fd3f3a1b',
});

// 05 §5 全部 92 张正式技术卡清单（挂卡 target/cardId 必须严格落在此集合内）
const OFFICIAL_92_SET = new Set([
  'time.timeline', 'time.envelope', 'time.events', 'time.seeded', 'camera.spline',
  'post.hdr-chain', 'comp.display', 'comp.finish', 'deliver.encode', 'audio.master',
  'blender.cycles', 'blender.state-keys', 'overlay.title', 'layout.panels', 'camera.orbit',
  'time.cut-grid', 'time.narration', 'time.narration-est', 'overlay.subs', 'overlay.cursor',
  'audio.event-mix', 'audio.align', 'page.det2d', 'camera.cue-kf', 'camera.drift',
  'assembly.dsl', 'assembly.schedule', 'assembly.explode', 'asset.bbox-proxy', 'camera.fit',
  'light.studio', 'mat.library', 'mat.bevel-node', 'mat.ao-ink', 'look.plated',
  'form.primitives', 'form.superloft', 'particle.ballistic', 'fx.streak-ring', 'camera.shake',
  'motion.snap', 'rig.rigid-ik', 'asset.stl-kit', 'asset.glb-bridge', 'overlay.anchored',
  'audio.drums', 'blur.subframe', 'three.patch', 'post.ao', 'post.bloom',
  'post.volumetric', 'post.grade-cl', 'post.lens-fx', 'fx.post-state', 'motion.sweep-body',
  'motion.roll-bank', 'motion.swim', 'motion.impulse', 'particle.premult', 'particle.soft',
  'particle.minpx', 'fx.breath', 'light.emit-pool', 'time.bake', 'atmo.height-fog',
  'shade.px-lod', 'shade.thin-line', 'shade.toon-kit', 'shade.hull-outline', 'comp.tonemap-hybrid',
  'post.hue-keep', 'post.grade-lut', 'post.bilateral-up', 'light.pcss', 'light.sun-fill',
  'light.hdri-sun', 'shade.shell-fur', 'motion.retarget', 'motion.ik2', 'motion.weapon-track',
  'motion.weigh', 'motion.spring-chain', 'motion.wing', 'particle.on-twos', 'particle.ambient',
  'form.sdf-nets', 'shade.scales', 'wind.gust-wake', 'camera.relative', 'audio.sfx-bank',
  'audio.scene-events', 'sky.cloud-toon',
]);

// 脱敏黑名单（作品名、角色名、品牌/硬件型号、真实地名等）的小写词元 SHA-256 前 16 位；明文不入库
const IP_HASHES = new Set([
  '016c4a54bc4b3103', '033fddb8853a1ad0', '049667efe4e69d1c', '0871d655983efd56',
  '089dd4929e658cdb', '09cf980b5ff304ac', '0a450f78e4551525', '0a7e404732db8f48',
  '0b2058635ba3d17f', '0c60185839ff2327', '0e377aac3a660698', '1351704cdc4d32f8',
  '13d00b4f50b002bf', '1472950b8ae0b5cd', '14e59f423e87958e', '15fc0e2c60b40ae1',
  '180bd8604df67b59', '18cc32c921b8e0be', '1ae0552a12823c54', '1c18bc2214f67ae1',
  '1f25b77eea9b8db1', '1fe8ba945043480d', '20b836be6317bc4c', '21f9f830edf15d42',
  '234330834c41105a', '241c1e30ed886aa4', '249993eec332cb78', '25d3e422e9a0730c',
  '2648b1fece5ca102', '2780b8eef998d6ea', '2bf84b0ad08b23b8', '2c5ed0922cc21476',
  '2d94fe98376d814d', '2f55b64c59eec8e5', '34bb03e8d85ab74a', '374eebfb2bae1290',
  '39fabf3d2bf91ace', '3a7bd3e2360a3d29', '3b54664e8163d36a', '3cb95ec0c6cc1835',
  '3f4a09b92ccf3382', '3f8f01ea269b6cfe', '400e436ed3eb0252', '40a7e9acb06295d6',
  '419a4461434283fd', '41bc72708c799dbc', '4ed91096f08e52f6', '4f594364d6326c96',
  '5017133fdc0a9bbb', '501d5acb4acc06d8', '5032f1bea2401f8f', '50537dab76505dfc',
  '50b2676afbe30c83', '515f3f510efacd0b', '5873102fa0951713', '58857e5318f3090b',
  '58d07b8a69516695', '58e8d9ca391c1ea9', '599917fb5a47d4ba', '59ee9ed12f7822d8',
  '5b79d0d574eedd09', '5f226262ba09e0ec', '5f6e7773915655fc', '60eb33388f4e0888',
  '64168e1ca791c61b', '65db8c764322e4f5', '6df977461d522f10', '75d28e035320c596',
  '75ff6821b8f8a31f', '7827e8eb2cb3b95f', '7c27b222a1dfa422', '7edbff10b5f7627e',
  '81678972842d4663', '8318900ae631b424', '8534cd0426607ce6', '8540d5ac82d1cc90',
  '857689a99bb12c62', '85ef3bae7236215b', '86663a1dd8f6b661', '89e1ed6c1d606797',
  '8b567a9cad647151', '8bdb247a2a76e166', '8be2978e343799a3', '8c6e8e8b9a0eb983',
  '8d4321d936320802', '8d6546721a1d106c', '91826add52a73308', '924493ee15e2a68c',
  '930eaf1684b953a9', '95a84911801a7130', '95b3ec132e6e5bfc', '963cd73004547f84',
  '98162a1e33275f16', '9eebe6aa942221a6', 'a0c0485eff9c817d', 'a309ac16ce1299ea',
  'a38188f3bafbcb73', 'a4c745facd3a9215', 'a590c43e71d44866', 'a6c0db788b589b10',
  'a7a4ded2d5035adb', 'aa416dab2cc47c86', 'ac13a8b534df4a28', 'acef2270f1204c8f',
  'afe04579004049cc', 'b05a020b94ff9f43', 'b2a4e476bb0cf3df', 'b41e6560a4467aa4',
  'b4832b04946a62a9', 'b6f6732db83b899a', 'bb1d46105bd704dc', 'bbdefa2950f49882',
  'bd732730bd39834d', 'bdf4949a46682dc3', 'c2326100129a9f9d', 'c26804e0eaf84a96',
  'c6661966bce79f30', 'c83c91fa43a37540', 'c857d09db23e6822', 'c99c21d86b0e1e4b',
  'cc37957cb6ba0e57', 'ceb6e5e5dab9b0f4', 'cf2abf0c5be326cb', 'd055c3998f13e70e',
  'd0b3b3d6c6c14f17', 'd14a7310bdf55b8f', 'd209bcc17778fd19', 'd4c58781c552db46',
  'd544b0316e19a87b', 'd8e60ebbbb2b1a9d', 'd9bb8452ecaf5a05', 'dbd7eae813c1dc02',
  'dc7a4a2cc7e36000', 'dd415e6f13d54a9b', 'dd9ab072bf740423', 'de0ba1b766697343',
  'e16702398a9a3929', 'e3f341fd8cb7a18c', 'e410993439c435f9', 'e5993ec06c2e0d77',
  'e6deb10a6558650a', 'e708e75b162e33f3', 'ecc9bddb65dc4451', 'ed818ec233248ae6',
  'ede9a01d7031cce4', 'f09bfa2c3c7042e4', 'f27354a69b790eda', 'f333c862259bb361',
  'f4a6923996dbeb19', 'f5b984831b2d99e5', 'fceb694b3d7420f9', 'fd41ccf562904e20',
  'fd8ecd2d4d814e68', 'fdb827d1a99796cd', 'ff627719813c923a', 'ff7b676cdada9bca',
]);

// 分区与源项目内部专名键的 SHA-256 前 16 位；明文不入库
const REGION_KEY_HASHES = new Set([
  '06f8e2ae03f7ec87', '07f0bf736c13b81f', '0b1df33ea7eef2b2', '14fc1fd907298aaa',
  '196cecb58d133eb0', '1dd31cd072fdd30f', '1e445d2d4b31efe2', '26dd587fdb6a290c',
  '2a7faaf70333cde4', '36997f035118cae8', '36ad0f15e388a8ce', '3d826890267c02bd',
  '3d85ee4f370e7579', '3d8c28f257964498', '3eef1f7226e1215e', '40fe6b860770436f',
  '4fac0361bcb7b771', '55e4e874c9f996f1', '619df91bac841eda', '63dbdfb4c910db1e',
  '75f128184099aaa2', '7e8672748ae4410e', '8aec299118b83ebd', '9e70b33fe4edaf5b',
  'a276bb8a748ddb9c', 'a624f2d4371bbd82', 'a819d7cd38e9101b', 'aaa1073bd98fd4e7',
  'ad21b547ce7162c5', 'b0be237b71b69a0d', 'b1f49128310e2481', 'b3158331cecc3845',
  'b9b13e1cd77acbd7', 'bcca17804247899c', 'bd54e7d6e49bd448', 'c8b40f3f8920b8aa',
  'ca71d3ec52ddc852', 'd4fff627da31250b', 'dc8331bcb2283e89', 'e5a6d6899f2e6e04',
  'e7620a32095f6909', 'ed4561f685f13353', 'ee839bf111a7e47a', 'f1ed891245759d1c',
  'f34d80eb22b1490a', 'f8158a8e962d1201', 'fba3a504b35a8d53',
]);

const sha16 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function collectNgrams(rawText) {
  const grams = new Set();
  const text = rawText
    .replace(/['’]s\b/g, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
  const words = text.match(/[a-z0-9]+/g) ?? [];
  words.forEach((_, i) => {
    for (let n = 1; n <= 3 && i + n <= words.length; n += 1) {
      grams.add(words.slice(i, i + n).join(' '));
    }
  });
  for (const run of text.match(/[一-鿿]{2,}/g) ?? []) {
    for (let i = 0; i < run.length; i += 1) {
      for (let n = 2; n <= 5 && i + n <= run.length; n += 1) {
        grams.add(run.slice(i, i + n));
      }
    }
  }
  return grams;
}

function mulberry32(seed) {
  let a = Math.imul(seed, 0x9e3779b1) >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleWithoutReplacement(items, count, rng) {
  const copy = items.slice();
  const n = Math.min(count, copy.length);
  for (let i = 0; i < n; i += 1) {
    const j = i + Math.floor(rng() * (copy.length - i));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy.slice(0, n);
}

const close = (a, b) => Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(a), Math.abs(b));

function extractNumbersFromText(text) {
  const t = String(text || '').replaceAll('−', '-');
  const out = [];
  for (const m of t.matchAll(/(?<![\d,.])-?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\d,])/g)) {
    out.push(Number(m[0].replaceAll(',', '')));
  }
  for (const m of t.matchAll(/(?<![\d.])-?(?:\d+(?:\.\d+)?|\.\d+)/g)) {
    out.push(Number(m[0]));
  }
  return out.filter(Number.isFinite);
}

function hexToRgbDisplay(hex) {
  const clean = hex.replace(/^#/, '');
  const round = (x) => Math.round(x * 1e6) / 1e6;
  return [
    round(parseInt(clean.slice(0, 2), 16) / 255),
    round(parseInt(clean.slice(2, 4), 16) / 255),
    round(parseInt(clean.slice(4, 6), 16) / 255),
  ];
}

function verifyValueInNote(value, note, unit, ext) {
  if (unit === 'rgb-display') {
    const hex = ext?.['c12.hex'];
    if (typeof hex !== 'string' || !note.toUpperCase().includes(hex.toUpperCase())) return false;
    const expected = hexToRgbDisplay(hex);
    return Array.isArray(value) && value.length === 3 && value.every((v, i) => close(v, expected[i]));
  }
  const found = extractNumbersFromText(note);
  const vals = typeof value === 'number'
    ? [value]
    : Array.isArray(value)
      ? value
      : Object.values(value);
  if (vals.length === 0 || !vals.every((v) => typeof v === 'number' && Number.isFinite(v))) return false;
  for (const v of vals) {
    const direct = found.some((n) => (
      close(n, v)
      || close(-n, v)
      || close(n * 1000, v)
      || close(n / 100, v)
      || (n >= 2 && Number.isInteger(n) && close(1 / n, v))
    ));
    if (direct) continue;
    const pmHit = Array.isArray(value)
      && value.length === 2
      && found.some((a) => found.some((b) => close(a - Math.abs(b), value[0]) && close(a + Math.abs(b), value[1])));
    if (!pmHit) return false;
  }
  return true;
}

const DATA = Object.fromEntries(C12_COLLECTIONS.map((col) => {
  const priorsText = raw(`${col}.json`);
  const cardPriorsText = raw(`${col}.card-priors.json`);
  const practicesText = raw(`${col}.practices.json`);
  const manifestText = raw(`${col}.manifest.json`);
  return [col, {
    priorsText,
    priors: JSON.parse(priorsText).entries,
    cardPriors: JSON.parse(cardPriorsText).entries,
    practices: JSON.parse(practicesText).entries,
    manifest: getBatch3MigrationManifest(col),
    raws: {
      [`${col}.json`]: priorsText,
      [`${col}.card-priors.json`]: cardPriorsText,
      [`${col}.practices.json`]: practicesText,
      [`${col}.manifest.json`]: manifestText,
    },
  }];
}));

test('C12 公开 API 完整导出、可加载且拒绝非法集合名', () => {
  assert.deepEqual(C12_COLLECTIONS, ['fx-ui', 'mat-hardsurf', 'render-pipe']);
  assert.equal(Object.isFrozen(C12_COLLECTIONS), true);

  const exported = [
    'C12_COLLECTIONS',
    'loadFxUiPriorsStore',
    'loadMatHardsurfPriorsStore',
    'loadRenderPipePriorsStore',
    'loadBatch3PriorsStore',
    'getBatch3CardPriors',
    'getBatch3Practices',
    'getBatch3MigrationManifest',
  ];
  for (const name of exported) {
    assert.ok(name in cards, `index.mjs 缺少导出 ${name}`);
  }
  assert.equal(cards.C12_COLLECTIONS, C12_COLLECTIONS);
  assert.equal(cards.loadFxUiPriorsStore, loadFxUiPriorsStore);
  assert.equal(cards.loadMatHardsurfPriorsStore, loadMatHardsurfPriorsStore);
  assert.equal(cards.loadRenderPipePriorsStore, loadRenderPipePriorsStore);
  assert.equal(cards.loadBatch3PriorsStore, loadBatch3PriorsStore);
  assert.equal(cards.getBatch3CardPriors, getBatch3CardPriors);
  assert.equal(cards.getBatch3Practices, getBatch3Practices);
  assert.equal(cards.getBatch3MigrationManifest, getBatch3MigrationManifest);

  assert.equal(loadFxUiPriorsStore(), loadBatch3PriorsStore('fx-ui'));
  assert.equal(loadMatHardsurfPriorsStore(), loadBatch3PriorsStore('mat-hardsurf'));
  assert.equal(loadRenderPipePriorsStore(), loadBatch3PriorsStore('render-pipe'));

  for (const bad of ['unknown', '', '__proto__', 'toString', 'constructor', null, 123, {}]) {
    assert.throws(() => loadBatch3PriorsStore(bad), RangeError);
    assert.throws(() => getBatch3MigrationManifest(bad), RangeError);
    assert.throws(() => getBatch3CardPriors('post.bloom', bad), RangeError);
    assert.throws(() => getBatch3Practices(bad), RangeError);
  }

  for (const unknownCard of ['nonexistent.card', '', null, undefined, 42]) {
    const res = getBatch3CardPriors(unknownCard);
    assert.deepEqual(res, []);
    assert.equal(Object.isFrozen(res), true);
  }
});

test('12 份 JSON 原文 SHA-256 校验锁定且零 C9 泄露', () => {
  const actualFiles = readdirSync(dataDir)
    .filter((f) => C12_COLLECTIONS.some((c) => f.startsWith(`${c}.`)))
    .sort();
  assert.deepEqual(actualFiles, Object.keys(EXPECTED_SHA256).sort());
  assert.equal(actualFiles.length, 12);

  for (const fname of actualFiles) {
    const content = raw(fname);
    assert.equal(sha256(content), EXPECTED_SHA256[fname], `文件摘要变更：${fname}`);
    assert.deepEqual(scanPriorLeaks(content), [], `C9 泄露扫描命中：${fname}`);
    assert.equal(content.includes('"_raw"'), false, `不应含内部字段 _raw：${fname}`);
  }
});

test('三份可移植先验整表过 C9：0 错误、0 泄露、单位与色彩空间合规、全部未读回', () => {
  for (const col of C12_COLLECTIONS) {
    const { priorsText, priors } = DATA[col];
    const checked = validatePriorsTable(priorsText);
    assert.deepEqual(checked.errors, [], `${col} errors`);
    assert.deepEqual(checked.leaks, [], `${col} leaks`);
    assert.equal(checked.ok, true, col);

    const store = loadBatch3PriorsStore(col);
    const view = store.query({ limit: 1 })[0];
    assert.ok(view, `${col} 至少有 1 条可移植先验`);
    assert.equal(view.readbackLabel, '未在我方读回');

    for (const e of priors) {
      assert.ok(PRIOR_UNITS.includes(e.unit), `${e.id}: unit=${e.unit}`);
      assert.notEqual(e.unit, 'count', `${e.id}: 场景计数预算不得进入 portable`);
      assert.equal(e.verifiedInOurStack, false, e.id);
      assert.equal(Object.hasOwn(e, 'readbackEvidence'), false, e.id);

      if (e.unit === 'rgb-linear') {
        assert.equal(e.colorSpace, 'scene-linear-rec709', e.id);
        assert.ok(Array.isArray(e.value) && (e.value.length === 3 || e.value.length === 4), e.id);
      } else if (e.unit === 'rgb-display') {
        assert.equal(e.colorSpace, 'srgb-display', e.id);
        assert.ok(Array.isArray(e.value) && (e.value.length === 3 || e.value.length === 4), e.id);
        assert.match(e.ext?.['c12.hex'] ?? '', /^#[0-9A-F]{6}$/, e.id);
      } else {
        assert.equal(Object.hasOwn(e, 'colorSpace'), false, `${e.id}: 非颜色单位不得带 colorSpace`);
      }
    }
  }
});

test('loadBatch3PriorsStore 原文直传 C9：三集合篡改插入重复 JSON 键必报 prior.duplicate-key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c12-dup-key-'));
  try {
    cpSync(new URL('./priors.mjs', import.meta.url), join(dir, 'priors.mjs'));
    cpSync(new URL('./priors-batch3.mjs', import.meta.url), join(dir, 'priors-batch3.mjs'));
    cpSync(dataDir, join(dir, 'priors-data'), { recursive: true });

    for (const col of C12_COLLECTIONS) {
      const p = join(dir, 'priors-data', `${col}.json`);
      const original = readFileSync(p, 'utf8');
      const tampered = original.replace('"verifiedInOurStack": false', '"verifiedInOurStack": false, "verifiedInOurStack": false');
      assert.notEqual(tampered, original, col);
      writeFileSync(p, tampered, 'utf8');
    }

    const mod = await import(`${pathToFileURL(join(dir, 'priors-batch3.mjs')).href}?t=${Date.now()}`);
    for (const [label, fn] of [
      ['fx-ui', () => mod.loadFxUiPriorsStore()],
      ['mat-hardsurf', () => mod.loadMatHardsurfPriorsStore()],
      ['render-pipe', () => mod.loadRenderPipePriorsStore()],
    ]) {
      assert.throws(fn, /prior\.duplicate-key|重复键|invalid/, `重复键未被拦截：${label}`);
    }
    assert.throws(
      () => createPriorsStore('{"format":"priors/0.1","format":"priors/0.1","entries":[]}'),
      /prior\.duplicate-key|重复键|invalid/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('1,574 条总账严密闭合：528 + 759 + 287，四路计数与各产物条目一一对应', () => {
  let grandTotal = 0;
  for (const col of C12_COLLECTIONS) {
    const exp = EXPECTED_TOTALS[col];
    const { priors, cardPriors, practices, manifest } = DATA[col];
    const { ledger } = manifest;
    grandTotal += ledger.length;

    assert.equal(manifest.collection, col);
    assert.equal(manifest.totalSourceEntries, exp.total, col);
    assert.equal(manifest.detailEntries, exp.detail, col);
    assert.equal(manifest.summaryRows, exp.summary, col);
    assert.equal(exp.detail + exp.summary, exp.total, col);
    assert.equal(ledger.length, exp.total, col);
    assert.equal(new Set(ledger.map((r) => r.sourceId)).size, exp.total, col);

    for (let i = 1; i < ledger.length; i += 1) {
      assert.ok(ledger[i].sourceLine >= ledger[i - 1].sourceLine, `${col}: sourceLine 非单调 ${ledger[i].sourceId}`);
    }

    const detailRows = ledger.filter((r) => r.kind === 'detail');
    const summaryRows = ledger.filter((r) => r.kind === 'summary');
    assert.equal(detailRows.length, exp.detail, col);
    assert.equal(summaryRows.length, exp.summary, col);

    const routeTotals = {
      portable: manifest.portableCount,
      'card-coupled': manifest.cardCoupledCount,
      practice: manifest.practiceCount,
      'skipped-or-conflict': manifest.excludedOrConflictCount,
    };
    assert.equal(Object.values(routeTotals).reduce((a, b) => a + b, 0), exp.total, col);
    for (const [route, n] of Object.entries(routeTotals)) {
      assert.equal(ledger.filter((r) => r.route === route).length, n, `${col}.${route}`);
      assert.equal(detailRows.filter((r) => r.route === route).length, manifest.detailRouteCounts[route], `${col}.detail.${route}`);
      assert.equal(summaryRows.filter((r) => r.route === route).length, manifest.summaryRouteCounts[route], `${col}.summary.${route}`);
      assert.equal(manifest.detailRouteCounts[route] + manifest.summaryRouteCounts[route], n, `${col}.sum.${route}`);
    }

    const detailMap = new Map(detailRows.map((r) => [r.sourceId, r]));
    const pools = {
      portable: new Set(priors.map((e) => e.id)),
      'card-coupled': new Set(cardPriors.map((e) => e.id)),
      practice: new Set(practices.map((e) => e.id)),
    };
    const seen = { portable: new Set(), 'card-coupled': new Set(), practice: new Set() };
    const excludedIds = new Set(manifest.excluded.map((x) => x.sourceId));

    for (const r of ledger) {
      if (r.kind === 'summary') {
        const parent = detailMap.get(r.summaryOf);
        assert.ok(parent, `${col} ${r.sourceId} summaryOf=${r.summaryOf} 必须指向真实明细`);
        assert.equal(r.route, parent.route, `${col} ${r.sourceId} 去向必须随明细`);
        if (parent.route === 'card-coupled') {
          assert.equal(r.cardId, parent.cardId, `${col} ${r.sourceId} cardId 必须随明细`);
          assert.equal(r.target, parent.target, `${col} ${r.sourceId} target 必须随明细`);
        }
        assert.ok(r.link === 'values' || r.link === 'gist', `${col} ${r.sourceId} link=${r.link}`);
        if (r.caseId !== parent.caseId) {
          assert.ok(
            parent.caseId === 'case-multi' && Array.isArray(parent.coveredCases) && parent.coveredCases.includes(r.caseId),
            `${col} ${r.sourceId} 跨案例汇总须指回覆盖该案例的明细`,
          );
        }
        if (r.alsoSummarizes) {
          assert.ok(Array.isArray(r.alsoSummarizes) && r.alsoSummarizes.length > 0);
          for (const extra of r.alsoSummarizes) {
            assert.notEqual(extra, r.summaryOf);
            assert.ok(detailMap.has(extra), `${col} ${r.sourceId} alsoSummarizes=${extra}`);
          }
        }
      }

      if (r.route === 'skipped-or-conflict') {
        assert.deepEqual(r.targets, [], `${col} ${r.sourceId}`);
        if (r.kind === 'detail') assert.ok(excludedIds.has(r.sourceId), `${col} ${r.sourceId} 缺少 excluded 留档`);
        continue;
      }

      if (r.kind === 'detail') {
        assert.ok(r.targets.length > 0, `${col} ${r.sourceId} 明细必须有产出`);
      } else if (r.route !== 'portable') {
        assert.deepEqual(r.targets, [], `${col} ${r.sourceId} 非 portable 汇总不得重复落条目`);
      }

      for (const tid of r.targets) {
        assert.ok(pools[r.route].has(tid), `${col} ${r.sourceId} target=${tid} 不在目标池`);
        assert.equal(seen[r.route].has(tid), false, `${col} ${tid} 重复归账`);
        seen[r.route].add(tid);
      }
    }

    assert.equal(seen.portable.size, pools.portable.size, `${col} portable 池未闭合`);
    assert.equal(seen['card-coupled'].size, pools['card-coupled'].size, `${col} card-coupled 池未闭合`);
    assert.equal(seen.practice.size, pools.practice.size, `${col} practice 池未闭合`);
    assert.equal(manifest.excluded.length, manifest.detailRouteCounts['skipped-or-conflict'], `${col} excluded 计数闭合`);
    assert.equal(manifest.emittedCounts.priorsTotal, priors.length);
    assert.equal(manifest.emittedCounts.priorsDetail, priors.filter((e) => !isSummary(e)).length);
    assert.equal(manifest.emittedCounts.priorsSummary, priors.filter(isSummary).length);
    assert.equal(manifest.emittedCounts.cardPriors, cardPriors.length);
    assert.equal(manifest.emittedCounts.practices, practices.length);
  }
  assert.equal(grandTotal, 1574);
});

test('汇总先验行严格指回同量同单位真实明细，store.stats 不重复计数', () => {
  for (const col of C12_COLLECTIONS) {
    const { priors, manifest } = DATA[col];
    const byId = new Map(priors.map((e) => [e.id, e]));
    const ledgerByTarget = new Map();
    for (const r of manifest.ledger) {
      for (const t of r.targets) ledgerByTarget.set(t, r);
    }

    const summaries = priors.filter(isSummary);
    assert.ok(summaries.length > 0, `${col} 应有汇总先验行`);
    for (const s of summaries) {
      assert.ok(Array.isArray(s.summaryOf) && s.summaryOf.length > 0, s.id);
      assert.equal(new Set(s.summaryOf).size, s.summaryOf.length, s.id);
      assert.equal(s.summaryOf.includes(s.id), false, s.id);

      const lRow = ledgerByTarget.get(s.id);
      assert.equal(lRow?.kind, 'summary', s.id);
      assert.equal(lRow?.link, 'values', `${s.id}: 仅 link=values 的汇总行可产出先验`);

      for (const did of s.summaryOf) {
        const d = byId.get(did);
        assert.ok(d, `${s.id} -> ${did}`);
        assert.equal(isSummary(d), false, `${s.id} 不能指回汇总行 ${did}`);
        assert.equal(d.topic, s.topic, `${s.id} topic 须与 ${did} 一致`);
        assert.equal(d.unit, s.unit, `${s.id} unit 须与 ${did} 一致`);
        assert.equal(d.colorSpace, s.colorSpace, `${s.id} colorSpace 须与 ${did} 一致`);
      }
    }

    const stats = loadBatch3PriorsStore(col).stats();
    assert.equal(stats.detailCount, priors.length - summaries.length, col);
    assert.equal(stats.summaryCount, summaries.length, col);
    assert.equal(stats.totalEntries, priors.length, col);
    assert.equal(stats.verifiedCount, 0, col);
  }
});

test('挂卡先验严格取自 05 §5 的 92 张正式卡、cardId===target 且绝不当默认值；做法表结构合规', () => {
  const allPractices = getBatch3Practices();
  let practiceTotal = 0;

  for (const col of C12_COLLECTIONS) {
    const { cardPriors, practices, manifest } = DATA[col];
    practiceTotal += practices.length;
    assert.equal(getBatch3Practices(col).length, practices.length);

    const countsByCard = new Map();
    for (const e of cardPriors) {
      assert.ok(OFFICIAL_92_SET.has(e.cardId), `${col} ${e.id}: 非法技术卡 ${e.cardId}`);
      assert.equal(e.cardId, e.target, `${col} ${e.id}: cardId 必须等于 target`);
      assert.equal(e.useAsDefault, false, e.id);
      assert.equal(e.verifiedInOurStack, false, e.id);
      assert.ok(typeof e.coupling === 'string' && e.coupling.length > 0, e.id);
      assert.ok(typeof e.recalibrate === 'string' && e.recalibrate.length > 0, e.id);
      assert.ok(Array.isArray(e.quantities), e.id);
      for (const q of e.quantities) {
        assert.equal(Object.hasOwn(q, '_raw'), false, `${e.id} quantities 不得含内部字段 _raw`);
      }
      countsByCard.set(e.cardId, (countsByCard.get(e.cardId) || 0) + 1);
    }

    assert.equal(manifest.cards.length, countsByCard.size, col);
    for (const c of manifest.cards) {
      assert.ok(OFFICIAL_92_SET.has(c.cardId), `${col} manifest.cards 非法卡 ${c.cardId}`);
      assert.equal(c.cardId, c.target, `${col} manifest.cards cardId===target`);
      assert.equal(c.inSpec, true);
      assert.equal(c.count, countsByCard.get(c.cardId), `${col} ${c.cardId} 计数`);
      assert.equal(getBatch3CardPriors(c.cardId, col).length, c.count, `${col} ${c.cardId} 查询`);
    }

    for (const p of practices) {
      assert.ok(p.kind === 'method' || p.kind === 'fix', `${p.id}: kind=${p.kind}`);
      assert.ok(typeof p.title === 'string' && p.title.length > 0, p.id);
      assert.ok(typeof p.text === 'string' && p.text.length > 0, p.id);
      assert.ok(typeof p.docRef === 'string' && p.docRef.length > 0, p.id);
      for (const q of p.quantities) {
        assert.equal(Object.hasOwn(q, '_raw'), false, `${p.id} quantities 不得含内部字段 _raw`);
      }
    }
  }

  assert.equal(allPractices.length, practiceTotal);
  const bloomAll = getBatch3CardPriors('post.bloom');
  const bloomSum = C12_COLLECTIONS.reduce((acc, col) => acc + getBatch3CardPriors('post.bloom', col).length, 0);
  assert.equal(bloomAll.length, bloomSum);
  assert.ok(bloomAll.length > 0);
});

test('冲突挂接、caseId 规范与案例 13 章号修复一致', () => {
  const CASE_ID_RE = /^case-(?:\d{2,3}(?:r|-legacy|-original)?|ext\d{2}|multi)$/;
  const expectedAttached = { 'fx-ui': 1, 'mat-hardsurf': 6, 'render-pipe': 5 };

  for (const col of C12_COLLECTIONS) {
    const { priors, cardPriors, practices, manifest } = DATA[col];
    const byId = new Map(priors.map((e) => [e.id, e]));

    for (const id of [
      ...manifest.ledger.map((r) => r.caseId),
      ...priors.map((e) => e.provenance.caseId),
      ...cardPriors.map((e) => e.caseId),
      ...practices.map((e) => e.caseId),
      ...manifest.conflicts.map((c) => c.caseId),
    ]) {
      assert.match(id, CASE_ID_RE, `${col} 非法 caseId: ${id}`);
    }

    // 案例 13 章号不重复附加
    for (const ref of [
      ...priors.map((e) => e.provenance.docRef),
      ...cardPriors.map((e) => e.docRef),
      ...practices.map((e) => e.docRef),
    ]) {
      const chMatches = ref.match(/（案例 13 第 \d+ 章/g) || [];
      assert.ok(chMatches.length <= 1, `${col} 重复章号后缀：${ref}`);
    }

    let attachedConflicts = 0;
    for (const c of manifest.conflicts) {
      assert.ok(typeof c.sourceId === 'string' && c.sourceId.length > 0);
      assert.ok(typeof c.detail === 'string' && c.detail.length > 0);
      if (Array.isArray(c.attachedTo) && c.attachedTo.length > 0) {
        attachedConflicts += 1;
        for (const eid of c.attachedTo) {
          const entry = byId.get(eid);
          assert.ok(entry, `${col} conflict ${c.sourceId} -> ${eid}`);
          assert.ok(Array.isArray(entry.conflicts) && entry.conflicts.length > 0, `${eid} 缺少 conflicts[]`);
          for (const ec of entry.conflicts) {
            assert.equal(ec.unit, entry.unit, `${eid} 冲突单位必须与主条一致`);
            assert.equal(ec.colorSpace, entry.colorSpace, `${eid} 冲突色彩空间必须一致`);
            assert.ok(typeof ec.reason === 'string' && ec.reason.length > 0, `${eid} 冲突缺少 reason`);
          }
        }
      }
    }
    assert.equal(attachedConflicts, expectedAttached[col], `${col} 挂接冲突数`);
  }
});

test('彻底脱敏：12 份 JSON 与本测试文件经 SHA-256 前缀扫描零专名、零分区键、零残留 wikilink', () => {
  const targets = [
    ...Object.keys(EXPECTED_SHA256).map((f) => [f, raw(f)]),
    ['c12-priors.test.mjs', readFileSync(new URL('./c12-priors.test.mjs', import.meta.url), 'utf8')],
  ];
  for (const [label, content] of targets) {
    const grams = collectNgrams(content);
    const ipHits = [];
    const regionHits = [];
    for (const g of grams) {
      const h = sha16(g);
      if (IP_HASHES.has(h)) ipHits.push(h);
      if (REGION_KEY_HASHES.has(h)) regionHits.push(h);
    }
    assert.deepEqual(ipHits, [], `${label} 命中专名黑名单哈希`);
    assert.deepEqual(regionHits, [], `${label} 命中分区键黑名单哈希`);
    if (label.endsWith('.json')) {
      assert.equal(content.includes('[['), false, `${label} 不得残留 wikilink`);
      assert.equal(/5090\s*级/.test(content), false, `${label} 不得残留硬件型号分级`);
      const srcHits = [...content.matchAll(/\b(?:src|tools|cases|scripts|scenes|assets)\/[A-Za-z0-9_./-]+|\b[A-Za-z0-9_-]+\.(?:mjs|cjs|jsx|tsx|ts|py|html|css|glsl|wgsl|frag|vert|blend|mp4|mov|wav|mp3|exr|png|jpg|webp|gltf|stl)\b(?::\d+)?/gi)]
        .map((m) => m[0]);
      assert.deepEqual(srcHits, [], `${label} 不得残留原包源码路径或媒体文件名`);
      const jsHits = [...content.matchAll(/\b[A-Za-z0-9_-]+\.js(?::\d+)?\b/gi)]
        .map((m) => m[0])
        .filter((s) => !/^three\.js$/i.test(s));
      assert.deepEqual(jsHits, [], `${label} 不得残留原包 .js 文件引用`);
    }
  }
});

test('数值忠实度、色彩空间、千分位、省略前导零与随机算式回归校验', () => {
  // 全部 444 条可移植先验的 value 必须能在 provenance.note 里逐项核回
  for (const col of C12_COLLECTIONS) {
    for (const e of DATA[col].priors) {
      assert.equal(
        verifyValueInNote(e.value, e.provenance.note, e.unit, e.ext),
        true,
        `${e.id}: value=${JSON.stringify(e.value)} (${e.unit}) 未在 provenance.note 中核回`,
      );
    }
  }

  // 1. 线性 RGB（scene-linear-rec709）
  const linEntries = DATA['mat-hardsurf'].priors.filter((e) => e.unit === 'rgb-linear');
  assert.ok(linEntries.length >= 40, 'mat-hardsurf 应含标准 PBR 线性基色');
  assert.equal(linEntries.every((e) => e.colorSpace === 'scene-linear-rec709'), true);

  // 2. 显示空间 RGB（srgb-display）及同色冲突挂接
  const d365 = loadFxUiPriorsStore().get('fx-ui.d365.display-color');
  assert.ok(d365);
  assert.equal(d365.unit, 'rgb-display');
  assert.equal(d365.colorSpace, 'srgb-display');
  assert.equal(d365.ext['c12.hex'], '#D1FE17');
  assert.deepEqual(d365.value, [0.819608, 0.996078, 0.090196]);
  assert.equal(d365.conflicts.length, 1);
  assert.equal(d365.conflicts[0].unit, 'rgb-display');
  assert.equal(d365.conflicts[0].colorSpace, 'srgb-display');

  // 3. 千分位大数与冲突（1,134 帧、5,376 帧 vs 5,375 帧）
  assert.equal(loadRenderPipePriorsStore().get('render-pipe.d054.frame-count').value, 1134);
  const d112Frames = loadRenderPipePriorsStore().get('render-pipe.d112.frame-count');
  assert.equal(d112Frames.value, 5376);
  assert.equal(d112Frames.conflicts[0].value, 5375);

  // 4. 全部 9 条含数值随机区间的记录在 card-priors.json 中结构化保留 jitter（含省略前导零 .4+rand×.8 与 -.08·rnd()）
  const fxCardBySrc = new Map(DATA['fx-ui'].cardPriors.map((e) => [e.sourceId, e]));
  const matCardBySrc = new Map(DATA['mat-hardsurf'].cardPriors.map((e) => [e.sourceId, e]));
  for (const sid of ['d093', 'd095', 'd116', 'd117']) {
    const qs = fxCardBySrc.get(sid)?.quantities.filter((q) => Object.hasOwn(q, 'jitter')) || [];
    assert.ok(qs.length > 0, `fx-ui ${sid} 应含结构化随机区间`);
  }
  for (const sid of ['d153', 'd226', 'd339', 'd436', 'd447']) {
    const qs = matCardBySrc.get(sid)?.quantities.filter((q) => Object.hasOwn(q, 'jitter')) || [];
    assert.ok(qs.length > 0, `mat-hardsurf ${sid} 应含结构化随机区间`);
  }
  const d226Speed = matCardBySrc.get('d226').quantities.find((q) => q.expr === '.4+rand×.8');
  assert.deepEqual(d226Speed.value, [0.4, 1.2]);
  assert.equal(d226Speed.jitter, 0.8);
  const d447Noise = matCardBySrc.get('d447').quantities.find((q) => q.expr === '-.08·rnd()');
  assert.deepEqual(d447Noise.value, [-0.08, 0]);
  assert.equal(d447Noise.jitter, 0.08);
});

test('独立盲审记录完备，canonical 种子 42 抽样可复现且 200 种子全过 <= 10%', () => {
  for (const col of C12_COLLECTIONS) {
    const { manifest } = DATA[col];
    const ba = manifest.blindAudit;
    assert.ok(ba && typeof ba === 'object', col);
    assert.equal(ba.canonicalSeed, 42, col);
    const minDetails = Math.ceil(manifest.detailEntries * 0.1);
    const minSummaries = Math.ceil(manifest.summaryRows * 0.1);
    assert.ok(ba.detailSampleSize >= minDetails, `${col} detailSampleSize`);
    assert.ok(ba.summarySampleSize >= minSummaries, `${col} summarySampleSize`);
    assert.equal(ba.sampleSize, ba.detailSampleSize + ba.summarySampleSize, col);
    assert.equal(ba.sample.length, ba.sampleSize, col);
    assert.ok(ba.disagreeRate <= 0.1, `${col} canonical disagreeRate=${ba.disagreeRate}`);
    assert.ok(ba.fullPopulationDisagreeRate <= 0.1, `${col} fullPop disagreeRate=${ba.fullPopulationDisagreeRate}`);
    assert.equal(ba.seed200Verified, true, col);
    assert.equal(ba.seed200PassCount, 200, col);
    assert.ok(ba.seed200Worst.disagreeRate <= 0.1, `${col} worst seed=${JSON.stringify(ba.seed200Worst)}`);

    // 用独立 mulberry32(Math.imul(42, 0x9e3779b1)) 复算分层无放回抽样顺序，核对 sample 无手选偏差
    const details = manifest.ledger.filter((r) => r.kind === 'detail');
    const summaries = manifest.ledger.filter((r) => r.kind === 'summary');
    const rng = mulberry32(42);
    const expectedIds = [
      ...sampleWithoutReplacement(details, minDetails, rng).map((r) => r.sourceId),
      ...sampleWithoutReplacement(summaries, minSummaries, rng).map((r) => r.sourceId),
    ];
    assert.deepEqual(ba.sample.map((x) => x.sourceId), expectedIds, `${col} seed 42 抽样序列不一致`);
    assert.equal(ba.sample.filter((x) => !x.agree).length, ba.disagreeCount, col);
  }
});

test('全部对外返回视图深冻结只读', () => {
  for (const col of C12_COLLECTIONS) {
    const manifest = getBatch3MigrationManifest(col);
    const practices = getBatch3Practices(col);
    const cardSample = getBatch3CardPriors(manifest.cards[0].cardId, col);
    const store = loadBatch3PriorsStore(col);
    const firstPrior = store.query({ limit: 1 })[0];

    assert.equal(Object.isFrozen(manifest), true);
    assert.equal(Object.isFrozen(manifest.ledger), true);
    assert.equal(Object.isFrozen(manifest.ledger[0]), true);
    assert.equal(Object.isFrozen(manifest.blindAudit), true);
    assert.equal(Object.isFrozen(manifest.blindAudit.sample), true);
    assert.equal(Object.isFrozen(practices), true);
    assert.equal(Object.isFrozen(practices[0]), true);
    assert.equal(Object.isFrozen(cardSample), true);
    assert.equal(Object.isFrozen(cardSample[0]), true);
    assert.equal(Object.isFrozen(firstPrior), true);

    assert.throws(() => { manifest.totalSourceEntries = 0; }, TypeError);
    assert.throws(() => { practices[0].title = 'mutated'; }, TypeError);
    assert.throws(() => { cardSample[0].useAsDefault = true; }, TypeError);
    assert.throws(() => { firstPrior.verifiedInOurStack = true; }, TypeError);
  }
  assert.equal(Object.isFrozen(getBatch3Practices()), true);
});
