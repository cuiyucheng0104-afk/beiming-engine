// V4 单测（Red -> Green）：7 项帧源一致性套件（three / blender / limited）与 17 条历史核心不变量正负对照
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      objectIdMetaMinIou: 0.91, // 低于 0.95 唯一口径
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
    ['depthMedianRelErr', 'depth', -1], ['objectIdMetaMinIou', 'object-id-meta', 1.01],
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
  const limited = { conformance: 'limited', determinism: 'hash-same-machine' };
  assert.deepEqual(failures(direct({}, limited)), ['color-linearity', 'shuffled-order', 'repeat-twice']);
  assert.deepEqual(failures(direct({ ...limits, repeatMaxDiff: 0 }, limited)), ['shuffled-order']);
  assert.deepEqual(failures(direct({ ...limits, repeatMaxDiff: 1, shuffledMaxDiff: 1 }, limited)),
    ['shuffled-order', 'repeat-twice']);
});

test('5090 两遍读数分档，不能用 Mac 的法线或乱序补齐', () => {
  for (const source of ['three', 'blender']) {
    const r = loadProbeSuiteReport(source, { machine: 'linux-5090' });
    assert.equal(r.rows.length, 7);
    assert.equal(r.rows[6].status, 'pass');
    assert.deepEqual(r.rows[6].measured, source === 'three' ? { repeatMaxDiff: 0 }
      : { repeatPsnrDb: 179.56, repeatFracAbove5: 0 });
    assert.deepEqual(failures(r), ['normal-space', 'shuffled-order']);
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
    ['color-linearity', 'normal-space', 'shuffled-order', 'repeat-twice']);
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

test('补测只提供法线和乱序，不能为缺失的两遍探针表签发通过', (t) => {
  const tableDir = mkdtempSync(join(tmpdir(), 'probe-v4-'));
  t.after(() => rmSync(tableDir, { recursive: true, force: true }));
  const sequential = ['a', 'b'].map((v, frame) => ({ frame, digest: v.repeat(64) }));
  const supplement = { format: 'v4-probe/0.1', source: 'three', machine: 'mac', sequential,
    shuffled: sequential.toReversed(), repeat: sequential };
  writeFileSync(join(tableDir, 'v4-three.mac.json'), JSON.stringify(supplement));
  const report = loadProbeSuiteReport('three', { tableDir, conformance: 'limited' });
  assert.deepEqual(failures(report), ['color-linearity', 'repeat-twice']);
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
  assert.equal(scan('const help = "Math.random()"; /* random() */ ctx.rng("grain")();'), true);
  assert.equal(scan('const value = `noise ${Math["random"]()}`;'), false);
});

test('INV-14 CLI 与 HTTP 逐一核对错误前缀和进程退出码', () => {
  for (const [prefix, exitCode] of Object.entries({ failure: 1, usage: 2, env: 3, contract: 4, busy: 5, timeout: 124 })) {
    const fixture = makeValidInvariantFixture('INV-14');
    for (const envelope of [fixture.cli, fixture.http]) {
      envelope.exitCode = exitCode;
      envelope.error.code = `${prefix}.test`;
    }
    fixture.processExitCode = exitCode;
    assert.equal(checkInvariant('INV-14', fixture).ok, true, prefix);
    fixture.http.error.code = 'unknown.test';
    assert.equal(checkInvariant('INV-14', fixture).ok, false, prefix);
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
