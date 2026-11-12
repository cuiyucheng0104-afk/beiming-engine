// engine/overlay/cjk.js 的性质测试（Node，不开浏览器）：禁则、不可拆分、挤压、中西文间距、断行、对齐、确定性与边界。
// 假 measure：汉字与全角标点 = size，半角（ASCII）= size / 2。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { layoutText, lintLine, LINE_START, LINE_END } from '../../engine/overlay/cjk.js';

const S = 10;
const measure = s => [...s].reduce((a, c) => a + (c.charCodeAt(0) < 128 ? S / 2 : S), 0);
const L = (t, o = {}) => layoutText(t, { size: S, measure, ...o });
const rows = r => r.lines.map(l => r.glyphs.slice(l.start, l.end).map(g => g.ch).join('').trimEnd());
const g0 = (r, ch) => r.glyphs.find(g => g.ch === ch);

test('规则表与 align.py 的 CLOSE / OPEN 全角部分一致', () => {
  const py = fs.readFileSync(new URL('../../engine/audio/voice/align.py', import.meta.url), 'utf8').split('\n');
  const grab = name => { const l = py.find(x => x.startsWith(`${name} = set(`)); return new Set([...l.slice(l.indexOf("set('") + 5, l.lastIndexOf("')"))].filter(c => c.charCodeAt(0) > 127)); };
  assert.deepEqual([...grab('CLOSE')].sort(), [...LINE_START].sort());
  assert.deepEqual([...grab('OPEN')].sort(), [...LINE_END].sort());
});

test('行首禁则：收尾标点不在行首，行尾禁则：开头标点不在行尾', () => {
  const r = L('一二三四五六七八九，十一二三四五六七八九（十一二三四', { maxWidth: 90 });
  for (const row of rows(r)) { assert.ok(!LINE_START.has(row[0]), row); assert.ok(!LINE_END.has(row.at(-1)), row); }
  assert.ok(rows(r).length >= 3);
});

test('先挤进：行尾收尾标点挤掉半个字宽后放得下就留在上一行', () => {
  const r = L('一二三四五六七八九，十', { maxWidth: 95 });   // 九个字 90 + 逗号挤后 5 = 95
  assert.deepEqual(rows(r), ['一二三四五六七八九，', '十']);
  assert.equal(r.lines[0].width, 95);
  assert.equal(g0(r, '，').w, 5);
});

test('推出：挤不进时把上一行末字带到下一行', () => {
  const r = L('一二三四五六七八九十，二', { maxWidth: 100 });
  assert.deepEqual(rows(r), ['一二三四五六七八九', '十，二']);
});

test('不可拆分：省略号、破折号成对不拆', () => {
  for (const t of ['……', '——']) {
    const r = L(`一二三四五六七八${t}`, { maxWidth: 90 });
    assert.ok(rows(r).some(x => x.includes(t)), rows(r).join('|'));   // 整对在同一行（不会一半在行尾一半在行首）
    assert.ok(rows(r).every(x => x[0] !== t[0]), '也不在行首');
  }
});

test('不可拆分：拉丁词、数字、数字加单位或百分号不在中间断', () => {
  const r = L('一二三四五六七八Hello', { maxWidth: 100 });
  assert.deepEqual(rows(r), ['一二三四五六七八', 'Hello']);
  const p = L('一二三四五六七八九12.5%', { maxWidth: 100 });
  assert.deepEqual(rows(p), ['一二三四五六七八九', '12.5%']);
  const u = L('一二三四五六七八九60kg', { maxWidth: 100 });
  assert.deepEqual(rows(u), ['一二三四五六七八九', '60kg']);
});

test('挤压：行尾收尾标点、行首开头标点各挤掉半个字宽', () => {
  const r = L('「好」', { maxWidth: 1000 });
  assert.equal(g0(r, '「').x, -5);      // 字面贴着框边
  assert.equal(g0(r, '「').w, 5);
  assert.equal(g0(r, '」').w, 5);
  assert.equal(r.lines[0].width, 20);   // 5 + 10 + 5
  const off = L('「好」', { maxWidth: 1000, squeeze: false });
  assert.equal(off.lines[0].width, 30);
});

test('挤压：相邻标点之间不空出整个字宽', () => {
  const r1 = L('好」。', { maxWidth: 1000 });
  assert.equal(g0(r1, '」').w, 5);            // 」。 →  」右挤
  const r2 = L('好、。', { maxWidth: 1000 }); assert.equal(g0(r2, '、').w, 5);
  const r3 = L('好）（好', { maxWidth: 1000 }); assert.equal(g0(r3, '）').w, 5);
  const r4 = L('好（「好', { maxWidth: 1000 }); assert.equal(g0(r4, '「').w, 5); assert.equal(g0(r4, '（').w, 10);
});

test('中西文间距：汉字与拉丁 / 数字相邻加 0.25 字，已有空格或标点旁不加', () => {
  const r = L('好a好', { maxWidth: 1000 });
  assert.equal(g0(r, 'a').x, 10 + 2.5);
  assert.equal(g0(r, '好').x, 0);
  assert.equal(r.glyphs[2].x, 10 + 2.5 + 5 + 2.5);
  const sp = L('好 a', { maxWidth: 1000 });
  assert.equal(g0(sp, 'a').x, 10 + 5);
  const pu = L('好，a', { maxWidth: 1000 });
  assert.equal(g0(pu, 'a').x, 20);
  assert.equal(L('好a', { maxWidth: 1000, autospace: 0 }).glyphs[1].x, 10);
});

test('balance：两行尽量等长', () => {
  const t = '一二三四五六七八九十一二三';
  const plain = L(t, { maxWidth: 100 }), bal = L(t, { maxWidth: 100, balance: true });
  assert.deepEqual(rows(plain).map(s => s.length), [10, 3]);
  assert.deepEqual(rows(bal).map(s => s.length), [7, 6]);
  assert.equal(L(t, { maxWidth: 100, balance: true }).lines.length, 2);
});

test('maxLines 超出时标明 overflow，且不丢行', () => {
  const t = '一二三四五六七八九十一二三';
  const r = L(t, { maxWidth: 50, maxLines: 2 });
  assert.equal(r.overflow, true); assert.equal(r.lines.length, 3); assert.equal(r.glyphs.length, 13);
  assert.equal(L(t, { maxWidth: 50, maxLines: 3 }).overflow, false);
  assert.equal(L(t, { maxWidth: 50 }).overflow, false);
});

test('align：left / center / right', () => {
  const t = '一二三\n一';
  const x1 = a => L(t, { maxWidth: 100, align: a }).lines.map(l => 0 + l.width);
  assert.deepEqual(x1('left'), [30, 10]);
  const c = L(t, { maxWidth: 100, align: 'center' }), r = L(t, { maxWidth: 100, align: 'right' });
  assert.equal(c.glyphs[0].x, 35); assert.equal(c.glyphs[3].x, 45);
  assert.equal(r.glyphs[0].x, 70); assert.equal(r.glyphs[3].x, 90);
});

test('硬换行 \\n、行号、基线与 index', () => {
  const r = L('一二\n三', { maxWidth: 1000 });
  assert.deepEqual(r.glyphs.map(g => [g.ch, g.line, g.index]), [['一', 0, 0], ['二', 0, 1], ['三', 1, 3]]);
  assert.equal(r.lines[1].y - r.lines[0].y, 17);
  assert.equal(r.height, 34); assert.equal(r.lineHeight, 17); assert.equal(r.fontSize, 10);
  assert.deepEqual(L('a\n\nb').lines.map(l => l.end - l.start), [1, 0, 1]);
});

test('字距 letterSpacing', () => {
  const r = L('一二三', { maxWidth: 1000, letterSpacing: 2 });
  assert.deepEqual(r.glyphs.map(g => g.x), [0, 12, 24]);
  assert.equal(r.lines[0].width, 34);
});

test('lintLine：报行首 / 行尾违规', () => {
  assert.deepEqual(lintLine('你好，世界'), []);
  assert.deepEqual(lintLine('，你好（').map(v => [v.kind, v.index]), [['line-start', 0], ['line-end', 3]]);
  assert.deepEqual(lintLine(''), []);
});

test('确定性：同输入两次调用逐位相同', () => {
  const t = '他说：“你好，世界。”然后——Hello world 3.5%…… 完了，《书名》。';
  const o = { maxWidth: 100, balance: true, align: 'center' };
  assert.deepEqual(L(t, o), L(t, o));
  assert.equal(JSON.stringify(L(t, o)), JSON.stringify(L(t, o)));
});

test('边界：空串、单字、只有标点、纯英文、超长英文词、窄于一个字', () => {
  const e = L(''); assert.deepEqual([e.glyphs.length, e.lines.length, e.height], [0, 0, 0]);
  assert.equal(L('字').glyphs.length, 1);
  const pu = L('，。」', { maxWidth: 30 }); assert.equal(pu.glyphs.length, 3);
  assert.deepEqual(rows(L('the quick brown fox', { maxWidth: 30 })), ['the', 'quick', 'brown', 'fox']);
  const long = L('Supercalifragilisticexpialidocious', { maxWidth: 40 });
  assert.equal(long.lines.length, 1); assert.ok(long.lines[0].width > 40);
  const narrow = L('一二三，四', { maxWidth: 3 });
  assert.equal(narrow.glyphs.length, 5); assert.ok(narrow.lines.length >= 3);
  assert.throws(() => layoutText('x', { size: 10 }));
});
