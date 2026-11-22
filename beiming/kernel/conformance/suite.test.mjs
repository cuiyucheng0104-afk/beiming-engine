// V4 单测（Red -> Green）：7 项帧源一致性套件（three / blender / limited）与 17 条历史核心不变量正负对照
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanText } from './scan.mjs';
import {
  SUITE_ITEMS,
  evaluateSourceConformance,
  loadProbeSuiteReport,
} from './suite.mjs';
import {
  INVARIANTS,
  checkInvariant,
  makeValidInvariantFixture,
  makeViolatingInvariantFixture,
  runInvariantSuite,
} from './invariants.mjs';

test('V4-1 帧源一致性套件：three 与 blender 探针表各出严格 7 行结果且口径对齐 P7/P8', () => {
  assert.equal(SUITE_ITEMS.length, 7);

  const threeMac = loadProbeSuiteReport('three', { machine: 'mac' });
  assert.equal(threeMac.rows.length, 7);
  assert.equal(threeMac.ok, true, JSON.stringify(threeMac.rows));

  const blenderMac = loadProbeSuiteReport('blender', { machine: 'mac' });
  assert.equal(blenderMac.rows.length, 7);
  assert.equal(blenderMac.ok, true, JSON.stringify(blenderMac.rows));

  for (const r of [threeMac, blenderMac]) {
    const ids = r.rows.map((x) => x.id);
    assert.deepEqual(ids, [
      'color-linearity',
      'depth',
      'object-id-meta',
      'normal-space',
      'camera-convention',
      'shuffled-order',
      'repeat-twice',
    ]);
  }
});

test('V4-2 帧源一致性套件：limited 合规档精准减免四项，超线读数立即判红', () => {
  const limited = evaluateSourceConformance({
    source: 'legacy-page',
    conformance: 'limited',
    determinism: 'hash-same-machine',
    readings: {
      colorLinearityMaxRelErr: 0.012,
      colorZeroMaxAbsErr: 0,
      shuffledMaxDiff: 0,
      repeatMaxDiff: 0,
    },
  });
  assert.equal(limited.rows.length, 7);
  assert.equal(limited.ok, true, JSON.stringify(limited));
  const exemptIds = limited.rows.filter((r) => r.status === 'exempt').map((r) => r.id);
  assert.deepEqual(exemptIds, ['depth', 'object-id-meta', 'normal-space', 'camera-convention']);

  const badIou = evaluateSourceConformance({
    source: 'three',
    conformance: 'full',
    determinism: 'tolerance',
    readings: {
      colorLinearityMaxRelErr: 0.01,
      colorZeroMaxAbsErr: 0,
      depthMedianRelErr: 0.01,
      objectIdMetaIous: { 'cube-near': 1, 'cube-mid': 1, 'cube-far': 0.91 },
      normalMedianDeg: 0.8,
      cameraAnchorMaxPx: 0.4,
      shuffledPsnrDb: 54,
      shuffledFracAbove5: 0.0002,
      repeatPsnrDb: 53,
      repeatFracAbove5: 0.0003,
    },
  });
  assert.equal(badIou.ok, false);
  assert.equal(badIou.rows.find((r) => r.id === 'object-id-meta')?.status, 'fail');
});

const limits = {
  colorLinearityMaxRelErr: 0.02, colorZeroMaxAbsErr: 0.005, depthMedianRelErr: 0.02,
  objectIdMetaMinIou: 0.95, normalMedianDeg: 2, cameraAnchorMaxPx: 1,
  shuffledPsnrDb: 50, shuffledFracAbove5: 0.001, repeatPsnrDb: 50, repeatFracAbove5: 0.001,
};
const direct = (readings, extra) => evaluateSourceConformance({ source: 'core', conformance: 'full',
  determinism: 'tolerance', readings, ...extra });
const failures = (report) => report.rows.filter((r) => r.status === 'fail').map((r) => r.id);

test('十项独立读数：等号过线；缺项、错类型或越线只影响对应行', () => {
  assert.equal(direct(limits).ok, true);
  for (const [field, id, bad] of [
    ['colorLinearityMaxRelErr', 'color-linearity', 0.0201], ['colorZeroMaxAbsErr', 'color-linearity', 0.0051],
    ['depthMedianRelErr', 'depth', -1], ['depthMedianRelErr', 'depth', 0.025], ['depthMedianRelErr', 'depth', 0.0201],
    ['objectIdMetaMinIou', 'object-id-meta', 0.9499], ['objectIdMetaMinIou', 'object-id-meta', 1.01],
    ['normalMedianDeg', 'normal-space', 2.01], ['cameraAnchorMaxPx', 'camera-convention', 1.01],
    ['shuffledPsnrDb', 'shuffled-order', 49.99], ['shuffledFracAbove5', 'shuffled-order', 0.00101],
    ['repeatPsnrDb', 'repeat-twice', 49.99], ['repeatFracAbove5', 'repeat-twice', 0.00101],
  ]) {
    for (const val of [bad, undefined, null, NaN, String(limits[field])]) {
      const report = direct({ ...limits, [field]: val });
      assert.equal(report.ok, false);
      assert.deepEqual(failures(report), [id], `${field}=${val}`);
      assert.ok(report.rows.find((r) => r.id === id).reason);
    }
  }
});

test('limited 不豁免三项；重复渲染不能充当乱序；哈希档不吃容差读数', () => {
  const limited = { source: 'legacy-page', conformance: 'limited', determinism: 'hash-same-machine' };
  assert.deepEqual(failures(direct({}, limited)), ['color-linearity', 'shuffled-order', 'repeat-twice']);
  assert.deepEqual(failures(direct({ ...limits, repeatMaxDiff: 0 }, limited)), ['shuffled-order']);
  assert.deepEqual(failures(direct({ ...limits, repeatMaxDiff: 1, shuffledMaxDiff: 1 }, limited)),
    ['shuffled-order', 'repeat-twice']);
});

test('5090 两遍按各自档位判定，不能借用 Mac 的法线、乱序与 Blender 单独渲读数', () => {
  for (const source of ['three', 'blender']) {
    const r = loadProbeSuiteReport(source, { machine: 'linux-5090' });
    assert.equal(r.rows.length, 7);
    assert.equal(r.rows[6].status, 'pass');
    assert.deepEqual(r.rows[6].measured, source === 'three' ? { repeatMaxDiff: 0 }
      : { repeatPsnrDb: 179.56, repeatFracAbove5: 0 });
    assert.deepEqual(failures(r), source === 'three' ? ['normal-space', 'shuffled-order']
      : ['object-id-meta', 'normal-space', 'shuffled-order']);
  }
});

test('探针表按文件配容差指标；缺任一指标即红，不相信摘要或旧 diff', (t) => {
  const tableDir = mkdtempSync(join(tmpdir(), 'probe-v4-'));
  t.after(() => rmSync(tableDir, { recursive: true, force: true }));
  const filename = 'blender.linux-5090.json';
  const column = JSON.parse(readFileSync(new URL(`../../calib/table/${filename}`, import.meta.url)));
  const colors = column.rows.find((row) => row.row === '颜色层的线性度');
  colors.readings[0].got[1] = 0.0051;
  const det = column.rows.find((row) => row.row === '确定性');
  det.readings.splice(det.readings.findIndex((r) => r.unit === 'ratio'), 1);
  writeFileSync(join(tableDir, filename), JSON.stringify(column));
  assert.deepEqual(failures(loadProbeSuiteReport('blender', { tableDir, machine: 'linux-5090' })),
    ['color-linearity', 'object-id-meta', 'normal-space', 'shuffled-order', 'repeat-twice']);
});

test('Three 表的重复样本不能补缺，坏掉的编号框不能被历史 IoU 摘要覆盖', (t) => {
  const tableDir = mkdtempSync(join(tmpdir(), 'probe-v4-'));
  t.after(() => rmSync(tableDir, { recursive: true, force: true }));
  const column = JSON.parse(readFileSync(new URL('../../calib/table/three.json', import.meta.url)));
  const colors = column.rows.find((row) => row.row === '颜色层的线性度').readings;
  colors[1] = colors[0];
  const boxes = column.rows.find((row) => row.row === '可见比例的成本').readings;
  boxes.find((r) => r.what.startsWith('cube-near 单独渲编号层反算包围盒 [')).got = [0, 0, 1, 1];
  writeFileSync(join(tableDir, 'three.json'), JSON.stringify(column));
  assert.deepEqual(failures(loadProbeSuiteReport('three', { tableDir })),
    ['color-linearity', 'object-id-meta', 'normal-space', 'shuffled-order']);
});

test('Three 探针表中任一方块的单渲框错位，只拒绝 object-id-meta', (t) => {
  const tableDir = mkdtempSync(join(tmpdir(), 'probe-v4-'));
  t.after(() => rmSync(tableDir, { recursive: true, force: true }));
  writeFileSync(join(tableDir, 'v4-three.mac.json'), readFileSync(new URL('./fixtures/v4-three.mac.json', import.meta.url)));
  const original = readFileSync(new URL('../../calib/table/three.json', import.meta.url), 'utf8');
  for (const name of ['cube-near', 'cube-mid', 'cube-far']) {
    const column = JSON.parse(original);
    const boxes = column.rows.find((r) => r.row === '可见比例的成本').readings;
    boxes.find((r) => r.what.startsWith(`${name} 单独渲编号层反算包围盒 [`)).got = [0, 0, 1, 1];
    writeFileSync(join(tableDir, 'three.json'), JSON.stringify(column));
    const report = loadProbeSuiteReport('three', { tableDir });
    assert.deepEqual(failures(report), ['object-id-meta'], name);
    assert.equal(report.rows[2].measured.objectIdMetaMinIou, 0, name);
  }
});

test('Three 补测只提供法线和乱序，不能为缺失的两遍探针表签发通过', (t) => {
  const tableDir = mkdtempSync(join(tmpdir(), 'probe-v4-'));
  t.after(() => rmSync(tableDir, { recursive: true, force: true }));
  const supplement = JSON.parse(readFileSync(new URL('./fixtures/v4-three.mac.json', import.meta.url)));
  supplement.repeat = supplement.sequential;
  writeFileSync(join(tableDir, 'v4-three.mac.json'), JSON.stringify(supplement));
  const report = loadProbeSuiteReport('three', { tableDir });
  assert.deepEqual(failures(report), ['color-linearity', 'depth', 'object-id-meta', 'camera-convention', 'repeat-twice']);
});

test('加载器逐项拒绝伪造的采样位置、没有运动的转台或另一版本的证据', (t) => {
  const tableDir = mkdtempSync(join(tmpdir(), 'probe-v4-'));
  t.after(() => rmSync(tableDir, { recursive: true, force: true }));
  writeFileSync(join(tableDir, 'three.json'), readFileSync(new URL('../../calib/table/three.json', import.meta.url)));
  const original = readFileSync(new URL('./fixtures/v4-three.mac.json', import.meta.url), 'utf8');
  for (const [mutate, failed] of [
    [(s) => { s.normals = [{ got: [0, 0, 1], expected: [0, 0, 1] }]; }, ['normal-space']],
    [(s) => { s.normals[0].expected = s.normals[1].expected; }, ['normal-space']],
    [(s) => { for (const r of [...s.sequential, ...s.shuffled]) r.digest = 'a'.repeat(64); }, ['shuffled-order']],
    [(s) => { s.provenance.sourceVersion = '0.0.1'; }, ['normal-space', 'shuffled-order']],
  ]) {
    const supplement = JSON.parse(original);
    mutate(supplement);
    writeFileSync(join(tableDir, 'v4-three.mac.json'), JSON.stringify(supplement));
    assert.deepEqual(failures(loadProbeSuiteReport('three', { tableDir })), failed);
  }
});

test('乱序渲染保留所采集的颜色与法线层逐帧摘要', () => {
  const sequential = ['a', 'b'].map((v, frame) => ({ frame, digest: v.repeat(64), normalDigest: 'c'.repeat(64) }));
  const shuffled = sequential.toReversed().map((r) => ({ ...r }));
  shuffled[0].normalDigest = 'd'.repeat(64);
  const report = direct({ ...limits, repeatMaxDiff: 0 }, { determinism: 'hash-same-machine', observations: { sequential, shuffled } });
  assert.deepEqual(failures(report), ['shuffled-order']);
});

test('原始法线与哈希按帧核对；空向量、假乱序、重复键都不能被汇总绿灯覆盖', () => {
  const sequential = ['a', 'b', 'c'].map((v, frame) => ({ frame, digest: v.repeat(64) }));
  const obs = { normals: [{ expected: [1, 0, 0], got: [2, 0, 0] }], sequential, shuffled: sequential.toReversed(), repeat: sequential };
  const check = (updates) => direct({ ...limits, shuffledMaxDiff: 0, repeatMaxDiff: 0 },
    { determinism: 'hash-same-machine', observations: { ...obs, ...updates } });
  assert.equal(check({}).ok, true);
  for (const shuffled of [[], sequential, [sequential[1], sequential[0], sequential[0]],
    [sequential[2], sequential[1], { frame: 0, digest: 'c'.repeat(64) }]]) {
    assert.deepEqual(failures(check({ shuffled })), ['shuffled-order']);
  }
  assert.deepEqual(failures(check({ normals: [{ expected: [1, 0, 0], got: [0, 0, 0] }], repeat: [] })),
    ['normal-space', 'repeat-twice']);
});

test('8 位 RGB 逐帧算 PSNR 和大差像素：同像素三个通道只算一次，差恰好 5 不算', () => {
  const rgb8 = Array(3000).fill(0), sequential = [{ frame: 0, rgb8 }];
  const check = (pixels) => direct(limits, { observations: { sequential, repeat: [{ frame: 0, rgb8: pixels }] } }).rows[6];
  assert.deepEqual(check(rgb8).measured, { repeatPsnrDb: '+Infinity', repeatFracAbove5: 0 });
  const pixels = [...rgb8]; pixels.fill(6, 0, 3); pixels[4] = 5;
  assert.equal(check(pixels).status, 'pass');
  assert.equal(check(pixels).measured.repeatFracAbove5, 0.001);
  pixels[4]++;
  assert.equal(check(pixels).status, 'fail');
  assert.equal(check(rgb8.map(() => 5)).status, 'fail'); // 无大差像素，但 PSNR 不足
});

test('INV-02 区分说明文字与模板插值里的随机调用', () => {
  const scan = (source) => checkInvariant('INV-02', { source, seed: 42 }).ok;
  const help = 'const help = "Math.random()"; /* random() */ ctx.rng("grain")();';
  assert.equal(scan(help), true);
  assert.deepEqual(scanText(help), [{ kind: 'unseededRandom', call: 'Math.random' }], '旧 K8 入口仍检查原文');
  assert.equal(scan('const value = `noise ${Math["random"]()}`;'), false);
});

test('INV-14 CLI 与 HTTP 逐一核对错误前缀和进程退出码', () => {
  for (const [code, exitCode] of Object.entries({ 'failure.ffmpeg': 1, 'usage.bad-argument': 2, 'env.missing-tool': 3,
    'contract.unknown-key': 4, 'auth.base-readonly': 4, 'busy.rev-conflict': 5, 'timeout.ffmpeg': 124 })) {
    const fixture = makeValidInvariantFixture('INV-14');
    for (const envelope of [fixture.cli, fixture.http]) {
      envelope.exitCode = exitCode;
      envelope.error.code = code;
    }
    fixture.processExitCode = exitCode;
    assert.equal(checkInvariant('INV-14', fixture).ok, true, code);
    const wrong = exitCode === 1 ? 2 : 1;
    fixture.cli.exitCode = fixture.http.exitCode = fixture.processExitCode = wrong;
    assert.equal(checkInvariant('INV-14', fixture).ok, false, `${code} 错配退出码 ${wrong}`);
    fixture.cli.exitCode = fixture.http.exitCode = fixture.processExitCode = exitCode;
    fixture.cli.error.code = fixture.http.error.code = `${code}.unregistered`;
    assert.equal(checkInvariant('INV-14', fixture).ok, false, '已知前缀下未登记的码仍无效');
  }
});

test('INV-16 同一扩展名的小素材与改名后的渲染文件由实际内容摘要区分', () => {
  const fixture = makeValidInvariantFixture('INV-16');
  fixture.staged[0].path = 'assets/input.wav';
  fixture.addArgs = ['--', fixture.staged[0].path];
  assert.equal(checkInvariant('INV-16', fixture).ok, true);
  fixture.renderedHashes.push(fixture.staged[0].sha256);
  assert.equal(checkInvariant('INV-16', fixture).ok, false);
});

for (const inv of INVARIANTS) {
  test(`${inv.id}：单独注入违例，批量报告仅这一行被拒`, () => {
    const cases = INVARIANTS.map(({ id }) => ({ id, fixture: id === inv.id
      ? makeViolatingInvariantFixture(id) : makeValidInvariantFixture(id) }));
    const r = runInvariantSuite(cases);
    assert.deepEqual([r.ok, r.passed, r.failed], [false, 16, 1]);
    assert.deepEqual(r.rows.filter((row) => !row.ok).map((row) => row.id), [inv.id]);
    assert.equal(checkInvariant(inv.id, {}).ok, false);
  });
}

test('V4-3 17 条不变量：完整覆盖 INV-01..INV-17，正例 17/17 通过，故意违例 17/17 逐一变红', () => {
  assert.equal(INVARIANTS.length, 17);

  for (let i = 1; i <= 17; i++) {
    const id = `INV-${String(i).padStart(2, '0')}`;
    const valid = makeValidInvariantFixture(id);
    const pos = checkInvariant(id, valid);
    assert.equal(pos.ok, true, `${id} 正例应当通过，实得: ${JSON.stringify(pos)}`);

    const violated = makeViolatingInvariantFixture(id);
    const neg = checkInvariant(id, violated);
    assert.equal(neg.ok, false, `${id} 故意违例应当变红，实得: ${JSON.stringify(neg)}`);
    assert.equal(neg.id, id);
    assert.ok(typeof neg.reason === 'string' && neg.reason.length > 0, `${id} 违例应返回原因`);
  }

  const allValidSuite = runInvariantSuite(
    INVARIANTS.map((inv) => ({ id: inv.id, fixture: makeValidInvariantFixture(inv.id) })),
  );
  assert.equal(allValidSuite.ok, true);
  assert.equal(allValidSuite.passed, 17);
  assert.equal(allValidSuite.failed, 0);
});

test('只有允许 limited 的帧源可申请减免', () => {
  for (const source of ['three', 'blender']) {
    assert.throws(() => loadProbeSuiteReport(source, { conformance: 'limited' }), RangeError);
  }
  for (const source of ['three', 'blender', 'core', 'other', 'ext.']) {
    assert.throws(() => direct(limits, { source, conformance: 'limited' }), RangeError);
  }
  assert.deepEqual(direct(limits, { source: 'ext.demo', conformance: 'limited' }).rows
    .filter((row) => row.status === 'exempt').map((row) => row.id),
  ['depth', 'object-id-meta', 'normal-space', 'camera-convention']);
});

test('两种完整帧源的编号行要求三个具名的单独渲读数', () => {
  const objectIdMetaIous = { 'cube-near': 0.98, 'cube-mid': 0.95, 'cube-far': 1 };
  for (const source of ['three', 'blender']) {
    const row = (values) => direct(limits, { source, observations: { objectIdMetaIous: values } }).rows[2];
    assert.equal(row(objectIdMetaIous).measured.objectIdMetaMinIou, 0.95);
    for (const key of Object.keys(objectIdMetaIous)) {
      const values = { ...objectIdMetaIous, [key]: 0.05 };
      assert.equal(row(values).status, 'fail', key);
      assert.equal(row(values).measured.objectIdMetaMinIou, 0.05);
      delete values[key];
      assert.equal(row(values).measured.objectIdMetaMinIou, null, key);
    }
    assert.equal(direct(limits, { source }).rows[2].status, 'fail', '汇总不能补齐单物体读数');
  }
});

test('Blender 每个单独渲都核对像素摘要、物体名和元数据框', (t) => {
  const tableDir = mkdtempSync(join(tmpdir(), 'probe-v4-'));
  t.after(() => rmSync(tableDir, { recursive: true, force: true }));
  writeFileSync(join(tableDir, 'blender.json'), readFileSync(new URL('../../calib/table/blender.json', import.meta.url)));
  const original = readFileSync(new URL('./fixtures/v4-blender.mac.json', import.meta.url), 'utf8');
  const check = (mutate) => {
    const rec = JSON.parse(original);
    mutate(rec);
    writeFileSync(join(tableDir, 'v4-blender.mac.json'), JSON.stringify(rec));
    return failures(loadProbeSuiteReport('blender', { tableDir }));
  };
  for (const name of ['cube-near', 'cube-mid', 'cube-far']) {
    for (const mutate of [
      (item) => { item.metaBBox = [0, 0, 1, 1]; },
      (item) => { item.runs[0][1]--; },
      (item) => { item.name = 'other'; },
    ]) {
      assert.deepEqual(check((rec) => mutate(rec.objectIdEvidence.objects.find((x) => x.name === name))), ['object-id-meta'], name);
    }
  }
  const { objectIdEvidence: evidence, observed: { objectIdMetaIous: recordedIous } } = JSON.parse(original);
  for (const item of evidence.objects) {
    // 独立枚举占用像素，验证存档中每个 IoU，而不只是验证最小值已过线。
    const width = evidence.size[0];
    const pixels = item.runs.flatMap(([start, count]) => Array.from({ length: count }, (_, i) => start + i));
    const xs = pixels.map((p) => p % width), ys = pixels.map((p) => Math.floor(p / width));
    const [left, top, right, bottom] = item.metaBBox;
    const x0 = Math.min(...xs), x1 = Math.max(...xs) + 1, y0 = Math.min(...ys), y1 = Math.max(...ys) + 1;
    const inter = (Math.min(x1, right) - Math.max(x0, left)) * (Math.min(y1, bottom) - Math.max(y0, top));
    const union = (x1 - x0) * (y1 - y0) + (right - left) * (bottom - top) - inter;
    assert.ok(Math.abs(recordedIous[item.name] - inter / union) < 1e-10, item.name);
  }
  assert.equal(loadProbeSuiteReport('blender').rows[2].measured.objectIdMetaMinIou, Math.min(...Object.values(recordedIous)));
  assert.deepEqual(check((rec) => { delete rec.objectIdEvidence; }), ['object-id-meta']);
  const supplementRows = ['object-id-meta', 'normal-space', 'shuffled-order'];
  assert.deepEqual(check((rec) => { rec.provenance.device.backend = 'OPTIX'; }), supplementRows);
  assert.deepEqual(check((rec) => { rec.provenance.platform = 'linux 6.12.0 x64'; }), supplementRows);
  assert.throws(() => check((rec) => { rec.machine = 'linux-5090'; }), /机器/);
});

test('Three 两遍结果中的一处差异必须计数', (t) => {
  const tableDir = mkdtempSync(join(tmpdir(), 'probe-v4-'));
  t.after(() => rmSync(tableDir, { recursive: true, force: true }));
  const column = JSON.parse(readFileSync(new URL('../../calib/table/three.json', import.meta.url)));
  column.rows.find((r) => r.row === '确定性').readings.find((r) => r.unit === 'sha256').got = '不同';
  writeFileSync(join(tableDir, 'three.json'), JSON.stringify(column));
  const row = loadProbeSuiteReport('three', { tableDir }).rows[6];
  assert.equal(row.status, 'fail');
  assert.equal(row.measured.repeatMaxDiff, 1);
});

test('容差档按最差帧判两遍和乱序，法线夹角按度判', () => {
  const sequential = [0, 1].map((frame) => ({ frame, rgb8: [0, 0, 0] }));
  const repeat = [sequential[0], { frame: 1, rgb8: [1, 1, 1] }];
  const angle = 2.5 * Math.PI / 180;
  const normals = [{ expected: [1, 0, 0], got: [Math.cos(angle), Math.sin(angle), 0] }];
  const r = direct(limits, { observations: { sequential, shuffled: repeat.toReversed(), repeat, normals } });
  assert.deepEqual(failures(r), ['normal-space', 'shuffled-order', 'repeat-twice']);
  for (const [index, prefix] of [[5, 'shuffled'], [6, 'repeat']]) {
    assert.equal(r.rows[index].measured[`${prefix}PsnrDb`], 10 * Math.log10(255 ** 2));
    assert.equal(r.rows[index].measured[`${prefix}FracAbove5`], 0);
  }
});

test('INV-02 保留 JS 私有字段、识别随机源的别名，并按语言处理注释', () => {
  const scan = (source, language) => checkInvariant('INV-02', { seed: 42, source, language }).ok;
  for (const source of ['class Grain { #jitter = Math.random(); }', 'const m = Math; m.random();',
    'const pick = Math.random; pick();', 'crypto.randomBytes(8)', 'const rng = makeRng(Date.now());']) {
    assert.equal(scan(source, 'js'), false, source);
  }
  for (const expr of ['random.random()', 'random.randint(1, 5)', 'random.uniform(1, 5)',
    'random.choice(xs)', 'random.gauss(0, 1)', 'np.random.rand(5)']) {
    assert.equal(scan(`x = 1 // 2 + ${expr}`, 'python'), false, expr);
  }
  assert.equal(scan('np.random.rand()'), false, '兼容不带语言字段的历史片段');
  assert.equal(scan('import numpy as np\nrng = np.random.default_rng(42)\nx = rng.random()', 'python'), true);
  assert.equal(checkInvariant('INV-02', { seed: 42, filename: 'shot.py', source: 'x = 42 # random.gauss(0, 1)' }).ok, true);
  assert.equal(scan('x = 42 # random.gauss(0, 1)', 'python'), true);
  assert.equal(scan('class Grain { #value = 1; } // Math.random()', 'js'), true);
});

test('INV-02 按赋值顺序跟踪带括号的别名与 Node 随机函数', async (t) => {
  const cases = [
    ['(Math).random()', false],
    ['let m; (m = Math).random()', false],
    ['const m = Math; (m).random()', false],
    ['const fixed = {random: () => 0}; let m; (m = fixed).random()', true],
    ['const fixed = () => ({random: () => 0}); fixed((Math)).random()', true],
    ['((Math))["random"]()', false],
    ['const m = (Math); m.random()', false],
    ['const fixed = {random: () => 0}; let m = Math; m = fixed; m.random()', true],
    ['let m = Math; m.random(); m = Object', false],
    ['let m = Math; m = {random: () => 0}; m.random()', true],
    ['let m = Math; m = m.random()', false],
    ["import {randomInt} from 'node:crypto'; randomInt(10)", false],
    ["import {randomFillSync as fill} from 'node:crypto'; fill(new Uint8Array(1))", false],
    ["const {randomFill} = require('node:crypto'); randomFill(buf, done)", false],
  ];
  for (const [source, expected] of cases) {
    await t.test(source, () => assert.equal(checkInvariant('INV-02', { seed: 42, language: 'js', source }).ok, expected));
  }
});

test('INV-15 识别代理签名并允许 Abbot 签署用户意见', () => {
  const fixture = makeValidInvariantFixture('INV-15');
  fixture.userApproved = true;
  fixture.review = { role: 'user', quote: '同意', source: '审片记录', decision: 'approved', artifactHash: fixture.artifactHash };
  for (const reviewer of ['GPT-5', 'Gemini', 'Claude', 'Codex', 'bot2', 'Abbot']) {
    fixture.review.reviewer = reviewer;
    assert.equal(checkInvariant('INV-15', fixture).ok, reviewer === 'Abbot', reviewer);
  }
});

test('INV-07 渲染失败必须由进程返回非零退出码', () => {
  const fixture = makeValidInvariantFixture('INV-07');
  fixture.exitCode = 0;
  assert.equal(checkInvariant('INV-07', fixture).ok, false);
});

test('INV-16 在 5 MiB 边界与输出目录上逐项判定', () => {
  const fixture = makeValidInvariantFixture('INV-16');
  const file = fixture.staged[0];
  file.bytes = 5 * 1024 ** 2;
  assert.equal(checkInvariant('INV-16', fixture).ok, true);
  file.bytes++;
  assert.equal(checkInvariant('INV-16', fixture).ok, false);
  file.bytes--;
  for (const path of ['out/frame.json', 'films/demo/out/run/frame.json']) {
    file.path = fixture.addArgs[1] = path;
    assert.equal(checkInvariant('INV-16', fixture).ok, false, path);
  }
});

test('批量不变量要求每个登记编号恰好一次', () => {
  const cases = INVARIANTS.map(({ id }) => ({ id, fixture: makeValidInvariantFixture(id) }));
  for (const batch of [cases.slice(1), [...cases.slice(1), cases[1]], [...cases, cases[0]]]) {
    assert.equal(runInvariantSuite(batch).ok, false);
  }
  assert.equal(runInvariantSuite(cases.toReversed()).ok, true);
});

test('V4 一审回归：私有字段、auth 前缀与不变量漏项', () => {
  // F-2: JS 私有字段 #jitter = Math.random() 绝不能被误当 Python # 注释吞掉
  const priv = makeValidInvariantFixture('INV-02');
  priv.source = 'class Grain { #jitter = Math.random(); }';
  assert.equal(checkInvariant('INV-02', priv).ok, false, 'JS 私有字段中的 Math.random() 必须判红');

  // F-4: errors.json 中 auth.base-readonly 对应退出码 4 必须合法通过
  const authFix = makeValidInvariantFixture('INV-14');
  authFix.http.error.code = 'auth.base-readonly';
  authFix.cli.error.code = 'auth.base-readonly';
  authFix.cli.exitCode = 4;
  authFix.processExitCode = 4;
  assert.equal(checkInvariant('INV-14', authFix).ok, true, '已登记的 auth.base-readonly 应通过');

  // F-6: runInvariantSuite 缺项或重复同一条不得返回 ok: true
  assert.equal(runInvariantSuite([{ id: 'INV-01', fixture: makeValidInvariantFixture('INV-01') }]).ok, false);
});

for (const module of ['random', 'numpy.random']) {
  test(`INV-02 在导入处拒绝 from ${module} import *`, () => {
    const statement = `from ${module} import *`;
    const check = (source) => checkInvariant('INV-02', { seed: 42, language: 'python', source });
    const result = check(`${statement}  # 导入后只使用常量\nx = 42`);
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes(statement));
    assert.equal(check(`if enabled: ${statement}`).ok, false);
    assert.equal(check(`from ${module.replace('.', ' . ')} import \\\n*`).ok, false);
    assert.equal(check(`help = "${statement}"  # ${statement}`).ok, true);
  });
}

test('V4-R3-Red 拒绝无确定性种子的随机源', () => {
  for (const badSrc of [
    'from random import *\nx = random()',
    'from random import uniform\nx = uniform(0, 1)',
    'import numpy as np\nrng = np.random.default_rng()\nx = rng.random()',
    'import random\nr = random.Random()\nx = r.random()',
    'x = random()',
    'const r = createSeededRandom(performance.now());',
    'const r = createSeededRandom(new Date());',
    'import time\nrng = make_rng(time.time())',
  ]) {
    const f = makeValidInvariantFixture('INV-02');
    f.source = badSrc;
    assert.equal(checkInvariant('INV-02', f).ok, false, `应拦截无确定性种子随机：${badSrc}`);
  }
});
