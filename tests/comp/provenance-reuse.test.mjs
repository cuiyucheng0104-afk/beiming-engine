// 派生代码比对、REUSE.toml 解析与许可合成、允许清单。
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tokenize, findDerived, levelOf, hasAttribution, provenanceHeaderProblems, PROVENANCE_TAG } from '../../tools/compliance/lib/provenance.mjs';
import { parseReuseToml, globToRegExp, headerInfo, resolveFile, reuseReport, licenseIds } from '../../tools/compliance/lib/reuse.mjs';
import { loadAllowlist, applyAllowlist } from '../../tools/compliance/lib/allowlist.mjs';
import { j, mkRepo, rm } from './helpers.mjs';

// 一段足够长的「上游」代码：Catmull-Rom 加密 + 单调样条（结构仿上游写法）
const UPSTREAM = `
export function spline(c, closed = true, k = 8) {
  const n = c.length, out = [], P = i => closed ? c[(i + n) % n] : c[clamp(i, 0, n - 1)];
  const m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let j = 0; j < k; j++) {
      const t = j / k, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map(d => .5 * (2 * p1[d] + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3)));
    }
  }
  if (!closed) out.push(c[n - 1]);
  return out;
}`;
// 改了名字、空白、注释、引号的同一段代码
const RENAMED = `// 我们的样条
export function catmull(pts, per = 8, closed = false) {
  const n = pts.length,   out = [], Q = idx => closed ? pts[(idx + n) % n] : pts[clamp(idx, 0, n - 1)];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a0 = Q(i - 1), a1 = Q(i), a2 = Q(i + 1), a3 = Q(i + 2);
    for (let s = 0; s < per; s++) {
      const u = s / per, u2 = u * u, u3 = u2 * u;
      out.push([0, 1].map(e => 0.5 * (2 * a1[e] + (-a0[e] + a2[e]) * u + (2 * a0[e] - 5 * a1[e] + 4 * a2[e] - a3[e]) * u2 + (-a0[e] + 3 * a1[e] - 3 * a2[e] + a3[e]) * u3)));
    }
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}`;

test('记号化：标识符与字符串归一，注释与空白不算', () => {
  const a = tokenize('const x = "a"; // 注释\nlet y=2.0;', 'a.js').toks;
  const b = tokenize("const zz = 'bbb';\n\n  let w = 2 ;", 'b.js').toks;
  assert.deepEqual(a, b);
  assert.deepEqual(tokenize('x = 1  # 注释\ny = """长\n串"""', 'a.py').toks, ['I', '=', '1', 'I', '=', 'S']);
});

test('派生比对：改名改空白照样认出，通用短写法不报', () => {
  const d = findDerived([{ rel: 'engine/x.js', text: RENAMED }], [{ rel: 'cases/vendor/lemo-opuscar/s/toon.js', text: UPSTREAM }]);
  assert.equal(d.length, 1);
  assert.equal(d[0].vendor, 'cases/vendor/lemo-opuscar/s/toon.js');
  assert.ok(d[0].run >= 150, `连续片段 ${d[0].run}`);
  assert.equal(d[0].attributed, false);
  // 一行 clamp 夹在一个正常大小的原创文件里：最长片段与占比都达不到阈值
  const clampLine = 'export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));\n';
  const own = Array.from({ length: 40 }, (_, i) => `export function f${i}(v) { if (v > ${i}) return v * ${i + 1} - ${i * 3}; return [v, ${i}, 'k${i}']; }`).join('\n');
  const tiny = findDerived([{ rel: 'engine/y.js', text: clampLine + own }], [{ rel: 'cases/vendor/lemo-opuscar/core/lib.js', text: clampLine + 'export const lerp = (a, b, t) => a + (b - a) * t;\n' }]);
  assert.equal(tiny.length, 0, 'clamp 这种一行的通用写法在正常文件里不该报');
});

test('派生比对：阈值分两档', () => {
  assert.equal(levelOf({ run: 200, coverage: 0.1 }), 'error');
  assert.equal(levelOf({ run: 60, coverage: 0.45 }), 'error');
  assert.equal(levelOf({ run: 95, coverage: 0.05 }), 'warn');
  assert.equal(levelOf({ run: 40, coverage: 0.31 }), 'warn');
  assert.equal(levelOf({ run: 80, coverage: 0.2 }), null);
});

test('来源头：要版权行与上游权利人同行，或完整的 @provenance 标记', () => {
  const tag = j('// @', 'provenance lemo-opuscar@bebbbe1:core/lib.js\n');
  const cr = j('// SPDX-', 'FileCopyrightText: 2026 LemoLab\n');
  const lic = j('// SPDX-', 'License-Identifier: MIT\n');
  assert.ok(hasAttribution(cr));
  assert.ok(hasAttribution(tag));
  assert.ok(!hasAttribution('// 这里的做法和 LemoLab 的不一样\n'), '顺口提到上游名不算来源头');
  assert.ok(!PROVENANCE_TAG.test('// 写法：@' + 'provenance <上游名>@<提交>:<路径>'), '说明文字不算标记');
  assert.deepEqual(provenanceHeaderProblems(tag), ['缺许可标识行', '缺上游版权行']);
  assert.deepEqual(provenanceHeaderProblems(tag + lic + cr), []);
  assert.deepEqual(provenanceHeaderProblems('// 普通文件\n'), []);
});

test('REUSE.toml：解析子集、跨行数组、报错带行号', () => {
  const doc = parseReuseToml(`version = 1\n# 注释\n[[annotations]]\npath = ["a/**",\n  "b/*.md"] # 尾注释\nprecedence = "override"\nSPDX-FileCopyrightText = '2026 某人'\nSPDX-License-Identifier = "MIT"\n`);
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.annotations[0].path, ['a/**', 'b/*.md']);
  assert.equal(doc.annotations[0].precedence, 'override');
  assert.throws(() => parseReuseToml('version = 1\n[tool]\n'), /第 2 行/);
  assert.throws(() => parseReuseToml('[[annotations]]\npath = "x"\nfoo = "y"\n'), /不认识的键 foo/);
  assert.throws(() => parseReuseToml('version = 1\nversion = 2\n'), /重复的键/);
});

test('通配：* 不跨目录，** 跨目录', () => {
  assert.ok(globToRegExp('fonts/*.woff2').test('fonts/a.woff2'));
  assert.ok(!globToRegExp('fonts/*.woff2').test('fonts/x/a.woff2'));
  assert.ok(globToRegExp('films/**/*.png').test('films/a/b/c.png'));
  assert.ok(globToRegExp('**').test('.gitattributes'));
  assert.deepEqual(licenseIds('MIT AND (OFL-1.1 OR CC0-1.0)'), ['MIT', 'OFL-1.1', 'CC0-1.0']);
});

test('文件头：忽略块里的标签不算；precedence 合成许可', () => {
  const lic = j('SPDX-', 'License-Identifier: MIT');
  const cr = j('SPDX-', 'FileCopyrightText: 2026 甲');
  const text = `// ${lic}\n// ${cr}\n<!-- REUSE-${'IgnoreStart'} -->\n// ${j('SPDX-', 'License-Identifier: GPL-3.0')}\n<!-- REUSE-${'IgnoreEnd'} -->\n`;
  const h = headerInfo(text);
  assert.deepEqual(h.licenses, ['MIT']);
  assert.deepEqual(h.copyrights, ['2026 甲']);
  const doc = parseReuseToml(`version = 1\n[[annotations]]\npath = "**"\nSPDX-FileCopyrightText = "2026 乙"\nSPDX-License-Identifier = "MIT"\n[[annotations]]\npath = "x/**"\nprecedence = "override"\nSPDX-FileCopyrightText = "2026 丙"\nSPDX-License-Identifier = "CC0-1.0"\n`);
  assert.deepEqual(resolveFile(doc, 'a.js', h).copyrights, ['2026 甲'], 'closest：文件头优先');
  assert.deepEqual(resolveFile(doc, 'b.js').copyrights, ['2026 乙'], '没有文件头就用 REUSE.toml');
  assert.deepEqual(resolveFile(doc, 'x/c.js', h).licenses, ['CC0-1.0'], 'override：一律用 REUSE.toml');
});

test('REUSE 覆盖：缺注释、缺许可全文、多余许可都报', () => {
  const dir = mkRepo({
    'REUSE.toml': 'version = 1\n[[annotations]]\npath = "src/**"\nSPDX-FileCopyrightText = "2026 甲"\nSPDX-License-Identifier = "MIT AND OFL-1.1"\n',
    'LICENSES/MIT.txt': 'MIT', 'LICENSES/CC0-1.0.txt': 'CC0', 'LICENSES/not a licence.txt': 'x',
    'src/a.js': 'x', 'other/b.js': 'y', 'LICENSE': 'MIT',
  }, { commit: false });
  try {
    const files = ['REUSE.toml', 'LICENSES/MIT.txt', 'LICENSES/CC0-1.0.txt', 'LICENSES/not a licence.txt', 'src/a.js', 'other/b.js', 'LICENSE'];
    const read = rel => ({ text: fs.readFileSync(path.join(dir, rel), 'utf8') });
    const rep = reuseReport({ root: dir, files, read });
    const msgs = rep.problems.map(p => p.message).join('\n');
    assert.match(msgs, /other\/b\.js|1 个文件查不到许可与版权/);
    assert.match(msgs, /OFL-1\.1 在 LICENSES\/ 里没有全文/);
    assert.match(msgs, /CC0-1\.0\.txt 没有任何文件用到/);
    assert.match(msgs, /不是合法许可标识/);
    assert.equal(rep.stats.covered, 1);
  } finally { rm(dir); }
});

test('允许清单：两类豁免、pending 必填项、过期与 --strict', () => {
  const dir = mkRepo({ 'allow.json': JSON.stringify({ schemaVersion: 1, entries: [
    { rule: 'comp.local-paths', path: 'tests/**', match: 'abs', reason: '测试里的构造样例', added: '2026-11-10' },
    { rule: 'comp.provenance', path: 'engine/a.js', kind: 'pending', reason: '等属主加来源头', owner: 'P13', expires: '2026-12-15', ref: '汇报' },
    { rule: 'comp.secrets', path: 'x.js', kind: 'pending', reason: '缺字段的待修条目' },
    { rule: 'comp.secrets', path: 'y.js', reason: '短' },
    { rule: 'comp.local-paths', path: 'old.js', reason: '已经过期的豁免', expires: '2026-01-01' },
  ] }) }, { commit: false });
  try {
    const list = loadAllowlist(path.join(dir, 'allow.json'));
    assert.equal(list.entries.length, 3);
    assert.equal(list.problems.length, 2);
    assert.match(list.problems.map(p => p.message).join(), /必须写 owner、expires 与 ref/);
    const findings = [
      { rule: 'comp.local-paths', file: 'tests/t.js', message: 'C:abs', _text: 'abs' },
      { rule: 'comp.provenance', file: 'engine/a.js', message: '派生' },
      { rule: 'comp.local-paths', file: 'old.js', message: 'x' },
    ];
    const now = Date.parse('2026-11-10T00:00:00Z');
    const r = applyAllowlist(findings, list, now);
    assert.equal(r.suppressed.length, 2);
    assert.equal(r.kept.length, 1, '过期条目不再豁免');
    assert.equal(r.expired.length, 1);
    assert.equal(r.suppressed.find(f => f.rule === 'comp.provenance').waiver, 'pending');
    const strict = applyAllowlist(findings, loadAllowlist(path.join(dir, 'allow.json')), now, { strict: true });
    assert.equal(strict.suppressed.length, 1, '--strict 时 pending 不生效');
    assert.ok(strict.kept.some(f => f.rule === 'comp.provenance'));
  } finally { rm(dir); }
});
