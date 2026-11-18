// 契约校验器的自测：正例全过；每条不变量都有判定函数，正好拒掉自己的反例。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lintContract } from './lint.mjs';
import { loadContracts, runContract } from './validate.mjs';

const loaded = await loadContracts();

test('每份契约：正例全部通过，没有判错的反例', () => {
  for (const name of loaded.contracts.keys()) {
    const { rows } = runContract(loaded, name);
    const bad = rows.filter((r) => !r.ok).map((r) => `${name}/${r.file}：${r.detail.join('；')}`);
    assert.deepEqual(bad, []);
  }
});

test('每份契约：每条不变量都有判定函数，每个反例都被自己那一条拒掉', () => {
  let total = 0;
  for (const [name, { dir, checks }] of loaded.contracts) {
    const { counts } = lintContract(dir);
    const { summary } = runContract(loaded, name);
    assert.equal(Object.keys(checks).length, counts.invariants, `${name}：判定函数的个数和第 4 节的不变量个数不一样`);
    assert.deepEqual({ byCheck: summary.byCheck, bySchema: summary.bySchema, unchecked: summary.unchecked }, { byCheck: counts.counterexamples, bySchema: 0, unchecked: 0 }, name);
    total += summary.byCheck;
  }
  assert.equal(total, 160);
});

test('合法记录改坏一处就被对应的那一条拒掉', () => {
  const rec = { format: 'time-check/0.1', fps: '24/1', shots: [{ id: 's01', start: 0, frames: 48, seed: 1, shutterAngleDeg: 180 }], holds: [{ f: 5, n: 2, result: 4 }] };
  assert.deepEqual(loaded.validate(rec), { contract: 'time', schemaErrors: [], violations: {} });
  rec.holds[0].result = 6;
  assert.deepEqual(Object.keys(loaded.validate(rec).violations), ['T10']);
});
