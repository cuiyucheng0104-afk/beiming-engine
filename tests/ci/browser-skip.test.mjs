// 守住「浏览器测试不会因为判错浏览器而在 CI 里静默跳过」：
// 渲染器启动的是 chromium-headless-shell，chromium.executablePath() 指向的却是完整 Chromium（CI 没装），
// 测试用后者做跳过条件，整组渲染、资产桥、确定性与金标准的集成测试在 CI 里全部「跳过」而不是运行。
// 跳过条件一律从 tests/ci/browser.mjs 取。
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SELF = 'tests/ci/browser-skip.test.mjs';

function* testFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'fixtures' && e.name !== 'node_modules') yield* testFiles(p); }
    else if (/\.mjs$/.test(e.name)) yield p;
  }
}

test('tests/ 里没有用 chromium.executablePath() 当「有没有浏览器」的判据', () => {
  const bad = [];
  for (const f of testFiles(path.join(ROOT, 'tests'))) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (rel === SELF) continue;
    if (/chromium\.executablePath\(\)/.test(fs.readFileSync(f, 'utf8'))) bad.push(rel);
  }
  assert.deepEqual(bad, [], '改用 tests/ci/browser.mjs 的 browserOk（与 run-tests 的 requires: browser 同一个探测）');
});
