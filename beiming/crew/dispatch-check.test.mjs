import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkDispatch } from './dispatch-check.mjs';

const impl = (id, extra = {}) => ({ id, role: 'implementer', contextTokens: 20000, tokenCap: 300000, ...extra });

test('上限之内的派工单可以发', () => {
  const plan = [
    ...Array.from({ length: 8 }, (_, i) => impl(`w${i}`)),
    { id: 'r1', role: 'reviewer', contextTokens: 20000, tokenCap: 150000 },
  ];
  assert.deepEqual(checkDispatch(plan), []);
});

test('第 9 个写者拒发', () => {
  const plan = Array.from({ length: 9 }, (_, i) => impl(`w${i}`));
  const problems = checkDispatch(plan);
  assert.equal(problems.filter((p) => p.includes('引擎仓库同时写代码的工作包 9 个')).length, 1);
});

test('上下文超上限、用量超上限、没有的角色、核心线第 3 个写者，各报一条', () => {
  const problems = checkDispatch([
    impl('a', { contextTokens: 30001 }),
    impl('b', { tokenCap: 400001 }),
    { id: 'c', role: 'wizard', contextTokens: 1, tokenCap: 1 },
    impl('d', { line: 'core' }), impl('e', { line: 'core' }), impl('f', { line: 'core' }),
  ]);
  assert.equal(problems.filter((p) => p.includes('起始上下文 30001')).length, 1);
  assert.equal(problems.filter((p) => p.includes('用量上限 400001')).length, 1);
  assert.equal(problems.filter((p) => p.includes('没有这个角色 wizard')).length, 1);
  assert.equal(problems.filter((p) => p.includes('核心线写者 3 个')).length, 1);
});
