// 无头浏览器与 GPU 探测（tools/env/lib/browser.mjs）：doctor 看到的必须就是渲染器用的——启动参数与软件渲染的判定和
// engine/render/page.mjs 逐项一致；锁定的 headless shell 是否装全按 Playwright 的目录约定判断。不启动浏览器。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromeArgs, rendererArgs, classifyRenderer, resolveAngle, headlessShell, browsersDir } from '../../tools/env/lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/env/spec.json'), 'utf8'));
const hasPw = fs.existsSync(path.join(ROOT, 'node_modules', 'playwright-core', 'package.json'));

test('启动参数：备用副本与 engine/render/page.mjs 逐项相同；doctor 实际用的是 page.mjs 导出的那份', { skip: !hasPw && '没装 npm 依赖' }, async () => {
  const page = await import(pathToFileURL(path.join(ROOT, 'engine/render/page.mjs')).href);
  for (const angle of SPEC.gpu.angles) {
    assert.deepEqual(chromeArgs(angle), page.chromeArgs(angle), `ANGLE=${angle} 的启动参数和渲染器不一致`);
    const r = await rendererArgs(ROOT, angle);
    assert.equal(r.source, 'engine/render/page.mjs');
    assert.deepEqual(r.args, page.chromeArgs(angle));
  }
  assert.equal(new RegExp(SPEC.gpu.softwarePattern, 'i').source, page.SOFTWARE_RENDERER.source, 'spec.json 的软件渲染判定与渲染器不一致');
});

test('classifyRenderer：软件渲染、核显、独显', () => {
  const k = s => classifyRenderer(s, SPEC);
  assert.equal(k('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'), 'software');
  assert.equal(k('ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'software');
  assert.equal(k('llvmpipe (LLVM 15.0.7, 256 bits)'), 'software');
  assert.equal(k('ANGLE (Intel, Intel(R) UHD Graphics 770 (0x00004680) Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'integrated');
  assert.equal(k('ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001681) Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'integrated');
  assert.equal(k('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 (0x00002B85) Vulkan 1.4.303, NVIDIA)'), 'hardware');
  assert.equal(k('ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)'), 'hardware');
  assert.equal(k(null), 'unknown');
});

test('resolveAngle：平台默认与渲染器一致；大小写或拼写不对判为不合法（渲染器会悄悄落到默认后端）', () => {
  assert.deepEqual([resolveAngle(SPEC, {}, 'darwin').angle, resolveAngle(SPEC, {}, 'win32').angle, resolveAngle(SPEC, {}, 'linux').angle], ['metal', 'default', 'default']);
  assert.equal(resolveAngle(SPEC, { BEIMING_ANGLE: 'vulkan' }, 'win32').valid, true);
  assert.equal(resolveAngle(SPEC, { BEIMING_ANGLE: 'Vulkan' }, 'win32').valid, false);
  assert.equal(resolveAngle(SPEC, { BEIMING_ANGLE: 'vulcan' }, 'linux').valid, false);
});

test('headlessShell：按 Playwright 的目录约定判断装没装全（目录、INSTALLATION_COMPLETE、可执行文件）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-pw-test-'));
  try {
    const env = { PLAYWRIGHT_BROWSERS_PATH: base };
    assert.equal(browsersDir(env, 'linux', ROOT), path.resolve(base));
    assert.equal(browsersDir({ PLAYWRIGHT_BROWSERS_PATH: '0' }, 'linux', ROOT), path.join(ROOT, 'node_modules', 'playwright-core', '.local-browsers'));
    let r = headlessShell({ root: ROOT, spec: SPEC, env, platform: 'linux' });
    assert.equal(r.installed, false);
    assert.match(r.reason, /没有/);
    const dir = path.join(base, `chromium_headless_shell-${SPEC.playwright.revision}`);
    fs.mkdirSync(path.join(dir, 'chrome-headless-shell-linux64'), { recursive: true });
    r = headlessShell({ root: ROOT, spec: SPEC, env, platform: 'linux' });
    assert.match(r.reason, /不完整/);
    fs.writeFileSync(path.join(dir, 'INSTALLATION_COMPLETE'), '');
    r = headlessShell({ root: ROOT, spec: SPEC, env, platform: 'linux' });
    assert.match(r.reason, /找不到/);
    fs.writeFileSync(path.join(dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell'), '');
    r = headlessShell({ root: ROOT, spec: SPEC, env, platform: 'linux' });
    assert.equal(r.installed, true);
    assert.equal(r.executable, path.join(dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
    // Windows 的可执行文件名带 .exe
    fs.writeFileSync(path.join(dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell.exe'), '');
    assert.match(headlessShell({ root: ROOT, spec: SPEC, env, platform: 'win32' }).executable, /chrome-headless-shell\.exe$/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('spec.json 的锁定版本与 node_modules 里的 playwright-core 及其 browsers.json 一致', { skip: !hasPw && '没装 npm 依赖' }, () => {
  const dir = path.join(ROOT, 'node_modules', 'playwright-core');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, SPEC.playwright.version);
  const b = JSON.parse(fs.readFileSync(path.join(dir, 'browsers.json'), 'utf8')).browsers.find(x => x.name === SPEC.playwright.browser);
  assert.equal(b.revision, SPEC.playwright.revision);
  assert.equal(b.browserVersion, SPEC.playwright.browserVersion);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies[SPEC.playwright.package], SPEC.playwright.version);
});
