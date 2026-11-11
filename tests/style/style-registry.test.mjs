// 画风注册表（engine/style）：node --test tests/style/style-registry.test.mjs
// 纯 Node，不开浏览器：登记表与锁定文件合格、lookPreset 解析、越界覆盖报错、插值、锁定文件校验的反例。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStyleRef, parseLookPreset, styleKey, loadRegistrySync, loadStyleSync, listLookPresets,
  resolveLook, checkOverrides, mixLook, mergeParams, validateStyleLock, StyleError,
} from '../../engine/style/index.js';

test('画风引用与 lookPreset 的写法', () => {
  assert.deepEqual(parseStyleRef('beiming-original@v1'), { id: 'beiming-original', version: 1 });
  assert.deepEqual(parseStyleRef('beiming-original@1'), { id: 'beiming-original', version: 1 });
  assert.deepEqual(parseStyleRef({ id: 'beiming-original', version: 1 }), { id: 'beiming-original', version: 1 });
  assert.deepEqual(parseLookPreset('beiming-original@v1/hero-sunrise'), { id: 'beiming-original', version: 1, preset: 'hero-sunrise' });
  assert.equal(styleKey({ id: 'x', version: 3 }), 'x@v3');
  for (const bad of ['Beiming@v1', 'beiming', 'beiming@v0x', '', null]) assert.throws(() => parseStyleRef(bad), StyleError, `${bad} 应当报错`);
  for (const bad of ['beiming-original@v1', 'beiming-original/wide', 'beiming-original@v1/Wide']) assert.throws(() => parseLookPreset(bad), StyleError, `${bad} 应当报错`);
});

test('登记表里的 beiming-original@v1 能解析，四个预设都在', () => {
  const reg = loadRegistrySync();
  assert.equal(reg.schema, 'beiming.style-registry/1');
  const presets = listLookPresets(reg);
  for (const p of ['wide', 'actor', 'hero', 'hero-sunrise']) assert.ok(presets.includes(`beiming-original@v1/${p}`));
  const st = loadStyleSync('beiming-original@v1');
  assert.deepEqual(validateStyleLock(st), []);
  assert.equal(st.status.userApproval, 'indirect', '没有用户原话的认可，不能写成 approved');
});

test('没登记的画风、版本、预设一律报错（不静默回退）', () => {
  assert.throws(() => loadStyleSync('beiming-original@v9'), e => e instanceof StyleError && e.code === 'unknown-style');
  assert.throws(() => loadStyleSync('no-such-style@v1'), e => e.code === 'unknown-style');
  const st = loadStyleSync('beiming-original@v1');
  assert.throws(() => resolveLook(st, 'closeup'), e => e.code === 'unknown-preset' && /可用/.test(e.message));
});

test('镜头级覆盖：允许范围内照用，越界在 strict 下报错，路径不在允许表里也报错', () => {
  const st = loadStyleSync('beiming-original@v1');
  const ok = resolveLook(st, 'wide', { kuwahara: { radius: 2 }, paper: { strength: 0.13 } }, { strict: true });
  assert.equal(ok.params.kuwahara.radius, 2);
  assert.equal(ok.params.kuwahara.farRadius, st.lookPresets.wide.params.kuwahara.farRadius, '没覆盖的字段保留预设值');
  assert.deepEqual(ok.problems, []);
  assert.throws(() => resolveLook(st, 'wide', { paper: { strength: 0.3 } }, { strict: true }), e => e.code === 'override-out-of-range');
  assert.throws(() => resolveLook(st, 'wide', { grade: { saturation: 2 } }, { strict: true }), /allowedOverrides/);
  const loose = resolveLook(st, 'wide', { paper: { strength: 0.3 } });
  assert.equal(loose.problems.length, 1, '非 strict 时只记问题');
  assert.deepEqual(checkOverrides(st, { t: 1.5, debug: 'id' }), [], 't 与 debug 是每帧参数，不算覆盖');
});

test('mixLook：数值与数组逐项插值，非数值按 0.5 切换；mergeParams 不改原对象', () => {
  const a = { grade: { exposure: 1, lift: [0, 0, 0] }, fog: null, mode: 'a' }, b = { grade: { exposure: 1.2, lift: [0.1, 0.2, 0.3] }, fog: null, mode: 'b' };
  const m = mixLook(a, b, 0.5);
  assert.ok(Math.abs(m.grade.exposure - 1.1) < 1e-12);
  assert.deepEqual(m.grade.lift.map(v => +v.toFixed(6)), [0.05, 0.1, 0.15]);
  assert.equal(m.mode, 'b');
  const base = { a: { b: 1, c: 2 } }, out = mergeParams(base, { a: { b: 9 } });
  assert.deepEqual(out, { a: { b: 9, c: 2 } });
  assert.deepEqual(base, { a: { b: 1, c: 2 } });
});

test('hero → hero-sunrise 的插值端点就是两个预设（光的剧本不越出两态）', () => {
  const st = loadStyleSync('beiming-original@v1');
  const A = resolveLook(st, 'hero').params, B = resolveLook(st, 'hero-sunrise').params;
  assert.deepEqual(mixLook(A, B, 0), A);
  assert.deepEqual(mixLook(A, B, 1), B);
  for (const k of [0.25, 0.5, 0.75]) assert.deepEqual(checkOverrides(st, { grade: { exposure: mixLook(A, B, k).grade.exposure, warmth: mixLook(A, B, k).grade.warmth } }), []);
});

test('锁定文件校验：缺字段、坏色值、approved 却没有证据，都要报出来', () => {
  const st = structuredClone(loadStyleSync('beiming-original@v1'));
  st.palette.colors[0].hex = 'red';
  delete st.palette.colors[1].role;
  st.status.userApproval = 'approved';
  st.newVersionWhen = [];
  const p = validateStyleLock(st).join('\n');
  assert.match(p, /hex 不合法/);
  assert.match(p, /缺 role/);
  assert.match(p, /approvalEvidence/);
  assert.match(p, /newVersionWhen 必填/);
  assert.deepEqual(validateStyleLock(null), ['顶层必须是对象']);
});
