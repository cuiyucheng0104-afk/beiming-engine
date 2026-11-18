// 契约校验器的自测：正例全过；写了判定函数的不变量正好拒掉自己的反例。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadContracts, runContract } from './validate.mjs';

const loaded = await loadContracts();

test('每份契约：正例全部通过，没有判错的反例', () => {
  for (const name of loaded.contracts.keys()) {
    const { rows } = runContract(loaded, name);
    const bad = rows.filter((r) => !r.ok).map((r) => `${name}/${r.file}：${r.detail.join('；')}`);
    assert.deepEqual(bad, []);
  }
});

test('时间键：13 条不变量各有判定函数，13 个反例各被自己那一条拒掉', () => {
  const { summary } = runContract(loaded, 'time');
  assert.equal(Object.keys(loaded.contracts.get('time').checks).length, 13);
  assert.deepEqual({ byCheck: summary.byCheck, bySchema: summary.bySchema, unchecked: summary.unchecked }, { byCheck: 13, bySchema: 0, unchecked: 0 });
});

test('合法记录改坏一处就被对应的那一条拒掉', () => {
  const rec = { format: 'time-check/0.1', fps: '24/1', shots: [{ id: 's01', start: 0, frames: 48, seed: 1, shutterAngleDeg: 180 }], holds: [{ f: 5, n: 2, result: 4 }] };
  assert.deepEqual(loaded.validate(rec), { contract: 'time', schemaErrors: [], violations: {} });
  rec.holds[0].result = 6;
  assert.deepEqual(Object.keys(loaded.validate(rec).violations), ['T10']);
});
