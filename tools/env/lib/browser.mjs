// 北冥仓库 · 无头浏览器：锁定的 chromium-headless-shell 装在哪、装没装全，以及按当前 ANGLE 设置启动一次看 WebGL 落在哪块 GPU。
//
// 接口：
//   browsersDir(env, platform)            Playwright 浏览器目录（尊重 PLAYWRIGHT_BROWSERS_PATH；=0 时在 playwright-core 包内）
//   headlessShell({root, spec, env})      → {installed, dir, executable, revision, browserVersion, reason}
//   resolveAngle(env, platform)           → {angle, source, valid, allowed}；与 engine/render/page.mjs 的默认值一致
//   chromeArgs(angle)                     → 启动参数（与 engine/render/page.mjs 相同：同一组参数才能代表真实渲染）
//   probeGpu({root, angle, chrome, timeout})  → Promise<{ok, version, webgl2, renderer, vendor, maxTexture, shaderOk, ms, error}>
//   classifyRenderer(renderer, spec)      → 'software' | 'integrated' | 'hardware' | 'unknown'
//   nvidiaSmi()                           → Promise<{ok, gpus:[{name, driver, memoryMiB, util}], error}>（Windows / Linux）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, which } from './proc.mjs';

export function browsersDir(env = process.env, platform = process.platform, root) {
  const p = env.PLAYWRIGHT_BROWSERS_PATH;
  if (p === '0') return path.join(root, 'node_modules', 'playwright-core', '.local-browsers');
  if (p) return path.resolve(p);
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright');
}

export function headlessShell({ root, spec, env = process.env, platform = process.platform }) {
  const base = browsersDir(env, platform, root);
  const dir = path.join(base, `chromium_headless_shell-${spec.playwright.revision}`);
  const out = { dir, revision: spec.playwright.revision, browserVersion: spec.playwright.browserVersion, installed: false, executable: null, reason: null };
  if (!fs.existsSync(dir)) { out.reason = `没有 ${dir}`; return out; }
  if (!fs.existsSync(path.join(dir, 'INSTALLATION_COMPLETE'))) { out.reason = `${dir} 不完整（缺 INSTALLATION_COMPLETE，下载或解压被中断过）`; return out; }
  const names = platform === 'win32' ? ['chrome-headless-shell.exe', 'headless_shell.exe'] : ['chrome-headless-shell', 'headless_shell'];
  for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    for (const n of names) {
      const p = path.join(dir, sub.name, n);
      if (fs.existsSync(p)) { out.executable = p; out.installed = true; return out; }
    }
  }
  out.reason = `${dir} 里找不到 ${names[0]}`;
  return out;
}

export function resolveAngle(spec, env = process.env, platform = process.platform) {
  const raw = env.BEIMING_ANGLE;
  const angle = raw || (platform === 'darwin' ? 'metal' : 'default');
  return { angle, source: raw ? 'BEIMING_ANGLE' : '平台默认', valid: spec.gpu.angles.includes(angle), allowed: spec.gpu.angles };
}

export function chromeArgs(angle) {
  return [
    ...(angle === 'default' ? [] : [`--use-angle=${angle}`]),
    '--enable-gpu', '--ignore-gpu-blocklist', '--font-render-hinting=none', '--force-color-profile=srgb',
  ];
}

export function classifyRenderer(renderer, spec) {
  if (!renderer) return 'unknown';
  if (new RegExp(spec.gpu.softwarePattern, 'i').test(renderer)) return 'software';
  if (new RegExp(spec.gpu.integratedPattern, 'i').test(renderer)) return 'integrated';
  return 'hardware';
}

export async function probeGpu({ root, angle, chrome, timeout = 45_000 }) {
  const t0 = Date.now();
  let pw;
  try {
    pw = await import(pathToFileURL(path.join(root, 'node_modules', 'playwright-core', 'index.mjs')).href);
  } catch (e) {
    return { ok: false, error: `加载 playwright-core 失败（${e.code || e.message}）`, ms: Date.now() - t0 };
  }
  let browser = null, timer;
  const work = (async () => {
    browser = await pw.chromium.launch({ executablePath: chrome || undefined, args: chromeArgs(angle), timeout: Math.max(5_000, timeout - 5_000) });
    const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
    const info = await page.evaluate(() => {
      const c = document.createElement('canvas');
      const g = c.getContext('webgl2');
      if (!g) return { webgl2: false };
      const e = g.getExtension('WEBGL_debug_renderer_info');
      const sh = g.createShader(g.FRAGMENT_SHADER);
      g.shaderSource(sh, '#version 300 es\nprecision highp float; out vec4 o; void main(){ o = vec4(1.0); }');
      g.compileShader(sh);
      return {
        webgl2: true,
        renderer: String(e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)),
        vendor: String(e ? g.getParameter(e.UNMASKED_VENDOR_WEBGL) : g.getParameter(g.VENDOR)),
        maxTexture: g.getParameter(g.MAX_TEXTURE_SIZE),
        shaderOk: !!g.getShaderParameter(sh, g.COMPILE_STATUS),
      };
    });
    return { ok: true, version: browser.version(), ...info };
  })();
  try {
    const r = await Promise.race([work, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`浏览器在 ${timeout / 1000} 秒内没有完成启动与探测`)), timeout); })]);
    return { ...r, ms: Date.now() - t0 };
  } catch (e) {
    const msg = String(e.message || e).split('\n').find(l => l.trim()) || String(e);
    return { ok: false, error: /Executable doesn't exist/.test(e.message || '') ? '锁定的 headless shell 没装' : msg.slice(0, 300), ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
    // 超时时 launch 可能还挂着：等它落地再关；playwright 在进程退出时也会结束它启动的浏览器
    work.catch(() => {}).finally(() => browser?.close().catch(() => {}));
    await browser?.close().catch(() => {});
  }
}

export async function nvidiaSmi({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'darwin') return { ok: false, gpus: [], error: 'macOS 没有 nvidia-smi' };
  const bin = which('nvidia-smi', { env }) || (platform === 'win32' && fs.existsSync('C:\\Windows\\System32\\nvidia-smi.exe') ? 'C:\\Windows\\System32\\nvidia-smi.exe' : null);
  if (!bin) return { ok: false, gpus: [], error: '没有 nvidia-smi（没有 NVIDIA 显卡或驱动）' };
  const r = await run(bin, ['--query-gpu=name,driver_version,memory.total,utilization.gpu', '--format=csv,noheader,nounits'], { timeout: 8_000, env });
  if (r.code !== 0) return { ok: false, gpus: [], error: `nvidia-smi 退出码 ${r.code}` };
  const gpus = r.stdout.trim().split('\n').filter(Boolean).map(l => {
    const [name, driver, mem, util] = l.split(',').map(s => s.trim());
    return { name, driver, memoryMiB: +mem || null, util: +util };
  });
  return { ok: true, gpus };
}
