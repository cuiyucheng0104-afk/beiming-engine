// 规范检查的规则加载器（tools/repo-check/core/loader.mjs）：
//   1. 两种写法都能加载：单条规则（{ id, title, run }，默认导出或具名导出）与域模块（rules: [...]，可带 domain、createContext）；
//   2. 域模块的规则按模块自己的约定换算：自带上下文（每次检查只建一次）、level 缺省取 severity、level 'ok' 不进报告、fix 当 hint；
//   3. 形状不对、域对不上、id 重复的文件各记一条加载问题（带 domain），不影响同目录的其他文件；
//   4. 本仓库的 env、qa 两个域模块能被加载（这两个域曾因写法不同被当成「规则自身出错」）。
//   node --test tests/governance
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createContext } from '../../tools/repo-check/core/context.mjs';
import { loadRules } from '../../tools/repo-check/core/loader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

/** 在临时目录里搭一个 rules/<域>/ 目录树：{ 'env/index.mjs': '源码', … } */
function rulesDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-loader-'));
  made.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return dir;
}
const ctxFor = () => createContext({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-loader-root-')) });

test('单条规则：默认导出与具名导出都能加载，id、title、域、文件位置照抄', async () => {
  const dir = rulesDir({
    'demo/a.mjs': "export default { id: 'demo.a', title: '默认导出', run: () => [] };\n",
    'demo/b.mjs': "export const id = 'demo.b'; export const title = '具名导出'; export function run() { return [{ level: 'warn', message: 'x' }]; }\n",
    'demo/_helper.mjs': 'export const x = 1;\n',
    'demo/c.test.mjs': 'throw new Error("测试文件不该被当成规则加载");\n',
  });
  const { rules, problems, domains } = await loadRules(dir);
  assert.deepEqual(problems, []);
  assert.deepEqual(domains, ['demo']);
  assert.deepEqual(rules.map(r => [r.id, r.title, r.domain, r.file]), [
    ['demo.a', '默认导出', 'demo', 'tools/repo-check/rules/demo/a.mjs'],
    ['demo.b', '具名导出', 'demo', 'tools/repo-check/rules/demo/b.mjs'],
  ]);
  assert.deepEqual(await rules[1].run(ctxFor()), [{ level: 'warn', message: 'x' }], '单条规则的发现原样交给执行器');
});

test('域模块：一个文件多条规则；level 缺省取 severity，ok 不进报告，fix 当 hint', async () => {
  const dir = rulesDir({
    'env/index.mjs': `export const domain = 'env';
export const rules = [
  { id: 'env.one', title: '缺省级别', severity: 'warn', run: () => [{ message: '没写 level', fix: '照这样修' }] },
  { id: 'env.two', title: '通过说明', run: () => [{ level: 'ok', message: '都好' }, { message: '缺省 error' }, { level: 'info', message: '汇总', hint: '已有 hint' }] },
];
`,
  });
  const { rules, problems } = await loadRules(dir);
  assert.deepEqual(problems, []);
  assert.deepEqual(rules.map(r => [r.id, r.domain, r.file]), [['env.one', 'env', 'tools/repo-check/rules/env/index.mjs'], ['env.two', 'env', 'tools/repo-check/rules/env/index.mjs']]);
  const ctx = ctxFor();
  assert.deepEqual(await rules[0].run(ctx), [{ message: '没写 level', fix: '照这样修', level: 'warn', hint: '照这样修' }]);
  assert.deepEqual(await rules[1].run(ctx), [{ message: '缺省 error', level: 'error', hint: null }, { level: 'info', message: '汇总', hint: '已有 hint' }]);
});

test('域模块自带 createContext：本模块的规则拿到它建的上下文，每次检查只建一次', async () => {
  const dir = rulesDir({
    'qa/index.mjs': `export let built = 0;
export function createContext(root, { staged }) { built++; return { mine: true, root, staged, n: built }; }
export const rules = [
  { id: 'qa.first', title: '一', run: ctx => [{ level: 'info', message: JSON.stringify(ctx) }] },
  { id: 'qa.second', title: '二', run: ctx => [{ level: 'info', message: JSON.stringify(ctx) }] },
];
`,
    'plain/index.mjs': "export const rules = [{ id: 'plain.root', title: '框架 ctx', run: ctx => [{ level: 'info', message: typeof ctx.walk }] }];\n",
  });
  const { rules, problems } = await loadRules(dir);
  assert.deepEqual(problems, []);
  const ctx = ctxFor();
  const seen = [];
  for (const r of rules.filter(x => x.domain === 'qa')) seen.push(JSON.parse((await r.run(ctx))[0].message));
  assert.deepEqual(seen.map(s => [s.mine, s.n, s.staged]), [[true, 1, null], [true, 1, null]], '同一次检查共用一个上下文');
  assert.equal(seen[0].root, ctx.root);
  assert.equal((await rules.find(r => r.id === 'plain.root').run(ctx))[0].message, 'function', '没导出 createContext 时用框架的 ctx');
});

test('形状不对的文件各记一条加载问题（带 domain），同目录的其他规则照常加载', async () => {
  const dir = rulesDir({
    'mix/ok.mjs': "export default { id: 'mix.ok', title: '好的', run: () => [] };\n",
    'mix/both.mjs': "export const id = 'mix.both'; export const title = 't'; export const run = () => []; export const rules = [];\n",
    'mix/empty.mjs': 'export const rules = [];\n',
    'mix/entry.mjs': "export const rules = [{ id: 'mix.entry', title: '缺 run' }];\n",
    'mix/domain.mjs': "export const domain = 'other'; export const rules = [{ id: 'mix.domain', title: 't', run: () => [] }];\n",
    'mix/wrong-id.mjs': "export const rules = [{ id: 'other.x', title: 't', run: () => [] }];\n",
    'mix/bad-id.mjs': "export default { id: 'mix.Bad_Id', title: 't', run: () => [] };\n",
    'mix/zz-dup.mjs': "export default { id: 'mix.ok', title: '重复', run: () => [] };\n",
    'mix/shape.mjs': 'export const nothing = 1;\n',
    'mix/syntax.mjs': 'export default {\n',
  });
  const { rules, problems } = await loadRules(dir);
  assert.deepEqual(rules.map(r => r.id), ['mix.ok']);
  const by = Object.fromEntries(problems.map(p => [p.file.split('/').pop(), p]));
  assert.ok(problems.every(p => p.domain === 'mix'), '加载问题带上所在的域');
  assert.match(by['both.mjs'].message, /只能选一种/);
  assert.match(by['empty.mjs'].message, /空数组/);
  assert.match(by['entry.mjs'].message, /rules\[0\]（mix\.entry）/);
  assert.match(by['domain.mjs'].message, /domain = "other"/);
  assert.match(by['wrong-id.mjs'].message, /域与目录 mix\/ 不一致/);
  assert.match(by['bad-id.mjs'].message, /kebab-case/);
  assert.match(by['zz-dup.mjs'].message, /重复/, '文件按字典序加载，后来者算重复');
  assert.match(by['shape.mjs'].message, /形状不认识/);
  assert.match(by['syntax.mjs'].message, /加载失败/);
});

test('本仓库：env、qa 的域模块与其他规则一起加载，没有加载问题', async () => {
  const { rules, problems } = await loadRules(path.join(ROOT, 'tools/repo-check/rules'));
  assert.deepEqual(problems, []);
  for (const d of ['env', 'qa']) {
    const mine = rules.filter(r => r.domain === d);
    assert.ok(mine.length >= 5, `${d} 域应加载出多条规则`);
    assert.ok(mine.every(r => r.file === `tools/repo-check/rules/${d}/index.mjs`));
  }
});
