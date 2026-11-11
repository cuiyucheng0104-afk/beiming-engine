// engine 九层的 API 快照（审计 CODE-04 ①）：模块 → 排序后的导出名，与 tests/engine/api-snapshot.json 比对。
// stable 模块（《北冥》、作品站、lab、路线模版在用）的导出必须逐个相同；experimental 只要求登记。
// 有意改了 API：node tests/engine/lib/api-snapshot.mjs --write，并在 CHANGELOG 的 [Unreleased] 记一笔。
import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, readSnapshot, compare, listModules } from './lib/api-snapshot.mjs';

test('engine 九层的导出与快照一致（stable 逐个相同；新模块先登记）', async () => {
  const { errors, notes } = compare(readSnapshot(), await collect());
  for (const n of notes) console.log(`（experimental，不拦）${n}`);
  assert.deepEqual(errors, [], '有意的 API 变化：运行 node tests/engine/lib/api-snapshot.mjs --write 更新快照并记 CHANGELOG');
});

test('快照覆盖 P13 的全部模块；《北冥》与作品站用到的模块都是 stable', () => {
  const snap = readSnapshot(), mods = listModules();
  assert.deepEqual(Object.keys(snap.modules).sort(), [...mods].sort());
  // 作品站（tools/build-showcase.py 按文件拷）与《北冥》正片的 import 链上的模块（2026-11-10 统计）
  const used = ['engine/core/clock.js', 'engine/core/math.js', 'engine/core/noise.js', 'engine/core/stroke.js', 'engine/form/bend.js', 'engine/form/loft.js',
    'engine/form/rock.js', 'engine/shade/toon.js', 'engine/shade/patch.js', 'engine/stage/film.js', 'engine/look/index.js', 'engine/look/paper.js',
    'engine/overlay/brush.js', 'engine/overlay/text.js', 'engine/paint/curve.js'];
  for (const m of used) assert.equal(snap.modules[m]?.stability, 'stable', m);
});

test('比对规则：stable 删 / 加导出都报，experimental 只记、模块缺登记报错', () => {
  const snap = { schemaVersion: 1, modules: { 'a.js': { stability: 'stable', exports: ['x', 'y'] }, 'b.js': { stability: 'experimental', exports: ['p'] }, 'gone.js': { stability: 'stable', exports: [] } } };
  const { errors, notes } = compare(snap, { 'a.js': ['x', 'z'], 'b.js': ['q'], 'new.js': ['n'] });
  assert.equal(errors.length, 3);
  assert.match(errors.join('\n'), /a\.js（stable）：少了 y；多了 z/);
  assert.match(errors.join('\n'), /new\.js：新模块还没登记/);
  assert.match(errors.join('\n'), /gone\.js：快照里有、仓库里没有了/);
  assert.deepEqual(notes, ['b.js（experimental）：少了 p；多了 q']);
});
